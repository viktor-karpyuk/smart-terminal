'use strict';

/**
 * The thread that walks directories and adds up their files.
 *
 * A tree of build caches is hundreds of thousands of entries, and walking it on
 * the main thread would freeze the window for as long as it took. Here the walk
 * happens on its own thread; the main thread asks for a list of paths and gets
 * one answer per path as each finishes, so a panel can fill in as the numbers
 * arrive rather than wait for the slowest.
 *
 * Symbolic links are counted as the link, never followed: a link out of a
 * worktree into `node_modules` of another would otherwise be counted twice, and a
 * link to `/` would never finish.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

/** How many files between two progress reports: often enough that a number is seen moving, rare enough to cost nothing. */
const PROGRESS_EVERY = 20_000;

/**
 * Add up one tree. Errors on single entries are skipped: a file that vanished
 * mid-walk is not a reason to give up on the rest. `onProgress` hears the
 * running total every `every` files, so a tree of a million entries shows a
 * number growing rather than a dash for a minute.
 */
function measure(root, onProgress = null, every = PROGRESS_EVERY) {
  let bytes = 0;
  let files = 0;
  let nextReport = every;
  const stack = [root];
  const report = () => {
    if (onProgress && files >= nextReport) {
      onProgress({ bytes, files });
      nextReport = files + every;
    }
  };
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          bytes += fs.lstatSync(full).size;
          files += 1;
        } catch {
          /* gone */
        }
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        bytes += fs.statSync(full).size;
        files += 1;
      } catch {
        /* vanished between readdir and stat */
      }
      report();
    }
  }
  return { bytes, files };
}

/**
 * Delete a tree, saying how far it got: bytes and files every `every` files.
 * Files first, then the now-empty directories, deepest first. An entry that
 * will not go is skipped and counted, so one stubborn file does not stop a
 * seventy-gigabyte removal. Symbolic links are unlinked, never followed.
 */
function remove(root, onProgress = null, every = 2000) {
  let bytes = 0;
  let files = 0;
  let failed = 0;
  let nextReport = every;
  const dirs = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    dirs.push(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(full);
        continue;
      }
      try {
        const size = entry.isSymbolicLink() ? 0 : fs.lstatSync(full).size;
        fs.unlinkSync(full);
        bytes += size;
        files += 1;
      } catch {
        failed += 1;
      }
      if (onProgress && files + failed >= nextReport) {
        onProgress({ bytes, files, failed });
        nextReport = files + failed + every;
      }
    }
  }
  for (const dir of dirs.reverse()) {
    try {
      fs.rmdirSync(dir);
    } catch {
      failed += 1;
    }
  }
  return { bytes, files, failed };
}

if (parentPort) {
  parentPort.on('message', ({ id, paths, remove: target }) => {
    if (target) {
      try {
        const result = remove(target, (partial) => parentPort.postMessage({ id, path: target, ...partial, partial: true }));
        parentPort.postMessage({ id, path: target, ...result });
      } catch (error) {
        parentPort.postMessage({ id, path: target, bytes: 0, files: 0, failed: 1, error: String(error?.message ?? error) });
      }
      parentPort.postMessage({ id, done: true });
      return;
    }
    for (const target of paths) {
      let result;
      try {
        const stat = fs.statSync(target);
        result = stat.isDirectory()
          ? measure(target, (partial) => parentPort.postMessage({ id, path: target, ...partial, partial: true }))
          : { bytes: stat.size, files: 1 };
        result.mtime = Math.floor(stat.mtimeMs);
      } catch (error) {
        result = { bytes: 0, files: 0, mtime: 0, error: String(error?.code ?? error?.message ?? error) };
      }
      parentPort.postMessage({ id, path: target, ...result });
    }
    parentPort.postMessage({ id, done: true });
  });
} else if (workerData?.selfTest) {
  // eslint-disable-next-line no-console
  console.log(measure(workerData.selfTest));
}

module.exports = { measure, remove };
