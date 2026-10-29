'use strict';

/**
 * Starting builds, against a Jenkins that is not there.
 *
 * What is checked is what would go wrong with a person's deploy: a batch that
 * starts half of itself, a schedule that fires three hours late, a secret that
 * ends up in a table, a promotion that copies the wrong version or a password,
 * a click that starts everything twice, a build that was started and never
 * heard of again. The Jenkins here is a small one with state: a queue that
 * turns into builds when told to, and builds that end when told to.
 *
 * Needs `node:sqlite` (Node 22+) and skips itself without it.
 */

const test = require('node:test');
const assert = require('node:assert');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

const { JenkinsError } = require('../electron/jenkins-api');
const launchModule = require('../electron/jenkins-launch');
const { Launch, familyOf, paramsIn, splitSecrets } = launchModule;
const { JenkinsService } = sqlite ? require('../electron/jenkins-service') : {};
const { fakeActiveChoices } = require('./support/active-choices-jenkins');

const T0 = Date.parse('2026-10-16T12:00:00Z');
const MASK = '••••••';
const STATUS_RESULT = { success: 'SUCCESS', failed: 'FAILURE', unstable: 'UNSTABLE', aborted: 'ABORTED' };

// --- a Jenkins with a queue and builds -------------------------------------------------

const def = (name, extra = {}) => ({ name, type: 'string', description: '', default: '', choices: null, secret: false, ...extra });

function world() {
  const w = {
    now: T0,
    jobs: new Map(),
    queue: new Map(),
    runs: [],
    nextQueue: 500,
    gets: [],
    down: false,
    failRun: new Map(),
    noLocation: false,
    events: [],
    notes: [],
    follows: [],
    favorites: [],
  };
  w.add = (path, { buildable = true, params = [], builds = [], inQueue = false } = {}) => {
    const job = {
      buildable,
      params,
      inQueue,
      builds: builds.map((b, at) => ({ number: builds.length - at, status: 'success', running: false, duration: 60_000, timestamp: T0 - (at + 1) * 3_600_000, params: [], changes: [], ...b })),
    };
    w.jobs.set(path, job);
    return job;
  };
  const need = (path) => {
    const job = w.jobs.get(path);
    if (!job) throw new JenkinsError('Jenkins has nothing there', 404);
    return job;
  };
  /** Jenkins takes a queue item and makes a build of it. */
  w.start = (queueId) => {
    const item = w.queue.get(queueId);
    const job = need(item.path);
    const number = (job.builds[0]?.number ?? 0) + 1;
    job.builds.unshift({ number, status: 'running', running: true, duration: 0, timestamp: w.now, params: Object.entries(item.params).map(([name, value]) => ({ name, value })), queueId, changes: [] });
    item.number = number;
    item.timestamp = w.now;
    job.inQueue = false;
    return number;
  };
  w.finish = (path, number, status = 'success', duration = 30_000) => {
    const build = need(path).builds.find((one) => one.number === number);
    Object.assign(build, { status, running: false, duration });
  };
  w.rows = () => new Map([...w.jobs].map(([path, job]) => {
    const last = job.builds[0] ?? null;
    return [path, { kind: 'job', path, name: path.split('/').pop(), status: last ? (last.running ? 'success' : last.status) : 'none', running: Boolean(last?.running), last: last ? { number: last.number, status: last.running ? 'running' : last.status, timestamp: last.timestamp, duration: last.duration } : null }];
  }));
  const ok = (body) => ({ status: 200, bytes: Buffer.from(JSON.stringify(body)), tooBig: false });
  w.api = {
    async job(path, { builds = 40 } = {}) {
      const job = need(path);
      return {
        path, name: path.split('/').pop(), kind: 'job', status: 'success', buildable: job.buildable, inQueue: job.inQueue, parameters: job.params,
        builds: job.builds.slice(0, builds).map((b) => ({ number: b.number, status: b.running ? 'running' : b.status, running: b.running, duration: b.duration, timestamp: b.timestamp })),
        newest: job.builds[0]?.number ?? null,
      };
    },
    async run(path, params, parameterized) {
      const job = need(path);
      if (w.failRun.has(path)) throw new JenkinsError(w.failRun.get(path), 500);
      if (!job.buildable) throw new JenkinsError('Jenkins answered 409', 409);
      const id = w.nextQueue;
      w.nextQueue += 1;
      w.queue.set(id, { path, params: { ...params }, number: null, cancelled: false });
      w.runs.push({ path, params: { ...params }, parameterized, queueId: id });
      job.inQueue = true;
      return { queued: w.noLocation ? null : id };
    },
    async build(path, number) {
      const b = need(path).builds.find((one) => one.number === number);
      if (!b) throw new JenkinsError('Jenkins has nothing there', 404);
      return {
        number, status: b.running ? 'running' : b.status, running: b.running, timestamp: b.timestamp, duration: b.duration,
        parameters: b.params.map(({ name, value }) => ({ name, value: /pass|secret|token|key/i.test(name) ? MASK : value })),
      };
    },
    async rawGet(url) {
      w.gets.push(url);
      if (w.down) throw new JenkinsError('Could not reach Jenkins: ECONNREFUSED');
      const [at, query = ''] = url.split('?');
      const queued = /^\/queue\/item\/(\d+)\/api\/json$/.exec(at);
      if (queued) {
        const item = w.queue.get(Number(queued[1]));
        if (!item || item.forgotten) throw new JenkinsError('Jenkins has nothing there', 404);
        return ok({ id: Number(queued[1]), cancelled: item.cancelled, why: 'Waiting for next available executor', task: { fullName: item.task ?? item.path }, ...(item.number ? { executable: { number: item.number, timestamp: item.timestamp } } : {}) });
      }
      const page = /^((?:\/job\/[^/]+)+)(?:\/(\d+))?\/api\/json$/.exec(at);
      assert.ok(page, `unexpected page ${url}`);
      const path = page[1].split('/job/').slice(1).map(decodeURIComponent).join('/');
      const job = need(path);
      if (page[2]) {
        const b = job.builds.find((one) => one.number === Number(page[2]));
        if (!b) throw new JenkinsError('Jenkins has nothing there', 404);
        return ok({ building: b.running, result: b.running ? null : STATUS_RESULT[b.status] ?? 'FAILURE', duration: b.duration, timestamp: b.timestamp });
      }
      if (query.includes('changeSets')) {
        return ok({ builds: job.builds.map((b) => ({ number: b.number, changeSets: [{ items: b.changes }] })) });
      }
      return ok({ builds: job.builds.slice(0, 15).map((b) => ({ number: b.number, queueId: b.queueId, timestamp: b.timestamp })) });
    },
    async viewJobs() { return []; },
  };
  return w;
}

function setup(w = world(), options = {}) {
  const db = options.db ?? new sqlite.DatabaseSync(':memory:');
  const launch = new Launch({
    archive: { db },
    on: () => ({ server: { id: 's1', name: 'ci', url: 'https://ci.test' }, api: w.api }),
    index: async () => ({ rows: w.rows() }),
    favorites: () => w.favorites,
    follow: (id, path, number) => w.follows.push([path, number]),
    presets: async () => ({ presets: w.presets ?? [] }),
    emit: (event) => w.events.push(event),
    notify: (...args) => w.notes.push(args),
    nudge: () => {},
    now: () => w.now,
    sleep: async () => {},
    maintain: false,
    ...options.launch,
  });
  const verbs = launch.verbs();
  const call = (name, args = {}) => verbs[name]({ server: 's1', ...args });
  const refused = async (name, args = {}) => {
    try { await call(name, args); } catch (error) { return String(error.message); }
    return assert.fail(`${name} should have been refused`);
  };
  /** Wait for a condition that a batch's driver brings about on its own. */
  const until = async (fn, what = 'the condition') => {
    for (let i = 0; i < 400; i += 1) {
      await launch.poll();
      if (fn()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`never: ${what}`);
  };
  return { w, db, launch, call, refused, until };
}

const rowsOf = (db, sql, ...args) => db.prepare(sql).all(...args);

// --- families ------------------------------------------------------------------------
//
// The detection itself is jenkins-board.js's (and tested there); what is checked here is that promotion
// uses it, on the names this Jenkins really has, and the words a person added.

const jobs = (paths) => paths.map((path) => ({ kind: 'job', path }));

test('promotion sees the families the board sees, on this Jenkins\' real names', () => {
  const rows = jobs([
    'KUBRIK/TIMELOG/TIMELOG MS DEV', 'KUBRIK/TIMELOG/TIMELOG MS PROD', 'KUBRIK/TIMELOG/AGENT MS DEV', 'KUBRIK/TIMELOG/AGENT MS PROD',
    'KUBRIK/TIMELOG/KUBRIK-CORE-DEV', 'KUBRIK/TIMELOG/KUBRIK-CORE-PROD', 'KUBRIK/TIMELOG/TIMELOGBOOK-V5-DEV', 'KUBRIK/TIMELOG/TIMELOGBOOK-V5-PROD',
    'KUBRIK/TIMELOG/PROJECTS MS DEV', 'KUBRIK/TIMELOG/TLOG WEBSITE',
  ]);
  for (const name of ['TIMELOG MS', 'AGENT MS', 'KUBRIK-CORE', 'TIMELOGBOOK-V5']) {
    const dev = familyOf(rows, `KUBRIK/TIMELOG/${name} DEV`.replace('KUBRIK-CORE DEV', 'KUBRIK-CORE-DEV').replace('TIMELOGBOOK-V5 DEV', 'TIMELOGBOOK-V5-DEV'));
    assert.ok(dev && !dev.single, name);
    assert.equal(dev.downstream[0].env, 'PROD', name);
  }
  assert.equal(familyOf(rows, 'KUBRIK/TIMELOG/PROJECTS MS DEV').single, true, 'PROJECTS is not PRO, and one job is not a family');
  assert.equal(familyOf(rows, 'KUBRIK/TIMELOG/TLOG WEBSITE'), null);
});

// --- arguments -------------------------------------------------------------------------

test('parameters are text by name; a value that is not text, or a name Jenkins could not have, is refused', () => {
  assert.deepEqual({ ...paramsIn({ A: 1, B: true, C: 'x', D: null }) }, { A: '1', B: 'true', C: 'x', D: '' });
  assert.equal(paramsIn({ T: 'line one\nline two\ttab' }).T, 'line one\nline two\ttab', 'a text parameter keeps its newlines');
  assert.equal(Object.getPrototypeOf(paramsIn({ __proto__x: 'ok' })), null);
  assert.throws(() => paramsIn({ A: 'x\u0000y' }), /characters that are not text/);
  assert.throws(() => paramsIn({ A: 'x\u001by' }), /characters that are not text/);
  assert.throws(() => paramsIn({ A: 'x'.repeat(4001) }), /longer than 4000/);
  assert.throws(() => paramsIn({ 'a/b': 'x' }), /not a name/);
  assert.throws(() => paramsIn({ A: { nested: 1 } }), /has to be text/);
  assert.throws(() => paramsIn(['x']), /list of names and values/);
  assert.throws(() => paramsIn(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`P${i}`, 'x']))), /more parameters/);
  assert.deepEqual({ ...paramsIn(undefined) }, {});
});

test('what is kept of a launch never holds a secret, only that there was one', () => {
  const defs = [def('VERSION'), def('API_KEY', { type: 'password', secret: true }), def('DB_PASSWORD')];
  const { kept, needs } = splitSecrets(defs, { VERSION: '1.0', API_KEY: 'hunter2', DB_PASSWORD: 'p4ss', OTHER: 'y' });
  assert.deepEqual(kept, { VERSION: '1.0', OTHER: 'y' });
  assert.deepEqual(needs.sort(), ['API_KEY', 'DB_PASSWORD']);
  // A name that sounds like a secret is one, whatever the job's definition says.
  assert.deepEqual(splitSecrets([], { GITHUB_TOKEN: 'ghp_x', NAME: 'n' }).kept, { NAME: 'n' });
});

// --- following a launch to the end ----------------------------------------------------------

test('a launch is followed from the queue to the build to its end, and the history says how it went', { skip }, async () => {
  const w = world();
  w.add('app', { params: [def('VERSION', { default: '1.0' })], builds: [{ number: 4, status: 'success' }] });
  const { launch, call, db } = setup(w);
  const id = launch.record('s1', 'app', { VERSION: '2.0' }, { queued: 501 }, { defs: w.jobs.get('app').params, after: 4 });
  assert.ok(id);
  w.nextQueue = 502;
  w.queue.set(501, { path: 'app', params: { VERSION: '2.0' }, number: null, cancelled: false });

  await launch.poll();
  assert.equal((await call('launchHistory')).rows[0].state, 'queued', 'still waiting in Jenkins\' queue');
  const number = w.start(501);
  assert.equal(number, 5);
  await launch.poll();
  let row = (await call('launchHistory')).rows[0];
  assert.deepEqual([row.state, row.number, row.queueId, row.source], ['running', 5, 501, 'manual']);
  assert.deepEqual(w.follows, [['app', 5]], 'and it is followed, so a notification says when it ends');
  w.now += 90_000;
  w.finish('app', 5, 'failed', 80_000);
  await launch.poll();
  row = (await call('launchHistory')).rows[0];
  assert.equal(row.state, 'failed');
  assert.equal(row.durationMs, row.endedAt - row.startedAt);
  assert.deepEqual(row.params, { VERSION: '2.0' });
  assert.deepEqual(w.events.filter((e) => e.type === 'launch').map((e) => e.state), ['queued', 'running', 'failed']);
  // Nothing in flight any more: nothing more is asked of Jenkins.
  const asked = w.gets.length;
  await launch.poll();
  assert.equal(w.gets.length, asked);
  assert.equal(rowsOf(db, "SELECT COUNT(*) AS n FROM jl_launch WHERE state IN ('queued','running')")[0].n, 0);
});

