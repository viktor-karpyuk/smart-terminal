'use strict';

/**
 * The housekeeping panel's arithmetic, compiled from the renderer and run bare:
 * what the one button takes, what an age filter keeps, how a size that lands
 * folds into the list.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const lib = require(path.join(__dirname, '..', '.test-build', 'lib', 'housekeeping.js'));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 17, 12);
const one = (over) => ({ id: 'x', kind: 'session', bucket: 'sessions', reversible: false, label: 'x', path: null, bytes: 0, lastActivityAt: null, state: null, blockers: [], detail: null, meta: null, ...over });

test('the one button takes the reversible and unblocked, and leaves the newest installer', () => {
  const items = [
    one({ id: 'cache', kind: 'build-cache', bucket: 'worktrees', reversible: true, bytes: 10 }),
    one({ id: 'busy', kind: 'build-cache', bucket: 'worktrees', reversible: true, bytes: 10, blockers: ['a session is working in this checkout'] }),
    one({ id: 'new', kind: 'installer', bucket: 'app', reversible: true, bytes: 5, state: 'latest' }),
    one({ id: 'old', kind: 'installer', bucket: 'app', reversible: true, bytes: 5, state: 'superseded' }),
    one({ id: 'chat', kind: 'session', bytes: 100 }),
  ];
  assert.deepEqual(lib.freeable(items).map((i) => i.id), ['cache', 'old']);
  assert.equal(lib.weigh(lib.freeable(items)), 15);
});

test('the session filter keeps by idle days and weight, hides running ones unless asked, and never passes an unknown age', () => {
  const items = [
    one({ id: 'old', bytes: 500, lastActivityAt: NOW - 45 * DAY }),
    one({ id: 'recent', bytes: 5000, lastActivityAt: NOW - 3 * DAY }),
    one({ id: 'open', bytes: 50, state: 'open', lastActivityAt: NOW - 60 * DAY, blockers: ['still running'] }),
    one({ id: 'undated', bytes: 9000 }),
    one({ id: 'cache', kind: 'build-cache', bucket: 'worktrees', reversible: true, bytes: 1 }),
  ];
  const ids = (filter) => lib.filterSessions(items, filter, NOW).map((i) => i.id);
  assert.deepEqual(ids({ olderThanDays: 30, minBytes: 0, includeOpen: false }), ['old']);
  assert.deepEqual(ids({ olderThanDays: 30, minBytes: 0, includeOpen: true }), ['old', 'open']);
  assert.deepEqual(ids({ olderThanDays: 0, minBytes: 1000, includeOpen: false }), ['recent', 'undated']);
  assert.deepEqual(ids({ olderThanDays: 0, minBytes: 0, includeOpen: false }), ['old', 'recent', 'undated']);
});

test('session filters: search words, account, kind and with-conversation narrow the list; facets list what is there', () => {
  const items = [
    one({ id: 'a', label: 'billing fix', path: '/dev/billing', bytes: 10, lastActivityAt: NOW - DAY, meta: { profile: 'kubrik', sessionKind: 'claude' } }),
    one({ id: 'b', label: 'shell', path: '/dev/erp', bytes: 0, lastActivityAt: NOW - DAY, meta: { profile: 'personal', sessionKind: 'shell' } }),
    one({ id: 'c', label: 'erp refactor', path: '/dev/erp', bytes: 5, lastActivityAt: NOW - 3 * DAY, meta: { profile: 'kubrik', sessionKind: 'claude' } }),
  ];
  const base = { olderThanDays: 0, minBytes: 0, includeOpen: false };
  const ids = (f) => lib.filterSessions(items, { ...base, ...f }, NOW).map((i) => i.id);
  assert.deepEqual(ids({ query: 'erp' }), ['b', 'c']);
  assert.deepEqual(ids({ query: 'erp refactor' }), ['c']);
  assert.deepEqual(ids({ profile: 'personal' }), ['b']);
  assert.deepEqual(ids({ sessionKind: 'claude' }), ['a', 'c']);
  assert.deepEqual(ids({ withConversation: true }), ['a', 'c']);
  assert.deepEqual(lib.sessionFacets(items), { profiles: ['kubrik', 'personal'], kinds: ['claude', 'shell'] });
  const withOpen = [...items, one({ id: 'live', state: 'open', bytes: 1, lastActivityAt: NOW, meta: {} })];
  const ids2 = (f) => lib.filterSessions(withOpen, { ...base, ...f }, NOW).map((i) => i.id);
  assert.deepEqual(ids2({ status: 'running' }), ['live']);
  assert.deepEqual(ids2({ status: 'ended' }), ['a', 'b', 'c']);
  assert.deepEqual(ids2({ status: 'any' }), ['a', 'b', 'c', 'live']);
  assert.deepEqual(ids2({ status: 'any', activeSince: NOW - 2 * DAY }), ['a', 'b', 'live']);
  assert.deepEqual(ids2({ status: 'any', inactiveSince: NOW - 2 * DAY }), ['c']);
});

test('the worktree filter keeps by idle days and finished state', () => {
  const items = [
    one({ id: 'done', kind: 'worktree', bucket: 'worktrees', lastActivityAt: NOW - 40 * DAY, meta: { finished: true } }),
    one({ id: 'fresh', kind: 'worktree', bucket: 'worktrees', lastActivityAt: NOW - DAY, meta: { finished: true } }),
    one({ id: 'old-open', kind: 'worktree', bucket: 'worktrees', lastActivityAt: NOW - 90 * DAY, meta: { finished: false } }),
    one({ id: 'chat' }),
  ];
  const ids = (f) => lib.filterWorktrees(items, f, NOW).map((i) => i.id);
  assert.deepEqual(ids({ olderThanDays: 0, finishedOnly: false }), ['done', 'fresh', 'old-open']);
  assert.deepEqual(ids({ olderThanDays: 14, finishedOnly: false }), ['done', 'old-open']);
  assert.deepEqual(ids({ olderThanDays: 14, finishedOnly: true }), ['done']);
});

test('a metric names its tab, and only real tab names are tabs', () => {
  assert.equal(lib.tabFor('worktrees.inactive'), 'worktrees');
  assert.equal(lib.tabFor('budget.worktrees.bytes'), 'worktrees');
  assert.equal(lib.tabFor('db.wal.bytes'), 'app');
  assert.equal(lib.tabFor('budget.app.bytes'), 'app');
  assert.equal(lib.tabFor('disk.free.pct'), 'health');
  assert.equal(lib.tabFor(undefined), 'health');
  assert.equal(lib.isTab('log'), true);
  assert.equal(lib.isTab('nope'), false);
});

test('the running cap pauses minimized, quiet sessions first and never a visible or busy one', () => {
  const sessions = [
    { id: 'vis', minimized: false, busy: false, lastActivityAt: 1 },
    { id: 'old', minimized: true, busy: false, lastActivityAt: 10 },
    { id: 'busy', minimized: true, busy: true, lastActivityAt: 5 },
    { id: 'new', minimized: true, busy: false, lastActivityAt: 100 },
  ];
  assert.deepEqual(lib.pickToPause(sessions, 1), ['old']);
  assert.deepEqual(lib.pickToPause(sessions, 5), ['old', 'new']);
  assert.deepEqual(lib.pickToPause(sessions, 0), []);
});

test('a size that lands replaces the row without reordering, and an unknown path changes nothing', () => {
  const items = [one({ id: 'a', path: '/a', meta: { sized: false } }), one({ id: 'b', path: '/b', bytes: 3 })];
  const next = lib.withSize(items, '/a', 42);
  assert.notEqual(next, items);
  assert.deepEqual(next.map((i) => [i.id, i.bytes, i.meta?.sized]), [['a', 42, true], ['b', 3, undefined]]);
  assert.equal(lib.withSize(items, '/zzz', 1), items, 'same array back when nothing matched');
  const partial = lib.withSize(items, '/a', 7, true);
  assert.deepEqual([partial[0].bytes, partial[0].meta.sized, partial[0].meta.partial], [7, false, true]);
});

test('ages and sizes read the way a person says them', () => {
  assert.equal(lib.describeIdle(null, NOW), '—');
  assert.equal(lib.describeIdle(NOW - 3600_000, NOW), 'today');
  assert.equal(lib.describeIdle(NOW - DAY, NOW), '1 day');
  assert.equal(lib.describeIdle(NOW - 12 * DAY, NOW), '12 days');
  assert.equal(lib.describeIdle(NOW - 65 * DAY, NOW), '2 months');
  assert.equal(lib.describeIdle(NOW - 400 * DAY, NOW), '1 year');
  assert.equal(lib.formatBytes(290 * 1024 ** 3), '290 GB');
  assert.equal(lib.diskUsedPercent({ free: 25, total: 100 }), 75);
  assert.equal(lib.diskUsedPercent({ free: null, total: 100 }), null);
});
