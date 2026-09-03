'use strict';

/**
 * Talking to git.
 *
 * Every call is `execFile('git', [...args])` with the arguments as an array and
 * never a shell string. That is not decoration: a branch called
 * `x; rm -rf ~` is a legal branch name, and a file path may contain anything at
 * all. Nothing here is ever concatenated into a command line.
 *
 * It runs in the panel's folder rather than in a session's terminal, so a commit
 * never interrupts what Claude is doing — and equally, a session running `git`
 * itself is invisible to this, which is why the panel refreshes rather than
 * assuming its picture is still true.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');

/** Long enough for a push over a slow link, short enough to not hang a panel. */
const TIMEOUT = 120000;
/** Field and record separators for `--format`: bytes that cannot occur in a ref. */
const FS = '\x1f';
const RS = '\x1e';

function run(root, args, { timeout = TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      // `-c color.ui=false` because a global config may force colour on, and
      // escape codes in the middle of a path make every parser here wrong.
      ['-c', 'color.ui=false', ...args],
      { cwd: root, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout, stderr });
        resolve({
          ok: false,
          stdout: stdout || '',
          // git says useful things on stderr even when it fails; that text is what
          // the panel shows, because our paraphrase of it would be worse.
          error: (stderr || error.message || 'git failed').trim(),
          code: typeof error.code === 'number' ? error.code : null,
        });
      },
    );
  });
}

/** The repository a folder is in, or null. Also what tells a panel to offer Git at all. */
async function repoRoot(dir) {
  const result = await run(dir, ['rev-parse', '--show-toplevel']);
  return result.ok ? result.stdout.trim() || null : null;
}

/**
 * What is changed, and where the branch stands.
 *
 * `--porcelain=v2 -z` is the only status output meant to be parsed: it is
 * explicitly stable, it carries the branch and its ahead/behind counts in the
 * same call, and NUL termination is the only way a path with a newline in it
 * survives the trip.
 */
async function status(root) {
  const result = await run(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  if (!result.ok) return { ok: false, error: result.error };

  const out = {
    ok: true,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    files: [],
  };

  const records = result.stdout.split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const line = records[i];
    if (!line) continue;

    if (line.startsWith('# branch.head ')) {
      const name = line.slice(14);
      if (name === '(detached)') out.detached = true;
      else out.branch = name;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice(18);
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const [ahead, behind] = line.slice(12).split(' ');
      out.ahead = Math.abs(Number(ahead) || 0);
      out.behind = Math.abs(Number(behind) || 0);
      continue;
    }
    if (line.startsWith('#')) continue;

    if (line.startsWith('1 ')) {
      const parts = line.split(' ');
      const xy = parts[1];
      out.files.push(entry(root, parts.slice(8).join(' '), xy));
      continue;
    }
    if (line.startsWith('2 ')) {
      // A rename: the original path is the NEXT NUL-separated record.
      const parts = line.split(' ');
      const xy = parts[1];
      const filePath = parts.slice(9).join(' ');
      const from = records[i + 1] ?? '';
      i += 1;
      out.files.push({ ...entry(root, filePath, xy), from });
      continue;
    }
    if (line.startsWith('u ')) {
      const parts = line.split(' ');
      out.files.push({ ...entry(root, parts.slice(10).join(' '), 'UU'), conflicted: true });
      continue;
    }
    if (line.startsWith('? ')) {
      out.files.push(entry(root, line.slice(2), '??'));
      continue;
    }
  }
  return out;
}

/**
 * One changed file, as the panel needs it.
 *
 * git reports two states — what is staged and what is not — and a file can be
 * both at once. The panel needs to know that a half-staged file is half staged,
 * so both letters are kept rather than flattened into one.
 */
function entry(root, filePath, xy) {
  const index = xy[0];
  const worktree = xy[1];
  const untracked = xy === '??';
  return {
    path: filePath,
    absolute: path.join(root, filePath),
    dir: path.dirname(filePath) === '.' ? '' : path.dirname(filePath),
    name: path.basename(filePath),
    index,
    worktree,
    untracked,
    conflicted: xy === 'UU',
    /** Fully staged: something in the index, nothing left in the working tree. */
    staged: !untracked && index !== '.' && worktree === '.',
    partial: !untracked && index !== '.' && worktree !== '.',
    /** One letter for the row: what happened to this file, from git's own set. */
    letter: untracked ? '?' : xy === 'UU' ? '!' : index !== '.' ? index : worktree,
  };
}

