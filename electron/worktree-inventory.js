'use strict';

/**
 * Every worktree of every repository the app knows, with what would have to be
 * true before it could go.
 *
 * `worktree-cleanup.js` answers a narrower question — which worktrees are
 * *finished* and may be offered for removal without asking anything else. This
 * answers the wider one the housekeeping panel asks: what is there, how long
 * has each been idle, and why can this one not be removed. The same git
 * primitives are used for both so the two never disagree about what "merged"
 * or "irreplaceable" means.
 *
 * Idleness is the latest of three signs of life, because any one of them lies
 * on its own: the last commit (a worktree with uncommitted work from yesterday
 * has a commit from a month ago), the mtime of the worktree's `.git` file
 * (moved by checkout and commit, not by editing), and the last time a Smart
 * Terminal session was standing inside it, which the database knows.
 *
 * A repository's worktrees are read with a bounded number of git processes at
 * a time, and each worktree's answer is remembered against its HEAD and the
 * mtime of its `.git` until `ttl` passes. Two hundred worktrees are a few
 * seconds the first time and nothing the second.
 */

const fs = require('node:fs');
const path = require('node:path');
const { WorktreeCleanup, parseWorktrees } = require('./worktree-cleanup');
const caches = require('./build-caches');
const { execFile } = require('node:child_process');

const MINUTE = 60_000;
const TIMEOUT = 20_000;
const BASES = new Set(['main', 'master', 'develop', 'trunk']);

function git(dir, args, { timeout = TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd: dir, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes', LC_ALL: 'C' } }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Whether the repository a worktree's .git file points at is still there. A checkout with a .git directory always is. */
function linkedRepoExists(dir) {
  try {
    const dotGit = path.join(dir, '.git');
    if (fs.statSync(dotGit).isDirectory()) return true;
    const text = fs.readFileSync(dotGit, 'utf8');
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (!m) return false;
    const gitdir = path.isAbsolute(m[1].trim()) ? m[1].trim() : path.join(dir, m[1].trim());
    return fs.existsSync(gitdir);
  } catch {
    return false;
  }
}

/** A path as the filesystem spells it — git prints resolved paths, and on macOS /var is /private/var. */
function real(one) {
  const resolved = path.resolve(one);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Not there (yet, or any more): resolve the nearest ancestor that is, and keep the rest as written.
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(real(parent), path.basename(resolved));
  }
}

/**
 * A name a build writes again: the cache list, a cache already renamed aside,
 * logs, and whatever the person added — a name, or a glob with `*`.
 */
function isRegenerable(name, extra = []) {
  const clean = String(name).replace(/\/$/, '');
  const base = path.posix.basename(clean);
  // Any segment: git lists `.angular/cache` when only the cache inside is ignored, and that is still the cache.
  const segments = clean.split('/').filter(Boolean);
  if (segments.some((segment) => REGENERABLE_NAMES.has(segment) || caches.TRASH.test(segment))) return true;
  if (/\.(log|tsbuildinfo)$/.test(base) || base === '.DS_Store' || base === 'Thumbs.db') return true;
  return extra.some((pattern) => globMatches(pattern, base) || globMatches(pattern, clean));
}

/** The cache list, plus output folders a build writes that the panel does not offer to delete on their own. */
const REGENERABLE_NAMES = new Set([...caches.KNOWN.map((known) => known.name), 'release', '.test-build', '.idea', '.vscode', 'venv', 'tmp', 'temp', '.tmp']);

/** `*` matches anything but a slash; everything else is literal. */
function globMatches(pattern, text) {
  const source = String(pattern)
    .trim()
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return source !== '' && new RegExp(`^${source}$`).test(text);
}

/**
 * The ignored entries of a worktree, top-level ones collapsed, without walking
 * inside them: `ls-files --directory` stops at an ignored folder, where
 * `status --ignored` walks every file in a seventy-gigabyte cache and
 * times out — which was read as "something irreplaceable", and kept the
 * worktree. A failure here is said as such, not as a file.
 */
async function ignoredIn(dir) {
  const out = await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { timeout: 60_000 });
  if (!out.ok) return ['(could not read ignored files)'];
  return out.stdout.split('\0').filter(Boolean).map((name) => name.replace(/\/$/, ''));
}

