import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { allTabs } from '../state/layout';
import { NewSessionMenu } from './NewSessionMenu';
import { SESSION_MIME } from '../lib/drag';
import { sessionLabel } from '../lib/labels';
import { compactPath } from '../lib/labels';
import { PathLabel } from './PathLabel';
import { AccountsIcon, AppearanceIcon, HistoryIcon, UsageIcon } from './icons';

/** Every live session, grouped by the account it belongs to. */
export function Sidebar() {
  const profiles = useStore((s) => s.profiles);
  const settings = useStore((s) => s.settings);
  const authByProfile = useStore((s) => s.authByProfile);
  const activeLeafId = useStore((s) => s.activeLeafId);
  const setProfileEditorOpen = useStore((s) => s.setProfileEditorOpen);
  const newSession = useStore((s) => s.newSession);
  const setUsagePanelOpen = useStore((s) => s.setUsagePanelOpen);
  const setHistoryOpen = useStore((s) => s.setHistoryOpen);
  const setAppearanceOpen = useStore((s) => s.setAppearanceOpen);
  const updateSettings = useStore((s) => s.updateSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Only membership matters here; each row subscribes to its own session, so a
  // session streaming output no longer re-renders the whole list.
  // Where you are working, so a new session opens there rather than in whatever
  // folder the account happens to default to.
  const activeCwd = useStore((s) => {
    const leaf = allTabs(s.layout).length ? s.sessions[s.activeSessionId ?? ''] : null;
    return leaf?.cwd;
  });

  const membership = useStore(
    useShallow((s) => allTabs(s.layout).map((id) => id + ' ' + (s.sessions[id]?.profileId ?? ''))),
  );
  const runningCount = useStore(
    (s) => allTabs(s.layout).filter((id) => s.sessions[id]?.status === 'running').length,
  );

  const grouped = useMemo(() => {
    const pairs = membership.map((entry) => entry.split(' ') as [string, string]);
    return profiles
      .map((profile) => ({
        profile,
        ids: pairs.filter(([, profileId]) => profileId === profile.id).map(([id]) => id),
      }))
      .filter((group) => group.ids.length > 0);
  }, [profiles, membership]);

  return (
    <aside className="sidebar" style={{ width: settings.sidebarWidth }}>
      <div className="sidebar-header">
        <button
          className="icon-btn"
          title="Hide sidebar (⌘B)"
          onClick={() => updateSettings({ sidebarVisible: false })}
        >
          &#9636;
        </button>
        <span className="sidebar-title">Sessions</span>
        <span className="sidebar-count">{runningCount} running</span>
      </div>

      <div className="sidebar-scroll">
        {grouped.length === 0 && <p className="sidebar-empty">No sessions yet.</p>}
        {grouped.map(({ profile, ids }) => {
          const auth = authByProfile[profile.id];
          return (
            <div className="sidebar-group" key={profile.id}>
              <div
                className="sidebar-group-header"
                title={auth?.loggedIn ? `Signed in as ${auth.email}` : 'Not signed in'}
              >
                <span className="tab-dot" style={{ background: profile.color }} />
                <span style={{ color: profile.color }}>{profile.name}</span>
                <span className="sidebar-group-account">{auth?.loggedIn ? auth.email : ''}</span>
                <span className="sidebar-group-count">{ids.length}</span>
              </div>
              {ids.map((id) => (
                <SidebarItem key={id} sessionId={id} />
              ))}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-footer-row">
          <button
            className="primary-btn grow"
            onClick={() => newSession({ leafId: activeLeafId, cwd: activeCwd })}
          >
            + New session
          </button>
          <button
            ref={menuButtonRef}
            className="ghost-btn"
            title="New session as another account"
            onClick={() => setMenuOpen((open) => !open)}
          >
            &#8964;
          </button>
        </div>
        {menuOpen && (
          <NewSessionMenu
            leafId={activeLeafId}
            cwdHint={activeCwd}
            anchorEl={menuButtonRef.current}
            onClose={() => setMenuOpen(false)}
          />
        )}
        <div className="tool-row">
          <button className="tool" onClick={() => setProfileEditorOpen(true)} title="Accounts (⌘,)">
            <AccountsIcon />
            <span>Accounts</span>
          </button>
          <button className="tool" onClick={() => setUsagePanelOpen(true)} title="Usage limits (⌘U)">
            <UsageIcon />
            <span>Usage</span>
          </button>
          <button className="tool" onClick={() => setHistoryOpen(true)} title="History (⌘Y)">
            <HistoryIcon />
            <span>History</span>
          </button>
          <button className="tool" onClick={() => setAppearanceOpen(true)} title="Appearance (⇧⌘,)">
            <AppearanceIcon />
            <span>Theme</span>
          </button>
        </div>
        <BuildLine />
      </div>
    </aside>
  );
}

/**
 * Which build this actually is. Worth a permanent line rather than a menu item:
 * the question "is the fix even installed?" comes up constantly while iterating,
 * and it should be answerable at a glance and copyable into a bug report.
 */
function BuildLine() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.api.version>> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.api.version().then(setInfo);
  }, []);

  if (!info) return null;

  const built = info.builtAt
    ? new Date(info.builtAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  const full = [
    `Smart Terminal ${info.version}${info.build ? ` (build ${info.build})` : ''}`,
    built ? `built ${built}` : null,
    `Electron ${info.electron} · Node ${info.node}`,
  ]
    .filter(Boolean)
    .join(String.fromCharCode(10));

  return (
    <button
      className="build-line"
      title={`${full}${String.fromCharCode(10)}${String.fromCharCode(10)}Click to copy`}
      onClick={() => {
        navigator.clipboard.writeText(full);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? 'copied' : `v${info.version}${info.build ? `·${info.build}` : ''}`}
      {built && !copied && <em>{built}</em>}
    </button>
  );
}

function SidebarItem({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const homedir = useStore((s) => s.homedir);
  const focusSession = useStore((s) => s.focusSession);
  const requestClose = useStore((s) => s.requestClose);
  const setRenamingId = useStore((s) => s.setRenamingSessionId);
  const setDraggingId = useStore((s) => s.setDraggingSessionId);
  const openContextMenu = useStore((s) => s.openContextMenu);

  if (!session) return null;

  const label = sessionLabel(session, homedir);
  const where = compactPath(session.cwd, homedir);

  return (
    <div
      className={`sidebar-item${session.status === 'exited' ? ' is-exited' : ''}`}
      draggable
      onDragStart={(event) => {
        setDraggingId(sessionId);
        event.dataTransfer.setData(SESSION_MIME, sessionId);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setDraggingId(null)}
      onClick={() => focusSession(sessionId, { startClaude: true })}
      onDoubleClick={() => {
        focusSession(sessionId);
        setRenamingId(sessionId);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        focusSession(sessionId);
        openContextMenu(sessionId, event.clientX, event.clientY);
      }}
      title={[session.cwd, session.title].join(String.fromCharCode(10))}
    >
      <span className={`state-dot state-${session.status}${session.busy ? ' is-busy' : ''}`} />
      <span className="sidebar-item-text">
        <span className="sidebar-item-title">{label}</span>
        {/* The folder line is only worth a row of its own when it says something
            the title does not already say. */}
        {where !== label && <PathLabel path={session.cwd} home={homedir} className="sidebar-item-cwd" />}
      </span>
      {session.unread && <span className="tab-unread" />}
      <button
        className="tab-close"
        onClick={(event) => {
          event.stopPropagation();
          requestClose(sessionId);
        }}
      >
        &times;
      </button>
    </div>
  );
}
