'use strict';

/**
 * The Jenkins dashboard's numbers, and what feeds them.
 *
 * Two halves. The store is tested with rows put in by hand, so that every
 * number can be checked against arithmetic done here: how many failed, how
 * long the slow ones took, what was running at noon. The collector is tested
 * against a Jenkins that is not there, and what is checked is what a person
 * would notice: a build that came and went between two looks, two builds of
 * one job at once, a clock that is five minutes off, a walk of the history
 * that is stopped in the middle, a server that is forgotten while it is read.
 *
 * Needs `node:sqlite` (Node 22+) and skips itself without it.
 */

const test = require('node:test');
const assert = require('node:assert');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

const metrics = sqlite ? require('../electron/jenkins-metrics') : {};
const { JenkinsMetrics, MetricsCollector, percentile, middle, triggerOf, DAY, MINUTE, HOUR } = metrics;

/** A Friday, aligned to the quarter hour so the buckets of every range start where the test expects. */
const NOW = Date.parse('2026-10-16T12:00:00Z');
const S = 'srv';

const memory = () => new sqlite.DatabaseSync(':memory:');
const store = (extra = {}) => new JenkinsMetrics(memory(), { now: () => NOW, ...extra });

/** One finished or running build, put in by hand. `ago` is how long before NOW it began. */
function put(m, path, number, { ago = 0, start = null, dur = 60_000, result = 'success', running = false, agent = null, who = null, server = S } = {}) {
  const timestamp = start ?? NOW - ago;
  const build = { number, timestamp, duration: dur, status: running ? 'running' : result, running, agent };
  if (who) { build.cause = 'user'; build.who = who; }
  assert.equal(m.upsertBuild(server, path, build, NOW), true);
}

/** History complete back `days` days: what a server that has been watched for a while looks like. */
function covered(m, days = 60) {
  m.setBackfill(S, 'running', { windowStart: NOW - days * DAY });
  m.setBackfill(S, 'done');
  return m;
}

const dash = (m, extra = {}) => m.dashboard(S, { range: '24h', now: NOW, ...extra });

// --- the small pure things ----------------------------------------------------------

test('percentiles are nearest-rank, and a lone sample is every percentile', { skip }, () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([7], 0.5), 7);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 0.95), 95);
  assert.equal(percentile(hundred, 0.9), 90);
  assert.equal(middle([]), null);
  assert.equal(middle([5]), 5);
  assert.equal(middle([1, 3]), 2);
  assert.equal(middle([1, 2, 10]), 2);
  assert.equal(middle([1, 2, 3, 10]), 3, 'the mean of the two in the middle, rounded');
});

test('what started a build is a person, another job, a change, a schedule or something else', { skip }, () => {
  assert.deepEqual(triggerOf([{ text: 'Started by user Ana', user: 'ana' }]), { cause: 'user', who: 'ana' });
  assert.deepEqual(triggerOf([{ text: 'Started by upstream project "a/b" build number 4', upstream: 'a/b' }]), { cause: 'upstream', who: 'upstream: a/b' });
  assert.deepEqual(triggerOf([{ text: 'Started by an SCM change' }]), { cause: 'scm', who: 'SCM change' });
  assert.deepEqual(triggerOf([{ text: 'Branch indexing' }]), { cause: 'scm', who: 'SCM change' });
  assert.deepEqual(triggerOf([{ text: 'Started by timer' }]), { cause: 'timer', who: 'timer' });
  assert.deepEqual(triggerOf([{ text: 'Started by remote host 10.0.0.1' }]), { cause: 'remote', who: 'remote' });
  assert.deepEqual(triggerOf([{ text: 'Started by the lunar calendar' }]), { cause: 'other', who: 'the lunar calendar' });
  assert.deepEqual(triggerOf([{ text: 'Legacy code started this job.  No cause information is available' }]), { cause: 'unknown', who: null }, 'Jenkins saying it recorded nothing is not a trigger');
  assert.deepEqual(triggerOf([]), { cause: 'unknown', who: null });
  assert.deepEqual(triggerOf(undefined), { cause: 'unknown', who: null });
  // A person wins over what else is said about the same build.
  assert.equal(triggerOf([{ text: 'Started by an SCM change' }, { text: 'x', user: 'bob' }]).who, 'bob');
});

// --- an empty history ---------------------------------------------------------------

test('with no history everything is well-formed zeros and nothing claims to be complete', { skip }, () => {
  const d = dash(store());
  assert.equal(d.range, '24h');
  assert.equal(d.bucketMs, 15 * MINUTE);
  assert.equal(d.buckets.length, 96);
  assert.equal(d.buckets.every((b) => b.started === 0 && b.success === 0 && b.runningMax === null), true);
  assert.deepEqual(d.kpi.finished, { count: 0, prev: null }, 'no history: nothing to compare with');
  assert.deepEqual(d.kpi.rate, { value: null, prev: null });
  assert.equal(d.kpi.duration.avg, null);
  assert.equal(d.kpi.duration.p95, null);
  assert.equal(d.coverage.from, null);
  assert.equal(d.coverage.complete, false);
  assert.deepEqual(d.byHour, new Array(24).fill(0));
  assert.deepEqual(d.byWeekday, new Array(7).fill(0));
  assert.deepEqual(d.failures.topJobs, []);
  assert.equal(d.failures.mttrMs, null);
  assert.equal(d.failures.incidents, 0);
  assert.equal(d.failures.open, 0);
  assert.deepEqual(d.perf.regressions, []);
  assert.deepEqual(d.live.runs, []);
  assert.equal(d.activity.executorHours, 0);
  // Never a NaN: it would be a blank in a panel and a null in JSON.
  assert.equal(JSON.stringify(d).includes('null,null,null,null,null,null,null'), false);
  assert.equal(/NaN|Infinity/.test(JSON.stringify(d)), false);
});

test('every range has its own bucket width, and the buckets cover the slice end to end', { skip }, () => {
  const m = store();
  const widths = { '1h': [MINUTE, 60], '24h': [15 * MINUTE, 96], '7d': [3 * HOUR, 56], '30d': [12 * HOUR, 60] };
  for (const [range, [width, count]] of Object.entries(widths)) {
    const d = m.dashboard(S, { range, now: NOW });
    assert.equal(d.bucketMs, width, range);
    assert.equal(d.buckets.length, count, range);
    assert.equal(d.buckets.every((b) => b.t % width === 0), true, `${range}: aligned to UTC`);
    assert.equal(d.to - d.from, { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }[range]);
  }
  // A range nobody knows is the day.
  assert.equal(m.dashboard(S, { range: 'forever', now: NOW }).range, '24h');
});

// --- the numbers --------------------------------------------------------------------

test('what failed, what passed, and what does not count against anyone', { skip }, () => {
  const m = covered(store());
  // In the slice: 5 passed, 2 failed, 1 unstable, 2 aborted, 1 not built.
  for (let i = 0; i < 5; i += 1) put(m, 'a', 100 + i, { ago: (i + 1) * HOUR, result: 'success' });
  for (let i = 0; i < 2; i += 1) put(m, 'b', 200 + i, { ago: (i + 1) * 30 * MINUTE, result: 'failed' });
  put(m, 'c', 1, { ago: 2 * HOUR, result: 'unstable' });
  put(m, 'd', 1, { ago: 3 * HOUR, result: 'aborted' });
  put(m, 'd', 2, { ago: 4 * HOUR, result: 'aborted' });
  put(m, 'e', 1, { ago: 5 * HOUR, result: 'none' });
  // The day before: 3 passed, 1 failed.
  for (let i = 0; i < 3; i += 1) put(m, 'a', 50 + i, { ago: DAY + (i + 1) * HOUR });
  put(m, 'b', 150, { ago: DAY + 2 * HOUR, result: 'failed' });

  const k = dash(m).kpi;
  assert.deepEqual(k.finished, { count: 11, prev: 4 });
  assert.deepEqual(k.success, { count: 5, prev: 3 });
  assert.deepEqual(k.failed, { count: 2, prev: 1 });
  assert.deepEqual(k.unstable, { count: 1, prev: 0 });
  assert.deepEqual(k.aborted, { count: 2, prev: 0 });
  // 5 of the 8 that said yes or no; the aborted and the not-built say nothing about the code.
  assert.equal(k.rate.value, 5 / 8);
  assert.equal(k.rate.prev, 3 / 4);
  assert.deepEqual(k.started, { count: 11, prev: 4 });
});

test('how long builds take: finished ones that decided something, with few samples handled', { skip }, () => {
  const m = store();
  [10, 20, 30, 40, 1000].forEach((seconds, i) => put(m, 'a', i + 1, { ago: (i + 1) * HOUR, dur: seconds * 1000 }));
  // An aborted build says nothing about how long a build takes.
  put(m, 'a', 9, { ago: 30 * MINUTE, dur: 5000, result: 'aborted' });
  const d = dash(m).kpi.duration;
  assert.equal(d.n, 5);
  assert.equal(d.avg, 220_000);
  assert.equal(d.p50, 30_000);
  assert.equal(d.p95, 1_000_000);
  assert.equal(d.total, 1_100_000);
  assert.equal(d.prevAvg, null);

  const one = store();
  put(one, 'a', 1, { ago: HOUR, dur: 42_000 });
  const lone = dash(one).kpi.duration;
  assert.deepEqual([lone.avg, lone.p50, lone.p95], [42_000, 42_000, 42_000]);

  const even = store();
  put(even, 'a', 1, { ago: HOUR, dur: 10_000 });
  put(even, 'a', 2, { ago: 2 * HOUR, dur: 20_000 });
  assert.equal(dash(even).kpi.duration.p50, 15_000);
});

test('executor hours add up what builds used, aborted ones included', { skip }, () => {
  const m = store();
  put(m, 'a', 1, { ago: 3 * HOUR, dur: HOUR });
  put(m, 'a', 2, { ago: 2 * HOUR, dur: 30 * MINUTE, result: 'aborted' });
  assert.equal(dash(m).activity.executorHours, 1.5);
});

// --- one build, many looks ----------------------------------------------------------

test('a build seen many times is one build, a finish is never taken back, a later finish wins', { skip }, () => {
  const m = covered(store());
  const start = NOW - HOUR;
  m.upsertBuild(S, 'a', { number: 1, timestamp: start, running: true, status: 'running' }, NOW);
  m.upsertBuild(S, 'a', { number: 1, timestamp: start, running: true, status: 'running', agent: 'linux-1' }, NOW);
  assert.equal(dash(m).kpi.finished.count, 0, 'running is not finished');
  m.upsertBuild(S, 'a', { number: 1, timestamp: start, duration: 120_000, status: 'failed' }, NOW);
  assert.deepEqual(dash(m).kpi.finished, { count: 1, prev: 0 });
  // Seen "running" again by a slower look: it has not stopped having finished.
  m.upsertBuild(S, 'a', { number: 1, timestamp: start, running: true, status: 'running' }, NOW);
  const k = dash(m).kpi;
  assert.deepEqual([k.finished.count, k.failed.count], [1, 1]);
  assert.equal(m.timeline(S, { from: NOW - DAY, to: NOW, now: NOW }).runs[0].agent, 'linux-1', 'what was learned on the way is kept');
  // And a later look that says it differently wins, as the last word on how it ended.
  m.upsertBuild(S, 'a', { number: 1, timestamp: start, duration: 130_000, status: 'unstable' }, NOW);
  const after = dash(m).kpi;
  assert.deepEqual([after.finished.count, after.failed.count, after.unstable.count], [1, 0, 1]);
  assert.equal(m.stats(S)[0].builds, 1);
});