test('a queue item that Jenkins forgot is found again through the build that carries its id; one that was cancelled is lost', { skip }, async () => {
  const w = world();
  w.add('app', { builds: [{ number: 1 }] });
  const { launch, call } = setup(w);
  // Started and gone from the queue's memory: the job's builds know which queue item each came from.
  const first = launch.record('s1', 'app', {}, { queued: 601 }, { after: 1 });
  w.queue.set(601, { path: 'app', params: {}, number: null, cancelled: false });
  w.start(601);
  w.queue.get(601).forgotten = true;
  await launch.poll();
  let rows = (await call('launchHistory')).rows;
  assert.deepEqual([rows[0].id, rows[0].state, rows[0].number], [first, 'running', 2]);
  // Cancelled in Jenkins' queue.
  launch.record('s1', 'app', {}, { queued: 602 }, { after: 2 });
  w.queue.set(602, { path: 'app', params: {}, number: null, cancelled: true });
  await launch.poll();
  rows = (await call('launchHistory')).rows;
  assert.equal(rows[0].state, 'lost');
  assert.match(rows[0].error, /taken out of the Jenkins queue/);
});

test('a start whose answer carried no queue address is matched to the first build since', { skip }, async () => {
  const w = world();
  w.noLocation = true;
  w.add('app', { builds: [{ number: 7 }] });
  const { launch, call } = setup(w);
  const id = launch.record('s1', 'app', {}, { queued: null }, { after: 7 });
  w.queue.set(500, { path: 'app', params: {}, number: null, cancelled: false });
  w.now += 3000;
  w.start(500);
  await launch.poll();
  const row = (await call('launchHistory')).rows.find((r) => r.id === id);
  assert.deepEqual([row.state, row.number], ['running', 8]);
});

test('what was in flight when the app closed is found again when it opens', { skip }, async () => {
  const w = world();
  w.add('app', { builds: [{ number: 1 }] });
  const first = setup(w);
  first.launch.record('s1', 'app', {}, { queued: 700 }, { after: 1 });
  w.queue.set(700, { path: 'app', params: {}, number: null, cancelled: false });
  first.launch.stop();
  w.start(700);
  w.finish('app', 2, 'success');
  // A new process, the same file.
  const again = setup(w, { db: first.db });
  await again.launch.poll();
  await again.launch.poll();
  const row = (await again.call('launchHistory')).rows[0];
  assert.deepEqual([row.state, row.number], ['success', 2]);
  assert.deepEqual(w.follows, [['app', 2]]);
});

test('Jenkins not answering is not a verdict, but one that has said nothing for hours is let go', { skip }, async () => {
  const w = world();
  w.add('app', { builds: [{ number: 1 }] });
  const { launch, call } = setup(w);
  launch.record('s1', 'app', {}, { queued: 800 }, { after: 1 });
  w.queue.set(800, { path: 'app', params: {}, number: null, cancelled: false });
  w.down = true;
  await launch.poll();
  assert.equal((await call('launchHistory')).rows[0].state, 'queued');
  w.now += 7 * 3_600_000;
  await launch.poll();
  const row = (await call('launchHistory')).rows[0];
  assert.equal(row.state, 'lost');
  assert.match(row.error, /did not say how it ended/);
});

// --- the history ----------------------------------------------------------------------------

test('the history has the newest first, pages, filters by job and batch, and is bounded', { skip }, async () => {
  const w = world();
  w.add('a'); w.add('b');
  const { launch, call, db } = setup(w);
  for (let i = 0; i < 5; i += 1) launch.record('s1', i % 2 ? 'a' : 'b', {}, { queued: 900 + i }, {});
  const all = await call('launchHistory');
  assert.equal(all.rows.length, 5);
  assert.equal(all.rows[0].id > all.rows[4].id, true);
  const page = await call('launchHistory', { limit: 2 });
  assert.deepEqual([page.rows.length, page.more], [2, true]);
  const next = await call('launchHistory', { limit: 2, before: page.rows[1].id });
  assert.equal(next.rows[0].id < page.rows[1].id, true);
  assert.equal((await call('launchHistory', { path: 'a' })).rows.every((r) => r.path === 'a'), true);
  assert.equal((await call('launchHistory', { limit: 5000 })).rows.length, 5, 'the page is capped, not refused');
  // Old rows go: ninety days, never what is still in flight.
  db.prepare("UPDATE jl_launch SET at = ?, state = 'success' WHERE id = ?").run(T0 - 100 * 86_400_000, all.rows[4].id);
  db.prepare('UPDATE jl_launch SET at = ? WHERE id = ?').run(T0 - 100 * 86_400_000, all.rows[3].id);
  launch.record('s1', 'a', {}, { queued: 990 }, {});
  launch.inserts = 0;
  launch.record('s1', 'a', {}, { queued: 991 }, {});
  const ids = (await call('launchHistory', { limit: 200 })).rows.map((r) => r.id);
  assert.equal(ids.includes(all.rows[4].id), false, 'a finished one older than ninety days is gone');
  assert.equal(ids.includes(all.rows[3].id), true, 'one still in flight stays');
});

test('a secret is in no table, in no event, and in no answer', { skip }, async () => {
  const w = world();
  w.add('deploy', { params: [def('VERSION', { default: '1' }), def('API_KEY', { type: 'password', secret: true })] });
  const { launch, call, db } = setup(w);
  w.favorites = ['deploy'];
  await call('runMany', { items: [{ path: 'deploy', params: { VERSION: '2', API_KEY: 'SECRET-VALUE-1' } }] });
  await new Promise((resolve) => setImmediate(resolve));
  await launch.poll();
  launch.record('s1', 'deploy', { VERSION: '3', API_KEY: 'SECRET-VALUE-2', MY_TOKEN: 'SECRET-VALUE-3' }, { queued: 1 }, { defs: w.jobs.get('deploy').params });
  await refusedSchedule(call);
  const everything = JSON.stringify([
    db.prepare('SELECT * FROM jl_launch').all(), db.prepare('SELECT * FROM jl_batch').all(), db.prepare('SELECT * FROM jl_schedule').all(),
    w.events, w.notes, await call('launchHistory'), await call('launchpad'), await call('schedules'),
  ]);
  assert.equal(/SECRET-VALUE/.test(everything), false, 'not in what was kept, not in what was said');
  // It was sent to Jenkins, though: that is what it was for.
  assert.equal(w.runs.some((r) => r.params.API_KEY === 'SECRET-VALUE-1'), true);
  const rows = (await call('launchHistory')).rows;
  assert.deepEqual(rows[0].needsInput.sort(), ['API_KEY', 'MY_TOKEN'], 'the names are kept, so that "again" knows to ask');
});

async function refusedSchedule(call) {
  try { await call('scheduleRun', { path: 'deploy', at: T0 + 3_600_000, params: { API_KEY: 'SECRET-VALUE-4' } }); } catch { /* refused: that is the point */ }
}

// --- the plan ----------------------------------------------------------------------------------

test('a plan says, for each job, whether it can run, what with, and what to know first', { skip }, async () => {
  const w = world();
  w.add('ok', { params: [def('VERSION', { default: '1' }), def('ENV', { type: 'choice', default: 'staging', choices: ['staging', 'production'] })], builds: [{ number: 3, duration: 100_000 }, { number: 2, duration: 300_000 }, { number: 1, duration: 200_000 }] });
  w.add('off', { buildable: false });
  w.add('secret', { params: [def('API_KEY', { type: 'password', secret: true })] });
  w.add('blank', { params: [def('TICKET')] });
  w.add('running', { builds: [{ number: 5, status: 'running', running: true }] });
  const { call } = setup(w);
  const plan = await call('launchPlan', { items: [
    { path: 'ok', params: { VERSION: '2', ENV: 'production', NOPE: 'x' } }, { path: 'off' }, { path: 'gone' }, { path: 'secret' }, { path: 'blank' }, { path: 'running' }, { path: 'ok', params: { ENV: 'moon' } },
  ] });
  const by = (n) => plan.items[n];
  assert.deepEqual([by(0).ok, by(0).ready, by(0).looksProd, by(0).expectedMs], [true, true, true, 200_000]);
  assert.deepEqual(by(0).unknown, ['NOPE']);
  assert.deepEqual(by(0).params, { VERSION: '2', ENV: 'production' });
  assert.deepEqual([by(1).ok, by(1).errors[0]], [false, 'off is disabled — enable it in Jenkins first']);
  assert.match(by(2).errors[0], /gone does not exist/);
  assert.deepEqual([by(3).ok, by(3).ready, by(3).needsInput], [true, false, ['API_KEY']], 'runnable, but somebody has to type it');
  assert.deepEqual([by(4).ok, by(4).missing], [true, ['TICKET']], 'no default and not given: a warning, not a refusal');
  assert.equal(by(5).running, true);
  assert.match(by(5).warnings.join(' '), /running now/);
  assert.deepEqual([by(6).ok, by(6).badChoice[0].name], [false, 'ENV']);
  assert.deepEqual([plan.valid, plan.ready], [false, false]);
  assert.equal(plan.counts.prod, 1);
  assert.equal(plan.counts.running, 1);
  assert.match(plan.warnings.join(' '), /already running/);
});

test('"re-run all failed" plans exactly the jobs failing now, with what each failed with', { skip }, async () => {
  const w = world();
  w.add('web/a', { params: [def('VERSION')], builds: [{ number: 2, status: 'failed', params: [{ name: 'VERSION', value: '9' }] }] });
  w.add('web/b', { builds: [{ number: 1, status: 'unstable' }] });
  w.add('api/c', { builds: [{ number: 1, status: 'failed' }] });
  w.add('web/ok', { builds: [{ number: 1, status: 'success' }] });
  w.add('web/busy', { builds: [{ number: 3, status: 'running', running: true }] });
  const { call } = setup(w);
  const all = await call('launchPlan', { retryFailed: true });
  assert.deepEqual(all.items.map((i) => i.path).sort(), ['api/c', 'web/a', 'web/b']);
  assert.deepEqual(all.items.find((i) => i.path === 'web/a').params, { VERSION: '9' }, 'the same parameters, not the defaults');
  assert.equal(all.items.find((i) => i.path === 'web/a').fromNumber, 2);
  const scoped = await call('launchPlan', { retryFailed: true, scope: { folder: 'web' } });
  assert.deepEqual(scoped.items.map((i) => i.path).sort(), ['web/a', 'web/b']);
  const none = await call('launchPlan', { retryFailed: true, scope: { folder: 'nowhere' } });
  assert.equal(none.items.length, 0);
  assert.equal(none.valid, true);
});

