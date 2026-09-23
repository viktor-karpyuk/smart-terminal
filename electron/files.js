'use strict';

/**
 * Reading and writing the files a session is working in.
 *
 * The app has never touched the working tree before — sessions did, through the
 * shell. So this is deliberately small and deliberately suspicious: it reads
 * directories and text files, and it writes a file back only when the copy on
 * disk is still the one that was read.
 *
 * That last part is the whole point. A Claude session rewrites files constantly,
 * some of them while running on their own, so "save what is in the editor" is not
 * a safe operation on its own. Every write carries the modification time the
 * editor loaded, and a write whose file has moved on is refused rather than
 * applied — the renderer then has something to show the person instead of a
 * silent overwrite of work they never saw.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** Big enough for anything worth editing by hand, small enough to stay instant. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Folders nobody opens a tree to look at. Dimmed, not hidden — see the design. */
const NOISE = new Set(['.git', 'node_modules', '.DS_Store', 'dist', 'release', '.next', '__pycache__']);

/** `.git` is a directory in a checkout and a file in a worktree or submodule. */
function hasGit(dir) {
  try {
    fs.statSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * A file is binary if its first chunk holds a NUL. Crude, and the same rule
 * `grep` uses — good enough to keep an editor from opening a database.
 */
function looksBinary(buffer) {
  const end = Math.min(buffer.length, 8000);
  for (let i = 0; i < end; i += 1) if (buffer[i] === 0) return true;
  return false;
}

async function listDir(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    // A symlink is asked about rather than assumed: a link to a directory should
    // open like one, and a broken link should not stop the whole listing.
    let isDirectory = entry.isDirectory();
    let link = null;
    if (entry.isSymbolicLink()) {
      /*
       * Where it goes, said out loud.
       *
       * Two folders with similar names, one of them a link into somewhere else
       * entirely, is how somebody spends an afternoon looking at a copy that
       * stopped syncing in September. The tree followed links already — it
       * simply never mentioned that it had.
       */
      let target = null;
      try {
        target = await fsp.readlink(path.join(dirPath, entry.name));
      } catch {
        target = null;
      }
      const to = target && !path.isAbsolute(target) ? path.resolve(dirPath, target) : target;
      try {
        isDirectory = (await fsp.stat(path.join(dirPath, entry.name))).isDirectory();
        link = { to, broken: false };
      } catch {
        // A broken link is drawn rather than dropped: a name that is there and
        // points at nothing is the one thing a tree that hides it can never say.
        isDirectory = false;
        link = { to, broken: true };
      }
    }
    const full = path.join(dirPath, entry.name);
    out.push({
      name: entry.name,
      path: full,
      isDirectory,
      link,
      // A folder holding a `.git` is a checkout of its own — a submodule, a
      // sibling repository, a vendored dependency. Saying so is the difference
      // between a tree of folders and a tree that knows what it is looking at.
      repo: isDirectory && hasGit(full),
      noise: NOISE.has(entry.name) || entry.name.startsWith('.'),
    });
  }
  // Folders first, then by name — the order every file tree has used for forty
  // years, and the one a person's eye is already trained on.
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return out;
}

/* ------------------------------------------------------------------------ *
 * Finding something by name, under one folder.
 *
 * Not a grep: this looks at names, which is the question people actually ask a
 * file tree — "where is that pitch deck", not "which file says pitch deck". It
 * walks breadth-first so the shallow answer arrives before the deep one, and it
 * is bounded three ways: how many it looks at, how long it may take, and how
 * many it returns. A search that has to be waited for is a search nobody uses,
 * and one that walks into `node_modules` is a search that never comes back.
 * ------------------------------------------------------------------------ */

/** Never walked into: the folders that are all volume and no answer. */
const NEVER_WALK = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'venv', 'target', 'vendor', '.gradle', '.idea', 'Pods', 'DerivedData']);

/**
 * How well a name answers the query, or -1 for not at all.
 *
 * Every word must appear, which is what makes two words useful — `pitch deck`
 * finds "Kubrik.io pitch deck.html" without also finding every pitch and every
 * deck. The words may be spread across the folders above it, so `erp pitch`
 * works on `KS-ERP/Kubrik.io pitch deck.html`; the ranking then puts matches in
 * the name itself above matches that only the path made.
 */