test('a build without a start time cannot be placed, and nonsense is clamped rather than stored', { skip }, () => {
  const m = store();
  assert.equal(m.upsertBuild(S, 'a', { number: 1, status: 'success', duration: 5 }), false);
  assert.equal(m.upsertBuild(S, 'a', { number: 0, timestamp: NOW, status: 'success' }), false);
  assert.equal(m.upsertBuild(S, '', { number: 1, timestamp: NOW, status: 'success' }), false);
  assert.equal(m.upsertBuild(S, 'a', { number: 1, timestamp: NaN, status: 'success' }), false);
  assert.equal(m.upsertBuild(S, 'a', { number: 1, timestamp: NOW - HOUR, status: 'success', duration: -5 }, NOW), true);
  assert.equal(m.upsertBuild(S, 'a', { number: 2, timestamp: NOW - HOUR, status: 'success', duration: 1e18 }, NOW), true);
  const durations = dash(m).kpi.duration;
  assert.equal(durations.n >= 1, true);
  assert.equal(Number.isFinite(durations.avg), true);
  assert.equal(m.upsertBuild(S, 'a', { number: 3, timestamp: NOW - HOUR, status: 'mystery', duration: 5 }, NOW), true);
  assert.equal(dash(m).kpi.aborted.count, 0);
});

test('names with quotes and worse are data, never SQL', { skip }, () => {
  const m = store();
  const evil = "x'); DROP TABLE jm_build; --";
  put(m, evil, 1, { ago: HOUR, result: 'failed', who: "o'brien" });
  put(m, 'ünï/cödé 😀/job', 1, { ago: HOUR, result: 'failed' });
  const d = dash(m);
  assert.equal(d.failures.topJobs.some((j) => j.path === evil), true);
  assert.equal(d.failures.topJobs.some((j) => j.path === 'ünï/cödé 😀/job'), true);
  assert.equal(d.activity.triggers[0].name, "o'brien");
  assert.equal(m.stats(S)[0].builds, 2);
});

// --- time ---------------------------------------------------------------------------

test('builds side by side are both there, and a build that crossed the start of the slice is in it', { skip }, () => {
  const m = covered(store());
  // Two builds of one job at once.
  put(m, 'team/a', 7, { start: NOW - 10 * MINUTE, dur: 8 * MINUTE });
  put(m, 'team/a', 8, { start: NOW - 6 * MINUTE, dur: 5 * MINUTE });
  const both = m.runningAt(S, NOW - 5 * MINUTE, { now: NOW });
  assert.deepEqual(both.running.map((r) => r.number), [7, 8]);
  assert.deepEqual(m.runningAt(S, NOW - 9 * MINUTE, { now: NOW }).running.map((r) => r.number), [7]);
  assert.deepEqual(m.runningAt(S, NOW - 20 * MINUTE, { now: NOW }).running, []);
  // Half open: it is running at its first instant, and not at its last.
  assert.equal(m.runningAt(S, NOW - 10 * MINUTE, { now: NOW }).running.length, 1);
  assert.equal(m.runningAt(S, NOW - 2 * MINUTE, { now: NOW }).running.map((r) => r.number).join(), '8', 'the first had just ended: it ended at that instant, and is no longer running');
  assert.equal(m.runningAt(S, NOW - MINUTE, { now: NOW }).running.length, 0);

  const edge = covered(store());
  const from = NOW - DAY;
  put(edge, 'x', 1, { start: from - HOUR, dur: 2 * HOUR });
  const d = dash(edge);
  assert.deepEqual(d.kpi.finished, { count: 1, prev: 0 }, 'it ended inside the slice');
  assert.deepEqual(d.kpi.started, { count: 0, prev: 1 }, 'but it began in the one before');
  assert.equal(edge.runningAt(S, from, { now: NOW }).running.length, 1, 'and at the start of the slice it was running');
});

test('what was running at an instant is honest about where history begins', { skip }, () => {
  const m = store();
  m.noteSeen(S, NOW - 6 * HOUR);
  put(m, 'a', 1, { start: NOW - 2 * HOUR, dur: HOUR });
  put(m, 'live', 1, { start: NOW - 30 * MINUTE, running: true, agent: 'linux-1' });
  const inside = m.runningAt(S, NOW - 90 * MINUTE, { now: NOW });
  assert.equal(inside.covered, true);
  assert.equal(inside.coverageFrom, NOW - 6 * HOUR);
  assert.deepEqual(inside.running.map((r) => [r.path, r.status, r.end === null, r.elapsedAtThen]), [['a', 'success', false, 30 * MINUTE]]);
  // Still running now: no end, and it is counted at any instant since it began.
  const now = m.runningAt(S, NOW - MINUTE, { now: NOW });
  assert.deepEqual(now.running.map((r) => [r.path, r.status, r.end]), [['live', 'running', null]]);
  assert.equal(now.running[0].agent, 'linux-1');
  // Before history began, or in the future: an answer, but not one to trust.
  assert.equal(m.runningAt(S, NOW - 7 * HOUR, { now: NOW }).covered, false);
  assert.equal(m.runningAt(S, NOW + HOUR, { now: NOW }).covered, false);
  assert.equal(store().runningAt(S, NOW, { now: NOW }).covered, false, 'no history at all');
});

test('the load of the server is the nearest sample within ninety seconds, or nothing', { skip }, () => {
  const m = store();
  m.recordSample(S, { t: NOW - 10 * MINUTE + 4000, running: 3, queued: 2, busy: 2, total: 2, offline: 1 });
  assert.deepEqual(m.runningAt(S, NOW - 10 * MINUTE + 30_000, { now: NOW }).load, { running: 3, queued: 2, busy: 2, executorsTotal: 2 });
  assert.equal(m.runningAt(S, NOW - 10 * MINUTE + 30_000, { now: NOW }).sampleAt, NOW - 10 * MINUTE);
  assert.equal(m.runningAt(S, NOW - 5 * MINUTE, { now: NOW }).load, null);
  assert.equal(m.runningAt(S, NOW - 5 * MINUTE, { now: NOW }).sampleAt, null);
  // Two samples for one minute are one sample: the later one.
  m.recordSample(S, { t: NOW - 10 * MINUTE + 50_000, running: 9, queued: 0, busy: 0, total: 0 });
  assert.equal(m.runningAt(S, NOW - 10 * MINUTE, { now: NOW }).load.running, 9);
  assert.equal(m.hasSample(S, NOW - 10 * MINUTE + 59_000), true);
  assert.equal(m.hasSample(S, NOW - 9 * MINUTE), false);
});

test('buckets are cut in UTC by when builds began and when they ended, with the load beside them', { skip }, () => {
  const m = store();
  const slot = Math.floor((NOW - 3 * HOUR) / (15 * MINUTE)) * (15 * MINUTE);
  put(m, 'a', 1, { start: slot + 2 * MINUTE, dur: 20 * MINUTE, result: 'success' });        // began in slot, ended in the next
  put(m, 'a', 2, { start: slot + 3 * MINUTE, dur: 5 * MINUTE, result: 'failed' });          // began and ended in slot
  put(m, 'a', 3, { start: slot + 4 * MINUTE, dur: 6 * MINUTE, result: 'unstable' });
  m.recordSample(S, { t: slot + 5 * MINUTE, running: 2, queued: 1, busy: 2, total: 4 });
  m.recordSample(S, { t: slot + 6 * MINUTE, running: 5, queued: 7, busy: 4, total: 4 });
  const d = dash(m);
  const at = (t) => d.buckets.find((b) => b.t === t);
  assert.equal(at(slot).started, 3);
  assert.equal(at(slot).failed, 1);
  assert.equal(at(slot).unstable, 1);
  assert.equal(at(slot).success, 0);
  assert.equal(at(slot + 15 * MINUTE).success, 1);
  assert.deepEqual([at(slot).runningMax, at(slot).queuedMax, at(slot).busyMax, at(slot).executorsTotal], [5, 7, 4, 4]);
  assert.equal(at(slot + 15 * MINUTE).runningMax, null, 'no sample, no number');
  // Counts add up: nothing lost between buckets and totals.
  assert.equal(d.buckets.reduce((n, b) => n + b.started, 0), d.kpi.started.count);
  assert.equal(d.buckets.reduce((n, b) => n + b.success + b.failed + b.unstable + b.aborted, 0), d.kpi.finished.count);
});

test('when builds begin is told in the asker\'s own hours', { skip }, () => {
  const m = store();
  // Thursday 2026-10-15, 23:30 UTC.
  put(m, 'a', 1, { start: Date.parse('2026-10-15T23:30:00Z'), dur: 1000 });
  put(m, 'a', 2, { start: Date.parse('2026-10-16T08:10:00Z'), dur: 1000 });
  const utc = dash(m);
  assert.equal(utc.byHour[23], 1);
  assert.equal(utc.byHour[8], 1);
  assert.equal(utc.byWeekday[4], 1, 'Thursday');
  assert.equal(utc.byWeekday[5], 1, 'Friday');
  const east = dash(m, { utcOffsetMinutes: 120 });
  assert.equal(east.byHour[1], 1, 'it was already after midnight there');
  assert.equal(east.byHour[10], 1);
  assert.equal(east.byWeekday[5], 2, 'both on the Friday');
  const west = dash(m, { utcOffsetMinutes: -300 });
  assert.equal(west.byHour[18], 1);
  assert.equal(west.byHour[3], 1);
  assert.deepEqual([west.byWeekday[4], west.byWeekday[5]], [1, 1], 'the first still on the Thursday, the second on the Friday');
  assert.equal(east.byHour.reduce((a, b) => a + b, 0), 2);
  // An absurd offset is held to the most there is (fourteen hours), and one that is not a number is none.
  const far = dash(m, { utcOffsetMinutes: 1e9 });
  assert.equal(far.byHour[13] + far.byHour[22], 2, '23:30 and 08:10, plus fourteen hours');
  assert.equal(dash(m, { utcOffsetMinutes: 'x' }).byHour[23], 1);
});

// --- what keeps breaking ------------------------------------------------------------

test('the jobs that fail most, how long they have been red, and when they last failed', { skip }, () => {
  const m = store();
  // `bad`: 3 passes then 4 failures to the present: red, streak of 4.
  [5, 4, 3].forEach((h, i) => put(m, 'bad', i + 1, { ago: (h + 3) * HOUR, result: 'success' }));
  [3, 2, 1, 0.5].forEach((h, i) => put(m, 'bad', 10 + i, { ago: h * HOUR, result: 'failed' }));
  // `meh`: two failures, the latest build passed: streak 0.
  put(m, 'meh', 1, { ago: 4 * HOUR, result: 'failed' });
  put(m, 'meh', 2, { ago: 3 * HOUR, result: 'failed' });
  put(m, 'meh', 3, { ago: HOUR, result: 'success' });
  // `shaky`: a failure, then unstable: the streak ends there.
  put(m, 'shaky', 1, { ago: 3 * HOUR, result: 'failed' });
  put(m, 'shaky', 2, { ago: HOUR, result: 'unstable' });
  put(m, 'fine', 1, { ago: HOUR, result: 'success' });

  const f = dash(m).failures;
  assert.deepEqual(f.topJobs.map((j) => [j.path, j.failed]), [['bad', 4], ['meh', 2], ['shaky', 1]]);
  const bad = f.topJobs[0];
  assert.equal(bad.runs, 7);
  assert.equal(bad.streak, 4);
  assert.deepEqual(bad.lastFailure, { number: 13, timestamp: NOW - 0.5 * HOUR + 60_000 });
  assert.equal(bad.rate, 4 / 7);
  assert.equal(f.topJobs[1].streak, 0);
  assert.equal(f.topJobs[2].streak, 0);
  assert.equal(f.open, 1, 'only `bad` is red right now');
});

