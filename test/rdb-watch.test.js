'use strict';

/**
 * Watching a server over time.
 *
 * What is held here is that an alert is said for a reason and once: that a
 * lock held for a moment is not one, that a statement is called slower only on
 * enough calls to be an average, that counters which went backwards are a
 * restart and not a miracle, and that something still wrong five minutes later
 * is the same alert and not a second notification.
 */

const test = require('node:test');
const assert = require('node:assert');

const watch = require('../electron/rdb-watch');
const { RdbStore } = require('../electron/rdb-store');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

function server(at, over = {}) {
  return {
    at, sessions: 10, max_connections: 100, active: 1, idle_tx: 0, blocked: 0, longest_active_s: 2, longest_idle_tx_s: 0,
    commits: 0, rollbacks: 0, blks_read: 0, blks_hit: 0, temp_bytes: 0, deadlocks: 0, size: 1024 ** 3, xid_age: 1000, dead: 10, live: 1000, tracked: true, ...over,
  };
}
const reading = (at, over, statements = []) => ({ server: server(at, over), statements });
const rules = (found) => found.map((one) => one.rule).sort();

test('a quiet server says nothing', () => {
  const history = [reading(T0), reading(T0 + 5 * MIN)];
  assert.deepEqual(watch.judge(history, reading(T0 + 10 * MIN)), []);
  assert.deepEqual(watch.judge([], reading(T0)), []);
});

test('a lock is an alert when it is still held at the next reading, and not before', () => {
  assert.deepEqual(rules(watch.judge([reading(T0)], reading(T0 + 5 * MIN, { blocked: 2 }))), []);
  const found = watch.judge([reading(T0, { blocked: 1 })], reading(T0 + 5 * MIN, { blocked: 2 }));
  assert.deepEqual(rules(found), ['blocked']);
  assert.match(found[0].message, /2 sessions have been waiting/);
});

test('each thing that can run out or pile up is said at a point where there is still time', () => {
  const at = T0 + 5 * MIN;
  const one = (over, before = {}) => rules(watch.judge([reading(T0, before)], reading(at, over)));
  assert.deepEqual(one({ longest_active_s: 301 }), ['long_query']);
  assert.deepEqual(one({ longest_active_s: 299 }), []);
  assert.deepEqual(one({ longest_idle_tx_s: 900 }), ['idle_transaction']);
  assert.deepEqual(one({ sessions: 85 }), ['connections']);
  assert.deepEqual(one({ sessions: 84 }), []);
  assert.deepEqual(one({ xid_age: 1_100_000_000 }), ['wraparound']);
  assert.match(watch.judge([], reading(at, { xid_age: 1_100_000_000 }))[0].message, /55% of the way/);
  assert.deepEqual(one({ dead: 300_000, live: 700_000 }), ['dead_rows']);
  // A small table that is all dead rows is nothing: it is the amount that costs.
  assert.deepEqual(one({ dead: 900, live: 100 }), []);
  assert.deepEqual(one({ deadlocks: 3 }, { deadlocks: 1 }), ['deadlocks']);
  // MySQL has no transaction ids to run out of and counts no dead rows.
  assert.deepEqual(one({ xid_age: null, dead: null, live: null }), []);
});

test('reading from disk matters on a busy server and not on a quiet one', () => {
  const at = T0 + 5 * MIN;
  assert.deepEqual(rules(watch.judge([reading(T0)], reading(at, { blks_read: 40_000, blks_hit: 60_000 }))), ['cache']);
  assert.deepEqual(rules(watch.judge([reading(T0)], reading(at, { blks_read: 400, blks_hit: 600 }))), []);
  assert.deepEqual(rules(watch.judge([reading(T0)], reading(at, { blks_read: 1000, blks_hit: 99_000 }))), []);
  // Counters that went backwards were reset: nothing is known about the interval.
  assert.deepEqual(rules(watch.judge([reading(T0, { blks_read: 9e9, blks_hit: 9e9, deadlocks: 50 })], reading(at, { blks_read: 40_000, blks_hit: 60_000, deadlocks: 0 }))), []);
});

test('a statement is called slower on enough calls to be an average, and named by its id', () => {
  const st = (calls, ms, qid = 'q1') => [{ qid, text: 'SELECT * FROM orders WHERE customer_id = $1', calls, ms }];
  // 2 ms a call for an hour, then 9 ms a call.
  const history = [reading(T0, {}, st(0, 0)), reading(T0 + 30 * MIN, {}, st(500, 1000)), reading(T0 + 60 * MIN, {}, st(1000, 2000))];
  const found = watch.judge(history, reading(T0 + 65 * MIN, {}, st(1200, 3800)));
  assert.deepEqual(rules(found), ['slower']);
  assert.equal(found[0].subject, 'q1');
  assert.match(found[0].message, /took 2\.0 ms a call now takes 9\.0 ms: SELECT \* FROM orders/);
  // Twice as slow is weather; three calls are not an average; half a second lost is not worth a notification.
  assert.deepEqual(watch.judge(history, reading(T0 + 65 * MIN, {}, st(1200, 2800))), []);
  assert.deepEqual(watch.judge(history, reading(T0 + 65 * MIN, {}, st(1003, 3500))), []);
  assert.deepEqual(watch.judge(history, reading(T0 + 65 * MIN, {}, st(1050, 2450))), []);
  // The server restarted and its counters began again.
  assert.deepEqual(watch.judge(history, reading(T0 + 65 * MIN, {}, st(40, 900))), []);
  // Too little history to know what is usual.
  assert.deepEqual(watch.judge(history.slice(1), reading(T0 + 65 * MIN, {}, st(1200, 3800))), []);
});