/** A job like LIB RELEASE: a block and a list that Jenkins works out from the other parameters. */
function reactiveWorld(fake, builds) {
  const w = world();
  w.add('lib', {
    params: [
      def('CURRENT_VERSIONS', { type: 'dynamicreferenceparameter', description: 'What releasing would publish.' }),
      def('LIB', { type: 'choice', choices: ['common', 'mongo-common'] }),
      def('BUMP', { type: 'cascadechoiceparameter', description: 'What to do with the pom.' }),
      def('OVERWRITE', { type: 'choice', choices: ['NO', 'YES'], default: 'NO' }),
    ],
    builds,
  });
  w.api.rawGet = ((plain) => async (url, opts) => (/\/build\?delay=0sec$|\/\$stapler\//.test(url) ? fake.api.rawGet(url, opts) : plain(url, opts)))(w.api.rawGet);
  w.api.rawPost = fake.api.rawPost;
  return w;
}

test('a plan holds what Jenkins works out for its reactive parameters, for the values the form starts from', { skip }, async () => {
  const fake = fakeActiveChoices();
  const w = reactiveWorld(fake, [{ number: 5, status: 'success', params: [{ name: 'LIB', value: 'mongo-common' }, { name: 'BUMP', value: 'PATCH' }, { name: 'OVERWRITE', value: 'NO' }] }]);
  const { call } = setup(w);
  const plan = await call('paramPlan', { path: 'lib' });
  const of = (name) => plan.params.find((p) => p.name === name);
  // The page was built for `common`; the last good run was `mongo-common`, so what it holds is asked for again.
  assert.deepEqual(of('BUMP').choices, ['POM (2.3.0)', 'MINOR', 'PATCH', 'MAJOR']);
  assert.deepEqual([of('BUMP').type, of('BUMP').suggested, of('BUMP').source, of('BUMP').reactive, of('BUMP').refs], ['choice', 'PATCH', 'last successful build', true, ['LIB']]);
  assert.deepEqual([of('CURRENT_VERSIONS').type, of('CURRENT_VERSIONS').required, of('CURRENT_VERSIONS').suggested], ['display', false, null]);
  assert.equal(of('CURRENT_VERSIONS').view[1].runs[0].t, 'Will release.', 'the sentence about mongo-common, not about common');
  assert.equal(plan.callPreview.body, 'LIB=mongo-common&BUMP=PATCH&OVERWRITE=NO', 'a block that only shows is not sent');
  assert.equal(fake.model.pages, 2, 'the form page, then once more inside the question');
});

test('a plan that starts where the form was built does not ask Jenkins to work anything out again', { skip }, async () => {
  const fake = fakeActiveChoices();
  const w = reactiveWorld(fake, []);
  const { call } = setup(w);
  const plan = await call('paramPlan', { path: 'lib' });
  const of = (name) => plan.params.find((p) => p.name === name);
  assert.deepEqual(of('BUMP').choices, ['POM (2.5.3)', 'MINOR', 'PATCH', 'MAJOR']);
  assert.equal(of('BUMP').default, 'POM (2.5.3)', 'what Jenkins marks is where it starts, so the form is never one that cannot be run');
  assert.equal(of('CURRENT_VERSIONS').view[0].type, 'table');
  assert.equal(fake.model.calls.some((c) => c.method === 'POST'), false, 'nothing was run on Jenkins');
});

test('a Jenkins that cannot say leaves the reactive parameters the plain fields they were', { skip }, async () => {
  const w = reactiveWorld(fakeActiveChoices({ down: true }), []);
  const { call } = setup(w);
  const plan = await call('paramPlan', { path: 'lib' });
  const of = (name) => plan.params.find((p) => p.name === name);
  assert.deepEqual([of('BUMP').type, of('BUMP').choices, of('BUMP').reactive], ['cascadechoiceparameter', null, undefined]);
  assert.equal(of('LIB').type, 'choice');
  // Asked again for one value, it is a refusal with words, as for any other verb.
  await assert.rejects(call('paramRefresh', { path: 'lib', values: { LIB: 'common' } }), /Could not reach Jenkins/);
});

test('refreshing says, per parameter, what a change of the others does — and takes only what it is given as text', { skip }, async () => {
  const fake = fakeActiveChoices();
  const w = reactiveWorld(fake, []);
  const { call } = setup(w);
  const reply = await call('paramRefresh', { path: 'lib', values: { LIB: 'mongo-common', BUMP: 'MINOR', OVERWRITE: 'YES', EVIL: { x: 1 }, LIST: [1] } });
  assert.deepEqual(reply.params.BUMP.choices, ['POM (2.3.0)', 'MINOR', 'PATCH', 'MAJOR']);
  assert.equal(reply.params.BUMP.selected, 'POM (2.3.0)');
  assert.equal(reply.params.CURRENT_VERSIONS.view[1].runs[0].t, 'Will release.');
  assert.equal(JSON.stringify(fake.model.calls).includes('EVIL'), false);
  assert.deepEqual((await call('paramRefresh', { path: 'plain-job-without-params', values: {} }).catch(() => ({ params: 'refused' }))).params, 'refused', 'a job that does not exist is a refusal');
  for (const bad of [null, [], 'LIB=common', 5]) {
    const out = await call('paramRefresh', { path: 'lib', values: bad });
    assert.ok(out.params, 'a value that is not a set of values is no values');
  }
});

test('the parameter plan says where each value came from, never fills a secret, and shows the exact request', { skip }, async () => {
  const w = world();
  w.add('deploy', {
    params: [def('VERSION', { default: '1.0' }), def('ENV', { type: 'choice', default: 'staging', choices: ['staging', 'production'] }), def('API_KEY', { type: 'password', secret: true }), def('TICKET')],
    builds: [
      { number: 9, status: 'failed', params: [{ name: 'VERSION', value: '2.1' }, { name: 'ENV', value: 'staging' }, { name: 'TICKET', value: 'T-1' }, { name: 'API_KEY', value: 'x' }] },
      { number: 8, status: 'success', params: [{ name: 'VERSION', value: '2.0' }, { name: 'ENV', value: 'production' }, { name: 'TICKET', value: 'T-0' }] },
    ],
  });
  w.presets = [{ name: 'hotfix', values: { VERSION: '2.0.1', GONE: 'x' } }];
  const { launch, call } = setup(w);
  // Nothing launched from here yet: the last successful build is the best there is.
  let plan = await call('paramPlan', { path: 'deploy' });
  const of = (name) => plan.params.find((p) => p.name === name);
  assert.deepEqual([of('VERSION').suggested, of('VERSION').source], ['2.0', 'last successful build']);
  assert.deepEqual(of('VERSION').others.map((o) => [o.source, o.value]), [['default', '1.0']]);
  assert.deepEqual([of('ENV').suggested, of('ENV').choiceOk], ['production', true]);
  assert.equal(of('ENV').looksProd, true);
  assert.deepEqual([of('API_KEY').suggested, of('API_KEY').needsInput, of('API_KEY').source, of('API_KEY').secret], [null, true, null, true]);
  assert.deepEqual([of('TICKET').required, of('TICKET').suggested], [true, 'T-0']);
  assert.deepEqual(plan.presets, [{ name: 'hotfix', values: { VERSION: '2.0.1', GONE: 'x' }, covers: ['VERSION'] }]);
  assert.equal(plan.looksProd, true);
  assert.equal(plan.callPreview.method, 'POST');
  assert.equal(plan.callPreview.url, 'https://ci.test/job/deploy/buildWithParameters');
  assert.match(plan.callPreview.body, /^VERSION=2\.0&ENV=production&API_KEY=••••&TICKET=T-0$/, 'in the job\'s own order, the secret hidden');
  assert.equal(/hunter|SECRET/.test(JSON.stringify(plan)), false);

  // Launched from here: that is what "last run by me" says now, ahead of the last success.
  launch.record('s1', 'deploy', { VERSION: '3.3', ENV: 'staging' }, { queued: 1 }, { defs: w.jobs.get('deploy').params });
  plan = await call('paramPlan', { path: 'deploy' });
  assert.deepEqual([of('VERSION').suggested, of('VERSION').source], ['3.3', 'last run by me']);
  assert.equal(of('VERSION').others.some((o) => o.source === 'last successful build'), true);

  // Again, the same as build 9: its own values, and its masked secret flagged.
  plan = await call('paramPlan', { path: 'deploy', fromNumber: 9 });
  assert.deepEqual([of('VERSION').suggested, of('VERSION').source], ['2.1', 'build #9']);
  assert.equal(of('API_KEY').suggested, null);
  assert.equal(plan.fromNumber, 9);
  // A value the job would no longer accept is not a suggestion.
  w.jobs.get('deploy').builds[0].params = [{ name: 'ENV', value: 'moon' }];
  plan = await call('paramPlan', { path: 'deploy', fromNumber: 9 });
  assert.notEqual(of('ENV').suggested, 'moon');
});

// --- starting many ------------------------------------------------------------------------------

test('starting several at once validates all first, and one that cannot run refuses the batch, naming it', { skip }, async () => {
  const w = world();
  w.add('a'); w.add('b', { buildable: false }); w.add('c', { params: [def('API_KEY', { type: 'password', secret: true })] });
  const { call, refused } = setup(w);
  const why = await refused('runMany', { items: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] });
  assert.match(why, /^Nothing was started\. 2 jobs cannot run/);
  assert.match(why, /b: b is disabled/);
  assert.match(why, /c: API_KEY has to be typed/);
  assert.equal(w.runs.length, 0, 'not even the one that could have');
  assert.match(await refused('runMany', { items: [] }), /nothing to run/);
  assert.match(await refused('runMany', { items: Array.from({ length: 21 }, (_, i) => ({ path: `j${i}` })) }), /At most 20/);
  assert.match(await refused('runMany', { items: [{ path: 'a/../x' }] }), /not a name/);
  assert.match(await refused('runMany', { items: [{ path: 'a', params: { P: 'x\u0000' } }] }), /not text/);
  // With skipInvalid the rest goes, and the others are said to have been skipped.
  const result = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }, { path: 'c' }], skipInvalid: true });
  assert.deepEqual(result.items.map((i) => [i.path, i.state]), [['a', 'waiting'], ['b', 'error'], ['c', 'error']]);
  assert.match(result.items[1].error, /disabled/);
});

test('in parallel every item starts, a little apart; the batch reports each and then that it is done', { skip }, async () => {
  const w = world();
  const pauses = [];
  ['a', 'b', 'c'].forEach((path) => w.add(path, { builds: [{ number: 1 }] }));
  const { launch, call, until } = setup(w, { launch: { sleep: async (ms) => { pauses.push(ms); }, staggerMs: 250 } });
  const batch = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }, { path: 'c' }], mode: 'parallel' });
  assert.match(batch.batchId, /^batch-[0-9a-f]{8}$/);
  assert.deepEqual([batch.mode, batch.done, batch.deduplicated], ['parallel', false, false]);
  await until(() => w.runs.length === 3, 'all three launched');
  assert.deepEqual(w.runs.map((r) => r.path), ['a', 'b', 'c']);
  assert.deepEqual(pauses, [250, 250], 'two pauses between three launches');
  [...w.queue.keys()].forEach((id) => w.start(id));
  ['a', 'b', 'c'].forEach((path) => w.finish(path, 2, path === 'b' ? 'failed' : 'success'));
  await until(() => w.events.some((e) => e.type === 'batch' && e.done), 'the batch finishing');
  const last = w.events.filter((e) => e.type === 'batch').at(-1);
  assert.equal(last.state, 'done');
  assert.deepEqual(last.counts, { success: 2, failed: 1, running: 0, queued: 0, waiting: 0, skipped: 0, error: 0 });
  assert.deepEqual(last.items.map((i) => [i.path, i.state, i.number]), [['a', 'success', 2], ['b', 'failed', 2], ['c', 'success', 2]]);
  assert.deepEqual(w.follows.map((f) => f[0]).sort(), ['a', 'b', 'c'], 'each build is followed');
  assert.equal(w.notes.length, 1, 'one notification for the batch, not three');
  assert.equal(w.notes[0][0], '3 builds finished');
  assert.match(w.notes[0][1], /2 passed · 1 failed/);
  assert.deepEqual(w.notes[0][2], { server: 's1', page: { type: 'home' } });
  const history = (await call('launchHistory', { batch: batch.batchId })).rows;
  assert.equal(history.length, 3);
  assert.equal(history.every((r) => r.source === 'runMany' && r.batch === batch.batchId), true);
  assert.equal((await call('launchHistory')).batches[0].state, 'done');
  void launch;
});

test('launches made one at a time count toward the minute, so a batch sees them; and they are never refused for it', { skip }, async () => {
  const w = world();
  for (let i = 0; i < 30; i += 1) w.add(`j${i}`);
  const { launch, call, refused } = setup(w);
  for (let i = 0; i < 18; i += 1) assert.ok(launch.record('s1', `j${i}`, {}, { queued: i }, {}), 'a manual launch is recorded, however many');
  assert.match(await refused('runMany', { items: [{ path: 'j20' }, { path: 'j21' }, { path: 'j22' }] }), /more than 20 launches in a minute/);
  await call('runMany', { items: [{ path: 'j20' }, { path: 'j21' }] });
});

test('a deep plan also asks why each would wait, and a plan that cannot ask still plans', { skip }, async () => {
  const w = world();
  w.add('app', { builds: [{ number: 1 }] });
  let asked = 0;
  const { call } = setup(w, { launch: { deepWhy: async (id, path) => { asked += 1; return { agents: [{ name: 'built-in', offline: false }], reasons: [{ code: 'label-missing', text: `No agent has the label arm for ${path}` }, { code: 'idle', text: 'fine' }] }; } } });
  const plain = await call('launchPlan', { items: [{ path: 'app' }] });
  assert.equal(asked, 0, 'only when asked for');
  assert.equal(plain.items[0].agents, undefined);
  const deep = await call('launchPlan', { items: [{ path: 'app' }], deep: true });
  assert.equal(asked, 1);
  assert.deepEqual(deep.items[0].agents, [{ name: 'built-in', offline: false }]);
  assert.match(deep.items[0].warnings.join(' '), /No agent has the label arm for app/);
  assert.equal(deep.items[0].warnings.some((one) => one === 'fine'), false, 'an idle job has nothing to warn about');
  const broken = setup(w, { launch: { deepWhy: async () => { throw new Error('no'); } } });
  assert.equal((await broken.call('launchPlan', { items: [{ path: 'app' }], deep: true })).valid, true);
});