test('a job that passes and fails by turns is flaky; one that broke and stayed broken is not', { skip }, () => {
  const m = store();
  ['success', 'failed', 'success', 'failed', 'success', 'success'].forEach((result, i) => put(m, 'flaky', i + 1, { ago: (7 - i) * HOUR, result }));
  ['success', 'success', 'failed', 'failed', 'failed', 'failed'].forEach((result, i) => put(m, 'broke', i + 1, { ago: (7 - i) * HOUR, result }));
  ['success', 'failed', 'success'].forEach((result, i) => put(m, 'short', i + 1, { ago: (4 - i) * HOUR, result }));
  const flaky = dash(m).failures.flaky;
  assert.deepEqual(flaky, [{ path: 'flaky', flips: 4, runs: 6 }], 'two flips and four runs at least, or it is just a bad day');
});

test('incidents last from the first failure to the next pass; one still going has no end yet', { skip }, () => {
  const m = store();
  // a: failed at -6h and -5h, passed at -4h: recovered in 2h (measured end to end of the builds).
  put(m, 'a', 1, { start: NOW - 7 * HOUR, dur: HOUR, result: 'failed' });      // ended -6h
  put(m, 'a', 2, { start: NOW - 6 * HOUR, dur: HOUR, result: 'failed' });      // ended -5h
  put(m, 'a', 3, { start: NOW - 5 * HOUR, dur: HOUR, result: 'success' });     // ended -4h
  // b: failed at -3h, passed at -2h30: 30 minutes.
  put(m, 'b', 1, { start: NOW - 4 * HOUR, dur: HOUR, result: 'failed' });      // ended -3h
  put(m, 'b', 2, { start: NOW - 3 * HOUR, dur: 30 * MINUTE, result: 'success' }); // ended -2h30
  // c: failed at -1h, no pass since: open.
  put(m, 'c', 1, { start: NOW - 2 * HOUR, dur: HOUR, result: 'failed' });      // ended -1h
  const f = dash(m).failures;
  assert.equal(f.incidents, 3);
  assert.equal(f.open, 1);
  // 2h and 30min: the middle of two is their mean.
  assert.equal(f.mttrMs, 75 * MINUTE);
  assert.equal(f.mttrP90Ms, 2 * HOUR);

  // A failure that began before the slice and ended inside it is not this slice's incident.
  const before = store();
  put(before, 'a', 1, { start: NOW - 2 * DAY, dur: HOUR, result: 'failed' });
  put(before, 'a', 2, { start: NOW - 2 * HOUR, dur: HOUR, result: 'success' });
  assert.equal(dash(before).failures.incidents, 0);
  assert.equal(dash(before).failures.mttrMs, null);
});

test('a job that has become slower is told apart from one that was always slow', { skip }, () => {
  const m = store();
  // 25 builds: the 20 before at 100 s, the last 5 at 200 s. Newest has the highest number.
  for (let i = 0; i < 20; i += 1) put(m, 'slowing', i + 1, { ago: (60 - i) * HOUR / 4, dur: 100_000 });
  for (let i = 0; i < 5; i += 1) put(m, 'slowing', 21 + i, { ago: (5 - i) * HOUR / 4, dur: 200_000 });
  // Slow from the start: no regression.
  for (let i = 0; i < 25; i += 1) put(m, 'steady', i + 1, { ago: (60 - i) * HOUR / 4, dur: 500_000 });
  // Slower, but only a little.
  for (let i = 0; i < 20; i += 1) put(m, 'a-bit', i + 1, { ago: (60 - i) * HOUR / 4, dur: 100_000 });
  for (let i = 0; i < 5; i += 1) put(m, 'a-bit', 21 + i, { ago: (5 - i) * HOUR / 4, dur: 120_000 });
  // Too little history to say.
  for (let i = 0; i < 5; i += 1) put(m, 'young', i + 1, { ago: (5 - i) * HOUR / 4, dur: 900_000 });
  const p = dash(m).perf;
  assert.deepEqual(p.regressions, [{ path: 'slowing', now: 200_000, before: 100_000, ratio: 2 }]);
  assert.equal(p.slowest.length, 5);
  assert.equal(p.slowest[0].duration, 900_000);
});

test('what is built most, by whom, and what looks like a deployment', { skip }, () => {
  const m = store();
  for (let i = 0; i < 4; i += 1) put(m, 'web/build', i + 1, { ago: (i + 1) * HOUR, who: i % 2 ? 'ana' : 'SCM change' });
  for (let i = 0; i < 2; i += 1) put(m, 'api/build', i + 1, { ago: (i + 1) * HOUR, who: 'ana' });
  put(m, 'infra/deploy-prod', 1, { ago: 2 * HOUR, result: 'success' });
  put(m, 'infra/deploy-prod', 2, { ago: HOUR, result: 'failed' });
  put(m, 'app/Release', 1, { ago: HOUR, result: 'success' });
  put(m, 'reproduce-bug', 1, { ago: HOUR, result: 'success' });   // "produce" in a word is not a deployment
  put(m, 'predeployed', 1, { ago: HOUR, result: 'success' });
  const a = dash(m).activity;
  assert.deepEqual(a.mostBuilt.slice(0, 2), [{ path: 'web/build', runs: 4 }, { path: 'api/build', runs: 2 }]);
  assert.deepEqual(a.triggers, [{ name: 'ana', runs: 4 }, { name: 'SCM change', runs: 2 }]);
  assert.deepEqual(a.deploys, { jobs: 2, finished: 3, failed: 1, successRate: 2 / 3, perDay: 3 });
});

test('where builds failed is counted for the jobs that failed, and says how much of it is known', { skip }, () => {
  const m = store();
  put(m, 'a', 1, { ago: 3 * HOUR, result: 'failed' });
  put(m, 'a', 2, { ago: 2 * HOUR, result: 'failed' });
  put(m, 'a', 3, { ago: HOUR, result: 'failed' });
  put(m, 'b', 1, { ago: HOUR, result: 'failed' });
  assert.deepEqual(m.unchecked(S, NOW - DAY, NOW), ['a', 'b']);
  m.setStages(S, 'a', new Map([[1, 'Test'], [2, 'Test']]), NOW - DAY, NOW);
  assert.deepEqual(m.unchecked(S, NOW - DAY, NOW), ['b'], 'every failed build of `a` is settled, found or not');
  const f = dash(m).failures;
  assert.deepEqual(f.byStage, [{ stage: 'Test', count: 2 }]);
  assert.deepEqual(f.stageCoverage, { known: 2, failed: 4 });
});

test('how long a build waited, for the builds that were seen waiting', { skip }, () => {
  const m = store();
  m.upsertBuild(S, 'a', { number: 1, timestamp: NOW - 2 * HOUR, running: true, status: 'running', queuedAt: NOW - 2 * HOUR - 30_000 }, NOW);
  m.upsertBuild(S, 'a', { number: 2, timestamp: NOW - HOUR, running: true, status: 'running', queuedAt: NOW - HOUR - 90_000 }, NOW);
  put(m, 'a', 3, { ago: 30 * MINUTE });
  assert.deepEqual(dash(m).kpi.queueWait, { n: 2, avg: 60_000, p95: 90_000 });
  // Seen waiting is kept from the first time it was seen: a later look does not make it wait less.
  m.upsertBuild(S, 'a', { number: 1, timestamp: NOW - 2 * HOUR, running: true, status: 'running', queuedAt: NOW - 2 * HOUR - 1000 }, NOW);
  assert.equal(dash(m).kpi.queueWait.avg, 60_000);
  assert.deepEqual(dash(store()).kpi.queueWait, { n: 0, avg: null, p95: null });
});

test('an agent that goes away and comes back shows as a flap', { skip }, () => {
  const m = store();
  [0, 0, 1, 1, 0, 0, 2, 0].forEach((offline, i) => m.recordSample(S, { t: NOW - (10 - i) * MINUTE, running: 0, queued: 0, busy: 0, total: 2, offline }));
  assert.equal(dash(m).activity.agentFlaps, 4);
});

// --- coverage -----------------------------------------------------------------------

test('coverage says where history begins and refuses to call itself complete until it is', { skip }, () => {
  const m = store();
  m.noteSeen(S, NOW - 3 * HOUR);
  let c = dash(m).coverage;
  assert.equal(c.from, NOW - 3 * HOUR);
  assert.equal(c.complete, false, 'three hours of a day');
  assert.equal(dash(m, { range: '1h' }).coverage.complete, false, 'not done reading the past either');
  m.setBackfill(S, 'running', { windowStart: NOW - 7 * DAY });
  m.planFolders(S, ['', 'a', 'a/b']);
  m.folderDone(S, '');
  assert.deepEqual(dash(m, { backfill: m.folderProgress(S) }).coverage.backfill, { done: 1, total: 3 });
  assert.equal(dash(m).coverage.backfill.running, true);
  m.setBackfill(S, 'done');
  c = dash(m).coverage;
  assert.equal(c.from, NOW - 7 * DAY, 'history is complete back to where the walk began');
  assert.equal(c.complete, true);
  assert.equal(dash(m, { range: '30d' }).coverage.complete, false, 'but a month is more than a week');
  // A job with more builds in the slice than were read: not complete, and says how many.
  m.setJobFrom(S, 'busy', NOW - 2 * HOUR);
  m.setJobFrom(S, 'busier', NOW - 30 * MINUTE);
  c = dash(m).coverage;
  assert.equal(c.truncatedJobs, 2);
  assert.equal(c.complete, false);
  m.setJobFrom(S, 'busy', null);
  m.setJobFrom(S, 'busier', null);
  assert.equal(dash(m).coverage.complete, true);
});

// --- the timeline -------------------------------------------------------------------

