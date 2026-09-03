/**
 * Tests for the split-tree engine — the part of the app where a subtle bug shows
 * up as panes vanishing or dividers drifting. Run with `npm test`.
 */
const assert = require('node:assert');
const L = require('../.test-build/layout');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const shape = (n) =>
  n.type === 'leaf'
    ? n.tabs.join(',') || '∅'
    : `${n.direction === 'row' ? 'H' : 'V'}[${n.children.map(shape).join(' | ')}]`;

// --- splitting -------------------------------------------------------------
test('split right nests a horizontal split', () => {
  const root = L.makeLeaf(['a']);
  const { root: next } = L.splitLeaf(root, root.id, 'row', 'b');
  assert.equal(shape(next), 'H[a | b]');
});

test('splitting a sibling along the same axis joins the existing split', () => {
  let root = L.makeLeaf(['a']);
  let r = L.splitLeaf(root, root.id, 'row', 'b');
  const leafB = r.leafId;
  r = L.splitLeaf(r.root, leafB, 'row', 'c');
  assert.equal(shape(r.root), 'H[a | b | c]', 'should stay flat, not nest H[a | H[b | c]]');
  assert.equal(r.root.sizes.length, 3);
  assert.ok(Math.abs(r.root.sizes.reduce((x, y) => x + y) - 1) < 1e-9, 'sizes normalize to 1');
});

test('cross-axis split nests', () => {
  const root = L.makeLeaf(['a']);
  const r1 = L.splitLeaf(root, root.id, 'row', 'b');
  const r2 = L.splitLeaf(r1.root, r1.leafId, 'column', 'c');
  assert.equal(shape(r2.root), 'H[a | V[b | c]]');
});

// --- drag & drop -----------------------------------------------------------
test('drop on centre moves the tab into the target pane', () => {
  const root = L.makeLeaf(['a']);
  const { root: split } = L.splitLeaf(root, root.id, 'row', 'b');
  const targetLeaf = split.children[0].id;
  const moved = L.dropTab(split, 'b', targetLeaf, 'center');
  assert.equal(shape(moved), 'a,b', 'the emptied pane collapses away');
});

test('drop on an edge re-splits around the target', () => {
  const root = L.makeLeaf(['a', 'b']);
  const moved = L.dropTab(root, 'b', root.id, 'bottom');
  assert.equal(shape(moved), 'V[a | b]');
});

test('drop on the left edge puts the tab first', () => {
  const root = L.makeLeaf(['a', 'b']);
  const moved = L.dropTab(root, 'b', root.id, 'left');
  assert.equal(shape(moved), 'H[b | a]');
});

test('dropping a pane\'s only tab back on its own edge is a no-op', () => {
  const root = L.makeLeaf(['a']);
  assert.equal(shape(L.dropTab(root, 'a', root.id, 'right')), 'a');
});

test('moving the last tab out of a pane does not destroy the drop target', () => {
  let root = L.makeLeaf(['a']);
  const r = L.splitLeaf(root, root.id, 'row', 'b');           // H[a | b]
  const targetLeaf = r.root.children[0].id;                    // the pane holding 'a'
  const moved = L.dropTab(r.root, 'b', targetLeaf, 'bottom');  // b leaves its own pane
  assert.equal(shape(moved), 'V[a | b]');
});

test('cross-pane edge drop joins a matching parent axis instead of nesting', () => {
  const base = L.makeLeaf(['a']);
  const r = L.splitLeaf(base, base.id, 'row', 'b');             // H[a | b]
  const r2 = L.splitLeaf(r.root, r.leafId, 'row', 'c');         // H[a | b | c]
  const paneA = r2.root.children[0].id;
  const moved = L.dropTab(r2.root, 'c', paneA, 'left');         // c to the far left
  assert.equal(shape(moved), 'H[c | a | b]');
});

// --- removal and pruning ---------------------------------------------------
test('closing a tab collapses the split it emptied', () => {
  const base = L.makeLeaf(['a']);
  const r = L.splitLeaf(base, base.id, 'row', 'b');
  assert.equal(shape(L.removeTab(r.root, 'b')), 'a');
});

test('closing the last tab leaves one empty pane', () => {
  const root = L.makeLeaf(['a']);
  const empty = L.removeTab(root, 'a');
  assert.equal(empty.type, 'leaf');
  assert.deepEqual(empty.tabs, []);
});

