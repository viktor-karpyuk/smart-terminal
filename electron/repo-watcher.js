'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Noticing that a working tree has changed.
 *
 * The Git panel used to be a photograph: taken when it opened, and true only
 * until the next thing happened. Everything that happens in this app happens
 * somewhere else too — a session runs `git add`, a build writes a file, a
 * checkout swaps a branch — so a panel that only refreshes when asked is a panel
 * that is usually wrong.
 *
 * Two different things are watched, because they mean different things. A change
 * in the working tree changes the *status*: which files are modified, added,
 * gone. A change inside `.git` changes the repository itself: a commit landed, a
 * branch moved, a merge started — and that invalidates the history and the
 * branch list as well. Telling them apart is what keeps a file being saved from
 * re-reading the whole commit graph.
 */

/** Long enough to swallow a build's worth of writes, short enough to feel live. */
const SETTLE_MS = 400;

/**
 * Directories whose churn is never a change worth reporting.
 *
 * Not a nicety: `npm install` writes tens of thousands of files into
 * `node_modules`, and a watcher that reports each one would run `git status`
 * until the machine gave up.
 */
const IGNORED = new Set(['node_modules', 'dist', 'release', '.next', '__pycache__', '.venv', 'target', 'build', '.turbo']);

/**
 * The parts of `.git` worth waking up for.
 *
 * Git rewrites its own directory constantly — object files, logs, lock files
 * appearing and vanishing for every command. These few are the ones that mean
 * the repository moved: the index (something was staged), HEAD (a commit or a
 * checkout), the refs, and the files that only exist mid-merge or mid-rebase.
 */
const GIT_INTERESTING = /^(index|HEAD|ORIG_HEAD|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|refs[/\\]|packed-refs)/;

function interesting(relative) {
  if (!relative) return null;
  const parts = relative.split(path.sep);
  if (parts[0] === '.git') {
    const inside = parts.slice(1).join('/');
    // A lock file is git working, not git having finished. Waiting for the real
    // file to change is the difference between one refresh and three.
    if (inside.endsWith('.lock')) return null;
    return GIT_INTERESTING.test(inside) ? 'git' : null;
  }
  for (const part of parts) if (IGNORED.has(part)) return null;
  return 'tree';
}

class RepoWatcher {
  /**
   * @param {object} deps
   * @param {(root: string, kind: 'tree' | 'git') => void} deps.emit
   */
  constructor({ emit, settleMs = SETTLE_MS }) {
    this.emit = emit;
    this.settleMs = settleMs;
    /** root -> { watcher, holders, timer, kind } */
    this.watching = new Map();
  }

  /**
   * Start watching, or note one more reason to keep watching.
   *
   * Counted rather than boolean: two panels can be open on the same repository,
   * and the first one closing must not blind the second.
   */
  watch(root) {
    if (!root) return false;
    const existing = this.watching.get(root);
    if (existing) {
      existing.holders += 1;
      return true;
    }

    let watcher;
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, name) => this.#saw(root, name));
    } catch {
      // An unreadable or enormous tree; the panel still works, it just will not
      // refresh by itself. Failing loudly here would be worse than that.
      return false;
    }
    watcher.on('error', () => this.release(root, true));
    this.watching.set(root, { watcher, holders: 1, timer: null, kind: 'tree' });
    return true;
  }

  /** One fewer reason to watch; the last one stops it. */
  release(root, force = false) {
    const entry = this.watching.get(root);
    if (!entry) return;
    entry.holders -= 1;
    if (!force && entry.holders > 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.watcher.close();
    } catch {
      /* already gone */
    }
    this.watching.delete(root);
  }

  stop() {
    for (const root of [...this.watching.keys()]) this.release(root, true);
  }

  /**
   * Something happened. Wait to see whether more is coming.
   *
   * A single `git commit` touches the index, HEAD, the refs and a dozen objects;
   * saving a file in an editor is often two events. Reporting each one would run
   * `git status` several times for one action, so the timer restarts on every
   * event and only the quiet at the end of a burst sends anything.
   */
  #saw(root, name) {
    const kind = interesting(name ?? '');
    if (!kind) return;
    const entry = this.watching.get(root);
    if (!entry) return;

    // The stronger of what has been seen since the last report wins: a commit
    // touches the tree as well, and reporting that as a mere file change would
    // leave the history and the branch list stale.
    if (kind === 'git') entry.kind = 'git';
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const reporting = entry.kind;
      entry.kind = 'tree';
      entry.timer = null;
      this.emit(root, reporting);
    }, this.settleMs);
    entry.timer.unref?.();
  }
}

module.exports = { RepoWatcher, interesting, IGNORED, SETTLE_MS };