test('the timeline lists what overlapped the window, oldest first, and says when it cut', { skip }, () => {
  const m = store();
  for (let i = 0; i < 30; i += 1) put(m, 'a', i + 1, { start: NOW - (40 - i) * MINUTE, dur: 5 * MINUTE });
  put(m, 'live', 1, { start: NOW - 3 * MINUTE, running: true });
  const all = m.timeline(S, { from: NOW - 2 * HOUR, to: NOW, now: NOW });
  assert.equal(all.runs.length, 31);
  assert.equal(all.truncated, false);
  assert.equal(all.runs.at(-1).status, 'running');
  assert.equal(all.runs.at(-1).end, null);
  assert.equal(all.runs.every((r, i) => i === 0 || all.runs[i - 1].start <= r.start), true);
  const cut = m.timeline(S, { from: NOW - 2 * HOUR, to: NOW, now: NOW, cap: 10 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.runs.length, 10);
  assert.equal(cut.runs.at(-1).path, 'live', 'the newest are kept');
  // A window that ends before a build began, or begins after it ended, does not have it.
  assert.deepEqual(m.timeline(S, { from: NOW - 3 * HOUR, to: NOW - 2 * HOUR, now: NOW }).runs, []);
  const crossing = m.timeline(S, { from: NOW - 39 * MINUTE, to: NOW - 38 * MINUTE, now: NOW }).runs;
  assert.deepEqual(crossing.map((r) => r.number), [1, 2], 'one began before the window and was still going, one began inside it');
});

// --- keeping it small, and keeping it private ---------------------------------------

test('old history is let go, minute samples are thinned, and a build that never ended is settled', { skip }, () => {
  const m = store({ retentionDays: 90 });
  put(m, 'old', 1, { ago: 100 * DAY });
  put(m, 'edge', 1, { ago: 89 * DAY });
  m.upsertBuild(S, 'ghost', { number: 1, timestamp: NOW - 4 * DAY, running: true, status: 'running' }, NOW - 4 * DAY);
  put(m, 'live', 1, { ago: 10 * MINUTE, running: true });
  for (let i = 0; i < 20; i += 1) m.recordSample(S, { t: NOW - 20 * DAY + i * MINUTE, running: 1, queued: 0, busy: 1, total: 2 });
  for (let i = 0; i < 5; i += 1) m.recordSample(S, { t: NOW - i * MINUTE, running: 1, queued: 0, busy: 1, total: 2 });
  m.recordSample(S, { t: NOW - 100 * DAY, running: 1, queued: 0, busy: 1, total: 2 });
  assert.equal(m.prune(NOW), true);
  const kept = m.timeline(S, { from: 0, to: NOW, now: NOW }).runs.map((r) => r.path);
  assert.deepEqual(kept.sort(), ['edge', 'ghost', 'live']);
  const ghost = m.timeline(S, { from: 0, to: NOW, now: NOW }).runs.find((r) => r.path === 'ghost');
  assert.equal(ghost.status, 'none', 'seen running and never seen finishing: finished as unknown');
  assert.equal(ghost.end !== null, true);
  assert.equal(m.timeline(S, { from: 0, to: NOW, now: NOW }).runs.find((r) => r.path === 'live').status, 'running');
  const samples = m.db.prepare('SELECT t FROM jm_sample WHERE server = ? ORDER BY t').all(S).map((r) => r.t);
  assert.equal(samples.filter((t) => t < NOW - DAY).length, 4, 'one in five of the twenty minutes that are old');
  assert.equal(samples.filter((t) => t >= NOW - DAY).length, 5, 'recent ones are all kept');
  assert.equal(samples.includes(NOW - 100 * DAY), false);
  // Hourly at most, unless forced.
  assert.equal(m.prune(NOW + MINUTE), false);
  assert.equal(m.prune(NOW + MINUTE, { force: true }), true);
});

test('what was kept of a server, a job or a build is gone when it is forgotten — and only that', { skip }, () => {
  const m = store();
  for (const server of ['one', 'two']) {
    put(m, 'a', 1, { ago: HOUR, server });
    put(m, 'a', 2, { ago: HOUR, server });
    put(m, 'b', 1, { ago: HOUR, server });
    m.recordSample(server, { t: NOW, running: 1, queued: 0, busy: 1, total: 1 });
    m.noteSeen(server, NOW);
    m.setJobFrom(server, 'a', NOW - HOUR);
  }
  m.forgetBuild('one', 'a', 2);
  assert.equal(m.stats('one')[0].builds, 2);
  m.forgetJob('one', 'a');
  assert.equal(m.stats('one')[0].builds, 1);
  assert.equal(m.cappedJobs('one').length, 0);
  assert.equal(m.cappedJobs('two').length, 1);
  m.forgetServer('one');
  assert.deepEqual(m.stats('one'), []);
  assert.equal(m.serverRow('one'), null);
  assert.equal(m.hasSample('one', NOW), false);
  assert.equal(m.stats('two')[0].builds, 3);
  assert.equal(m.hasSample('two', NOW), true);
  assert.equal(m.serverRow('two') !== null, true);
});

test('the tables can be made twice, and a database from a newer build is not touched', { skip }, () => {
  const db = memory();
  const a = new JenkinsMetrics(db, { now: () => NOW });
  put(a, 'a', 1, { ago: HOUR });
  const b = new JenkinsMetrics(db, { now: () => NOW });
  assert.equal(b.stats(S)[0].builds, 1, 'the second one sees what the first kept');
  db.prepare('UPDATE jm_schema SET version = 99').run();
  assert.throws(() => new JenkinsMetrics(db, { now: () => NOW }), /newer than this build knows/);
});

test('retention and sample thinning are bounded to sane values', { skip }, () => {
  const tiny = store({ retentionDays: 0, sampleKeepDays: 0 });
  assert.equal(tiny.retentionMs >= 7 * DAY, true);
  assert.equal(tiny.sampleKeepMs >= DAY, true);
  const huge = store({ retentionDays: 1e9, sampleKeepDays: 1e9 });
  assert.equal(huge.retentionMs <= 365 * DAY, true);
  assert.equal(huge.sampleKeepMs <= huge.retentionMs, true);
});

// ======================================================================================
// The collector
// ======================================================================================

/** A Jenkins that is not there: every call the collector makes is answered from a table, and counted. */
function fakeApi(state = {}) {
  const api = {
    calls: [],
    state: { executors: { serverDate: NOW, agents: [], builds: [], executors: { busy: 0, total: 0 } }, queue: [], history: {}, folders: {}, runs: {}, ...state },
    async running() {
      api.calls.push('running');
      if (api.state.runningError) throw api.state.runningError;
      return api.state.executors;
    },
    async queue() { api.calls.push('queue'); return api.state.queue; },
    async buildsOf(path, { limit = 30 } = {}) {
      api.calls.push(`buildsOf ${path} ${limit}`);
      if (api.state.buildsError) throw api.state.buildsError;
      return (api.state.history[path] ?? []).slice(0, limit);
    },
    async foldersBuilds(folder, { limit = 30 } = {}) {
      api.calls.push(`foldersBuilds ${folder} ${limit}`);
      const answer = api.state.folders[folder];
      if (answer instanceof Error) throw answer;
      if (api.state.gate) await api.state.gate(folder);
      return { jobs: (answer ?? []).map((job) => ({ path: job.path, builds: job.builds.slice(0, limit) })) };
    },
    async runs(path) {
      api.calls.push(`runs ${path}`);
      if (api.state.runsGate) await api.state.runsGate;
      return api.state.runs[path] ?? { available: false, runs: [] };
    },
  };
  return api;
}

/** An index with the shape the service keeps. */
function indexOf(rows, extra = {}) {
  return { rows: new Map(rows.map((row) => [row.path, { kind: 'job', status: 'success', running: false, ...row }])), truncated: false, ...extra };
}
const last = (number, extra = {}) => ({ number, status: 'success', running: false, timestamp: NOW - 10 * MINUTE, duration: 60_000, ...extra });

function collector(extra = {}) {
  let now = NOW;
  const db = extra.db ?? memory();
  const c = new MetricsCollector({ db, now: () => now, sleep: async () => {}, pause: 0, ...extra });
  return { c, db, tick: (ms) => { now += ms; }, at: (t) => { now = t; }, clock: () => now };
}

test('until a dashboard has been opened, only what the index says is kept and Jenkins is asked nothing', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  const index = indexOf([{ path: 'a', last: last(5) }, { path: 'b', running: true, status: 'success', last: last(9, { running: true, status: 'running' }) }]);
  await c.afterPoll(S, api, index);
  assert.deepEqual(api.calls, [], 'not one request');
  const rows = c.timeline(S, { from: NOW - DAY, to: NOW });
  assert.deepEqual(rows.runs.map((r) => [r.path, r.number, r.status]).sort(), [['a', 5, 'success'], ['b', 9, 'running']]);
  // A job that moved by many numbers is not filled in without asking, and is not asked until someone looks.
  await c.afterPoll(S, api, indexOf([{ path: 'a', last: last(9) }]));
  assert.deepEqual(api.calls, []);
  assert.equal(c.store.isActive(S), false);
  assert.equal(c.store.hasSample(S, NOW), false, 'and nothing is sampled');
});

test('a build that came and went between two looks is found, as are several of one job at once', { skip }, async () => {
  const { c, tick } = collector();
  const api = fakeApi();
  c.store.activate(S);
  await c.afterPoll(S, api, indexOf([{ path: 'a', last: last(5) }]));
  api.calls.length = 0;
  api.state.history.a = [8, 7, 6, 5].map((number, i) => ({ number, status: i === 1 ? 'failed' : 'success', running: false, timestamp: NOW - (i + 1) * 5 * MINUTE, duration: 60_000, estimated: null, agent: 'linux-1', causes: [{ text: 'Started by user ana', user: 'ana', upstream: null }] }));
  tick(5000);
  await c.afterPoll(S, api, indexOf([{ path: 'a', last: last(8) }]));
  assert.equal(api.calls.includes('buildsOf a 4'), true, 'asked for exactly the numbers it was missing, and the one before');
  const runs = c.timeline(S, { from: NOW - DAY, to: NOW + MINUTE }).runs.filter((r) => r.path === 'a');
  assert.deepEqual(runs.map((r) => r.number).sort(), [5, 6, 7, 8]);
  assert.equal(runs.find((r) => r.number === 7).status, 'failed');
  assert.equal(runs.find((r) => r.number === 6).trigger, 'ana');
  // Asked once: the next look, with nothing new, is not asked about it again.
  api.calls.length = 0;
  tick(5000);
  await c.afterPoll(S, api, indexOf([{ path: 'a', last: last(8) }]));
  assert.equal(api.calls.some((call) => call.startsWith('buildsOf')), false);
});

test('a build seen running that the job has moved on from is asked about until it says how it ended', { skip }, async () => {
  const { c, tick } = collector();
  const api = fakeApi();
  c.store.activate(S);
  await c.afterPoll(S, api, indexOf([{ path: 'a', running: true, last: last(5, { running: true, status: 'running' }) }]));
  api.state.history.a = [
    { number: 6, status: 'running', running: true, timestamp: NOW - MINUTE, duration: 0, causes: [] },
    { number: 5, status: 'failed', running: false, timestamp: NOW - 10 * MINUTE, duration: 120_000, causes: [] },
  ];
  tick(MINUTE);
  await c.afterPoll(S, api, indexOf([{ path: 'a', running: true, last: last(6, { running: true, status: 'running' }) }]));
  const five = c.timeline(S, { from: NOW - DAY, to: NOW + HOUR }).runs.find((r) => r.number === 5);
  assert.equal(five.status, 'failed');
  assert.equal(five.end !== null, true);
});