test('removal redistributes sizes so they still sum to 1', () => {
  const base = L.makeLeaf(['a']);
  const r1 = L.splitLeaf(base, base.id, 'row', 'b');
  const r2 = L.splitLeaf(r1.root, r1.leafId, 'row', 'c');
  const after = L.removeTab(r2.root, 'b');
  assert.equal(shape(after), 'H[a | c]');
  assert.ok(Math.abs(after.sizes.reduce((x, y) => x + y) - 1) < 1e-9);
});

test('prune flattens a nested split sharing its parent axis', () => {
  const inner = { id: 'i', type: 'split', direction: 'row', children: [L.makeLeaf(['b']), L.makeLeaf(['c'])], sizes: [0.5, 0.5] };
  const outer = { id: 'o', type: 'split', direction: 'row', children: [L.makeLeaf(['a']), inner], sizes: [0.5, 0.5] };
  const pruned = L.prune(outer);
  assert.equal(shape(pruned), 'H[a | b | c]');
  assert.deepEqual(pruned.sizes.map((s) => +s.toFixed(3)), [0.5, 0.25, 0.25]);
});

test('keepOnly drops tabs whose sessions are gone', () => {
  const base = L.makeLeaf(['a']);
  const r = L.splitLeaf(base, base.id, 'row', 'b');
  assert.equal(shape(L.keepOnly(r.root, new Set(['a']))), 'a');
});

test('evenOut resets every level', () => {
  const base = L.makeLeaf(['a']);
  const r1 = L.splitLeaf(base, base.id, 'row', 'b');
  const r2 = L.splitLeaf(r1.root, r1.leafId, 'row', 'c');
  const skewed = L.setSizes(r2.root, r2.root.id, [0.8, 0.1, 0.1]);
  assert.deepEqual(L.evenOut(skewed).sizes.map((s) => +s.toFixed(4)), [0.3333, 0.3333, 0.3333]);
});

test('reordering within a pane keeps every tab exactly once', () => {
  const root = L.makeLeaf(['a', 'b', 'c']);
  const moved = L.insertTab(root, root.id, 'c', 0);
  assert.deepEqual(moved.tabs, ['c', 'a', 'b']);
});

// --- regressions ---------------------------------------------------------
test('moving a tab keeps every other pane the size it was', () => {
  const a = L.makeLeaf(['a']), b = L.makeLeaf(['b']), c = L.makeLeaf(['c']), d = L.makeLeaf(['d']);
  const inner = { id: 'inner', type: 'split', direction: 'row', children: [b, c], sizes: [0.5, 0.5] };
  const root = { id: 'root', type: 'split', direction: 'column', children: [a, inner, d], sizes: [0.6, 0.2, 0.2] };

  // Dragging b out collapses the inner split; c inherits its slot, a and d must not move.
  const after = L.dropTab(root, 'b', a.id, 'center');
  assert.equal(shape(after), 'V[a,b | c | d]');
  assert.equal(after.children.length, after.sizes.length, 'a size per child');
  assert.deepEqual(after.sizes.map((s) => +s.toFixed(4)), [0.6, 0.2, 0.2]);
});

test('a collapsing nested split hands its share to the survivor', () => {
  const a = L.makeLeaf(['a']), b = L.makeLeaf(['b']), c = L.makeLeaf(['c']);
  const inner = { id: 'inner', type: 'split', direction: 'row', children: [b, c], sizes: [0.5, 0.5] };
  const root = { id: 'root', type: 'split', direction: 'column', children: [a, inner], sizes: [0.7, 0.3] };
  const after = L.dropTab(root, 'b', a.id, 'center');
  assert.deepEqual(after.sizes.map((s) => +s.toFixed(4)), [0.7, 0.3]);
});

test('reordering tabs leaves the selected one selected', () => {
  const leaf = L.makeLeaf(['a', 'b', 'c']);       // 'a' is active
  const reordered = L.insertTab(L.removeTab(leaf, 'c'), leaf.id, 'c', 0, false);
  assert.deepEqual(reordered.tabs, ['c', 'a', 'b']);
  assert.equal(reordered.active, 'a', 'dragging a background tab must not focus it');
});

