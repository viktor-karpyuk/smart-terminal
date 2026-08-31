/**
 * A short, sayable codename for a session that has not been given one.
 *
 * The folder is a poor identity when several sessions sit in the same place —
 * three tabs reading "~" say nothing — so every session starts with a name of its
 * own. One word, because a tab is narrow. It is only a starting point: renaming
 * replaces it and the new name sticks.
 */
const NAMES = [
  'anchor', 'arbor', 'aster', 'basalt', 'basin', 'beacon', 'bellows', 'birch',
  'bramble', 'brine', 'cairn', 'canyon', 'cedar', 'cinder', 'cobalt', 'comet',
  'compass', 'coral', 'cove', 'crag', 'delta', 'dune', 'ember', 'fathom',
  'fennel', 'ferry', 'flint', 'forge', 'fjord', 'gable', 'garnet', 'geyser',
  'glacier', 'granite', 'grove', 'harbor', 'hearth', 'heron', 'indigo', 'inlet',
  'ironwood', 'jetty', 'juniper', 'kestrel', 'kettle', 'lantern', 'ledger', 'lichen',
  'lumen', 'magnet', 'mallow', 'marsh', 'meadow', 'mesa', 'meridian', 'mica',
  'moraine', 'nettle', 'orbit', 'orchard', 'otter', 'pampas', 'pier', 'pinion',
  'plume', 'quarry', 'quartz', 'quill', 'rampart', 'ridge', 'rill', 'rookery',
  'sable', 'saffron', 'sextant', 'shale', 'sienna', 'silo', 'sparrow', 'spindle',
  'summit', 'tally', 'tannin', 'thicket', 'tide', 'timber', 'trellis', 'tundra',
  'vale', 'vellum', 'verdigris', 'willow', 'wren', 'zenith',
];

/** A name not already in `taken`; numbered only once the list runs out. */
export function generateSessionName(taken: Iterable<string | null | undefined>): string {
  const used = new Set([...taken].filter(Boolean) as string[]);
  const free = NAMES.filter((name) => !used.has(name));
  if (free.length) return free[Math.floor(Math.random() * free.length)];

  const base = NAMES[Math.floor(Math.random() * NAMES.length)];
  let n = 2;
  while (used.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}
