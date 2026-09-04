import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { asFilePanel, isDarkAppearance, useStore } from '../state/store';
import type { DirEntry } from '../global';
import { GIT_TAB } from '../state/types';
import { leafOfTab } from '../state/layout';
import { Editor } from './Editor';
import { Popover } from './Popover';
import { FileIcon, colourFor } from '../lib/fileIcons';
import { previewDocument, previewKind } from '../lib/preview';
import type { PreviewKind, PreviewRule } from '../lib/preview';
import { GitPanel } from './GitPanel';
import { TerminalSlot } from './TerminalSlot';

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
    const found = asFilePanel(s.panels[panelId]);
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

  return (
    <div className="files-panel">
      {/* The tree never moves, whatever is open on the right. */}
      <div className="files-tree" style={{ flexBasis: panel.treeWidth ?? 236 }}>
        <TreeHeader panelId={panelId} root={panel.root} homedir={homedir} />
        <div className="files-tree-scroll">
          <UpRow panelId={panelId} root={panel.root} />
          <Dir panelId={panelId} path={panel.root} depth={0} />
        </div>
      </div>

      <TreeResizer panelId={panelId} />

      <div className="files-editor">
        {(panel.open.length > 0 || panel.gitOpen) && (
          <div className="file-tabs">
            {panel.gitOpen && <GitTab panelId={panelId} selected={active === GIT_TAB} />}
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

        {active === GIT_TAB ? (
          <GitPanel panelId={panelId} />
        ) : active ? (
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

        {panel.terminalId && (
          <>
            <TerminalResizer panelId={panelId} />
            <div className="files-terminal" style={{ height: panel.terminalHeight ?? 220 }}>
              {/*
                A strip of its own, so the terminal can be shut from where it is
                rather than from the button that opened it — the same reason every
                panel that can be closed carries its own cross.
              */}
              <header className="files-terminal-head">
                <TerminalName sessionId={panel.terminalId} />
                <button
                  className="tab-close"
                  title="Close the terminal"
                  aria-label="Close the terminal"
                  onClick={() => useStore.getState().togglePanelTerminal(panelId)}
                >
                  ×
                </button>
              </header>
              <TerminalSlot key={panel.terminalId} sessionId={panel.terminalId} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What the terminal is called: where it actually is.
 *
 * Named after the shell's own directory rather than the tree's root, and the two
 * come apart in both directions — re-rooting the tree does not move a running
 * shell, and typing `cd` in the shell does not move the tree. Whichever way they
 * drift, the strip has to say where the prompt you are looking at is standing.
 */
function TerminalName({ sessionId }: { sessionId: string }) {
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd ?? '');
  const homedir = useStore((s) => s.homedir);
  const here = cwd.split('/').filter(Boolean).pop() ?? cwd;
  const full = cwd.startsWith(homedir) ? `~${cwd.slice(homedir.length)}` : cwd;

  return (
    <span className="files-terminal-name" title={full}>
      Terminal — {cwd === homedir ? '~' : here}
    </span>
  );
}

/**
 * The divider between the editor and the terminal below it.
 *
 * Dragged upward makes the terminal taller, which is the direction that reads as
 * "give me more terminal" — and the numbers are clamped so neither half can be
 * dragged out of existence, since a zero-height editor looks exactly like a bug.
 */
function TerminalResizer({ panelId }: { panelId: string }) {
  const setHeight = useStore((s) => s.setPanelTerminalHeight);

  return (
    <div
      className="files-terminal-resizer"
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={(event) => {
        event.preventDefault();
        const panel = asFilePanel(useStore.getState().panels[panelId]);
        const startY = event.clientY;
        const startHeight = panel?.terminalHeight ?? 220;
        const editor = event.currentTarget.parentElement;
        const room = editor ? editor.getBoundingClientRect().height : 600;

        const move = (moveEvent: PointerEvent) => {
          const wanted = startHeight + (startY - moveEvent.clientY);
          setHeight(panelId, Math.max(80, Math.min(room - 120, wanted)));
        };
        const done = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', done);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', done);
      }}
    />
  );
}

/** Opens and shuts the terminal, and says which it will do. */
function TerminalButton({ panelId }: { panelId: string }) {
  const open = useStore((s) => Boolean(asFilePanel(s.panels[panelId])?.terminalId));
  const toggle = useStore((s) => s.togglePanelTerminal);

  return (
    <button
      className={`files-tool${open ? ' is-on' : ''}`}
      title={open ? 'Close the terminal' : 'Open a terminal in this folder'}
      aria-label="Terminal"
      onClick={() => toggle(panelId)}
    >
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.6 4.4 5.4 7l-2.8 2.6M7.4 9.8h4" />
      </svg>
    </button>
  );
}

/**
 * A document as it is meant to be read.
 *
 * In a frame with no origin and no scripts. A working tree is full of files
 * nobody wrote to be opened here, and a preview that runs them is a preview that
 * can be made to do things — so it renders and does not execute. The cost is
 * stated on screen rather than left to be discovered: a page's own scripts do
 * not run and the images beside it do not load.
 */
function Preview({ path, text, kind }: { path: string; text: string; kind: NonNullable<PreviewKind> }) {
  const dark = useStore((s) => isDarkAppearance(s.settings.theme));
  const doc = useMemo(() => previewDocument(path, text, dark), [path, text, dark]);

  return (
    <div className="file-preview">
      <iframe
        className="file-preview-frame"
        title={`Preview of ${path.split('/').pop()}`}
        // No allow-scripts and no allow-same-origin: it renders, and can do
        // nothing else. Everything the preview cannot show follows from this.
        sandbox=""
        srcDoc={doc}
      />
      {kind === 'html' && (
        <p className="file-preview-note">
          Rendered without scripts, and it cannot read files from beside it — images and
          stylesheets it loads from disk will be missing.
        </p>
      )}
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
  // The folder above this one, or null at the top of the disk.
  const parent = (() => {
    const cut = root.replace(/\/+$/, '').lastIndexOf('/');
    if (cut <= 0) return root === '/' ? null : '/';
    return root.slice(0, cut);
  })();

  return (
    <div className="files-tree-header">
      <div className="files-head-main">
      <div className="files-root-row">
        {/*
          Changing the root walks you down into a folder, so there has to be a way
          back out of it. Up to the parent, named — a bare arrow leaves you
          guessing where it goes.
        */}
        <button
          className="files-up"
          disabled={!parent}
          title={parent ? `Up to ${parent.split('/').filter(Boolean).pop() ?? '/'}` : 'Already at the top'}
          aria-label="Up to the parent folder"
          onClick={() => parent && setPanelRoot(panelId, parent)}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M7 11.2V3.2M3.4 6.6L7 3l3.6 3.6" />
          </svg>
        </button>
        <button ref={buttonRef} className="files-root" title={root} onClick={() => setOpen((o) => !o)}>
          <span className="files-root-name">{root.split('/').filter(Boolean).pop() ?? root}</span>
          <span className="files-caret">⌄</span>
        </button>
      </div>
      <div className="files-root-line">
        <span className="files-root-path" title={root}>{short}</span>
      </div>
      </div>

      {/*
        Stacked at the end of the header rather than on a bar of their own.
        A bar would have cost a row of tree height for two buttons, and bought
        nothing: the header does not scroll, so they are just as permanently in
        view here. Icons alone — a strip this narrow spends its width on words
        before it spends it on anything worth reading.
      */}
      <div className="files-head-tools">
        <GitButton panelId={panelId} />
        <TerminalButton panelId={panelId} />
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
 * `..` at the top of the tree.
 *
 * The arrow in the header does the same thing, and both are here on purpose:
 * one is where the folder's identity is, the other is where forty years of file
 * trees have taught people to look.
 */
function UpRow({ panelId, root }: { panelId: string; root: string }) {
  const setPanelRoot = useStore((s) => s.setPanelRoot);
  const cut = root.replace(/\/+$/, '').lastIndexOf('/');
  const parent = cut <= 0 ? (root === '/' ? null : '/') : root.slice(0, cut);
  if (!parent) return null;

  return (
    <div
      className="files-row is-up"
      style={{ paddingLeft: 6 }}
      title={parent}
      onClick={() => setPanelRoot(panelId, parent)}
    >
      <span className="files-chevron" />
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M1.6 3.4h3.4l1.1 1.4h6.3v6.2H1.6z" />
      </svg>
      <span className="files-name">..</span>
      <span className="files-up-name">{parent.split('/').filter(Boolean).pop() ?? '/'}</span>
    </div>
  );
}

/**
 * What a folder or a file in the tree can be asked to do.
 *
 * The two that matter are the two ways of taking a folder somewhere: a section
 * of its own beside this one, or a window of its own. A subfolder is very often
 * a project in its own right — a submodule, a sibling checkout — and until now
 * the only way to open one was to go back to the chooser and find it again.
 */
function EntryMenu({
  panelId,
  entry,
  at,
  onClose,
}: {
  panelId: string;
  entry: DirEntry;
  at: { x: number; y: number };
  onClose(): void;
}) {
  const openFilePanel = useStore((s) => s.openFilePanel);
  const openFile = useStore((s) => s.openFile);
  const setPanelRoot = useStore((s) => s.setPanelRoot);
  const layout = useStore((s) => s.layout);

  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const leafId = leafOfTab(layout, panelId)?.id;

  return (
    <Popover anchorPoint={at} onClose={onClose}>
      <div className="menu-heading">
        <span style={{ color: entry.repo ? '#e0af68' : undefined }}>{entry.name}</span>
        {entry.repo && <span className="menu-heading-pid">its own repository</span>}
      </div>

      {entry.isDirectory ? (
        <>
          <MenuRow
            label="Open in a new section"
            hint="beside this one"
            onClick={act(() => openFilePanel({ leafId, side: 'right', root: entry.path }))}
          />
          <MenuRow
            label="Open in a new window"
            hint="⌘N"
            onClick={act(() => {
              // The window opens empty and the folder is opened into it; there is
              // no way to hand a new window a job before it has booted.
              window.api.newWindow();
              openFilePanel({ leafId, side: 'center', root: entry.path });
            })}
          />
          <MenuRow
            label="Show this folder here"
            hint="change the root"
            onClick={act(() => setPanelRoot(panelId, entry.path))}
          />
        </>
      ) : (
        <MenuRow label="Open" hint="in the editor" onClick={act(() => openFile(panelId, entry.path))} />
      )}

      <div className="menu-separator" />
      <MenuRow label="Copy path" onClick={act(() => navigator.clipboard?.writeText(entry.path))} />
      <MenuRow label="Show in Finder" onClick={act(() => window.api.files.reveal(entry.path))} />
    </Popover>
  );
}

function MenuRow({ label, hint, onClick }: { label: string; hint?: string; onClick(): void }) {
  return (
    <button className="menu-item" onClick={onClick}>
      <span>{label}</span>
      {hint && <kbd title={hint}>{hint}</kbd>}
    </button>
  );
}

/**
 * The divider between the tree and the file.
 *
 * A tree of `src/state/components/…` needs room a tree of `migrations/` does
 * not, so the width belongs to the panel rather than to the app — two folders
 * open at once keep their own. Pointer capture rather than window listeners, so
 * a drag that leaves the window still ends where the pointer does.
 */
function TreeResizer({ panelId }: { panelId: string }) {
  const patchPanel = useStore((s) => s.patchPanel);

  return (
    <div
      className="tree-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the tree"
      onDoubleClick={() => patchPanel(panelId, { treeWidth: 236 })}
      onPointerDown={(event) => {
        event.preventDefault();
        // Capture is a nicety — the listeners below are on the window, so the
        // drag works without it. It can throw when the pointer is already gone,
        // and a throw here would take the listeners with it and leave a divider
        // that silently does nothing.
        try {
          (event.target as HTMLElement).setPointerCapture(event.pointerId);
        } catch {
          /* no capture; the window listeners still see the whole drag */
        }
        const startX = event.clientX;
        const startWidth = asFilePanel(useStore.getState().panels[panelId])?.treeWidth ?? 236;

        const onMove = (move: PointerEvent) => {
          // Narrower than this and the names are all ellipsis; wider and the file
          // has nowhere to be.
          const next = Math.round(Math.min(640, Math.max(140, startWidth + move.clientX - startX)));
          patchPanel(panelId, { treeWidth: next });
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

/**
 * The way into Git, in the tree's own corner.
 *
 * It opens Git as a tab on the right rather than replacing anything: the tree is
 * what you navigate by and it should not vanish because you glanced at what
 * changed. The count is what makes the button findable — a bare glyph in a
 * corner is not read.
 */
function GitButton({ panelId }: { panelId: string }) {
  const root = useStore((s) => asFilePanel(s.panels[panelId])?.root ?? '');
  const gitRoot = useStore((s) => asFilePanel(s.panels[panelId])?.gitRoot ?? null);
  const changed = useStore((s) => (gitRoot ? (s.repos[gitRoot]?.files.length ?? 0) : 0));
  const branch = useStore((s) => (gitRoot ? (s.repos[gitRoot]?.branch ?? null) : null));
  const showing = useStore((s) => Boolean(asFilePanel(s.panels[panelId])?.gitOpen));
  const openGit = useStore((s) => s.openGit);
  const closeGit = useStore((s) => s.closeGit);
  const [isRepo, setIsRepo] = useState<boolean | null>(null);

  /**
   * Watch the repository for as long as this panel has one.
   *
   * Held by the panel rather than by the Git tab: the button carries a count of
   * what has changed, and a count that only updates when you open the thing it
   * is a count of is not worth having. Counted in the main process, so two
   * panels on one repository share a single watch.
   */
  useEffect(() => {
    if (!gitRoot) return;
    window.api.git.watch(gitRoot);
    return () => window.api.git.unwatch(gitRoot);
  }, [gitRoot]);

  // Asked once. Offering Git where there is no repository is a button that can
  // only ever disappoint.
  useEffect(() => {
    if (!root) return;
    if (gitRoot) {
      setIsRepo(true);
      return;
    }
    let alive = true;
    window.api.git.call('root', root).then((result) => {
      if (alive) setIsRepo(typeof result.value === 'string' && Boolean(result.value));
    });
    return () => {
      alive = false;
    };
  }, [root, gitRoot]);

  if (isRepo === false) return null;

  return (
    <button
      // The same button both ways, like the terminal beside it: pressing the
      // thing that opened something is how anyone expects to shut it again.
      className={`files-tool${showing ? ' is-on' : ''}${changed ? ' has-changes' : ''}`}
      onClick={() => (showing ? closeGit(panelId) : openGit(panelId))}
      aria-label="Git"
      aria-pressed={showing}
      title={
        showing
          ? 'Close Git'
          : branch
            ? `Git — on ${branch}${changed ? `, ${changed} changed` : ''}`
            : 'Git'
      }
    >
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="3.6" cy="3.2" r="1.7" />
        <circle cx="3.6" cy="10.8" r="1.7" />
        <circle cx="10.4" cy="6.4" r="1.7" />
        <path d="M3.6 4.9v4.2M5.2 3.9c2.6.4 3.8 1.3 4 2.3" />
      </svg>
      {changed > 0 && <span className="files-git-count">{changed}</span>}
    </button>
  );
}

/** Git's own tab in the content row, first, with a close of its own. */
function GitTab({ panelId, selected }: { panelId: string; selected: boolean }) {
  const gitRoot = useStore((s) => asFilePanel(s.panels[panelId])?.gitRoot ?? null);
  const changed = useStore((s) => (gitRoot ? (s.repos[gitRoot]?.files.length ?? 0) : 0));
  const setActiveFile = useStore((s) => s.setActiveFile);
  const closeGit = useStore((s) => s.closeGit);

  return (
    <div
      className={`file-tab is-git${selected ? ' is-selected' : ''}`}
      onMouseDown={() => setActiveFile(panelId, GIT_TAB)}
      title="Git"
    >
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#e0af68" strokeWidth="1.3">
        <circle cx="3.6" cy="3.2" r="1.7" />
        <circle cx="3.6" cy="10.8" r="1.7" />
        <circle cx="10.4" cy="6.4" r="1.7" />
        <path d="M3.6 4.9v4.2M5.2 3.9c2.6.4 3.8 1.3 4 2.3" />
      </svg>
      <span className="file-tab-name">Git</span>
      {changed > 0 && <span className="files-git-count">{changed}</span>}
      <button
        className="tab-close"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          closeGit(panelId);
        }}
        aria-label="Close Git"
      >
        ×
      </button>
    </div>
  );
}

/** One folder's children. Each level subscribes only to its own listing. */
function Dir({ panelId, path, depth }: { panelId: string; path: string; depth: number }) {
  const listing = useStore((s) => s.dirs[path]);
  const expanded = useStore(
    useShallow((s) => {
      const panel = asFilePanel(s.panels[panelId]);
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
  entry: DirEntry;
  depth: number;
  expanded: boolean;
}) {
  const toggleDir = useStore((s) => s.toggleDir);
  const openFile = useStore((s) => s.openFile);
  const isOpen = useStore((s) => {
    const panel = asFilePanel(s.panels[panelId]);
    return panel?.kind === 'files' && panel.active === entry.path;
  });
  const dirty = useStore((s) => {
    const buffer = s.buffers[entry.path];
    return buffer ? buffer.text !== buffer.savedText : false;
  });
  const iconStyle = useStore((s) => s.settings.fileIcons);
  const folderColour = useStore((s) => s.settings.folderColour);
  const folderStyle = useStore((s) => s.settings.folderStyle);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <div
        className={`files-row${isOpen ? ' is-open' : ''}${entry.noise ? ' is-noise' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        title={entry.path}
        onClick={() => (entry.isDirectory ? toggleDir(panelId, entry.path) : openFile(panelId, entry.path))}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenuAt({ x: event.clientX, y: event.clientY });
        }}
      >
        {entry.isDirectory ? (
          <svg className={`files-chevron${expanded ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4.5 2.5L8 6l-3.5 3.5" />
          </svg>
        ) : (
          <span className="files-chevron" />
        )}
        <FileIcon
          name={entry.name}
          isDirectory={entry.isDirectory}
          open={expanded}
          style={iconStyle}
          folderColour={folderColour}
          folderStyle={folderStyle}
        />
        <span
          className="files-name"
          // In colour mode the name takes the icon's tint too, faintly — an icon
          // on its own is a small target for the eye at this size.
          style={
            iconStyle === 'colour' && !entry.isDirectory
              ? { color: colourFor(entry.name, false, 'colour') }
              : undefined
          }
        >
          {entry.name}
        </span>
        {/* Its own checkout, not just a folder: a submodule, a sibling
            repository, something vendored in. Worth knowing before you open it. */}
        {entry.repo && (
          <svg
            className="files-repo"
            width="11"
            height="11"
            viewBox="0 0 14 14"
            fill="none"
            stroke="#e0af68"
            strokeWidth="1.4"
          >
            <circle cx="3.6" cy="3.2" r="1.7" />
            <circle cx="3.6" cy="10.8" r="1.7" />
            <circle cx="10.4" cy="6.4" r="1.7" />
            <path d="M3.6 4.9v4.2M5.2 3.9c2.6.4 3.8 1.3 4 2.3" />
          </svg>
        )}
        {dirty && <span className="files-dirty" title="unsaved" />}
      </div>
      {menuAt && (
        <EntryMenu panelId={panelId} entry={entry} at={menuAt} onClose={() => setMenuAt(null)} />
      )}
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
  const rules = useStore((s) => s.extensions.previews) as PreviewRule[];
  // Which files preview at all is decided by what is installed, so the rules
  // come from the store rather than from the module's own list.
  const kind = previewKind(path, rules);
  // Per open file, and not remembered: which way you want to look at a document
  // is a question about this minute, not a setting.
  const [showing, setShowing] = useState<'code' | 'preview' | 'both'>(kind ? 'preview' : 'code');
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
        {kind && (
          <span className="file-view">
            <button className={showing === 'code' ? 'is-on' : ''} onClick={() => setShowing('code')}>
              Code
            </button>
            <button className={showing === 'preview' ? 'is-on' : ''} onClick={() => setShowing('preview')}>
              Preview
            </button>
            <button className={showing === 'both' ? 'is-on' : ''} onClick={() => setShowing('both')}>
              Both
            </button>
          </span>
        )}
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

      <div className={`editor-wrap${kind && showing === 'both' ? ' is-split' : ''}`}>
        {(!kind || showing !== 'preview') && (
          <Editor path={path} onSave={onSave} onSelection={onSelection} />
        )}
        {kind && showing !== 'code' && <Preview path={path} text={buffer.text} kind={kind} />}
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