test('growth is carried forward from a day of it', () => {
  const GB = 1024 ** 3;
  const day = 24 * 60 * MIN;
  const history = [reading(T0, { size: 10 * GB }), reading(T0 + day - 5 * MIN, { size: 10.9 * GB })];
  const found = watch.judge(history, reading(T0 + day, { size: 11 * GB }));
  assert.deepEqual(rules(found), ['growth']);
  assert.match(found[0].message, /grew 1\.0 GB in the last day and is 11 GB.*doubles in 11 days/);
  assert.deepEqual(watch.judge(history, reading(T0 + day, { size: 10.1 * GB })), []);
  // An hour of history is not a trend.
  assert.deepEqual(watch.judge([reading(T0 + day - 60 * MIN, { size: 5 * GB })], reading(T0 + day, { size: 11 * GB })), []);
});

test('readings become rates and levels, at most a hundred points, and a spike survives being thinned', () => {
  const few = [server(T0, { commits: 0 }), server(T0 + 5 * MIN, { commits: 3000, interval_ms: 600, blks_read: 10, blks_hit: 90 }), server(T0 + 10 * MIN, { commits: 100 })];
  const points = watch.trend(few);
  assert.equal(points.length, 2);
  assert.equal(points[0].commits, 10);
  assert.equal(points[0].load, 2);
  assert.equal(points[0].cache, 90);
  // Went backwards: a restart, shown as nothing rather than as a negative rate.
  assert.equal(points[1].commits, 0);
  assert.deepEqual(watch.trend([server(T0)]), []);

  const many = [];
  for (let i = 0; i <= 2000; i += 1) many.push(server(T0 + i * 5 * MIN, { commits: i * 300, blocked: i === 777 ? 9 : 0 }));
  const thinned = watch.trend(many);
  assert.equal(thinned.length, watch.TREND_POINTS);
  assert.equal(Math.max(...thinned.map((point) => point.blocked)), 9);
  assert.ok(thinned.every((point) => Math.abs(point.commits - 1) < 1e-9));
});

test('the statements of a window are summed step by step and compared half against half', () => {
  const rows = [];
  for (let i = 0; i <= 12; i += 1) rows.push({ at: T0 + i * 5 * MIN, qid: 'a', calls: i * 100, ms: i <= 6 ? i * 200 : 1200 + (i - 6) * 800 });
  // One that reset half way: the step where it went backwards is lost, the rest is kept.
  rows.push({ at: T0, qid: 'b', calls: 1000, ms: 5000 }, { at: T0 + 5 * MIN, qid: 'b', calls: 1010, ms: 5050 }, { at: T0 + 10 * MIN, qid: 'b', calls: 5, ms: 20 }, { at: T0 + 15 * MIN, qid: 'b', calls: 15, ms: 70 });
  rows.sort((x, y) => x.at - y.at);
  const found = watch.statementTrends(rows, new Map([['a', 'SELECT a'], ['b', 'SELECT b']]), T0 - 1, T0 + 60 * MIN + 1);
  assert.deepEqual(found.map((one) => one.qid), ['a', 'b']);
  const a = found[0];
  assert.deepEqual([a.calls, a.ms, a.text], [1200, 6000, 'SELECT a']);
  assert.equal(a.meanBefore, 2);
  assert.equal(a.meanNow, 8);
  assert.equal(a.change, 4);
  assert.deepEqual([found[1].calls, found[1].ms], [20, 100]);
  assert.deepEqual(watch.statementTrends(rows, new Map(), T0 + 500 * MIN, T0 + 600 * MIN), []);
});

