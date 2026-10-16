'use strict';

/**
 * A month of a busy Jenkins in the history must not stop the app while the dashboard is added up.
 *
 * 300 000 builds in a file (as the app keeps them): the big questions are answered by a worker thread with its own
 * read-only handle, the answer is the one the main thread would have given, and the thread that serves the window never
 * waits for more than a moment — measured as the longest delay of its own event loop. Needs `node:sqlite` (Node 22).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';
const { JenkinsMetrics } = sqlite ? require('../electron/jenkins-metrics') : {};

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-16T12:00:00Z');
const ROWS = 300_000;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-scale-'));
  const db = new sqlite.DatabaseSync(path.join(dir, 'history.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  const store = new JenkinsMetrics(db, { now: () => NOW });
  const insert = db.prepare('INSERT INTO jm_build (server, path, number, queued_at, started_at, ended_at, duration, estimated, result, agent, cause, who, stage, stage_checked, seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const results = ['success', 'success', 'success', 'failed', 'unstable', 'aborted'];
  db.exec('BEGIN');
  for (let i = 0; i < ROWS; i += 1) {
    const job = i % 1500;
    const start = NOW - 40 * DAY + Math.floor((i / ROWS) * 40 * DAY);
    const duration = 30_000 + ((i * 7919) % 900_000);
    const result = results[(i * 31) % results.length];
    insert.run('s', `team${job % 30}/job${job}`, Math.floor(i / 1500) + 1, i % 7 === 0 ? start - 5000 : null, start, start + duration, duration, duration, result, `agent${job % 8}`, 'Started by timer', null, result === 'failed' ? `stage${i % 6}` : null, 1, NOW);
  }
  db.exec('COMMIT');
  return { dir, db, store, remove: () => { store.close(); try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('a month of 300 000 builds is added up without stopping the app, and to the same numbers', { skip, timeout: 120_000 }, async () => {
  const f = fixture();
  try {
    const options = { range: '30d', now: NOW };
    const golden = f.store.dashboard('s', options);                       // on this thread, all at once: the answer to match
    const heatmap = f.store.heatmapData('s', null, { from: NOW - 30 * DAY, to: NOW });
    const red = f.store.redJobs('s', null, { limit: 40 });
    const recovered = f.store.recoveriesIn('s', null, NOW - 30 * DAY, NOW);

    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    const [dashboard, map, reds, back] = await Promise.all([
      f.store.offload('dashboard', ['s', options]),
      f.store.offload('heatmapData', ['s', null, { from: NOW - 30 * DAY, to: NOW }]),
      f.store.offload('redJobs', ['s', null, { limit: 40 }]),
      f.store.offload('recoveriesIn', ['s', null, NOW - 30 * DAY, NOW]),
    ]);
    delay.disable();

    assert.deepEqual(dashboard, golden, 'the dashboard is the same, number for number');
    assert.deepEqual(map, heatmap);
    assert.deepEqual(reds, red);
    assert.deepEqual(back, recovered);
    assert.equal(f.store.worker !== null || f.store.workerOff, true);
    assert.equal(f.store.workerOff, false, 'a thread was had');
    // The longest the thread that serves the window waited for anything: well under what a person notices.
    assert.equal(delay.max / 1e6 < 100, true, `the app stopped for ${(delay.max / 1e6).toFixed(0)} ms`);
  } finally { f.remove(); }
});

test('the poller writes while a month is added up, and neither waits for the other', { skip, timeout: 120_000 }, async () => {
  const f = fixture();
  try {
    const asking = f.store.offload('dashboard', ['s', { range: '30d', now: NOW }]);
    let written = 0;
    // Write in short transactions the whole time the thread is reading, as the poller and the walk do.
    while (!(await Promise.race([asking.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]))) {
      f.store.upsertBuild('s', 'live/job', { number: written + 1, status: 'success', timestamp: NOW - 1000, duration: 500 }, NOW);
      written += 1;
    }
    assert.equal(written > 0, true);
    assert.equal((await asking).kpi.finished.count > 0, true);
  } finally { f.remove(); }
});

test('without a file, or when the thread fails, the same question is answered here', { skip }, async () => {
  const memory = new JenkinsMetrics(new sqlite.DatabaseSync(':memory:'), { now: () => NOW });
  memory.upsertBuild('s', 'a', { number: 1, status: 'success', timestamp: NOW - 5000, duration: 1000 }, NOW);
  assert.deepEqual(await memory.offload('dashboard', ['s', { range: '24h', now: NOW }]), memory.dashboard('s', { range: '24h', now: NOW }));
  await assert.rejects(memory.offload('upsertBuild', []), /not a question/);
});

test('in a packaged app the worker is loaded from the unpacked folder', { skip }, () => {
  const { workerPath } = require('../electron/jenkins-metrics');
  const path = require('node:path');
  assert.equal(workerPath(path.join('/Applications/X.app/Contents/Resources/app.asar/electron')), path.join('/Applications/X.app/Contents/Resources/app.asar.unpacked/electron/jenkins-metrics-worker.js'));
  assert.equal(workerPath(path.join('/dev/repo/electron')), path.join('/dev/repo/electron/jenkins-metrics-worker.js'), 'and untouched when not packaged');
});

test('a question the thread is too slow to answer is answered "slow": the thread is stopped and the app does not repeat the work', { skip, timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-slow-'));
  const db = new sqlite.DatabaseSync(path.join(dir, 'history.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  const store = new JenkinsMetrics(db, { now: () => NOW, workerMs: 1 });
  try {
    store.upsertBuild('s', 'a', { number: 1, status: 'success', timestamp: NOW - 5000, duration: 1000 }, NOW);
    let here = 0;
    const error = await store.offload('dashboard', ['s', { range: '24h', now: NOW }], { inline: () => { here += 1; return {}; } }).catch((e) => e);
    assert.equal(error.code, 'slow');
    assert.match(error.message, /too long/);
    assert.equal(here, 0, 'the same question was not asked again on this thread');
    assert.equal(store.worker, null, 'and the thread that was slow is gone');
    assert.equal(store.workerOff, false, 'a slow answer is not a thread that cannot start');
    // The next question gets a thread of its own, and is answered.
    store.workerMs = 30_000;
    const answer = await store.offload('dashboard', ['s', { range: '24h', now: NOW }]);
    assert.equal(answer.kpi.finished.count, 1);
    // The same question asked twice while it is answered once is one question.
    const [x, y] = await Promise.all([store.offload('redJobs', ['s']), store.offload('redJobs', ['s'])]);
    assert.equal(x, y);
  } finally { store.close(); try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); }
});
