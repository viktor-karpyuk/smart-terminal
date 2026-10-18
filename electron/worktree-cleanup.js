'use strict';

/**
 * Finding the worktrees a finished task left behind, and taking them away.
 *
 * A task ends when its work is on the base branch. Until then a worktree may be
 * the only copy of something, so every rule here errs toward leaving it:
 *
 *   - a worktree is a candidate only when its branch is *finished* (its commits
 *     are in the base branch, or the branch it was pushed to is gone from origin
 *     — what a squash-merge with "delete branch" leaves), it has no changes of
 *     its own, nothing is locked or detached, and no live session is inside it;
 *   - one that was just created and has no commit of its own is not finished,
 *     though its head is, trivially, "in" the base branch;
 *   - the Code Reviewer's workshops are candidates when their pull request is no
 *     longer open and no fix is waiting to be handed back.
 *
 * Nothing is removed by `scan`. `clean` removes what it is given, one by one,
 * with `git worktree remove` and never `--force`, so git itself refuses
 * anything that has changed since it was looked at.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const TIMEOUT = 20000;
/** Branches nobody finishes: their worktrees are somebody's base, not a task. */
const BASES = new Set(['main', 'master', 'develop', 'trunk']);

function git(dir, args, { timeout = TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd: dir, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** `git worktree list --porcelain` as entries; the first is the main working tree. */
function parseWorktrees(text) {
  const entries = [];
  for (const block of String(text).split(/\n\n+/)) {
    const entry = { path: '', head: '', branch: null, detached: false, locked: false, prunable: false, bare: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice(9);
      else if (line.startsWith('HEAD ')) entry.head = line.slice(5);
      else if (line.startsWith('branch ')) entry.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'detached') entry.detached = true;
      else if (line === 'bare') entry.bare = true;
      else if (line.startsWith('locked')) entry.locked = true;
      else if (line.startsWith('prunable')) entry.prunable = true;
    }
    if (entry.path) entries.push(entry);
  }
  return entries;
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

class WorktreeCleanup {
  /**
   * @param {object} deps
   * @param {() => string[]} deps.folders   folders of live sessions and known repositories: where to look, and what is in use
   * @param {() => Promise<Array<{path: string, label: string, discard: () => Promise<unknown>}>>} [deps.workshops] finished Code Reviewer workshops
   * @param {boolean} [deps.fetch]          bring origin up to date first (default true)
   */
  constructor({ folders, workshops = async () => [], fetch = true }) {
    this.folders = folders;
    this.workshops = workshops;
    this.fetch = fetch;
    /** What the last `scan` offered, by path: `clean` takes only from here, never a path it is handed. */
    this.offered = new Map();
  }

  /** The main working tree of the repository a folder is in, or null. */
  async rootOf(folder) {
    if (!folder || !fs.existsSync(folder)) return null;
    const common = await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common.ok) return null;
    const dir = common.stdout.trim();
    return path.basename(dir) === '.git' ? path.dirname(dir) : null;
  }

  async baseOf(root) {
    const head = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head.ok && head.stdout.trim()) return head.stdout.trim();
    for (const name of ['origin/develop', 'origin/main', 'origin/master']) {
      if ((await git(root, ['rev-parse', '--verify', '--quiet', name])).ok) return name;
    }
    return null;
  }

  /** Whether the branch has a commit of its own, as opposed to having been created and left alone. */
  async hasOwnWork(root, branch) {
    const log = await git(root, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`]);
    return log.ok && log.stdout.split('\n').some((line) => /^(commit|rebase|cherry-pick|merge|pull|am)\b/.test(line));
  }

  /** The upstream of a branch was set and is gone from origin. */
  async upstreamGone(root, branch) {
    const out = await git(root, ['for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`]);
    return out.ok && out.stdout.trim() === '[gone]';
  }

  async candidatesIn(root, live) {
    const base = await this.baseOf(root);
    if (this.fetch) await git(root, ['fetch', '--quiet', '--prune', 'origin'], { timeout: 30000 });
    const list = await git(root, ['worktree', 'list', '--porcelain']);
    if (!list.ok) return [];
    const found = [];
    for (const entry of parseWorktrees(list.stdout).slice(1)) {
      if (entry.bare || entry.locked) continue;
      if (entry.prunable) { found.push({ kind: 'stale', root, path: entry.path, label: path.basename(entry.path), why: 'its folder is gone' }); continue; }
      if (entry.detached || !entry.branch || BASES.has(entry.branch)) continue;
      if (live.some((folder) => inside(folder, entry.path))) continue;
      const status = await git(entry.path, ['status', '--porcelain']);
      if (!status.ok || status.stdout.trim()) continue;
      let why = null;
      if (base && (await git(root, ['merge-base', '--is-ancestor', entry.head, base])).ok && (await this.hasOwnWork(root, entry.branch))) why = `merged into ${base}`;
      else if (await this.upstreamGone(root, entry.branch)) why = 'its branch was deleted on origin';
      if (why) found.push({ kind: 'worktree', root, path: entry.path, branch: entry.branch, label: path.basename(entry.path), why });
    }
    return found;
  }

  /** What could be cleaned up now. Removes nothing. */
  async scan() {
    const folders = [...new Set((this.folders() ?? []).filter(Boolean).map((one) => path.resolve(one)))];
    const roots = new Set();
    for (const folder of folders) {
      const root = await this.rootOf(folder);
      if (root) roots.add(root);
    }
    const found = [];
    for (const root of roots) found.push(...(await this.candidatesIn(root, folders)));
    const seen = new Set(found.map((one) => one.path));
    for (const shop of await this.workshops().catch(() => [])) {
      if (seen.has(shop.path) || !fs.existsSync(shop.path)) continue;
      found.push({ kind: 'workshop', path: shop.path, label: shop.label, why: 'its pull request is no longer open', discard: shop.discard });
    }
    this.offered = new Map(found.map((one) => [one.path, one]));
    return found.map(({ discard, ...rest }) => rest);
  }

  /** Remove what the last scan offered, by path, each on its own: one that git refuses does not stop the rest. */
  async clean(paths) {
    const results = [];
    for (const target of paths) {
      const item = this.offered.get(target);
      if (!item) { results.push({ path: target, ok: false, error: 'That was not offered; scan again.' }); continue; }
      try {
        if (item.kind === 'workshop') {
          await item.discard();
        } else if (item.kind === 'stale') {
          const done = await git(item.root, ['worktree', 'prune']);
          if (!done.ok) throw new Error(done.stderr.trim() || 'git could not prune');
        } else {
          const done = await git(item.root, ['worktree', 'remove', item.path]);
          if (!done.ok) throw new Error(done.stderr.trim().split('\n').pop() || 'git refused');
          await git(item.root, ['branch', '-d', item.branch]);
          await git(item.root, ['worktree', 'prune']);
        }
        this.offered.delete(target);
        results.push({ path: target, ok: true });
      } catch (error) {
        results.push({ path: target, ok: false, error: error.message });
      }
    }
    return results;
  }
}

module.exports = { WorktreeCleanup, parseWorktrees };
