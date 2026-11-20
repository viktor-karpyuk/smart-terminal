/**
 * The git worktrees a session worked in, and taking them away with it.
 *
 * Claude makes a worktree per piece of work (`claude --worktree`, or entering
 * one mid-conversation), and deleting the session from history left every one
 * of them behind: a checkout on disk, registered with its repository, that
 * nothing pointed at any more. Deleting a session now removes the worktrees it
 * was in — found from where it started, where it last was, and every folder its
 * conversation says it worked in.
 *
 * Three things are never touched:
 *   - a repository's main checkout, which is not a worktree of anything;
 *   - a worktree another session in history still uses, open or not;
 *   - a worktree with changes nobody committed. `git worktree remove` without
 *     `--force` refuses those, and that refusal is kept and reported rather
 *     than overridden: deleting a history row is not a reason to lose work.
 * The branch a worktree had is left alone too; it holds the commits.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** A transcript bigger than this is only read for its head and tail. */
const TRANSCRIPT_READ_MAX = 16 * 1024 * 1024;

function git(cwd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'color.ui=false', ...args], { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout: String(stdout) });
      resolve({ ok: false, stdout: String(stdout || ''), error: String(stderr || error.message || 'git failed').trim() });
    });
  });
}

/** Every folder a conversation says it was in. */
function cwdsInTranscript(file) {
  const found = new Set();
  if (!file) return found;
  let text = '';
  try {
    const size = fs.statSync(file).size;
    if (size <= TRANSCRIPT_READ_MAX) text = fs.readFileSync(file, 'utf8');
    else {
      // Head and tail: where it started, and where it ended up.
      const fd = fs.openSync(file, 'r');
      try {
        const half = TRANSCRIPT_READ_MAX / 2;
        const head = Buffer.alloc(half);
        const tail = Buffer.alloc(half);
        fs.readSync(fd, head, 0, half, 0);
        fs.readSync(fd, tail, 0, half, size - half);
        text = `${head.toString('utf8')}\n${tail.toString('utf8')}`;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return found;
  }
  const pattern = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    try {
      const cwd = JSON.parse(`"${match[1]}"`);
      if (typeof cwd === 'string' && path.isAbsolute(cwd)) found.add(cwd);
    } catch {
      /* a half-written line */
    }
  }
  return found;
}

/**
 * The linked worktree a folder is inside, with the main checkout that owns it —
 * or null for a folder that is not in one (including a repository's main checkout).
 */
async function worktreeOf(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const probe = await git(dir, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']);
  if (!probe.ok) return null;
  const [gitDir, commonDir, top] = probe.stdout.split('\n').map((line) => line.trim());
  if (!gitDir || !commonDir || !top || path.resolve(gitDir) === path.resolve(commonDir)) return null;
  // The first entry of the list is always the main checkout.
  const list = await git(top, ['worktree', 'list', '--porcelain']);
  const main = list.ok ? (list.stdout.match(/^worktree (.+)$/m)?.[1] ?? null) : null;
  if (!main || path.resolve(main) === path.resolve(top)) return null;
  return { path: path.resolve(top), main };
}

function inside(dir, root) {
  const resolved = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Remove the worktrees these sessions were in.
 *
 * `dirs` is every folder the deleted sessions worked in; `stillUsed` is every
 * folder the sessions that remain worked in. Returns what was removed and what
 * was kept, with why.
 */
async function removeWorktrees({ dirs, stillUsed = [] }) {
  const removed = [];
  const kept = [];
  const seen = new Map();
  for (const dir of dirs) {
    const tree = await worktreeOf(dir);
    if (tree && !seen.has(tree.path)) seen.set(tree.path, tree);
  }

  for (const tree of seen.values()) {
    if (stillUsed.some((dir) => dir && inside(dir, tree.path))) {
      kept.push({ path: tree.path, reason: 'another session still uses it' });
      continue;
    }
    const result = await git(tree.main, ['worktree', 'remove', tree.path]);
    if (result.ok) {
      removed.push(tree.path);
      continue;
    }
    kept.push({
      path: tree.path,
      reason: /modified|untracked|changes/i.test(result.error)
        ? 'it has changes that were not committed'
        : /locked/i.test(result.error)
          ? 'it is locked'
          : result.error.split('\n')[0],
    });
  }

  // Whatever was deleted by hand before this leaves a registration behind; clear those too.
  for (const main of new Set([...seen.values()].map((tree) => tree.main))) await git(main, ['worktree', 'prune']);
  return { removed, kept };
}

module.exports = { removeWorktrees, cwdsInTranscript, worktreeOf };
