'use strict';

/**
 * What a lead reads off the history: the filters that narrow every number to
 * the same builds, the board of services by environment, the heatmap, the
 * cards that say what needs a look, the summary to paste, the wall screen.
 *
 * Every card is a claim, so every test builds the history that makes it true
 * and one where it is not, and checks the numbers in `evidence` against what
 * was put in by hand.
 *
 * Needs `node:sqlite` (Node 22+) and skips itself without it.
 */

const test = require('node:test');
const assert = require('node:assert');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

const metrics = sqlite ? require('../electron/jenkins-metrics') : {};
const insights = sqlite ? require('../electron/jenkins-insights') : {};
const { JenkinsMetrics, MetricsCollector, normalizeScope, scopeKey, matchScope, DAY, MINUTE, HOUR } = metrics;

const NOW = Date.parse('2026-10-16T12:00:00Z');   // a Friday
const S = 'srv';
const memory = () => new sqlite.DatabaseSync(':memory:');

function put(m, path, number, { ago = 0, start = null, dur = 60_000, result = 'success', running = false, agent = null, who = null, server = S } = {}) {
  const timestamp = start ?? NOW - ago;
  const build = { number, timestamp, duration: dur, status: running ? 'running' : result, running, agent };
  if (who) { build.cause = 'user'; build.who = who; }
  assert.equal(m.upsertBuild(server, path, build, NOW), true);
}

/** A Jenkins that is not there, with every call the page makes answered from a table, and counted. */
function fakeApi(state = {}) {
  const api = {
    calls: [],
    state: { executors: { serverDate: NOW, agents: [], builds: [], executors: { busy: 0, total: 0 } }, queue: [], history: {}, runs: {}, views: {}, me: { id: 'ana', name: 'Ana R.' }, params: {}, changes: {}, ...state },
    async running() { api.calls.push('running'); return api.state.executors; },
    async queue() { api.calls.push('queue'); return api.state.queue; },
    async buildsOf(path, { limit = 30 } = {}) { api.calls.push(`buildsOf ${path}`); return (api.state.history[path] ?? []).slice(0, limit); },
    async foldersBuilds() { return { jobs: [] }; },
    async runs(path) { api.calls.push(`runs ${path}`); return api.state.runs[path] ?? { available: false, runs: [] }; },
    async viewJobs(view) { api.calls.push(`viewJobs ${view}`); if (api.state.views[view] instanceof Error) throw api.state.views[view]; return api.state.views[view] ?? []; },
    async whoami() { api.calls.push('whoami'); return api.state.me; },
    async buildParams(path, number) {
      api.calls.push(`buildParams ${path} ${number}`);
      const answer = api.state.params[`${path}#${number}`];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    async buildChanges(path, number) { api.calls.push(`buildChanges ${path} ${number}`); return api.state.changes[`${path}#${number}`] ?? []; },
  };
  return api;
}

const jobRow = (path, extra = {}) => ({ kind: 'job', path, name: path.split('/').pop(), status: 'success', running: false, last: null, ...extra });
const folderRow = (path, extra = {}) => ({ kind: 'folder', path, name: path.split('/').pop(), status: 'none', running: false, last: null, ...extra });
/** History complete back two months: what a server that has been watched for a while looks like. */
const covered = (c) => { c.store.setBackfill(S, 'running', { windowStart: NOW - 60 * DAY }); c.store.setBackfill(S, 'done'); return c; };
const indexOf = (rows, extra = {}) => ({ rows: new Map(rows.map((row) => [row.path, row])), truncated: false, ...extra });
const lastOf = (number, extra = {}) => ({ number, status: 'success', running: false, timestamp: NOW - 10 * MINUTE, duration: 60_000, ...extra });

function collector(extra = {}) {
  let now = NOW;
  const db = extra.db ?? memory();
  const c = new MetricsCollector({ db, now: () => now, pause: 0, ...extra });
  return { c, db, tick: (ms) => { now += ms; }, clock: () => now };
}

// ======================================================================================
// Filters
// ======================================================================================

test('a filter is held to what is known, and spelled one way', { skip }, () => {
  assert.deepEqual(normalizeScope(null), {});
  assert.deepEqual(normalizeScope([]), {});
  assert.deepEqual(normalizeScope('x'), {});
  assert.deepEqual(normalizeScope({ folder: ' /a/b/ ', view: 'QA/Smoke', pattern: '*-PROD', branch: 'main', trigger: 'ana', mine: true, result: 'failed', nonsense: 1 }), {
    folder: 'a/b', view: 'QA/Smoke', pattern: '*-PROD', branch: 'main', trigger: 'ana', mine: true, result: 'failed',
  });
  // What is not a string, not a known result, not literally true, is nothing.
  assert.deepEqual(normalizeScope({ folder: 5, pattern: {}, result: 'exploded', mine: 'yes', trigger: '', branch: '\u0000' }), {});
  assert.equal(normalizeScope({ pattern: 'x\ny' }).pattern, 'x y');
  assert.equal(normalizeScope({ folder: 'a'.repeat(5000) }).folder.length, 1000);
  assert.equal(scopeKey({ folder: 'a', mine: true }), scopeKey({ mine: true, folder: 'a' }));
  assert.notEqual(scopeKey({ folder: 'a' }), scopeKey({ folder: 'b' }));
});

/** Builds that are the same in every way except what a filter looks at. */
function seedScope(m) {
  put(m, 'KUBRIK/TIMELOG/api DEV', 1, { ago: 5 * HOUR, who: 'ana', result: 'failed' });
  put(m, 'KUBRIK/TIMELOG/api DEV', 2, { ago: 4 * HOUR, who: 'bob' });
  put(m, 'KUBRIK/TIMELOG/api PROD', 1, { ago: 3 * HOUR, who: 'SCM change' });
  put(m, 'KUBRIK/KS/web DEV', 1, { ago: 2 * HOUR, who: 'ana' });
  put(m, 'KUBRIK/KS/web DEV', 2, { ago: 1 * HOUR, who: 'upstream: KUBRIK/TIMELOG/api DEV', result: 'failed' });
  put(m, 'KUBRIKX/other', 1, { ago: HOUR });                       // a sibling whose name begins like the folder
  put(m, 'app/feature%2Fx', 1, { ago: HOUR, who: 'timer', result: 'unstable' });
  put(m, 'app/main', 1, { ago: HOUR, who: 'timer' });
}

test('a folder is what is under it, and not what merely starts like it', { skip }, () => {
  const m = new JenkinsMetrics(memory(), { now: () => NOW });
  seedScope(m);
  const count = (scope) => m.dashboard(S, { range: '24h', now: NOW, scope }).kpi.finished.count;
  assert.equal(count(null), 8);
  assert.equal(count({ folder: 'KUBRIK' }), 5, 'KUBRIKX is not under KUBRIK');
  assert.equal(count({ folder: 'KUBRIK/TIMELOG' }), 3);
  assert.equal(count({ folder: 'KUBRIK/KS' }), 2);
  assert.equal(count({ folder: 'KUBRIK/TIMELOG/api DEV' }), 0, 'a job is not a folder');
  assert.equal(count({ folder: 'nothing' }), 0);
});

test('a name pattern is a word in the path, or a pattern with wildcards, whatever the case', { skip }, () => {
  const m = new JenkinsMetrics(memory(), { now: () => NOW });
  seedScope(m);
  const count = (scope) => m.dashboard(S, { range: '24h', now: NOW, scope }).kpi.finished.count;
  assert.equal(count({ pattern: 'api' }), 3);
  assert.equal(count({ pattern: 'PROD' }), 1);
  assert.equal(count({ pattern: 'web dev' }), 2);
  assert.equal(count({ pattern: '*DEV' }), 4, 'api DEV x2, web DEV x2');
  assert.equal(count({ pattern: 'KUBRIK/*/api*' }), 3);
  assert.equal(count({ pattern: '*api ???' }), 2, 'one character each: "api DEV" and not "api PROD"');
  assert.equal(count({ pattern: 'api ???' }), 0, 'with a wildcard it has to match the whole path, as a glob does');
  assert.equal(count({ pattern: '100%' }), 0, 'a percent sign is a character, not "anything"');
  assert.equal(count({ pattern: '_' }), 0, 'and so is an underscore');
  assert.equal(count({ pattern: "x'; DROP TABLE jm_build; --" }), 0);
  assert.equal(m.stats(S)[0].builds, 8);
});

test('a branch is the last part of a path, in the spelling Jenkins uses', { skip }, () => {
  const m = new JenkinsMetrics(memory(), { now: () => NOW });
  seedScope(m);
  const count = (scope) => m.dashboard(S, { range: '24h', now: NOW, scope }).kpi.finished.count;
  assert.equal(count({ branch: 'main' }), 1);
  assert.equal(count({ branch: 'feature%2Fx' }), 1);
  assert.equal(count({ branch: 'feature' }), 0);
  assert.equal(count({ branch: 'DEV' }), 0, 'the end of a name is not a branch');
});

test('who started a build, and how it ended, narrow every number the same way', { skip }, () => {
  const m = new JenkinsMetrics(memory(), { now: () => NOW });
  seedScope(m);
  const page = (scope) => m.dashboard(S, { range: '24h', now: NOW, scope });
  assert.equal(page({ trigger: 'ana' }).kpi.finished.count, 2);
  assert.equal(page({ trigger: 'ANA' }).kpi.finished.count, 2, 'case does not matter');
  assert.equal(page({ trigger: 'scm' }).kpi.finished.count, 1);
  assert.equal(page({ trigger: 'timer' }).kpi.finished.count, 2);
  assert.equal(page({ trigger: 'upstream' }).kpi.finished.count, 1);
  assert.equal(page({ trigger: 'nobody' }).kpi.finished.count, 0);
  assert.equal(page({ user: 'ana' }).kpi.finished.count, 2);
  assert.equal(page({ result: 'failed' }).kpi.finished.count, 2);
  assert.equal(page({ result: 'unstable' }).kpi.unstable.count, 1);
  const both = page({ result: 'failed', trigger: 'ana' });
  assert.equal(both.kpi.finished.count, 1);
  assert.deepEqual(both.failures.topJobs.map((j) => j.path), ['KUBRIK/TIMELOG/api DEV']);
});

test('every number on a filtered page is about the same builds, which a filter that missed one would break', { skip }, () => {
  const m = new JenkinsMetrics(memory(), { now: () => NOW });
  seedScope(m);
  for (const scope of [null, { folder: 'KUBRIK' }, { pattern: 'dev' }, { trigger: 'ana' }, { result: 'failed' }, { folder: 'KUBRIK/TIMELOG', trigger: 'bob' }]) {
    const d = m.dashboard(S, { range: '24h', now: NOW, scope });
    const label = JSON.stringify(scope);
    assert.equal(d.buckets.reduce((n, b) => n + b.started, 0), d.kpi.started.count, `${label}: buckets add up to what started`);
    assert.equal(d.buckets.reduce((n, b) => n + b.success + b.failed + b.unstable + b.aborted, 0), d.kpi.finished.count, `${label}: and to what finished`);
    assert.equal(d.byHour.reduce((a, b) => a + b, 0), d.kpi.started.count, `${label}: the hours too`);
    assert.equal(d.byWeekday.reduce((a, b) => a + b, 0), d.kpi.started.count, `${label}: and the weekdays`);
    assert.equal(d.activity.mostBuilt.reduce((n, j) => n + j.runs, 0) <= d.kpi.started.count, true, label);
    assert.equal(d.failures.topJobs.reduce((n, j) => n + j.failed, 0), d.kpi.failed.count, `${label}: the jobs that failed add up to what failed`);
    assert.equal(Math.round(d.capacity.byJob.reduce((n, j) => n + j.share, 0) * 1000) / 1000 <= 1.0001, true, label);
  }
});

test('a filter in SQL and the same filter in JavaScript pick the same jobs', { skip }, () => {
  // What is running now is not in the database, so the same rules are written twice; this holds them to each other.
  const m = new JenkinsMetrics(memory(), { now: () => NOW });
  const paths = ['KUBRIK/TIMELOG/api DEV', 'KUBRIK/TIMELOG/api PROD', 'KUBRIK/KS/web DEV', 'KUBRIKX/other', 'app/feature%2Fx', 'app/main', 'top', 'a_b%c', 'Team/WEB prod'];
  paths.forEach((path, i) => put(m, path, 1, { ago: (i + 1) * 10 * MINUTE }));
  const scopes = [{ folder: 'KUBRIK' }, { folder: 'app' }, { pattern: 'api' }, { pattern: '*prod' }, { pattern: 'KUBRIK/*/web*' }, { pattern: 'a_b' }, { pattern: '%' }, { branch: 'main' }, { branch: 'feature%2Fx' }, { pattern: 'WEB PROD' }, {}];
  for (const scope of scopes) {
    const sql = m.dashboard(S, { range: '24h', now: NOW, scope }).failures; void sql;
    const fromSql = m.timeline(S, { from: NOW - DAY, to: NOW, now: NOW, scope }).runs.map((r) => r.path).sort();
    const fromJs = paths.filter((path) => matchScope(scope, path)).sort();
    assert.deepEqual(fromSql, fromJs, JSON.stringify(scope));
  }
});

test('the same filter narrows the instant and the timeline too', { skip }, () => {
  const m = new JenkinsMetrics(memory(), { now: () => NOW });
  seedScope(m);
  const at = NOW - 3 * HOUR + 10_000;
  assert.equal(m.runningAt(S, at, { now: NOW, scope: null }).running.length, 1);
  assert.deepEqual(m.runningAt(S, NOW - 3 * HOUR + 10_000, { now: NOW, scope: { folder: 'KUBRIK/TIMELOG' } }).running.map((r) => r.path), ['KUBRIK/TIMELOG/api PROD']);
  assert.deepEqual(m.runningAt(S, NOW - 3 * HOUR + 10_000, { now: NOW, scope: { folder: 'KUBRIK/KS' } }).running, []);
  assert.equal(m.timeline(S, { from: NOW - DAY, to: NOW, now: NOW, scope: { trigger: 'ana' } }).runs.length, 2);
});

test('through the collector: a view, "mine", and a view that cannot be read', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi({ views: { 'QA/Smoke': [{ kind: 'job', path: 'KUBRIK/KS/web DEV' }, { kind: 'folder', path: 'app' }], Broken: Object.assign(new Error('nope'), { status: 404 }) } });
  seedScope(c.store);
  const index = indexOf([jobRow('KUBRIK/KS/web DEV'), jobRow('app/main'), jobRow('app/feature%2Fx'), jobRow('KUBRIK/TIMELOG/api DEV'), jobRow('KUBRIK/TIMELOG/api PROD')]);

  const view = await c.dashboard(S, api, index, { range: '24h', scope: { view: 'QA/Smoke' } });
  assert.equal(view.kpi.finished.count, 4, 'the job named, and everything under the folder named');
  assert.equal(api.calls.filter((call) => call === 'viewJobs QA/Smoke').length, 1);
  await c.dashboard(S, api, index, { range: '7d', scope: { view: 'QA/Smoke' } });
  assert.equal(api.calls.filter((call) => call === 'viewJobs QA/Smoke').length, 1, 'a view is read once a minute, not once a page');

  const smart = await c.dashboard(S, api, indexOf([jobRow('KUBRIK/KS/web DEV', { status: 'failed' }), jobRow('app/main')]), { range: '24h', scope: { view: 'smart:failing' } });
  assert.equal(smart.kpi.finished.count, 2, 'the app\'s own views too');

  const mine = await c.dashboard(S, api, index, { range: '24h', scope: { mine: true } });
  assert.equal(mine.kpi.finished.count, 2, 'ana started two');
  assert.equal(api.calls.filter((call) => call === 'whoami').length, 1);
  await c.dashboard(S, api, index, { range: '7d', scope: { mine: true } });
  assert.equal(api.calls.filter((call) => call === 'whoami').length, 1, 'who you are is asked once in a while');

  const broken = await c.dashboard(S, api, index, { range: '24h', scope: { view: 'Broken' } });
  assert.equal(broken.kpi.finished.count, 0, 'a view that cannot be read has no jobs: showing everything would be a lie');
  assert.equal(broken.notes.some((n) => /could not be read, so nothing matches/.test(n)), true);

  api.state.me = null;
  c.dashCache.clear(); c.meCache.clear();
  const nobody = await c.dashboard(S, api, index, { range: '24h', scope: { mine: true } });
  assert.equal(nobody.kpi.finished.count, 0);
  assert.equal(nobody.notes.some((n) => /user could not be determined/.test(n)), true);
  const odd = await c.dashboard(S, api, index, { range: '24h', scope: { view: 'smart:made-up' } });
  assert.equal(odd.kpi.finished.count, 0);
});

