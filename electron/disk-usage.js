'use strict';

/**
 * How big things on disk are, asked of a worker and remembered.
 *
 * Measuring is the expensive half of housekeeping: 300 GB of worktrees is
 * minutes of walking, and nobody opens a panel to watch a spinner for minutes.
 * So two rules. The walk happens on a worker thread, never here, and the panel
 * is told each number as it lands. And every number is kept, with the mtime of
 * what it measured and when, so the next look is answered from memory unless
 * the directory changed or the answer is older than `ttl`.
 *
 * A directory's mtime moves when an entry is added or removed directly inside
 * it, not deeper down, so it is a hint rather than proof. That is why the
 * `ttl` exists: a cache that was measured an hour ago is measured again, mtime
 * or not. Between the two, a panel reopened a minute later costs nothing and a
 * cache that grew by a gigabyte overnight is seen in the morning.
 */

const path = require('node:path');
const fs = require('node:fs');

const MINUTE = 60_000;

/** Where the worker's file is: beside this one, and in a packaged app in the unpacked folder, since a Worker cannot be read out of an asar. */
function workerPath(dir = __dirname, sep = path.sep) {
  return path.join(dir, 'disk-usage-worker.js').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

class DiskUsage {
  /**
   * @param {object} [options]
   * @param {object} [options.store] something with `sizes()` and `rememberSize(path, row)` — the database table, or nothing
   * @param {number} [options.ttl] how long a measurement is trusted without re-walking
   * @param {() => number} [options.now]
   */
  constructor({ store = null, ttl = 60 * MINUTE, now = () => Date.now(), workerFile = workerPath() } = {}) {
    this.store = store;
    this.ttl = ttl;
    this.now = now;
    this.workerFile = workerFile;
    /** @type {Map<string, {bytes:number, files:number, mtime:number, measuredAt:number}>} */
    this.cache = new Map();
    this.worker = null;
    this.asking = new Map();
    this.askId = 0;
    if (store) {
      try {
        for (const row of store.sizes()) this.cache.set(row.path, row);
      } catch {
        /* a store that cannot answer starts empty */
      }
    }
  }

  /** What is known about a path right now, stale or not; null when it was never measured. */
  known(target) {
    return this.cache.get(target) ?? null;
  }

  /** Whether the kept number still holds: the directory's mtime is unchanged and the number is young enough. */
  fresh(target) {
    const kept = this.cache.get(target);
    if (!kept) return false;
    if (this.now() - kept.measuredAt > this.ttl) return false;
    try {
      return Math.floor(fs.statSync(target).mtimeMs) === kept.mtime;
    } catch {
      return false;
    }
  }

  /** Forget a path that was removed, so a panel does not keep showing it. */
  forget(target) {
    this.cache.delete(target);
    try {
      this.store?.forgetSize?.(target);
    } catch {
      /* best effort */
    }
  }

  /** Drop remembered sizes of paths that no longer exist, so the table does not keep every folder ever measured. Returns how many. */
  pruneMissing() {
    let gone = 0;
    for (const target of [...this.cache.keys()]) {
      if (fs.existsSync(target)) continue;
      this.forget(target);
      gone += 1;
    }
    return gone;
  }

  /**
   * Sizes for many paths. Fresh answers come straight back; the rest are
   * walked by the worker, and `onEach` hears every one as it lands so a
   * caller can show progress. Resolves to a map of path → measurement.
   */
  async measure(paths, { onEach = null, force = false } = {}) {
    const out = new Map();
    const pending = [];
    for (const target of new Set(paths)) {
      if (!force && this.fresh(target)) {
        out.set(target, this.cache.get(target));
        onEach?.(target, out.get(target));
      } else pending.push(target);
    }
    if (!pending.length) return out;
    await this.#ask(pending, (row) => {
      if (row.partial) {
        // A running total, for the eye only: nothing is remembered until the walk ends.
        onEach?.(row.path, { bytes: row.bytes, files: row.files, partial: true });
        return;
      }
      const kept = { bytes: row.bytes, files: row.files, mtime: row.mtime, measuredAt: this.now() };
      this.cache.set(row.path, kept);
      try {
        this.store?.rememberSize?.(row.path, kept);
      } catch {
        /* the number is still good for this run */
      }
      out.set(row.path, kept);
      onEach?.(row.path, kept);
    });
    return out;
  }

  #ask(paths, onRow) {
    return new Promise((resolve, reject) => {
      let worker = this.worker;
      if (!worker) {
        try {
          const { Worker } = require('node:worker_threads');
          worker = new Worker(this.workerFile);
        } catch (error) {
          reject(error);
          return;
        }
        worker.unref();
        worker.on('message', (message) => {
          const entry = this.asking.get(message.id);
          if (!entry) return;
          if (message.done) {
            this.asking.delete(message.id);
            entry.resolve();
          } else entry.onRow(message);
        });
        const lost = (error) => {
          if (this.worker !== worker) return;
          this.worker = null;
          for (const [id, entry] of this.asking) {
            this.asking.delete(id);
            entry.reject(new Error(String(error?.message ?? 'The measuring thread stopped')));
          }
        };
        worker.on('error', lost);
        worker.on('exit', () => lost(new Error('The measuring thread stopped')));
        this.worker = worker;
      }
      this.askId += 1;
      const id = this.askId;
      this.asking.set(id, { resolve, reject, onRow });
      try {
        worker.postMessage({ id, paths });
      } catch (error) {
        this.asking.delete(id);
        reject(error);
      }
    });
  }

  /** Stop the thread. Whatever was being measured is asked again next time. */
  stop() {
    const worker = this.worker;
    this.worker = null;
    if (worker) worker.terminate().catch(() => {});
    for (const [id, entry] of this.asking) {
      this.asking.delete(id);
      entry.reject(new Error('Measuring was stopped'));
    }
  }
}

/** The size of one file or nothing, for the small things that do not need a thread. */
function fileSize(target) {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}

module.exports = { DiskUsage, workerPath, fileSize, MINUTE };
