const assert = require('node:assert');
const test = require('node:test');

const {
  tabsInLayout,
  minimizedIds,
  windowTabs,
  sessionsToRestore,
  unaccountedTabs,
} = require('../electron/restore');

const leaf = (id, tabs) => ({ id, type: 'leaf', tabs, active: tabs[0] ?? null });
const split = (...children) => ({
  id: 'split',
  type: 'split',
  direction: 'row',
  children,
  sizes: children.map(() => 1 / children.length),
});

const WIN_A = '69370dd6';
const WIN_B = '1cd7870d';

test('every tab in a nested tree is named', () => {
  const layout = split(leaf('l1', ['a', 'b']), split(leaf('l2', ['c']), leaf('l3', [])));
  assert.deepStrictEqual(tabsInLayout(layout).sort(), ['a', 'b', 'c']);
});

test('a layout that is a bare leaf still names its tabs', () => {
  assert.deepStrictEqual(tabsInLayout(leaf('l1', ['a'])), ['a']);
});

test('a missing layout names nothing rather than throwing', () => {
  assert.deepStrictEqual(tabsInLayout(null), []);
});

test("a window restores what its own layout names", () => {
  const layout = leaf('l1', ['a', 'b']);
  const rows = [
    { id: 'a', windowId: WIN_A },
    { id: 'b', windowId: WIN_A },
    { id: 'z', windowId: WIN_B },
  ];
  const restored = sessionsToRestore({ windowId: WIN_A, layout, rows, openWindowIds: [WIN_A, WIN_B] });
  assert.deepStrictEqual(restored.map((r) => r.id), ['a', 'b']);
});

/*
 * The regression this file exists for. Two sessions were filed under a second
 * window; that window was marked closed by a copy of the app shutting down over
 * the running one's database, so it never came back — and the sessions were then
 * offered to no window at all. They had a pane waiting for them the whole time.
 */
test('a session whose window is not coming back is restored by the layout that names it', () => {
  const layout = leaf('l1', ['codebucket', 'sable']);
  const rows = [
    { id: 'codebucket', windowId: WIN_B },
    { id: 'sable', windowId: WIN_B },
  ];
  const restored = sessionsToRestore({
    windowId: WIN_A,
    layout,
    rows,
    // WIN_B is gone: it is not among the windows this launch brings back.
    openWindowIds: [WIN_A],
  });
  assert.deepStrictEqual(restored.map((r) => r.id), ['codebucket', 'sable']);
});

test('a session another open window is bringing back is left to it', () => {
  // Both layouts name it — only the window it belongs to may start it, or one
  // session id would get two processes.
  const layout = leaf('l1', ['shared']);
  const rows = [{ id: 'shared', windowId: WIN_B }];
  const restored = sessionsToRestore({
    windowId: WIN_A,
    layout,
    rows,
    openWindowIds: [WIN_A, WIN_B],
  });
  assert.deepStrictEqual(restored, []);
});

test('a session filed under this window comes back even if no pane names it yet', () => {
  const rows = [{ id: 'adopted', windowId: WIN_A }];
  const restored = sessionsToRestore({ windowId: WIN_A, layout: leaf('l1', []), rows, openWindowIds: [WIN_A] });
  assert.deepStrictEqual(restored.map((r) => r.id), ['adopted']);
});

test('a session belonging to no window at all is still restorable', () => {
  // Adoption files a session started by hand without a window.
  const rows = [{ id: 'byhand', windowId: null }];
  const restored = sessionsToRestore({ windowId: WIN_A, layout: leaf('l1', ['byhand']), rows, openWindowIds: [WIN_A] });
  assert.deepStrictEqual(restored.map((r) => r.id), ['byhand']);
});

test('panes naming a session with no row left are reported, not silently dropped', () => {
  const layout = split(leaf('l1', ['a']), leaf('l2', ['deleted']));
  assert.deepStrictEqual(unaccountedTabs(layout, [{ id: 'a', windowId: WIN_A }]), ['deleted']);
});

/*
 * A minimized session is on purpose absent from the layout — that is what gave
 * its pane back. So the layout alone can no longer be the whole record of what a
 * window had, and every one of these guards a way the dock could quietly vanish.
 */

test('the dock is read whether it stores entries or bare ids', () => {
  assert.deepStrictEqual(minimizedIds([{ sessionId: 'a', leafId: 'l1' }, 'b']), ['a', 'b']);
  assert.deepStrictEqual(minimizedIds([{ leafId: 'l1' }, null, undefined]), []);
  assert.deepStrictEqual(minimizedIds(undefined), []);
  assert.deepStrictEqual(minimizedIds('not a list'), []);
});

test('a window answers for its panes and its dock together', () => {
  const layout = split(leaf('l1', ['a']), leaf('l2', ['b']));
  assert.deepStrictEqual(
    windowTabs(layout, [{ sessionId: 'docked', leafId: 'l1' }]).sort(),
    ['a', 'b', 'docked'],
  );
});

test('a minimized session comes back even though no pane names it', () => {
  const layout = leaf('l1', ['a']);
  const rows = [{ id: 'a', windowId: WIN_A }, { id: 'docked', windowId: WIN_A }];
  const restored = sessionsToRestore({
    windowId: WIN_A,
    layout,
    minimized: [{ sessionId: 'docked', leafId: 'l1' }],
    rows,
    openWindowIds: [WIN_A],
  });
  assert.deepStrictEqual(restored.map((r) => r.id).sort(), ['a', 'docked']);
});

/*
 * The 31 Aug loss, replayed against the dock. A session whose window id points at
 * a window that is not coming back has only the naming to save it — and a
 * minimized session is named by the dock, never by a pane.
 */
test('a minimized session whose window is gone is restored by the dock that names it', () => {
  const restored = sessionsToRestore({
    windowId: WIN_A,
    layout: leaf('l1', []),
    minimized: [{ sessionId: 'docked', leafId: null }],
    rows: [{ id: 'docked', windowId: WIN_B }],
    openWindowIds: [WIN_A],
  });
  assert.deepStrictEqual(restored.map((r) => r.id), ['docked']);
});

test('a minimized session held by another live window is left to it', () => {
  const restored = sessionsToRestore({
    windowId: WIN_A,
    layout: leaf('l1', []),
    minimized: [{ sessionId: 'docked', leafId: null }],
    rows: [{ id: 'docked', windowId: WIN_B }],
    openWindowIds: [WIN_A, WIN_B],
  });
  assert.deepStrictEqual(restored, []);
});

test('a dock entry with no row left is reported like a pane with none', () => {
  assert.deepStrictEqual(
    unaccountedTabs(leaf('l1', ['a']), [{ id: 'a', windowId: WIN_A }], [{ sessionId: 'gone' }]),
    ['gone'],
  );
});

test('a window with no dock behaves exactly as before', () => {
  const layout = split(leaf('l1', ['a']), leaf('l2', ['b']));
  assert.deepStrictEqual(windowTabs(layout).sort(), ['a', 'b']);
  assert.deepStrictEqual(unaccountedTabs(layout, [{ id: 'a' }, { id: 'b' }]), []);
});