test('the load is sampled once a minute, never twice for one minute, and only after a dashboard was opened', { skip }, async () => {
  const { c, tick } = collector();
  const api = fakeApi({ executors: { serverDate: NOW, agents: [{ name: 'a1', offline: true, busy: 0, executors: 2, labels: [] }, { name: 'a2', offline: false, busy: 1, executors: 2, labels: [] }], builds: [{ path: 'x', number: 1, timestamp: NOW - 5 * MINUTE, estimated: null, agents: ['a2'] }], executors: { busy: 1, total: 2 } }, queue: [{ id: 1, path: 'q', since: NOW - MINUTE, why: 'w', stuck: false, blocked: false }] });
  const index = indexOf([]);
  await c.afterPoll(S, api, index);
  assert.equal(c.store.hasSample(S, NOW), false);
  c.store.activate(S);
  await c.afterPoll(S, api, index);
  assert.equal(c.store.hasSample(S, NOW), true);
  const first = c.store.runningAt(S, NOW + 1000, { now: NOW + 1000 });
  assert.deepEqual(first.load, { running: 1, queued: 1, busy: 1, executorsTotal: 2 });
  const asked = api.calls.length;
  for (let i = 0; i < 4; i += 1) { tick(10_000); await c.afterPoll(S, api, index); }
  // Fifty seconds on: the same minute, so no new sample (the live read is kept for a few seconds, at most one more).
  assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM jm_sample WHERE server = ?').get(S).n, 1);
  assert.equal(api.calls.length <= asked + 0, true, 'and not a request more');
  tick(30_000);
  await c.afterPoll(S, api, index);
  assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM jm_sample WHERE server = ?').get(S).n, 2);
  assert.equal(c.store.db.prepare('SELECT offline FROM jm_sample WHERE server = ? ORDER BY t').all(S)[0].offline, 1);
});

test('what is running now includes builds side by side and those that hold no executor', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi({
    executors: {
      serverDate: NOW,
      agents: [{ name: 'linux-1', offline: false, busy: 2, executors: 2, labels: ['linux'] }, { name: 'arm-1', offline: true, busy: 0, executors: 1, labels: ['arm'] }],
      builds: [
        { path: 'team/web', number: 41, timestamp: NOW - 4 * MINUTE, estimated: 8 * MINUTE, agents: ['linux-1', 'built-in'] },
        { path: 'team/web', number: 42, timestamp: NOW - 1 * MINUTE, estimated: 8 * MINUTE, agents: ['linux-1'] },
        { path: 'team/e2e', number: 3, timestamp: NOW - 3 * HOUR, estimated: 10 * MINUTE, agents: ['linux-1'] },
        { path: 'team/odd', number: 1, timestamp: NOW - 7 * HOUR, estimated: null, agents: ['linux-1'] },
        { path: 'team/quick', number: 9, timestamp: NOW - 20 * MINUTE, estimated: 10 * MINUTE, agents: ['linux-1'] },
      ],
      executors: { busy: 2, total: 2 },
    },
    queue: [{ id: 7, path: 'team/it', since: NOW - 3 * MINUTE, why: 'Waiting for next available executor', stuck: false, blocked: false }, { id: 8, path: 'team/arm', since: NOW - HOUR, why: 'no arm agent', stuck: true, blocked: false }],
  });
  const index = indexOf([
    { path: 'team/deploy', running: true, last: last(12, { running: true, status: 'running', timestamp: NOW - 40 * MINUTE }) },
    { path: 'team/web', running: true, last: last(42, { running: true, status: 'running', timestamp: NOW - MINUTE }) },
  ]);
  const live = await c.live(S, api, index);
  assert.equal(live.running, 6);
  assert.deepEqual(live.runs.map((r) => `${r.path}#${r.number}`).slice(0, 4), ['team/web#42', 'team/web#41', 'team/quick#9', 'team/deploy#12'], 'newest first');
  const by = Object.fromEntries(live.runs.map((r) => [`${r.path}#${r.number}`, r]));
  assert.deepEqual([by['team/web#41'].elapsed, by['team/web#41'].progress, by['team/web#41'].agent, by['team/web#41'].agents], [4 * MINUTE, 0.5, 'linux-1', ['linux-1', 'built-in']]);
  assert.equal(by['team/web#41'].waiting, false);
  assert.equal(by['team/web#42'].waiting, false, 'in the index as the last build too, and not counted twice');
  assert.equal(by['team/deploy#12'].waiting, true, 'running with no executor: waiting for input, or asleep');
  assert.equal(by['team/deploy#12'].agent, null);
  assert.equal(by['team/e2e#3'].stuck, true, 'three hours of a ten minute job');
  assert.equal(by['team/e2e#3'].progress, 0.99, 'a bar never says done while it still runs');
  assert.equal(by['team/odd#1'].stuck, true, 'seven hours and no idea how long it should take');
  assert.equal(by['team/quick#9'].stuck, false, 'twice its estimate is not yet stuck: the slack applies too');
  assert.equal(by['team/web#41'].stuck, false);
  assert.equal(live.queued, 2);
  assert.equal(live.stuck, 3, 'two builds and the queue item Jenkins says is stuck');
  assert.deepEqual(live.queue.map((q) => [q.id, q.waited]), [[7, 3 * MINUTE], [8, HOUR]]);
  assert.deepEqual(live.executors, { busy: 2, total: 2 });
  assert.deepEqual([live.agents.total, live.agents.offline], [2, 1]);
  assert.equal(live.agents.list[1].offline, true);
});

test('a clock that is off is measured, said, and corrected for', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi({ executors: { serverDate: NOW + 5 * MINUTE, agents: [], builds: [{ path: 'a', number: 1, timestamp: NOW + 5 * MINUTE - 3 * MINUTE, estimated: null, agents: [] }], executors: { busy: 0, total: 0 } } });
  const live = await c.live(S, api, indexOf([]));
  assert.equal(live.runs[0].elapsed, 3 * MINUTE, 'three minutes by Jenkins\' clock, not eight by ours');
  assert.equal(live.notes.some((n) => /5 minutes ahead/.test(n)), true);
  assert.equal(c.store.serverRow(S).skew_ms, 5 * MINUTE);
  // A header has one second of resolution: a difference that small is not a skew.
  const { c: ok } = collector();
  const near = fakeApi({ executors: { serverDate: NOW - 900, agents: [], builds: [{ path: 'a', number: 1, timestamp: NOW - MINUTE, estimated: null, agents: [] }], executors: { busy: 0, total: 0 } } });
  const fine = await ok.live(S, near, indexOf([]));
  assert.equal(fine.runs[0].elapsed, MINUTE);
  assert.equal(fine.notes.length, 0);
});

test('when the agents cannot be read, the dashboard says so and falls back to the job list', { skip }, async () => {
  const { c } = collector();
  const err = Object.assign(new Error('Jenkins knows who you are but does not allow that'), { status: 403 });
  const api = fakeApi({ runningError: err, queue: [] });
  const live = await c.live(S, api, indexOf([{ path: 'a', running: true, last: last(3, { running: true, status: 'running' }) }]));
  assert.equal(live.running, 1);
  assert.deepEqual(live.executors, { busy: 0, total: 0 });
  assert.equal(live.notes.some((n) => /agents could not be read/.test(n)), true);
});

test('what started a running build is asked for once, and kept', { skip }, async () => {
  const { c, tick } = collector();
  const api = fakeApi({
    executors: { serverDate: NOW, agents: [], builds: [{ path: 'a', number: 4, timestamp: NOW - MINUTE, estimated: null, agents: ['x'] }], executors: { busy: 1, total: 1 } },
    history: { a: [{ number: 4, status: 'running', running: true, timestamp: NOW - MINUTE, duration: 0, estimated: null, agent: 'x', causes: [{ text: 'Started by user Ana', user: 'ana', upstream: null }] }] },
  });
  const first = await c.live(S, api, indexOf([]), { fresh: true });
  assert.equal(first.runs[0].trigger, 'ana');
  assert.equal(api.calls.filter((call) => call.startsWith('buildsOf')).length, 1);
  tick(10_000);
  await c.live(S, api, indexOf([]), { fresh: true });
  assert.equal(api.calls.filter((call) => call.startsWith('buildsOf')).length, 1, 'known now: not asked again');
  // A build nobody started (Jenkins said nothing) is settled too, as unknown.
  const { c: c2 } = collector();
  const quiet = fakeApi({ executors: { serverDate: NOW, agents: [], builds: [{ path: 'q', number: 1, timestamp: NOW - MINUTE, estimated: null, agents: [] }], executors: { busy: 0, total: 0 } }, history: { q: [{ number: 1, status: 'running', running: true, timestamp: NOW - MINUTE, duration: 0, causes: [] }] } });
  await c2.live(S, quiet, indexOf([]), { fresh: true });
  await c2.live(S, quiet, indexOf([]), { fresh: true });
  assert.equal(quiet.calls.filter((call) => call.startsWith('buildsOf')).length, 1);
});

test('a build is known to have waited when it was seen in the queue before it began', { skip }, async () => {
  const { c, tick } = collector();
  const api = fakeApi({ queue: [{ id: 5, path: 'a', since: NOW - 2 * MINUTE, why: 'busy', stuck: false, blocked: false }] });
  await c.live(S, api, indexOf([]), { fresh: true });
  tick(2 * MINUTE);
  api.state.queue = [];
  api.state.executors = { serverDate: NOW + 2 * MINUTE, agents: [], builds: [{ path: 'a', number: 1, timestamp: NOW + 90_000, estimated: null, agents: [] }], executors: { busy: 1, total: 1 } };
  api.state.history.a = [{ number: 1, status: 'running', running: true, timestamp: NOW + 90_000, duration: 0, causes: [] }];
  await c.live(S, api, indexOf([]), { fresh: true });
  const row = c.store.db.prepare('SELECT queued_at, started_at FROM jm_build WHERE server = ? AND path = ?').get(S, 'a');
  assert.equal(row.started_at - row.queued_at, 3.5 * MINUTE, 'it began 90 s after the clock moved, and was seen queued two minutes before that');
});

test('the history of a server is read once, in the background, and the dashboard says how far it has got', { skip }, async () => {
  const { c, at } = collector({ backfillDays: 7, perJob: 5 });
  const api = fakeApi();
  const win = NOW - 7 * DAY;
  const b = (number, ago, extra = {}) => ({ number, status: 'success', running: false, timestamp: NOW - ago, duration: 60_000, estimated: null, agent: 'x', causes: [], ...extra });
  api.state.folders[''] = [{ path: 'top', builds: [b(3, HOUR), b(2, 2 * HOUR), b(1, 8 * DAY)] }];    // the last is older than the window
  api.state.folders.team = [
    { path: 'team/busy', builds: [b(50, HOUR), b(49, 2 * HOUR), b(48, 3 * HOUR), b(47, 4 * HOUR), b(46, 5 * HOUR)] },   // as many as were asked for: maybe more
    { path: 'team/calm', builds: [b(2, DAY), b(1, 2 * DAY)] },
  ];
  api.state.history['team/busy'] = [50, 49, 48, 47, 46, 45, 44, 43].map((n, i) => b(n, (i + 1) * HOUR)).concat([b(42, 9 * DAY)]);
  const index = indexOf([{ path: 'top', last: last(3) }, { path: 'team/busy', last: last(50) }, { path: 'team/calm', last: last(2) }]);
  c.store.activate(S);
  await c.afterPoll(S, api, index);
  // The walk is not waited for; let it finish.
  while (c.backfills.size) await Promise.all([...c.backfills.values()]);
  const row = c.store.serverRow(S);
  assert.equal(row.backfill, 'done');
  assert.equal(row.since, win, 'complete back to where the walk began');
  const numbers = (path) => c.timeline(S, { from: NOW - 8 * DAY, to: NOW + HOUR }).runs.filter((r) => r.path === path).map((r) => r.number).sort((x, y) => x - y);
  assert.deepEqual(numbers('top'), [2, 3], 'nothing older than the window');
  assert.deepEqual(numbers('team/calm'), [1, 2]);
  assert.deepEqual(numbers('team/busy'), [43, 44, 45, 46, 47, 48, 49, 50], 'the busy one was read again, deeper');
  assert.equal(api.calls.includes('buildsOf team/busy 200'), true);
  assert.equal(c.store.cappedJobs(S).length, 0, 'and it is complete now: nothing is marked as cut');
  assert.equal(api.calls.includes('buildsOf team/calm 200'), false, 'the calm ones were not');
  assert.equal(c.store.foldersLeft(S).length, 0);
  const d = await c.dashboard(S, api, index, { range: '7d' });
  assert.equal(d.coverage.complete, true);
  assert.equal(d.coverage.from, win);
  assert.deepEqual(d.coverage.backfill, { done: 2, total: 2, running: false }, 'it says how many it read, after as well as during');
  assert.equal(d.kpi.finished.count, 2 + 2 + 8);
  at(NOW);
});

