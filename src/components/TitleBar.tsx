import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { allTabs } from '../state/layout';
import { UsageGauge } from './UsageGauge';

export function TitleBar() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const splitActive = useStore((s) => s.splitActive);
  const evenSplits = useStore((s) => s.evenSplits);
  const toggleZoom = useStore((s) => s.toggleZoom);
  const zoomed = useStore((s) => s.zoomedLeafId);
  const profiles = useStore((s) => s.profiles);
  const authByProfile = useStore((s) => s.authByProfile);
  // Selecting the session object itself keeps this stable, so dragging a divider
  // or another pane streaming output no longer re-renders the title bar.
  const activeSession = useStore((s) => {
    const leaf = findLeafShallow(s.layout, s.activeLeafId);
    return leaf?.active ? (s.sessions[leaf.active] ?? null) : null;
  });
  const activeProfile = profiles.find((p) => p.id === activeSession?.profileId);

  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        {/* The toggle lives in the sidebar's own header; this is only the way back. */}
        {!settings.sidebarVisible && (
          <button
            className="icon-btn show-sidebar"
            title="Show sidebar (⌘B)"
            onClick={() => updateSettings({ sidebarVisible: true })}
          >
            &#9636; <span>Sessions</span>
          </button>
        )}
        <span className="app-name">Smart Terminal</span>
        {activeProfile && (
          <span
            className="titlebar-chip"
            style={{ borderColor: activeProfile.color, color: activeProfile.color }}
            title={
              authByProfile[activeProfile.id]?.loggedIn
                ? `Signed in as ${authByProfile[activeProfile.id].email}`
                : 'Not signed in'
            }
          >
            {activeProfile.name}
            {authByProfile[activeProfile.id]?.email && (
              <em className="titlebar-chip-email">{authByProfile[activeProfile.id].email}</em>
            )}
          </span>
        )}
        {activeProfile && <UsageGauge profileId={activeProfile.id} />}
        <WaitingOnYou />
      </div>

      <div className="titlebar-actions">
        <button className="icon-btn" title="Split right (⌘D)" onClick={() => splitActive('row')}>
          ⇥
        </button>
        <button className="icon-btn" title="Split down (⇧⌘D)" onClick={() => splitActive('column')}>
          ⇩
        </button>
        <button className="icon-btn" title="Even out splits (⌥⌘0)" onClick={evenSplits}>
          ⊞
        </button>
        <button
          className={`icon-btn${zoomed ? ' is-on' : ''}`}
          title="Maximize pane (⌥⌘⏎)"
          onClick={toggleZoom}
        >
          ⤢
        </button>
      </div>
    </header>
  );
}

function findLeafShallow(node: import('../state/types').LayoutNode, id: string): import('../state/types').LeafNode | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findLeafShallow(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * Decisions are what actually halt a run, so they are worth counting in one place.
 * One session stopped on a question is easy to miss; three of them piled up is the
 * moment to go and clear them.
 */
function WaitingOnYou() {
  const waiting = useStore(
    useShallow((s) =>
      allTabs(s.layout).filter((id) => s.sessions[id]?.autopilotState === 'waiting-for-you'),
    ),
  );
  const focusSession = useStore((s) => s.focusSession);
  if (!waiting.length) return null;

  return (
    <button
      className="titlebar-waiting"
      title="Sessions running on their own that have stopped on a question"
      onClick={() => focusSession(waiting[0])}
    >
      {waiting.length} waiting on you
    </button>
  );
}
