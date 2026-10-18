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
const { HousekeepingMonitor, levelOf, describe, parseSwapUsage, DAY, HOUR } = require('../electron/housekeeping-monitor');
const { composeBrief } = require('../electron/housekeeping-brief');

const GB = 1024 ** 3;
const made = [];
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function world({ free = 500 * GB, total = 2000 * GB, mem = 8 * GB, load = [1, 1, 1], cores = 8 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hkm-'));
  made.push(dir);
  const db = new sqlite.DatabaseSync(path.join(dir, 'test.db'));
  const store = new HousekeepingStore(db);
  const sys = { statfs: () => ({ free, total }), freemem: () => mem, totalmem: () => 16 * GB, loadavg: () => load, cpus: () => cores, rss: () => 1 * GB, swap: () => ({ total: 4 * GB, used: 1 * GB }) };
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

test('swap is parsed from sysctl, crosses its lines, and the brief says what to close', { skip }, async () => {
  assert.deepEqual(parseSwapUsage('total = 4096.00M  used = 2818.38M  free = 1277.62M  (encrypted)'), { total: 4096 * 1024 ** 2, used: Math.round(2818.38 * 1024 ** 2) });
  assert.deepEqual(parseSwapUsage('garbage'), { total: null, used: null });
  const { monitor, sys, notes } = world();
  sys.swap = () => ({ total: 4 * GB, used: 3.5 * GB });
  const out = await monitor.tickSystem();
  assert.deepEqual(out.conditions.map((c) => [c.metric, c.level]), [['swap.used.pct', 'limit'], ['swap.used.bytes', 'attention']]);
  assert.ok(notes.some((n) => /Swap in use is at its limit/.test(n.title)));
  const brief = composeBrief({
    report: monitor.report(),
    inventory: { totals: { sessions: { bytes: 1, count: 1 }, worktrees: { bytes: 2, count: 1 }, app: { bytes: 3, count: 1 }, all: { reversibleBytes: 4 } }, disk: { free: 5, total: 6 }, items: [{ kind: 'worktree', label: 'app/x', state: '2 commits not merged', bytes: 9, lastActivityAt: null, blockers: ['never pushed'], meta: { work: 'unmerged' } }] },
    processes: [{ pid: 1, bytes: 2 * GB, command: '/Applications/Chrome' }],
    openSessions: 7,
  });
  assert.match(brief, /Swap used: 3\.50 GB of 4\.00 GB \(87\.5%\)/);
  assert.match(brief, /2\.00 GB  pid 1  \/Applications\/Chrome/);
  assert.match(brief, /1 with unmerged work/);
  assert.match(brief, /app\/x: 2 commits not merged; idle unknown; 9 B; blocked: never pushed/);
  assert.match(brief, /## Question/);
  assert.match(composeBrief({ report: null, inventory: null, question: 'Why?' }), /Why\?$/);
});

test('stats: what was given back by week and how the readings moved', { skip }, async () => {
  const { monitor, store, tick, clockNow } = world();
  store.log({ action: 'free', kind: 'build-cache', label: 'a', bytes: 10 * GB, at: clockNow() - 20 * DAY });
  store.log({ action: 'free', kind: 'build-cache', label: 'b', bytes: 5 * GB, at: clockNow() - 2 * DAY });
  store.log({ action: 'remove-worktree', kind: 'worktree', label: 'c', bytes: 1 * GB, at: clockNow() - DAY });
  store.log({ action: 'free', kind: 'build-cache', label: 'refused', bytes: 0, ok: false, at: clockNow() - DAY });
  store.recordReading('disk.used.bytes', 1000 * GB, clockNow() - 10 * DAY);
  store.recordReading('disk.used.bytes', 1200 * GB, clockNow());
  const s = monitor.stats(30);
  assert.equal(s.freed.n, 3);
  assert.equal(s.freed.bytes, 16 * GB);
  assert.deepEqual(s.freed.byAction['remove-worktree'], { n: 1, bytes: 1 * GB });
  assert.equal(s.moved['disk.used.bytes'].from, 1000 * GB);
  assert.equal(s.moved['disk.used.bytes'].to, 1200 * GB);
  assert.equal(s.moved['bucket.app.bytes'], null);
  const last = s.weeks[s.weeks.length - 1];
  assert.equal(last.bytes, 6 * GB, 'this week: the cache and the worktree');
  assert.equal(s.weeks.reduce((a, w) => a + w.bytes, 0), 16 * GB);
  tick(DAY);
});

test('a pageouts counter becomes a rate per minute between two readings', { skip }, async () => {
  const { monitor, sys, tick } = world();
  let count = 1000;
  sys.pageouts = () => count;
  await monitor.tickSystem();
  assert.equal(monitor.latest['swap.pageouts.perMin'], undefined, 'one reading is not a rate');
  tick(60_000);
  count = 1000 + 3000;
  const out = await monitor.tickSystem();
  assert.equal(monitor.latest['swap.pageouts.perMin'].value, 3000);
  assert.ok(out.conditions.some((c) => c.metric === 'swap.pageouts.perMin' && c.level === 'limit'));
});

test('the balance: freed from the log, consumed from how the disk moved, by period, from a daily roll-up that outlives the readings', { skip }, async () => {
  const { monitor, store, sys, tick, clockNow } = world({ free: 500 * GB, total: 1000 * GB });
  // Twenty days ago the disk had 400 GB used; housekeeping freed 50 GB ten days ago; today it is at 500 GB used.
  store.rollup('disk.used.bytes', 400 * GB, clockNow() - 20 * DAY);
  store.rollup('disk.used.bytes', 430 * GB, clockNow() - 10 * DAY);
  store.log({ action: 'free', kind: 'build-cache', label: 'a', bytes: 50 * GB, at: clockNow() - 10 * DAY });
  store.log({ action: 'free', kind: 'build-cache', label: 'b', bytes: 5 * GB, at: clockNow() - 2 * 3600_000 });
  await monitor.tickSystem();
  const b = monitor.balance();
  assert.equal(b.month.freed, 55 * GB);
  assert.equal(b.month.usedDelta, 100 * GB);
  assert.equal(b.month.consumed, 155 * GB, 'the disk grew 100 despite 55 freed: 155 consumed');
  assert.equal(b.week.freed, 5 * GB);
  assert.equal(b.year.freed, 55 * GB);
  assert.equal(b.day.freed, 5 * GB);
  assert.equal(b.day.usedDelta, 0, 'one reading today: no movement yet');
  assert.ok(b.month.covered >= 2);
  // Readings are trimmed after a month; the roll-up is what a year's balance stands on.
  store.recordReading('disk.used.bytes', 1, clockNow() - 40 * DAY);
  store.rollup('disk.used.bytes', 1, clockNow() - 40 * DAY);
  assert.equal(store.trimReadings(), 1);
  assert.equal(store.trimDaily(), 0);
  assert.ok(store.dailyRange('disk.used.bytes', Math.floor(clockNow() / DAY) - 365));
  tick(DAY);
  sys.statfs = () => ({ free: 490 * GB, total: 1000 * GB });
  await monitor.tickSystem();
  assert.equal(monitor.balance().day.usedDelta, 10 * GB, 'the day the disk grew ten');
  assert.ok(monitor.stats().balance.week);
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
