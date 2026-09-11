import { useStore } from '../state/store';
import { PANEL_MIME } from '../lib/drag';
import { folderGit } from '../lib/folderGit';

/**
 * The tab a file panel wears.
 *
 * It sits in the same strip as the sessions, because it is the same kind of
 * thing — and it carries the one signal a session tab does not have room for:
 * whether anything in it is unsaved.
 */
export function PanelTab({
  panelId,
  selected,
  leafId,
}: {
  panelId: string;
  selected: boolean;
  leafId: string;
}) {
  // Both kinds, on purpose: the strip is where a section says what it holds, and
  // it holds either a folder or the monitor.
  const panel = useStore((s) => s.panels[panelId] ?? null);
  const closePanel = useStore((s) => s.closePanel);
  const setDraggingId = useStore((s) => s.setDraggingSessionId);
  const setActiveLeaf = useStore((s) => s.setActiveLeaf);
  const focusPanel = useStore((s) => s.focusPanel);
  /*
   * Unsaved text, in *this* folder.
   *
   * It used to be every buffer the app had open, so a file edited in one folder
   * put the dot on every folder tab on screen — which says the opposite of what
   * a dot on a tab is for.
   */
  const folder = panel?.kind === 'files' ? panel.root : '';
  const unsaved = useStore((s) =>
    Object.entries(s.buffers).some(
      ([file, buffer]) =>
        buffer.text !== buffer.savedText && (!folder || file === folder || file.startsWith(`${folder}/`)),
    ),
  );
  /*
   * And what the repository underneath it is waiting for.
   *
   * The folder finds its repository when it opens rather than when Git does, so
   * this is answered before anybody has clicked anything — see followFolderGit.
   */
  const gitRoot = panel?.kind === 'files' ? panel.gitRoot : null;
  const repo = useStore((s) => (gitRoot ? s.repos[gitRoot] : undefined));
  const git = folderGit(repo);

  if (!panel) return null;
  const monitor = panel.kind === 'monitor';
  const shop = panel.kind === 'extensions';
  // A view an extension brought. It carries its own name — the cluster, for a
  // Kubernetes tab — and without this it wore the folder icon and the word
  // "Files", which is neither what it is nor what it shows.
  const view = panel.kind === 'extension' ? panel : null;
  const root = panel.kind === 'files' ? panel.root : '';
  const name = monitor
    ? 'Monitor'
    : shop
      ? 'Extensions'
      : view
        ? view.title
        : (root.split('/').filter(Boolean).pop() ?? 'Files');

  return (
    <div
      className={`tab${selected ? ' tab-selected' : ''}`}
      style={{ boxShadow: selected ? 'inset 0 -2px 0 #7aa2f7' : undefined }}
      title={
        monitor
          ? 'How every session is behaving'
          : shop
            ? 'What the app can be taught to open'
            : view
              ? (view.root ?? view.title)
              : root || 'No folder chosen yet'
      }
      // A folder tab moves like a session tab: the panes already know how to
      // take a tab, and a folder is one.
      draggable
      onDragStart={(event) => {
        setDraggingId(panelId);
        event.dataTransfer.setData(PANEL_MIME, panelId);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setDraggingId(null)}
      onMouseDown={() => {
        setActiveLeaf(leafId);
        focusPanel(leafId, panelId);
      }}
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#7aa2f7" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {view ? (
          // The helm, when it is a cluster; the extension's blocks otherwise.
          view.root && view.viewId === 'kubernetes' ? (
            <>
              <circle cx="7" cy="7" r="5.1" />
              <circle cx="7" cy="7" r="1.7" />
              <path d="M7 1.9v3.4M7 8.7v3.4M1.9 7h3.4M8.7 7h3.4" />
            </>
          ) : (
            <path d="M2 5.2h4.2v4.2H2zM7.8 2.6h4.2v4.2H7.8zM7.8 8.4h4.2v4.2H7.8z" />
          )
        ) : shop ? (
          <path d="M2.2 4.6h4.2v4.2H2.2zM7.6 2.4h4v4h-4zM7.6 8.2h4v3.4h-4z" />
        ) : monitor ? (
          <path d="M1.4 8h2.3l1.4-3.9L7.2 10l1.5-3.2 1 1.2h2.9" />
        ) : (
          <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
        )}
      </svg>
      <span className="tab-title">{name}</span>
      {!monitor && !view && unsaved && <span className="file-tab-dirty" title="unsaved changes" />}
      {/*
        The same two colours the Git tab uses for the same two things, so a
        folder tab and the panel behind it are never saying different things:
        amber for work that is only in the working tree, green for commits that
        are only on this machine.
      */}
      {!monitor && !view && git.state === 'uncommitted' && (
        <span className="tab-git-dot" title={git.title} aria-label={git.title} />
      )}
      {!monitor && !view && git.state === 'unpushed' && (
        <span className="tab-git-up" title={git.title} aria-label={git.title}>
          ↑{git.count}
        </span>
      )}
      {/* A folder can be put down without being closed, the same as a session:
          the tree it is showing takes real work to get back to. */}
      <button
        className="tab-min"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          useStore.getState().minimizeSession(panelId);
        }}
        title="Set this folder aside — it keeps its tree, and you get its space back"
        aria-label="Minimize folder"
      >
        –
      </button>
      <button
        className="tab-close"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          closePanel(panelId);
        }}
        aria-label="Close files"
      >
        ×
      </button>
    </div>
  );
}
