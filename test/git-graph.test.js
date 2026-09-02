const assert = require('node:assert');
const test = require('node:test');

const { layout } = require('../electron/git-graph');
const { parseRefs, entry } = require('../electron/git');

/** `a <- b` reads "a's parent is b", which is the direction git reports. */
const c = (sha, ...parents) => ({ sha, parents });

test('a straight history is one lane', () => {
  const { rows, width } = layout([c('d', 'c'), c('c', 'b'), c('b', 'a'), c('a')]);
  assert.deepStrictEqual(rows.map((r) => r.lane), [0, 0, 0, 0]);
  assert.strictEqual(width, 1);
  assert.ok(rows[3].root, 'the commit with no parents is a root');
});

/*
 * The rule the whole picture rests on. A merge keeps its FIRST parent's lane, so
 * the trunk stays a straight line down the page and the branch is the one that
 * bends — get this backwards and every history looks like a staircase.
 */
test('a merge keeps the first parent in its own lane and bends the second out', () => {
  //   m        merge of trunk (t1) and a branch (b1)
  //   |\
  //   t1 b1
  //   |  /
  //   base
  const { rows } = layout([c('m', 't1', 'b1'), c('t1', 'base'), c('b1', 'base'), c('base')]);
  const [m, t1, b1, base] = rows;

  assert.strictEqual(m.lane, 0);
  assert.ok(m.merge);
  assert.strictEqual(t1.lane, 0, 'the first parent carries on in the merge lane');
  assert.strictEqual(b1.lane, 1, 'the second parent gets a lane of its own');
  assert.strictEqual(base.lane, 0, 'the shared ancestor comes back to the leftmost lane');

  const bend = m.edges.find((e) => e.kind === 'merge');
  assert.deepStrictEqual({ from: bend.from, to: bend.to }, { from: 0, to: 1 });
});

test('a lane that has ended is reused rather than the graph growing wider', () => {
  // Two branches, one after the other, never open at the same time.
  const { rows, width } = layout([
    c('m2', 't2', 'b2'),
    c('t2', 'm1'),
    c('b2', 'm1'),
    c('m1', 't1', 'b1'),
    c('t1', 'base'),
    c('b1', 'base'),
    c('base'),
  ]);
  assert.strictEqual(width, 2, 'the second branch takes the lane the first gave back');
  assert.deepStrictEqual(rows.map((r) => r.lane), [0, 0, 1, 0, 0, 1, 0]);
});

test('an octopus merge opens a lane per extra parent', () => {
  const { rows, width } = layout([
    c('m', 'a', 'b', 'd'),
    c('a', 'root'),
    c('b', 'root'),
    c('d', 'root'),
    c('root'),
  ]);
  assert.strictEqual(width, 3);
  assert.strictEqual(rows[0].edges.length, 3);
  assert.deepStrictEqual(rows[0].edges.map((e) => e.to), [0, 1, 2]);
});

test('lanes that merely pass a row are reported so their verticals are unbroken', () => {
  const { rows } = layout([c('m', 't1', 'b1'), c('t1', 'base'), c('b1', 'base'), c('base')]);
  // While t1 is drawn in lane 0, the branch waiting in lane 1 passes straight by.
  assert.deepStrictEqual(rows[1].through.map((t) => t.lane), [1]);
  assert.deepStrictEqual(rows[0].through, [], 'nothing passes the newest row');
});

test('two branches converging on one commit leave only the leftmost open', () => {
  const { rows, width } = layout([c('a', 'shared'), c('b', 'shared'), c('shared')]);
  assert.deepStrictEqual(rows.map((r) => r.lane), [0, 1, 0]);
  assert.strictEqual(width, 2);
  // Lane 1 ended at `shared`, so nothing passes below it.
  assert.deepStrictEqual(rows[2].through, []);
});

test('an empty history lays out to nothing rather than throwing', () => {
  assert.deepStrictEqual(layout([]), { rows: [], width: 1 });
  assert.deepStrictEqual(layout(), { rows: [], width: 1 });
});

test('a commit whose parent is missing from the page still lays out', () => {
  // The oldest row of a --max-count page names a parent that was not fetched.
  const { rows } = layout([c('a', 'b'), c('b', 'not-on-this-page')]);
  assert.deepStrictEqual(rows.map((r) => r.lane), [0, 0]);
});

test('every lane gets a colour, and the same lane always gets the same one', () => {
  const { rows } = layout([c('m', 't1', 'b1'), c('t1', 'base'), c('b1', 'base'), c('base')]);
  assert.strictEqual(rows[0].colour, rows[3].colour, 'lane 0 is one colour throughout');
  assert.notStrictEqual(rows[1].colour, rows[2].colour, 'different lanes are told apart');
});

// --- what git says, as the panel reads it ---------------------------------

test('a decoration line is split into the refs a row shows', () => {
  const refs = parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/tags/v1.0');
  assert.deepStrictEqual(refs, [
    { kind: 'local', name: 'main', head: true },
    { kind: 'remote', name: 'origin/main', head: false },
    { kind: 'tag', name: 'v1.0', head: false },
  ]);
  assert.deepStrictEqual(parseRefs(''), []);
  assert.deepStrictEqual(parseRefs(undefined), []);
});

test('a detached HEAD is a ref of its own, not a branch', () => {
  assert.deepStrictEqual(parseRefs('HEAD'), [{ kind: 'head', name: 'HEAD', head: true }]);
});

/*
 * A file can be staged and edited again at the same time. Flattening those two
 * letters into one is how a half-staged file gets committed whole by mistake.
 */
test('a file staged and then edited again reads as partial, not staged', () => {
  const both = entry('/repo', 'src/a.ts', 'MM');
  assert.strictEqual(both.staged, false);
  assert.strictEqual(both.partial, true);
  assert.strictEqual(both.letter, 'M');

  const clean = entry('/repo', 'src/a.ts', 'M.');
  assert.strictEqual(clean.staged, true);
  assert.strictEqual(clean.partial, false);

  const unstaged = entry('/repo', 'src/a.ts', '.M');
  assert.strictEqual(unstaged.staged, false);
  assert.strictEqual(unstaged.partial, false);
  assert.strictEqual(unstaged.letter, 'M');
});

test('untracked and conflicted files carry their own marks', () => {
  const untracked = entry('/repo', 'notes.md', '??');
  assert.strictEqual(untracked.untracked, true);
  assert.strictEqual(untracked.letter, '?');
  assert.strictEqual(untracked.staged, false);

  const conflicted = entry('/repo', 'src/a.ts', 'UU');
  assert.strictEqual(conflicted.conflicted, true);
  assert.strictEqual(conflicted.letter, '!');
});

test('a path is split into the folder and the name the tree groups by', () => {
  assert.deepStrictEqual(
    (({ dir, name }) => ({ dir, name }))(entry('/repo', 'src/state/store.ts', '.M')),
    { dir: 'src/state', name: 'store.ts' },
  );
  assert.deepStrictEqual(
    (({ dir, name }) => ({ dir, name }))(entry('/repo', 'README.md', '.M')),
    { dir: '', name: 'README.md' },
  );
});
