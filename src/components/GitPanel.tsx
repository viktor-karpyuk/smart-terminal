import { useEffect, useMemo, useRef, useState } from 'react';
import { asFilePanel, useStore } from '../state/store';
import type { GitBranch, GitCommit, GitFile } from '../global';
import { Popover } from './Popover';
import { group } from '../lib/gitTree';
import type { Node } from '../lib/gitTree';

/**
 * Git, as a tab beside the files.
 *
 * Three views on one repository: what is about to be committed, what has
 * happened, and the branches. It runs git in the panel's folder rather than in a
 * session's terminal, so committing never interrupts whatever Claude is doing —
 * and because a session can commit without telling anyone, every view asks git
 * again rather than trusting the picture it already has.
 */
export function GitPanel({ panelId }: { panelId: string }) {
  const panel = useStore((s) => asFilePanel(s.panels[panelId]) ?? null);
  const root = panel?.gitRoot ?? null;
  const repo = useStore((s) => (root ? s.repos[root] : undefined));
  const setGitView = useStore((s) => s.setGitView);
  const refreshRepo = useStore((s) => s.refreshRepo);

  useEffect(() => {
    if (root && !repo) refreshRepo(root, 'all');
  }, [root, repo, refreshRepo]);

  if (!panel) return null;
  if (!root) {
    return (
      <div className="git-panel">
        <div className="files-empty">
          <p>This folder is not in a git repository.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="git-panel">
      <BranchBar panelId={panelId} root={root} />

      <div className="git-views">
        {(['changes', 'history', 'branches'] as const).map((view) => (
          <button
            key={view}
            className={panel.gitView === view ? 'is-on' : ''}
            onClick={() => setGitView(panelId, view)}
          >
            {view === 'changes' ? 'Changes' : view === 'history' ? 'History' : 'Branches'}
            {view === 'changes' && repo?.files.length ? (
              <span className="git-count">{repo.files.length}</span>
            ) : null}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          title="Ask git again"
          onClick={() => refreshRepo(root, 'all')}
        >
          ↻
        </button>
      </div>

      {repo?.notice && (
        <div className={`git-notice is-${repo.notice.kind}`}>
          <span className="file-bar-dot" />
          <span className="file-bar-text">{repo.notice.text}</span>
        </div>
      )}
      {repo?.busy && (
        <div className="git-notice is-busy">
          <span className="git-spinner" />
          <span className="file-bar-text">{repo.busy}…</span>
        </div>
      )}
      {repo?.error && !repo.busy && (
        <div className="git-notice is-bad">
          <span className="file-bar-dot" />
          <span className="file-bar-text">{repo.error}</span>
        </div>
      )}

      {panel.gitView === 'changes' && <Changes panelId={panelId} />}
      {panel.gitView === 'history' && <History panelId={panelId} />}
      {panel.gitView === 'branches' && <Branches panelId={panelId} />}
    </div>
  );
}

function BranchBar({ panelId, root }: { panelId: string; root: string }) {
  const repo = useStore((s) => s.repos[root]);
  const gitDo = useStore((s) => s.gitDo);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <div className="git-branchbar">
      {open && (
        <BranchMenu panelId={panelId} root={root} anchorEl={chipRef.current} onClose={() => setOpen(false)} />
      )}
      <button ref={chipRef} className="git-branch" onClick={() => setOpen((was) => !was)} title="Branches">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#e0af68" strokeWidth="1.3">
          <circle cx="3.6" cy="3.2" r="1.7" />
          <circle cx="3.6" cy="10.8" r="1.7" />
          <circle cx="10.4" cy="6.4" r="1.7" />
          <path d="M3.6 4.9v4.2M5.2 3.9c2.6.4 3.8 1.3 4 2.3" />
        </svg>
        <span>{repo?.detached ? 'detached HEAD' : (repo?.branch ?? '…')}</span>
        <span className="git-branch-caret">⌄</span>
      </button>
      {(repo?.ahead ?? 0) > 0 && <span className="git-ahead">↑{repo?.ahead}</span>}
      {(repo?.behind ?? 0) > 0 && <span className="git-behind">↓{repo?.behind}</span>}
      <span style={{ flex: 1 }} />
      <button className="ghost-btn" onClick={() => gitDo(root, 'fetch', {}, 'Fetching')}>
        Fetch
      </button>
      <button className="ghost-btn" onClick={() => gitDo(root, 'pull', {}, 'Updating')}>
        Update
      </button>
      <button
        className="ghost-btn"
        onClick={() =>
          gitDo(
            root,
            'push',
            // A branch with no upstream needs one, and saying so is better than
            // failing with git's advice text and making someone read it.
            repo?.upstream ? {} : { setUpstream: repo?.branch },
            'Pushing',
          )
        }
      >
        Push
      </button>
    </div>
  );
}

/**
 * Every branch, and everything that can be done to one, off the branch chip.
 *
 * A branch is picked first and its actions appear under it, rather than a flat
 * list of verbs that each then ask which branch. And every verb names both
 * sides — *Merge into main*, never a bare *Merge*: the direction is the whole
 * decision, and getting it backwards is the mistake everyone makes once.
 */
function BranchMenu({
  panelId,
  root,
  anchorEl,
  onClose,
}: {
  panelId: string;
  root: string;
  anchorEl: HTMLElement | null;
  onClose(): void;
}) {
  const repo = useStore((s) => s.repos[root]);
  const gitDo = useStore((s) => s.gitDo);
  const setGitView = useStore((s) => s.setGitView);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);

  const current = repo?.current ?? null;
  const run = (name: string, args: unknown, label: string) => {
    onClose();
    gitDo(root, name, args, label);
  };

  return (
    <Popover anchorEl={anchorEl} onClose={onClose}>
      <div className="popover-header">
        <span>On {current ?? 'HEAD'}</span>
        {((repo?.ahead ?? 0) > 0 || (repo?.behind ?? 0) > 0) && (
          <span>
            {(repo?.ahead ?? 0) > 0 && <em className="git-ahead">↑{repo?.ahead}</em>}{' '}
            {(repo?.behind ?? 0) > 0 && <em className="git-behind">↓{repo?.behind}</em>}
          </span>
        )}
      </div>

      <button className="menu-item" onClick={() => run('pull', {}, 'Updating')}>
        <span>Update from origin</span>
        <kbd>{(repo?.behind ?? 0) > 0 ? `pull ↓${repo?.behind}` : 'pull'}</kbd>
      </button>
      <button
        className="menu-item"
        onClick={() => run('push', repo?.upstream ? {} : { setUpstream: repo?.branch }, 'Pushing')}
      >
        <span>Push</span>
        <kbd>{repo?.upstream ? `↑${repo?.ahead ?? 0} commits` : 'and set the upstream'}</kbd>
      </button>
      <button className="menu-item" onClick={() => run('fetch', {}, 'Fetching')}>
        <span>Fetch</span>
        <kbd>every remote</kbd>
      </button>

      <div className="menu-separator" />
      {naming ? (
        <label className="field">
          <span>New branch from {current ?? 'HEAD'}</span>
          <input
            autoFocus
            placeholder="fix/something"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setNaming(false);
              if (event.key !== 'Enter') return;
              const name = (event.target as HTMLInputElement).value.trim();
              if (name) run('createBranch', { name }, `Creating ${name}`);
              else setNaming(false);
            }}
          />
        </label>
      ) : (
        <button className="menu-item" onClick={() => setNaming(true)}>
          <span>New branch…</span>
          <kbd>from here</kbd>
        </button>
      )}

      <div className="menu-label">Local</div>
      {repo?.local.map((branch) => (
        <div key={branch.name}>
          <button
            className={`menu-item${branch.name === current ? ' menu-check is-on' : ''}`}
            onClick={() => setExpanded(expanded === branch.name ? null : branch.name)}
          >
            <span>
              {branch.name === current && <i className="check">✓</i>} {branch.name}
            </span>
            <kbd>
              {branch.gone
                ? 'gone'
                : !branch.upstream
                  ? 'no remote'
                  : branch.ahead || branch.behind
                    ? `${branch.ahead ? `↑${branch.ahead}` : ''}${branch.behind ? ` ↓${branch.behind}` : ''}`.trim()
                    : 'up to date'}
            </kbd>
          </button>
          {expanded === branch.name && (
            <div className="branch-actions">
              {branch.name !== current && (
                <button className="menu-item" onClick={() => run('checkout', { ref: branch.name }, `Checking out ${branch.name}`)}>
                  <span>Check it out</span>
                </button>
              )}
              {branch.name !== current && (
                <button
                  className="menu-item"
                  onClick={() => run('merge', { ref: branch.name }, `Merging ${branch.name} into ${current}`)}
                >
                  <span>Merge into <em>{current}</em></span>
                </button>
              )}
              {branch.name !== current && (
                <button
                  className="menu-item"
                  onClick={() => run('rebase', { ref: branch.name }, `Rebasing ${current} onto ${branch.name}`)}
                >
                  <span>Rebase <em>{current}</em> onto it</span>
                </button>
              )}
              <button
                className="menu-item"
                onClick={() => {
                  const next = window.prompt(`Rename ${branch.name} to`, branch.name);
                  if (next && next !== branch.name) run('renameBranch', { from: branch.name, to: next }, `Renaming ${branch.name}`);
                }}
              >
                <span>Rename…</span>
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  onClose();
                  useStore.getState().patchPanel(panelId, { selectedBranch: branch.name });
                  setGitView(panelId, 'branches');
                }}
              >
                <span>Compare with this one</span>
              </button>
              {branch.name !== current && (
                <button
                  className="menu-item is-danger"
                  onClick={() => run('deleteBranch', { name: branch.name }, `Deleting ${branch.name}`)}
                >
                  <span>Delete</span>
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {(repo?.remote.length ?? 0) > 0 && <div className="menu-label">Remote</div>}
      {repo?.remote.slice(0, 12).map((branch) => {
        const local = branch.name.replace(/^[^/]+\//, '');
        const haveIt = repo?.local.some((entry) => entry.name === local);
        return (
          <button
            key={branch.name}
            className="menu-item"
            disabled={haveIt}
            onClick={() =>
              !haveIt && run('trackRemote', { remote: branch.name, local }, `Checking out ${local}`)
            }
          >
            <span>{branch.name}</span>
            <kbd>{haveIt ? 'already local' : `check out as ${local}`}</kbd>
          </button>
        );
      })}

      {(repo?.stashes.length ?? 0) > 0 && <div className="menu-label">Stashes</div>}
      {repo?.stashes.map((stash) => (
        <button
          key={stash.ref}
          className="menu-item"
          onClick={() => run('stashPop', { ref: stash.ref }, 'Restoring the stash')}
        >
          <span>{stash.subject}</span>
          <kbd>put it back</kbd>
        </button>
      ))}
    </Popover>
  );
}

// --- Changes ---------------------------------------------------------------

/** Every folder key in the tree, however deep — what "collapse everything" means. */
function allFolders(nodes: Node[]): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'dir') continue;
    keys.push(node.key);
    keys.push(...allFolders(node.children));
  }
  return keys;
}

/**
 * One row of the changes tree, and everything under it.
 *
 * Recursive, which the previous version was not: it drew a folder and then its
 * files, and rendered a folder inside a folder as nothing at all. That was
 * invisible while every grouping produced one level — and it would have quietly
 * swallowed whole modules the moment one produced two.
 */
function TreeRow({
  node,
  depth,
  panelId,
  collapsed,
  selectedPath,
  onToggleStage,
  onFold,
}: {
  node: Node;
  depth: number;
  panelId: string;
  collapsed: string[];
  selectedPath: string | null;
  onToggleStage(file: GitFile): void;
  onFold(key: string): void;
}) {
  if (node.kind === 'file') {
    return (
      <FileRow
        file={node.file}
        depth={depth}
        onToggle={onToggleStage}
        panelId={panelId}
        selected={selectedPath === node.file.path}
      />
    );
  }

  const shut = collapsed.includes(node.key);
  return (
    <>
      <div
        className="git-row is-dir"
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => onFold(node.key)}
      >
        <svg
          className={`files-chevron${shut ? '' : ' is-open'}`}
          width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
        >
          <path d="M4.5 2.5L8 6l-3.5 3.5" />
        </svg>
        <span className="git-dir-name">{node.label}</span>
        <span className="git-count">{node.count}</span>
      </div>
      {!shut &&
        node.children.map((child) => (
          <TreeRow
            key={child.key}
            node={child}
            depth={depth + 1}
            panelId={panelId}
            collapsed={collapsed}
            selectedPath={selectedPath}
            onToggleStage={onToggleStage}
            onFold={onFold}
          />
        ))}
    </>
  );
}

const LETTER_COLOUR: Record<string, string> = {
  A: '#9ece6a', M: '#7aa2f7', D: '#f7768e', R: '#bb9af7', C: '#bb9af7', '?': '#e0af68', '!': '#f7768e',
};

export function Changes({ panelId, compact = false }: { panelId: string; compact?: boolean }) {
  const panel = useStore((s) => asFilePanel(s.panels[panelId]) ?? null);
  const root = panel?.gitRoot ?? '';
  const repo = useStore((s) => (root ? s.repos[root] : undefined));
  const patch = useStore((s) => s.patchPanel);
  const gitDo = useStore((s) => s.gitDo);
  /**
   * What was in the box before Amend was ticked, and what ticking put there.
   *
   * Both are needed to undo the tick honestly. Ticking replaces an empty box with
   * the message being rewritten — that is the point of it — but unticking must
   * only take back the message *it* put there. If the person has since edited it,
   * those words are theirs and clearing them would be destroying work to tidy up
   * a checkbox.
   */
  const draft = useRef<string | null>(null);
  const loaded = useRef<string | null>(null);

  /** Ticking Amend is a question asked of git, not a flag flipped in the panel. */
  const toggleAmend = async (id: string, on: boolean) => {
    const before = asFilePanel(useStore.getState().panels[id]);

    if (!on) {
      const untouched = before?.message === loaded.current;
      patch(id, { amend: false, message: untouched ? (draft.current ?? '') : (before?.message ?? '') });
      draft.current = null;
      loaded.current = null;
      return;
    }

    draft.current = before?.message ?? '';
    patch(id, { amend: true });

    const result = await window.api.git.call('head', root, {});
    if (!result?.ok) return;
    const now = asFilePanel(useStore.getState().panels[id]);
    // An answer that arrives late must not land on a box somebody has moved on
    // from — unticked in the meantime, or typed into while it was being fetched.
    if (!now?.amend || now.message.trim()) return;
    loaded.current = result.message ?? '';
    patch(id, { message: loaded.current });
  };

  const files = repo?.files ?? [];
  const tree = useMemo(() => group(files, panel?.gitGrouping ?? 'directory'), [files, panel?.gitGrouping]);
  const staged = files.filter((file) => file.staged || file.partial);
  const allStaged = files.length > 0 && staged.length === files.length;
  const someStaged = staged.length > 0 && !allStaged;

  if (!panel || !root) return null;

  const toggle = (file: GitFile) =>
    gitDo(root, file.staged || file.partial ? 'unstage' : 'stage', { paths: [file.path] }, 'Staging');

  // Everything in one call rather than one call per file: forty files is forty
  // git processes and forty refreshes, and the list flickering its way through
  // them looks like something going wrong.
  const selectAll = () =>
    gitDo(root, 'stage', { paths: files.map((file) => file.path) }, 'Staging everything');
  const deselectAll = () =>
    gitDo(
      root,
      'unstage',
      { paths: files.filter((file) => file.staged || file.partial).map((file) => file.path) },
      'Taking everything back out',
    );

  return (
    <>
      <div className={`git-toolbar${compact ? ' is-compact' : ''}`}>
        {!compact && <span className="git-toolbar-label">Group by</span>}
        <div className="segmented git-grouping" title="Group the changes by">
          {(['directory', 'module', 'both', 'files'] as const).map((mode) => (
            <button
              key={mode}
              className={panel.gitGrouping === mode ? 'is-on' : ''}
              onClick={() => patch(panelId, { gitGrouping: mode })}
            >
              {compact
                ? mode === 'directory' ? 'Dir' : mode === 'module' ? 'Mod' : mode === 'both' ? 'Both' : 'Flat'
                : mode === 'directory' ? 'Directory' : mode === 'module' ? 'Module' : mode === 'both' ? 'Both' : 'Files'}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          title="Expand everything"
          onClick={() => patch(panelId, { gitCollapsed: [] })}
        >
          +
        </button>
        <button
          className="icon-btn"
          title="Collapse everything"
          onClick={() =>
            // Every folder, not only the ones at the top: with modules over
            // directories, collapsing the outer row and leaving the inner ones
            // open means "expand everything" no longer means what it says.
            patch(panelId, { gitCollapsed: allFolders(tree) })
          }
        >
          –
        </button>
      </div>

      {files.length > 0 && (
        <div className="git-selectall">
          {/*
            One box for the lot. Tri-state on purpose: with some files staged it
            shows a dash rather than a tick, because a box that reads "checked"
            while three of seven are staged is a box that gets a half-commit made.
          */}
          <button
            className={`git-box${allStaged ? ' is-on' : someStaged ? ' is-partial' : ''}`}
            title={allStaged ? 'Take everything back out' : 'Stage everything'}
            aria-label={allStaged ? 'Deselect all' : 'Select all'}
            onClick={() => (allStaged ? deselectAll() : selectAll())}
          />
          <span className="git-selectall-count">
            {staged.length} of {files.length} staged
          </span>
          <span style={{ flex: 1 }} />
          <button className="link-btn" disabled={allStaged} onClick={selectAll}>
            {compact ? 'All' : 'Select all'}
          </button>
          <button className="link-btn" disabled={!staged.length} onClick={deselectAll}>
            {compact ? 'None' : 'Deselect all'}
          </button>
        </div>
      )}

      <div className="git-changes-body">
      <div className="git-list">
        {files.length === 0 && <p className="files-note">Nothing changed.</p>}
        {tree.map((node) => (
          <TreeRow
            key={node.key}
            node={node}
            depth={0}
            panelId={panelId}
            collapsed={panel.gitCollapsed}
            selectedPath={panel.selectedPath}
            onToggleStage={toggle}
            onFold={(key) =>
              patch(panelId, {
                gitCollapsed: panel.gitCollapsed.includes(key)
                  ? panel.gitCollapsed.filter((k) => k !== key)
                  : [...panel.gitCollapsed, key],
              })
            }
          />
        ))}
      </div>
      {!compact && <Diff root={root} panelId={panelId} />}
      </div>

      <div className="git-commit">
        {panel.amend && <Amending root={root} panelId={panelId} />}
        <textarea
          className="git-message"
          placeholder="What changed, and why"
          value={panel.message}
          onChange={(event) => patch(panelId, { message: event.target.value })}
        />
        <div className="git-commit-actions">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={panel.amend}
              onChange={(event) => toggleAmend(panelId, event.target.checked)}
            />
            <span>Amend</span>
          </label>
          <span style={{ flex: 1 }} />
          <button
            className="ghost-btn"
            disabled={!panel.message.trim() || (!staged.length && !panel.amend)}
            onClick={async () => {
              const result = await gitDo(root, 'commit', { message: panel.message, amend: panel.amend }, 'Committing');
              if (result.ok) patch(panelId, { message: '', amend: false });
            }}
          >
            Commit
          </button>
          <button
            className="primary-btn"
            disabled={!panel.message.trim() || (!staged.length && !panel.amend)}
            onClick={async () => {
              const result = await gitDo(root, 'commit', { message: panel.message, amend: panel.amend }, 'Committing');
              if (!result.ok) return;
              patch(panelId, { message: '', amend: false });
              await gitDo(root, 'push', repo?.upstream ? {} : { setUpstream: repo?.branch }, 'Pushing');
            }}
          >
            Commit and Push
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * What is about to be rewritten.
 *
 * Amend is the one git verb in this panel that changes history rather than adding
 * to it, and until now the box gave no sign of which commit it meant. Naming it —
 * its subject, when it was made, and every file already in it — is the difference
 * between amending the commit you think you are amending and amending whatever
 * happens to be at the top.
 */
function Amending({ root, panelId }: { root: string; panelId: string }) {
  const [head, setHead] = useState<{
    sha: string;
    message: string;
    author: string;
    date: string;
    files: Array<{ path: string; name: string; added: number | null; removed: number | null }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openFile = useStore((s) => s.openFile);

  useEffect(() => {
    let alive = true;
    setHead(null);
    setError(null);
    window.api.git.call('head', root, {}).then((result) => {
      if (!alive) return;
      if (result?.ok) setHead(result as never);
      else setError(result?.error ?? 'Could not read the last commit.');
    });
    return () => {
      alive = false;
    };
  }, [root]);

  if (error) return <p className="git-amending is-empty">{error}</p>;
  if (!head) return <p className="git-amending is-empty">Reading the last commit…</p>;

  const subject = head.message.split('\n')[0];

  return (
    <div className="git-amending">
      <header>
        <span className="git-amending-label">Rewriting</span>
        <code>{head.sha.slice(0, 8)}</code>
        <span className="git-amending-subject" title={head.message}>{subject}</span>
        <small>{new Date(head.date).toLocaleString()}</small>
      </header>
      <div className="git-amending-files">
        {!head.files.length && <span className="git-amending-none">No files in it — an empty commit.</span>}
        {head.files.map((file) => (
          <button
            key={file.path}
            className="git-amending-file"
            title={file.path}
            onClick={() => openFile(panelId, `${root}/${file.path}`)}
          >
            <span className="git-amending-name">{file.name}</span>
            <span className="git-amending-dir">{file.path.split('/').slice(0, -1).join('/')}</span>
            {file.added ? <i className="is-add">+{file.added}</i> : null}
            {file.removed ? <i className="is-del">−{file.removed}</i> : null}
          </button>
        ))}
      </div>
      <p className="git-amending-note">
        Committing replaces this commit. Anything staged joins it; the message above becomes its
        message. If it has already been pushed, the push after it has to be forced.
      </p>
    </div>
  );
}

function FileRow({
  file,
  depth,
  onToggle,
  panelId,
  selected,
}: {
  file: GitFile;
  depth: number;
  onToggle(file: GitFile): void;
  panelId: string;
  selected?: boolean;
}) {
  const openFile = useStore((s) => s.openFile);
  const patch = useStore((s) => s.patchPanel);

  return (
    <div
      className={`git-row${selected ? ' is-selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 16 }}
      // One click shows what changed; opening it to edit is the deliberate
      // second act, because most looks at a changed file are only looks.
      onClick={() => patch(panelId, { selectedPath: file.path })}
      onDoubleClick={() => openFile(panelId, file.absolute)}
    >
      <button
        className={`git-box${file.staged ? ' is-on' : file.partial ? ' is-partial' : ''}`}
        onClick={() => onToggle(file)}
        title={file.staged ? 'Staged — click to take it out' : 'Not staged — click to stage it'}
        aria-label="Stage"
      />
      <span className="git-letter" style={{ color: LETTER_COLOUR[file.letter] ?? '#7b849c' }}>
        {file.letter}
      </span>
      <span
        className={`git-file-name${file.letter === 'D' ? ' is-gone' : ''}`}
        title={file.from ? `${file.from} → ${file.path}` : file.path}
        // Back to the files, with this one open — the same tab, so nothing moves.
      >
        {depth === 0 && file.dir ? `${file.dir}/` : ''}
        {file.name}
      </span>
      {(file.added !== null || file.removed !== null) && (
        <span className="git-numstat">
          {file.added ? <i className="is-add">+{file.added}</i> : null}
          {file.removed ? <i className="is-del">−{file.removed}</i> : null}
        </span>
      )}
    </div>
  );
}

/**
 * What changed inside one file.
 *
 * The patch is parsed rather than shown raw: a unified diff carries its own line
 * numbers in the hunk headers, and a diff without them is a diff you cannot talk
 * about with anyone. Colour marks the change; the numbers say where it is.
 */
function Diff({ root, panelId }: { root: string; panelId: string }) {
  const selected = useStore((s) => asFilePanel(s.panels[panelId])?.selectedPath ?? null);
  const file = useStore((s) => {
    const gitRoot = asFilePanel(s.panels[panelId])?.gitRoot;
    return gitRoot ? s.repos[gitRoot]?.files.find((entry) => entry.path === selected) : undefined;
  });
  const openFile = useStore((s) => s.openFile);
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) {
      setPatch(null);
      return;
    }
    let alive = true;
    setPatch(null);
    setError(null);
    window.api.git
      .call('diff', root, { file: selected, untracked: file?.untracked === true })
      .then((result) => {
        if (!alive) return;
        if (result.ok) setPatch(result.patch ?? '');
        else setError(result.error ?? 'Could not read the diff.');
      });
    return () => {
      alive = false;
    };
  }, [root, selected, file?.untracked, file?.index, file?.worktree]);

  if (!selected) {
    return (
      <div className="git-diff is-empty">
        <p className="files-note">Pick a file to see what changed.</p>
      </div>
    );
  }

  return (
    <div className="git-diff">
      <div className="git-diff-head">
        <span className="git-diff-name" title={selected}>{selected}</span>
        <button className="link-btn" onClick={() => file && openFile(panelId, file.absolute)}>
          Open
        </button>
      </div>
      <div className="git-diff-body">
        {error && <p className="files-note">{error}</p>}
        {patch === null && !error && <p className="files-note">Reading…</p>}
        {patch !== null && patch.trim() === '' && <p className="files-note">No text changes.</p>}
        {patch ? <Patch text={patch} /> : null}
      </div>
    </div>
  );
}

/** A unified diff, with the line numbers its hunk headers already carry. */
function Patch({ text }: { text: string }) {
  const rows = useMemo(() => {
    const out: Array<{ kind: string; text: string; before: number | null; after: number | null }> = [];
    let before = 0;
    let after = 0;
    for (const line of text.split('\n')) {
      // `@@ -12,7 +12,9 @@` — where the next run of lines sits in each side.
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        before = Number(hunk[1]);
        after = Number(hunk[2]);
        out.push({ kind: 'hunk', text: line, before: null, after: null });
        continue;
      }
      // The file headers say nothing the panel is not already showing.
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) {
        continue;
      }
      if (line.startsWith('+')) {
        out.push({ kind: 'add', text: line.slice(1), before: null, after });
        after += 1;
      } else if (line.startsWith('-')) {
        out.push({ kind: 'del', text: line.slice(1), before, after: null });
        before += 1;
      } else if (line.startsWith('\\')) {
        out.push({ kind: 'note', text: line.slice(1).trim(), before: null, after: null });
      } else {
        out.push({ kind: 'same', text: line.slice(1), before, after });
        before += 1;
        after += 1;
      }
    }
    return out;
  }, [text]);

  return (
    <div className="patch mono">
      {rows.map((row, index) => (
        <div key={index} className={`patch-line is-${row.kind}`}>
          <span className="patch-num">{row.before ?? ''}</span>
          <span className="patch-num">{row.after ?? ''}</span>
          <span className="patch-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</span>
          <span className="patch-text">{row.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Making a branch, from wherever you are.
 *
 * It branches from the current one and checks it out, which is what `git
 * checkout -b` does and what anyone typing "new branch" means. The name is not
 * validated here — git's own refusal says exactly what is wrong with it, and
 * would say it better than a regex.
 */
function NewBranch({ root, from }: { root: string; from: string | null }) {
  const [naming, setNaming] = useState(false);
  const gitDo = useStore((s) => s.gitDo);

  if (!naming) {
    return (
      <div className="git-newbranch">
        <button className="ghost-btn" onClick={() => setNaming(true)}>
          + New branch
        </button>
      </div>
    );
  }

  return (
    <div className="git-newbranch">
      <input
        autoFocus
        placeholder="fix/something"
        onBlur={() => setNaming(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setNaming(false);
          if (event.key !== 'Enter') return;
          const name = (event.target as HTMLInputElement).value.trim();
          if (!name) return setNaming(false);
          setNaming(false);
          gitDo(root, 'createBranch', { name }, `Creating ${name}`);
        }}
      />
      <span className="form-hint">from {from ?? 'HEAD'} · ↵ to make it</span>
    </div>
  );
}

// --- History ---------------------------------------------------------------

/** One row of the graph is one commit, so both use the same height. */
const ROW = 26;
const LANE_W = 16;

function History({ panelId }: { panelId: string }) {
  const panel = useStore((s) => asFilePanel(s.panels[panelId]) ?? null);
  const root = panel?.gitRoot ?? '';
  const repo = useStore((s) => (root ? s.repos[root] : undefined));
  const patch = useStore((s) => s.patchPanel);
  const refreshRepo = useStore((s) => s.refreshRepo);

  useEffect(() => {
    if (root && repo && !repo.commits.length && !repo.loading) refreshRepo(root, 'graph');
  }, [root, repo, refreshRepo]);

  if (!panel || !root) return null;
  const commits = repo?.commits ?? [];
  const width = Math.max(1, repo?.graphWidth ?? 1) * LANE_W + 16;

  return (
    <div className="git-history">
      <div className="git-graph" style={{ minHeight: commits.length * ROW }}>
        <svg
          className="git-lanes"
          width={width}
          height={commits.length * ROW}
          fill="none"
          strokeWidth="1.8"
        >
          {commits.map((commit, index) => (
            <Lanes key={commit.sha} commit={commit} index={index} commits={commits} />
          ))}
        </svg>

        <div className="git-commits" style={{ marginLeft: width }}>
          {commits.map((commit) => (
            <div
              key={commit.sha}
              className={`git-commit-row${panel.selectedSha === commit.sha ? ' is-selected' : ''}`}
              onClick={() => patch(panelId, { selectedSha: commit.sha })}
            >
              {commit.refs.map((ref) => (
                <span
                  key={ref.kind + ref.name}
                  className={`git-ref is-${ref.kind}${ref.head ? ' is-head' : ''}`}
                  title={ref.kind}
                >
                  {ref.name}
                </span>
              ))}
              <span className="git-subject">{commit.subject}</span>
              <span className="git-who">{commit.author}</span>
              <span className="git-sha">{commit.sha.slice(0, 7)}</span>
            </div>
          ))}
          {!commits.length && <p className="files-note">No commits yet.</p>}
        </div>
      </div>

      {panel.selectedSha && <CommitDetail root={root} sha={panel.selectedSha} />}
    </div>
  );
}

/** The lines and the dot for one commit, on the shared row rhythm. */
function Lanes({ commit, index, commits }: { commit: GitCommit; index: number; commits: GitCommit[] }) {
  const y = index * ROW + ROW / 2;
  const x = (lane: number) => 10 + lane * LANE_W;
  const rowOf = (sha: string) => commits.findIndex((other) => other.sha === sha);

  return (
    <g>
      {/* lanes that only pass this row keep their line unbroken */}
      {commit.through.map((lane) => (
        <line
          key={`t${lane.lane}`}
          x1={x(lane.lane)}
          y1={y - ROW / 2}
          x2={x(lane.lane)}
          y2={y + ROW / 2}
          stroke={lane.colour}
        />
      ))}

      {commit.edges.map((edge) => {
        const target = rowOf(edge.sha);
        // A parent off the end of the page still gets a stub, so the line does
        // not simply stop in mid-air at the bottom of the list.
        const endY = target === -1 ? y + ROW : target * ROW + ROW / 2;
        return edge.from === edge.to ? (
          <line key={edge.sha + edge.to} x1={x(edge.from)} y1={y} x2={x(edge.to)} y2={endY} stroke={edge.colour} />
        ) : (
          <path
            key={edge.sha + edge.to}
            d={`M${x(edge.from)} ${y} C ${x(edge.from)} ${y + ROW * 0.6}, ${x(edge.to)} ${endY - ROW * 0.6}, ${x(edge.to)} ${endY}`}
            stroke={edge.colour}
          />
        );
      })}

      <circle cx={x(commit.lane)} cy={y} r={commit.merge ? 5 : 4} fill={commit.merge ? commit.colour : '#0b0d13'} stroke={commit.colour} />
    </g>
  );
}

function CommitDetail({ root, sha }: { root: string; sha: string }) {
  const [files, setFiles] = useState<Array<{ path: string; name: string; added: number | null; removed: number | null }>>([]);
  const gitDo = useStore((s) => s.gitDo);
  const refreshRepo = useStore((s) => s.refreshRepo);

  useEffect(() => {
    let alive = true;
    window.api.git.call('commitFiles', root, { sha }).then((result) => {
      if (alive && result.ok) setFiles((result.value as never) ?? (result as { files?: never }).files ?? []);
    });
    return () => {
      alive = false;
    };
  }, [root, sha]);

  return (
    <div className="git-detail">
      <div className="git-detail-head">
        <span className="git-sha">{sha.slice(0, 7)}</span>
        <span style={{ flex: 1 }} />
        <button className="ghost-btn" onClick={() => gitDo(root, 'checkout', { ref: sha }, 'Checking out')}>
          Check out
        </button>
        <button className="ghost-btn" onClick={() => gitDo(root, 'revert', { sha }, 'Reverting')}>
          Revert
        </button>
        <button
          className="ghost-btn"
          onClick={() => {
            navigator.clipboard?.writeText(sha);
            refreshRepo(root, 'status');
          }}
        >
          Copy SHA
        </button>
      </div>
      <div className="git-detail-files">
        {files.map((file) => (
          <div key={file.path} className="git-row">
            <span className="git-file-name" title={file.path}>{file.path}</span>
            <span className="git-numstat">
              {file.added ? <i className="is-add">+{file.added}</i> : null}
              {file.removed ? <i className="is-del">−{file.removed}</i> : null}
            </span>
          </div>
        ))}
        {!files.length && <p className="files-note">Reading…</p>}
      </div>
    </div>
  );
}

// --- Branches --------------------------------------------------------------

function Branches({ panelId }: { panelId: string }) {
  const panel = useStore((s) => asFilePanel(s.panels[panelId]) ?? null);
  const root = panel?.gitRoot ?? '';
  const repo = useStore((s) => (root ? s.repos[root] : undefined));
  const patch = useStore((s) => s.patchPanel);
  const gitDo = useStore((s) => s.gitDo);
  const refreshRepo = useStore((s) => s.refreshRepo);

  useEffect(() => {
    if (root && repo && !repo.local.length && !repo.loading) refreshRepo(root, 'refs');
  }, [root, repo, refreshRepo]);

  if (!panel || !root) return null;
  const current = repo?.current ?? null;
  const picked: GitBranch | null =
    repo?.local.find((branch) => branch.name === panel.selectedBranch) ?? null;

  return (
    <div className="git-branches">
      <div className="git-reflist">
        <NewBranch root={root} from={current} />
        <div className="git-caption">Local · {repo?.local.length ?? 0}</div>
        {repo?.local.map((branch) => (
          <div
            key={branch.name}
            className={`git-row${branch.name === panel.selectedBranch ? ' is-selected' : ''}`}
            onClick={() => patch(panelId, { selectedBranch: branch.name })}
          >
            <span className="git-tick">{branch.name === current ? '✓' : ''}</span>
            <span className="git-file-name">{branch.name}</span>
            {branch.ahead > 0 && <span className="git-ahead">↑{branch.ahead}</span>}
            {branch.behind > 0 && <span className="git-behind">↓{branch.behind}</span>}
            {branch.gone && <span className="git-gone">gone</span>}
            {!branch.upstream && <span className="git-gone">no remote</span>}
          </div>
        ))}

        <div className="git-caption">Remote · {repo?.remote.length ?? 0}</div>
        {repo?.remote.map((branch) => {
          // `origin/fix/x` becomes the local `fix/x`; a local branch of that name
          // already existing means there is nothing to bring across.
          const local = branch.name.replace(/^[^/]+\//, '');
          const haveIt = repo?.local.some((entry) => entry.name === local);
          return (
            <div key={branch.name} className="git-row is-quiet">
              <span className="git-tick" />
              <span className="git-file-name">{branch.name}</span>
              {!haveIt && (
                <button
                  className="link-btn"
                  title={`Check it out as ${local}, tracking ${branch.name}`}
                  onClick={() =>
                    gitDo(root, 'trackRemote', { remote: branch.name, local }, `Checking out ${local}`)
                  }
                >
                  Check out
                </button>
              )}
            </div>
          );
        })}

        {(repo?.tags.length ?? 0) > 0 && <div className="git-caption">Tags · {repo?.tags.length}</div>}
        {repo?.tags.slice(0, 20).map((tag) => (
          <div key={tag.name} className="git-row is-quiet">
            <span className="git-tick" />
            <span className="git-file-name" style={{ color: '#e0af68' }}>{tag.name}</span>
          </div>
        ))}

        {(repo?.stashes.length ?? 0) > 0 && <div className="git-caption">Stashes · {repo?.stashes.length}</div>}
        {repo?.stashes.map((stash) => (
          <div key={stash.ref} className="git-row is-quiet">
            <span className="git-tick" />
            <span className="git-file-name">{stash.subject}</span>
            <button className="link-btn" onClick={() => gitDo(root, 'stashPop', { ref: stash.ref }, 'Restoring')}>
              Pop
            </button>
          </div>
        ))}
      </div>

      <div className="git-branch-detail">
        {!picked ? (
          <p className="files-note">Pick a branch.</p>
        ) : (
          <>
            <div className="git-branch-title">{picked.name}</div>
            <div className="form-hint">
              {picked.upstream ? `tracks ${picked.upstream}` : 'no upstream'}
            </div>
            <div className="git-standings">
              <div>
                <strong className="is-ahead">{picked.ahead}</strong>
                <span>commits it has that its remote does not</span>
              </div>
              <div>
                <strong className="is-behind">{picked.behind}</strong>
                <span>commits its remote has that it does not</span>
              </div>
            </div>
            <div className="git-branch-actions">
              <button
                className="primary-btn"
                disabled={picked.name === current}
                onClick={() => gitDo(root, 'checkout', { ref: picked.name }, `Checking out ${picked.name}`)}
              >
                Check out
              </button>
              {/* Both sides named. A bare "Merge" is the one everyone gets backwards. */}
              <button
                className="ghost-btn"
                disabled={picked.name === current}
                onClick={() => gitDo(root, 'merge', { ref: picked.name }, `Merging ${picked.name} into ${current}`)}
              >
                Merge into {current}
              </button>
              <button
                className="ghost-btn"
                disabled={picked.name === current}
                onClick={() => gitDo(root, 'rebase', { ref: picked.name }, `Rebasing ${current} onto ${picked.name}`)}
              >
                Rebase {current} onto it
              </button>
              <button
                className="ghost-btn"
                onClick={() => {
                  const next = window.prompt(`Rename ${picked.name} to`, picked.name);
                  if (next && next !== picked.name) {
                    gitDo(root, 'renameBranch', { from: picked.name, to: next }, `Renaming ${picked.name}`);
                  }
                }}
              >
                Rename
              </button>
              <button
                className="ghost-btn is-danger"
                disabled={picked.name === current}
                onClick={() => gitDo(root, 'deleteBranch', { name: picked.name }, `Deleting ${picked.name}`)}
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