test('the live list is narrowed too, and the executors stay the whole server\'s', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi({
    executors: {
      serverDate: NOW,
      agents: [{ name: 'a1', offline: false, busy: 2, executors: 2, labels: [] }],
      builds: [
        { path: 'team/web DEV', number: 4, timestamp: NOW - MINUTE, estimated: null, agents: ['a1'] },
        { path: 'other/job', number: 9, timestamp: NOW - MINUTE, estimated: null, agents: ['a1'] },
      ],
      executors: { busy: 2, total: 2 },
    },
    queue: [{ id: 1, path: 'team/web PROD', since: NOW - MINUTE, why: 'x', stuck: false, blocked: false }, { id: 2, path: 'other/q', since: NOW - MINUTE, why: 'y', stuck: false, blocked: false }],
  });
  const index = indexOf([jobRow('team/web DEV'), jobRow('other/job')]);
  const all = await c.dashboard(S, api, index, { range: '24h' });
  assert.equal(all.live.running, 2);
  assert.equal(all.live.queued, 2);
  const team = await c.dashboard(S, api, index, { range: '24h', scope: { folder: 'team' } });
  assert.deepEqual(team.live.runs.map((r) => r.path), ['team/web DEV']);
  assert.deepEqual(team.live.queue.map((q) => q.path), ['team/web PROD']);
  assert.equal(team.live.running, 1);
  assert.equal(team.live.queued, 1);
  assert.deepEqual(team.live.executors, { busy: 2, total: 2 }, 'the server has the executors it has');
  assert.equal(team.notes.some((n) => /Filtered/.test(n)), true);
  // A queued item has no one who started it yet, so a filter about who cannot match it.
  const ana = await c.dashboard(S, api, index, { range: '24h', scope: { trigger: 'ana' } });
  assert.equal(ana.live.queued, 0);
});

// ======================================================================================
// Capacity and delivery
// ======================================================================================

test('where the executor time went, by job and by folder, and how much of what there was was used', { skip }, () => {
  const m = new JenkinsMetrics(memory(), { now: () => NOW });
  put(m, 'team1/e2e', 1, { ago: 5 * HOUR, dur: 3 * HOUR });
  put(m, 'team1/e2e', 2, { ago: 3 * HOUR, dur: 1 * HOUR });
  put(m, 'team2/build', 1, { ago: 2 * HOUR, dur: 1 * HOUR, result: 'aborted' });
  put(m, 'solo', 1, { ago: 2 * HOUR, dur: HOUR });
  for (let i = 0; i < 60; i += 1) m.recordSample(S, { t: NOW - (i + 1) * MINUTE, running: 1, queued: 0, busy: i < 30 ? 2 : 1, total: 2 });
  const cap = m.dashboard(S, { range: '24h', now: NOW }).capacity;
  assert.deepEqual(cap.byJob.map((j) => [j.path, j.hours]), [['team1/e2e', 4], ['solo', 1], ['team2/build', 1]]);
  assert.equal(cap.byJob[0].share, 4 / 6);
  assert.deepEqual(cap.byFolder.map((f) => [f.folder, f.hours]), [['team1', 4], ['', 1], ['team2', 1]], 'root jobs are the folder called ""');
  // Sixty minute-samples: 30 with both executors busy, 30 with one; two executors throughout.
  assert.deepEqual(cap.utilisation, { busyHours: 1.5, availableHours: 2, ratio: 0.75, sampleMinutes: 60 });
  assert.deepEqual(m.dashboard('nobody', { range: '24h', now: NOW }).capacity.utilisation, { busyHours: 0, availableHours: 0, ratio: null, sampleMinutes: 0 });
});

test('deployments are the jobs that are the last environment of a service', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  const rows = [folderRow('app'), jobRow('app/web DEV'), jobRow('app/web PROD'), jobRow('app/api DEV'), jobRow('app/api PROD'), jobRow('lib/build')];
  // Four production deployments of web (one failed, then fixed), one of api; DEV builds are not deployments.
  put(c.store, 'app/web PROD', 1, { start: NOW - 20 * HOUR, dur: 60_000 });
  put(c.store, 'app/web PROD', 2, { start: NOW - 10 * HOUR, dur: 60_000, result: 'failed' });
  put(c.store, 'app/web PROD', 3, { start: NOW - 8 * HOUR, dur: 60_000 });
  put(c.store, 'app/web PROD', 4, { start: NOW - 2 * HOUR, dur: 60_000 });
  put(c.store, 'app/api PROD', 1, { start: NOW - 3 * HOUR, dur: 60_000 });
  for (let i = 1; i <= 9; i += 1) put(c.store, 'app/web DEV', i, { ago: i * HOUR });
  put(c.store, 'lib/build', 1, { ago: HOUR });
  const d = await c.dashboard(S, api, indexOf(rows), { range: '24h' });
  assert.equal(d.delivery.env, 'PROD');
  assert.equal(d.delivery.jobs, 2);
  assert.equal(d.delivery.deploys, 5);
  assert.equal(d.delivery.failedShare, 0.2);
  assert.equal(d.delivery.successRate, 0.8);
  assert.equal(d.delivery.perDay, 5);
  assert.equal(d.delivery.incidents, 1);
  // Failed at -10h (ended -9h59m), passed at -8h (ended -7h59m): two hours.
  assert.equal(d.delivery.mttrMs, 2 * HOUR);
  // A filter narrows it like everything else; no services in two environments, and there is nothing to say.
  const lib = await c.dashboard(S, api, indexOf(rows), { range: '24h', scope: { folder: 'lib' } });
  assert.equal(lib.delivery.deploys, 0);
  const none = await c.dashboard(S, api, indexOf([jobRow('lib/build')]), { range: '7d' });
  assert.deepEqual(none.delivery, { env: null, jobs: 0, deploys: 0, perDay: 0, failedShare: null, successRate: null, mttrMs: null, mttrP90Ms: null, incidents: 0 });
});