test('dropping a tab into a pane does focus it', () => {
  const leaf = L.makeLeaf(['a', 'b']);
  assert.equal(L.insertTab(leaf, leaf.id, 'b', 0).active, 'b');
});

test('splitting leaves an empty pane that survives pruning', () => {
  const root = L.makeLeaf(['a']);
  const { root: split, leafId } = L.splitEmpty(root, root.id, 'row');
  assert.equal(shape(split), 'H[a | ∅]');
  // Any later operation prunes; the deliberate empty pane must still be there.
  assert.equal(shape(L.prune(split)), 'H[a | ∅]');
  assert.ok(leafId, 'returns the pane it made');
});

test('a pane emptied by closing its last tab still collapses', () => {
  const base = L.makeLeaf(['a']);
  const { root } = L.splitLeaf(base, base.id, 'row', 'b');
  assert.equal(shape(L.removeTab(root, 'b')), 'a');
});

test('putting a tab in an empty pane makes it an ordinary pane', () => {
  const root = L.makeLeaf(['a']);
  const { root: split, leafId } = L.splitEmpty(root, root.id, 'row');
  const filled = L.insertTab(split, leafId, 'b');
  assert.equal(shape(filled), 'H[a | b]');
  // No longer deliberate, so emptying it again collapses it.
  assert.equal(shape(L.removeTab(filled, 'b')), 'a');
});

// --- minimizing a whole section, and putting it back -----------------------

/*
 * The place is remembered by a TAB in the neighbouring pane, never by a split id
 * or an index: removing a pane rebuilds the tree above it, and a split with two
 * children collapses into its survivor, so both of those are gone by the time
 * anyone wants to undo it.
 */
test('a pane remembers which side of its neighbour it was on', () => {
  let root = L.makeLeaf(['a']);
  const r = L.splitLeaf(root, root.id, 'row', 'b');
  const place = L.panePlace(r.root, r.leafId);
  assert.equal(place.anchorTabId, 'a');
  assert.equal(place.side, 'right');
});

test('the first pane of a split remembers it was on the left', () => {
  let root = L.makeLeaf(['a']);
  const r = L.splitLeaf(root, root.id, 'row', 'b');
  const leafA = L.leafOfTab(r.root, 'a');
  const place = L.panePlace(r.root, leafA.id);
  assert.equal(place.anchorTabId, 'b');
  assert.equal(place.side, 'left');
});

test('a stacked pane remembers top and bottom, not left and right', () => {
  let root = L.makeLeaf(['a']);
  const r = L.splitLeaf(root, root.id, 'column', 'b');
  assert.equal(L.panePlace(r.root, r.leafId).side, 'bottom');
});

test('a section comes back exactly where it was', () => {
  let root = L.makeLeaf(['a']);
  let r = L.splitLeaf(root, root.id, 'row', 'b');
  r = L.splitLeaf(r.root, r.leafId, 'row', 'c');
  assert.equal(shape(r.root), 'H[a | b | c]');

  const leafB = L.leafOfTab(r.root, 'b');
  const place = L.panePlace(r.root, leafB.id);
  const without = L.closePane(r.root, leafB.id);
  assert.equal(shape(without), 'H[a | c]');

  const back = L.restorePaneAt(without, ['b'], 'b', place, L.allLeaves(without)[0].id);
  assert.equal(shape(back.root), 'H[a | b | c]', 'it goes back between a and c');
});

test('a section whose split collapsed still comes back beside its neighbour', () => {
  let root = L.makeLeaf(['a']);
  const r = L.splitLeaf(root, root.id, 'row', 'b');
  const leafB = L.leafOfTab(r.root, 'b');
  const place = L.panePlace(r.root, leafB.id);
  // Removing it collapses the split entirely — there is no tree left to index into.
  const without = L.closePane(r.root, leafB.id);
  assert.equal(shape(without), 'a');

  const back = L.restorePaneAt(without, ['b'], 'b', place, L.allLeaves(without)[0].id);
  assert.equal(shape(back.root), 'H[a | b]');
});