test('a job too busy to be read in full is marked, and the dashboard says so', { skip }, async () => {
  const { c } = collector({ perJob: 5, deepJob: 6 });
  const api = fakeApi();
  const b = (number, ago) => ({ number, status: 'success', running: false, timestamp: NOW - ago, duration: 1000, estimated: null, agent: null, causes: [] });
  api.state.folders[''] = [{ path: 'storm', builds: [1, 2, 3, 4, 5].map((n) => b(n, n * MINUTE)) }];
  api.state.history.storm = [1, 2, 3, 4, 5, 6].map((n) => b(n, n * MINUTE));    // still more than the deeper read asked for
  const index = indexOf([{ path: 'storm', last: last(1) }]);
  c.store.activate(S);
  await c.afterPoll(S, api, index);
  while (c.backfills.size) await Promise.all([...c.backfills.values()]);
  assert.deepEqual(c.store.cappedJobs(S), [{ path: 'storm', from: NOW - 6 * MINUTE }]);
  // Complete only from six minutes ago: a day is more than that, so the day is not covered, and the dashboard says why.
  const d = await c.dashboard(S, api, index, { range: '24h' });
  assert.equal(d.coverage.truncatedJobs, 1);
  assert.equal(d.coverage.complete, false);
  assert.equal(d.notes.some((n) => /very busy job has more builds/.test(n)), true);
  // Once the job is known from further back than the slice begins, it is no longer a hole in it.
  c.store.setJobFrom(S, 'storm', NOW - 2 * DAY);
  c.dashCache.clear();
  const d2 = await c.dashboard(S, api, index, { range: '24h' });
  assert.equal(d2.coverage.truncatedJobs, 0);
  assert.equal(d2.coverage.complete, true);
});

test('a walk that is stopped goes on from where it stopped, and a folder that cannot be read is not the end of it', { skip }, async () => {
  const db = memory();
  const one = collector({ db, concurrency: 1 });
  const api = fakeApi();
  const b = (number) => ({ number, status: 'success', running: false, timestamp: NOW - HOUR, duration: 1000, estimated: null, agent: null, causes: [] });
  api.state.folders = { a: [{ path: 'a/j', builds: [b(1)] }], b: [{ path: 'b/j', builds: [b(1)] }], c: [{ path: 'c/j', builds: [b(1)] }], d: Object.assign(new Error('forbidden'), { status: 403 }), e: [{ path: 'e/j', builds: [b(1)] }] };
  const index = indexOf(['a', 'b', 'c', 'd', 'e'].map((f) => ({ path: `${f}/j`, last: last(1) })));
  one.c.store.activate(S);
  // The third request stops the world.
  let seen = 0;
  api.state.gate = async () => { seen += 1; if (seen === 3) one.c.stop(); };
  await one.c.afterPoll(S, api, index);
  while (one.c.backfills.size) await Promise.all([...one.c.backfills.values()]);
  assert.equal(one.c.store.serverRow(S).backfill, 'running', 'not done: it was stopped');
  assert.equal(one.c.store.foldersLeft(S).length > 0, true);
  const done = one.c.store.folderProgress(S);
  assert.equal(done.total, 5);
  assert.equal(done.done >= 2 && done.done < 5, true);

  // A new process, the same file.
  const two = collector({ db, concurrency: 1 });
  const again = fakeApi({ folders: api.state.folders });
  await two.c.afterPoll(S, again, index);
  while (two.c.backfills.size) await Promise.all([...two.c.backfills.values()]);
  assert.equal(two.c.store.serverRow(S).backfill, 'done');
  const walked = again.calls.filter((call) => call.startsWith('foldersBuilds')).map((call) => call.split(' ')[1]);
  assert.equal(walked.length <= 5 - done.done, true, 'only what was left');
  assert.equal(walked.some((f) => f === 'a'), false);
  const jobs = two.c.timeline(S, { from: NOW - DAY, to: NOW + HOUR }).runs.map((r) => r.path).sort();
  // `d` could not be read, so only the newest build of its job — which the job list gave — is there; and the walk of it is done, not retried for ever.
  assert.deepEqual(jobs, ['a/j', 'b/j', 'c/j', 'd/j', 'e/j']);
  assert.equal(two.c.store.foldersLeft(S).length, 0);
});

test('a folder that failed for another reason is tried again, not given up on', { skip }, async () => {
  const { c } = collector({ concurrency: 1 });
  const api = fakeApi();
  api.state.folders = { a: Object.assign(new Error('Jenkins answered 500'), { status: 500 }) };
  c.store.activate(S);
  await c.afterPoll(S, api, indexOf([{ path: 'a/j', last: last(1) }]));
  while (c.backfills.size) await Promise.all([...c.backfills.values()]);
  assert.equal(c.store.serverRow(S).backfill, 'running');
  assert.deepEqual(c.store.foldersLeft(S), ['a']);
});

test('a server forgotten while it is being read leaves nothing behind', { skip }, async () => {
  const { c } = collector({ concurrency: 1 });
  const api = fakeApi();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  api.state.gate = () => gate;
  api.state.folders = { a: [{ path: 'a/j', builds: [{ number: 1, status: 'success', running: false, timestamp: NOW - HOUR, duration: 1000, estimated: null, agent: null, causes: [] }] }] };
  c.store.activate(S);
  await c.afterPoll(S, api, indexOf([{ path: 'a/j', last: last(1) }]));
  assert.equal(c.backfills.size, 1);
  c.forgetServer(S);
  release();
  while (c.backfills.size) await Promise.all([...c.backfills.values()]);
  assert.deepEqual(c.store.stats(S), [], 'what came back after it was forgotten was not written');
  assert.equal(c.store.serverRow(S), null);
});

test('the failing stage of what failed is looked up for the jobs that failed most, once', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  for (let i = 0; i < 3; i += 1) put(c.store, 'a', i + 1, { ago: (i + 1) * HOUR, result: 'failed' });
  put(c.store, 'b', 1, { ago: HOUR, result: 'failed' });
  put(c.store, 'plain', 1, { ago: HOUR, result: 'failed' });
  api.state.runs.a = { available: true, runs: [
    { number: 1, stages: [{ name: 'Build', status: 'success', executed: true }, { name: 'Test', status: 'failed', executed: true }, { name: 'Deploy', status: 'skipped', executed: false }] },
    { number: 2, stages: [{ name: 'Test', status: 'failed', executed: true }] },
    { number: 3, stages: [{ name: 'Lint', status: 'failed', executed: true }, { name: 'Test', status: 'failed', executed: true }] },
  ] };
  api.state.runs.b = { available: true, runs: [{ number: 1, stages: [{ name: 'Deploy', status: 'failed', executed: false }, { name: 'Publish', status: 'failed', executed: true }] }] };
  const d = await c.dashboard(S, api, indexOf([]), { range: '24h' });
  assert.deepEqual(d.failures.byStage, [{ stage: 'Test', count: 2 }, { stage: 'Lint', count: 1 }, { stage: 'Publish', count: 1 }], 'the first stage that really ran and failed');
  assert.deepEqual(d.failures.stageCoverage, { known: 4, failed: 5 }, 'a job that is not a pipeline has no stage, and the number says so');
  const asked = api.calls.filter((call) => call.startsWith('runs ')).length;
  assert.equal(asked, 3);
  await c.dashboard(S, api, indexOf([]), { range: '24h' });
  assert.equal(api.calls.filter((call) => call.startsWith('runs ')).length, asked, 'settled: not asked again');
});

test('a job that is not a pipeline is found out once and not asked about again for a day', { skip }, async () => {
  const { c, tick } = collector();
  const api = fakeApi();   // every job here answers "no stages": not a pipeline
  put(c.store, 'plain', 1, { ago: 3 * HOUR, result: 'failed' });
  put(c.store, 'plain', 2, { ago: 2 * HOUR, result: 'failed' });
  await c.dashboard(S, api, indexOf([]), { range: '24h' });
  assert.deepEqual(api.calls.filter((call) => call.startsWith('runs ')), ['runs plain']);
  assert.deepEqual(c.store.unchecked(S, NOW - DAY, NOW + DAY), [], 'every failure of it is settled, not only the ones in the slice');
  // A new failure of the same job, an hour on: still not a pipeline, still not asked.
  tick(HOUR);
  put(c.store, 'plain', 3, { start: NOW + 30 * MINUTE, dur: 1000, result: 'failed' });
  await c.dashboard(S, api, indexOf([]), { range: '24h' });
  assert.equal(api.calls.filter((call) => call.startsWith('runs ')).length, 1);
  assert.deepEqual(c.store.unchecked(S, NOW - DAY, NOW + 2 * DAY), [], 'and that one is settled too');
  // A day later it may have become one, so it is asked once more.
  tick(DAY);
  put(c.store, 'plain', 4, { start: NOW + 24 * HOUR + 30 * MINUTE, dur: 1000, result: 'failed' });
  await c.dashboard(S, api, indexOf([]), { range: '24h' });
  assert.equal(api.calls.filter((call) => call.startsWith('runs ')).length, 2);
});

test('a slow answer about stages does not hold the dashboard up', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  put(c.store, 'a', 1, { ago: HOUR, result: 'failed' });
  let release;
  api.state.runsGate = new Promise((resolve) => { release = resolve; });
  api.state.runs.a = { available: true, runs: [{ number: 1, stages: [{ name: 'Test', status: 'failed', executed: true }] }] };
  const started = Date.now();
  const d = await c.dashboard(S, api, indexOf([]), { range: '24h' });
  assert.equal(Date.now() - started < 1000, true, 'the budget is a pause in the collector, which a test makes instant');
  assert.deepEqual(d.failures.byStage, [], 'and what is not yet known is simply not there yet');
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  c.dashCache.clear();
  const later = await c.dashboard(S, api, indexOf([]), { range: '24h' });
  assert.deepEqual(later.failures.byStage, [{ stage: 'Test', count: 1 }], 'it was learned in the background and is there next time');
});

test('a page that was just computed is the answer for a few seconds, and is shared while it is being computed', { skip }, async () => {
  const { c, tick } = collector();
  const api = fakeApi();
  put(c.store, 'a', 1, { ago: HOUR, result: 'failed' });
  const index = indexOf([]);
  const [one, two] = await Promise.all([c.dashboard(S, api, index, { range: '24h' }), c.dashboard(S, api, index, { range: '24h' })]);
  assert.equal(one, two, 'asked together, computed once');
  const requests = api.calls.length;
  tick(4000);
  assert.equal(await c.dashboard(S, api, index, { range: '24h' }), one, 'asked again within five seconds');
  assert.equal(api.calls.length, requests, 'and Jenkins was not asked again');
  assert.notEqual(await c.dashboard(S, api, index, { range: '7d' }), one, 'another range is another page');
  assert.notEqual(await c.dashboard(S, api, index, { range: '24h', utcOffsetMinutes: 60 }), one, 'and so is another time zone');
  assert.notEqual(await c.dashboard(S, api, index, { range: '24h', scope: { folder: 'a' } }), one, 'and another filter');
  tick(2000);
  assert.notEqual(await c.dashboard(S, api, index, { range: '24h' }), one, 'after that it is computed again');
  c.forgetServer(S);
  assert.equal(c.dashCache.size, 0, 'a forgotten server leaves no page behind');
});