// ======================================================================================
// The board
// ======================================================================================

/** Two services in two environments, with the history that makes them differ. */
function seedBoard(c) {
  // timelog: DEV is ahead of PROD by three builds; PROD last passed five days ago.
  for (let i = 1; i <= 4; i += 1) put(c.store, 'KUBRIK/TIMELOG/TIMELOG MS PROD', i, { start: NOW - (9 - i) * DAY, dur: 60_000 });   // last at -5d
  for (let i = 1; i <= 10; i += 1) put(c.store, 'KUBRIK/TIMELOG/TIMELOG MS DEV', i, { start: NOW - (11 - i) * 12 * HOUR, dur: 60_000 });   // #7..#10 after PROD's last
  // agent: both green and in step.
  put(c.store, 'KUBRIK/TIMELOG/AGENT MS PROD', 5, { start: NOW - 2 * HOUR, dur: 60_000 });
  put(c.store, 'KUBRIK/TIMELOG/AGENT MS DEV', 9, { start: NOW - 3 * HOUR, dur: 60_000 });
  // core: DEV is red.
  put(c.store, 'KUBRIK/TIMELOG/KUBRIK-CORE-PROD', 2, { start: NOW - DAY, dur: 60_000 });
  put(c.store, 'KUBRIK/TIMELOG/KUBRIK-CORE-DEV', 7, { start: NOW - HOUR, dur: 60_000, result: 'failed' });
}
const boardIndex = () => indexOf([
  folderRow('KUBRIK'), folderRow('KUBRIK/TIMELOG'),
  jobRow('KUBRIK/TIMELOG/TIMELOG MS DEV', { last: lastOf(10, { timestamp: NOW - 11 * HOUR, duration: 60_000 }) }),
  jobRow('KUBRIK/TIMELOG/TIMELOG MS PROD', { last: lastOf(4, { timestamp: NOW - 5 * DAY, duration: 60_000 }) }),
  jobRow('KUBRIK/TIMELOG/AGENT MS DEV', { last: lastOf(9, { timestamp: NOW - 3 * HOUR, duration: 60_000 }) }),
  jobRow('KUBRIK/TIMELOG/AGENT MS PROD', { last: lastOf(5, { timestamp: NOW - 2 * HOUR, duration: 60_000 }) }),
  jobRow('KUBRIK/TIMELOG/KUBRIK-CORE-DEV', { status: 'failed', last: lastOf(7, { status: 'failed', timestamp: NOW - HOUR, duration: 60_000 }) }),
  jobRow('KUBRIK/TIMELOG/KUBRIK-CORE-PROD', { last: lastOf(2, { timestamp: NOW - DAY, duration: 60_000 }) }),
  jobRow('KUBRIK/TIMELOG/LIB RELEASE', { last: lastOf(3) }),
]);

test('the board: services down, environments across, and what each cell says', { skip }, async () => {
  const { c } = collector({ sleep: undefined });
  const api = fakeApi();
  seedBoard(c);
  const page = await c.board(S, api, boardIndex(), {});
  assert.deepEqual(page.envs, ['DEV', 'PROD']);
  assert.deepEqual(page.rows.map((r) => r.service), ['AGENT MS', 'KUBRIK CORE', 'TIMELOG MS']);
  assert.deepEqual(page.rows.map((r) => r.key), ['KUBRIK/TIMELOG|agent ms', 'KUBRIK/TIMELOG|kubrik core', 'KUBRIK/TIMELOG|timelog ms']);
  const row = page.rows.find((r) => r.service === 'TIMELOG MS');
  assert.deepEqual(Object.keys(row.cells), ['DEV', 'PROD']);
  const dev = row.cells.DEV;
  assert.equal(dev.path, 'KUBRIK/TIMELOG/TIMELOG MS DEV');
  assert.deepEqual([dev.last.number, dev.last.status, dev.last.running, dev.last.duration], [10, 'success', false, 60_000]);
  assert.equal(dev.last.age, 11 * HOUR - 60_000);
  assert.deepEqual([dev.lastSuccess.number, dev.queued, dev.disabled, dev.stuck], [10, false, false, false]);
  assert.equal(row.cells.PROD.last.age, 5 * DAY - 60_000);
  // DEV has builds 7..10 after PROD's last success (-5d + 1min), and 6 as well: 12h steps from #1 at -5.5d: #6 at -2.5d… all of 3..10 are after -5d.
  const drift = row.drift[0];
  assert.deepEqual([drift.from, drift.to], ['DEV', 'PROD']);
  assert.equal(drift.behind, 9, 'every successful DEV build since production last succeeded');
  assert.equal(typeof drift.since, 'number');
  assert.equal(drift.versionsDiffer, null, 'no versions are known');
  assert.deepEqual(row.promotable, [{ from: 'DEV', to: 'PROD' }]);
  assert.equal(row.health, 'green');
  const agent = page.rows.find((r) => r.service === 'AGENT MS');
  assert.equal(agent.drift[0].behind, 0, 'DEV #9 finished before PROD #5');
  assert.deepEqual(agent.promotable, []);
  const core = page.rows.find((r) => r.service === 'KUBRIK CORE');
  assert.equal(core.health, 'red');
  assert.deepEqual(core.promotable, [], 'a red build is not promoted');
  assert.deepEqual(page.summary, { services: 3, red: 1, amber: 0, green: 2, running: 0, none: 0, lagging: 1, byEnv: { DEV: { red: 1, amber: 0, green: 2, running: 0, none: 0 }, PROD: { red: 0, amber: 0, green: 3, running: 0, none: 0 } } });
  assert.equal(page.truncated, false);
});