function scoreName(name, relative, words) {
  const lowerName = name.toLowerCase();
  const lowerPath = relative.toLowerCase();
  for (const word of words) if (!lowerPath.includes(word)) return -1;
  const inName = words.filter((word) => lowerName.includes(word)).length;
  if (inName === 0) return 0;
  const first = words[0];
  if (lowerName === first) return 100;
  const stem = lowerName.replace(/\.[^.]+$/, '');
  if (stem === first) return 95;
  if (lowerName.startsWith(first)) return 80;
  if (inName === words.length) return 60;
  return 20 + inName;
}

/**
 * @param {string} root the folder the panel is showing
 * @param {string} query what was typed
 */
async function findInTree(root, query, { limit = 200, maxEntries = 40000, maxMs = 4000, hidden = false, now = Date.now } = {}) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { ok: true, results: [], scanned: 0, cut: false };

  // Somebody typing a dotted name means it: `.env` is not a search for nothing.
  const wantsHidden = hidden || words.some((word) => word.startsWith('.'));
  const started = now();
  const results = [];
  const queue = [root];
  let scanned = 0;
  let cut = false;

  while (queue.length) {
    if (scanned >= maxEntries || now() - started > maxMs) { cut = true; break; }
    const dir = queue.shift();
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable is not a reason to stop looking everywhere else
    }
    for (const entry of entries) {
      scanned += 1;
      const isHidden = entry.name.startsWith('.');
      if (isHidden && !wantsHidden) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      // A link is not followed while searching: two of them pointing at each
      // other is a walk that never ends, and the link itself is still a result.
      const isDirectory = entry.isDirectory();
      const score = scoreName(entry.name, relative, words);
      if (score >= 0) {
        results.push({
          name: entry.name,
          path: full,
          relative,
          dir: path.dirname(relative) === '.' ? '' : path.dirname(relative),
          isDirectory,
          link: entry.isSymbolicLink(),
          score,
          depth: relative.split(path.sep).length,
        });
      }
      if (isDirectory && !NEVER_WALK.has(entry.name) && !entry.isSymbolicLink()) queue.push(full);
    }
  }

  results.sort((a, b) => b.score - a.score || a.depth - b.depth || a.relative.localeCompare(b.relative, undefined, { numeric: true, sensitivity: 'base' }));
  return { ok: true, results: results.slice(0, limit), scanned, cut: cut || results.length > limit };
}

