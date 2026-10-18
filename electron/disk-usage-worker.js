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

/** Add up one tree. Errors on single entries are skipped: a file that vanished mid-walk is not a reason to give up on the rest. */
function measure(root) {
  let bytes = 0;
  let files = 0;
  const stack = [root];
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
    }
  }
  return { bytes, files };
}

if (parentPort) {
  parentPort.on('message', ({ id, paths }) => {
    for (const target of paths) {
      let result;
      try {
        const stat = fs.statSync(target);
        result = stat.isDirectory() ? measure(target) : { bytes: stat.size, files: 1 };
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

module.exports = { measure };