test('versions are read once from the build\'s parameters, kept, and compared on what last succeeded', { skip }, async () => {
  const { c } = collector({ sleep: undefined });
  const api = fakeApi({
    params: {
      'KUBRIK/TIMELOG/TIMELOG MS DEV#10': [{ name: 'BRANCH', value: 'develop' }, { name: 'VERSION', value: '1.5.0' }, { name: 'API_KEY', value: '••••••' }],
      'KUBRIK/TIMELOG/TIMELOG MS PROD#4': [{ name: 'IMAGE_TAG', value: 'https://ana:s3cret@registry.example.com/timelog:1.4.0' }, { name: 'TOKEN', value: 'hunter2' }],
      'KUBRIK/TIMELOG/AGENT MS DEV#9': [{ name: 'VERSION', value: '2.0.0' }],
      'KUBRIK/TIMELOG/AGENT MS PROD#5': [{ name: 'VERSION', value: '2.0.0' }],
    },
  });
  seedBoard(c);
  const first = await c.board(S, api, boardIndex(), {});
  assert.equal(api.calls.filter((call) => call.startsWith('buildParams')).length >= 1, true);
  await new Promise((resolve) => setImmediate(resolve));
  c.boardCache?.clear?.();
  const page = await c.board(S, api, boardIndex(), {});
  void first;
  const row = page.rows.find((r) => r.service === 'TIMELOG MS');
  assert.deepEqual([row.cells.DEV.version, row.cells.DEV.versionName, row.cells.DEV.successVersion], ['1.5.0', 'VERSION', '1.5.0'], 'the best-named parameter, not the first');
  assert.equal(row.cells.PROD.version, 'https://registry.example.com/timelog:1.4.0', 'credentials in an address are not kept');
  assert.equal(row.drift[0].versionsDiffer, null, 'VERSION against IMAGE_TAG is not a comparison: they are not the same kind of thing');
  assert.equal(page.rows.find((r) => r.service === 'AGENT MS').drift[0].versionsDiffer, false);
  assert.equal(JSON.stringify(page).includes('hunter2'), false, 'a secret never reaches a page');
  assert.equal(JSON.stringify(page).includes('s3cret'), false);
  // Once each: a build never changes.
  const asked = api.calls.filter((call) => call.startsWith('buildParams')).length;
  await c.board(S, api, boardIndex(), {});
  assert.equal(api.calls.filter((call) => call.startsWith('buildParams')).length, asked);
  // A build that is gone settles as having no version, and is not asked about again.
  const gone = fakeApi({ params: { 'KUBRIK/TIMELOG/KUBRIK-CORE-PROD#2': Object.assign(new Error('gone'), { status: 404 }) } });
  await c.board(S, gone, boardIndex(), {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.store.paramOf(S, 'KUBRIK/TIMELOG/KUBRIK-CORE-PROD', 2).known, true);
});

test('a version that cannot be read does not stop the board, and is asked about again', { skip }, async () => {
  const { c } = collector({ sleep: undefined });
  const api = fakeApi({ params: { 'KUBRIK/TIMELOG/AGENT MS DEV#9': Object.assign(new Error('Jenkins answered 500'), { status: 500 }) } });
  seedBoard(c);
  const page = await c.board(S, api, boardIndex(), {});
  assert.equal(page.rows.length, 3);
  assert.equal(c.store.paramOf(S, 'KUBRIK/TIMELOG/AGENT MS DEV', 9).known, false);
  const bare = await c.board(S, { ...fakeApi(), buildParams: undefined }, boardIndex(), {});
  assert.equal(bare.rows.length, 3, 'an old client that cannot ask is still a board');
});

test('what is running, waiting, off or stuck shows on the cell, and a running promotion target is not promotable', { skip }, async () => {
  const { c } = collector({ sleep: undefined });
  const api = fakeApi({
    executors: { serverDate: NOW, agents: [], builds: [{ path: 'KUBRIK/TIMELOG/AGENT MS PROD', number: 6, timestamp: NOW - 10 * HOUR, estimated: 5 * MINUTE, agents: [] }], executors: { busy: 0, total: 0 } },
    queue: [{ id: 3, path: 'KUBRIK/TIMELOG/TIMELOG MS PROD', since: NOW - 3 * MINUTE, why: 'busy', stuck: false, blocked: false }],
  });
  seedBoard(c);
  const index = boardIndex();
  index.rows.get('KUBRIK/TIMELOG/AGENT MS PROD').running = true;
  index.rows.get('KUBRIK/TIMELOG/AGENT MS PROD').last = lastOf(6, { status: 'running', running: true, timestamp: NOW - 10 * HOUR, duration: 0 });
  index.rows.get('KUBRIK/TIMELOG/KUBRIK-CORE-PROD').status = 'disabled';
  const page = await c.board(S, api, index, {});
  const agent = page.rows.find((r) => r.service === 'AGENT MS');
  assert.equal(agent.cells.PROD.last.running, true);
  assert.equal(agent.cells.PROD.last.status, 'running');
  assert.equal(agent.cells.PROD.last.endedAt, null);
  assert.equal(agent.cells.PROD.stuck, true, 'ten hours of a five minute build');
  assert.equal(agent.health, 'running');
  const timelog = page.rows.find((r) => r.service === 'TIMELOG MS');
  assert.equal(timelog.cells.PROD.queued, true);
  assert.equal(timelog.cells.PROD.queuedSince, NOW - 3 * MINUTE);
  assert.deepEqual(timelog.promotable, [], 'it is ahead, but the other side is already waiting for a build');
  assert.equal(page.rows.find((r) => r.service === 'KUBRIK CORE').cells.PROD.disabled, true);
});

test('the board follows the person\'s own words, order and rows, and is narrowed by a filter', { skip }, async () => {
  const { c } = collector({ sleep: undefined });
  const api = fakeApi();
  seedBoard(c);
  const index = boardIndex();
  const stg = jobRow('KUBRIK/TIMELOG/TIMELOG MS HOM', { last: lastOf(3) });
  index.rows.set(stg.path, stg);
  assert.deepEqual((await c.board(S, api, index, {})).envs, ['DEV', 'PROD']);
  const saved = c.saveBoardSettings(S, { envTokens: { HOM: 'HOMOLOG' }, order: ['DEV', 'HOMOLOG', 'PROD'], rowOverrides: { 'KUBRIK/TIMELOG|agent ms': { name: 'The agent' } }, hide: ['KUBRIK/TIMELOG|kubrik core'] });
  assert.deepEqual(saved.envTokens, { HOM: 'HOMOLOG' });
  assert.equal(c.boardSettings(S).includeSingles, false);
  const page = await c.board(S, api, index, {});
  assert.deepEqual(page.envs, ['DEV', 'HOMOLOG', 'PROD']);
  assert.deepEqual(page.rows.map((r) => r.service), ['The agent', 'TIMELOG MS']);
  assert.deepEqual(Object.keys(page.rows[1].cells), ['DEV', 'HOMOLOG', 'PROD']);
  assert.equal(page.rows[1].drift.length, 2, 'a pair for each step: DEV to HOMOLOG, HOMOLOG to PROD');
  assert.deepEqual(page.rows[1].drift.map((d) => [d.from, d.to]), [['DEV', 'HOMOLOG'], ['HOMOLOG', 'PROD']]);
  // Narrowed to a name; a filter about builds says it does not apply.
  const narrow = await c.board(S, api, index, { scope: { pattern: 'agent' } });
  assert.deepEqual(narrow.rows.map((r) => r.service), ['The agent']);
  assert.equal((await c.board(S, api, index, { scope: { trigger: 'ana' } })).notes.some((n) => /does not apply to the board/.test(n)), true);
  // Services seen in one environment, when asked for.
  const singles = await c.board(S, api, indexOf([jobRow('solo DEV')]), { includeSingles: true });
  assert.equal(singles.rows.length, 1);
  assert.equal((await c.board(S, api, indexOf([jobRow('solo DEV')]), {})).rows.length, 0);
  // Settings persist, and are the server's own.
  assert.deepEqual(new MetricsCollector({ db: c.store.db, now: () => NOW }).boardSettings(S).order, ['DEV', 'HOMOLOG', 'PROD']);
  assert.deepEqual(c.boardSettings('another').order, []);
  assert.throws(() => c.saveBoardSettings(S, { order: 'DEV' }), /list of environments/);
  assert.deepEqual(c.boardSettings(S).order, ['DEV', 'HOMOLOG', 'PROD'], 'a refused change changes nothing');
  c.forgetServer(S);
  assert.deepEqual(c.boardSettings(S).order, [], 'and goes when the server does');
});

test('the board is empty-safe, says when the job list is not there, and cuts a huge one', { skip }, async () => {
  const { c } = collector({ sleep: undefined });
  const api = fakeApi();
  const empty = await c.board(S, api, null, {});
  assert.deepEqual([empty.rows, empty.envs], [[], []]);
  assert.equal(empty.notes.some((n) => /job list is not there yet/.test(n)), true);
  const rows = [];
  for (let i = 0; i < 400; i += 1) rows.push(jobRow(`svc${String(i).padStart(3, '0')} DEV`), jobRow(`svc${String(i).padStart(3, '0')} PROD`));
  const big = await c.board(S, api, indexOf(rows, { truncated: true }), {});
  assert.equal(big.rows.length, 300);
  assert.equal(big.truncated, true);
  assert.equal(big.notes.some((n) => /more jobs than this app reads/.test(n)), true);
  const dup = await c.board(S, api, indexOf([jobRow('a DEV'), jobRow('a-dev'), jobRow('a PROD')]), {});
  assert.equal(dup.notes.some((n) => /two jobs for one environment/.test(n)), true);
});

// ======================================================================================
// The heatmap
// ======================================================================================

test('the heatmap: jobs down, days across, aligned to the asker\'s midnight', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  // 2026-10-16 is "today" at 12:00 UTC. A build at 23:30 UTC on the 15th is the 16th at 01:30 for someone two hours east.
  put(c.store, 'web', 1, { start: Date.parse('2026-10-15T23:30:00Z'), dur: 1000 });
  put(c.store, 'web', 2, { start: Date.parse('2026-10-15T10:00:00Z'), dur: 1000, result: 'failed' });
  put(c.store, 'web', 3, { start: Date.parse('2026-10-14T10:00:00Z'), dur: 1000, result: 'unstable' });
  put(c.store, 'web', 4, { start: Date.parse('2026-10-14T11:00:00Z'), dur: 1000, result: 'aborted' });
  put(c.store, 'api', 1, { start: Date.parse('2026-10-16T08:00:00Z'), dur: 1000 });
  const utc = await c.heatmap(S, api, null, { days: 7 });
  assert.equal(utc.days, 7);
  assert.equal(utc.axis.length, 7);
  assert.equal(utc.axis.at(-1), Date.parse('2026-10-16T00:00:00Z'));
  assert.equal(utc.axis[0], Date.parse('2026-10-10T00:00:00Z'));
  const web = utc.rows.find((r) => r.path === 'web');
  assert.deepEqual(web.cells.at(-2), [1, 1, 0, 4], 'the 15th: one passed, one failed → worst is failed');
  assert.deepEqual(web.cells.at(-3), [0, 0, 2, 3], 'the 14th: unstable and aborted are "other"; worst is unstable');
  assert.deepEqual(web.cells.at(-1), [0, 0, 0, 0]);
  assert.deepEqual([web.total, web.failed], [4, 1]);
  assert.equal(web.stability, 1 / 3, 'one success of the three that decided something');
  // Two hours east, the late build is on the 16th.
  const east = await c.heatmap(S, api, null, { days: 7, utcOffsetMinutes: 120 });
  assert.equal(east.axis.at(-1), Date.parse('2026-10-15T22:00:00Z'), 'their midnight is 22:00 UTC the day before');
  assert.deepEqual(east.rows.find((r) => r.path === 'web').cells.at(-1), [1, 0, 0, 1]);
  assert.equal(east.utcOffsetMinutes, 120);
  // Most failing first, or most active first.
  assert.deepEqual(utc.rows.map((r) => r.path), ['web', 'api']);
  assert.deepEqual((await c.heatmap(S, api, null, { days: 7, sort: 'activity' })).rows.map((r) => r.path), ['web', 'api']);
});

test('the heatmap says whether a job is getting better or worse, and only when it can tell', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  // 14 days: the first week mostly red, the second mostly green; and one that is the other way round; and one too thin to say.
  for (let d = 0; d < 14; d += 1) {
    for (let i = 0; i < 2; i += 1) {
      const start = NOW - (13 - d) * DAY - i * HOUR;
      put(c.store, 'improving', d * 2 + i + 1, { start, result: d < 7 ? 'failed' : 'success' });
      put(c.store, 'worsening', d * 2 + i + 1, { start, result: d < 7 ? 'success' : 'failed' });
      put(c.store, 'steady', d * 2 + i + 1, { start, result: 'success' });
    }
  }
  put(c.store, 'thin', 1, { ago: HOUR, result: 'failed' });
  const page = await c.heatmap(S, api, null, { days: 14 });
  const by = (path) => page.rows.find((r) => r.path === path);
  assert.equal(by('improving').trend.direction, 'up');
  assert.deepEqual([by('improving').trend.before, by('improving').trend.recent], [0, 1]);
  assert.equal(by('worsening').trend.direction, 'down');
  assert.equal(by('worsening').trend.delta, -1);
  assert.equal(by('steady').trend.direction, 'flat');
  assert.equal(by('thin').trend, null);
  assert.equal(by('steady').stability, 1);
});

test('the heatmap is cut to the busiest rows and says so, and is narrowed by a filter', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  for (let j = 0; j < 100; j += 1) put(c.store, `team${j % 2}/job${j}`, 1, { ago: HOUR, result: j < 30 ? 'failed' : 'success' });
  const page = await c.heatmap(S, api, null, { days: 7, limit: 10 });
  assert.equal(page.rows.length, 10);
  assert.equal(page.truncated, true);
  assert.equal(page.totalJobs, 100);
  assert.equal(page.rows.every((r) => r.failed === 1), true, 'the ones that failed come first');
  assert.equal((await c.heatmap(S, api, null, { days: 7, limit: 1e9 })).rows.length, 100);
  assert.equal((await c.heatmap(S, api, null, { days: 7, limit: 1 })).rows.length, 5, 'at least five, or it is not a map');
  assert.equal((await c.heatmap(S, api, null, { days: 7, scope: { folder: 'team1' } })).totalJobs, 50);
  assert.equal((await c.heatmap(S, api, null, { days: 3 })).days, 14, 'a span nobody offered is the default');
  assert.equal((await c.heatmap(S, api, null, { days: 90 })).axis.length, 90);
  const none = await c.heatmap('nobody', api, null, { days: 7 });
  assert.deepEqual([none.rows, none.totalJobs, none.truncated, none.coverage.from], [[], 0, false, null]);
  assert.equal(none.notes.some((n) => /no history yet/.test(n)), true);
});

// ======================================================================================
// The insights
// ======================================================================================

const find = (page, kind, path = null) => page.cards.filter((one) => one.kind === kind && (path === null || one.jobs.includes(path)));

test('nothing wrong is no cards, and cards say so in their counts', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  for (let i = 1; i <= 5; i += 1) put(c.store, 'fine', i, { ago: i * HOUR });
  const page = await c.insights(S, api, indexOf([jobRow('fine', { last: lastOf(5) })]), { range: '24h' });
  assert.deepEqual(page.cards, []);
  assert.deepEqual(page.counts, { critical: 0, warning: 0, info: 0, good: 0 });
});

