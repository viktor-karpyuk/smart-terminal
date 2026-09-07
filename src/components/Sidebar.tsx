import { Fragment, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { asFilePanel, useStore } from '../state/store';
import { allTabs, leafOfTab } from '../state/layout';
import { SESSION_MIME } from '../lib/drag';
import { sessionLabel } from '../lib/labels';
import { shortContext } from '../lib/extensionHost';
import { compactPath } from '../lib/labels';
import { PathLabel } from './PathLabel';
import { Popover } from './Popover';
import {
  AccountsIcon,
  AppearanceIcon,
  ClustersIcon,
  ExtensionsIcon,
  HistoryIcon,
  MonitorIcon,
  UsageIcon,
} from './icons';

/**
 * The narrowest the sidebar will sit at. With the switches down to icons what
 * sets the floor is the headings below them; narrower than this it hides.
 */
export const SIDEBAR_MIN = 150;

/** The lists the sidebar can show, in the order they arrive with. */
type SidebarList = 'sessions' | 'folders' | 'monitor' | 'clusters';
const DEFAULT_ORDER: SidebarList[] = ['sessions', 'folders', 'monitor', 'clusters'];

/**
 * One list: a heading that stays, and a body that scrolls on its own.
 *
 * Each open list takes a share of the room rather than a number of pixels, so
 * resizing the window keeps the balance someone chose instead of handing every
 * spare pixel to whichever list happens to be last. A folded one is only its
 * heading and takes no share at all.
 */
function List({
  id,
  collapsed,
  header,
  children,
}: {
  id: string;
  collapsed: boolean;
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  /*
   * As tall as what is in it, unless somebody said otherwise.
   *
   * The sidebar used to give every open list an equal share of the column,
   * which meant a list of three folders got a quarter of the screen and three
   * quarters of that was blank. Content-sized is what a sidebar should do; a
   * height only appears here once somebody has dragged for one, and then it is
   * theirs and the list scrolls inside it.
   */
  const height = useStore((s) => s.settings.sidebarSectionHeights?.[id]);
  return (
    <div
      className={`sidebar-list${collapsed ? ' is-collapsed' : ''}${height ? ' is-sized' : ''}`}
      style={collapsed || !height ? undefined : { height }}
      data-list={id}
    >
      {header}
      {!collapsed && <div className="sidebar-list-body">{children}</div>}
    </div>
  );
}

/**
 * The divider under an open list. Drag it and that list is the height you drag
 * it to; everything below simply moves with it.
 */
function ListResizer({ above }: { above: string }) {
  const updateSettings = useStore((s) => s.updateSettings);

  return (
    <div
      className="list-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the lists"
      onDoubleClick={() => {
        // Back to the size of what is in it, which is where every list starts.
        const sizes = { ...(useStore.getState().settings.sidebarSectionHeights ?? {}) };
        delete sizes[above];
        updateSettings({ sidebarSectionHeights: sizes });
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        const container = (event.currentTarget as HTMLElement).parentElement;
        const list = container?.querySelector(`[data-list="${above}"]`) as HTMLElement | null;
        if (!container || !list) return;

        /*
         * Pixels, straight through.
         *
         * This used to convert the pointer's movement into a share of the whole
         * column, which made the divider travel the pair's *fraction* of the
         * distance the cursor did — half speed with two lists open, a third
         * with three — so the line trailed further behind the further you
         * dragged. A height in pixels is what the pointer is speaking in, and
         * the divider now lands under it.
         */
        const startY = event.clientY;
        const startHeight = list.getBoundingClientRect().height;
        const room = container.getBoundingClientRect().height;

        const onMove = (move: PointerEvent) => {
          const wanted = startHeight + (move.clientY - startY);
          // Never smaller than its own heading, never so tall that everything
          // below it is pushed off the sidebar.
          const next = Math.round(Math.min(Math.max(wanted, 46), Math.max(80, room - 90)));
          updateSettings({
            sidebarSectionHeights: {
              ...(useStore.getState().settings.sidebarSectionHeights ?? {}),
              [above]: next,
            },
          });
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          document.body.classList.remove('resizing');
        };
        document.body.classList.add('resizing');
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }}
    />
  );
}

/** Its own kind, so dragging a session onto a heading is not mistaken for this. */
const SECTION_MIME = 'application/x-smart-terminal-section';

/**
 * Which heading is being dragged, kept outside the drag event.
 *
 * `dataTransfer.getData` returns nothing during `dragover` — the browser hides
 * the payload until the drop, deliberately. That is fine for a drop handler and
 * useless for reordering as the pointer moves, which needs to know what is being
 * dragged *now*. So it is remembered when the drag starts.
 */
let draggingSection: SidebarList | null = null;

/**
 * A foldable heading, the way an editor's sidebar has them.
 *
 * Two different acts, and they are not the same thing: the chevron folds the
 * list away but keeps the heading, so the count is still visible and opening it
 * again takes one click; the × takes the whole section off the sidebar, and it
 * comes back from the switches at the top. Collapsing is for "not now"; closing
 * is for "not at all".
 */
function SectionHeader({
  id,
  label,
  count,
  collapsed,
  onToggle,
  onClose,
  extra,
}: {
  id: SidebarList;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle(): void;
  onClose(): void;
  extra?: React.ReactNode;
}) {
  const updateSettings = useStore((s) => s.updateSettings);
  const order = useStore((s) => s.settings.sidebarOrder ?? DEFAULT_ORDER);
  const [over, setOver] = useState(false);

  /**
 * Dropping one heading on another puts the dragged list where that one is.
 *
 * With two lists this was a swap and nothing more; with three it has to be an
 * insertion, or dragging the last onto the first would leave the middle one
 * where it was and look like nothing happened.
 */
  const moveHere = (dragged: string | null) => {
    if (!dragged || dragged === id) return;
    const next = order.filter((entry) => entry !== dragged);
    const at = next.indexOf(id);
    if (at === -1) return;
    next.splice(at, 0, dragged as SidebarList);
    // Reordering on every pointer move means this runs many times a second, and
    // most of those times the answer is the order it already has. Writing it
    // again would be a settings save per frame.
    if (next.length === order.length && next.every((entry, i) => entry === order[i])) return;
    updateSettings({ sidebarOrder: next });
  };

  return (
    <div
      className={`sidebar-section${collapsed ? ' is-collapsed' : ''}${over ? ' is-drop-target' : ''}`}
      onClick={onToggle}
      draggable
      onDragStart={(event) => {
        draggingSection = id;
        event.dataTransfer.setData(SECTION_MIME, id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        draggingSection = null;
        setOver(false);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(SECTION_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
        // Move it now, not on the drop. Waiting until the button comes up meant
        // nothing on screen answered the pointer for the whole length of the
        // drag — the list stayed put and then jumped, which reads as the cursor
        // having run ahead of it. Reordering as the pointer crosses each heading
        // is what makes the list follow the hand.
        moveHere(draggingSection);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        // The order is already right — the drag put it there. This only ends it.
        moveHere(draggingSection ?? event.dataTransfer.getData(SECTION_MIME));
        draggingSection = null;
      }}
    >
      <svg
        className={`files-chevron${collapsed ? '' : ' is-open'}`}
        width="11"
        height="11"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M4.5 2.5L8 6l-3.5 3.5" />
      </svg>
      <span className="sidebar-section-label">{label}</span>
      <span className="sidebar-section-count">{count}</span>
      <span className="sidebar-section-actions" onClick={(event) => event.stopPropagation()}>
        {extra}
        <button className="tab-close" onClick={onClose} aria-label={`Close ${label}`} title={`Close ${label}`}>
          ×
        </button>
      </span>
    </div>
  );
}

/**
 * The folders that are open, grouped by the repository they belong to.
 *
 * Sessions group by account because that is what makes two of them different
 * kinds of thing. For folders it is the repository: two folders in one checkout
 * are the same piece of work, and two in different ones are not.
 */
function Folders() {
  const homedir = useStore((s) => s.homedir);
  const panelIds = useStore(useShallow((s) => Object.keys(s.panels).filter((id) => asFilePanel(s.panels[id])?.root)));
  const openFilePanel = useStore((s) => s.openFilePanel);
  const activeLeafId = useStore((s) => s.activeLeafId);
  const collapsed = useStore((s) => s.settings.sidebarFoldersCollapsed);
  const updateSettings = useStore((s) => s.updateSettings);

  const groups = useMemo(() => {
    const panels = useStore.getState().panels;
    const byRepo = new Map<string, string[]>();
    for (const id of panelIds) {
      // Not in a repository is its own heading rather than a silent lump at the
      // end: it is a real answer about the folder, not a leftover.
      const key = asFilePanel(panels[id])?.gitRoot ?? '';
      byRepo.set(key, [...(byRepo.get(key) ?? []), id]);
    }
    return [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [panelIds]);

  return (
    <List
      id="folders"
      collapsed={collapsed}
      header={
        <SectionHeader
          id="folders"
        label="Folders"
        count={panelIds.length}
        collapsed={collapsed}
        onToggle={() => updateSettings({ sidebarFoldersCollapsed: !collapsed })}
        onClose={() => updateSettings({ sidebarShowFolders: false })}
          extra={
            <button
              className="link-btn"
              title="Open another folder"
              onClick={(event) => {
                event.stopPropagation();
                openFilePanel({ leafId: activeLeafId });
              }}
            >
              + Open
            </button>
          }
        />
      }
    >
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
    </List>
  );
}

function FolderItem({ panelId, homedir }: { panelId: string; homedir: string }) {
  const root = useStore((s) => asFilePanel(s.panels[panelId])?.root ?? '');
  const gitRoot = useStore((s) => asFilePanel(s.panels[panelId])?.gitRoot ?? null);
  const changed = useStore((s) => (gitRoot ? (s.repos[gitRoot]?.files.length ?? 0) : 0));
  const unsaved = useStore((s) => {
    const panel = asFilePanel(s.panels[panelId]);
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
  // Whether anything contributes a cluster view at all. A boolean, not the
  // list: this component re-renders on every session change, and it has no
  // business re-rendering because a pod somewhere restarted.
  const hasClusters = useStore((s) => s.extensions.panels.some((panel) => panel.needs === 'kubernetes'));
  const authByProfile = useStore((s) => s.authByProfile);
  const updateSettings = useStore((s) => s.updateSettings);

  // Only membership matters here; each row subscribes to its own session, so a
  // session streaming output no longer re-renders the whole list.
  const membership = useStore(
    useShallow((s) => allTabs(s.layout).map((id) => id + ' ' + (s.sessions[id]?.profileId ?? ''))),
  );
  const runningCount = useStore(
    (s) => allTabs(s.layout).filter((id) => s.sessions[id]?.status === 'running').length,
  );

  // With both switched off there is no panel at all — just the rail, which is
  // the whole point of the rail.
  const showsSomething =
    settings.sidebarShowSessions ||
    settings.sidebarShowFolders ||
    settings.sidebarShowMonitor ||
    (settings.sidebarShowClusters && hasClusters);
  // Any list the order does not mention yet — the monitor, for a workspace saved
  // before it existed — goes on the end rather than disappearing.
  const ordered = [
    ...(settings.sidebarOrder ?? DEFAULT_ORDER),
    ...DEFAULT_ORDER.filter((which) => !(settings.sidebarOrder ?? DEFAULT_ORDER).includes(which)),
  ];
  const shown: Record<SidebarList, boolean> = {
    sessions: settings.sidebarShowSessions,
    folders: settings.sidebarShowFolders,
    monitor: settings.sidebarShowMonitor,
    // Only when something contributes it. A list of clusters on the sidebar of
    // somebody who does not run Kubernetes is a permanent empty box.
    clusters: settings.sidebarShowClusters && hasClusters,
  };
  const open = ordered.filter((which) => shown[which]);
  /*
   * A folded list has no room to trade, so there is no divider above the one
   * below it. A handle that says row-resize and then does nothing is worse than
   * no handle: it reads as broken rather than as unavailable.
   */
  const folded: Record<SidebarList, boolean> = {
    sessions: settings.sidebarSessionsCollapsed,
    folders: settings.sidebarFoldersCollapsed,
    monitor: settings.sidebarMonitorCollapsed,
    clusters: settings.sidebarClustersCollapsed,
  };

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
    <aside className="sidebar-dock">
      <ActivityBar />
      {/*
        The lists. Clamped where the width is applied, not only where it is
        dragged: a width can also arrive from a saved workspace or an older
        build, and a sidebar too narrow to read its own headings is the one
        shape it must never take.
      */}
      {showsSomething && (
      <div className="sidebar" style={{ width: Math.min(520, Math.max(SIDEBAR_MIN, settings.sidebarWidth)) }}>
      <div className="sidebar-lists">
        {open.map((which, index) => (
          <Fragment key={which}>
            {index > 0 && !folded[open[index - 1]] && <ListResizer above={open[index - 1]} />}
            {which === 'sessions' ? (
              <List
                id="sessions"
                collapsed={settings.sidebarSessionsCollapsed}
                header={
                  <SectionHeader
                    id="sessions"
                    label="Sessions"
                    count={runningCount}
                    collapsed={settings.sidebarSessionsCollapsed}
                    onToggle={() =>
                      updateSettings({ sidebarSessionsCollapsed: !settings.sidebarSessionsCollapsed })
                    }
                    onClose={() => updateSettings({ sidebarShowSessions: false })}
                  />
                }
              >
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
              </List>
            ) : which === 'folders' ? (
              <Folders />
            ) : which === 'clusters' ? (
              <ClustersList />
            ) : (
              <MonitorList />
            )}
          </Fragment>
        ))}
      </div>

      <div className="sidebar-footer">
        <BuildLine />
      </div>
      </div>
      )}
    </aside>
  );
}

/**
 * The clusters, as a list.
 *
 * Every context in kubeconfig with a dot saying whether it answers, because on
 * a laptop with seven of them two are usually behind a VPN nobody is on and one
 * has a token that expired — and finding that out by clicking is a slow way to
 * learn something a dot can say.
 *
 * Clicking one opens it. A tab per cluster, not one tab that switches: two
 * clusters open at once is the whole reason to have a list of them, and a tab
 * that changed what it was showing underneath you would be worse than useless
 * while something is being followed in it.
 */
function ClustersList() {
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const collapsed = useStore((s) => s.settings.sidebarClustersCollapsed);
  const updateSettings = useStore((s) => s.updateSettings);
  const names = useStore(useShallow((s) => s.clusters.list.map((entry) => entry.name)));
  const error = useStore((s) => s.clusters.error);
  const probing = useStore((s) => s.clusters.probing);
  const down = useStore(
    (s) => Object.values(s.clusters.reach).filter((entry) => entry.up === false && !entry.slow).length,
  );

  return (
    <List
      id="clusters"
      collapsed={collapsed}
      header={
        <SectionHeader
          id="clusters"
          label="Clusters"
          count={down}
          collapsed={collapsed}
          onToggle={() => updateSettings({ sidebarClustersCollapsed: !collapsed })}
          onClose={() => updateSettings({ sidebarShowClusters: false })}
          extra={
            <button
              className="section-open"
              title={probing ? 'Asking each cluster…' : 'Ask each cluster again'}
              aria-label="Check the clusters again"
              onClick={(event) => {
                event.stopPropagation();
                void useStore
                  .getState()
                  .loadClusters()
                  .then(() => useStore.getState().probeClusters(true));
              }}
            >
              {probing ? '·' : '⟳'}
            </button>
          }
        />
      }
    >
      {error && <p className="sidebar-empty">{error}</p>}
      {!error && !names.length && <p className="sidebar-empty">No clusters in kubeconfig.</p>}
      {names.map((name) => (
        <ClusterRow key={name} name={name} onMenu={setMenu} />
      ))}
      {menu && <ClusterMenu name={menu.name} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </List>
  );
}

/** One cluster: whether it answers, and what it is called by people. */
function ClusterRow({
  name,
  onMenu,
}: {
  name: string;
  onMenu(at: { name: string; x: number; y: number }): void;
}) {
  const reach = useStore((s) => s.clusters.reach[name]);
  const openCluster = useStore((s) => s.openCluster);
  const isDefault = useStore((s) => s.clusters.current === name);
  const open = useStore(
    (s) => Object.values(s.panels).some((panel) => panel.kind === 'extension' && panel.root === name),
  );
  const state = dotFor(reach);

  return (
    <button
      className={`sidebar-item cluster-row${open ? ' is-open' : ''}`}
      title={reach?.error ? `${name}\n\n${reach.error}` : name}
      onClick={() => openCluster(name)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ name, x: event.clientX, y: event.clientY });
      }}
    >
      <span className={`cluster-dot is-${state}`} />
      <span className="sidebar-item-title">{shortContext(name)}</span>
      {/* Which one a plain `kubectl` uses. Worth marking, precisely because
          nothing this app does depends on it. */}
      {isDefault && <span className="cluster-default" title="What a plain kubectl uses">default</span>}
    </button>
  );
}

/**
 * Three answers, not two.
 *
 * Answered: green. Said no — refused the connection, or the credentials are
 * stale: red. Did not answer at all: amber, because that is not the same claim.
 * A cluster that is merely slow, or behind a VPN that drops rather than
 * refuses, has told us nothing, and a confident red about a healthy production
 * cluster is how a dashboard stops being believed.
 */
function dotFor(reach?: { up: boolean | null; slow?: boolean }): 'ok' | 'warn' | 'bad' | 'unknown' {
  if (!reach || reach.up == null) return 'unknown';
  if (reach.up) return 'ok';
  return reach.slow ? 'warn' : 'bad';
}

/**
 * What you can do to a cluster from the list.
 *
 * Two of these edit the person's own kubeconfig rather than talk to a cluster,
 * and they are the two worth being careful about — so removing asks first, and
 * making one the default says out loud what else that changes.
 */
function ClusterMenu({
  name,
  x,
  y,
  onClose,
}: {
  name: string;
  x: number;
  y: number;
  onClose(): void;
}) {
  const reach = useStore((s) => s.clusters.reach[name]);
  const isDefault = useStore((s) => s.clusters.current === name);
  const [confirming, setConfirming] = useState(false);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  if (confirming) {
    return (
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div className="confirm" onMouseDown={(event) => event.stopPropagation()}>
          <h3>Remove {shortContext(name)}?</h3>
          <p style={{ color: 'var(--text)' }}>{name}</p>
          <p>
            This edits your kubeconfig. The context goes, and so do its cluster and user entries
            unless another context is still pointing at them. Nothing in the cluster itself is
            touched — you are removing the way in, not the thing.
          </p>
          <div className="confirm-actions">
            <button className="ghost-btn" onClick={onClose} autoFocus>
              Keep it
            </button>
            <button
              className="danger-btn"
              onClick={() => {
                onClose();
                void useStore.getState().removeCluster(name);
              }}
            >
              Remove from kubeconfig
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Popover anchorPoint={{ x, y }} onClose={onClose}>
      <div className="menu-heading">
        <span className={`cluster-dot is-${dotFor(reach)}`} />
        <span>{shortContext(name)}</span>
      </div>

      <button className="menu-item" onClick={run(() => useStore.getState().openCluster(name))}>
        <span>Open</span>
        <kbd>a tab of its own</kbd>
      </button>
      <button
        className="menu-item"
        onClick={run(() => void useStore.getState().openClusterTerminal(name))}
      >
        <span>Terminal here</span>
        <kbd>k aliased to it</kbd>
      </button>
      <button className="menu-item" onClick={run(() => void useStore.getState().probeCluster(name))}>
        <span>Check it again</span>
        {reach?.error && <kbd title={reach.error}>not answering</kbd>}
      </button>

      <div className="menu-separator" />

      <button className="menu-item" onClick={run(() => void navigator.clipboard.writeText(name))}>
        <span>Copy its full name</span>
      </button>
      {!isDefault && (
        <button
          className="menu-item"
          onClick={run(() => void useStore.getState().makeClusterDefault(name))}
          title="Changes what a plain kubectl does everywhere, including in your own shells"
        >
          <span>Make it kubectl's default</span>
          <kbd>outside this app too</kbd>
        </button>
      )}

      <div className="menu-separator" />

      <button className="menu-item is-danger" onClick={() => setConfirming(true)}>
        <span>Remove from kubeconfig…</span>
      </button>
    </Popover>
  );
}

/**
 * The fleet's health, as a list.
 *
 * The same readings the monitor section shows, in the place you already look to
 * find a session. Clicking one opens the monitor on it — the list answers "which
 * one should I look at", the section answers "why".
 */
function MonitorList() {
  const collapsed = useStore((s) => s.settings.sidebarMonitorCollapsed);
  const updateSettings = useStore((s) => s.updateSettings);
  const ids = useStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((session) => session.kind === 'claude')
        .map((session) => session.id),
    ),
  );
  const troubled = useStore(
    (s) => Object.values(s.analysisBySession).filter((v) => v.worst === 'high' || v.worst === 'medium').length,
  );

  return (
    <List
      id="monitor"
      collapsed={collapsed}
      header={
        <SectionHeader
          id="monitor"
          label="Monitor"
          count={troubled}
          collapsed={collapsed}
          onToggle={() => updateSettings({ sidebarMonitorCollapsed: !collapsed })}
          onClose={() => updateSettings({ sidebarShowMonitor: false })}
          extra={
            <button
              className="section-open"
              title="Open the monitor in a section"
              aria-label="Open the monitor"
              onClick={(event) => {
                event.stopPropagation();
                useStore.getState().openMonitor();
              }}
            >
              ⇱
            </button>
          }
        />
      }
    >
      {!ids.length && <p className="sidebar-empty">No Claude sessions running.</p>}
      {ids.map((id) => (
        <MonitorRow key={id} sessionId={id} />
      ))}
    </List>
  );
}

/** One session's health: how full it is, and whether anything is wrong. */
function MonitorRow({ sessionId }: { sessionId: string }) {
  const openMonitor = useStore((s) => s.openMonitor);
  const title = useStore((s) => s.sessions[sessionId]?.customTitle || s.sessions[sessionId]?.title || 'session');
  // Primitives only. The verdict object is replaced on every sweep, and selecting
  // it would redraw every row in the list each time any session was read.
  const share = useStore((s) => {
    const verdict = s.analysisBySession[sessionId];
    if (!verdict?.ok || !verdict.context.window) return -1;
    return verdict.context.last / verdict.context.window;
  });
  const worst = useStore((s) => s.analysisBySession[sessionId]?.worst ?? null);
  const pct = share < 0 ? null : Math.min(100, Math.round(share * 100));
  const tone = pct === null ? '' : pct >= 80 ? 'is-high' : pct >= 60 ? 'is-warm' : 'is-ok';

  return (
    <button
      className="sidebar-item monitor-item"
      onClick={() => openMonitor(sessionId)}
      title={pct === null ? `${title} — nothing measured yet` : `${title} — ${pct}% of its context window`}
    >
      <span className={`monitor-pip is-${worst ?? 'clear'}`} />
      <span className="sidebar-item-name">{title}</span>
      {pct === null ? (
        <span className="monitor-row-quiet">—</span>
      ) : (
        <>
          <span className="monitor-bar">
            <span className={`monitor-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
          </span>
          <span className="monitor-item-pct">{pct}%</span>
        </>
      )}
    </button>
  );
}

/**
 * The strip of icons that never goes away.
 *
 * It is the one part of the sidebar that is always on screen, so it is always
 * the way back: the lists beside it can all be switched off and there is still
 * something to press. The two at the top choose what the panel shows; the four
 * at the bottom open the things that are not lists at all.
 */
function ActivityBar() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const hasClusters = useStore((s) => s.extensions.panels.some((panel) => panel.needs === 'kubernetes'));
  const down = useStore(
    (s) => Object.values(s.clusters.reach).filter((entry) => entry.up === false && !entry.slow).length,
  );
  const runningCount = useStore(
    (s) => allTabs(s.layout).filter((id) => s.sessions[id]?.status === 'running').length,
  );
  const folderCount = useStore((s) => Object.values(s.panels).filter((p) => asFilePanel(p)?.root).length);
  /** Extensions with a newer version than the one installed. A count, so it is stable. */
  const updates = useStore((s) => s.extensions.rows.filter((row) => row.status === 'update').length);
  /** Sessions with something worth looking at — a count, so the selector is stable. */
  const alerts = useStore(
    (s) => Object.values(s.analysisBySession).filter((v) => v.worst === 'high' || v.worst === 'medium').length,
  );
  const setProfileEditorOpen = useStore((s) => s.setProfileEditorOpen);
  const setUsagePanelOpen = useStore((s) => s.setUsagePanelOpen);
  const setHistoryOpen = useStore((s) => s.setHistoryOpen);
  const setAppearanceOpen = useStore((s) => s.setAppearanceOpen);

  return (
    <nav className="activity-bar" aria-label="Sidebar">
      <button
        className={`activity${settings.sidebarShowSessions ? ' is-on' : ''}`}
        data-tip={`Sessions — ${runningCount} running`}
        aria-label="Sessions"
        aria-pressed={settings.sidebarShowSessions}
        onClick={() => updateSettings({ sidebarShowSessions: !settings.sidebarShowSessions })}
      >
        <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="1.4" y="2.4" width="11.2" height="9.2" rx="1.6" />
          <path d="M4 6.2l1.8 1.6L4 9.4M7.6 9.6h2.6" />
        </svg>
        {runningCount > 0 && <span className="activity-count">{runningCount}</span>}
      </button>

      <button
        className={`activity${settings.sidebarShowFolders ? ' is-on' : ''}`}
        data-tip={`Folders — ${folderCount} open`}
        aria-label="Folders"
        aria-pressed={settings.sidebarShowFolders}
        onClick={() => updateSettings({ sidebarShowFolders: !settings.sidebarShowFolders })}
      >
        <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
        </svg>
        {folderCount > 0 && <span className="activity-count">{folderCount}</span>}
      </button>

      <button
        className={`activity${settings.sidebarShowMonitor ? ' is-on' : ''}`}
        data-tip={alerts ? `Monitor — ${alerts} need a look` : 'Monitor'}
        aria-label="Monitor"
        aria-pressed={settings.sidebarShowMonitor}
        onClick={() => updateSettings({ sidebarShowMonitor: !settings.sidebarShowMonitor })}
      >
        <MonitorIcon />
        {alerts > 0 && <span className="activity-count">{alerts}</span>}
      </button>

      {hasClusters && (
        <button
          className={`activity${settings.sidebarShowClusters ? ' is-on' : ''}`}
          data-tip={down ? `Clusters — ${down} not answering` : 'Clusters'}
          aria-label="Clusters"
          aria-pressed={settings.sidebarShowClusters}
          onClick={() => updateSettings({ sidebarShowClusters: !settings.sidebarShowClusters })}
        >
          <ClustersIcon />
          {down > 0 && <span className="activity-count">{down}</span>}
        </button>
      )}

      <span className="activity-spacer" />

      <button className="activity" onClick={() => setProfileEditorOpen(true)} data-tip="Accounts (⌘,)" aria-label="Accounts">
        <AccountsIcon />
      </button>
      <button className="activity" onClick={() => setUsagePanelOpen(true)} data-tip="Usage limits (⌘U)" aria-label="Usage">
        <UsageIcon />
      </button>
      <button
        className="activity"
        onClick={() => useStore.getState().openExtensions()}
        data-tip={updates ? `Extensions — ${updates} to update` : 'Extensions'}
        aria-label="Extensions"
      >
        <ExtensionsIcon />
        {updates > 0 && <span className="activity-count">{updates}</span>}
      </button>
      <button className="activity" onClick={() => setHistoryOpen(true)} data-tip="History (⌘Y)" aria-label="History">
        <HistoryIcon />
      </button>
      <button className="activity" onClick={() => setAppearanceOpen(true)} data-tip="Appearance (⇧⌘,)" aria-label="Appearance">
        <AppearanceIcon />
      </button>
    </nav>
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