/** Line counts per changed file, for the numbers beside each row. */
async function stat(root, { staged = false } = {}) {
  const args = ['diff', '--numstat', '-z'];
  if (staged) args.push('--cached');
  const result = await run(root, args);
  if (!result.ok) return {};
  const counts = {};
  const parts = result.stdout.split('\0').filter(Boolean);
  for (const part of parts) {
    const [added, removed, file] = part.split('\t');
    if (!file) continue;
    counts[file] = { added: Number(added) || 0, removed: Number(removed) || 0 };
  }
  return counts;
}

/** The commits, newest first, with their parents and refs — the graph's input. */
async function log(root, { limit = 200, all = true } = {}) {
  const format = ['%H', '%P', '%an', '%aI', '%D', '%s'].join(FS) + RS;
  // `--topo-order` is not a preference. In date order a branch's commits can be
  // listed before the merge that brings them in, and the lane layout then opens a
  // lane for the branch and pushes the trunk sideways — the trunk stops being a
  // straight line, which is the one thing the picture is for.
  const args = [
    'log',
    `--format=${format}`,
    `--max-count=${limit}`,
    '--decorate=full',
    '--topo-order',
  ];
  if (all) args.push('--all');
  const result = await run(root, args);
  if (!result.ok) return { ok: false, error: result.error };

  const commits = result.stdout
    .split(RS)
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, author, date, refs, subject] = record.split(FS);
      return {
        sha,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author,
        date,
        subject,
        refs: parseRefs(refs),
      };
    });
  return { ok: true, commits };
}

/** `HEAD -> refs/heads/main, refs/remotes/origin/main, refs/tags/v1` */
function parseRefs(decoration) {
  if (!decoration) return [];
  return decoration
    .split(', ')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const head = raw.startsWith('HEAD -> ');
      const name = head ? raw.slice(8) : raw;
      if (name === 'HEAD') return { kind: 'head', name: 'HEAD', head: true };
      if (name.startsWith('refs/heads/')) return { kind: 'local', name: name.slice(11), head };
      if (name.startsWith('refs/remotes/')) return { kind: 'remote', name: name.slice(13), head: false };
      if (name.startsWith('refs/tags/')) return { kind: 'tag', name: name.slice(10), head: false };
      return { kind: 'other', name, head };
    });
}

/** Every ref worth listing, with how each branch stands against its upstream. */
async function refs(root) {
  const format = ['%(refname)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:iso8601)'].join(FS);
  const result = await run(root, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
  if (!result.ok) return { ok: false, error: result.error };

  const local = [];
  const remote = [];
  const tags = [];
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const [refname, sha, upstream, track, date] = line.split(FS);
    // `[ahead 3, behind 1]`, `[gone]`, or empty.
    const ahead = Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0);
    const behind = Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0);
    const gone = /gone/.test(track ?? '');
    if (refname.startsWith('refs/heads/')) {
      local.push({ name: refname.slice(11), sha, upstream: upstream || null, ahead, behind, gone, date });
    } else if (refname.startsWith('refs/remotes/')) {
      const name = refname.slice(13);
      // `origin/HEAD` is a pointer, not a branch anyone checks out.
      if (!name.endsWith('/HEAD')) remote.push({ name, sha, date });
    } else if (refname.startsWith('refs/tags/')) {
      tags.push({ name: refname.slice(10), sha, date });
    }
  }

  const head = await run(root, ['symbolic-ref', '--short', 'HEAD']);
  const stashes = await run(root, ['stash', 'list', `--format=%gd${FS}%gs${FS}%aI`]);
  return {
    ok: true,
    current: head.ok ? head.stdout.trim() : null,
    local,
    remote,
    tags,
    stashes: stashes.ok
      ? stashes.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [ref, subject, date] = line.split(FS);
            return { ref, subject, date };
          })
      : [],
  };
}

/** How far apart two refs are, for "2 commits you have that main does not". */
async function compare(root, a, b) {
  const result = await run(root, ['rev-list', '--left-right', '--count', `${a}...${b}`]);
  if (!result.ok) return { ahead: 0, behind: 0 };
  const [left, right] = result.stdout.trim().split(/\s+/);
  return { ahead: Number(left) || 0, behind: Number(right) || 0 };
}