test('a job that was green and turned red is a new failure, with the commits that are suspected', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi({ changes: { 'team/web#13': [{ id: 'a91c3e2b', message: 'Round refund amounts', author: 'Ana R.' }] } });
  for (let i = 1; i <= 12; i += 1) put(c.store, 'team/web', i, { start: NOW - (40 - i) * HOUR });
  put(c.store, 'team/web', 13, { start: NOW - 3 * HOUR, result: 'failed' });
  put(c.store, 'team/web', 14, { start: NOW - 90 * MINUTE, result: 'failed' });
  // Another that is red but was never green for long: not "new".
  put(c.store, 'team/flaky', 1, { start: NOW - 5 * HOUR });
  put(c.store, 'team/flaky', 2, { start: NOW - 4 * HOUR, result: 'failed' });
  const page = await c.insights(S, api, indexOf([jobRow('team/web'), jobRow('team/flaky')]), { range: '24h' });
  const [one] = find(page, 'new-failure', 'team/web');
  assert.equal(one.id, 'new-failure:team/web');
  assert.equal(one.severity, 'critical', 'twelve greens before it');
  assert.equal(one.title, 'web started failing');
  assert.match(one.detail, /First red after 12 green builds, 3 h ago \(#13\)\. It has failed 2 times since\./);
  assert.deepEqual([one.evidence.number, one.evidence.previousGreen, one.evidence.builds], [13, 12, 2]);
  assert.deepEqual(one.evidence.suspects, [{ id: 'a91c3e2b', message: 'Round refund amounts', author: 'Ana R.' }]);
  assert.deepEqual(one.actions.map((a) => a.label), ['Ask Claude', 'Re-run', 'Open']);
  assert.deepEqual(one.actions[0], { label: 'Ask Claude', verb: 'ask', args: { path: 'team/web', number: 13 } });
  assert.deepEqual(one.actions[1], { label: 'Re-run', verb: 'run', args: { path: 'team/web' } });
  assert.deepEqual(one.actions[2], { label: 'Open', page: { type: 'build', path: 'team/web', number: 13 } });
  assert.equal(find(page, 'new-failure', 'team/flaky').length, 0, 'one green is not "after N greens"');
  // Asked for once, however often the page is read.
  c.dashCache.clear();
  await c.insights(S, api, indexOf([jobRow('team/web')]), { range: '24h' });
  assert.equal(api.calls.filter((call) => call.startsWith('buildChanges')).length, 1);
});

test('the commits behind a failure come from what is already kept, without asking', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  c.store.db.exec('CREATE TABLE IF NOT EXISTS jk_build (server TEXT, path TEXT, number INTEGER, changes TEXT)');
  c.store.db.prepare('INSERT INTO jk_build (server, path, number, changes) VALUES (?, ?, ?, ?)').run(S, 'svc', 6, JSON.stringify([{ id: 'deadbeef', message: 'Kept', author: 'Bob' }]));
  for (let i = 1; i <= 5; i += 1) put(c.store, 'svc', i, { start: NOW - (30 - i) * HOUR });
  put(c.store, 'svc', 6, { start: NOW - 2 * HOUR, result: 'failed' });
  const page = await c.insights(S, api, indexOf([jobRow('svc')]), { range: '24h' });
  assert.deepEqual(find(page, 'new-failure', 'svc')[0].evidence.suspects, [{ id: 'deadbeef', message: 'Kept', author: 'Bob' }]);
  assert.equal(api.calls.some((call) => call.startsWith('buildChanges')), false);
  assert.equal(find(page, 'new-failure', 'svc')[0].severity, 'warning', 'five greens: worth a look, not an alarm');
});

test('a job red for days is a warning at three and critical at seven', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  for (let i = 1; i <= 3; i += 1) put(c.store, 'four', i, { start: NOW - (4 * DAY + (4 - i) * HOUR), result: 'failed' });
  for (let i = 1; i <= 2; i += 1) put(c.store, 'eight', i, { start: NOW - (8 * DAY + (3 - i) * HOUR), result: 'failed' });
  put(c.store, 'two', 1, { start: NOW - 2 * DAY, result: 'failed' });
  const page = await c.insights(S, api, indexOf([jobRow('four'), jobRow('eight'), jobRow('two')]), { range: '24h' });
  const four = find(page, 'red-for-days', 'four')[0];
  const eight = find(page, 'red-for-days', 'eight')[0];
  assert.equal(four.severity, 'warning');
  assert.equal(eight.severity, 'critical');
  assert.match(four.title, /four has been failing for 4 days/);
  assert.match(four.detail, /3 builds in a row; the last is #3/);
  assert.equal(four.evidence.firstFailing, 1);
  assert.equal(find(page, 'red-for-days', 'two').length, 0, 'two days is not yet a story');
  assert.equal(page.cards.findIndex((one) => one.id === eight.id) < page.cards.findIndex((one) => one.id === four.id), true, 'critical before warning');
});

test('more failures than the day before is a spike, and a much bigger one is critical', { skip }, async () => {
  const { c } = collector();
  covered(c);
  const api = fakeApi();
  for (let i = 0; i < 12; i += 1) put(c.store, `job${i % 3}`, i + 1, { ago: (i + 1) * 30 * MINUTE, result: 'failed' });
  for (let i = 0; i < 2; i += 1) put(c.store, 'job0', 100 + i, { ago: DAY + (i + 1) * HOUR, result: 'failed' });
  const page = await c.insights(S, api, indexOf([]), { range: '24h' });
  const [spike] = find(page, 'failure-spike');
  assert.equal(spike.severity, 'critical', 'twelve against two');
  assert.match(spike.title, /12 builds failed in the last 24h/);
  assert.deepEqual([spike.evidence.failed, spike.evidence.previous], [12, 2]);
  const calm = collector();
  for (let i = 0; i < 4; i += 1) put(calm.c.store, 'j', i + 1, { ago: (i + 1) * HOUR, result: 'failed' });
  assert.equal(find(await calm.c.insights(S, fakeApi(), indexOf([]), { range: '24h' }), 'failure-spike').length, 0, 'four is not a spike');
});

test('a job that has become slower, and builds that have run too long, are cards', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi({
    executors: { serverDate: NOW, agents: [], builds: [
      { path: 'slow/est', number: 3, timestamp: NOW - 3 * HOUR, estimated: 10 * MINUTE, agents: ['a1'] },
      { path: 'slow/usual', number: 41, timestamp: NOW - 40 * MINUTE, estimated: null, agents: ['a1'] },
      { path: 'fine/job', number: 5, timestamp: NOW - 12 * MINUTE, estimated: 30 * MINUTE, agents: ['a1'] },
    ], executors: { busy: 3, total: 4 } },
  });
  for (let i = 0; i < 20; i += 1) put(c.store, 'reg/job', i + 1, { ago: (70 - i) * HOUR / 4, dur: 100_000 });
  for (let i = 0; i < 5; i += 1) put(c.store, 'reg/job', 21 + i, { ago: (5 - i) * HOUR / 4, dur: 250_000 });
  // `slow/usual` always takes about ten minutes, and has now run for forty with no estimate.
  for (let i = 0; i < 12; i += 1) put(c.store, 'slow/usual', i + 1, { ago: (13 - i) * HOUR, dur: 10 * MINUTE + i * 1000 });
  const page = await c.insights(S, api, indexOf([jobRow('slow/est'), jobRow('slow/usual'), jobRow('fine/job'), jobRow('reg/job')]), { range: '24h' });
  const reg = find(page, 'duration-regression', 'reg/job')[0];
  assert.equal(reg.severity, 'warning');
  assert.equal(reg.title, 'job takes 2.5× as long as it did');
  assert.deepEqual([reg.evidence.now, reg.evidence.before], [250_000, 100_000]);
  const stuck = find(page, 'stuck-build', 'slow/est')[0];
  assert.equal(stuck.severity, 'critical', 'eighteen times what Jenkins expected');
  assert.match(stuck.title, /est #3 has been running for 3 h/);
  assert.match(stuck.detail, /expected about 10 min/);
  assert.deepEqual(stuck.actions.map((a) => a.verb ?? 'page'), ['stop', 'ask', 'page']);
  assert.deepEqual(stuck.actions[0].args, { path: 'slow/est', number: 3 });
  const longer = find(page, 'stuck-build', 'slow/usual')[0];
  assert.equal(longer.severity, 'warning');
  assert.match(longer.title, /taking longer than usual/);
  assert.match(longer.detail, /95% of its last 12 builds took less than/);
  assert.equal(find(page, 'stuck-build', 'fine/job').length, 0);
});

test('a build waiting too long, and executors that never get a break, are cards', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi({
    queue: [
      { id: 7, path: 'q/waiting', since: NOW - 45 * MINUTE, why: 'No agent has the label arm', stuck: false, blocked: false },
      { id: 8, path: 'q/fine', since: NOW - 2 * MINUTE, why: 'busy', stuck: false, blocked: false },
      { id: 9, path: 'q/stuck', since: NOW - 4 * MINUTE, why: 'it says so', stuck: true, blocked: false },
    ],
  });
  for (let i = 0; i < 20; i += 1) c.store.recordSample(S, { t: NOW - (i + 1) * MINUTE, running: 2, queued: 4, busy: 2, total: 2 });
  const page = await c.insights(S, api, indexOf([]), { range: '24h' });
  const waiting = find(page, 'queue-wait', 'q/waiting')[0];
  assert.equal(waiting.severity, 'warning');
  assert.match(waiting.title, /waiting 45 min for an executor/);
  assert.match(waiting.detail, /No agent has the label arm/);
  assert.deepEqual(waiting.actions[0], { label: 'Cancel', verb: 'cancelQueued', args: { id: 7 } });
  assert.equal(find(page, 'queue-wait', 'q/fine').length, 0);
  assert.equal(find(page, 'queue-wait', 'q/stuck')[0].severity, 'critical', 'Jenkins itself says it is stuck');
  const [sat] = find(page, 'executor-saturation');
  assert.equal(sat.severity, 'warning');
  assert.equal(sat.evidence.queuedAverage, 4);
  assert.equal(find(await collector().c.insights(S, fakeApi(), indexOf([]), { range: '24h' }), 'executor-saturation').length, 0, 'with no samples there is nothing to say');
  // Half an hour of samples where there was room is not saturation.
  const calm = collector();
  for (let i = 0; i < 20; i += 1) calm.c.store.recordSample(S, { t: NOW - (i + 1) * MINUTE, running: 1, queued: i % 2 ? 3 : 0, busy: 1, total: 2 });
  assert.equal(find(await calm.c.insights(S, fakeApi(), indexOf([]), { range: '24h' }), 'executor-saturation').length, 0);
});

test('agents that are offline, or that come and go, are cards', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi({ executors: { serverDate: NOW, agents: [{ name: 'arm-1', offline: true, busy: 0, executors: 1, labels: ['arm'] }, { name: 'linux-1', offline: false, busy: 0, executors: 2, labels: [] }], builds: [], executors: { busy: 0, total: 2 } } });
  [0, 1, 0, 1, 0, 1, 0, 1].forEach((offline, i) => c.store.recordSample(S, { t: NOW - (10 - i) * MINUTE, running: 0, queued: 0, busy: 0, total: 2, offline }));
  const page = await c.insights(S, api, indexOf([]), { range: '24h' });
  const [off] = find(page, 'agents-offline');
  assert.equal(off.severity, 'warning');
  assert.equal(off.title, '1 agent is offline');
  assert.match(off.detail, /arm-1/);
  assert.equal(find(page, 'agents-flapping')[0].evidence.flaps, 7);
  const dead = fakeApi({ executors: { serverDate: NOW, agents: [{ name: 'only', offline: true, busy: 0, executors: 1, labels: [] }], builds: [], executors: { busy: 0, total: 0 } } });
  assert.equal(find(await collector().c.insights(S, dead, indexOf([]), { range: '24h' }), 'agents-offline')[0].severity, 'critical', 'every one of them');
});