test('the dashboard says in words what it cannot promise', { skip }, async () => {
  const { c, tick } = collector();
  const api = fakeApi();
  const first = await c.dashboard(S, api, indexOf([{ path: 'a', last: last(1, { timestamp: NOW - 40 * DAY }) }, { path: 'b', status: 'disabled', last: last(1, { timestamp: NOW - 40 * DAY }) }, { path: 'c', last: last(1) }]), { range: '24h' });
  assert.equal(first.notes.some((n) => /first time the dashboard is opened/.test(n)), true, JSON.stringify(first.notes));
  assert.equal(first.activity.staleJobs, 1, 'a disabled job is not stale, it is disabled');
  assert.equal(c.store.isActive(S), true, 'and from now on the server is sampled');
  tick(MINUTE);
  // The walk of the (empty) history is done, so a week is complete; a month is not, and says how far back it goes.
  const second = await c.dashboard(S, api, indexOf([], { truncated: true }), { range: '30d' });
  assert.equal(second.notes.some((n) => /first time/.test(n)), false);
  assert.equal(second.notes.some((n) => /History starts 7 days ago: the range is only partly covered/.test(n)), true, JSON.stringify(second.notes));
  assert.equal(second.notes.some((n) => /more jobs than this app reads/.test(n)), true, JSON.stringify(second.notes));
  assert.equal(second.activity.staleJobs, 0);
  const none = await c.dashboard(S, api, null, { range: '24h' });
  assert.equal(none.activity.staleJobs, null, 'without a job list it does not guess');
});

test('the verbs of the collector answer for the window and the instant asked, and refuse nonsense', { skip }, () => {
  const { c } = collector();
  put(c.store, 'a', 1, { start: NOW - 20 * MINUTE, dur: 10 * MINUTE });
  put(c.store, 'a', 2, { start: NOW - 5 * MINUTE, running: true });
  const day = c.timeline(S, { range: '24h' });
  assert.equal(day.runs.length, 2);
  assert.equal(day.range, '24h');
  assert.equal(day.to, NOW);
  assert.equal(c.timeline(S, { range: '1h' }).from, NOW - HOUR);
  // An explicit window is cut to a month and to the present, and a backwards one still answers.
  const wide = c.timeline(S, { from: 1, to: NOW + DAY });
  assert.equal(wide.to, NOW);
  assert.equal(wide.from >= NOW - 31 * DAY, true);
  assert.doesNotThrow(() => c.timeline(S, { from: NOW, to: NOW - HOUR }));
  assert.doesNotThrow(() => c.timeline(S, {}));
  assert.deepEqual(c.runningAt(S, { at: NOW - 15 * MINUTE }).running.map((r) => r.number), [1]);
  assert.deepEqual(c.runningAt(S, { at: NOW - MINUTE }).running.map((r) => r.number), [2]);
  assert.throws(() => c.runningAt(S, { at: 'soon' }), /time in milliseconds/);
  assert.throws(() => c.runningAt(S, {}), /time in milliseconds/);
  assert.throws(() => c.runningAt(S, { at: -5 }), /time in milliseconds/);
});

test('looking after a poll never throws and never overlaps itself, whatever Jenkins does', { skip }, async () => {
  const { c, tick } = collector();
  c.store.activate(S);
  const api = fakeApi({ runningError: new Error('boom'), buildsError: new Error('boom too') });
  api.queue = async () => { throw new Error('and this'); };
  const index = indexOf([{ path: 'a', last: last(5) }]);
  await assert.doesNotReject(c.afterPoll(S, api, index));
  await assert.doesNotReject(c.afterPoll(S, null, index));
  await assert.doesNotReject(c.afterPoll(S, api, null));
  // Two at once are one: the second finds the first still going and leaves.
  let release;
  const slow = fakeApi();
  slow.running = async () => { await new Promise((resolve) => { release = resolve; }); return slow.state.executors; };
  tick(2 * MINUTE);
  const first = c.afterPoll(S, slow, index);
  await new Promise((resolve) => setImmediate(resolve));
  const calls = slow.calls.length;
  await c.afterPoll(S, slow, index);
  assert.equal(slow.calls.length, calls, 'the second did nothing');
  release();
  await first;
  c.stop();
  await assert.doesNotReject(c.afterPoll(S, slow, index));
});

// ======================================================================================
// Through the service
// ======================================================================================

const { JenkinsService } = sqlite ? require('../electron/jenkins-service') : {};

