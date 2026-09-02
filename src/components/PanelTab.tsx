import { useStore } from '../state/store';

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
  const setActiveLeaf = useStore((s) => s.setActiveLeaf);
  const focusPanel = useStore((s) => s.focusPanel);
  const unsaved = useStore((s) =>
    Object.values(s.buffers).some((buffer) => buffer.text !== buffer.savedText),
  );

  if (!panel) return null;
  const isGit = panel.mode === 'git';
  const name = panel.root ? (panel.root.split('/').filter(Boolean).pop() ?? 'Files') : 'Files';

  return (
    <div
      className={`tab${selected ? ' tab-selected' : ''}`}
      style={{ boxShadow: selected ? `inset 0 -2px 0 ${isGit ? '#e0af68' : '#7aa2f7'}` : undefined }}
      title={panel.root || 'No folder chosen yet'}
      onMouseDown={() => {
        setActiveLeaf(leafId);
        focusPanel(leafId, panelId);
      }}
    >
      {isGit ? (
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#e0af68" strokeWidth="1.3">
          <circle cx="3.6" cy="3.2" r="1.7" />
          <circle cx="3.6" cy="10.8" r="1.7" />
          <circle cx="10.4" cy="6.4" r="1.7" />
          <path d="M3.6 4.9v4.2M5.2 3.9c2.6.4 3.8 1.3 4 2.3" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#7aa2f7" strokeWidth="1.3">
          <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
        </svg>
      )}
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