test('good news is a card too: what was broken and passes again', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  for (let i = 1; i <= 3; i += 1) put(c.store, 'healed', i, { start: NOW - (10 - i) * HOUR, result: 'failed' });
  put(c.store, 'healed', 4, { start: NOW - 5 * HOUR, result: 'success' });
  put(c.store, 'blip', 1, { start: NOW - 4 * HOUR, result: 'failed' });
  put(c.store, 'blip', 2, { start: NOW - 3 * HOUR, result: 'success' });
  const page = await c.insights(S, api, indexOf([jobRow('healed'), jobRow('blip')]), { range: '24h' });
  const [fixed] = find(page, 'fixed');
  assert.equal(fixed.jobs[0], 'healed');
  assert.equal(fixed.severity, 'good');
  assert.equal(fixed.title, 'healed is green again');
  assert.equal(fixed.evidence.failures, 3);
  assert.equal(find(page, 'fixed', 'blip').length, 0, 'one failure and one pass is a blip, not news');
  assert.equal(page.cards.at(-1).severity, 'good', 'and it comes last');
});

test('a job that was built often and then stopped is a card, a disabled one is not, and nights are not quiet', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  const dayStart = (back) => Math.floor((NOW - back * DAY) / DAY) * DAY;
  // Mornings (08-11 UTC) every day for nine days, and not today: four builds are due by now.
  for (const name of ['mornings', 'paused']) for (let d = 1; d <= 9; d += 1) for (let h = 8; h < 12; h += 1) put(c.store, name, (d - 1) * 4 + h - 7, { start: dayStart(d) + h * HOUR });
  // Afternoons (13-17 UTC) every day, and the afternoon of yesterday was the last: it is only the night.
  for (let d = 1; d <= 9; d += 1) for (let h = 13; h < 18; h += 1) put(c.store, 'afternoons', (d - 1) * 5 + h - 12, { start: dayStart(d) + h * HOUR });
  // One busy afternoon, long ago, never repeated: not a habit.
  for (let i = 0; i < 9; i += 1) put(c.store, 'burst', i + 1, { start: dayStart(13) + 14 * HOUR + i * 10 * MINUTE });
  for (let i = 0; i < 12; i += 1) put(c.store, 'active', i + 1, { start: NOW - (11 - i) * HOUR });
  const page = await c.insights(S, api, indexOf([jobRow('mornings'), jobRow('paused', { status: 'disabled' }), jobRow('afternoons'), jobRow('burst'), jobRow('active')]), { range: '24h' });
  const [quiet] = find(page, 'gone-quiet');
  assert.equal(quiet.jobs[0], 'mornings');
  assert.equal(quiet.severity, 'info');
  assert.match(quiet.detail, /About 4 builds were due since, at the hours it usually builds \(36 builds/);
  assert.equal(find(page, 'gone-quiet').length, 1, 'only the one that missed its hours');
  assert.equal(find(page, 'gone-quiet', 'paused').length, 0);
  assert.equal(find(page, 'gone-quiet', 'afternoons').length, 0, 'a job of working hours is not quiet overnight');
  assert.equal(find(page, 'gone-quiet', 'burst').length, 0, 'a burst once is not a habit');
  assert.equal(find(page, 'gone-quiet', 'active').length, 0);
});

test('stale jobs and the time it takes to fix things, once there are enough of them to say', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  const stale = Array.from({ length: 25 }, (_, i) => jobRow(`old/job${i}`, { last: lastOf(1, { timestamp: NOW - 90 * DAY }) }));
  for (let i = 0; i < 3; i += 1) {
    put(c.store, `inc${i}`, 1, { start: NOW - (10 - i) * HOUR, result: 'failed' });
    put(c.store, `inc${i}`, 2, { start: NOW - (6 - i) * HOUR, result: 'success' });
  }
  const page = await c.insights(S, api, indexOf(stale), { range: '24h' });
  const [old] = find(page, 'stale-jobs');
  assert.equal(old.evidence.count, 25);
  assert.deepEqual(old.actions[0].page, { type: 'view', kind: 'smart', name: 'stale' });
  const [mttr] = find(page, 'mttr');
  assert.equal(mttr.evidence.incidents, 3);
  assert.equal(mttr.evidence.median, 4 * HOUR);
  assert.equal(mttr.severity, 'info');
  assert.equal(find(await collector().c.insights(S, fakeApi(), indexOf(stale.slice(0, 5)), { range: '24h' }), 'stale-jobs').length, 0, 'five is not worth a card');
});

test('cards are ordered by how much they matter, bounded, and every action is something the panel can do', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  for (let j = 0; j < 60; j += 1) {
    for (let i = 1; i <= 4; i += 1) put(c.store, `many/job${j}`, i, { start: NOW - (30 - i) * HOUR });
    put(c.store, `many/job${j}`, 5, { start: NOW - 3 * HOUR, result: 'failed' });
  }
  const page = await c.insights(S, api, indexOf([]), { range: '24h' });
  assert.equal(page.cards.length, 30);
  assert.equal(page.counts.warning >= 30, true);
  assert.equal(page.notes.some((n) => /more are not shown/.test(n)), true);
  const order = page.cards.map((one) => [-{ critical: 3, warning: 2, info: 1, good: 0 }[one.severity], -one.score]);
  assert.deepEqual(order, [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]), 'severity first, then how much');
  const verbs = new Set(['run', 'stop', 'ask', 'cancelQueued', 'follow']);
  for (const one of page.cards) {
    assert.equal(typeof one.id, 'string');
    assert.equal(one.id.startsWith(`${one.kind}:`), true);
    assert.equal(['critical', 'warning', 'info', 'good'].includes(one.severity), true);
    assert.equal(typeof one.title, 'string');
    assert.equal(typeof one.detail, 'string');
    for (const action of one.actions) assert.equal(Boolean(action.verb) !== Boolean(action.page), true, 'a verb or a page, never both, never neither');
    for (const action of one.actions.filter((a) => a.verb)) assert.equal(verbs.has(action.verb), true, action.verb);
  }
  assert.equal(new Set(page.cards.map((one) => one.id)).size, page.cards.length, 'ids are unique');
});

test('insights are narrowed by a filter like everything else', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  for (const folder of ['a', 'b']) {
    for (let i = 1; i <= 5; i += 1) put(c.store, `${folder}/job`, i, { start: NOW - (30 - i) * HOUR });
    put(c.store, `${folder}/job`, 6, { start: NOW - 3 * HOUR, result: 'failed' });
  }
  const index = indexOf([]);
  assert.equal(find(await c.insights(S, api, index, { range: '24h' }), 'new-failure').length, 2);
  const only = await c.insights(S, api, index, { range: '24h', scope: { folder: 'a' } });
  assert.deepEqual(find(only, 'new-failure').map((one) => one.jobs[0]), ['a/job']);
});

// ======================================================================================
// The report
// ======================================================================================

async function seedReport(c, api) {
  for (let i = 1; i <= 8; i += 1) put(c.store, 'team/web', i, { start: NOW - (30 - i) * HOUR, dur: 5 * MINUTE });
  put(c.store, 'team/web', 9, { start: NOW - 3 * HOUR, dur: 6 * MINUTE, result: 'failed' });
  put(c.store, 'team/slow', 1, { start: NOW - 5 * HOUR, dur: 41 * MINUTE });
  put(c.store, 'team/slow', 2, { start: NOW - 4 * HOUR, dur: 2 * MINUTE, result: 'aborted' });
  void api;
}

