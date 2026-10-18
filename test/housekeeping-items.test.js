'use strict';

/**
 * The one shape every removable thing takes, and the arithmetic over it: the
 * totals at the top of the panel, the "older than" filter, the order in which
 * clearing pays.
 */

const test = require('node:test');
const assert = require('node:assert');
const { item, idleDays, olderThan, removable, totals, byWeight, formatBytes, BUCKETS, DAY } = require('../electron/housekeeping-items');

const NOW = Date.UTC(2026, 9, 17, 12);

const sample = () => [
  item({ id: 's1', kind: 'session', label: 'old chat', bytes: 1000, lastActivityAt: NOW - 40 * DAY }),
  item({ id: 's2', kind: 'session', label: 'live chat', bytes: 500, lastActivityAt: NOW - DAY, blockers: ['still running'] }),
  item({ id: 'c1', kind: 'build-cache', label: 'app/.angular', bytes: 70_000, lastActivityAt: NOW - 10 * DAY }),
  item({ id: 'c2', kind: 'build-cache', label: 'app/node_modules', bytes: 70_000, lastActivityAt: NOW - 20 * DAY }),
  item({ id: 'b1', kind: 'install-backup', label: 'backup', bytes: 9000 }),
];

test('an unknown kind is refused, and every known one lands in a bucket', () => {
  assert.throws(() => item({ id: 'x', kind: 'mystery', label: 'x' }), /Unknown housekeeping item kind/);
  for (const one of sample()) assert.ok(BUCKETS.includes(one.bucket), `${one.kind} has a bucket`);
});

test('only what comes back by itself is reversible', () => {
  const { KINDS } = require('../electron/housekeeping-items');
  const reversible = Object.entries(KINDS).filter(([, k]) => k.reversible).map(([name]) => name).sort();
  assert.deepEqual(reversible, ['browser-cache', 'build-cache', 'db-backup', 'install-backup', 'installer', 'pasted', 'trash']);
  for (const name of ['session', 'worktree', 'workshop']) assert.equal(KINDS[name].reversible, false, `${name} is the only copy of something`);
});

test('negative or missing sizes become zero, and empty blockers are dropped', () => {
  const one = item({ id: 'x', kind: 'session', label: 'x', bytes: -5, blockers: ['', null, 'busy'] });
  assert.equal(one.bytes, 0);
  assert.deepEqual(one.blockers, ['busy']);
  assert.equal(one.lastActivityAt, null);
});

test('idle days count whole days, and an item with no date is never "old"', () => {
  const items = sample();
  assert.equal(idleDays(items[0], NOW), 40);
  assert.equal(idleDays(items[4], NOW), null);
  assert.deepEqual(olderThan(items, 30, NOW).map((one) => one.id), ['s1']);
  assert.deepEqual(olderThan(items, 10, NOW).map((one) => one.id), ['s1', 'c1', 'c2']);
});

test('removable leaves out anything with a blocker', () => {
  assert.deepEqual(removable(sample()).map((one) => one.id), ['s1', 'c1', 'c2', 'b1']);
});

test('totals add per bucket and overall, and only unblocked reversible bytes count as freeable', () => {
  const t = totals(sample());
  assert.equal(t.all.bytes, 150_500);
  assert.equal(t.all.count, 5);
  assert.equal(t.all.blocked, 1);
  assert.equal(t.sessions.bytes, 1500);
  assert.equal(t.worktrees.bytes, 140_000);
  assert.equal(t.app.bytes, 9000);
  assert.equal(t.all.reversibleBytes, 149_000);
  assert.equal(t.sessions.reversibleBytes, 0);
});

test('byWeight puts the largest first and breaks ties by the longest idle', () => {
  assert.deepEqual(byWeight(sample(), NOW).map((one) => one.id), ['c2', 'c1', 'b1', 's1', 's2']);
});

test('bytes read the way a person says them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(850 * 1024 * 1024), '850 MB');
  assert.equal(formatBytes(4.9 * 1024 ** 3), '4.90 GB');
  assert.equal(formatBytes(290 * 1024 ** 3), '290 GB');
});