test('a stacked section comes back stacked', () => {
  let root = L.makeLeaf(['a']);
  const r = L.splitLeaf(root, root.id, 'column', 'b');
  const leafB = L.leafOfTab(r.root, 'b');
  const place = L.panePlace(r.root, leafB.id);
  const back = L.restorePaneAt(L.closePane(r.root, leafB.id), ['b'], 'b', place, L.allLeaves(L.closePane(r.root, leafB.id))[0].id);
  assert.equal(shape(back.root), 'V[a | b]');
});

/*
 * Its neighbour can be closed while it is away. Refusing to bring a section back
 * because the pane it used to sit beside has gone would be the worst of both.
 */
test('a section whose anchor is gone still comes back, beside the fallback', () => {
  const place = { anchorTabId: 'gone', side: 'right', share: 0.5 };
  const root = L.makeLeaf(['a']);
  const back = L.restorePaneAt(root, ['b'], 'b', place, root.id);
  assert.equal(shape(back.root), 'H[a | b]');
});

test('a section carries all its tabs back, and which one was in front', () => {
  const root = L.makeLeaf(['a']);
  const place = L.panePlace(root, root.id);
  const back = L.restorePaneAt(root, ['x', 'y', 'z'], 'y', place, root.id);
  const leaf = L.leafOfTab(back.root, 'y');
  assert.deepEqual(leaf.tabs, ['x', 'y', 'z']);
  assert.equal(leaf.active, 'y');
});

test('a section comes back about the width it was', () => {
  let root = L.makeLeaf(['a']);
  const r = L.splitLeaf(root, root.id, 'row', 'b');
  const leafB = L.leafOfTab(r.root, 'b');
  const wide = L.setSizes(r.root, r.root.id, [0.25, 0.75]);
  const place = L.panePlace(wide, leafB.id);
  assert.ok(Math.abs(place.share - 0.75) < 0.01, 'its share is remembered');

  const back = L.restorePaneAt(L.closePane(wide, leafB.id), ['b'], 'b', place, L.allLeaves(L.closePane(wide, leafB.id))[0].id);
  const sizes = back.root.sizes;
  assert.ok(Math.abs(sizes[1] - 0.75) < 0.05, `came back at ${sizes[1]}, wanted about 0.75`);
});

// --- trading two panes -----------------------------------------------------

test('two panes trade what they hold, not where they sit', () => {
  let root = L.makeLeaf(['a']);
  let r = L.splitLeaf(root, root.id, 'row', 'b');
  r = L.splitLeaf(r.root, r.leafId, 'row', 'c');
  assert.equal(shape(r.root), 'H[a | b | c]');

  const leafA = L.leafOfTab(r.root, 'a');
  const leafC = L.leafOfTab(r.root, 'c');
  const swapped = L.swapPanes(r.root, leafA.id, leafC.id);
  assert.equal(shape(swapped), 'H[c | b | a]');
});

test('a pane holding several tabs takes all of them, and which was in front', () => {
  let root = L.makeLeaf(['a', 'b']);
  root = L.setActiveTab(root, root.id, 'b');
  const r = L.splitLeaf(root, root.id, 'row', 'c');
  const left = L.leafOfTab(r.root, 'a');
  const swapped = L.swapPanes(r.root, left.id, r.leafId);
  assert.equal(shape(swapped), 'H[c | a,b]');
  assert.equal(L.leafOfTab(swapped, 'a').active, 'b', 'the tab that was in front still is');
});

test('panes in different splits still trade', () => {
  let root = L.makeLeaf(['a']);
  let r = L.splitLeaf(root, root.id, 'row', 'b');
  r = L.splitLeaf(r.root, r.leafId, 'column', 'c');
  assert.equal(shape(r.root), 'H[a | V[b | c]]');
  const leafA = L.leafOfTab(r.root, 'a');
  const leafC = L.leafOfTab(r.root, 'c');
  assert.equal(shape(L.swapPanes(r.root, leafA.id, leafC.id)), 'H[c | V[b | a]]');
});

test('sizes stay with the places, not with what was moved into them', () => {
  let root = L.makeLeaf(['a']);
  const r = L.splitLeaf(root, root.id, 'row', 'b');
  const wide = L.setSizes(r.root, r.root.id, [0.3, 0.7]);
  const leafA = L.leafOfTab(wide, 'a');
  const swapped = L.swapPanes(wide, leafA.id, r.leafId);
  assert.equal(shape(swapped), 'H[b | a]');
  assert.deepEqual(swapped.sizes, [0.3, 0.7], 'the left slot is still the narrow one');
});

