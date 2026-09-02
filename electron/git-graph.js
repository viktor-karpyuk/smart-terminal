'use strict';

/**
 * Turning a list of commits into the picture of a graph.
 *
 * git hands back commits and their parents; what a person reads is lanes — the
 * vertical lines, where one splits off, and where two come back together. That
 * translation is this file, and it is kept pure so it can be tested against
 * shapes that are a nuisance to create in a real repository: octopus merges,
 * a branch that outlives its merge, roots with no parents at all.
 *
 * The rule the whole thing rests on: **a commit keeps its first parent's lane**.
 * That is what makes the trunk of a history a straight line down the page rather
 * than a staircase, and it is why a merge's second parent is the one that gets
 * bent back in.
 */

/** Lanes are coloured by position, from the app's own palette. */
const LANE_COLOURS = ['#7aa2f7', '#9ece6a', '#bb9af7', '#e0af68', '#7dcfff', '#f7768e', '#ff9e64', '#2ac3de'];

const colourOf = (lane) => LANE_COLOURS[lane % LANE_COLOURS.length];

/**
 * Lay commits out in lanes.
 *
 * `commits` is newest-first, each `{ sha, parents }`. Returns one row per commit
 * carrying everything the renderer needs and nothing it has to work out itself:
 * which lane the dot sits in, which lanes merely pass this row, and the lines
 * leaving it towards each parent.
 */
function layout(commits = []) {
  /** Lane -> the sha that lane is currently waiting to draw. */
  const waiting = [];
  const rows = [];

  const freeLane = () => {
    const at = waiting.indexOf(null);
    return at === -1 ? waiting.length : at;
  };

  for (const commit of commits) {
    // Lanes already expecting this commit. More than one means branches
    // converging here, and all but the leftmost end at this row.
    const expecting = [];
    for (let lane = 0; lane < waiting.length; lane += 1) {
      if (waiting[lane] === commit.sha) expecting.push(lane);
    }

    const lane = expecting.length ? expecting[0] : freeLane();
    // Everything open *before* this row is drawn is what passes through it.
    const through = [];
    for (let i = 0; i < waiting.length; i += 1) {
      if (waiting[i] !== null && i !== lane && !expecting.includes(i)) through.push(i);
    }
    // The lanes that converged here stop; the leftmost carries on below.
    for (const other of expecting.slice(1)) waiting[other] = null;

    const parents = commit.parents ?? [];
    const edges = [];

    if (parents.length === 0) {
      // A root commit: nothing continues below it.
      waiting[lane] = null;
    } else {
      // The first parent inherits this lane — the straight-line rule.
      waiting[lane] = parents[0];
      edges.push({ sha: parents[0], from: lane, to: lane, kind: 'first' });

      for (const parent of parents.slice(1)) {
        // A parent already being waited for is reached by bending into that
        // lane rather than by opening a second line to the same commit.
        let target = waiting.indexOf(parent);
        if (target === -1) {
          target = freeLane();
          waiting[target] = parent;
        }
        edges.push({ sha: parent, from: lane, to: target, kind: 'merge' });
      }
    }

    rows.push({
      sha: commit.sha,
      lane,
      colour: colourOf(lane),
      /** Lanes drawn straight through this row, so verticals are unbroken. */
      through: through.map((index) => ({ lane: index, colour: colourOf(index) })),
      edges: edges.map((edge) => ({ ...edge, colour: colourOf(edge.to) })),
      merge: parents.length > 1,
      root: parents.length === 0,
    });

    // Trailing empty lanes are not kept: the graph should be as narrow as the
    // history is, not as wide as it once briefly was.
    while (waiting.length && waiting[waiting.length - 1] === null) waiting.pop();
  }

  const width = rows.reduce(
    (widest, row) =>
      Math.max(widest, row.lane + 1, ...row.through.map((t) => t.lane + 1), ...row.edges.map((e) => e.to + 1)),
    1,
  );
  return { rows, width };
}

module.exports = { layout, colourOf, LANE_COLOURS };