/** One commit's files, for the panel beside the graph. */
async function commitFiles(root, sha) {
  const result = await run(root, ['show', '--numstat', '--format=', '-z', sha]);
  if (!result.ok) return { ok: false, error: result.error };
  const files = [];
  for (const part of result.stdout.split('\0').filter(Boolean)) {
    const [added, removed, file] = part.split('\t');
    if (!file) continue;
    files.push({
      path: file,
      name: path.basename(file),
      added: added === '-' ? null : Number(added) || 0,
      removed: removed === '-' ? null : Number(removed) || 0,
    });
  }
  return { ok: true, files };
}

/** The diff of one file — of a commit, of the index, or of the working tree. */
async function diff(root, { sha = null, file = null, staged = false, untracked = false } = {}) {
  // An untracked file is in no diff at all — git has never seen it. Showing it
  // whole, as one long addition, is what someone means by "what changed here".
  if (untracked && file) {
    const read = await run(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
    // `--no-index` exits 1 when the files differ, which is the normal case here.
    return { ok: true, patch: read.stdout || read.error || '' };
  }
  const args = ['diff', '--no-color'];
  if (sha) {
    args.length = 0;
    args.push('show', '--no-color', '--format=', sha);
  } else if (staged) {
    args.push('--cached');
  } else {
    // Against HEAD, so a file that is half staged still shows everything that
    // changed rather than only the half git happens to be asked about.
    args.push('HEAD');
  }
  if (file) args.push('--', file);
  const result = await run(root, args);
  return result.ok ? { ok: true, patch: result.stdout } : { ok: false, error: result.error };
}

// --- the verbs -------------------------------------------------------------

const stage = (root, paths) => run(root, ['add', '--', ...paths]);
/** `reset` leaves the working tree alone; it only takes things back out of the index. */
const unstage = (root, paths) => run(root, ['reset', '--quiet', 'HEAD', '--', ...paths]);

/**
 * Commit what is staged.
 *
 * The message goes through stdin rather than `-m`, so a message containing
 * anything at all — quotes, newlines, a lone backslash — arrives intact.
 */
function commit(root, message, { amend = false } = {}) {
  return new Promise((resolve) => {
    const args = ['-c', 'color.ui=false', 'commit', '--file=-', '--cleanup=strip'];
    if (amend) args.push('--amend');
    const child = execFile(
      'git',
      args,
      { cwd: root, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout });
        resolve({ ok: false, error: (stderr || error.message).trim() });
      },
    );
    child.stdin.end(message, 'utf8');
  });
}

const push = (root, { force = false, setUpstream = null } = {}) =>
  run(root, [
    'push',
    // Never a bare --force: this refuses when the remote moved in a way we have
    // not seen, which is the difference between overwriting your own commit and
    // overwriting somebody else's.
    ...(force ? ['--force-with-lease'] : []),
    ...(setUpstream ? ['--set-upstream', 'origin', setUpstream] : []),
  ]);

const pull = (root, { rebase = false } = {}) => run(root, ['pull', ...(rebase ? ['--rebase'] : ['--ff'])]);
const fetch = (root) => run(root, ['fetch', '--prune']);
const checkout = (root, ref) => run(root, ['checkout', ref]);
const createBranch = (root, name, from) => run(root, ['checkout', '-b', name, ...(from ? [from] : [])]);
const deleteBranch = (root, name, { force = false } = {}) => run(root, ['branch', force ? '-D' : '-d', name]);
const renameBranch = (root, from, to) => run(root, ['branch', '-m', from, to]);
/**
 * Check out a remote branch as a local one that tracks it. `git checkout <name>`
 * already does this when exactly one remote has that name, but saying it plainly
 * means it also works when the local name is not the remote's last segment.
 */
const trackRemote = (root, remote, local) =>
  run(root, ['checkout', '-b', local, '--track', remote]);
const merge = (root, ref) => run(root, ['merge', '--no-edit', ref]);
const rebase = (root, ref) => run(root, ['rebase', ref]);
const abortMerge = (root) => run(root, ['merge', '--abort']);
const revertCommit = (root, sha) => run(root, ['revert', '--no-edit', sha]);
const stashPush = (root, message) =>
  run(root, ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])]);
const stashPop = (root, ref) => run(root, ['stash', 'pop', ...(ref ? [ref] : [])]);

module.exports = {
  run,
  repoRoot,
  status,
  stat,
  log,
  refs,
  compare,
  commitFiles,
  diff,
  stage,
  unstage,
  commit,
  push,
  pull,
  fetch,
  checkout,
  createBranch,
  renameBranch,
  trackRemote,
  deleteBranch,
  merge,
  rebase,
  abortMerge,
  revertCommit,
  stashPush,
  stashPop,
  parseRefs,
  entry,
};