test('the report says the same things every time, in a shape a person can paste', { skip }, async () => {
  const { c } = collector();
  covered(c);
  const api = fakeApi({ executors: { serverDate: NOW, agents: [{ name: 'arm-1', offline: true, busy: 0, executors: 1, labels: [] }, { name: 'a2', offline: false, busy: 1, executors: 2, labels: [] }], builds: [{ path: 'team/e2e', number: 8, timestamp: NOW - 12 * MINUTE, estimated: 20 * MINUTE, agents: ['a2'] }], executors: { busy: 1, total: 2 } } });
  await seedReport(c, api);
  const index = indexOf([jobRow('team/web'), jobRow('team/slow'), jobRow('team/e2e', { running: true, last: lastOf(8, { running: true, status: 'running', timestamp: NOW - 12 * MINUTE }) })]);
  const out = await c.report(S, api, index, { range: '24h', format: 'markdown', serverName: 'kubrik-ci' });
  assert.equal(out.format, 'markdown');
  assert.equal(out.truncated, false);
  assert.equal(out.bytes, Buffer.byteLength(out.text));
  const text = out.text;
  assert.match(text, /^# CI summary — kubrik-ci — last 24h/);
  assert.match(text, /\*\*Builds\*\*: 6 finished \(5 before\) · success rate 80% \(100% before\) · 1 failed \(0 before\)/, 'four of the five that said yes or no; the aborted one says nothing');
  assert.match(text, /\*\*Now\*\*: 1 running · 0 queued · executors 1\/2 · agents 1\/2 online/);
  assert.match(text, /## Failing now \(1\)\n\n- `team\/web` — red for 2\.9 h \(1 build\), last #9/, text);
  assert.match(text, /## Running now \(1\)\n\n- `team\/e2e` #8 — 12 min of about 20 min/);
  assert.match(text, /## Needs attention/);
  assert.match(text, /1\. \[warning\] web started failing — First red after 8 green builds, 2\.9 h ago \(#9\)\./, 'our own punctuation is left alone');
  assert.match(text, /## Slowest builds\n\n- `team\/slow` #1 — 41 min/);
  assert.match(text, /## Agents\n\n- Offline: arm-1/);
  assert.match(text, /_Generated 2026-10-16T12:00:00\.000Z_$/);
  assert.equal((await c.report(S, api, index, { range: '24h', format: 'markdown', serverName: 'kubrik-ci' })).text, text, 'the same history gives the same words');
  // Plain text has no markup at all.
  const plain = (await c.report(S, api, index, { range: '24h', format: 'text', serverName: 'kubrik-ci' })).text;
  assert.match(plain, /^CI SUMMARY — kubrik-ci — last 24h/);
  assert.match(plain, /\nFAILING NOW \(1\)\n\n {2}\* team\/web — red for 2\.9 h/);
  assert.equal(/`|\*\*|^#+ /m.test(plain), false, 'no backticks, bold or headings');
  assert.equal(plain.includes('**'), false);
});

test('the report says what it was narrowed to, and what is behind between environments', { skip }, async () => {
  const { c } = collector({ sleep: undefined });
  const api = fakeApi({ params: { 'KUBRIK/TIMELOG/TIMELOG MS DEV#10': [{ name: 'VERSION', value: '1.5.0' }], 'KUBRIK/TIMELOG/TIMELOG MS PROD#4': [{ name: 'VERSION', value: '1.4.0' }] } });
  seedBoard(c);
  await c.board(S, api, boardIndex(), {});
  await new Promise((resolve) => setImmediate(resolve));
  const out = await c.report(S, api, boardIndex(), { range: '7d', scope: { folder: 'KUBRIK' }, serverName: 'ci' });
  assert.match(out.text, /_Filtered — folder: KUBRIK_/);
  assert.match(out.text, /## Environments that are behind\n\n- TIMELOG MS: PROD is 9 builds behind DEV \(DEV 1\.5\.0, PROD 1\.4\.0\)/, out.text);
  assert.doesNotMatch(out.text, /AGENT MS: PROD/, 'in step is not behind');
});

test('text from a server is neutralised before it goes into something a person pastes', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  const hostile = 'x`; rm -rf ~`\n## Heading‮@everyone <script>[click](http://evil)* _under_';
  put(c.store, hostile, 1, { start: NOW - 2 * HOUR, result: 'failed' });
  put(c.store, hostile, 2, { start: NOW - HOUR, result: 'failed' });
  put(c.store, 'ok/job', 1, { start: NOW - 2 * HOUR, dur: 61 * MINUTE });
  const index = indexOf([jobRow(hostile), jobRow('ok/job')]);
  for (const format of ['markdown', 'text']) {
    const { text } = await c.report(S, api, index, { range: '24h', format, serverName: `ci\n# injected @here` });
    const lines = text.split('\n');
    assert.equal(lines.some((line) => /^##? (Heading|injected)/.test(line)), false, `${format}: a name cannot start a heading`);
    assert.equal(text.includes('‮'), false, `${format}: no direction override`);
    assert.equal(text.includes('@everyone') || text.includes('@here'), false, `${format}: nobody is mentioned`);
    // A link is harmless inside a code span, and only there: nothing outside backticks can be one.
    const outside = text.split('\n').map((line) => line.replace(/`[^`]*`/g, '')).join('\n');
    assert.equal(/\[click\]\(http/.test(outside), false, `${format}: no link outside code`);
    assert.equal(/<script>/.test(outside), false, `${format}: no tag outside code`);
    assert.equal(/\n\u0000/.test(text), false);
  }
  const md = (await c.report(S, api, index, { range: '24h', format: 'markdown' })).text;
  const line = md.split('\n').find((one) => one.includes('rm -rf'));
  assert.equal((line.match(/`/g) ?? []).length, 2, 'a backtick inside a name cannot end its code span early');
});

test('a report is never longer than a screen or two', { skip }, async () => {
  const { c } = collector();
  const api = fakeApi();
  for (let j = 0; j < 80; j += 1) {
    put(c.store, `long/path/${'segment-'.repeat(10)}${j}`, 1, { start: NOW - 3 * HOUR, result: 'failed', dur: 50 * MINUTE });
    put(c.store, `long/path/${'segment-'.repeat(10)}${j}`, 2, { start: NOW - 2 * HOUR, result: 'failed', dur: 50 * MINUTE });
  }
  const out = await c.report(S, api, indexOf([]), { range: '24h', format: 'markdown' });
  assert.equal(out.text.length <= 8000, true, `${out.text.length}`);
  const text = out.text;
  assert.equal(/Failing now \(80\)/.test(text), true, 'the count says 80 even though ten are listed');
  assert.match(text, /…and 70 more\./);
  assert.equal((await c.report(S, api, indexOf([]), { range: '24h', format: 'bogus' })).format, 'markdown');
});

// ======================================================================================
// The wallboard
// ======================================================================================

test('the wallboard is small, bounded, and cached for a moment', { skip }, async () => {
  const { c, tick } = collector({ sleep: undefined });
  const api = fakeApi({
    executors: { serverDate: NOW, agents: [], builds: Array.from({ length: 15 }, (_, i) => ({ path: `run/job${i}`, number: 1, timestamp: NOW - (i + 1) * MINUTE, estimated: 30 * MINUTE, agents: [] })), executors: { busy: 2, total: 2 } },
    queue: [{ id: 1, path: 'q', since: NOW - MINUTE, why: 'w', stuck: false, blocked: false }],
  });
  // Twenty jobs red since different times; thirty finished builds.
  for (let j = 0; j < 20; j += 1) { put(c.store, `red/job${j}`, 1, { start: NOW - (j + 2) * HOUR, result: 'failed' }); }
  for (let i = 0; i < 30; i += 1) put(c.store, 'ticker/job', i + 1, { start: NOW - (i + 1) * 3 * MINUTE - 10 * MINUTE, dur: 60_000, result: i % 5 ? 'success' : 'failed' });
  const board = indexOf([folderRow('app'), jobRow('app/web DEV', { last: lastOf(1) }), jobRow('app/web PROD', { last: lastOf(1, { status: 'failed' }), status: 'failed' })]);
  put(c.store, 'app/web DEV', 1, { ago: HOUR });
  put(c.store, 'app/web PROD', 1, { ago: HOUR, result: 'failed' });
  const page = await c.wallboard(S, api, board, {});
  assert.deepEqual(Object.keys(page).sort(), ['asOf', 'board', 'counts', 'executors', 'failing', 'rate24h', 'running', 'ticker'].sort());
  assert.deepEqual(page.counts, { running: 15, queued: 1, failing: 22, stuck: 0 }, 'twenty jobs, the production one, and the job whose newest build failed');
  assert.equal(page.failing.length, 12);
  assert.equal(page.failing[0].path, 'red/job19', 'the one that has been red longest first');
  assert.equal(page.failing.every((f, i) => i === 0 || f.since >= page.failing[i - 1].since), true);
  assert.equal(page.running.length, 12);
  assert.deepEqual(Object.keys(page.running[0]).sort(), ['agent', 'elapsed', 'estimated', 'number', 'path', 'progress', 'stage', 'stuck', 'trigger'].sort());
  assert.equal(page.ticker.length, 20);
  assert.equal(page.ticker.every((t, i) => i === 0 || t.endedAt <= page.ticker[i - 1].endedAt), true, 'newest first');
  assert.deepEqual(Object.keys(page.ticker[0]).sort(), ['ago', 'duration', 'endedAt', 'number', 'path', 'result'].sort());
  assert.deepEqual(page.executors, { busy: 2, total: 2 });
  assert.deepEqual(page.board, { services: 1, red: 1, amber: 0, green: 0, running: 0, byEnv: { DEV: { red: 0, amber: 0, green: 1, running: 0, none: 0 }, PROD: { red: 1, amber: 0, green: 0, running: 0, none: 0 } } });
  assert.equal(JSON.stringify(page).length < 12_000, true, `${JSON.stringify(page).length} bytes`);
  const asked = api.calls.length;
  assert.equal(await c.wallboard(S, api, board, {}), page, 'asked again at once: the same page');
  assert.equal(api.calls.length, asked);
  tick(3000);
  assert.notEqual(await c.wallboard(S, api, board, {}), page, 'a few seconds on it is made again');
  // Narrowed like any other page.
  assert.equal((await c.wallboard(S, api, board, { scope: { folder: 'red' } })).failing.length, 12);
  assert.equal((await c.wallboard(S, api, board, { scope: { folder: 'nothing' } })).counts.failing, 0);
});

// ======================================================================================
// Through the service
// ======================================================================================

const { JenkinsService } = sqlite ? require('../electron/jenkins-service') : {};

function jenkinsFor(state) {
  const requests = [];
  const reply = (body, headers = {}) => ({ status: 200, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, body: null, text: async () => JSON.stringify(body), arrayBuffer: async () => Buffer.from(JSON.stringify(body)) });
  const stub = (b) => ({ number: b.number, result: b.building ? null : b.result, building: Boolean(b.building), timestamp: b.timestamp, duration: b.duration ?? 0, estimatedDuration: 60_000, builtOn: 'linux-1', actions: [{ causes: [{ shortDescription: 'Started by user ana', userId: 'ana' }] }] });
  const entry = (p) => ({ _class: 'hudson.model.FreeStyleProject', name: p.split('/').pop(), fullName: p, color: 'blue', lastBuild: stub(state.jobs[p][0]) });
  // A job list with its folders: what the index asks for, two levels at a time.
  const listing = (dir) => {
    const seen = new Map();
    for (const p of Object.keys(state.jobs)) {
      if (!p.startsWith(dir)) continue;
      const rest = p.slice(dir.length);
      const head = rest.split('/')[0];
      if (rest.includes('/')) {
        const folder = `${dir}${head}`;
        if (!seen.has(folder)) seen.set(folder, { _class: 'com.cloudbees.hudson.plugins.folder.Folder', name: head, fullName: folder, jobs: [] });
        const grand = rest.slice(head.length + 1);
        if (!grand.includes('/')) seen.get(folder).jobs.push(entry(p));
      } else seen.set(p, entry(p));
    }
    return [...seen.values()];
  };
  const fetch = async (url) => {
    const { pathname, search } = new URL(url);
    const query = decodeURIComponent(search);
    requests.push(`${pathname}${query}`);
    if (pathname === '/computer/api/json') return reply({ computer: [{ displayName: 'linux-1', offline: false, numExecutors: 2, assignedLabels: [], executors: [], oneOffExecutors: [] }] }, { date: new Date(NOW).toUTCString() });
    if (pathname === '/queue/api/json') return reply({ items: [] });
    if (pathname === '/me/api/json') return reply({ id: 'ana', fullName: 'Ana R.' });
    const parts = pathname.split('/').filter(Boolean);
    const names = [];
    while (parts[0] === 'job') { parts.shift(); names.push(decodeURIComponent(parts.shift())); }
    const path = names.join('/');
    if (parts.length === 2 && /^\d+$/.test(parts[0]) && parts[1] === 'api') return reply(parts[0] === '4' ? { actions: [{ parameters: [{ name: 'VERSION', value: '9.9' }] }] } : {});
    if (query.includes('tree=jobs[') && query.includes('builds[')) return reply({ jobs: [] });
    if (query.includes('tree=jobs[')) return reply({ jobs: listing(path ? `${path}/` : '') });
    if (query.includes('builds[')) return reply({ builds: (state.jobs[path] ?? []).map(stub) });
    return reply({});
  };
  return { fetch, requests };
}

function service(extra = {}) {
  const state = { jobs: {}, ...extra.state };
  const jenkins = jenkinsFor(state);
  const svc = new JenkinsService({ db: memory(), fetch: jenkins.fetch, now: () => NOW, sleep: async () => {}, nudgeMs: [], notify: () => {}, emit: () => {} });
  return { svc, jenkins, call: (name, args) => svc.call(name, args) };
}
const build = (number, ago, extra = {}) => ({ number, result: 'SUCCESS', timestamp: NOW - ago, duration: 60_000, ...extra });

test('through the service: every verb answers, takes a filter, checks what it is given, and the settings are written only by their verb', { skip }, async () => {
  const jobs = { 'app/web DEV': [build(3, HOUR), build(2, 2 * HOUR)], 'app/web PROD': [build(4, 3 * HOUR)], 'lib/build': [build(1, HOUR, { result: 'FAILURE' })] };
  const { svc, call } = service({ state: { jobs } });
  const id = (await call('saveServer', { name: 'ci', url: 'https://ci.test', user: 'a', token: 't' })).id;
  await call('home', { server: id });
  await svc.poll(id);
  for (const verb of ['board', 'heatmap', 'insights', 'report', 'wallboard', 'dashboard', 'timeline']) {
    const answer = await call(verb, { server: id, range: '24h', scope: { folder: 'app' } });
    assert.equal(answer.ok, undefined, `${verb}: ${answer.error ?? ''}`);
  }
  const board = await call('board', { server: id });
  assert.deepEqual(board.rows.map((r) => r.service), ['web']);
  assert.deepEqual(board.envs, ['DEV', 'PROD']);
  const report = await call('report', { server: id, range: '24h', format: 'text' });
  assert.match(report.text, /^CI SUMMARY — ci — last 24h/, 'the server\'s own name is in it');
  assert.match((await call('report', { server: id, format: 'bogus' })).error, /format has to be markdown or text/);
  assert.match((await call('report', { server: id, range: '5y' })).error, /range has to be/);
  assert.match((await call('insights', { server: id, range: '5y' })).error, /range has to be/);
  assert.match((await call('board', { server: 'nope' })).error, /not set up/);
  assert.equal((await call('heatmap', { server: id, days: 'x' })).days, 14);

  const saved = await call('boardSettings', { server: id, order: ['PROD', 'DEV'], includeSingles: true });
  assert.deepEqual(saved.settings.order, ['PROD', 'DEV']);
  assert.equal(saved.settings.includeSingles, true);
  assert.deepEqual((await call('board', { server: id })).envs, ['PROD', 'DEV']);
  assert.match((await call('boardSettings', { server: id, order: 'DEV' })).error, /list of environments/);
  assert.match((await call('boardSettings', { server: id, rowOverrides: { k: { cells: { DEV: '../x' } } } })).error, /not a job path/);
  // An unknown field changes nothing; reading never writes.
  assert.deepEqual((await call('boardSettings', { server: id, junk: 1 })).settings.order, ['PROD', 'DEV']);
  await call('board', { server: id });
  assert.deepEqual((await call('boardSettings', { server: id, order: null })).settings.order, []);
  // The settings go with the server.
  await call('deleteServer', { id });
  assert.deepEqual(svc.metrics.store.boardSettings(id), {});
  svc.stop();
});

test('through the service: a view and "mine" are resolved by the server, not by whoever asked', { skip }, async () => {
  const jobs = { 'app/web DEV': [build(3, HOUR)], 'other/job': [build(1, HOUR)] };
  const { svc, jenkins, call } = service({ state: { jobs } });
  const id = (await call('saveServer', { name: 'ci', url: 'https://ci.test', user: 'a', token: 't' })).id;
  await call('home', { server: id });
  await svc.poll(id);
  await call('dashboard', { server: id });
  const mine = await call('dashboard', { server: id, scope: { mine: true } });
  assert.equal(jenkins.requests.some((r) => r.startsWith('/me/api/json')), true, 'who you are comes from Jenkins');
  assert.equal(mine.ok, undefined);
  const spoof = await call('dashboard', { server: id, scope: { user: 'somebody-else', paths: ['x'], pathSet: new Set(['x']), pathsKey: 'x' } });
  assert.equal(spoof.kpi.finished.count >= 1, true, 'a panel cannot hand in a resolved scope: only the documented fields count');
  const t = await call('timeline', { server: id, range: '24h', scope: { mine: true } });
  assert.equal(Array.isArray(t.runs), true);
  const at = await call('runningAt', { server: id, at: NOW - 30 * MINUTE, scope: { folder: 'app' } });
  assert.equal(Array.isArray(at.running), true);
  svc.stop();
});

// ======================================================================================
// What a review found
// ======================================================================================

test('a spike is a spike against a period the history covers; with nothing before, there is no card', { skip }, async () => {
  const { c } = collector();
  for (let i = 0; i < 20; i += 1) put(c.store, `job${i % 4}`, i + 1, { ago: (i + 1) * 6 * HOUR, result: 'failed' });
  c.store.setBackfill(S, 'running', { windowStart: NOW - 6 * DAY });
  c.store.setBackfill(S, 'done');
  const page = await c.insights(S, fakeApi(), indexOf([]), { range: '7d' });
  assert.equal(find(page, 'failure-spike').length, 0, 'six days of history say nothing about the week before');
  const again = collector();
  for (let i = 0; i < 20; i += 1) put(again.c.store, `job${i % 4}`, i + 1, { ago: (i + 1) * 6 * HOUR, result: 'failed' });
  covered(again.c);
  const full = await again.c.insights(S, fakeApi(), indexOf([]), { range: '7d' });
  assert.equal(find(full, 'failure-spike').length, 1, 'and with the week before recorded, they do');
});

test('a folder full of red jobs is one card, a few are a card each, and the dead are not in it', { skip }, async () => {
  const { c } = collector();
  covered(c);
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    put(c.store, `KUBRIK/TIMELOG/job${i}`, 1, { start: NOW - 4 * DAY, result: 'failed' });
    rows.push(jobRow(`KUBRIK/TIMELOG/job${i}`, { status: 'failed', last: lastOf(1, { status: 'failed', timestamp: NOW - 4 * DAY }) }));
  }
  for (const name of ['solo/a', 'solo/b']) {
    put(c.store, name, 1, { start: NOW - 5 * DAY, result: 'failed' });
    rows.push(jobRow(name, { status: 'failed', last: lastOf(1, { status: 'failed', timestamp: NOW - 5 * DAY }) }));
  }
  put(c.store, 'deleted/job', 1, { start: NOW - 20 * DAY, result: 'failed' });
  put(c.store, 'DEPRECATED/old', 1, { start: NOW - 30 * DAY, result: 'failed' });
  rows.push(jobRow('DEPRECATED/old', { status: 'failed', last: lastOf(1, { status: 'failed', timestamp: NOW - 30 * DAY }) }));
  put(c.store, 'off/job', 1, { start: NOW - 9 * DAY, result: 'failed' });
  rows.push(jobRow('off/job', { status: 'disabled', last: lastOf(1, { status: 'failed', timestamp: NOW - 9 * DAY }) }));
  const index = indexOf(rows);
  await c.afterPoll(S, fakeApi(), index);
  const page = await c.insights(S, fakeApi(), index, { range: '24h' });
  const reds = find(page, 'red-for-days');
  assert.equal(reds.length, 3, '1 for the folder, 2 for the jobs on their own');
  const grouped = reds.find((r) => r.id === 'red-for-days:KUBRIK/TIMELOG');
  assert.match(grouped.title, /12 jobs in KUBRIK\/TIMELOG have been red for 3\+ days/);
  assert.equal(grouped.evidence.count, 12);
  assert.deepEqual(reds.filter((r) => r !== grouped).map((r) => r.jobs[0]).sort(), ['solo/a', 'solo/b']);
  const all = JSON.stringify(page);
  for (const dead of ['deleted/job', 'DEPRECATED/old', 'off/job']) assert.equal(all.includes(dead), false, `${dead} is not red now`);
  const wall = await c.wallboard(S, fakeApi(), index, {});
  assert.equal(wall.counts.failing, 14);
});

test('the board hides old folders unless asked, never promotes along a guess or equal versions, and compares like with like', { skip }, async () => {
  const { c } = collector({ sleep: undefined });
  const names = (base) => [`${base} DEV`, `${base} PROD`];
  const put2 = (path, n, params) => { put(c.store, path, n, { ago: HOUR }); return params; };
  const params = {};
  const add = (path, n, list) => { put(c.store, path, n, { ago: HOUR }); params[`${path}#${n}`] = list; };
  add('same DEV', 3, [{ name: 'VERSION', value: '1.0' }]);
  add('same PROD', 1, [{ name: 'VERSION', value: '1.0' }]);
  add('branch DEV', 3, [{ name: 'BRANCH', value: 'develop' }]);
  add('branch PROD', 1, [{ name: 'BRANCH', value: 'main' }]);
  add('kinds DEV', 3, [{ name: 'VERSION', value: '2.0' }]);
  add('kinds PROD', 1, [{ name: 'IMAGE_TAG', value: '1.0' }]);
  add('ahead DEV', 3, [{ name: 'VERSION', value: '2.0' }]);
  add('ahead PROD', 1, [{ name: 'VERSION', value: '1.0' }]);
  add('Billing_DEV', 1, [{ name: 'VERSION', value: '2.0' }]);
  add('Billing_PROD', 1, [{ name: 'VERSION', value: '1.0' }]);
  put(c.store, 'billing-prod', 1, { ago: HOUR });
  add('Legacy/old DEV', 1, [{ name: 'VERSION', value: '2.0' }]);
  add('Legacy/old PROD', 1, [{ name: 'VERSION', value: '1.0' }]);
  void names; void put2;
  const job = (path, n) => jobRow(path, { last: lastOf(n, { timestamp: NOW - HOUR }) });
  const index = indexOf([job('same DEV', 3), job('same PROD', 1), job('branch DEV', 3), job('branch PROD', 1), job('kinds DEV', 3), job('kinds PROD', 1), job('ahead DEV', 3), job('ahead PROD', 1),
    job('Billing_DEV', 1), job('Billing_PROD', 1), job('billing-prod', 1), job('Legacy/old DEV', 1), job('Legacy/old PROD', 1)]);
  const api = fakeApi({ params });
  await c.board(S, api, index, {});
  await new Promise((resolve) => setImmediate(resolve));
  const page = await c.board(S, api, index, {});
  const row = (name) => page.rows.find((r) => r.service === name);
  assert.deepEqual(page.rows.map((r) => r.service).sort(), ['Billing', 'ahead', 'branch', 'kinds', 'same'], 'the old folder is not there');
  assert.equal(page.hiddenInactive, 1);
  assert.deepEqual(row('same').promotable, [], 'the same version in both: nothing to promote, however often DEV was rebuilt');
  assert.equal(row('same').drift[0].versionsDiffer, false);
  assert.deepEqual(row('same').drift[0].behind, 0);
  assert.equal(row('branch').drift[0].versionsDiffer, null, 'develop against main is not "different versions"');
  assert.equal(row('kinds').drift[0].versionsDiffer, null, 'VERSION against IMAGE_TAG is not a comparison');
  assert.deepEqual(row('ahead').promotable, [{ from: 'DEV', to: 'PROD' }]);
  assert.equal(row('Billing').ambiguous, true);
  assert.deepEqual(row('Billing').promotable, [], 'two PRODs: nobody chose');
  assert.deepEqual(row('Billing').candidates.PROD, ['Billing_PROD', 'billing-prod']);
  assert.equal(page.notes.some((n) => /two jobs for one environment/.test(n)), true);
  const withOld = await c.board(S, api, index, { showInactive: true });
  const old = withOld.rows.find((r) => r.service === 'old');
  assert.equal(old.inactive, true);
  assert.deepEqual(old.promotable, [], 'shown on request, never promoted');
  assert.equal(withOld.hiddenInactive, 0);
});
