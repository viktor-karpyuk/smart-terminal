import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { Editor } from './Editor';
import { Popover } from './Popover';
import { FileIcon, colourFor } from '../lib/fileIcons';
import { GitPanel } from './GitPanel';

/**
 * A folder on the left, the file you are looking at on the right.
 *
 * This is a tab, not a sidebar — so it splits, moves between sections, fills the
 * window and goes into the dock like everything else, without one line of code
 * for any of it.
 */
export function FilesPanel({ panelId }: { panelId: string }) {
  // Narrowed here once: everything below this belongs to a files panel.
  const panel = useStore((s) => {
    const found = s.panels[panelId];
    return found?.kind === 'files' ? found : null;
  });
  const homedir = useStore((s) => s.homedir);
  const closeFile = useStore((s) => s.closeFile);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const saveBuffer = useStore((s) => s.saveBuffer);
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null);

  if (!panel) return null;
  const active = panel.active;

  // Opened without a folder. Asking is better than guessing: the folders worth
  // offering are the ones sessions are actually working in.
  if (!panel.root) return <ChooseFolder panelId={panelId} />;
  if (panel.mode === 'git') return <GitPanel panelId={panelId} />;

  return (
    <div className="files-panel">
      <div className="files-tree">
        <TreeHeader panelId={panelId} root={panel.root} homedir={homedir} />
        <div className="files-tree-scroll">
          <Dir panelId={panelId} path={panel.root} depth={0} />
        </div>
      </div>

      <div className="files-editor">
        {panel.open.length > 0 && (
          <div className="file-tabs">
            {panel.open.map((path) => (
              <FileTab
                key={path}
                path={path}
                selected={path === active}
                onSelect={() => setActiveFile(panelId, path)}
                onClose={() => closeFile(panelId, path)}
              />
            ))}
          </div>
        )}

        {active ? (
          <OpenFile
            key={active}
            panelId={panelId}
            path={active}
            root={panel.root}
            onSave={() => saveBuffer(active)}
            selection={selection}
            onSelection={(from, to, text) => setSelection({ from, to, text })}
          />
        ) : (
          <div className="files-empty">
            <p>Pick a file on the left.</p>
            <p className="form-hint">⌘S and Ctrl+S both save.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** What a Files tab shows before a folder has been picked. */
function ChooseFolder({ panelId }: { panelId: string }) {
  const homedir = useStore((s) => s.homedir);
  const setPanelRoot = useStore((s) => s.setPanelRoot);
  const folders = useStore(
    useShallow((s) => {
      const seen = new Map<string, string[]>();
      for (const session of Object.values(s.sessions)) {
        if (!session.cwd) continue;
        const names = seen.get(session.cwd) ?? [];
        names.push(session.customTitle ?? session.title);
        seen.set(session.cwd, names);
      }
      return [...seen.entries()].map(([cwd, names]) => `${cwd}\u0000${names.join(', ')}`);
    }),
  );

  const short = (path: string) => (path.startsWith(homedir) ? `~${path.slice(homedir.length)}` : path);

  return (
    <div className="files-choose">
      <h3>Which folder?</h3>
      {folders.length > 0 && <p className="form-hint">Where your sessions are working.</p>}
      <div className="files-choose-list">
        {folders.map((entry) => {
          const [cwd, who] = entry.split('\u0000');
          return (
            <button key={cwd} className="menu-item" onClick={() => setPanelRoot(panelId, cwd)}>
              <span>{cwd.split('/').filter(Boolean).pop()}</span>
              <kbd title={cwd}>{who}</kbd>
            </button>
          );
        })}
      </div>
      <div className="files-choose-actions">
        <button
          className="primary-btn"
          onClick={async () => {
            const picked = await window.api.system.pickDirectory(homedir);
            if (picked) setPanelRoot(panelId, picked);
          }}
        >
          Browse…
        </button>
        {folders.length > 0 && (
          <span className="form-hint">{short(folders[0].split('\u0000')[0])}</span>
        )}
      </div>
    </div>
  );
}

function TreeHeader({ panelId, root, homedir }: { panelId: string; root: string; homedir: string }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // Ids only. Packing several fields into one string to keep the selector stable
  // was a trap: a title or a path containing the separator came back split wrong.
  const sessionIds = useStore(useShallow((state) => Object.keys(state.sessions)));
  const setPanelRoot = useStore((s) => s.setPanelRoot);
  const short = root.startsWith(homedir) ? `~${root.slice(homedir.length)}` : root;

  return (
    <div className="files-tree-header">
      <button ref={buttonRef} className="files-root" title={root} onClick={() => setOpen((o) => !o)}>
        <span className="files-root-name">{root.split('/').filter(Boolean).pop() ?? root}</span>
        <span className="files-caret">⌄</span>
      </button>
      <div className="files-root-line">
        <span className="files-root-path" title={root}>{short}</span>
        <GitButton panelId={panelId} />
      </div>
      {open && (
        <Popover anchorEl={buttonRef.current} onClose={() => setOpen(false)}>
          <div className="popover-header"><span>Show the folder of</span></div>
          {sessionIds.map((id) => {
            const session = useStore.getState().sessions[id];
            if (!session?.cwd) return null;
            const { cwd } = session;
            const name = session.customTitle ?? session.title;
            return (
              <button
                key={id}
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  setPanelRoot(panelId, cwd);
                }}
              >
                <span>{name}</span>
                <kbd title={cwd}>{cwd.split('/').filter(Boolean).pop()}</kbd>
              </button>
            );
          })}
          <div className="menu-separator" />
          <button
            className="menu-item"
            onClick={async () => {
              setOpen(false);
              const picked = await window.api.system.pickDirectory(root);
              if (picked) setPanelRoot(panelId, picked);
            }}
          >
            <span>A folder…</span>
            <kbd>choose it</kbd>
          </button>
        </Popover>
      )}
    </div>
  );
}

/**
 * The way into Git, in the tree's own corner.
 *
 * Not a tab of its own: Git here is the repository *of the folder you are looking
 * at*, so it belongs to this tab rather than beside it. It carries the number of
 * changed files, which is also what makes it findable — an icon with a count on
 * it is read; a bare glyph in a corner is not.
 */
function GitButton({ panelId }: { panelId: string }) {
  const root = useStore((s) => s.panels[panelId]?.root ?? '');
  const gitRoot = useStore((s) => s.panels[panelId]?.gitRoot ?? null);
  const changed = useStore((s) => (gitRoot ? (s.repos[gitRoot]?.files.length ?? 0) : 0));
  const branch = useStore((s) => (gitRoot ? (s.repos[gitRoot]?.branch ?? null) : null));
  const setPanelMode = useStore((s) => s.setPanelMode);
  const [known, setKnown] = useState<boolean | null>(null);

  // Ask once whether this folder is even in a repository; offering Git where
  // there is none is a button that can only ever disappoint.
  useEffect(() => {
    if (!root) return;
    if (gitRoot) {
      setKnown(true);
      return;
    }
    let alive = true;
    window.api.git.call('root', root).then((result) => {
      if (alive) setKnown(typeof result.value === 'string' && Boolean(result.value));
    });
    return () => {
      alive = false;
    };
  }, [root, gitRoot]);

  if (known === false) return null;

  return (
    <button
      className={`files-git${changed ? ' has-changes' : ''}`}
      onClick={() => setPanelMode(panelId, 'git')}
      title={branch ? `Git — on ${branch}${changed ? `, ${changed} changed` : ''}` : 'Git'}
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="3.6" cy="3.2" r="1.7" />
        <circle cx="3.6" cy="10.8" r="1.7" />
        <circle cx="10.4" cy="6.4" r="1.7" />
        <path d="M3.6 4.9v4.2M5.2 3.9c2.6.4 3.8 1.3 4 2.3" />
      </svg>
      <span>Git</span>
      {changed > 0 && <span className="files-git-count">{changed}</span>}
    </button>
  );
}

/** One folder's children. Each level subscribes only to its own listing. */
function Dir({ panelId, path, depth }: { panelId: string; path: string; depth: number }) {
  const listing = useStore((s) => s.dirs[path]);
  const expanded = useStore(
    useShallow((s) => {
      const panel = s.panels[panelId];
      return panel?.kind === 'files' ? panel.expanded : [];
    }),
  );
  const loadDir = useStore((s) => s.loadDir);

  useEffect(() => {
    if (!listing) loadDir(path);
  }, [path, listing, loadDir]);

  if (listing?.error) return <p className="files-note" style={{ paddingLeft: 10 + depth * 12 }}>{listing.error}</p>;
  if (!listing || (listing.loading && !listing.entries.length)) {
    return <p className="files-note" style={{ paddingLeft: 10 + depth * 12 }}>reading…</p>;
  }
  if (!listing.entries.length) {
    return <p className="files-note" style={{ paddingLeft: 10 + depth * 12 }}>empty</p>;
  }

  return (
    <>
      {listing.entries.map((entry) => (
        <Row
          key={entry.path}
          panelId={panelId}
          entry={entry}
          depth={depth}
          expanded={expanded.includes(entry.path)}
        />
      ))}
    </>
  );
}

function Row({
  panelId,
  entry,
  depth,
  expanded,
}: {
  panelId: string;
  entry: { name: string; path: string; isDirectory: boolean; noise: boolean };
  depth: number;
  expanded: boolean;
}) {
  const toggleDir = useStore((s) => s.toggleDir);
  const openFile = useStore((s) => s.openFile);
  const isOpen = useStore((s) => {
    const panel = s.panels[panelId];
    return panel?.kind === 'files' && panel.active === entry.path;
  });
  const dirty = useStore((s) => {
    const buffer = s.buffers[entry.path];
    return buffer ? buffer.text !== buffer.savedText : false;
  });
  const iconStyle = useStore((s) => s.settings.fileIcons);

  return (
    <>
      <div
        className={`files-row${isOpen ? ' is-open' : ''}${entry.noise ? ' is-noise' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        title={entry.path}
        onClick={() => (entry.isDirectory ? toggleDir(panelId, entry.path) : openFile(panelId, entry.path))}
        onContextMenu={(event) => {
          event.preventDefault();
          window.api.files.reveal(entry.path);
        }}
      >
        {entry.isDirectory ? (
          <svg className={`files-chevron${expanded ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4.5 2.5L8 6l-3.5 3.5" />
          </svg>
        ) : (
          <span className="files-chevron" />
        )}
        <FileIcon name={entry.name} isDirectory={entry.isDirectory} open={expanded} style={iconStyle} />
        <span
          className="files-name"
          // In colour mode the name takes the icon's tint too, faintly — an icon
          // on its own is a small target for the eye at this size.
          style={iconStyle === 'colour' && !entry.isDirectory ? { color: colourFor(entry.name, false, 'colour') } : undefined}
        >
          {entry.name}
        </span>
        {dirty && <span className="files-dirty" title="unsaved" />}
      </div>
      {entry.isDirectory && expanded && <Dir panelId={panelId} path={entry.path} depth={depth + 1} />}
    </>
  );
}

function FileTab({
  path,
  selected,
  onSelect,
  onClose,
}: {
  path: string;
  selected: boolean;
  onSelect(): void;
  onClose(): void;
}) {
  const dirty = useStore((s) => {
    const buffer = s.buffers[path];
    return buffer ? buffer.text !== buffer.savedText : false;
  });
  return (
    <div className={`file-tab${selected ? ' is-selected' : ''}`} onMouseDown={onSelect} title={path}>
      <span className="file-tab-name">{path.split('/').pop()}</span>
      {dirty ? (
        <span className="file-tab-dirty" title="unsaved" />
      ) : (
        <button
          className="tab-close"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          aria-label="Close file"
        >
          ×
        </button>
      )}
    </div>
  );
}

function OpenFile({
  panelId,
  path,
  root,
  onSave,
  selection,
  onSelection,
}: {
  panelId: string;
  path: string;
  root: string;
  onSave(): void;
  selection: { from: number; to: number; text: string } | null;
  onSelection(from: number, to: number, text: string): void;
}) {
  const buffer = useStore((s) => s.buffers[path]);
  const saveBuffer = useStore((s) => s.saveBuffer);
  const revertBuffer = useStore((s) => s.revertBuffer);
  const sendSelectionTo = useStore((s) => s.sendSelectionTo);
  // Sessions working in this folder — the ones a selection can usefully go to.
  const nearby = useStore(
    useShallow((s) =>
      Object.values(s.sessions)
        .filter((session) => path.startsWith(session.cwd))
        .map((session) => session.id),
    ),
  );

  if (!buffer) return <div className="files-empty"><p>opening…</p></div>;
  if (buffer.loading) return <div className="files-empty"><p>opening…</p></div>;
  if (buffer.error && buffer.readOnly) {
    return (
      <div className="files-empty">
        <p>{buffer.error}</p>
        <button className="ghost-btn" onClick={() => window.api.files.reveal(path)}>Show in Finder</button>
      </div>
    );
  }

  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const dirty = buffer.text !== buffer.savedText;

  return (
    <>
      <div className="file-crumbs">
        {relative.split('/').map((part, index, all) => (
          <span key={`${part}-${index}`} className={index === all.length - 1 ? 'is-file' : undefined}>
            {part}
            {index < all.length - 1 && <i>›</i>}
          </span>
        ))}
      </div>

      {/* A session rewrote this while it was open and nothing was unsaved. */}
      {buffer.reloadedAt && !dirty && (
        <div className="file-bar is-quiet">
          <span className="file-bar-dot is-ok" />
          <span>Updated — a session just changed this file.</span>
        </div>
      )}

      {/*
        The one that matters: it changed on disk while an edit was in the buffer.
        Nothing has been touched, and nothing will be until this is answered.
      */}
      {buffer.conflict && (
        <div className="file-bar is-warn">
          <span className="file-bar-dot is-warn" />
          <span className="file-bar-text">This file changed on disk while you were editing it.</span>
          <button className="ghost-btn" onClick={() => saveBuffer(path, { force: true })}>Keep mine</button>
          <button className="ghost-btn" onClick={() => revertBuffer(path)}>Take theirs</button>
        </div>
      )}

      {buffer.error && !buffer.readOnly && (
        <div className="file-bar is-danger">
          <span className="file-bar-dot is-danger" />
          <span className="file-bar-text">{buffer.error}</span>
        </div>
      )}

      <div className="editor-wrap">
        <Editor path={path} onSave={onSave} onSelection={onSelection} />
      </div>

      <footer className="files-status">
        <span className="files-status-name">{path.split('/').pop()}</span>
        {selection && selection.text ? (
          <span className="files-status-sel">
            Ln {selection.from}
            {selection.to !== selection.from ? `–${selection.to}` : ''} selected
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {selection && selection.text && nearby.length > 0 && (
          <span className="files-send">
            {nearby.slice(0, 3).map((id) => {
              const session = useStore.getState().sessions[id];
              const name = session?.customTitle ?? session?.title ?? 'session';
              return (
                <button
                  key={id}
                  className="link-btn"
                  title={`Put ${relative}:${selection.from}–${selection.to} into ${name}'s prompt`}
                  onClick={() => sendSelectionTo(id, path, selection.text, selection.from, selection.to)}
                >
                  Send to {name}
                </button>
              );
            })}
          </span>
        )}
        <span className={dirty ? 'files-status-dirty' : undefined}>{dirty ? 'unsaved · ⌘S' : 'saved'}</span>
      </footer>
    </>
  );
}
