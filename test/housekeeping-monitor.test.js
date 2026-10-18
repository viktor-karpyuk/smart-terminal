'use strict';

/**
 * The health job: readings against lines, one notification per crossing and
 * not again for a day unless it got worse, the person's own lines over the
 * defaults, and a trend that says how many days of disk are left.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';
const { HousekeepingStore } = sqlite ? require('../electron/housekeeping-store') : {};
const { HousekeepingMonitor, levelOf, describe, DAY, HOUR } = require('../electron/housekeeping-monitor');

const GB = 1024 ** 3;
const made = [];
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function world({ free = 500 * GB, total = 2000 * GB, mem = 8 * GB, load = [1, 1, 1], cores = 8 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hkm-'));
  made.push(dir);
  const db = new sqlite.DatabaseSync(path.join(dir, 'test.db'));
  const store = new HousekeepingStore(db);
  const sys = { statfs: () => ({ free, total }), freemem: () => mem, totalmem: () => 16 * GB, loadavg: () => load, cpus: () => cores, rss: () => 1 * GB };
  const notes = [];
  const events = [];
  let clock = Date.UTC(2026, 9, 17, 12);
  const inventory = { totals: { sessions: { bytes: 1 * GB }, worktrees: { bytes: 300 * GB }, app: { bytes: 2 * GB }, all: { reversibleBytes: 250 * GB } }, items: [] };
  const monitor = new HousekeepingMonitor({
    store,
    housekeeping: { inventory: async () => inventory },
    userData: dir,
    openSessions: () => 12,
    notify: (note) => notes.push(note),
    emit: (name, payload) => events.push([name, payload]),
    sys,
    now: () => clock,
  });
  return { monitor, store, sys, notes, events, inventory, tick: (ms) => (clock += ms), clockNow: () => clock };
}

test('levels: which side of the line, in either direction, with a line switched off', () => {
  assert.equal(levelOf(50, { direction: 'below', attention: 15, limit: 8 }), 'fine');
  assert.equal(levelOf(10, { direction: 'below', attention: 15, limit: 8 }), 'attention');
  assert.equal(levelOf(5, { direction: 'below', attention: 15, limit: 8 }), 'limit');
  assert.equal(levelOf(3, { direction: 'above', attention: 1, limit: 2 }), 'limit');
  assert.equal(levelOf(99, { direction: 'above', attention: null, limit: null }), 'fine');
  assert.equal(describe({ label: 'Disk free', value: 6, unit: '%', level: 'limit', direction: 'below', threshold: 8 }), 'Disk free is 6% (limit below 8%)');
});

test('a healthy machine has no conditions and says nothing', { skip }, async () => {
  const { monitor, notes, events } = world();
  const out = await monitor.tickSystem();
  assert.equal(out.status, 'fine');
  assert.deepEqual(out.conditions, []);
  assert.deepEqual(notes, []);
  assert.equal(events[0][0], 'health');
});

test('crossing a line is said once, said again only when worse or a day later, and forgotten when it comes back', { skip }, async () => {
  const { monitor, sys, notes, tick } = world({ free: 100 * GB, total: 1000 * GB });
  let out = await monitor.tickSystem();
  assert.equal(out.status, 'attention');
  assert.deepEqual(out.conditions.map((c) => [c.metric, c.level]), [['disk.free.pct', 'attention']]);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /needs attention/);
  assert.match(notes[0].body, /Disk free is 10%/);

  tick(HOUR);
  await monitor.tickSystem();
  assert.equal(notes.length, 1, 'not again within the day');

  sys.statfs = () => ({ free: 30 * GB, total: 1000 * GB });
  out = await monitor.tickSystem();
  assert.equal(out.status, 'limit');
  assert.equal(notes.length, 3, 'worse: the percentage at its limit, and the bytes line now crossed too');
  assert.ok(notes.slice(1).some((n) => /at its limit/.test(n.title)));

  tick(DAY + 1);
  await monitor.tickSystem();
  assert.equal(notes.length, 5, 'a day later, said again');

  sys.statfs = () => ({ free: 600 * GB, total: 1000 * GB });
  out = await monitor.tickSystem();
  assert.equal(out.status, 'fine');
  sys.statfs = () => ({ free: 100 * GB, total: 1000 * GB });
  await monitor.tickSystem();
  assert.equal(notes.length, 6, 'back to fine and crossed again: said again at once');
});

test('the inventory tick reads the buckets and counts inactive worktrees; budgets apply only when set', { skip }, async () => {
  const { monitor, inventory, clockNow } = world();
  inventory.items = [
    { kind: 'worktree', lastActivityAt: clockNow() - 30 * DAY, meta: { finished: true } },
    { kind: 'worktree', lastActivityAt: clockNow() - DAY, meta: { finished: false } },
    { kind: 'session' },
  ];
  let out = await monitor.tickInventory();
  assert.equal(out.status, 'fine');
  assert.equal(monitor.latest['worktrees.inactive'].value, 1);
  assert.equal(monitor.latest['worktrees.finished'].value, 1);
  assert.equal(monitor.latest['budget.worktrees.bytes'].value, 300 * GB);

  out = monitor.setThreshold('budget.worktrees.bytes', 'limit', 200 * GB);
  assert.deepEqual(out.conditions.map((c) => [c.metric, c.level]), [['budget.worktrees.bytes', 'limit']]);
  assert.equal(monitor.thresholds()['budget.worktrees.bytes'].limit, 200 * GB);
  out = monitor.setThreshold('budget.worktrees.bytes', 'limit', null);
  assert.equal(out.status, 'fine');
  assert.throws(() => monitor.setThreshold('nope', 'limit', 1), /Not a threshold/);
  assert.throws(() => monitor.setThreshold('db.bytes', 'limit', 'lots'), /is a number/);
});

test('the trend is a slope over days, and the disk gets a days-until-full', { skip }, async () => {
  const { monitor, sys, tick } = world({ free: 500 * GB, total: 1000 * GB });
  // Ten GB a day used, for four days, read hourly.
  for (let hour = 0; hour <= 4 * 24; hour++) {
    const used = 500 * GB + (hour / 24) * 10 * GB;
    sys.statfs = () => ({ free: 1000 * GB - used, total: 1000 * GB });
    await monitor.tickSystem();
    tick(HOUR);
  }
  const report = monitor.report();
  const perDay = monitor.slopePerDay('disk.used.bytes');
  assert.ok(Math.abs(perDay - 10 * GB) < 0.2 * GB, `about ten GB a day, got ${perDay / GB}`);
  assert.ok(report.daysUntilFull >= 45 && report.daysUntilFull <= 46, `460 GB left at 10 a day: ${report.daysUntilFull}`);
  assert.ok(Math.abs(report.growthPerWeek['disk.used.bytes'] - 70 * GB) < 1.5 * GB);
  assert.equal(report.growthPerWeek['db.bytes'] === null || typeof report.growthPerWeek['db.bytes'] === 'number', true);
  assert.equal(monitor.slopePerDay('bucket.app.bytes'), null, 'nothing read yet: no guess');
});

test('readings older than a month are trimmed, settings round-trip through JSON', { skip }, () => {
  const { store, clockNow } = world();
  store.recordReading('x', 1, clockNow() - 40 * DAY);
  store.recordReading('x', 2, clockNow());
  assert.equal(store.trimReadings(), 1);
  assert.deepEqual(store.readings('x').map((r) => r.value), [2]);
  store.setSetting('notified', { a: { level: 'limit', at: 1 } });
  assert.deepEqual(store.setting('notified'), { a: { level: 'limit', at: 1 } });
  store.setSetting('db.bytes.limit', null);
  assert.equal(store.setting('db.bytes.limit'), null);
  assert.equal(store.setting('missing'), undefined);
  assert.deepEqual(Object.keys(store.settings()).sort(), ['db.bytes.limit', 'notified']);
});
