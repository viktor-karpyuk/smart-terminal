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
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = (await fsp.stat(path.join(dirPath, entry.name))).isDirectory();
      } catch {
        continue;
      }
    }
    out.push({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      isDirectory,
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

module.exports = { listDir, readTextFile, writeTextFile, FileWatcher, looksBinary, MAX_BYTES, NOISE };