test('the same click twice is one batch, and a different one is another', { skip }, async () => {
  const w = world();
  w.add('a'); w.add('b');
  const { call, until } = setup(w);
  const first = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }] });
  const second = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }] });
  assert.equal(second.deduplicated, true);
  assert.equal(second.batchId, first.batchId);
  await until(() => w.runs.length === 2);
  assert.equal(w.runs.length, 2, 'nothing was started twice');
  const other = await call('runMany', { items: [{ path: 'a', params: { X: '1' } }, { path: 'b' }], force: true });
  assert.notEqual(other.batchId, first.batchId);
  // After ten seconds it is a new click.
  w.now += 11_000;
  const later = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }] });
  assert.equal(later.deduplicated, false);
});

test('in sequence the next starts only when the one before has passed; a failure stops the rest unless told not to', { skip }, async () => {
  const w = world();
  ['a', 'b', 'c'].forEach((path) => w.add(path, { builds: [{ number: 1 }] }));
  const { call, until } = setup(w);
  const batch = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }, { path: 'c' }], mode: 'sequential' });
  assert.equal(batch.stopOnFailure, true, 'a chain stops by default');
  await until(() => w.runs.length === 1, 'the first started');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(w.runs.map((r) => r.path), ['a'], 'b waits for a');
  w.start(w.runs[0].queueId);
  await until(() => (w.jobs.get('a').builds[0].running), 'a running');
  assert.equal(w.runs.length, 1, 'still only the first');
  w.finish('a', 2, 'success');
  await until(() => w.runs.length === 2, 'b started after a passed');
  w.start(w.runs[1].queueId);
  w.finish('b', 2, 'failed');
  await until(() => w.events.some((e) => e.type === 'batch' && e.done), 'the batch ended');
  const last = w.events.filter((e) => e.type === 'batch').at(-1);
  assert.deepEqual(last.items.map((i) => i.state), ['success', 'failed', 'skipped']);
  assert.match((await call('launchHistory')).batches[0].items[2].error, /earlier one did not pass/);
  assert.equal(w.runs.length, 2, 'c was never started');

  // Told not to stop, it goes on past a failure.
  const w2 = world();
  ['a', 'b'].forEach((path) => w2.add(path, { builds: [{ number: 1 }] }));
  const second = setup(w2);
  await second.call('runMany', { items: [{ path: 'a' }, { path: 'b' }], mode: 'sequential', stopOnFailure: false });
  await second.until(() => w2.runs.length === 1);
  w2.start(w2.runs[0].queueId);
  w2.finish('a', 2, 'unstable');
  await second.until(() => w2.runs.length === 2, 'b started although a was unstable');
});

test('a batch that is cancelled starts nothing more, and says what it left running', { skip }, async () => {
  const w = world();
  ['a', 'b', 'c'].forEach((path) => w.add(path, { builds: [{ number: 1 }] }));
  const { call, until } = setup(w);
  const batch = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }, { path: 'c' }], mode: 'sequential' });
  await until(() => w.runs.length === 1);
  const cancelled = await call('scheduleCancel', { id: batch.batchId });
  assert.deepEqual(cancelled, { ok: true, id: batch.batchId, state: 'cancelled', skipped: 2, leftRunning: 1 });
  w.start(w.runs[0].queueId);
  w.finish('a', 2, 'success');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await until(() => true);
  assert.equal(w.runs.length, 1, 'b and c never started');
  const shown = (await call('launchHistory')).batches[0];
  assert.deepEqual([shown.state, shown.items.map((i) => i.state)], ['cancelled', ['success', 'skipped', 'skipped']], 'what had started went on to its end');
  assert.match(await rejects(call('scheduleCancel', { id: batch.batchId })), /already finished|not here/);
  assert.match(await rejects(call('scheduleCancel', { id: 'whatever' })), /not a schedule or a batch/);
});

async function rejects(promise) {
  try { await promise; } catch (error) { return String(error.message); }
  return assert.fail('should have been refused');
}

test('a batch the app was closed in the middle of is interrupted, and nothing of it resumes', { skip }, async () => {
  const w = world();
  ['a', 'b', 'c'].forEach((path) => w.add(path, { builds: [{ number: 1 }] }));
  const first = setup(w);
  await first.call('runMany', { items: [{ path: 'a' }, { path: 'b' }, { path: 'c' }], mode: 'sequential' });
  await first.until(() => w.runs.length === 1);
  first.launch.stop();
  const again = setup(w, { db: first.db });
  const shown = (await again.call('launchHistory')).batches[0];
  assert.deepEqual([shown.state, shown.items.map((i) => i.state)], ['interrupted', ['queued', 'skipped', 'skipped']]);
  w.start(w.runs[0].queueId);
  w.finish('a', 2, 'success');
  await again.until(() => true);
  await again.launch.poll();
  assert.equal(w.runs.length, 1, 'b is not started by anybody');
  assert.equal((await again.call('launchHistory')).rows[0].state, 'success', 'what had started is still followed to its end');
});

test('at most twenty launches leave in a minute, and the refusal says how long to wait', { skip }, async () => {
  const w = world();
  for (let i = 0; i < 25; i += 1) w.add(`j${i}`);
  const { call, refused, until } = setup(w);
  await call('runMany', { items: Array.from({ length: 15 }, (_, i) => ({ path: `j${i}` })) });
  await until(() => w.runs.length === 15);
  const why = await refused('runMany', { items: Array.from({ length: 10 }, (_, i) => ({ path: `j${i + 15}` })) });
  assert.match(why, /more than 20 launches in a minute — wait \d+ seconds/);
  assert.equal(w.runs.length, 15);
  w.now += 61_000;
  await call('runMany', { items: Array.from({ length: 10 }, (_, i) => ({ path: `j${i + 15}` })) });
  await until(() => w.runs.length === 25, 'the minute passed');
});

test('a job Jenkins refuses to start is an item in error, and the others go on', { skip }, async () => {
  const w = world();
  ['a', 'b', 'c'].forEach((path) => w.add(path, { builds: [{ number: 1 }] }));
  w.failRun.set('b', 'Jenkins answered 500');
  const { call, until } = setup(w);
  await call('runMany', { items: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] });
  await until(() => w.runs.length === 2, 'a and c');
  const shown = (await call('launchHistory')).batches[0];
  assert.deepEqual(shown.items.map((i) => i.state), ['queued', 'error', 'queued']);
  assert.match(shown.items[1].error, /Jenkins answered 500/);
  const row = (await call('launchHistory')).rows.find((r) => r.path === 'b');
  assert.equal(row.state, 'error', 'and the history says it did not start');
});

// --- promoting ------------------------------------------------------------------------------------

function services() {
  const w = world();
  const secret = def('API_KEY', { type: 'password', secret: true });
  w.add('T/AGENT MS DEV', {
    params: [def('VERSION', { default: '1' }), def('ENV', { type: 'choice', default: 'dev', choices: ['dev', 'staging', 'production'] }), def('NOTES'), secret],
    builds: [
      { number: 171, status: 'success', params: [{ name: 'VERSION', value: '1.4.0' }, { name: 'ENV', value: 'dev' }, { name: 'NOTES', value: 'n' }, { name: 'API_KEY', value: 'x' }], changes: [{ commitId: 'aaaaaaaa1111', msg: 'Round refund amounts\n\nlong', author: { fullName: 'Ana R.' } }] },
      { number: 170, status: 'success', params: [{ name: 'VERSION', value: '1.3.9' }, { name: 'ENV', value: 'dev' }], changes: [{ commitId: 'bbbbbbbb2222', msg: 'Fix mail', author: { fullName: 'Bob' } }] },
      { number: 169, status: 'failed', params: [{ name: 'VERSION', value: '1.3.8' }] },
      { number: 168, status: 'success', params: [{ name: 'VERSION', value: '1.3.7' }], changes: [{ commitId: 'cccccccc3333', msg: 'Old', author: { fullName: 'Cy' } }] },
    ],
  });
  w.add('T/AGENT MS PROD', {
    params: [def('VERSION'), def('ENV', { type: 'choice', default: 'staging', choices: ['staging', 'production'] }), secret, def('REGION', { default: 'sa' })],
    builds: [{ number: 88, status: 'success', params: [{ name: 'VERSION', value: '1.3.7' }, { name: 'ENV', value: 'production' }] }],
  });
  w.add('T/BILLING MS DEV', { builds: [{ number: 5, status: 'success' }] });
  return w;
}

test('promoting shows the next environment, how far behind it is, the commits in between and what it would be started with', { skip }, async () => {
  const w = services();
  const { call } = setup(w);
  const plan = await call('promoteCandidates', { path: 'T/AGENT MS DEV' });
  assert.deepEqual(plan.family, { base: 'AGENT MS', env: 'DEV', rank: 0 });
  assert.deepEqual([plan.from.number, plan.from.status, plan.from.blocked], [171, 'success', null]);
  assert.deepEqual(plan.from.params, { VERSION: '1.4.0', ENV: 'dev', NOTES: 'n' }, 'the source\'s own parameters, no secret');
  const [prod] = plan.candidates;
  assert.deepEqual([prod.path, prod.env, prod.looksProd, prod.canPromote, prod.reason], ['T/AGENT MS PROD', 'PROD', true, true, null]);
  assert.deepEqual(prod.deployed, { sourceNumber: 168, how: 'params', params: { VERSION: '1.3.7', ENV: 'production' } });
  assert.deepEqual([prod.ahead, prod.drift], [2, 2], 'builds 170 and 171 passed since what PROD runs');
  assert.deepEqual(prod.commits.map((c) => [c.number, c.id, c.message, c.author]), [[171, 'aaaaaaaa', 'Round refund amounts', 'Ana R.'], [170, 'bbbbbbbb', 'Fix mail', 'Bob']]);
  assert.deepEqual(prod.proposal.params, { VERSION: '1.4.0', ENV: 'production' }, 'the environment parameter points at where it is going');
  assert.deepEqual(prod.proposal.environment, { name: 'ENV', value: 'production' });
  assert.deepEqual(prod.proposal.needsInput.map((n) => [n.name, n.kind, n.blocking]), [['API_KEY', 'secret', true]]);
  assert.deepEqual(prod.proposal.unmatched, ['NOTES']);
  assert.match(prod.warnings.join(' '), /looks like production/);
  assert.match(prod.warnings.join(' '), /API_KEY has to be given before it can start/);
});

test('promotion refuses what should not move, and says why', { skip }, async () => {
  const w = services();
  const { call } = setup(w);
  w.jobs.get('T/AGENT MS DEV').builds.unshift({ number: 172, status: 'failed', running: false, duration: 1, timestamp: T0, params: [], changes: [] });
  const failed = await call('promoteCandidates', { path: 'T/AGENT MS DEV', number: 172 });
  assert.deepEqual([failed.from.blocked, failed.candidates[0].canPromote], ['failed', false]);
  assert.match(failed.candidates[0].reason, /failed/);
  w.jobs.get('T/AGENT MS PROD').buildable = false;
  assert.match((await call('promoteCandidates', { path: 'T/AGENT MS DEV' })).candidates[0].reason, /disabled/);
  // Not an environment, one environment, the last.
  assert.match((await call('promoteCandidates', { path: 'nightly' })).none.reason, /not named for an environment/);
  assert.match((await call('promoteCandidates', { path: 'T/BILLING MS DEV' })).none.reason, /No other environment of BILLING MS/);
  assert.match((await call('promoteCandidates', { path: 'T/AGENT MS PROD' })).none.reason, /PROD is the last environment of AGENT MS/);
});

test('promoting starts the next environment with the build\'s parameters, never its secret, and remembers where from', { skip }, async () => {
  const w = services();
  const { call, refused, db, until } = setup(w);
  // The secret has to be typed: nothing starts, and the error says which.
  assert.match(await refused('promote', { from: { path: 'T/AGENT MS DEV', number: 171 } }), /API_KEY \(a secret is never copied from one build to another\)/);
  assert.equal(w.runs.length, 0);
  const done = await call('promote', { from: { path: 'T/AGENT MS DEV', number: 171 }, overrides: { API_KEY: 'TYPED-SECRET' }, to: 'T/AGENT MS PROD', serverName: 'ci' });
  assert.deepEqual([done.ok, done.to, done.followed], [true, 'T/AGENT MS PROD', true]);
  assert.deepEqual(w.runs[0].params, { VERSION: '1.4.0', ENV: 'production', API_KEY: 'TYPED-SECRET' }, 'what Jenkins got');
  assert.deepEqual(done.params, { VERSION: '1.4.0', ENV: 'production' }, 'what is said back has no secret');
  const row = (await call('launchHistory')).rows[0];
  assert.deepEqual([row.source, row.from, row.path], ['promote', { path: 'T/AGENT MS DEV', number: 171 }, 'T/AGENT MS PROD']);
  assert.equal(/TYPED-SECRET/.test(JSON.stringify(db.prepare('SELECT * FROM jl_launch').all())), false);
  // Once it has passed, it is what PROD last ran: no guessing from parameters.
  w.start(w.runs[0].queueId);
  w.finish('T/AGENT MS PROD', 89, 'success');
  await until(() => w.jobs.get('T/AGENT MS PROD').builds[0].status === 'success' && w.events.some((e) => e.type === 'launch' && e.state === 'success'));
  const after = await call('promoteCandidates', { path: 'T/AGENT MS DEV', number: 171 });
  assert.deepEqual([after.candidates[0].deployed.how, after.candidates[0].deployed.sourceNumber, after.candidates[0].ahead], ['history', 171, 0]);
  assert.match(after.candidates[0].warnings.join(' '), /already what the target last ran/);
});