function mtimeOf(target) {
  try {
    return Math.floor(fs.statSync(target).mtimeMs);
  } catch {
    return null;
  }
}

/** `Promise.all` with at most `limit` in flight. */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const index = next++;
        out[index] = await fn(list[index], index);
      }
    }),
  );
  return out;
}

class WorktreeInventory {
  /**
   * @param {object} deps
   * @param {() => string[]} deps.folders         checkouts and folders to find repositories from (roots' checkouts, live sessions, known repos)
   * @param {() => string[]} [deps.live]           folders live sessions are standing in
   * @param {(dir: string) => number|null} [deps.sessionActivity] when a session was last active inside a folder, or null
   * @param {boolean} [deps.fetch]                 `git fetch --prune` each repository once per `ttl`
   * @param {() => string[]} [deps.regenerable]    extra names or globs a build makes again, beyond the cache list
   * @param {number} [deps.ttl]
   * @param {number} [deps.concurrency]
   * @param {() => number} [deps.now]
   */
  constructor({ folders, live = () => [], sessionActivity = () => null, fetch = true, ttl = 10 * MINUTE, concurrency = 6, now = () => Date.now(), regenerable = () => [] }) {
    this.folders = folders;
    this.regenerable = regenerable;
    this.live = live;
    this.sessionActivity = sessionActivity;
    this.fetch = fetch;
    this.ttl = ttl;
    this.concurrency = concurrency;
    this.now = now;
    this.helper = new WorktreeCleanup({ folders, fetch: false });
    /** path → { stamp, at, row } */
    this.memo = new Map();
    /** root → when it was last fetched */
    this.fetched = new Map();
  }

  /** The main working trees of the repositories the folders belong to. */
  async roots() {
    const folders = [...new Set((this.folders() ?? []).filter(Boolean).map(real))];
    const roots = new Set();
    for (const root of await mapLimit(folders, this.concurrency, (folder) => this.helper.rootOf(folder))) if (root) roots.add(root);
    return [...roots].sort();
  }

  /** Every worktree of every repository, as rows. The main working tree of each repository is listed too, marked `main: true`, and never removable. */
  async list() {
    const live = (this.live() ?? []).filter(Boolean).map(real);
    const roots = await this.roots();
    const perRoot = await mapLimit(roots, 2, (root) => this.listIn(root, live));
    return perRoot.flat();
  }

  async listIn(root, live) {
    if (this.fetch && this.now() - (this.fetched.get(root) ?? 0) > this.ttl) {
      await git(root, ['fetch', '--quiet', '--prune', 'origin'], { timeout: 30_000 });
      this.fetched.set(root, this.now());
    }
    const bases = await this.helper.basesOf(root);
    const list = await git(root, ['worktree', 'list', '--porcelain']);
    if (!list.ok) return [];
    const entries = parseWorktrees(list.stdout);
    return mapLimit(entries, this.concurrency, (entry, index) => this.describe(root, entry, index === 0, bases, live));
  }