test('swapping a pane with itself changes nothing', () => {
  const root = L.makeLeaf(['a']);
  assert.equal(shape(L.swapPanes(root, root.id, root.id)), 'a');
});

test('an empty pane can be traded into, and is not pruned away', () => {
  const root = L.makeLeaf(['a']);
  const { root: split, leafId } = L.splitEmpty(root, root.id, 'row');
  assert.equal(shape(split), 'H[a | ∅]');
  const leafA = L.leafOfTab(split, 'a');
  assert.equal(shape(L.swapPanes(split, leafA.id, leafId)), 'H[∅ | a]');
});

test('a pane that is not there leaves the layout alone', () => {
  let root = L.makeLeaf(['a']);
  const r = L.splitLeaf(root, root.id, 'row', 'b');
  assert.equal(shape(L.swapPanes(r.root, 'nope', r.leafId)), 'H[a | b]');
});

console.log(`\n${passed} passing`);


// --- a whole section set aside, and put back where it was -------------------

/**
 * The case that was wrong: a pane whose neighbour is not one pane but several.
 *
 * Remembering "the pane holding tab X" is enough while the neighbour is a single
 * pane. When it is a column of three, X names one of them, and the pane came
 * back squeezed beside that one instead of alongside the whole column.
 */
test('a pane comes back between the two it sat between', () => {
  const start = L.makeLeaf(['a']);
  let r = L.splitLeaf(start, start.id, 'row', 'b');
  r = L.splitLeaf(r.root, L.leafOfTab(r.root, 'b').id, 'row', 'c');
  const middle = L.leafOfTab(r.root, 'b').id;
  const remembered = L.panePlace(r.root, middle);
  const without = L.closePane(r.root, middle);
  assert.equal(shape(without), 'H[a | c]');

  const back = L.restorePaneAt(without, ['b'], 'b', remembered, L.allLeaves(without)[0].id);
  assert.equal(shape(back.root), 'H[a | b | c]');
});

test('a pane beside a column of panes comes back beside the whole column', () => {
  const start = L.makeLeaf(['a']);
  let r = L.splitLeaf(start, start.id, 'row', 'b');
  r = L.splitLeaf(r.root, L.leafOfTab(r.root, 'b').id, 'column', 'c');
  assert.equal(shape(r.root), 'H[a | V[b | c]]');

  const left = L.leafOfTab(r.root, 'a').id;
  const remembered = L.panePlace(r.root, left);
  const without = L.closePane(r.root, left);
  assert.equal(shape(without), 'V[b | c]');

  const back = L.restorePaneAt(without, ['a'], 'a', remembered, L.allLeaves(without)[0].id);
  assert.equal(shape(back.root), 'H[a | V[b | c]]', 'a belongs beside the whole column, not beside b');
});

test('a pane whose neighbours have all closed still comes back', () => {
  const start = L.makeLeaf(['a']);
  const r = L.splitLeaf(start, start.id, 'row', 'b');
  const bLeaf = L.leafOfTab(r.root, 'b').id;
  const remembered = L.panePlace(r.root, bLeaf);
  let without = L.closePane(r.root, bLeaf);
  without = L.removeTab(without, 'a');

  const back = L.restorePaneAt(without, ['b'], 'b', remembered, L.allLeaves(without)[0]?.id ?? '');
  assert.deepEqual(L.allTabs(back.root), ['b']);
});

test('a pane keeps roughly the width it had', () => {
  const start = L.makeLeaf(['a']);
  const r = L.splitLeaf(start, start.id, 'row', 'b');
  const root = L.setSizes(r.root, r.root.id, [0.75, 0.25]);
  const bLeaf = L.leafOfTab(root, 'b').id;
  const remembered = L.panePlace(root, bLeaf);
  assert.ok(Math.abs(remembered.share - 0.25) < 0.01, `share was ${remembered.share}`);

  const without = L.closePane(root, bLeaf);
  const back = L.restorePaneAt(without, ['b'], 'b', remembered, L.allLeaves(without)[0].id);
  assert.ok(Math.abs(back.root.sizes[1] - 0.25) < 0.02, `expected about a quarter, got ${back.root.sizes[1]}`);
});
