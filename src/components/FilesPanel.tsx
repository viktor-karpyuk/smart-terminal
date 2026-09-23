import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { asFilePanel, isDarkAppearance, useStore } from '../state/store';
import type { DirEntry } from '../global';
import { GIT_TAB } from '../state/types';
import { leafOfTab } from '../state/layout';
import { Editor } from './Editor';
import { Popover } from './Popover';
import { FileIcon, colourFor } from '../lib/fileIcons';
import { previewDocument, previewKind } from '../lib/preview';
import { renderWithExtension } from '../lib/extensionRender';
import type { PreviewKind, PreviewRule } from '../lib/preview';
import { GitPanel } from './GitPanel';
import { TerminalSlot } from './TerminalSlot';
import { readAll } from '../terminals/registry';
import { FILE_MIME } from '../lib/drag';
import { isInside, nameProblem, parentOf } from '../lib/fileOps';

/**
 * Entries whose row should open for renaming the moment it appears — a file
 * or folder just created under a placeholder name. The row is not there yet
 * when the request is made, so it is left for the row to find.
 */
const pendingRenames = new Set<string>();

/** A word to the person about a change to the tree that did not happen, shown by the panel that asked. */
const noticeListeners = new Map<string, (text: string) => void>();
function tell(panelId: string, text: string) {
  noticeListeners.get(panelId)?.(text);
}

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
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    noticeListeners.set(panelId, setNotice);
    return () => {
      noticeListeners.delete(panelId);
    };
  }, [panelId]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

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
        {panel.find?.trim() ? (
          <NarrowedTree panelId={panelId} root={panel.root} query={panel.find} />
        ) : (
          <DropZone panelId={panelId} dir={panel.root} className="files-tree-scroll">
            <UpRow panelId={panelId} root={panel.root} />
            <Dir panelId={panelId} path={panel.root} depth={0} />
          </DropZone>
        )}
        {notice && (
          <div className="git-notice is-floating is-bad" onClick={() => setNotice(null)}>
            {notice}
          </div>
        )}
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
                <CopyOutput sessionId={panel.terminalId} />
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
 * Take everything the terminal has said.
 *
 * A selection is the answer when you want part of it; this is the answer when
 * you want the lot — the output of the build you just ran, to paste somewhere
 * that is not this app. It says what it took, because a copy button that gives
 * no sign of having worked is a button people press twice.
 */
