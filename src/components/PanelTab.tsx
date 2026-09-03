import { useStore } from '../state/store';
import { PANEL_MIME } from '../lib/drag';

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
  const unsaved = useStore((s) =>
    Object.values(s.buffers).some((buffer) => buffer.text !== buffer.savedText),
  );

  if (!panel) return null;
  const monitor = panel.kind === 'monitor';
  const root = panel.kind === 'files' ? panel.root : '';
  const name = monitor ? 'Monitor' : (root.split('/').filter(Boolean).pop() ?? 'Files');

  return (
    <div
      className={`tab${selected ? ' tab-selected' : ''}`}
      style={{ boxShadow: selected ? 'inset 0 -2px 0 #7aa2f7' : undefined }}
      title={monitor ? 'How every session is behaving' : root || 'No folder chosen yet'}
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
        {monitor ? (
          <path d="M1.4 8h2.3l1.4-3.9L7.2 10l1.5-3.2 1 1.2h2.9" />
        ) : (
          <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
        )}
      </svg>
      <span className="tab-title">{name}</span>
      {!monitor && unsaved && <span className="file-tab-dirty" title="unsaved changes" />}
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
