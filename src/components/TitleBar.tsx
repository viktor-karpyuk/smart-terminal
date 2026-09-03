import { useEffect, useState } from 'react';
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
  /*
   * The limits belong to an account, not to whichever tab is in front — and with
   * a folder or a Git view in front there is no session to ask. Falling back to
   * the default account keeps the gauge where it is instead of blinking out
   * every time you look at a file.
   */
  const gaugeProfile =
    activeProfile ??
    profiles.find((p) => p.id === settings.defaultProfileId) ??
    profiles[0];

  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        {/*
          The way back to the sidebar, and nothing else. It said "Sessions" when
          the sidebar held only sessions; it holds folders too now, and a menu
          button that names one of the things behind it is worse than one that
          names none.
        */}
        {!settings.sidebarVisible && (
          <button
            className="icon-btn show-sidebar"
            title="Show the sidebar (⌘B)"
            aria-label="Show the sidebar"
            onClick={() => updateSettings({ sidebarVisible: true })}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 3.5h10M2 7h10M2 10.5h10" />
            </svg>
          </button>
        )}
        <AppMark />
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
        <WaitingOnYou />
      </div>

      {/*
        The middle of the window, centred on the window itself rather than on
        whatever happens to be to its left. It is the one thing here you look at
        rather than press, and the middle is where the eye goes.
      */}
      <div className="titlebar-centre">
        {gaugeProfile && <UsageGauge profileId={gaugeProfile.id} />}
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

/**
 * What this app is and which build of it you are running, where the window's
 * name goes anyway.
 *
 * The build number is the useful half: "is the fix even installed?" comes up
 * constantly while iterating, and it should be answerable without opening a
 * panel. The description is there for anyone meeting the app for the first
 * time, and gets out of the way as the window narrows.
 */
function AppMark() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.api.version>> | null>(null);

  useEffect(() => {
    window.api.version().then(setInfo);
  }, []);

  const built = info?.builtAt ? new Date(info.builtAt) : null;
  return (
    <span
      className="app-mark"
      title={
        info
          ? `Smart Terminal ${info.version} · build ${info.build}\nBuilt ${built?.toLocaleString() ?? '—'}` +
            '\n\nA workbench for running many Claude Code sessions at once,\neach on its own account, beside the files they are working on.'
          : 'Smart Terminal'
      }
    >
      <span className="app-name">Smart Terminal</span>
      <span className="app-blurb">many Claude sessions, and their files</span>
      {info && (
        <span className="app-version">
          {info.version}
          <em>·{info.build}</em>
        </span>
      )}
    </span>
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