test('a target that is running or already has a build waiting is not promoted to unless the person says so', { skip }, async () => {
  const w = services();
  const { call, refused } = setup(w);
  w.jobs.get('T/AGENT MS PROD').inQueue = true;
  const waiting = (await call('promoteCandidates', { path: 'T/AGENT MS DEV' })).candidates[0];
  assert.deepEqual([waiting.canPromote, /already has a build waiting/.test(waiting.reason)], [false, true]);
  assert.match(await refused('promote', { from: { path: 'T/AGENT MS DEV', number: 171 }, overrides: { API_KEY: 'x' } }), /already waiting for a build — wait for it, or promote anyway/);
  w.jobs.get('T/AGENT MS PROD').inQueue = false;
  w.jobs.get('T/AGENT MS PROD').builds.unshift({ number: 89, status: 'running', running: true, duration: 0, timestamp: T0, params: [], changes: [] });
  assert.match(await refused('promote', { from: { path: 'T/AGENT MS DEV', number: 171 }, overrides: { API_KEY: 'x' } }), /is running now — wait for it, or promote anyway/);
  assert.equal(w.runs.length, 0);
  const done = await call('promote', { from: { path: 'T/AGENT MS DEV', number: 171 }, overrides: { API_KEY: 'x' }, allowBusy: true });
  assert.equal(done.ok, true);
});

test('the words a person gave their environments are understood, for the next job and for the environment parameter', { skip }, async () => {
  const w = world();
  w.add('S/web DEV', { params: [def('ENV', { type: 'choice', default: 'dev', choices: ['dev', 'homologation'] })], builds: [{ number: 3, params: [{ name: 'ENV', value: 'dev' }] }] });
  w.add('S/web HOM', { params: [def('ENV', { type: 'choice', default: 'dev', choices: ['dev', 'homologation'] })], builds: [{ number: 1 }] });
  // Without being told, HOM is nothing and DEV has no next environment.
  const plain = setup(w);
  assert.match((await plain.call('promoteCandidates', { path: 'S/web DEV' })).none.reason, /No other environment of web/);
  // Told that HOM is staging, and that "homologation" means it too.
  const tuned = setup(w, { launch: { boardSettings: () => ({ envTokens: { HOM: 'STG', HOMOLOGATION: 'STG' } }) } });
  const plan = await tuned.call('promoteCandidates', { path: 'S/web DEV' });
  assert.deepEqual([plan.candidates[0].path, plan.candidates[0].env], ['S/web HOM', 'STG']);
  assert.deepEqual(plan.candidates[0].proposal.params, { ENV: 'homologation' }, 'the environment parameter points at the environment, in the job\'s own word');
  assert.deepEqual(plan.candidates[0].proposal.environment, { name: 'ENV', value: 'homologation' });
});

