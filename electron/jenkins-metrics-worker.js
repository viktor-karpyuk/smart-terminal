'use strict';

/**
 * Where the big questions of the dashboard are answered: a thread of its own, with a read-only handle on the same file.
 *
 * A month of a busy Jenkins is hundreds of thousands of rows, and adding them up is one statement that takes a second
 * or more — a second in which the window of the whole app does not move, because the thread that answers it is the one
 * that is counting. Here it is the worker that counts; the main thread only waits for the answer. The database is in WAL
 * mode, so this reads while the poller writes, and neither waits for the other.
 *
 * It answers only what `JenkinsMetrics` names as safe to ask (`OFFLOADABLE`), and it can write nothing.
 */

const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { JenkinsMetrics, OFFLOADABLE } = require('./jenkins-metrics');

let held = null;
let at = Date.now();

parentPort.on('message', ({ id, file, now, method, args }) => {
  try {
    if (!OFFLOADABLE.has(method)) throw new Error('That is not a question this thread answers');
    at = now;
    if (!held || held.file !== file) {
      try { held?.db.close(); } catch { /* it is being replaced */ }
      const db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000');
      held = { file, db, metrics: new JenkinsMetrics(db, { now: () => at, readOnly: true }) };
    }
    parentPort.postMessage({ id, value: held.metrics[method](...args) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message ?? error).split('\n')[0].slice(0, 300) });
  }
});