  async describe(root, entry, isMain, bases, live) {
    const gitMtime = mtimeOf(path.join(entry.path, '.git'));
    const extra = this.regenerable() ?? [];
    const stamp = `${entry.head}:${gitMtime}:${entry.branch}:${entry.locked}:${entry.prunable}:${extra.join(',')}`;
    const kept = this.memo.get(entry.path);
    const liveInside = live.some((folder) => inside(folder, entry.path));
    const sessionAt = this.sessionActivity(entry.path);
    if (kept && kept.stamp === stamp && this.now() - kept.at < this.ttl) return finish(kept.row, liveInside, sessionAt);

    const row = {
      root,
      repo: path.basename(root),
      path: entry.path,
      label: path.basename(entry.path),
      branch: entry.branch,
      head: entry.head,
      main: isMain,
      detached: entry.detached,
      locked: entry.locked,
      prunable: entry.prunable,
      base: Boolean(entry.branch && BASES.has(entry.branch)),
      /** Its .git file points at a repository folder that is not there: moved or deleted. git can neither read nor remove it. */
      broken: !entry.prunable && fs.existsSync(entry.path) && !linkedRepoExists(entry.path),
      dirty: false,
      /** How many paths git status lists: changed, staged or untracked. */
      dirtyCount: 0,
      irreplaceable: [],
      mergedInto: null,
      upstreamGone: false,
      upstream: null,
      ahead: 0,
      /** Commits on this worktree that no base branch has: the work that would be lost. */
      aheadOfBase: null,
      ownWork: false,
      lastCommitAt: null,
      gitMtime,
    };

    if (!entry.prunable && fs.existsSync(entry.path) && !row.broken) {
      const [status, commit] = await Promise.all([git(entry.path, ['status', '--porcelain']), git(entry.path, ['log', '-1', '--format=%ct'])]);
      row.dirty = !status.ok || Boolean(status.stdout.trim());
      row.dirtyCount = status.ok ? status.stdout.split('\n').filter(Boolean).length : 0;
      row.lastCommitAt = commit.ok && commit.stdout.trim() ? Number(commit.stdout.trim()) * 1000 : null;
      // Ignored files a build cannot make again. A build cache by any name on the list is not one of them:
      // .angular at seventy gigabytes is the thing to remove, not the thing that keeps the worktree.
      if (!isMain) row.irreplaceable = (await ignoredIn(entry.path)).filter((name) => !isRegenerable(name, extra));
      // A detached worktree can still be finished: its commit may already be on a base branch.
      if (entry.detached && !isMain && bases.length) {
        row.mergedInto = await this.helper.mergedInto(root, entry.head, bases);
      }
      if (entry.branch && !isMain && !row.base) {
        const [into, gone, own, track] = await Promise.all([
          this.helper.mergedInto(root, entry.head, bases),
          this.helper.upstreamGone(root, entry.branch),
          this.helper.hasOwnWork(root, entry.branch),
          git(root, ['for-each-ref', '--format=%(upstream:short) %(upstream:track)', `refs/heads/${entry.branch}`]),
        ]);
        row.mergedInto = into && own ? into : null;
        row.upstreamGone = gone;
        row.ownWork = own;
        if (bases.length) {
          const count = await git(root, ['rev-list', '--count', `${bases[0]}..${entry.head}`]);
          row.aheadOfBase = count.ok ? Number(count.stdout.trim()) || 0 : null;
        }
        const [upstream, ...rest] = track.ok ? track.stdout.trim().split(' ') : [''];
        row.upstream = upstream || null;
        const aheadMatch = rest.join(' ').match(/ahead (\d+)/);
        row.ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      }
    }
    this.memo.set(entry.path, { stamp, at: this.now(), row });
    return finish(row, liveInside, sessionAt);
  }

  /**
   * Point broken worktrees back at the repository that lists them: `git worktree
   * repair` rewrites the .git file and the repository's record of it, and touches
   * nothing else. Safe, and the only way such a worktree becomes readable again.
   */
  async repair(paths) {
    const rows = new Map((await this.list()).map((row) => [row.path, row]));
    const results = [];
    for (const target of paths) {
      const row = rows.get(target) ?? rows.get(real(target));
      if (!row) {
        results.push({ path: target, ok: false, error: 'That is not a worktree the app knows; look again.' });
        continue;
      }
      const done = await git(row.root, ['worktree', 'repair', row.path]);
      this.memo.delete(row.path);
      results.push(done.ok ? { path: target, ok: true } : { path: target, ok: false, error: done.stderr.trim().split('\n').pop() || 'git could not repair it' });
    }
    return results;
  }