function CopyOutput({ sessionId }: { sessionId: string }) {
  const [took, setTook] = useState<number | null>(null);

  return (
    <button
      className="files-terminal-copy"
      title="Copy everything in this terminal"
      onClick={() => {
        const text = readAll(sessionId);
        if (!text) {
          setTook(0);
          window.setTimeout(() => setTook(null), 1600);
          return;
        }
        navigator.clipboard.writeText(text);
        setTook(text.split('\n').length);
        window.setTimeout(() => setTook(null), 1600);
      }}
    >
      {took === null ? 'Copy output' : took === 0 ? 'Nothing yet' : `Copied ${took} lines`}
    </button>
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
 * In a frame with no origin, and by default with no scripts. A working tree is
 * full of files nobody wrote to be opened here, so the preview renders and does
 * not execute — the cost is stated on screen rather than left to be discovered.
 *
 * But a page whose arrows do nothing is not a preview of that page. So scripts
 * can be turned on for one file from its own footer, or for good in Appearance.
 * The frame never gets an origin either way: `allow-scripts` without
 * `allow-same-origin` leaves the page in an origin of its own, unable to read
 * the disk, this app, or anything this app holds. What it buys is behaviour;
 * what it costs is that the page can talk to the network, which is a thing
 * worth being asked about rather than assumed.
 */
function Preview({ path, text, kind }: { path: string; text: string; kind: NonNullable<PreviewKind> }) {
  const dark = useStore((s) => isDarkAppearance(s.settings.theme));
  const always = useStore((s) => s.settings.previewScripts);
  // Just this one, just this time: forgotten when the file changes or the tab closes.
  const [justThisOne, setJustThisOne] = useState(false);
  useEffect(() => setJustThisOne(false), [path]);
  const scripts = always || justThisOne;
  // The rule that matched, so an extension's own renderer can be found. Only its
  // source matters here, and a string is a stable thing to select.
  const source = useStore(
    (s) => s.extensions.previews.find((rule) => rule.kind === kind)?.source ?? null,
  );
  const [fromExtension, setFromExtension] = useState<{ html: string } | { error: string } | null>(null);

  /**
   * An extension's renderer is asked in a worker, so the answer arrives later.
   * What is on screen while it does is deliberately the last good answer rather
   * than a blank: retyping in a file should not make the preview flicker.
   */
  useEffect(() => {
    if (!source) {
      setFromExtension(null);
      return;
    }
    let alive = true;
    renderWithExtension(kind, source, { path, text, dark })
      .then((html) => alive && setFromExtension({ html }))
      .catch((error: Error) => alive && setFromExtension({ error: error.message }));
    return () => {
      alive = false;
    };
  }, [kind, source, path, text, dark]);

  const built = useMemo(
    () => (source ? '' : previewDocument(path, text, dark, 3, kind)),
    [source, path, text, dark, kind],
  );

  const failed = fromExtension && 'error' in fromExtension ? fromExtension.error : null;
  const doc = source ? (fromExtension && 'html' in fromExtension ? fromExtension.html : '') : built;

  return (
    <div className="file-preview">
      {source && !fromExtension && <p className="file-preview-note">Asking the extension…</p>}
      {failed && (
        <p className="file-preview-note is-warn">
          The extension could not render this: {failed}
        </p>
      )}
      <iframe
        // Remounted when scripts are turned on, or the page that was already
        // drawn keeps the frame it was drawn in and nothing starts running.
        key={scripts ? 'live' : 'inert'}
        className="file-preview-frame"
        title={`Preview of ${path.split('/').pop()}`}
        /*
         * `allow-same-origin` is never here, whatever else is: without it the
         * page sits in an origin of its own and cannot read this app, its
         * storage or the disk. Adding scripts to that lets the page behave;
         * it does not let it reach anything.
         */
        sandbox={scripts ? 'allow-scripts' : ''}
        srcDoc={doc}
      />
      {kind === 'html' && (
        <p className="file-preview-note">
          {scripts ? (
            <>
              Running this page&rsquo;s own scripts{always ? '' : ' — just this once'}. It still cannot
              read files from beside it, so images and stylesheets it loads from disk are missing.
              {!always && (
                <button className="link-btn" onClick={() => setJustThisOne(false)}>
                  Stop running them
                </button>
              )}
            </>
          ) : (
            <>
              Rendered without scripts, so its own buttons, arrows and slides do nothing. It cannot
              read files from beside it either — images and stylesheets it loads from disk will be
              missing.
              <button className="link-btn" onClick={() => setJustThisOne(true)}>
                Run this page&rsquo;s scripts
              </button>
            </>
          )}
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
        <ExtensionButtons panelId={panelId} />
      </div>
      <FindBox panelId={panelId} root={root} />
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
  onRename,
  onTrash,
}: {
  panelId: string;
  entry: DirEntry;
  at: { x: number; y: number };
  onClose(): void;
  onRename(): void;
  onTrash(): void;
}) {
  const openFilePanel = useStore((s) => s.openFilePanel);
  const openFile = useStore((s) => s.openFile);
  const setPanelRoot = useStore((s) => s.setPanelRoot);
  const createEntry = useStore((s) => s.createEntry);
  const duplicateEntry = useStore((s) => s.duplicateEntry);
  const layout = useStore((s) => s.layout);

  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const leafId = leafOfTab(layout, panelId)?.id;
  // A new thing goes into this folder, or beside this file.
  const into = entry.isDirectory ? entry.path : parentOf(entry.path);
  const make = (kind: 'file' | 'folder') =>
    act(async () => {
      const name = await freeName(into, kind === 'file' ? 'untitled.txt' : 'untitled folder');
      // Under a placeholder name, and straight into renaming it: the wish is
      // left before the row exists, because the row looks for it as it appears.
      pendingRenames.add(`${into}/${name}`);
      const problem = await createEntry(panelId, into, name, kind);
      if (problem) {
        pendingRenames.delete(`${into}/${name}`);
        tell(panelId, problem);
      }
    });

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
      <MenuRow label="New file" hint={entry.isDirectory ? 'in here' : 'beside it'} onClick={make('file')} />
      <MenuRow label="New folder" hint={entry.isDirectory ? 'in here' : 'beside it'} onClick={make('folder')} />
      <div className="menu-separator" />
      <MenuRow label="Rename" onClick={act(onRename)} />
      <MenuRow
        label="Duplicate"
        onClick={act(async () => {
          const problem = await duplicateEntry(entry.path);
          if (problem) tell(panelId, problem);
        })}
      />
      <MenuRow label="Move to Trash" danger onClick={act(onTrash)} />
      <div className="menu-separator" />
      <MenuRow label="Copy path" onClick={act(() => navigator.clipboard?.writeText(entry.path))} />
      <MenuRow label="Show in Finder" onClick={act(() => window.api.files.reveal(entry.path))} />
    </Popover>
  );
}

/** `untitled.txt`, or `untitled 2.txt` when that is taken — read from the listing the tree already has. */
async function freeName(dir: string, wanted: string): Promise<string> {
  let listing = useStore.getState().dirs[dir];
  if (!listing) {
    await useStore.getState().loadDir(dir);
    listing = useStore.getState().dirs[dir];
  }
  const taken = new Set((listing?.entries ?? []).map((entry) => entry.name));
  if (!taken.has(wanted)) return wanted;
  const dot = wanted.lastIndexOf('.');
  const stem = dot > 0 ? wanted.slice(0, dot) : wanted;
  const ext = dot > 0 ? wanted.slice(dot) : '';
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} ${Date.now()}${ext}`;
}

/**
 * A folder that takes what is dropped on it.
 *
 * Wraps the whole tree at the root and each folder row below; a file dragged
 * from anywhere in the tree lands in whichever it is let go over. A folder is
 * refused its own contents, and a file dropped where it already is is nothing.
 */
function DropZone({
  panelId,
  dir,
  className,
  style,
  children,
  onClick,
  onContextMenu,
  title,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  panelId: string;
  dir: string;
  className: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  onClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  title?: string;
  draggable?: boolean;
  onDragStart?: (event: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const moveEntry = useStore((s) => s.moveEntry);
  const [over, setOver] = useState(false);
  const accepts = (event: React.DragEvent) => event.dataTransfer.types.includes(FILE_MIME);
  return (
    <div
      className={`${className}${over ? ' is-drop' : ''}`}
      style={style}
      title={title}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      }}
      onDragLeave={(event) => {
        // Leaving for a child of this element is not leaving.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const from = event.dataTransfer.getData(FILE_MIME);
        if (!from || parentOf(from) === dir) return;
        // Said, not swallowed: a folder let go over its own contents looks like it should have gone somewhere.
        if (isInside(dir, from)) {
          tell(panelId, 'A folder cannot be moved into itself.');
          return;
        }
        void moveEntry(from, dir).then((problem) => {
          if (problem) tell(panelId, problem);
        });
      }}
    >
      {children}
    </div>
  );
}

function MenuRow({ label, hint, danger, onClick }: { label: string; hint?: string; danger?: boolean; onClick(): void }) {
  return (
    <button className={`menu-item${danger ? ' is-danger' : ''}`} onClick={onClick}>
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

/**
 * One ⋮ for every view the installed extensions bring to this folder.
 *
 * Nothing here knows what any of them do. An extension says it has a panel and
 * what that panel needs, and this offers it where what it needs is there — so
 * the app grows an entry without the app being edited, which is the whole point
 * of the thing being an extension rather than a feature.
 *
 * A menu rather than a button each, and the reason is arithmetic. These sat in a
 * column beside the folder's name, so every extension that applied made the
 * header 21px taller: two tools cost 40px, five cost 103px — more than the
 * folder name, its path and four rows of tree together. The count only goes up.
 * Behind one ⋮ the header stops growing, and the long tail gets what it needed
 * most, which is **names**: nobody was ever going to learn that a cube is Maven
 * and brackets are the reviewer.
 */
function ExtensionButtons({ panelId }: { panelId: string }) {
  const root = useStore((s) => asFilePanel(s.panels[panelId])?.root ?? '');
  const gitRoot = useStore((s) => asFilePanel(s.panels[panelId])?.gitRoot ?? null);
  // Ids only: a selector that builds a fresh array of objects re-renders this
  // for ever, which is a lesson this file has already learned once.
  const viewIds = useStore(
    useShallow((s) => s.extensions.panels.map((view) => `${view.id}\u0000${view.title}\u0000${view.needs ?? ''}`)),
  );
  // Asked only when something would be offered for the answer.
  const wantsBuild = viewIds.some((packed) => packed.endsWith('\u0000build'));
  const buildRoot = useBuildRoot(wantsBuild ? root : '');
  const openExtensionView = useStore((s) => s.openExtensionView);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  /*
   * Which of them this folder can actually offer, worked out once.
   *
   * Each rule is the same one it has always been: a panel that needs a
   * repository is not offered on a folder that is not one, a panel about a
   * folder needs one on screen, a build panel needs a pom or a Gradle build at
   * or above here. And a panel about something else entirely — a cluster — is
   * opened from Extensions, where it is not pretending to have anything to do
   * with what is on screen.
   */
  const views = useMemo(
    () =>
      viewIds
        .map((packed) => {
          const [id, title, needs] = packed.split('\u0000');
          return { id, title, needs };
        })
        .filter(({ needs }) => {
          if (needs === 'repository') return Boolean(gitRoot);
          if (needs === 'folder') return Boolean(root);
          if (needs === 'build') return Boolean(buildRoot);
          return !needs;
        })
        .map((view) => ({
          ...view,
          on: view.needs === 'repository' ? gitRoot : view.needs === 'build' ? buildRoot : root || null,
        })),
    [viewIds, gitRoot, root, buildRoot],
  );

  if (!views.length) return null;

  return (
    <>
      <button
        ref={anchorRef}
        className={`files-tool${open ? ' is-on' : ''}`}
        aria-label="What else this folder opens"
        aria-expanded={open}
        title={
          views.length === 1
            ? views[0].title
            : `${views.length} more things this folder opens`
        }
        onClick={() => setOpen((was) => !was)}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor">
          <circle cx="7" cy="3" r="1.15" />
          <circle cx="7" cy="7" r="1.15" />
          <circle cx="7" cy="11" r="1.15" />
        </svg>
      </button>
      {open && (
        <Popover anchorEl={anchorRef.current} onClose={() => setOpen(false)}>
          <div className="menu-label">Open in this folder</div>
          {views.map((view) => (
            <button
              key={view.id}
              className="menu-item"
              onClick={() => {
                setOpen(false);
                openExtensionView(view.id, view.on);
              }}
            >
              <span>
                <i className="menu-glyph">{extensionGlyph(view.needs)}</i>
                {view.title}
              </span>
            </button>
          ))}
        </Popover>
      )}
    </>
  );
}

/**
 * A mark for what a panel is about, kept small on purpose.
 *
 * In the menu the name does the work — this is only there so the rows have a
 * left edge to line up on. It is the one place these marks are allowed to be
 * ambiguous, because nothing depends on reading them.
 */
function extensionGlyph(needs: string) {
  if (needs === 'folder') {
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
        <path d="M4 2.2v9.6l7.4-4.8z" />
      </svg>
    );
  }
  if (needs === 'build') {
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
        <path d="M7 1.8 12.4 4.5 7 7.2 1.6 4.5z" />
        <path d="M1.6 7.2 7 9.9l5.4-2.7M1.6 9.9 7 12.6l5.4-2.7" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2 10.5V3.2M2 3.2a1.4 1.4 0 1 0 0-.1M2 10.8a1.4 1.4 0 1 0 0 .1" />
      <path d="M7 11.2V6.4c0-1 .8-1.8 1.8-1.8H11" />
      <circle cx="7" cy="12" r="1.4" />
      <circle cx="12" cy="4.6" r="1.4" />
    </svg>
  );
}

/**
 * Whether a folder is inside a Maven or Gradle project, and where that is.
 *
 * Asked once per folder and remembered for the window: it is a handful of
 * stats up the directory tree, but it is asked by every folder tab on every
 * render, and a cache is cheaper than being clever about renders. Asked again
 * when the tree changes, because the answer changes when somebody adds a pom.
 */
const buildRoots = new Map<string, string | null>();
function useBuildRoot(root: string): string | null {
  const [found, setFound] = useState<string | null>(() => (root ? (buildRoots.get(root) ?? null) : null));
  useEffect(() => {
    if (!root) {
      setFound(null);
      return;
    }
    let alive = true;
    // What was known, first, so a tab pointed at a new folder never offers
    // the old folder's project for the length of a round trip.
    setFound(buildRoots.get(root) ?? null);
    const ask = () =>
      void window.api.build.call('root', { dir: root }).then((answer) => {
        const where = answer.ok && typeof answer.root === 'string' ? answer.root : null;
        buildRoots.set(root, where);
        if (alive) setFound(where);
      });
    // Asked again on every mount, cache or no cache: the listener below is
    // only there while this tab is in front, and a pom that arrived while it
    // was behind another is a pom nobody was told about.
    ask();
    const stop = window.api.files.onTreeChanged((change) => {
      // `git` is not "only git": a burst is reported as its strongest kind,
      // and a checkout that rewrites the pom arrives as one.
      if (change.root === root && change.kind !== 'noise') ask();
    });
    return () => {
      alive = false;
      stop();
    };
  }, [root]);
  return found;
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
/**
 * Finding a file by name, without leaving the folder you are in.
 *
 * A file tree answers "what is in here" and, until now, nothing else — the
 * question people actually arrive with is "where is that thing", and answering
 * it meant Finder, or a terminal, or knowing.
 *
 * It narrows the tree rather than replacing it. Typing takes rows away; the
 * folders that still hold something stay, opened down to what matched, and
 * everything else goes. That is what a search box does everywhere else, and the
 * reason it matters here is that the shape of the tree is half the answer:
 * seeing *where* the three files called `config` are is the thing being asked.
 * Deleting the tree and printing a list instead throws that away and makes the
 * panel blink on every keystroke.
 */

/**
 * What the tree may still draw while a search is on.
 *
 * `keep` is every match plus every folder above it, so a branch survives only
 * because something inside it did. `matched` is the matches themselves, which
 * are the rows worth marking. Null means no search: draw everything.
 */
const FindNarrowing = createContext<{ keep: Set<string>; matched: Set<string> } | null>(null);

function FindBox({ panelId, root }: { panelId: string; root: string }) {
  const query = useStore((s) => asFilePanel(s.panels[panelId])?.find ?? '');
  const patch = useStore((s) => s.patchPanel);
  const inputRef = useRef<HTMLInputElement>(null);

  // The folder changed under it: an answer about the last one is worse than none.
  useEffect(() => {
    if (query) patch(panelId, { find: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p' && !event.shiftKey) {
        // Only the folder somebody is actually in: several are often open, and
        // every one of them is listening.
        const { layout, activeLeafId } = useStore.getState();
        const leaf = leafOfTab(layout, panelId);
        if (!leaf || leaf.id !== activeLeafId || leaf.active !== panelId) return;
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelId]);

  return (
    <div className="files-find">
      <svg className="files-find-icon" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="6.2" cy="6.2" r="3.9" />
        <path d="M9.2 9.2L12 12" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        className="files-find-input"
        placeholder="Find a file or folder"
        aria-label="Find a file or folder in this folder"
        value={query}
        onChange={(event) => patch(panelId, { find: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            patch(panelId, { find: '' });
            event.currentTarget.blur();
          }
        }}
      />
      {query && (
        <button className="files-find-clear" aria-label="Stop searching" onClick={() => patch(panelId, { find: '' })}>
          ×
        </button>
      )}
    </div>
  );
}

/**
 * The tree, with everything that does not match taken out of it.
 *
 * The narrowing arrives from the main process, so it lags the keystroke by a
 * moment. What is on screen meanwhile is the *previous* narrowing rather than
 * nothing: a search that blanks between answers flickers once per letter, and
 * the rows that are about to go are the ones already being looked past.
 */
function NarrowedTree({ panelId, root, query }: { panelId: string; root: string; query: string }) {
  const [found, setFound] = useState<{ query: string; keep: Set<string>; matched: Set<string>; cut: boolean; error: string | null } | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setFound(null);
      return;
    }
    let alive = true;
    const at = window.setTimeout(() => {
      window.api.files.find(root, query).then(
        (result) => {
          if (!alive) return;
          const keep = new Set<string>();
          const matched = new Set<string>();
          for (const row of result.results ?? []) {
            matched.add(row.path);
            // Every folder above it, so the branch it lives in survives with it.
            let at = row.path;
            while (at.length > root.length) {
              keep.add(at);
              const cut = at.lastIndexOf('/');
              if (cut <= 0) break;
              at = at.slice(0, cut);
            }
          }
          setFound({ query, keep, matched, cut: Boolean(result.cut), error: result.ok ? null : (result.error ?? 'It could not look.') });
        },
        (error) => alive && setFound({ query, keep: new Set(), matched: new Set(), cut: false, error: String(error?.message ?? error) }),
      );
    }, 140);
    return () => {
      alive = false;
      window.clearTimeout(at);
    };
  }, [root, query]);

  const narrowing = useMemo(
    () => (found ? { keep: found.keep, matched: found.matched } : null),
    [found],
  );
  const behind = Boolean(found && found.query !== query);

  return (
    <FindNarrowing.Provider value={narrowing}>
      <DropZone panelId={panelId} dir={root} className={`files-tree-scroll${behind ? ' is-behind' : ''}`}>
        <UpRow panelId={panelId} root={root} />
        <Dir panelId={panelId} path={root} depth={0} />
        {found?.error && <p className="files-find-note is-bad">{found.error}</p>}
        {found && !found.error && found.matched.size === 0 && !behind && (
          <p className="files-find-note">Nothing here is called that.</p>
        )}
        {found?.cut && (
          <p className="files-find-note">
            It stopped before reaching the end of this folder — a few more words will narrow it.
          </p>
        )}
      </DropZone>
    </FindNarrowing.Provider>
  );
}

function Dir({ panelId, path, depth }: { panelId: string; path: string; depth: number }) {
  const listing = useStore((s) => s.dirs[path]);
  const expanded = useStore(
    useShallow((s) => {
      const panel = asFilePanel(s.panels[panelId]);
      return panel?.kind === 'files' ? panel.expanded : [];
    }),
  );
  const loadDir = useStore((s) => s.loadDir);
  const narrowing = useContext(FindNarrowing);

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

  // What survives the search, if one is on. A folder is kept because something
  // inside it matched, and is then opened so that something can be seen.
  const rows = narrowing ? listing.entries.filter((entry) => narrowing.keep.has(entry.path)) : listing.entries;
  if (!rows.length) return null;

  return (
    <>
      {rows.map((entry) => (
        <Row
          key={entry.path}
          panelId={panelId}
          entry={entry}
          depth={depth}
          expanded={narrowing ? entry.isDirectory : expanded.includes(entry.path)}
          matched={narrowing ? narrowing.matched.has(entry.path) : false}
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
  matched = false,
}: {
  panelId: string;
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  /** This row is what the search was looking for, rather than a folder on the way to it. */
  matched?: boolean;
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
  const renameEntry = useStore((s) => s.renameEntry);
  const trashEntry = useStore((s) => s.trashEntry);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [asking, setAsking] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Just created under a placeholder name: straight into renaming it.
  useEffect(() => {
    if (pendingRenames.delete(entry.path)) setRenaming(true);
  }, [entry.path]);

  const commitRename = async (name: string) => {
    setRenaming(false);
    if (!name || name === entry.name) return;
    const problem = await renameEntry(entry.path, name);
    if (problem) tell(panelId, problem);
  };

  const rowClass = `files-row${isOpen ? ' is-open' : ''}${entry.noise ? ' is-noise' : ''}${dragging ? ' is-dragging' : ''}${matched ? ' is-match' : ''}`;
  const rowStyle = { paddingLeft: 6 + depth * 12 };
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenuAt({ x: event.clientX, y: event.clientY });
  };
  const onDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData(FILE_MIME, entry.path);
    event.dataTransfer.effectAllowed = 'move';
    setDragging(true);
  };
  const body = (
    <>
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
        {renaming ? (
          <RenameBox name={entry.name} isDirectory={entry.isDirectory} onDone={commitRename} />
        ) : (
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
        )}
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
        {/*
          A link, and where it goes. Two folders with nearly the same name, one
          of them a link into somewhere else entirely, is how somebody spends an
          afternoon reading a copy that stopped syncing weeks ago. The tree
          followed links already; it simply never said that it had.
        */}
        {entry.link && (
          <span
            className={`files-link${entry.link.broken ? ' is-broken' : ''}`}
            title={entry.link.broken
              ? `A link to ${entry.link.to ?? 'somewhere'} — nothing is there any more`
              : `A link to ${entry.link.to ?? 'somewhere else'}`}
          >
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M6 8a2.6 2.6 0 0 0 3.9.3l2-2a2.6 2.6 0 0 0-3.7-3.7l-1.1 1.1" />
              <path d="M8 6a2.6 2.6 0 0 0-3.9-.3l-2 2a2.6 2.6 0 0 0 3.7 3.7l1.1-1.1" />
            </svg>
          </span>
        )}
        {dirty && <span className="files-dirty" title="unsaved" />}
    </>
  );

  return (
    <>
      {entry.isDirectory ? (
        <DropZone
          panelId={panelId}
          dir={entry.path}
          className={rowClass}
          style={rowStyle}
          title={entry.path}
          draggable={!renaming}
          onDragStart={onDragStart}
          onDragEnd={() => setDragging(false)}
          onClick={() => !renaming && toggleDir(panelId, entry.path)}
          onContextMenu={onContextMenu}
        >
          {body}
        </DropZone>
      ) : (
        <div
          className={rowClass}
          style={rowStyle}
          title={entry.path}
          draggable={!renaming}
          onDragStart={onDragStart}
          onDragEnd={() => setDragging(false)}
          onClick={() => !renaming && openFile(panelId, entry.path)}
          onContextMenu={onContextMenu}
        >
          {body}
        </div>
      )}
      {menuAt && (
        <EntryMenu
          panelId={panelId}
          entry={entry}
          at={menuAt}
          onClose={() => setMenuAt(null)}
          onRename={() => setRenaming(true)}
          onTrash={() => setAsking(true)}
        />
      )}
      {asking && (
        <TrashConfirm
          entry={entry}
          dirty={dirty}
          onAnswer={(yes) => {
            setAsking(false);
            if (!yes) return;
            void trashEntry(entry.path).then((problem) => {
              if (problem) tell(panelId, problem);
            });
          }}
        />
      )}
      {entry.isDirectory && expanded && <Dir panelId={panelId} path={entry.path} depth={depth + 1} />}
    </>
  );
}

/**
 * The name, editable where it was. The stem is selected and the extension is
 * not, which is the part of a rename that is nearly always meant. Enter
 * keeps, Escape leaves it as it was, and clicking elsewhere keeps too — the
 * way every file manager does it.
 */
function RenameBox({ name, isDirectory, onDone }: { name: string; isDirectory: boolean; onDone(name: string): void }) {
  const box = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const input = box.current;
    if (!input) return;
    input.focus();
    const dot = isDirectory || name.startsWith('.') ? -1 : name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name, isDirectory]);
  const finish = (keep: boolean) => {
    const input = box.current;
    if (!input) return;
    const value = input.value.trim();
    if (keep && value !== name && nameProblem(value)) {
      setProblem(nameProblem(value));
      return;
    }
    onDone(keep ? value : name);
  };
  return (
    <input
      ref={box}
      className="files-rename"
      defaultValue={name}
      spellCheck={false}
      title={problem ?? undefined}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => finish(true)}
      onInput={() => setProblem(null)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
        event.stopPropagation();
      }}
    />
  );
}

/**
 * The one question the tree asks. To the Trash, so it can be undone from
 * there — but a folder is a folder, and a file with an edit nobody saved is
 * an edit that goes with it.
 */
function TrashConfirm({ entry, dirty, onAnswer }: { entry: DirEntry; dirty: boolean; onAnswer(yes: boolean): void }) {
  return (
    <div className="modal-backdrop" onMouseDown={() => onAnswer(false)}>
      <div className="confirm" onMouseDown={(event) => event.stopPropagation()}>
        <h3>Move {entry.isDirectory ? `the folder ${entry.name}` : entry.name} to the Trash?</h3>
        <p>
          {entry.isDirectory ? 'Everything in it goes with it. ' : ''}
          {dirty ? 'It has changes that were never saved; they go too. ' : ''}
          It can be put back from the Trash.
        </p>
        <div className="confirm-actions">
          <button className="ghost-btn" autoFocus onClick={() => onAnswer(false)}>
            Keep it
          </button>
          <button className="danger-btn" onClick={() => onAnswer(true)}>
            Move to Trash
          </button>
        </div>
      </div>
    </div>
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
  /*
   * Per open file, and not remembered: which way you want to look at a document
   * is a question about this minute, not a setting.
   *
   * YAML and XML open in the editor rather than the preview, unlike everything
   * else that previews. Their preview adds folding and a tree — worth having,
   * and a button away — but the colours are now the same on both sides, and
   * opening a file you meant to edit in a thing you cannot type into is a
   * detour when the editor already reads as well.
   */
  const readsWellInTheEditor = kind === 'yaml' || kind === 'xml';
  const [showing, setShowing] = useState<'code' | 'preview' | 'both'>(
    kind && !readsWellInTheEditor ? 'preview' : 'code',
  );
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