test('what is still wrong is the same alert, what stopped is closed, and what was dismissed stays quiet for a day', { skip }, () => {
  const store = new RdbStore(new sqlite.DatabaseSync(':memory:'), { encrypt: (text) => text, decrypt: (text) => text });
  const id = store.save({ engine: 'postgres', host: 'db', user: 'u', name: 'far' }).id;
  const lock = { rule: 'blocked', subject: '', message: '1 session has been waiting' };
  const slow = { rule: 'slower', subject: 'q1', message: 'A statement got slower' };

  assert.deepEqual(store.judged(id, [lock, slow], T0).map((one) => one.rule), ['blocked', 'slower']);
  assert.equal(store.openAlerts().get(id), 2);
  // Found again: nothing new to say, and the message is brought up to date.
  assert.deepEqual(store.judged(id, [{ ...lock, message: '3 sessions have been waiting' }, slow], T0 + 5 * MIN), []);
  assert.equal(store.alerts(id).find((one) => one.rule === 'blocked').message, '3 sessions have been waiting');
  // The lock went away.
  assert.deepEqual(store.judged(id, [slow], T0 + 10 * MIN), []);
  const lockRow = store.alerts(id).find((one) => one.rule === 'blocked');
  assert.equal(lockRow.closedAt, T0 + 10 * MIN);
  assert.equal(store.openAlerts().get(id), 1);
  // And came back: that is news again.
  assert.deepEqual(store.judged(id, [lock, slow], T0 + 15 * MIN).map((one) => one.rule), ['blocked']);

  // Dismissed, then found again an hour later after going away: not said. A day later: said.
  const open = store.alerts(id).find((one) => one.rule === 'slower' && !one.closedAt);
  store.dismissAlert(id, open.id);
  assert.equal(store.openAlerts().get(id), 1);
  store.judged(id, [lock], T0 + 20 * MIN);
  assert.deepEqual(store.judged(id, [lock, slow], T0 + 80 * MIN), []);
  store.judged(id, [lock], T0 + 85 * MIN);
  assert.deepEqual(store.judged(id, [lock, slow], T0 + 26 * 60 * MIN).map((one) => one.rule), ['slower']);

  // Forgetting the connection takes its readings and alerts with it.
  store.addReading(id, server(T0), [{ qid: 'q1', text: 'SELECT 1', calls: 1, ms: 1 }]);
  assert.equal(store.readings(id, 0, { statements: true })[0].statements[0].text, 'SELECT 1');
  store.remove(id);
  assert.deepEqual([store.readings(id, 0).length, store.alerts(id).length, store.statementTexts(id).size], [0, 0, 0]);
});

test('a watched server is read when it is due, judged against what came before, and said once', { skip }, async () => {
  const { RdbService } = require('../electron/rdb-service');
  let clock = T0;
  let blocked = 0;
  const notes = [];
  const session = {
    engine: 'postgres', txn: 'idle', closed: false,
    all: async (text) => {
      if (/to_regclass/.test(text)) return [{ there: 't' }];
      if (/pg_stat_statements/.test(text)) return [{ qid: '7', text: 'SELECT 1', calls: String((clock - T0) / MIN), ms: '5', rows: '1' }];
      if (/pg_stat_database/.test(text)) return [{ sessions: '4', max_connections: '100', active: '1', idle_tx: '0', blocked: String(blocked), longest_active_s: '1', longest_idle_tx_s: '0', commits: String((clock - T0) / 1000), rollbacks: '0', blks_read: '0', blks_hit: '0', temp_bytes: '0', deadlocks: '0', size: '1000', xid_age: '5', dead: '0', live: '10' }];
      return [];
    },
    run: async () => ({ columns: [], rows: [] }),
    close: async () => {},
  };
  const service = new RdbService({ db: new sqlite.DatabaseSync(':memory:'), secrets: { encrypt: (text) => text, decrypt: (text) => text }, open: async () => session, now: () => clock, notify: (note) => notes.push(note) });
  const id = (await service.call('saveConnection', { connection: { engine: 'postgres', host: 'db', user: 'u', name: 'far' } })).connection.id;

  // Nothing is read until somebody asks for it to be.
  await service.watchTick();
  assert.equal((await service.call('trends', { id })).readings, 0);
  assert.equal((await service.call('watch', { id, on: true })).watching, true);
  assert.equal((await service.call('trends', { id })).readings, 1);
  // Not due yet.
  clock += 2 * MIN;
  await service.watchTick();
  assert.equal((await service.call('trends', { id })).readings, 1);

  blocked = 2;
  clock += 3 * MIN;
  await service.watchTick();
  clock += 5 * MIN;
  await service.watchTick();
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /far: sessions stuck on a lock/);
  clock += 5 * MIN;
  await service.watchTick();
  assert.equal(notes.length, 1, 'still wrong is not news');

  const trends = await service.call('trends', { id, hours: 6 });
  assert.equal(trends.readings, 4);
  assert.equal(trends.points.length, 3);
  assert.equal(trends.points.at(-1).commits, 1);
  assert.equal(trends.alerts.filter((one) => !one.closedAt).length, 1);
  assert.equal((await service.call('overview', {})).connections[0].alerts, 1);
  await service.call('dismissAlert', { id, alert: trends.alerts[0].id });
  assert.equal((await service.call('overview', {})).connections[0].alerts, 0);

  await service.call('watch', { id, on: false });
  clock += 30 * MIN;
  await service.watchTick();
  assert.equal((await service.call('trends', { id, hours: 6 })).readings, 4);
  await service.stop();
});