  /**
   * Remove worktrees by path, each on its own. Never `--force`: git refuses
   * anything that changed since it was looked at. A finished branch is deleted
   * with `-d`, which refuses what is not merged, so the commits of an
   * unfinished one stay on their branch.
   */
  async remove(paths, { onEach = null } = {}) {
    const rows = new Map((await this.list()).map((row) => [row.path, row]));
    const results = [];
    let index = 0;
    for (const target of paths) {
      index += 1;
      onEach?.({ index, total: paths.length, path: target, label: path.basename(target) });
      const row = rows.get(target) ?? rows.get(real(target));
      if (!row) {
        results.push({ path: target, ok: false, error: 'That is not a worktree the app knows; look again.' });
        continue;
      }
      if (row.blockers.length) {
        results.push({ path: target, ok: false, error: row.blockers.join('; ') });
        continue;
      }
      try {
        if (row.prunable) {
          const done = await git(row.root, ['worktree', 'prune']);
          if (!done.ok) throw new Error(done.stderr.trim() || 'git could not prune');
        } else {
          const done = await git(row.root, ['worktree', 'remove', row.path]);
          if (!done.ok) throw new Error(done.stderr.trim().split('\n').pop() || 'git refused');
          let branchKept = false;
          if (row.branch && row.finished) {
            const branch = await git(row.root, ['branch', '-d', row.branch]);
            branchKept = !branch.ok;
          } else branchKept = Boolean(row.branch);
          await git(row.root, ['worktree', 'prune']);
          this.memo.delete(row.path);
          results.push({ path: target, ok: true, branchKept });
          continue;
        }
        this.memo.delete(row.path);
        results.push({ path: target, ok: true });
      } catch (error) {
        results.push({ path: target, ok: false, error: String(error?.message ?? error) });
      }
    }
    return results;
  }
}

/** The parts that change without git changing: who is inside now, and the activity the database knows. */
function finish(row, liveInside, sessionAt) {
  const lastActivityAt = Math.max(row.lastCommitAt ?? 0, row.gitMtime ?? 0, sessionAt ?? 0) || null;
  const finished = Boolean(row.mergedInto || row.upstreamGone);
  const blockers = [];
  if (row.main) blockers.push('the main working tree');
  if (row.broken) blockers.push('its .git points at a repository folder that is gone; repair it first');
  if (row.base) blockers.push(`${row.branch} is a base branch`);
  if (row.locked) blockers.push('locked');
  if (row.detached && !row.prunable && !row.mergedInto) blockers.push('detached HEAD, and its commit is on no base branch');
  if (liveInside) blockers.push('a session is inside it');
  if (row.dirty) blockers.push(row.dirtyCount ? `${row.dirtyCount} file${row.dirtyCount === 1 ? '' : 's'} not committed` : 'changes not committed');
  if (row.irreplaceable.length) blockers.push(`ignored files nothing could rebuild: ${row.irreplaceable.slice(0, 3).join(', ')}${row.irreplaceable.length > 3 ? '…' : ''}`);
  // Only work of its own can be lost by removal: a branch with no commit of its own has nothing to push.
  if (!finished && !row.main && !row.base && !row.prunable && row.branch && row.ownWork) {
    if (!row.upstream) blockers.push('never pushed');
    else if (row.ahead > 0) blockers.push(`${row.ahead} commit${row.ahead === 1 ? '' : 's'} not pushed`);
  }
  const unmerged = row.aheadOfBase ? `${row.aheadOfBase} commit${row.aheadOfBase === 1 ? '' : 's'} not merged` : null;
  const state = row.prunable
    ? 'folder gone'
    : row.broken
      ? 'link broken'
    : row.main
      ? 'main working tree'
      : row.mergedInto
        ? `merged into ${row.mergedInto}`
        : row.upstreamGone
          ? 'branch deleted on origin'
          : row.detached
            ? 'detached'
            : row.dirty
              ? `uncommitted changes${unmerged ? `, ${unmerged}` : ''}`
              : unmerged
                ? unmerged
                : row.ownWork
                  ? 'open'
                  : 'nothing of its own';
  /** The one-word answer to "is the work in it done": done, unmerged, or empty. */
  const work = row.main || row.base ? 'base' : finished ? 'done' : row.dirty || (row.aheadOfBase ?? 0) > 0 ? 'unmerged' : row.ownWork ? 'unknown' : 'empty';
  return { ...row, liveInside, sessionAt, lastActivityAt, finished, blockers, state, work };
}

module.exports = { WorktreeInventory, finish, mapLimit, isRegenerable, globMatches, ignoredIn, linkedRepoExists };