async function readTextFile(filePath) {
  const stat = await fsp.stat(filePath);
  if (stat.isDirectory()) return { ok: false, error: 'That is a folder.' };
  if (stat.size > MAX_BYTES) {
    return { ok: false, error: `Too big to open here (${Math.round(stat.size / 1024)} KB).`, size: stat.size };
  }
  const buffer = await fsp.readFile(filePath);
  if (looksBinary(buffer)) return { ok: false, error: 'This is a binary file.', binary: true };
  return { ok: true, text: buffer.toString('utf8'), mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * Write a file back, but only over the version the editor loaded.
 *
 * `expectedMtimeMs` is what `readTextFile` handed out. If the file on disk has a
 * different one, something else wrote it in the meantime — almost always a
 * session — and the write is refused with the current contents so the caller can
 * show both. `force` is the answer to that question, never the default.
 */
async function writeTextFile(filePath, text, { expectedMtimeMs = null, force = false } = {}) {
  if (expectedMtimeMs !== null && !force) {
    let current = null;
    try {
      current = await fsp.stat(filePath);
    } catch {
      current = null; // it was deleted; writing it back is a create, which is fine
    }
    if (current && Math.abs(current.mtimeMs - expectedMtimeMs) > 1) {
      const buffer = await fsp.readFile(filePath);
      return {
        ok: false,
        conflict: true,
        mtimeMs: current.mtimeMs,
        text: looksBinary(buffer) ? null : buffer.toString('utf8'),
      };
    }
  }
  await fsp.writeFile(filePath, text, 'utf8');
  const after = await fsp.stat(filePath);
  return { ok: true, mtimeMs: after.mtimeMs, size: after.size };
}

/**
 * Notices when a file the editor has open changes underneath it.
 *
 * Polled rather than watched. `fs.watch` on macOS misses writes and doubles
 * others depending on how the writer saved, and the app already leans on polling
 * for the working directory of every session — one more small interval is
 * cheaper than a class of bug that only shows up on someone else's machine.
 */
class FileWatcher {
  /** @param {(changes: Array<{path: string, mtimeMs: number, gone?: boolean}>) => void} emit */
  constructor(emit, intervalMs = 1500) {
    this.emit = emit;
    this.intervalMs = intervalMs;
    /** path -> last mtime we told anyone about */
    this.watched = new Map();
    this.timer = null;
  }

  watch(filePath, mtimeMs) {
    this.watched.set(filePath, mtimeMs);
    this.#ensureRunning();
  }

  forget(filePath) {
    this.watched.delete(filePath);
    if (!this.watched.size) this.stop();
  }

  #ensureRunning() {
    if (this.timer) return;
    this.timer = setInterval(() => this.#tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  #tick() {
    const changes = [];
    for (const [filePath, known] of this.watched) {
      let stat = null;
      try {
        stat = fs.statSync(filePath);
      } catch {
        changes.push({ path: filePath, mtimeMs: 0, gone: true });
        this.watched.set(filePath, 0);
        continue;
      }
      if (Math.abs(stat.mtimeMs - known) <= 1) continue;
      this.watched.set(filePath, stat.mtimeMs);
      // A change the app made itself still reports: the renderer knows which
      // saves were its own and is the only thing that can tell them apart.
      changes.push({ path: filePath, mtimeMs: stat.mtimeMs });
    }
    if (changes.length) this.emit(changes);
  }
}

/**
 * An image from the clipboard, put somewhere Claude can read it.
 *
 * A terminal cannot carry a picture: the thing on the other end of the pty is a
 * program reading bytes, and ⌘V of an image has nothing to type. What Claude
 * Code *can* read is a path — so the image is written down and the path is
 * pasted, which is the same gesture with one step in between that nobody has to
 * think about.
 *
 * The name carries the time rather than a random id so the folder reads as a
 * history, and the extension comes from what the clipboard said it was rather
 * than from sniffing the bytes: the clipboard is the one that knows.
 */
const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg',
};

function imageExtension(type) {
  return IMAGE_TYPES[String(type ?? '').toLowerCase().trim()] ?? null;
}

/** `pasted-2026-09-09T04-17-42-087Z.png` — sortable, and says when. */
function pastedImageName(type, at = Date.now()) {
  const extension = imageExtension(type);
  if (!extension) return null;
  return `pasted-${new Date(at).toISOString().replace(/[:.]/g, '-')}${extension}`;
}

async function savePastedImage(dir, bytes, type, at = Date.now()) {
  const name = pastedImageName(type, at);
  if (!name) return { ok: false, error: `The clipboard holds ${type || 'something'}, which is not an image.` };
  const body = Buffer.from(bytes ?? []);
  if (!body.length) return { ok: false, error: 'The clipboard image was empty.' };
  try {
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await fsp.writeFile(file, body);
    return { ok: true, file, bytes: body.length };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Throw away the ones nobody is going to look at again.
 *
 * Every paste leaves a file behind, and a folder that only grows is a folder
 * somebody finds in a year wondering what it is. A week is longer than any
 * conversation that referred to one.
 */
async function forgetOldPastes(dir, { days = 7, now = Date.now() } = {}) {
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  let gone = 0;
  for (const name of names) {
    if (!name.startsWith('pasted-')) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fsp.stat(file);
      if (now - stat.mtimeMs < days * 24 * 60 * 60 * 1000) continue;
      await fsp.unlink(file);
      gone += 1;
    } catch {
      /* it went by itself, or is not ours to remove */
    }
  }
  return gone;
}

/* ------------------------------------------------------------------------ *
 * Changing the tree: rename, move, create, duplicate.
 *
 * The rules are few and each is a thing that has bitten somebody: nothing is
 * overwritten, ever — a rename onto an existing name is refused rather than
 * replacing what was there; a folder is never moved into itself; a name is a
 * name and not a path. Deleting is not here: it goes to the Trash, which is
 * Electron's `shell.trashItem` in the main process, so it can be undone.
 * ------------------------------------------------------------------------ */

/** What a name may not be. Null when it is fine. The renderer has the same rules; this side is the one that counts. */
function nameProblem(name) {
  const text = String(name ?? '');
  if (!text.trim()) return 'A name is needed.';
  if (text !== text.trim()) return 'A name cannot start or end with a space.';
  if (text === '.' || text === '..') return 'That is not a name.';
  if (/[/\\]/.test(text)) return 'A name cannot contain a slash.';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) return 'A name cannot contain control characters.';
  if (/[:]/.test(text)) return 'A name cannot contain a colon.';
  if (Buffer.byteLength(text) > 255) return 'That name is too long.';
  return null;
}

function mustBeAbsolute(value, what) {
  const text = String(value ?? '');
  if (!path.isAbsolute(text)) throw new Error(`${what} must be a full path`);
  return path.resolve(text);
}

async function exists(file) {
  try {
    await fsp.lstat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * `from` becomes `to`. Same folder or another one; a file or a folder.
 *
 * Across file systems `rename` fails with EXDEV, and the move is done the long
 * way: copied, then removed — in that order, so a copy that fails leaves the
 * original where it was.
 */
async function renamePath(fromValue, toValue) {
  const from = mustBeAbsolute(fromValue, 'The path to rename');
  const to = mustBeAbsolute(toValue, 'The new path');
  const problem = nameProblem(path.basename(to));
  if (problem) throw new Error(problem);
  if (from === to) return { ok: true, path: to };
  if (to.startsWith(`${from}${path.sep}`)) throw new Error('A folder cannot be moved into itself.');
  if (!(await exists(from))) throw new Error('That is not there any more.');
  if (!(await exists(path.dirname(to)))) throw new Error('The folder to put it in is not there any more.');
  // Case-only renames on a case-insensitive disk are the one time `to` "exists" and the rename is still right.
  if ((await exists(to)) && from.toLowerCase() !== to.toLowerCase()) {
    throw new Error(`There is already something called ${path.basename(to)} there.`);
  }
  try {
    await fsp.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await fsp.rm(from, { recursive: true, force: true });
  }
  return { ok: true, path: to };
}

/** `from` goes into the folder `dir`, under the name it has. */
async function moveInto(fromValue, dirValue) {
  const from = mustBeAbsolute(fromValue, 'The path to move');
  const dir = mustBeAbsolute(dirValue, 'The folder');
  return renamePath(from, path.join(dir, path.basename(from)));
}

/** A new empty file or folder called `name` in `dir`. Refused when the name is taken. */
async function createEntry(dirValue, name, kind) {
  const dir = mustBeAbsolute(dirValue, 'The folder');
  const problem = nameProblem(name);
  if (problem) throw new Error(problem);
  const target = path.join(dir, String(name));
  if (await exists(target)) throw new Error(`There is already something called ${name} there.`);
  if (kind === 'folder') await fsp.mkdir(target);
  else await fsp.writeFile(target, '', { flag: 'wx' });
  return { ok: true, path: target };
}

/** `name copy.ext`, `name copy 2.ext`… — the first that is free. */
async function copyName(dir, name) {
  const dot = name.startsWith('.') ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem} copy${n > 1 ? ` ${n}` : ''}${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new Error('Too many copies already.');
}

/** A copy of a file or folder beside it, named the way Finder names one. */
async function duplicatePath(fileValue) {
  const file = mustBeAbsolute(fileValue, 'The path to duplicate');
  if (!(await exists(file))) throw new Error('That is not there any more.');
  const dir = path.dirname(file);
  const target = path.join(dir, await copyName(dir, path.basename(file)));
  await fsp.cp(file, target, { recursive: true, errorOnExist: true, force: false });
  return { ok: true, path: target };
}

module.exports = {
  listDir,
  findInTree,
  scoreName,
  renamePath,
  moveInto,
  createEntry,
  duplicatePath,
  copyName,
  nameProblem,
  readTextFile,
  writeTextFile,
  FileWatcher,
  looksBinary,
  hasGit,
  savePastedImage,
  pastedImageName,
  imageExtension,
  forgetOldPastes,
  MAX_BYTES,
  NOISE,
};