test('promoting refuses a build that did not pass, one still running, and a job with nowhere to go', { skip }, async () => {
  const w = services();
  const { call, refused } = setup(w);
  assert.match(await refused('promote', { from: { path: 'T/AGENT MS DEV', number: 169 }, overrides: { API_KEY: 'x' } }), /did not pass \(failed\)/);
  w.jobs.get('T/AGENT MS DEV').builds.unshift({ number: 172, status: 'running', running: true, duration: 0, timestamp: T0, params: [], changes: [] });
  assert.match(await refused('promote', { from: { path: 'T/AGENT MS DEV', number: 172 } }), /still running/);
  assert.match(await refused('promote', { from: { path: 'nightly', number: 1 } }), /nothing there|does not exist|Jenkins has nothing/i);
  w.add('nightly', { builds: [{ number: 1 }] });
  assert.match(await refused('promote', { from: { path: 'nightly', number: 1 } }), /not named for an environment/);
  assert.match(await refused('promote', { from: { path: 'T/AGENT MS PROD', number: 88 } }), /already the last environment/);
  assert.match(await refused('promote', { from: { path: 'T/AGENT MS DEV', number: 171 }, to: 'T/AGENT MS DEV' }), /to another job/);
  assert.match(await refused('promote', {}), /Say which build/);
  // An explicit target outside the family is the person's decision.
  // It takes no version, so the build's version has nowhere to go: that is a choice, and it is made by name.
  assert.match(await refused('promote', { from: { path: 'T/AGENT MS DEV', number: 171 }, to: { path: 'T/BILLING MS DEV' } }), /VERSION \(.*has no parameter called VERSION/);
  const done = await call('promote', { from: { path: 'T/AGENT MS DEV', number: 171 }, to: { path: 'T/BILLING MS DEV' }, skip: ['VERSION'], serverName: 'ci' });
  assert.equal(done.to, 'T/BILLING MS DEV');
  assert.match((await call('launchHistory')).rows[0].note, /Left behind on purpose: VERSION/);
  // A failed build is not promoted whatever is said; an unstable one can be, on purpose.
  assert.match(await refused('promote', { from: { path: 'T/AGENT MS DEV', number: 169 }, to: 'T/BILLING MS DEV', allowUnstable: true, allowBusy: true, force: true, skip: ['VERSION'] }), /did not pass \(failed\)/);
  w.jobs.get('T/AGENT MS DEV').builds.find((b) => b.number === 169).status = 'unstable';
  // (The first is still waiting in the queue, so this one is a second deploy on top of it: said, and allowed here.)
  const unstable = await call('promote', { from: { path: 'T/AGENT MS DEV', number: 169 }, to: 'T/BILLING MS DEV', allowUnstable: true, allowBusy: true, allowOlder: true, force: true, skip: ['VERSION'] });
  assert.equal(unstable.ok, true);
});

// --- scheduling -----------------------------------------------------------------------------------

test('a schedule is checked when it is made: not too soon, not too far, no secret, a job that exists', { skip }, async () => {
  const w = world();
  w.add('app', { params: [def('VERSION', { default: '1' }), def('API_KEY', { type: 'password', secret: true })] });
  w.add('off', { buildable: false });
  const { call, refused } = setup(w);
  assert.match(await refused('scheduleRun', { path: 'app', at: T0 + 10_000 }), /too soon/);
  assert.match(await refused('scheduleRun', { path: 'app', at: T0 + 31 * 86_400_000 }), /too far ahead/);
  assert.match(await refused('scheduleRun', { path: 'app' }), /when it should run/);
  assert.match(await refused('scheduleRun', { path: 'app', at: 'soon' }), /when it should run/);
  assert.match(await refused('scheduleRun', { path: 'app', at: T0 + 3_600_000, params: { API_KEY: 'x' } }), /API_KEY is a secret, and a secret is never kept/);
  assert.match(await refused('scheduleRun', { path: 'off', at: T0 + 3_600_000 }), /disabled/);
  assert.match(await refused('scheduleRun', { path: 'gone', at: T0 + 3_600_000 }), /nothing there/i);
  w.add('plain', { params: [def('VERSION', { default: '1' })] });
  const made = await call('scheduleRun', { path: 'plain', at: T0 + 3_600_000, params: { VERSION: '2' }, note: 'before standup', when: 'Fri 18:00', serverName: 'ci' });
  assert.match(made.id, /^sched-[0-9a-f]{8}$/);
  assert.equal(made.state, 'scheduled');
  const listed = (await call('schedules')).schedules[0];
  assert.deepEqual([listed.path, listed.params, listed.note, listed.state, listed.inMs], ['plain', { VERSION: '2' }, 'before standup', 'scheduled', 3_600_000]);
});

test('a schedule fires when its time comes, records it as a schedule, and says so', { skip }, async () => {
  const w = world();
  w.add('app', { params: [def('VERSION', { default: '1' })], builds: [{ number: 1 }] });
  const { launch, call } = setup(w);
  const { id } = await call('scheduleRun', { path: 'app', at: T0 + 120_000, params: { VERSION: '9' } });
  await launch.runDue();
  assert.equal(w.runs.length, 0, 'not yet');
  w.now = T0 + 121_000;
  await launch.runDue();
  assert.deepEqual(w.runs.map((r) => [r.path, r.params]), [['app', { VERSION: '9' }]]);
  const fired = (await call('schedules')).schedules.find((s) => s.id === id);
  assert.equal(fired.state, 'fired');
  assert.ok(fired.launchId);
  assert.equal((await call('launchHistory')).rows[0].source, 'schedule');
  assert.deepEqual(w.events.find((e) => e.type === 'schedule'), { type: 'schedule', server: 's1', id, path: 'app', state: 'fired', launchId: fired.launchId });
  assert.deepEqual(w.notes[0].slice(0, 2), ['Started: app', 'Scheduled run']);
  assert.deepEqual(w.notes[0][2], { server: 's1', page: { type: 'job', path: 'app' } });
  await launch.runDue();
  assert.equal(w.runs.length, 1, 'once');
});

test('a schedule more than two minutes late is missed and never run, for the person to decide', { skip }, async () => {
  const w = world();
  w.add('app');
  const { launch, call } = setup(w);
  const { id } = await call('scheduleRun', { path: 'app', at: T0 + 120_000 });
  // The machine slept through it.
  w.now = T0 + 3 * 3_600_000;
  await launch.runDue();
  assert.equal(w.runs.length, 0, 'a deploy meant for six is not run at nine');
  const row = (await call('schedules')).schedules.find((s) => s.id === id);
  assert.equal(row.state, 'missed');
  assert.match(w.notes[0][0], /^Missed: app/);
  assert.equal(w.events.find((e) => e.type === 'schedule').state, 'missed');
  // It stays, until it is dismissed.
  assert.equal((await call('schedules')).schedules[0].id, id);
  assert.deepEqual(await call('scheduleCancel', { id }), { ok: true, id, state: 'cancelled' });
  assert.equal((await call('schedules')).schedules.find((s) => s.id === id).state, 'cancelled');
  assert.match(await rejects(call('scheduleCancel', { id })), /already cancelled/);
});

test('a schedule whose time passed while the app was closed is missed when it opens, one in the future still waits', { skip }, async () => {
  const w = world();
  w.add('app');
  const first = setup(w);
  const past = await first.call('scheduleRun', { path: 'app', at: T0 + 60_000 });
  const future = await first.call('scheduleRun', { path: 'app', at: T0 + 7_200_000 });
  first.launch.stop();
  w.now = T0 + 3_600_000;
  const again = setup(w, { db: first.db });
  const states = Object.fromEntries((await again.call('schedules')).schedules.map((s) => [s.id, s.state]));
  assert.deepEqual([states[past.id], states[future.id]], ['missed', 'scheduled']);
  await again.launch.runDue();
  assert.equal(w.runs.length, 0, 'nothing ran by itself');
  w.now = T0 + 7_200_000 + 1000;
  await again.launch.runDue();
  assert.equal(w.runs.length, 1, 'the one still waiting fired on time');
});

test('a schedule that cannot start says why instead of failing quietly, and a second beat never runs it twice', { skip }, async () => {
  const w = world();
  w.add('app');
  const { launch, call } = setup(w);
  const { id } = await call('scheduleRun', { path: 'app', at: T0 + 60_000 });
  w.jobs.get('app').buildable = false;
  w.now = T0 + 61_000;
  await Promise.all([launch.runDue(), launch.runDue()]);
  assert.equal(w.runs.length, 0);
  const row = (await call('schedules')).schedules.find((s) => s.id === id);
  assert.deepEqual([row.state, /disabled/.test(row.error)], ['failed', true]);
  assert.match(w.notes[0][0], /^Did not start: app/);
  assert.equal(w.notes.length, 1, 'said once');
  // Twice at once: one launch.
  w.jobs.get('app').buildable = true;
  const again = await call('scheduleRun', { path: 'app', at: T0 + 200_000 });
  w.now = T0 + 201_000;
  await Promise.all([launch.runDue(), launch.runDue(), launch.runDue()]);
  assert.equal(w.runs.length, 1);
  void again;
});

test('there is a limit on how many schedules wait', { skip }, async () => {
  const w = world();
  w.add('app');
  const { call, refused } = setup(w);
  for (let i = 0; i < 50; i += 1) await call('scheduleRun', { path: 'app', at: T0 + 60_000 + i * 1000 });
  assert.match(await refused('scheduleRun', { path: 'app', at: T0 + 900_000 }), /already 50 schedules/);
});

// --- the launchpad ----------------------------------------------------------------------------------

test('the launchpad gathers what is worth launching next, with what each needs', { skip }, async () => {
  const w = world();
  w.favorites = ['web/fav'];
  w.add('web/fav', { builds: [{ number: 7, status: 'success' }] });
  w.add('web/broken', { params: [def('VERSION'), def('API_KEY', { type: 'password', secret: true })], builds: [{ number: 3, status: 'failed' }] });
  w.add('web/plain', { params: [def('ENV', { default: 'a', type: 'choice', choices: ['a', 'b'] })], builds: [{ number: 1, status: 'success' }] });
  w.add('web/off', { buildable: false, builds: [{ number: 1 }] });
  const { launch, call } = setup(w);
  launch.record('s1', 'web/plain', { ENV: 'b' }, { queued: 1 }, { defs: w.jobs.get('web/plain').params });
  launch.record('s1', 'web/plain', { ENV: 'b' }, { queued: 2 }, { defs: w.jobs.get('web/plain').params });
  launch.record('s1', 'web/broken', { VERSION: '4', API_KEY: 'SECRET' }, { queued: 3 }, { defs: w.jobs.get('web/broken').params });
  launch.record('s1', 'web/off', {}, { queued: 4 }, {});
  const pad = await call('launchpad');
  assert.deepEqual(pad.favorites.map((t) => t.path), ['web/fav']);
  assert.deepEqual(pad.recent.map((t) => t.path), ['web/off', 'web/broken', 'web/plain'], 'newest launch first');
  assert.deepEqual(pad.frequent[0].path, 'web/plain');
  assert.equal(pad.frequent[0].runs, 2);
  assert.deepEqual(pad.failing.map((t) => t.path), ['web/broken']);
  const broken = pad.failing[0];
  assert.deepEqual(broken.why.sort(), ['failing', 'recent']);
  assert.deepEqual([broken.status, broken.last.number, broken.lastParams, broken.needsInput], ['failed', 3, { VERSION: '4' }, ['API_KEY']]);
  assert.deepEqual([broken.hasParams, broken.needsForm, broken.buildable], [true, true, true]);
  assert.deepEqual([pad.favorites[0].hasParams, pad.favorites[0].needsForm], [false, false]);
  assert.equal(pad.recent[0].buildable, false);
  assert.equal(pad.recent.find((t) => t.path === 'web/plain').needsForm, false, 'a pick with a default needs no form');
  assert.deepEqual(pad.batches, []);
  assert.equal(/SECRET/.test(JSON.stringify(pad)), false);
  // A second look asks Jenkins for no definition again.
  const asked = w.gets.length;
  await call('launchpad');
  assert.equal(w.gets.length, asked);
});

// --- forgetting -----------------------------------------------------------------------------------------

test('forgetting takes the history, the batches and the schedules of what is forgotten and nothing else', { skip }, async () => {
  const w = world();
  w.add('a'); w.add('b');
  const { launch, call } = setup(w);
  const a1 = launch.record('s1', 'a', {}, { queued: 1 }, {});
  launch.record('s1', 'a', {}, { queued: 2 }, {});
  launch.record('s1', 'b', {}, { queued: 3 }, {});
  launch.db.prepare('UPDATE jl_launch SET number = 5 WHERE id = ?').run(a1);
  await call('scheduleRun', { path: 'a', at: T0 + 3_600_000 });
  await call('scheduleRun', { path: 'b', at: T0 + 3_600_000 });
  launch.forget('s1', { path: 'a', number: 5 });
  assert.equal((await call('launchHistory')).rows.length, 2);
  launch.forget('s1', { path: 'a' });
  assert.deepEqual((await call('launchHistory')).rows.map((r) => r.path), ['b']);
  assert.deepEqual((await call('schedules')).schedules.map((s) => s.path), ['b'], 'a job\'s schedule goes with it');
  launch.forget('s1', {});
  assert.equal((await call('launchHistory')).rows.length, 0);
  assert.equal((await call('schedules')).schedules.length, 0);
  // Another server is untouched.
  launch.record('other', 'a', {}, { queued: 9 }, {});
  launch.forget('s1', {});
  assert.equal(launch.db.prepare("SELECT COUNT(*) AS n FROM jl_launch WHERE server = 'other'").get().n, 1);
});

test('without a place to keep things the verbs say so, and the rest of the service is not touched', { skip }, async () => {
  const launch = new Launch({ archive: null, on: () => ({ server: { id: 's1', url: 'https://ci.test' }, api: {} }), maintain: false });
  const verbs = launch.verbs();
  await assert.rejects(verbs.launchHistory({ server: 's1' }), /could not be opened/);
  assert.equal(launch.record('s1', 'a', {}, { queued: 1 }), null, 'a build that was started is never undone by a history that cannot be written');
  launch.forget('s1', {});
  launch.stop();
});

test('the launch tables are versioned, and a file from a newer build is refused rather than mangled', { skip }, () => {
  const db = new sqlite.DatabaseSync(':memory:');
  const first = new Launch({ archive: { db }, on: () => null, maintain: false });
  assert.equal(db.prepare('SELECT version FROM jl_schema').get().version, 2);
  first.stop();
  db.prepare('UPDATE jl_schema SET version = 99').run();
  const newer = new Launch({ archive: { db }, on: () => null, maintain: false });
  assert.match(newer.error, /newer than this build knows/);
  assert.equal(newer.db, null);
});


// =====================================================================================
// The independent review's findings (R2): what must never start, and never start twice.
// =====================================================================================

function envWorld({ sourceParams, sourceDefs, targetDefs, sourceBuilds, targetBuilds } = {}) {
  const w = world();
  w.add('app DEV', {
    params: sourceDefs ?? [def('VERSION'), def('NAMESPACE'), def('ENV'), def('FLAG', { type: 'boolean', default: true }), def('CLUSTER'), def('CONFIG_URL')],
    builds: sourceBuilds ?? [{ number: 7, status: 'success', params: sourceParams ?? [{ name: 'VERSION', value: '1.2.3' }, { name: 'NAMESPACE', value: 'app-dev' }, { name: 'ENV', value: 'dev' }, { name: 'FLAG', value: 'true' }, { name: 'CLUSTER', value: 'dev-eks' }, { name: 'CONFIG_URL', value: 'https://cfg.dev.example.com/x' }] }],
  });
  w.add('app PROD', {
    params: targetDefs ?? [def('VERSION'), def('NAMESPACE', { default: 'app-prod' }), def('ENV', { default: 'prod' }), def('FLAG', { type: 'boolean', default: false }), def('CLUSTER'), def('CONFIG_URL', { default: 'https://cfg.example.com/x' })],
    builds: targetBuilds ?? [{ number: 3, status: 'success' }],
  });
  return w;
}

test('promoting never copies a value that belongs to the source environment into the target', { skip }, async () => {
  const w = envWorld();
  const { call, refused } = setup(w);
  const plan = (await call('promoteCandidates', { path: 'app DEV' })).candidates[0].proposal;
  assert.deepEqual(plan.copied.map((c) => c.name), ['VERSION'], 'only what is version-like, with a target parameter of that name, is copied');
  assert.deepEqual(plan.params, { VERSION: '1.2.3' });
  const by = Object.fromEntries(plan.needsInput.map((n) => [n.name, n]));
  assert.deepEqual([by.NAMESPACE.kind, by.NAMESPACE.sourceValue, by.NAMESPACE.targetDefault, by.NAMESPACE.blocking], ['environment', 'app-dev', 'app-prod', false], 'shown with both values; the target\'s own default is safe');
  assert.deepEqual([by.ENV.kind, by.ENV.sourceValue, by.ENV.blocking], ['environment', 'dev', false]);
  assert.deepEqual([by.CONFIG_URL.kind, by.CONFIG_URL.blocking], ['environment', false], 'a URL is where, not what');
  assert.deepEqual([by.CLUSTER.kind, by.CLUSTER.blocking], ['environment', true], 'no default of the target\'s own to fall back on: somebody has to say');
  assert.deepEqual([by.FLAG.kind, by.FLAG.blocking], ['other', false], 'a plain difference is shown, not silently decided');
  assert.equal(plan.ready, false);
  // Nothing starts until the one that has nothing safe to fall back on is given.
  assert.match(await refused('promote', { from: { path: 'app DEV', number: 7 } }), /CLUSTER/);
  assert.equal(w.runs.length, 0);
  await call('promote', { from: { path: 'app DEV', number: 7 }, overrides: { CLUSTER: 'prod-eks' } });
  assert.deepEqual(w.runs[0].params, { VERSION: '1.2.3', CLUSTER: 'prod-eks' }, 'what Jenkins got: nothing of DEV in it');
  const sent = JSON.stringify(w.runs[0].params);
  assert.equal(/app-dev|dev-eks|cfg\.dev|"dev"/.test(sent), false);
});

test('a version-like value that carries the source environment (a development snapshot) is not promoted either', { skip }, async () => {
  const w = envWorld({ sourceParams: [{ name: 'VERSION', value: '1.4.0-dev.3' }, { name: 'ENV', value: 'dev' }], sourceDefs: [def('VERSION'), def('ENV')], targetDefs: [def('VERSION'), def('ENV', { default: 'prod' })] });
  const { call, refused } = setup(w);
  const plan = (await call('promoteCandidates', { path: 'app DEV' })).candidates[0].proposal;
  assert.deepEqual(plan.copied, []);
  const version = plan.needsInput.find((n) => n.name === 'VERSION');
  assert.deepEqual([version.kind, version.blocking, version.sourceValue], ['environment', true, '1.4.0-dev.3']);
  assert.match(await refused('promote', { from: { path: 'app DEV', number: 7 } }), /VERSION/);
  assert.equal(w.runs.length, 0);
});

test('a version the target has no parameter of that name for blocks the promotion instead of deploying the default', { skip }, async () => {
  const w = envWorld({ sourceDefs: [def('VERSION')], sourceParams: [{ name: 'VERSION', value: '1.2.3' }], targetDefs: [def('IMAGE_VERSION', { default: 'latest' })] });
  const { call, refused } = setup(w);
  const candidate = (await call('promoteCandidates', { path: 'app DEV' })).candidates[0];
  assert.deepEqual(candidate.proposal.blocked.map((b) => b.name), ['VERSION']);
  assert.match(candidate.proposal.blocked[0].reason, /no parameter called VERSION.*choose how to map/);
  assert.deepEqual(candidate.proposal.blocked[0].candidates, ['IMAGE_VERSION'], 'the target\'s own version-like parameters to choose from');
  assert.equal(candidate.proposal.ready, false);
  assert.match(await refused('promote', { from: { path: 'app DEV', number: 7 } }), /choose how to map VERSION/);
  assert.equal(w.runs.length, 0, 'not even with the target\'s default available: that is the version of whatever was last typed there');
  // Mapped on purpose, or typed on purpose.
  await call('promote', { from: { path: 'app DEV', number: 7 }, map: { VERSION: 'IMAGE_VERSION' } });
  assert.deepEqual(w.runs[0].params, { IMAGE_VERSION: '1.2.3' });
  w.start(w.runs[0].queueId);
  w.finish('app PROD', 4);
  w.now += 11_000;
  await call('promote', { from: { path: 'app DEV', number: 7 }, overrides: { IMAGE_VERSION: '9.9.9' } });
  assert.deepEqual(w.runs[1].params, { IMAGE_VERSION: '9.9.9' });
  w.start(w.runs[1].queueId);
  w.finish('app PROD', 5);
  w.now += 11_000;
  assert.match(await rejects(call('promote', { from: { path: 'app DEV', number: 7 }, map: { VERSION: 'NOPE' } })), /NOPE is not a parameter of app PROD/);
});

test('a target version with a default of its own is still not started on the default', { skip }, async () => {
  const w = envWorld({ sourceDefs: [def('FLAG', { type: 'boolean' })], sourceParams: [{ name: 'FLAG', value: 'true' }], targetDefs: [def('VERSION', { default: 'latest' })] });
  const { call, refused } = setup(w);
  const plan = (await call('promoteCandidates', { path: 'app DEV' })).candidates[0].proposal;
  const version = plan.needsInput.find((n) => n.name === 'VERSION');
  assert.deepEqual([version.kind, version.blocking], ['required', true]);
  assert.match(await refused('promote', { from: { path: 'app DEV', number: 7 } }), /VERSION/);
});

test('only a build that is unstable can be promoted on request; one that failed or was aborted never can', { skip }, async () => {
  const w = envWorld({ sourceDefs: [def('VERSION')], targetDefs: [def('VERSION')], sourceBuilds: [
    { number: 9, status: 'aborted', params: [{ name: 'VERSION', value: '2' }] }, { number: 8, status: 'failed', params: [{ name: 'VERSION', value: '2' }] },
    { number: 7, status: 'unstable', params: [{ name: 'VERSION', value: '2' }] }, { number: 6, status: 'success', params: [{ name: 'VERSION', value: '1' }] },
  ] });
  const { call, refused, db } = setup(w);
  assert.match(await refused('promote', { from: { path: 'app DEV', number: 8 }, allowUnstable: true }), /did not pass \(failed\)/);
  assert.match(await refused('promote', { from: { path: 'app DEV', number: 9 }, allowUnstable: true }), /did not pass \(aborted\)/);
  assert.match(await refused('promote', { from: { path: 'app DEV', number: 7 } }), /did not pass \(unstable\)/);
  assert.equal(w.runs.length, 0);
  // Unstable, on purpose; and it is on the record that it was.
  const done = await call('promote', { from: { path: 'app DEV', number: 7 }, allowUnstable: true });
  assert.equal(done.ok, true);
  const row = (await call('launchHistory')).rows[0];
  assert.match(row.note, /unstable build/);
  assert.equal(db.prepare('SELECT note FROM jl_launch ORDER BY id DESC LIMIT 1').get().note, row.note);
});

test('a build that is not the newest success of its job is promoted only when said, and the history says so', { skip }, async () => {
  const w = envWorld({ sourceDefs: [def('VERSION')], targetDefs: [def('VERSION')], sourceBuilds: [
    { number: 7, status: 'success', params: [{ name: 'VERSION', value: '1.1' }] }, { number: 6, status: 'success', params: [{ name: 'VERSION', value: '1.0' }] },
  ] });
  const { call, refused } = setup(w);
  assert.match(await refused('promote', { from: { path: 'app DEV', number: 6 } }), /A newer build \(#7\) passed since/);
  assert.equal(w.runs.length, 0);
  const plan = (await call('promoteCandidates', { path: 'app DEV', number: 6 })).candidates[0];
  assert.match(plan.warnings.join(' '), /newer build \(#7\) passed/);
  await call('promote', { from: { path: 'app DEV', number: 6 }, allowOlder: true });
  assert.match((await call('launchHistory')).rows[0].note, /older build \(#6; #7 is newer\)/);
});

test('a target in a deprecated family, hidden on the board, or claimed by two jobs is not promoted to on its own', { skip }, async () => {
  const w = world();
  for (const base of ['KUBRIK (old - do not use)/svc', 'ok/svc', 'twin/billing']) {
    w.add(`${base} DEV`, { params: [def('VERSION')], builds: [{ number: 4, status: 'success', params: [{ name: 'VERSION', value: '1' }] }] });
  }
  w.add('KUBRIK (old - do not use)/svc PROD', { params: [def('VERSION')], builds: [{ number: 1 }] });
  w.add('ok/svc PROD', { params: [def('VERSION')], builds: [{ number: 1 }] });
  w.add('twin/Billing_PROD', { params: [def('VERSION')], builds: [{ number: 1 }] });
  w.add('twin/billing-prod', { params: [def('VERSION')], builds: [{ number: 1 }] });
  const { call, refused } = setup(w, { launch: { boardSettings: () => ({ hide: ['hidden'] }) } });
  w.add('hidden/app DEV', { params: [def('VERSION')], builds: [{ number: 2, status: 'success', params: [{ name: 'VERSION', value: '1' }] }] });
  w.add('hidden/app PROD', { params: [def('VERSION')], builds: [{ number: 1 }] });
  const old = (await call('promoteCandidates', { path: 'KUBRIK (old - do not use)/svc DEV' })).candidates[0];
  assert.deepEqual([old.canPromote, /deprecated|old/.test(old.reason)], [false, true]);
  assert.match(await refused('promote', { from: { path: 'KUBRIK (old - do not use)/svc DEV', number: 4 }, overrides: { VERSION: '1' } }), /old|deprecated/i);
  assert.match(await refused('promote', { from: { path: 'hidden/app DEV', number: 2 }, overrides: { VERSION: '1' } }), /hidden on the board/);
  assert.match(await refused('promote', { from: { path: 'twin/billing DEV', number: 4 } }), /Two jobs claim PROD.*Billing_PROD.*billing-prod/);
  assert.equal((await call('promoteCandidates', { path: 'twin/billing DEV' })).candidates[0].canPromote, false);
  assert.equal(w.runs.length, 0);
  // Said on purpose, each of them works.
  await call('promote', { from: { path: 'twin/billing DEV', number: 4 }, to: 'twin/billing-prod' });
  await call('promote', { from: { path: 'KUBRIK (old - do not use)/svc DEV', number: 4 }, allowDeprecated: true, force: true });
  assert.deepEqual(w.runs.map((r) => r.path), ['twin/billing-prod', 'KUBRIK (old - do not use)/svc PROD']);
  // And the ordinary pair is not troubled by any of it.
  assert.equal((await call('promoteCandidates', { path: 'ok/svc DEV' })).candidates[0].canPromote, true);
});

test('the same request made twice at once starts one batch, one promotion and one schedule', { skip }, async () => {
  const w = world();
  w.add('a'); w.add('b');
  const secret = def('API_KEY', { type: 'password', secret: true });
  w.add('x DEV', { params: [def('VERSION'), secret], builds: [{ number: 4, status: 'success', params: [{ name: 'VERSION', value: '1' }] }] });
  w.add('x PROD', { params: [def('VERSION'), secret], builds: [{ number: 1 }] });
  const { call, db } = setup(w);
  const [one, two] = await Promise.all([call('runMany', { items: [{ path: 'a' }, { path: 'b' }] }), call('runMany', { items: [{ path: 'a' }, { path: 'b' }] })]);
  assert.equal(one.batchId, two.batchId);
  assert.deepEqual([one.deduplicated, two.deduplicated].sort(), [false, true]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.runs.length, 2, 'two jobs, once each — not four');
  const args = { from: { path: 'x DEV', number: 4 }, overrides: { API_KEY: 'k' } };
  const [p1, p2] = await Promise.all([call('promote', args), call('promote', args)]);
  assert.equal(w.runs.filter((r) => r.path === 'x PROD').length, 1, 'one deploy');
  assert.deepEqual([p1.launchId, p1.deduplicated ?? false, p2.deduplicated ?? false].slice(1).sort(), [false, true]);
  assert.equal(p1.launchId, p2.launchId);
  const ask = { path: 'a', at: T0 + 3_600_000 };
  const [s1, s2] = await Promise.all([call('scheduleRun', ask), call('scheduleRun', ask)]);
  assert.equal(s1.id, s2.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jl_schedule WHERE state = 'scheduled'").get().n, 1, 'fires once');
});

test('the same job started by two different requests within ten seconds is refused unless forced', { skip }, async () => {
  const w = world();
  w.add('a'); w.add('b');
  const { call, refused } = setup(w);
  await call('runMany', { items: [{ path: 'a', params: { X: '1' } }] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const why = await refused('runMany', { items: [{ path: 'a', params: { X: '2' } }, { path: 'b' }] });
  assert.match(why, /a was started \d+ seconds? ago by another request/);
  assert.match(why, /force/);
  assert.equal(w.runs.length, 1);
  const forced = await call('runMany', { items: [{ path: 'a', params: { X: '2' } }, { path: 'b' }], force: true });
  assert.equal(forced.deduplicated, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.runs.length, 3);
  // Ten seconds on it is a new decision.
  w.now += 11_000;
  await call('runMany', { items: [{ path: 'a', params: { X: '3' } }] });
  // A run made by hand counts as a launch too.
  const { launch } = setup(w);
  launch.record('s1', 'b', {}, { queued: 1 }, {});
  assert.match(await rejects(launch.verbs().runMany({ server: 's1', items: [{ path: 'b', params: { Y: '1' } }] })), /b was started/);
});

test('what makes the same batch is the whole request, options included', { skip }, async () => {
  const w = world();
  w.add('a'); w.add('b');
  const { call } = setup(w);
  const first = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }], mode: 'sequential' });
  w.now += 11_000;
  const other = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }], mode: 'sequential', stopOnFailure: false });
  assert.notEqual(other.batchId, first.batchId, 'not stopping on failure is another request');
  const alike = await call('runMany', { items: [{ path: 'a' }, { path: 'b' }], mode: 'sequential', stopOnFailure: false });
  assert.equal(alike.deduplicated, true);
});

test('a queue address that Jenkins has reused after a restart is not taken for the launch it was given to', { skip }, async () => {
  const w = world();
  w.add('app', { builds: [{ number: 50 }] });
  const { launch, call } = setup(w);
  const id = launch.record('s1', 'app', {}, { queued: 9 }, { after: 50 });
  // After a restart the numbers start again: item 9 is somebody else's, for another job, and an old build of this job carries id 9.
  w.queue.set(9, { path: 'other/job', task: 'other/job', params: {}, number: 3, timestamp: w.now, cancelled: false });
  const old = w.jobs.get('app');
  old.builds.push({ number: 12, status: 'failed', running: false, duration: 1, timestamp: w.now - 90 * 86_400_000, params: [], queueId: 9, changes: [] });
  old.builds.sort((a, b) => b.number - a.number);
  await launch.poll();
  let row = (await call('launchHistory')).rows.find((r) => r.id === id);
  assert.deepEqual([row.state, row.number], ['queued', null], 'neither the other job\'s item nor the old build is this launch');
  // The same job, an item with a number from before the launch: also not ours.
  w.queue.set(9, { path: 'app', task: 'app', params: {}, number: 40, timestamp: w.now, cancelled: false });
  await launch.poll();
  row = (await call('launchHistory')).rows.find((r) => r.id === id);
  assert.equal(row.state, 'queued');
  // And the build that really is ours, started after it, is found.
  old.builds.unshift({ number: 51, status: 'running', running: true, duration: 0, timestamp: w.now + 1000, params: [], queueId: 9, changes: [] });
  w.queue.get(9).forgotten = true;
  w.now += 2000;
  await launch.poll();
  row = (await call('launchHistory')).rows.find((r) => r.id === id);
  assert.deepEqual([row.state, row.number], ['running', 51]);
});

test('a schedule that was being started when the app closed is said to be unknown, not left starting', { skip }, async () => {
  const w = world();
  w.add('app');
  const first = setup(w);
  const { id } = await first.call('scheduleRun', { path: 'app', at: T0 + 60_000 });
  first.launch.stop();
  first.db.prepare("UPDATE jl_schedule SET state = 'firing' WHERE id = ?").run(id);
  const again = setup(w, { db: first.db });
  const row = (await again.call('schedules')).schedules.find((s) => s.id === id);
  assert.equal(row.state, 'missed');
  assert.match(row.error, /whether it ran/);
});

test('a schedule for something that looks like production waits less for a late machine, and old missed ones expire', { skip }, async () => {
  const w = world();
  w.add('docs'); w.add('svc PROD'); w.add('Timelog PRO'); w.add('svc DEV');
  const { launch, call } = setup(w);
  const a = await call('scheduleRun', { path: 'docs', at: T0 + 60_000 });
  const b = await call('scheduleRun', { path: 'svc PROD', at: T0 + 60_000 });
  const c = await call('scheduleRun', { path: 'Timelog PRO', at: T0 + 60_000 });
  w.now = T0 + 60_000 + 90_000;
  await launch.runDue();
  const state = async (id) => (await call('schedules')).schedules.find((s) => s.id === id).state;
  assert.deepEqual([await state(a.id), await state(b.id), await state(c.id)], ['fired', 'missed', 'missed'], 'ninety seconds late is fine for docs, not for production');
  // Missed ones do not wait for ever, nor count against the limit for ever.
  const stale = await call('scheduleRun', { path: 'svc DEV', at: T0 + 3_600_000 });
  launch.db.prepare("UPDATE jl_schedule SET state = 'missed', at = ? WHERE id = ?").run(T0 - 8 * 86_400_000, stale.id);
  launch.stop();
  const again = setup(w, { db: launch.db });
  assert.equal((await again.call('schedules')).schedules.some((s) => s.id === stale.id), false);
});

test('a job with a secret parameter cannot be scheduled: the run would start with the secret empty', { skip }, async () => {
  const w = world();
  w.add('deploy', { params: [def('VERSION'), def('API_KEY', { type: 'password', secret: true })] });
  const { refused, call } = setup(w);
  assert.match(await refused('scheduleRun', { path: 'deploy', at: T0 + 3_600_000, params: { VERSION: '1' } }), /API_KEY is a secret.*never kept — run this one now/);
  w.add('plain', { params: [def('VERSION')] });
  assert.equal((await call('scheduleRun', { path: 'plain', at: T0 + 3_600_000 })).state, 'scheduled');
});

test('a value that looks like a credential is not kept, whatever the parameter is called; a name that merely contains "key" is not a secret', { skip }, async () => {
  const w = world();
  w.add('app', { params: [def('CONN'), def('ARGS'), def('NOTE'), def('KEYSTORE_ALIAS'), def('MONKEY'), def('PWD'), def('PAT'), def('AUTH_HEADER'), def('PRIVATE_KEY'), def('apiKey')] });
  const { launch, call } = setup(w);
  const values = { CONN: 'postgres://u:hunter2@db/x', ARGS: '--auth=Bearer abc123def', NOTE: ['gh','p_abcdefghijklmnopqrstuvwxyz0123456789'].join(''), KEYSTORE_ALIAS: 'release', MONKEY: 'banana', PWD: 'p', PAT: 'p', AUTH_HEADER: 'p', PRIVATE_KEY: 'p', apiKey: 'p' };
  launch.record('s1', 'app', values, { queued: 1 }, { defs: w.jobs.get('app').params });
  const row = (await call('launchHistory')).rows[0];
  assert.deepEqual(row.params, { KEYSTORE_ALIAS: 'release', MONKEY: 'banana' });
  assert.deepEqual(row.needsInput.sort(), ['ARGS', 'AUTH_HEADER', 'CONN', 'NOTE', 'PAT', 'PRIVATE_KEY', 'PWD', 'apiKey']);
  assert.equal(/hunter2|abc123|ghp_|"p"/.test(JSON.stringify([row, launch.db.prepare('SELECT * FROM jl_launch').all()])), false);
  assert.equal(/AKIA/.test(JSON.stringify(splitSecrets([], { X: ['AK','IAABCDEFGHIJKLMNOP'].join('') }).kept)), false, 'an access key id is one');
  assert.equal(Object.keys(splitSecrets([], { LONG: 'dGhpcyBpcyBhIHNlY3JldCB2YWx1ZSB0aGF0IGlzIGxvbmc9' }).kept).length, 0, 'forty-plus characters of base64-looking text are kept out');
  assert.deepEqual(splitSecrets([], { SHA: 'a'.repeat(40), BRANCH: 'feature-add-a-very-long-descriptive-branch-name-for-this' }).kept.SHA, 'a'.repeat(40), 'a hash of a commit is not a secret');
  assert.deepEqual(splitSecrets([], { VERSION: '1.4.0', SHA: 'a91c3e2b7d00' }).kept, { VERSION: '1.4.0', SHA: 'a91c3e2b7d00' });
});

test('"looks like production" knows the board\'s words: PRO, PRD, and the ones a person added', { skip }, async () => {
  const w = world();
  for (const path of ['Timelog PRO', 'x-PRD', 'web LIVEISH', 'docs', 'PROJECTS']) w.add(path);
  const { call } = setup(w, { launch: { boardSettings: () => ({ envTokens: { LIVEISH: 'PROD' } }) } });
  const plan = await call('launchPlan', { items: ['Timelog PRO', 'x-PRD', 'web LIVEISH', 'docs', 'PROJECTS'].map((path) => ({ path })) });
  assert.deepEqual(plan.items.map((i) => i.looksProd), [true, true, true, false, false]);
  const pad = await call('launchpad');
  assert.equal(Array.isArray(pad.favorites), true);
});

test('the launch tables are at version 2, with a note on every launch', { skip }, () => {
  const db = new sqlite.DatabaseSync(':memory:');
  const launch = new Launch({ archive: { db }, on: () => null, maintain: false });
  assert.equal(db.prepare('SELECT version FROM jl_schema').get().version, 2);
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('jl_launch') WHERE name = 'note'").get());
  launch.stop();
  // A file made by the first version is brought up, not refused.
  const old = new sqlite.DatabaseSync(':memory:');
  old.exec('CREATE TABLE jl_schema (version INTEGER NOT NULL); INSERT INTO jl_schema VALUES (1);');
  old.exec(`CREATE TABLE jl_launch (id INTEGER PRIMARY KEY, server TEXT NOT NULL, path TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', needs TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, batch TEXT, from_path TEXT, from_number INTEGER, queue_id INTEGER, after_number INTEGER, number INTEGER, state TEXT NOT NULL, error TEXT, at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, checked_at INTEGER NOT NULL, follow INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE jl_batch (id TEXT PRIMARY KEY, server TEXT NOT NULL, mode TEXT NOT NULL, stop_on_failure INTEGER NOT NULL, follow INTEGER NOT NULL, source TEXT NOT NULL, items TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE jl_schedule (id TEXT PRIMARY KEY, server TEXT NOT NULL, path TEXT NOT NULL, params TEXT NOT NULL, at INTEGER NOT NULL, note TEXT, state TEXT NOT NULL, created INTEGER NOT NULL, fired_at INTEGER, launch_id INTEGER, error TEXT);`);
  const upgraded = new Launch({ archive: { db: old }, on: () => null, maintain: false });
  assert.equal(upgraded.error, null);
  assert.equal(old.prepare('SELECT version FROM jl_schema').get().version, 2);
  upgraded.stop();
});


test('no verb answers a validation outcome with a top-level ok:false — the host reads that as a failed call', { skip }, async () => {
  const w = world();
  w.add('off', { buildable: false });
  w.add('gone-secret', { params: [def('API_KEY', { type: 'password', secret: true })] });
  w.add('app', { builds: [{ number: 1, status: 'failed' }] });
  const { launch, call } = setup(w);
  // A plan with problems in it is still a plan: `valid:false`, and what is wrong item by item.
  const plan = await call('launchPlan', { items: [{ path: 'off' }, { path: 'gone-secret' }, { path: 'nowhere' }, { path: 'app', params: { NOPE: 'x' } }] });
  assert.equal('ok' in plan, false, 'no top-level ok at all');
  assert.equal(plan.valid, false);
  assert.deepEqual(plan.items.map((i) => i.ok), [false, true, false, true], 'per item, nested, is fine');
  assert.match(plan.items[0].errors[0], /disabled/);
  assert.equal(plan.counts.errors, 2);
  const clean = await call('launchPlan', { items: [{ path: 'app' }] });
  assert.equal(clean.valid, true);
  assert.equal('ok' in clean, false);
  const retry = await call('launchPlan', { retryFailed: true });
  assert.equal(retry.valid, true);
  // The same for everything else that can say "not possible" in a result.
  const results = [
    await call('promoteCandidates', { path: 'nightly' }),
    await call('promoteCandidates', { path: 'app' }),
    await call('launchpad'), await call('launchHistory'), await call('schedules'), await call('paramPlan', { path: 'off' }),
    await call('runMany', { items: [{ path: 'app' }], skipInvalid: true }),
    await call('scheduleRun', { path: 'app', at: T0 + 3_600_000 }),
  ];
  for (const result of results) assert.notEqual(result.ok, false, JSON.stringify(result).slice(0, 80));
  // A real failure throws, with words.
  for (const [verb, args] of [['runMany', { items: [{ path: 'off' }] }], ['promote', {}], ['scheduleRun', { path: 'app', at: 1 }], ['scheduleCancel', { id: 'x' }], ['paramPlan', { path: 'nowhere' }]]) {
    await assert.rejects(launch.verbs()[verb]({ server: 's1', ...args }), (error) => typeof error.message === 'string' && error.message.length > 3, verb);
  }
});

// --- through the service ----------------------------------------------------------------------------------

function reply(body, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n) => lower[n.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) };
}

