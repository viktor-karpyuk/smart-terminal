'use strict';

/**
 * The folders a build leaves behind, and taking them away without losing work.
 *
 * Most of what a worktree weighs is not the code. It is `.angular`, `node_modules`,
 * `target`, `dist` — folders a build writes and the next build writes again. On
 * one machine they were 252 of 290 GB. They are the safest thing housekeeping
 * can remove, with two guards:
 *
 *   - only names on the list are looked for, and before one is removed git is
 *     asked whether it ignores it. A `dist` that is committed is not a cache,
 *     whatever it is called;
 *   - removal is a rename first and a delete second. Renaming `.angular` to
 *     `.angular.trash-1700000000` is one atomic step, after which the build no
 *     longer sees it and the panel can count it as gone. Deleting the renamed
 *     folder can take a while and can be interrupted; `sweep` finishes the job
 *     on the next start.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** Names a build writes and rebuilds. Order is the order they are shown. */
const KNOWN = Object.freeze([
  { name: '.angular', tool: 'Angular' },
  { name: 'node_modules', tool: 'npm' },
  { name: 'target', tool: 'Maven' },
  { name: 'build', tool: 'Gradle' },
  { name: '.gradle', tool: 'Gradle' },
  { name: 'dist', tool: 'bundler' },
  { name: '.next', tool: 'Next.js' },
  { name: '.nuxt', tool: 'Nuxt' },
  { name: '.vite', tool: 'Vite' },
  { name: '.turbo', tool: 'Turborepo' },
  { name: '.parcel-cache', tool: 'Parcel' },
  { name: 'coverage', tool: 'test coverage' },
  { name: '.pytest_cache', tool: 'pytest' },
  { name: '__pycache__', tool: 'Python' },
  { name: '.venv', tool: 'Python' },
  { name: 'out', tool: 'compiler' },
  { name: '.cache', tool: 'tooling' },
]);

const TRASH = /\.trash-\d+$/;

function git(cwd, args, { timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, code: error?.code, stdout: String(stdout ?? '') });
    });
  });
}

/** Whether a folder is a git checkout or worktree — `.git` is a directory in one and a file in the other. */
function isCheckout(dir) {
  try {
    fs.statSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** The known cache folders present directly inside one checkout. */
function findIn(dir) {
  const found = [];
  for (const known of KNOWN) {
    const full = path.join(dir, known.name);
    try {
      if (fs.lstatSync(full).isDirectory()) found.push({ ...known, path: full, root: dir });
    } catch {
      /* not there */
    }
  }
  return found;
}

/**
 * Which of several names git ignores in one checkout, asked in one process.
 *
 * One `check-ignore` per folder is one process per folder; across two hundred
 * worktrees that is a thousand processes to open a panel. Fed through stdin it
 * is one per checkout. The answer is remembered against the mtime of the
 * checkout's `.gitignore`, which is the file that would change it.
 */
const ignoredMemo = new Map();
async function ignoredIn(checkout, names) {
  if (!names.length) return new Set();
  const stamp = `${mtimeOf(path.join(checkout, '.gitignore'))}:${names.join(',')}`;
  const kept = ignoredMemo.get(checkout);
  if (kept && kept.stamp === stamp) return kept.ignored;
  const ignored = await new Promise((resolve) => {
    const child = execFile('git', ['check-ignore', '-z', '--stdin'], { cwd: checkout, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // Exit 1 means "none of them"; anything above is git refusing, and nothing is claimed ignored.
      if (error && error.code !== 1) return resolve(new Set());
      resolve(new Set(String(stdout ?? '').split('\0').filter(Boolean)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(names.join('\0') + '\0');
  });
  ignoredMemo.set(checkout, { stamp, ignored });
  return ignored;
}

function mtimeOf(file) {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

/** Whether git ignores the folder — the proof that it is a cache and not something committed under a cache's name. */
async function ignoredByGit(folder) {
  const dir = path.dirname(folder);
  const answer = await git(dir, ['check-ignore', '-q', '--', path.basename(folder)]);
  // Exit 0: ignored. Exit 1: not ignored. Anything else: not a repository, or git is missing — refuse rather than guess.
  return answer.ok;
}

/**
 * Put one cache folder out of the way, atomically, and delete it in the background.
 * Resolves with the trash path once the rename is done; the deletion continues on its own.
 */
async function discard(folder, { now = Date.now(), confirmIgnored = true, remove = removeLater } = {}) {
  const name = path.basename(folder);
  if (!KNOWN.some((known) => known.name === name)) throw new Error(`${name} is not a build cache this app removes.`);
  let stat;
  try {
    stat = fs.lstatSync(folder);
  } catch {
    return { ok: true, path: folder, gone: true };
  }
  if (stat.isSymbolicLink()) {
    // A link is somebody's arrangement, not a cache. Removing the link loses nothing, but following it could.
    await fsp.unlink(folder);
    return { ok: true, path: folder, link: true };
  }
  if (!stat.isDirectory()) throw new Error(`${name} is not a folder.`);
  if (confirmIgnored && !(await ignoredByGit(folder))) {
    throw new Error(`git does not ignore ${name} here, so it may be committed work. Left alone.`);
  }
  const trash = `${folder}.trash-${now}`;
  await fsp.rename(folder, trash);
  void remove(trash);
  return { ok: true, path: folder, trash };
}

/** Delete a renamed folder. Errors are swallowed: `sweep` will find whatever was left. */
async function removeLater(trash) {
  try {
    await fsp.rm(trash, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* next start */
  }
}

/** The `*.trash-*` folders left under these checkouts by a removal that did not finish. */
function pendingTrash(dirs) {
  const found = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && TRASH.test(entry.name)) found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** Finish removals a previous run started. */
async function sweep(dirs, { remove = removeLater } = {}) {
  const found = pendingTrash(dirs);
  await Promise.all(found.map((one) => remove(one)));
  return found;
}

module.exports = { KNOWN, TRASH, isCheckout, findIn, ignoredByGit, ignoredIn, discard, pendingTrash, sweep, removeLater };
