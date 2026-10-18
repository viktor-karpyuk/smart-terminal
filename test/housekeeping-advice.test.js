'use strict';

/**
 * The panel's own plan: memory first when the machine swaps, then the disk by
 * what is largest and safest, then the database — each with the action that
 * does it, and nothing proposed that would lose unmerged work.
 */

const test = require('node:test');
const assert = require('node:assert');
const { proposals, shortName } = require('../electron/housekeeping-advice');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12);

const report = (latest, extra = {}) => ({ latest: Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, { value: v, at: NOW }])), conditions: [], daysUntilFull: null, growthPerWeek: {}, ...extra });
const item = (over) => ({ id: over.path ?? 'x', kind: 'build-cache', bucket: 'worktrees', reversible: true, label: 'x', path: '/x', bytes: 0, lastActivityAt: null, state: null, blockers: [], meta: {}, ...over });

test('a swapping machine is told which processes hold the memory, first', () => {
  const out = proposals({
    report: report({ 'swap.used.pct': 70, 'mem.free.bytes': 600 * MB, 'sessions.open': 14, 'app.rss.bytes': 2 * GB, 'swap.pageouts.perMin': 900 }),
    inventory: { items: [], totals: {} },
    processes: [{ pid: 1, bytes: 6 * GB, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, { pid: 2, bytes: 3 * GB, command: 'Docker' }],
    now: NOW,
  });
  assert.equal(out[0].id, 'memory-processes');
  assert.equal(out[0].priority, 'now');
  assert.match(out[0].title, /swapping right now/);
  assert.match(out[0].detail, /Google Chrome \(6\.00 GB\), Docker \(3\.00 GB\)/);
  assert.match(out[0].detail, /900 pages a minute/);
  assert.equal(out[1].id, 'memory-sessions');
  assert.equal(out[1].action.id, 'show-sessions');
  assert.equal(shortName('/Applications/Google Chrome.app'), 'Google Chrome');
});

test('the disk plan: idle caches, finished worktrees, old app files, old conversations — never unmerged work', () => {
  const items = [
    item({ kind: 'worktree', reversible: false, label: 'app/done', path: '/w/done', bytes: 2 * GB, lastActivityAt: NOW - 40 * DAY, meta: { finished: true, work: 'done' } }),
    item({ kind: 'worktree', reversible: false, label: 'app/busy', path: '/w/busy', bytes: 1 * GB, lastActivityAt: NOW - 60 * DAY, meta: { finished: false, work: 'unmerged' }, blockers: ['never pushed'] }),
    item({ kind: 'worktree', reversible: false, label: 'app/fresh', path: '/w/fresh', bytes: 1 * GB, lastActivityAt: NOW - DAY, meta: { finished: false, work: 'unmerged' } }),
    item({ label: 'done/.angular', path: '/w/done/.angular', bytes: 30 * GB, meta: { checkout: '/w/done' } }),
    item({ label: 'busy/node_modules', path: '/w/busy/node_modules', bytes: 5 * GB, meta: { checkout: '/w/busy' } }),
    item({ label: 'fresh/node_modules', path: '/w/fresh/node_modules', bytes: 5 * GB, meta: { checkout: '/w/fresh' } }),
    item({ label: 'committed/dist', path: '/w/done/dist', bytes: 9 * GB, meta: { checkout: '/w/done' }, blockers: ['not ignored by git, so it may be committed work'] }),
    item({ kind: 'install-backup', bucket: 'app', label: 'Smart Terminal.backup-1', path: '/a/b1', bytes: 20 * GB }),
    item({ kind: 'installer', bucket: 'app', label: 'new.dmg', path: '/a/new.dmg', bytes: 130 * MB, state: 'latest' }),
    item({ kind: 'session', bucket: 'sessions', reversible: false, label: 'old chat', path: '/p', bytes: 300 * MB, lastActivityAt: NOW - 100 * DAY, meta: { sessionId: 's1' } }),
    item({ kind: 'session', bucket: 'sessions', reversible: false, label: 'new chat', path: '/p', bytes: 300 * MB, lastActivityAt: NOW - 5 * DAY, meta: { sessionId: 's2' } }),
  ];
  const out = proposals({ report: report({ 'db.wal.bytes': 300 * MB }), inventory: { items, totals: {} }, dbHealth: { bytes: 2 * GB, wasted: 600 * MB }, now: NOW });
  const ids = out.map((one) => one.id);
  // By priority, then by what each gives back; a log under its line is "later", like the old conversations.
  assert.deepEqual(ids, ['caches-inactive', 'app-files', 'worktrees-finished', 'db-reclaim', 'sessions-old', 'db-checkpoint', 'worktrees-unmerged-idle']);

  const caches = out.find((one) => one.id === 'caches-inactive');
  assert.deepEqual(caches.action.ids.sort(), ['/w/busy/node_modules', '/w/done/.angular'], 'idle checkouts only; the fresh one and the committed dist are left');
  assert.equal(caches.bytes, 35 * GB);

  const finished = out.find((one) => one.id === 'worktrees-finished');
  assert.deepEqual(finished.action.ids, ['/w/done']);
  assert.equal(finished.action.danger, true);

  const app = out.find((one) => one.id === 'app-files');
  assert.equal(app.bytes, 20 * GB, 'the newest installer is not offered');

  const old = out.find((one) => one.id === 'sessions-old');
  assert.deepEqual(old.action.ids, ['s1']);

  assert.ok(!out.some((one) => one.action?.ids?.includes('/w/busy')), 'unmerged work is pointed at, never removed');
  assert.equal(out.find((one) => one.id === 'worktrees-unmerged-idle').action.id, 'show-worktrees');
});

test('a disk filling within two weeks goes to the top', () => {
  const out = proposals({ report: report({}, { daysUntilFull: 9, growthPerWeek: { 'disk.used.bytes': 70 * GB } }), inventory: { items: [], totals: {} }, now: NOW });
  assert.equal(out[0].id, 'disk-trend');
  assert.equal(out[0].priority, 'now');
  assert.match(out[0].detail, /70\.0 GB a week/);
});
