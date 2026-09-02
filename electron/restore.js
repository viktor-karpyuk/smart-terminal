/**
 * Deciding what a window brings back, kept pure so it can be tested without an
 * app, a database or a screen.
 *
 * The rule that matters: **a window's own layout is the record of what was on it**.
 * A minimized session is the exception that proves it: it is deliberately not in
 * the layout — that is what freed its pane — so the window keeps a second list of
 * what it set aside, and both lists together are the record. Leaving the dock out
 * of this file would lose a minimized session on exactly the launch the layout
 * exists to survive.
 * Sessions used to be handed back by the `window_id` on their row instead, which
 * loses a session the moment that id names a window that is gone — the row is then
 * offered to no window at all, the renderer prunes the tab out of the layout it
 * just loaded, and the pruned layout is saved. The conversation survives in
 * History, but its pane is gone for good.
 */

/** Every session id the tree names, in no particular order. */
function tabsInLayout(node) {
  if (!node || typeof node !== 'object') return [];
  if (node.type === 'leaf') return Array.isArray(node.tabs) ? node.tabs.filter(Boolean) : [];
  if (!Array.isArray(node.children)) return [];
  return node.children.flatMap(tabsInLayout);
}

/**
 * The dock is stored as `{ sessionId, leafId }` so a restored tab can go back
 * where it came from. Only the id matters here, and a plain id is accepted too so
 * an older window's saved state still reads.
 */
function minimizedIds(minimized = []) {
  if (!Array.isArray(minimized)) return [];
  return minimized
    .map((entry) => (typeof entry === 'string' ? entry : entry?.sessionId))
    .filter(Boolean);
}

/** Every session this window is answerable for: the ones in panes and the ones docked. */
function windowTabs(layout, minimized = []) {
  return [...tabsInLayout(layout), ...minimizedIds(minimized)];
}

/**
 * Which of `rows` this window should restore.
 *
 * `openWindowIds` is every window this launch is actually bringing back. A row
 * belonging to one of the *others* is left to that window, which is what keeps a
 * session from being spawned twice. A row belonging to a window that is not
 * coming back is nobody's — so the layout naming it wins, and it comes home.
 */
function sessionsToRestore({ windowId, layout, minimized = [], rows = [], openWindowIds = [] }) {
  const named = new Set(windowTabs(layout, minimized));
  const otherWindows = new Set(openWindowIds.filter((id) => id && id !== windowId));
  return rows.filter((row) => {
    if (row.windowId && row.windowId !== windowId && otherWindows.has(row.windowId)) return false;
    return named.has(row.id) || row.windowId === windowId;
  });
}

/** Ids the window names that no row answers for — a pane or dock entry that cannot be revived. */
function unaccountedTabs(layout, rows = [], minimized = []) {
  const present = new Set(rows.map((row) => row.id));
  return windowTabs(layout, minimized).filter((id) => !present.has(id));
}

module.exports = { tabsInLayout, minimizedIds, windowTabs, sessionsToRestore, unaccountedTabs };
