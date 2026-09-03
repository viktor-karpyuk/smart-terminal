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
  const panel = useStore((s) => s.panels[panelId]);
  const closePanel = useStore((s) => s.closePanel);
  const setDraggingId = useStore((s) => s.setDraggingSessionId);
  const setActiveLeaf = useStore((s) => s.setActiveLeaf);
  const focusPanel = useStore((s) => s.focusPanel);
  const unsaved = useStore((s) =>
    Object.values(s.buffers).some((buffer) => buffer.text !== buffer.savedText),
  );

  if (!panel) return null;
  const name = panel.root ? (panel.root.split('/').filter(Boolean).pop() ?? 'Files') : 'Files';

  return (
    <div
      className={`tab${selected ? ' tab-selected' : ''}`}
      style={{ boxShadow: selected ? 'inset 0 -2px 0 #7aa2f7' : undefined }}
      title={panel.root || 'No folder chosen yet'}
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
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#7aa2f7" strokeWidth="1.3">
        <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
      </svg>
      <span className="tab-title">{name}</span>
      {unsaved && <span className="file-tab-dirty" title="unsaved changes" />}
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