/** A Jenkins over HTTP, with the little the run verb and the launch tracking ask of it. */
function http() {
  const s = { posts: [], gets: [], queue: new Map(), builds: [], nextQueue: 40 };
  s.fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    s.gets.push(`${method} ${pathname}${search ? '?…' : ''}`);
    if (pathname === '/crumbIssuer/api/json') return reply('', { status: 404 });
    if (method === 'POST' && /\/build(WithParameters)?$/.test(pathname)) {
      s.posts.push({ pathname, body: init.body ?? '' });
      const id = s.nextQueue;
      s.nextQueue += 1;
      s.queue.set(id, { number: null });
      return reply('', { status: 201, headers: { location: `https://ci.test/queue/item/${id}/` } });
    }
    const item = /^\/queue\/item\/(\d+)\/api\/json$/.exec(pathname);
    if (item) {
      const found = s.queue.get(Number(item[1]));
      return found ? reply({ id: Number(item[1]), cancelled: false, executable: found.number ? { number: found.number, timestamp: 1 } : undefined }) : reply('', { status: 404 });
    }
    if (/^\/job\/app\/(\d+)\/api\/json$/.test(pathname)) {
      const n = Number(/(\d+)\/api/.exec(pathname)[1]);
      const b = s.builds.find((one) => one.number === n);
      return b ? reply({ building: b.building, result: b.building ? null : 'SUCCESS', duration: 5000, timestamp: 1 }) : reply('', { status: 404 });
    }
    if (pathname === '/job/app/api/json') {
      return reply({ _class: 'hudson.model.FreeStyleProject', name: 'app', fullName: 'app', buildable: true, inQueue: false, lastBuild: { number: 1 }, builds: [{ number: 1, result: 'SUCCESS', building: false, timestamp: 1, duration: 1 }], property: [{ parameterDefinitions: [{ name: 'VERSION', type: 'StringParameterDefinition', defaultParameterValue: { value: '1' } }, { name: 'API_KEY', type: 'PasswordParameterDefinition' }] }] });
    }
    return reply('', { status: 404 });
  };
  return s;
}

