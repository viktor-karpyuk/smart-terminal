import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { allTabs, leafOfTab } from '../state/layout';
import { NewSessionMenu } from './NewSessionMenu';
import { SESSION_MIME } from '../lib/drag';
import { sessionLabel } from '../lib/labels';
import { compactPath } from '../lib/labels';
import { PathLabel } from './PathLabel';
import { AccountsIcon, AppearanceIcon, HistoryIcon, UsageIcon } from './icons';

/**
 * The folders that are open, grouped by the repository they belong to.
 *
 * Sessions group by account because that is what makes two of them different
 * kinds of thing. For folders it is the repository: two folders in one checkout
 * are the same piece of work, and two in different ones are not.
 */
function Folders() {
  const homedir = useStore((s) => s.homedir);
  const panelIds = useStore(useShallow((s) => Object.keys(s.panels).filter((id) => s.panels[id].root)));
  const openFilePanel = useStore((s) => s.openFilePanel);
  const activeLeafId = useStore((s) => s.activeLeafId);

  const groups = useMemo(() => {
    const panels = useStore.getState().panels;
    const byRepo = new Map<string, string[]>();
    for (const id of panelIds) {
      // Not in a repository is its own heading rather than a silent lump at the
      // end: it is a real answer about the folder, not a leftover.
      const key = panels[id].gitRoot ?? '';
      byRepo.set(key, [...(byRepo.get(key) ?? []), id]);
    }
    return [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [panelIds]);

  return (
    <>
      <div className="sidebar-section">
        Folders
        <button
          className="link-btn"
          title="Open another folder"
          onClick={() => openFilePanel({ leafId: activeLeafId })}
        >
          + Open
        </button>
      </div>
      {panelIds.length === 0 && <p className="sidebar-empty">No folders open.</p>}
      {groups.map(([repo, ids]) => (
        <div className="sidebar-group" key={repo || 'loose'}>
          <div className="sidebar-group-header" title={repo || 'Not in a git repository'}>
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={repo ? '#e0af68' : '#565f79'} strokeWidth="1.3">
              {repo ? (
                <>
                  <circle cx="3.6" cy="3.2" r="1.7" />
                  <circle cx="3.6" cy="10.8" r="1.7" />
                  <circle cx="10.4" cy="6.4" r="1.7" />
                  <path d="M3.6 4.9v4.2M5.2 3.9c2.6.4 3.8 1.3 4 2.3" />
                </>
              ) : (
                <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
              )}
            </svg>
            <span style={{ color: repo ? '#e0af68' : undefined }}>
              {repo ? (repo.split('/').filter(Boolean).pop() ?? repo) : 'Not in a repository'}
            </span>
            <span className="sidebar-group-count">{ids.length}</span>
          </div>
          {ids.map((id) => (
            <FolderItem key={id} panelId={id} homedir={homedir} />
          ))}
        </div>
      ))}
    </>
  );
}

function FolderItem({ panelId, homedir }: { panelId: string; homedir: string }) {
  const root = useStore((s) => s.panels[panelId]?.root ?? '');
  const gitRoot = useStore((s) => s.panels[panelId]?.gitRoot ?? null);
  const changed = useStore((s) => (gitRoot ? (s.repos[gitRoot]?.files.length ?? 0) : 0));
  const unsaved = useStore((s) => {
    const panel = s.panels[panelId];
    if (!panel) return false;
    return panel.open.some((path) => {
      const buffer = s.buffers[path];
      return buffer ? buffer.text !== buffer.savedText : false;
    });
  });
  const layout = useStore((s) => s.layout);
  const focusPanel = useStore((s) => s.focusPanel);
  const closePanel = useStore((s) => s.closePanel);

  const short = root.startsWith(homedir) ? `~${root.slice(homedir.length)}` : root;

  return (
    <div
      className="sidebar-item"
      title={root}
      onMouseDown={() => {
        const leaf = leafOfTab(layout, panelId);
        if (leaf) focusPanel(leaf.id, panelId);
      }}
    >
      <svg width="12" height="12" viewBox="0 0 14 14" fill="#7aa2f7" stroke="none" style={{ flex: '0 0 auto' }}>
        <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
      </svg>
      <div className="sidebar-item-text">
        <span className="sidebar-item-title">{root.split('/').filter(Boolean).pop() ?? root}</span>
        <PathLabel path={short} home={homedir} className="sidebar-item-path" />
      </div>
      {changed > 0 && <span className="sidebar-changed" title={`${changed} changed`}>{changed}</span>}
      {unsaved && <span className="files-dirty" title="unsaved changes" />}
      <button
        className="tab-close"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          closePanel(panelId);
        }}
        aria-label="Close folder"
      >
        ×
      </button>
    </div>
  );
}

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
  const folderCount = useStore((s) => Object.values(s.panels).filter((p) => p.root).length);
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
        {/*
          Two switches rather than one control that picks a list. They are
          different things — a session is work going on, a folder is a place — and
          someone with twenty sessions and one folder wants a different sidebar
          from someone reading four repositories. Both on is the default.
        */}
        <button
          className={`sidebar-toggle${settings.sidebarShowSessions ? ' is-on' : ''}`}
          title="Show sessions"
          onClick={() => updateSettings({ sidebarShowSessions: !settings.sidebarShowSessions })}
        >
          Sessions
          <span className="sidebar-toggle-count">{runningCount}</span>
        </button>
        <button
          className={`sidebar-toggle${settings.sidebarShowFolders ? ' is-on' : ''}`}
          title="Show folders"
          onClick={() => updateSettings({ sidebarShowFolders: !settings.sidebarShowFolders })}
        >
          Folders
          <span className="sidebar-toggle-count">{folderCount}</span>
        </button>
      </div>

      <div className="sidebar-scroll">
        {!settings.sidebarShowSessions && !settings.sidebarShowFolders && (
          <p className="sidebar-empty">Both lists are switched off.</p>
        )}

        {settings.sidebarShowSessions && (
          <>
            <div className="sidebar-section">Sessions</div>
            {grouped.length === 0 && <p className="sidebar-empty">No sessions yet.</p>}
          </>
        )}
        {settings.sidebarShowSessions && grouped.map(({ profile, ids }) => {
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

        {settings.sidebarShowFolders && <Folders />}
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