/** What the history of a server is waiting for, in the background: the walk of its past, and what it asked of Jenkins for it. */
async function settle(svc) {
  for (let i = 0; i < 50; i += 1) {
    const walks = [...svc.metrics.backfills.values()];
    if (!walks.length) return;
    await Promise.all(walks);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A Jenkins small enough to be a table, with just the endpoints the dashboard touches. */
function jenkinsFor(state) {
  const requests = [];
  const reply = (body, headers = {}) => ({ status: 200, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, body: null, text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.from(JSON.stringify(body)) });
  const stub = (b) => ({ number: b.number, result: b.building ? null : b.result, building: Boolean(b.building), timestamp: b.timestamp, duration: b.duration ?? 0, estimatedDuration: 60_000, builtOn: 'linux-1', actions: [{ causes: [{ shortDescription: 'Started by user ana', userId: 'ana' }] }] });
  const fetch = async (url) => {
    const { pathname, search } = new URL(url);
    const query = decodeURIComponent(search);
    requests.push(`${pathname}${query}`);
    if (pathname === '/computer/api/json') {
      return reply({ computer: [{ displayName: 'linux-1', offline: false, numExecutors: 2, assignedLabels: [{ name: 'linux' }], executors: state.running.map((b) => ({ currentExecutable: { url: `https://ci.test/job/${b.path}/${b.number}/`, number: b.number, timestamp: b.timestamp, estimatedDuration: 60_000 } })), oneOffExecutors: [] }] }, { date: new Date(state.now()).toUTCString() });
    }
    if (pathname === '/queue/api/json') return reply({ items: [] });
    const parts = pathname.split('/').filter(Boolean);
    const names = [];
    while (parts[0] === 'job') { parts.shift(); names.push(decodeURIComponent(parts.shift())); }
    const path = names.join('/');
    if (query.includes('tree=jobs[') && query.includes('builds[')) {
      return reply({ jobs: Object.keys(state.jobs).filter((p) => (path ? p.startsWith(`${path}/`) : true) && p.split('/').length === (path ? path.split('/').length + 1 : 1)).map((p) => ({ _class: 'hudson.model.FreeStyleProject', name: p.split('/').pop(), fullName: p, builds: state.jobs[p].map(stub) })) });
    }
    if (query.includes('tree=jobs[')) {
      return reply({ jobs: Object.keys(state.jobs).filter((p) => p.split('/').length === 1).map((p) => ({ _class: 'hudson.model.FreeStyleProject', name: p, fullName: p, color: state.jobs[p][0].building ? 'blue_anime' : 'blue', lastBuild: stub(state.jobs[p][0]) })) });
    }
    if (query.includes('builds[')) return reply({ builds: (state.jobs[path] ?? []).map(stub) });
    return reply({});
  };
  return { fetch, requests };
}

function service(extra = {}) {
  const state = { now: () => clock.now, running: [], jobs: {}, ...extra.state };
  const clock = { now: NOW };
  const jenkins = jenkinsFor(state);
  const svc = new JenkinsService({ db: memory(), fetch: jenkins.fetch, now: () => clock.now, sleep: async () => {}, nudgeMs: [], notify: () => {}, emit: () => {} });
  return { svc, state, clock, jenkins, call: (name, args) => svc.call(name, args) };
}
const build = (number, ago, extra = {}) => ({ number, result: 'SUCCESS', timestamp: NOW - ago, duration: 60_000, ...extra });

test('through the service: nothing extra is asked of Jenkins until the dashboard is opened, then it is', { skip }, async () => {
  const { svc, state, jenkins, call } = service({ state: { jobs: { app: [build(5, 10 * MINUTE)] } } });
  const id = (await call('saveServer', { name: 'ci', url: 'https://ci.test', user: 'a', token: 't' })).id;
  await call('home', { server: id });
  await svc.poll(id);
  await svc.poll(id);
  // What only the history asks: the recent builds of jobs, with who started them and where they ran.
  const mine = () => jenkins.requests.filter((r) => /builds\[number,result,building,timestamp,duration,builtOn/.test(r));
  assert.equal(mine().length, 0, `polling, and the home, read none of it: ${JSON.stringify(mine().map((r) => r.slice(0, 150)))}`);
  await svc.poll(id);
  await settle(svc);
  assert.equal(mine().length, 0, 'and polling again does not either');

  const d = await call('dashboard', { server: id, range: '24h' });
  assert.equal(d.ok, undefined);
  assert.equal(d.range, '24h');
  assert.equal(d.live.executors.total, 2);
  await settle(svc);
  assert.equal(mine().length > 0, true, 'the dashboard starts reading the past of the server');
  assert.equal(svc.metrics.store.isActive(id), true);
  assert.equal(d.kpi.finished.count >= 1, true, 'the build the index showed is in the history');
  assert.equal(d.notes.some((n) => /first time the dashboard/.test(n)), true);
  svc.stop();
});

test('through the service: the three verbs answer, check what they are given, and are for one server', { skip }, async () => {
  const { svc, state, clock, call } = service({ state: { jobs: { app: [build(5, 10 * MINUTE)] } } });
  const id = (await call('saveServer', { name: 'ci', url: 'https://ci.test', user: 'a', token: 't' })).id;
  state.running = [{ path: 'app', number: 6, timestamp: NOW - MINUTE }];
  state.jobs.app = [{ number: 6, building: true, timestamp: NOW - MINUTE }, build(5, 10 * MINUTE)];
  const d = await call('dashboard', { server: id, range: '1h', utcOffsetMinutes: -180 });
  assert.equal(d.live.runs[0].path, 'app');
  assert.equal(d.live.runs[0].number, 6);
  assert.equal(d.live.runs[0].agent, 'linux-1');
  assert.equal(d.live.runs[0].trigger, 'ana');
  assert.equal(d.bucketMs, MINUTE);

  assert.match((await call('dashboard', { server: id, range: 'forever' })).error, /range has to be 1h, 24h, 7d or 30d/);
  assert.match((await call('dashboard', { server: 'nope' })).error, /not set up/);
  assert.match((await call('timeline', { server: id, range: '5y' })).error, /range has to be/);
  assert.match((await call('runningAt', { server: id, at: 'x' })).error, /time in milliseconds/);

  const t = await call('timeline', { server: id, range: '24h' });
  assert.equal(t.runs.some((r) => r.path === 'app' && r.number === 6 && r.status === 'running'), true);
  const at = await call('runningAt', { server: id, at: NOW - 30_000 });
  assert.equal(at.running.some((r) => r.number === 6), true);
  assert.equal(at.running.find((r) => r.number === 6).stage, null);
  assert.equal(clock.now, NOW);
  svc.stop();
});

test('through the service: forgetting a build, a job or a server takes its history too; so does a new address', { skip }, async () => {
  const { svc, state, call } = service({ state: { jobs: { app: [build(5, 10 * MINUTE), build(4, 20 * MINUTE)], web: [build(2, 20 * MINUTE)], keep: [build(1, 30 * MINUTE)] } } });
  const id = (await call('saveServer', { name: 'ci', url: 'https://ci.test', user: 'a', token: 't' })).id;
  await call('dashboard', { server: id });
  await settle(svc);
  const count = () => svc.metrics.store.stats(id).reduce((n, row) => n + row.builds, 0);
  const before = count();
  assert.equal(before, 4, 'every build the walk of the past found');
  await call('forget', { server: id, path: 'app', number: 5 });
  assert.equal(count(), before - 1);
  await call('forget', { server: id, path: 'web' });
  assert.equal(count(), 2);
  assert.equal(svc.metrics.store.timeline(id, { from: 0, to: NOW + HOUR, now: NOW }).runs.some((r) => r.path === 'web'), false);
  // A new address is a different Jenkins: what was kept of the old one says nothing about it.
  assert.equal(count() >= 1, true);
  await call('saveServer', { id, name: 'ci', url: 'https://other.test', user: 'a', token: 't' });
  assert.equal(count(), 0);
  // A new name is not.
  await call('saveServer', { id, name: 'ci', url: 'https://other.test', user: 'a', token: 't' });
  await call('dashboard', { server: id }).catch(() => {});
  await call('deleteServer', { id });
  assert.deepEqual(svc.metrics.store.stats(id), []);
  assert.equal(svc.metrics.store.serverRow(id), null);
  void state;
  svc.stop();
});

// ======================================================================================
// What a review found: builds lost after a gap, a comparison with nothing, flakiness, the red of jobs that are gone
// ======================================================================================

test('builds that went by while nobody looked are all read, over as many polls as it takes, and the page says so until they are', { skip }, async () => {
  const { c, tick } = collector();
  covered(c.store);
  c.store.activate(S);
  const api = fakeApi();
  const jobs = Array.from({ length: 40 }, (_, j) => `job${j}`);
  // The history knows build 10 of every job; Jenkins is at 13: three builds each (120 in all) were missed.
  for (const path of jobs) {
    put(c.store, path, 10, { ago: DAY });
    api.state.history[path] = [13, 12, 11].map((number) => ({ number, status: 'success', running: false, timestamp: NOW - (14 - number) * HOUR, duration: 1000, causes: [] }));
  }
  const index = indexOf(jobs.map((path) => ({ path, last: last(13) })));
  const count = () => c.store.timeline(S, { from: NOW - 2 * DAY, to: NOW + HOUR, limit: 1000 }).runs.filter((r) => r.number > 10).length;
  const seen = [];
  for (let poll = 0; poll < 5; poll += 1) {
    await c.afterPoll(S, api, index);
    tick(1000);
    seen.push(count());
  }
  assert.deepEqual(seen.slice(0, 3), [36, 72, 108], 'twelve jobs a poll, none given up');
  assert.equal(seen[3], 120, 'and all of them in the end');
  const early = collector();
  covered(early.c.store);
  early.c.store.activate(S);
  for (const path of jobs) put(early.c.store, path, 10, { ago: DAY });
  await early.c.afterPoll(S, api, index);
  const half = await early.c.dashboard(S, api, index, { range: '24h' });
  assert.equal(half.coverage.pendingGaps, 28);
  assert.equal(half.coverage.complete, false, 'not complete while builds are waiting to be read');
  assert.equal(half.notes.some((n) => /still being read \(28 jobs left\)/.test(n)), true, JSON.stringify(half.notes));
  const whole = await c.dashboard(S, api, index, { range: '24h' });
  assert.equal(whole.coverage.pendingGaps, 0);
  assert.equal(whole.coverage.complete, true);
});

test('a job that cannot be read does not hold the others back, and is tried again later', { skip }, async () => {
  const { c, tick } = collector();
  covered(c.store);
  c.store.activate(S);
  const api = fakeApi();
  for (const path of ['bad', 'good']) {
    put(c.store, path, 1, { ago: DAY });
    api.state.history[path] = [3, 2].map((number) => ({ number, status: 'success', running: false, timestamp: NOW - (4 - number) * HOUR, duration: 1000, causes: [] }));
  }
  const index = indexOf([{ path: 'bad', last: last(3) }, { path: 'good', last: last(3) }]);
  const realBuilds = api.buildsOf;
  api.buildsOf = async (path, options) => { if (path === 'bad' && api.state.broken) throw new Error('boom'); return realBuilds(path, options); };
  api.state.broken = true;
  await c.afterPoll(S, api, index);
  const numbers = (path) => c.store.timeline(S, { from: NOW - 2 * DAY, to: NOW + HOUR }).runs.filter((r) => r.path === path).map((r) => r.number).sort();
  assert.deepEqual(numbers('good'), [1, 2, 3]);
  assert.deepEqual(numbers('bad'), [1], 'nothing of what could not be read is recorded as if it were');
  api.state.broken = false;
  tick(MINUTE);
  await c.afterPoll(S, api, index);
  assert.deepEqual(numbers('bad'), [1], 'not asked again at once');
  tick(6 * MINUTE);
  await c.afterPoll(S, api, index);
  assert.deepEqual(numbers('bad'), [1, 2, 3], 'asked again after a while, and then it is all there');
});

test('the period before is compared only when the history reaches back that far', { skip }, () => {
  const m = store();
  for (let i = 0; i < 20; i += 1) put(m, `j${i}`, 1, { ago: (i + 1) * 6 * HOUR, result: 'failed' });
  covered(m, 6);
  const week = m.dashboard(S, { range: '7d', now: NOW });
  assert.equal(week.coverage.previousComplete, false);
  assert.deepEqual(week.kpi.failed, { count: 20, prev: null }, 'no baseline, no "from zero"');
  assert.equal(week.kpi.rate.prev, null);
  assert.equal(week.kpi.duration.prevAvg, null);
  assert.equal(week.notes.some((n) => /does not reach back far enough/.test(n)), true);
  // A day is well inside six days of history: it has a day before.
  assert.equal(m.dashboard(S, { range: '24h', now: NOW }).coverage.previousComplete, true);
  covered(m, 30);
  const both = m.dashboard(S, { range: '7d', now: NOW });
  assert.equal(both.coverage.previousComplete, true);
  assert.equal(both.kpi.failed.prev, 0);
});

test('flaky is passing and failing again and again; one outage, or a few long ones, is not', { skip }, () => {
  const run = (name, pattern) => [...pattern].forEach((ch, i) => put(covered(m), name, i + 1, { ago: (pattern.length - i) * HOUR, result: ch === 'S' ? 'success' : ch === 'U' ? 'unstable' : 'failed' }));
  const m = store();
  run('outage', 'SSFFSS');
  run('alternating', 'SFSFSFSS');
  run('longs', 'SFFFSSFFFS');
  run('twice', 'SFSS');
  const d = dash(m);
  assert.deepEqual(d.failures.flaky.map((f) => f.path), ['alternating']);
  assert.equal(d.failures.flaky[0].flips, 6);
  // Unstable counts as passing again, the same as everywhere else a job is "red" or not.
  const u = covered(store());
  [['F', 4], ['U', 3], ['F', 2], ['S', 1]].forEach(([r, h], i) => put(u, 'mixed', i + 1, { ago: h * HOUR, result: r === 'F' ? 'failed' : r === 'U' ? 'unstable' : 'success' }));
  const f = dash(u).failures;
  assert.equal(f.incidents, 2, 'failed, unstable (back), failed again: two incidents');
  assert.equal(f.open, 0);
});

test('the success rate of deployments is the same as the success rate of everything else: unstable is not a success', { skip }, () => {
  const m = covered(store());
  ['success', 'unstable', 'unstable', 'failed'].forEach((result, i) => put(m, 'app/Deploy PROD', i + 1, { ago: (i + 1) * HOUR, result }));
  const d = dash(m);
  assert.equal(d.kpi.rate.value, 0.25);
  assert.equal(d.activity.deploys.successRate, 0.25);
  assert.deepEqual([d.activity.deploys.finished, d.activity.deploys.failed], [4, 1]);
});

test('jobs that are deleted, disabled or in an old folder are not red now, whatever their last build said', { skip }, async () => {
  const { c } = collector();
  covered(c.store);
  const api = fakeApi();
  for (const path of ['live', 'gone', 'paused', 'Legacy/x', 'KUBRIK (old)/y']) put(c.store, path, 1, { ago: 2 * HOUR, result: 'failed' });
  const index = indexOf([{ path: 'live', last: last(1) }, { path: 'paused', status: 'disabled', last: last(1) }, { path: 'Legacy/x', last: last(1) }, { path: 'KUBRIK (old)/y', last: last(1) }]);
  await c.afterPoll(S, api, index);
  const d = await c.dashboard(S, api, index, { range: '24h' });
  assert.equal(d.failures.open, 1, 'only the one that is there and enabled');
  assert.deepEqual(c.store.redJobs(S).map((r) => r.path), ['live']);
  // Back in service: red again.
  index.rows.get('paused').status = 'success';
  await c.afterPoll(S, api, index);
  assert.deepEqual(c.store.redJobs(S).map((r) => r.path).sort(), ['live', 'paused']);
});

test('the instant asked for is the instant answered, fractions and all', { skip }, () => {
  const m = covered(store());
  put(m, 'a', 1, { start: NOW - 10 * MINUTE, dur: 8 * MINUTE });
  const at = NOW - 5 * MINUTE + 0.5;
  const out = m.runningAt(S, at, { now: NOW });
  assert.equal(out.at, at);
  assert.equal(out.requestedAt, at);
  assert.equal(out.running.length, 1);
  const { c } = collector();
  assert.equal(c.runningAt(S, { at: at + 0.25 }).at, at + 0.25);
  assert.throws(() => c.runningAt(S, { at: 'soon' }), /milliseconds/);
});

test('a build that holds no executor and a pipeline that waits for a person are told apart', { skip }, async () => {
  const stagesNow = async () => Object.assign(new Map([['ask', 'Approve'], ['sleep', 'Wait']]), { inputs: new Set(['ask']) });
  const { c } = collector({ stagesNow });
  const api = fakeApi({ executors: { serverDate: NOW, agents: [], builds: [], executors: { busy: 0, total: 2 } } });
  const run = (path) => ({ path, running: true, last: last(4, { running: true, status: 'running', timestamp: NOW - 2 * DAY }) });
  const index = indexOf([run('ask'), run('sleep')]);
  const live = await c.live(S, api, index, { fresh: true });
  const ask = live.runs.find((r) => r.path === 'ask');
  const sleep = live.runs.find((r) => r.path === 'sleep');
  assert.deepEqual([ask.holdsNoExecutor, ask.waitingForInput, ask.waiting, ask.stuck], [true, true, true, false], 'waiting for input is not stuck');
  assert.deepEqual([sleep.holdsNoExecutor, sleep.waitingForInput, sleep.waiting], [true, false, true], 'a sleep holds no executor and asks nobody anything');
});