test('through the service: the run verb is remembered and followed, the verbs exist, and forgetting reaches the history', { skip }, async () => {
  const jenkins = http();
  const notes = [];
  const service = new JenkinsService({
    db: new sqlite.DatabaseSync(':memory:'), archiveDb: new sqlite.DatabaseSync(':memory:'), fetch: jenkins.fetch, nudgeMs: [], notify: (...a) => notes.push(a),
  });
  const call = async (name, args) => {
    const result = await service.call(name, args);
    if (result?.ok === false) throw new Error(result.error);
    return result;
  };
  for (const verb of ['launchpad', 'launchHistory', 'launchPlan', 'paramPlan', 'promoteCandidates', 'schedules', 'runMany', 'promote', 'scheduleRun', 'scheduleCancel']) {
    assert.equal(typeof service.verbs[verb], 'function', verb);
  }
  const id = (await service.call('saveServer', { name: 'ci', url: 'https://ci.test', user: 'ana', token: 'TOKEN-1' })).id;
  const queued = await call('run', { server: id, path: 'app', params: { VERSION: '2', API_KEY: 'SECRET-RUN' } });
  assert.deepEqual(queued, { queued: 40 }, 'the answer is the one it always was');
  let row = (await call('launchHistory', { server: id })).rows[0];
  assert.deepEqual([row.path, row.state, row.source, row.params, row.needsInput], ['app', 'queued', 'manual', { VERSION: '2' }, ['API_KEY']]);
  jenkins.queue.get(40).number = 2;
  jenkins.builds.push({ number: 2, building: true });
  await service.launch.poll();
  assert.equal((await call('launchHistory', { server: id })).rows[0].state, 'running');
  assert.deepEqual(service.store.follows(id).map((f) => [f.path, f.number]), [['app', 2]], 'a build started from here is followed');
  jenkins.builds[0].building = false;
  await service.launch.poll();
  assert.equal((await call('launchHistory', { server: id })).rows[0].state, 'success');
  // A run that asks not to be followed is not.
  await call('run', { server: id, path: 'app', follow: false });
  jenkins.queue.get(41).number = 3;
  jenkins.builds.push({ number: 3, building: true });
  await service.launch.poll();
  assert.equal(service.store.follows(id).length, 1);
  // The secret went to Jenkins and is nowhere here.
  assert.equal(jenkins.posts.some((p) => p.body.includes('SECRET-RUN')), true);
  assert.equal(/SECRET-RUN/.test(JSON.stringify(service.launch.db.prepare('SELECT * FROM jl_launch').all())), false);
  // Forgetting the job's archive forgets what was launched; removing the server forgets everything.
  await call('forget', { server: id, path: 'app' });
  assert.equal((await call('launchHistory', { server: id })).rows.length, 0);
  await call('run', { server: id, path: 'app' });
  service.launch.db.prepare("INSERT INTO jl_schedule (id, server, path, params, at, state, created) VALUES ('sched-1', ?, 'app', '{}', ?, 'scheduled', ?)").run(id, Date.now() + 3_600_000, Date.now());
  await call('deleteServer', { id });
  assert.equal(service.launch.db.prepare('SELECT COUNT(*) AS n FROM jl_launch').get().n, 0);
  assert.equal(service.launch.db.prepare('SELECT COUNT(*) AS n FROM jl_schedule').get().n, 0);
  service.stop();
  void notes;
});

test('through the service: stopping stops the clocks', { skip }, () => {
  const service = new JenkinsService({ db: new sqlite.DatabaseSync(':memory:'), archiveDb: new sqlite.DatabaseSync(':memory:'), fetch: async () => reply('', { status: 404 }), nudgeMs: [] });
  assert.ok(service.launch.timer);
  service.stop();
  assert.equal(service.launch.timer, null);
  assert.equal(service.launch.stopped, true);
});

test('an override is not started from what was typed in it last time, but that is still offered', async () => {
  const w = world();
  w.add('deploy-prod', { params: [def('VERSION', { default: 'latest' }), def('VERSION_OVERRIDE')], builds: [] });
  const { launch, call } = setup(w);
  launch.record('s1', 'deploy-prod', { VERSION: 'latest', VERSION_OVERRIDE: '2.2.0.318' }, { queued: 1 }, { defs: w.jobs.get('deploy-prod').params });
  const plan = await call('paramPlan', { path: 'deploy-prod' });
  const of = (name) => plan.params.find((p) => p.name === name);
  assert.deepEqual([of('VERSION').suggested, of('VERSION').source], ['latest', 'last run by me']);
  assert.equal(of('VERSION_OVERRIDE').suggested, null, 'so a redeploy does not pin an old version without being asked');
  assert.deepEqual(of('VERSION_OVERRIDE').others.map((o) => o.value), ['2.2.0.318']);
});
