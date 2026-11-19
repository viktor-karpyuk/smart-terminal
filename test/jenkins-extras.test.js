'use strict';

/**
 * What a person asks of a build once it has gone wrong — or never starts —
 * against a Jenkins that is not there.
 *
 * The answers of the server in these tests are the ones a real Jenkins gave
 * (LTS 2.5xx with the Pipeline plugins), recorded and cut down: the step graph
 * of a failed build, the words of the build queue, the Jenkinsfile validator,
 * the replay form. What is checked is what would mislead somebody: a failing
 * step that is really a step that never ran, a reason that sounds sure and is
 * a guess, a search that finds nothing because a quote broke it, a "seen
 * before" with nothing to look at, a link that points somewhere else.
 *
 * Needs `node:sqlite` (Node 22+) and skips itself without it.
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

const extras = require('../electron/jenkins-extras');
const { JenkinsService } = sqlite ? require('../electron/jenkins-service') : {};
const {
  reasonFrom, normalize, signatureOf, errorLines, errorWindow, extract, scriptsOf, decodeEntities, failingNodes, queuedFor, agentOf, soonestFree,
} = extras;

// --- a Jenkins made of a table -------------------------------------------------------

function reply(body, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n) => lower[n.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

/**
 * `routes` maps `METHOD /path` (no query) to a reply, or to a function of `{ search, init }` that makes one.
 * What is not in it is a 404, which is what Jenkins says about a page that is not there.
 */
function jenkins(routes) {
  const server = {
    routes,
    calls: [],
    down: false,
    count: (re) => server.calls.filter((one) => re.test(one.key)).length,
  };
  server.fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method ?? 'GET'} ${pathname}`;
    server.calls.push({ key, search, body: init.body ?? null, headers: init.headers ?? {} });
    if (server.down) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
    const answer = server.routes[key];
    if (!answer) return reply('', { status: 404 });
    return typeof answer === 'function' ? answer({ search, init }) : answer;
  };
  return server;
}

function setup(routes = {}, options = {}) {
  const fake = jenkins(routes);
  const service = new JenkinsService({
    db: new sqlite.DatabaseSync(':memory:'), archiveDb: new sqlite.DatabaseSync(':memory:'), fetch: fake.fetch, nudgeMs: [], ...options,
  });
  const call = async (name, args) => {
    const result = await service.call(name, args);
    if (result?.ok === false) throw new Error(result.error);
    return result;
  };
  const refused = async (name, args) => {
    const result = await service.call(name, args);
    assert.equal(result?.ok, false, `${name} should have been refused`);
    return result.error;
  };
  const add = async () => (await service.call('saveServer', { name: 'ci', url: 'https://ci.test', user: 'ana', token: 'SECRET-TOKEN' })).id;
  return { fake, service, call, refused, add };
}

/** A finished build kept in the archive, with its console. */
function keep(service, serverId, path, number, status, log, timestamp = Date.parse('2026-10-10T10:00:00Z') + number * 1000) {
  const text = Buffer.from(log, 'utf8');
  service.archive.put(serverId, path, {
    number, status, running: false, timestamp, duration: 1000, path, name: `#${number}`, description: '', agent: 'built-in',
    causes: [], changes: [], parameters: [], artifacts: [], stages: [],
  }, { gz: zlib.gzipSync(text), chars: log.length, rawSize: text.length, truncated: false, skipped: 0 }, { now: timestamp });
}

// --- real answers, cut down ------------------------------------------------------------

const ERR3 = { message: 'script returned exit code 3', type: 'hudson.AbortException' };
const DESCRIBE_SH = {
  status: 'FAILED',
  stages: [
    { id: '6', name: 'Build', status: 'SUCCESS', startTimeMillis: 1000, durationMillis: 210 },
    { id: '11', name: 'Test', status: 'FAILED', error: ERR3, startTimeMillis: 1300, durationMillis: 437 },
    // What Jenkins says about a stage that never ran: the error of the one before.
    { id: '17', name: 'Deploy', status: 'FAILED', error: ERR3, startTimeMillis: 1800, durationMillis: 102 },
  ],
};
const NODE_TEST = {
  id: '11', name: 'Test', status: 'FAILED',
  stageFlowNodes: [
    { id: '12', name: 'Print Message', status: 'SUCCESS', parameterDescription: 'running tests', parentNodes: ['11'] },
    { id: '13', name: 'Shell Script', status: 'FAILED', error: ERR3, parameterDescription: 'echo FAIL: 3 tests failed at /tmp/build-12345/x.java:88 after 41s; exit 3', parentNodes: ['12'], startTimeMillis: 1310 },
  ],
};
const NODE_DEPLOY_SKIPPED = { id: '17', name: 'Deploy', status: 'FAILED', stageFlowNodes: [{ id: '18', name: 'Get contextual object from internal APIs', status: 'SUCCESS', parentNodes: ['17'] }] };
const LOG_13 = { nodeId: '13', nodeStatus: 'FAILED', length: 138, hasMore: false, text: '+ echo FAIL: 3 tests failed at /tmp/build-12345/x.java:88 after 41s\nFAIL: 3 tests failed at /tmp/build-12345/x.java:88 after 41s\n+ exit 3\n' };

function shRoutes(job = 'fail-sh', number = 1) {
  const base = `/job/${job}/${number}`;
  return {
    [`GET ${base}/wfapi/describe`]: reply(DESCRIBE_SH),
    [`GET ${base}/execution/node/11/wfapi/describe`]: reply(NODE_TEST),
    [`GET ${base}/execution/node/17/wfapi/describe`]: reply(NODE_DEPLOY_SKIPPED),
    [`GET ${base}/execution/node/13/wfapi/log`]: reply(LOG_13),
    [`GET ${base}/api/json`]: reply({ actions: [{}, { restartEnabled: true, restartableStages: ['Build', 'Test'] }] }),
  };
}

/** A console served the way Jenkins serves one: from an offset, with the size and whether more is coming. */
function consoleRoute(text) {
  return ({ search }) => {
    const start = Number(new URLSearchParams(search).get('start') ?? 0);
    const body = Buffer.from(text).subarray(Math.max(0, start)).toString();
    return reply(body, { headers: { 'x-text-size': String(Buffer.byteLength(text)), 'x-more-data': '' } });
  };
}

// --- the words of the queue --------------------------------------------------------------

test('every queue message Jenkins was seen to send is a reason a person can act on, and an unknown one is not dressed up', () => {
  const cases = [
    ['In the quiet period. Expires in 1.9 sec', 'quiet-period'],
    ['Finished waiting', 'finished-waiting'],
    ['Build #2 is already in progress (ETA: N/A)', 'concurrent-build'],
    ['Build #14 is already in progress (ETA: 1 min 30 sec)', 'concurrent-build'],
    ['Upstream project ‘up’ is already building', 'blocked-by-upstream'],
    ['Downstream project ‘down’ is already building', 'blocked-by-downstream'],
    ['‘Jenkins’ doesn’t have label ‘nonexistent-label’', 'no-node-with-label'],
    ['There are no nodes with the label ‘gpu’', 'no-node-with-label'],
    ['All nodes of label ‘arm’ are offline', 'label-all-offline'],
    ['‘build-07’ is offline', 'node-offline'],
    ['Waiting for next available executor', 'waiting-executor'],
    ['Waiting for next available executor on ‘build-07’', 'waiting-executor-on-node'],
    ['Waiting for next available executor on ‘build-07’ (offline)', 'node-offline'],
    ['Throttled by the category “deploys”', 'throttled'],
    ['Jenkins is about to shut down', 'shutting-down'],
    ['Something a later version says', 'other'],
    ['', 'other'],
  ];
  for (const [why, code] of cases) assert.equal(reasonFrom(why).code, code, why);
  assert.equal(reasonFrom('In the quiet period. Expires in 1.9 sec').seconds, 1.9);
  assert.equal(reasonFrom('‘Jenkins’ doesn’t have label ‘nonexistent-label’').label, 'nonexistent-label');
  assert.equal(reasonFrom('Waiting for next available executor on ‘build-07’ (offline)').node, 'build-07');
  assert.equal(reasonFrom('Upstream project ‘up’ is already building').text.includes('up'), true);
  // The raw text is always kept, because the prose is the server's and a guess about it can be wrong.
  assert.equal(reasonFrom('Something a later version says').detail, 'Something a later version says');
  // Hostile text is only ever text.
  assert.equal(reasonFrom('<img src=x onerror=alert(1)>'.repeat(1000)).code, 'other');
});

test('a queue item is a job\'s when its address says so: its own, or a Pipeline\'s "part of" placeholder', () => {
  assert.equal(queuedFor({ task: { url: 'http://ci/job/team/job/deploy/' } }, '/job/team/job/deploy'), true);
  assert.equal(queuedFor({ task: { url: 'job/label-missing/2/' } }, '/job/label-missing'), true);
  assert.equal(queuedFor({ task: { url: 'http://ci/job/label-missing-2/' } }, '/job/label-missing'), false, 'another job that starts the same way');
  assert.equal(queuedFor({ task: { url: 'http://ci/job/other/' } }, '/job/deploy'), false);
  assert.equal(queuedFor({}, '/job/deploy'), false);
});

test('an agent\'s capacity is its own executors, and its disk is low when Jenkins\' own threshold says so', () => {
  const busy = { currentExecutable: { url: 'x' } };
  const agent = agentOf({
    displayName: 'build-1', offline: false, numExecutors: 2, assignedLabels: [{ name: 'build-1' }, { name: 'linux' }],
    executors: [busy, {}], oneOffExecutors: [busy, busy, busy],
    monitorData: { 'hudson.node_monitors.DiskSpaceMonitor': { size: 500 * 1048576, threshold: 1073741824 }, 'hudson.node_monitors.ArchitectureMonitor': 'Linux' },
  });
  assert.deepEqual([agent.busy, agent.total, agent.labels, agent.diskFreeMB, agent.diskLow], [1, 2, ['linux'], 500, true]);
  assert.equal(agentOf({ displayName: 'a', numExecutors: 1, executors: [], monitorData: { 'hudson.node_monitors.DiskSpaceMonitor': { size: 90_000 * 1048576, threshold: 1073741824 } } }).diskLow, false);
  assert.equal(agentOf({ displayName: 'a' }).diskFreeMB, null);
});

test('the wait for an executor is worked out from what is running and how long it usually takes, and an idle one is no wait at all', () => {
  const now = 1_000_000;
  const running = (left) => ({ currentExecutable: { timestamp: now - 60_000, estimatedDuration: 60_000 + left * 1000 } });
  assert.equal(soonestFree([{ numExecutors: 2, executors: [running(120), running(45)] }], now), 45);
  assert.equal(soonestFree([{ numExecutors: 2, executors: [running(120), {}] }], now), 0);
  assert.equal(soonestFree([{ numExecutors: 1, executors: [{ currentExecutable: { timestamp: now, estimatedDuration: -1 } }] }], now), null, 'no estimate, no guess');
  assert.equal(soonestFree([{ offline: true, numExecutors: 1, executors: [] }], now), null, 'an offline agent frees nothing');
});

// --- what counts as the same failure ------------------------------------------------------

test('the same failure is the same signature however the numbers, paths and times fall, and a different one is not', () => {
  const a = signatureOf('compiling\nERROR: certificate has expired (notAfter=2026-10-01T10:00:00Z) at /tmp/build-123/x.java:88 after 41s\nFinished: FAILURE');
  const b = signatureOf('compiling\nERROR: certificate has expired (notAfter=2026-12-24T23:59:59Z) at /var/lib/jenkins/ws/y.java:9 after 3s\nFinished: FAILURE');
  const c = signatureOf('ERROR: connection refused by 10.0.0.7:5432');
  assert.equal(a.sig, b.sig);
  assert.notEqual(a.sig, c.sig);
  assert.match(a.text, /certificate has expired/, 'the evidence is the line itself, as it was');
  assert.match(a.normalized, /<ts>/);
  assert.equal(a.sig.length, 16);
  assert.equal(signatureOf('all fine\nBuild succeeded\n'), null);
  assert.equal(signatureOf(''), null);
});

test('what every failure says is not what this one said', () => {
  const log = [
    '[Pipeline] sh', '+ echo ERROR: boom in module core', 'ERROR: boom in module core',
    '\tat hudson.model.Foo.run(Foo.java:1)', 'ERROR: script returned exit code 1', 'Finished: FAILURE',
  ].join('\n');
  assert.equal(errorLines(log, { count: 1 })[0].line, 'ERROR: boom in module core', 'not the shell\'s trace of the command, nor the wrapper');
  // With nothing but the wrappers, the wrapper is all there is.
  assert.equal(errorLines('ERROR: script returned exit code 2\nFinished: FAILURE')[0].line, 'ERROR: script returned exit code 2');
  assert.equal(errorWindow('a\nb\nc').found, false);
  assert.equal(errorWindow('a\nb\nERROR: x\nc\nd').text.split('\n').length, 5);
});

test('normalising text that somebody else wrote takes linear time, however hostile', () => {
  const hostile = [`ERROR: ${'/a'.repeat(300_000)}`, `ERROR: ${'1'.repeat(1_000_000)}`, `ERROR: ${'a-'.repeat(400_000)}`, `ERROR: ${'\u001b[31m'.repeat(200_000)}`];
  for (const line of hostile) {
    const began = Date.now();
    normalize(line);
    signatureOf(`${line}\n${line}`);
    errorLines(`${line.slice(0, 5000)}\n`.repeat(2000));
    assert.ok(Date.now() - began < 1500, `${line.slice(0, 12)}… took ${Date.now() - began} ms`);
  }
  // Lines are cut before any pattern sees them.
  assert.ok(normalize('x'.repeat(100_000)).length <= 240);
});

test('what is indexed of a console: all of a small one, the end and the error lines of a large one, and never more than a bound', () => {
  const small = 'line one\nERROR: x\nline three\n';
  assert.deepEqual(extract(small), { text: small, full: true });
  const filler = (n) => Array.from({ length: n }, (_, i) => `compiling module ${i} of the build`).join('\n');
  const big = `${filler(5000)}\nERROR: needle in the middle\n${filler(40_000)}\nFINAL-LINE`;
  const part = extract(big);
  assert.equal(part.full, false);
  assert.ok(part.text.includes('FINAL-LINE'), 'the end');
  assert.ok(part.text.includes('needle in the middle'), 'the error line far from the end');
  assert.ok(part.text.length < 300 * 1024, `${part.text.length} characters`);
  assert.ok(extract('x\n'.repeat(5_000_000)).text.length < 300 * 1024);
});

// --- the Jenkins page, a little of it ---------------------------------------------------------

test('a replay form is read without evaluating it: entities decoded, loaded scripts found, hostile markup inert', () => {
  const html = `<form><textarea name="_.mainScript" class="x">node {\n  echo &quot;a &amp; b&quot; &lt;tag&gt; &#39;q&#39; &#x41;\n}</textarea>
    <textarea checkDependsOn="" name="_.Script1" rows="5">def hi() { echo "hi" }\nreturn this</textarea></form>`;
  const found = scriptsOf(html);
  assert.equal(found.main, 'node {\n  echo "a & b" <tag> \'q\' A\n}');
  assert.deepEqual(found.loaded, [{ name: 'Script1', script: 'def hi() { echo "hi" }\nreturn this' }]);
  assert.equal(scriptsOf('<p>no form here</p>').main, null);
  assert.equal(scriptsOf('<textarea name="_.mainScript">never closed').main, null);
  assert.equal(decodeEntities('&#0;&#1;&#x110000;&#xD800;ok&#10;'), 'ok\n', 'control characters and invalid code points are dropped');
  assert.equal(decodeEntities('&amp;lt;'), '&lt;', 'decoded once, not twice');
  const began = Date.now();
  scriptsOf(`<textarea name="_.mainScript">${'&amp;'.repeat(400_000)}</textarea>`);
  scriptsOf('<textarea name="_.a">'.repeat(100_000));
  assert.ok(Date.now() - began < 2000);
});

test('of the steps of a stage, the ones that failed are the ones that did something, not the blocks around them', () => {
  const nodes = [
    { id: '2', name: 'Allocate node : Start', status: 'FAILED', parentNodes: ['1'], startTimeMillis: 5 },
    { id: '3', name: 'Shell Script', status: 'FAILED', parentNodes: ['2'], startTimeMillis: 9 },
    { id: '4', name: 'Print Message', status: 'SUCCESS', parentNodes: ['3'] },
    { id: '5', name: 'Shell Script', status: 'UNSTABLE', parentNodes: ['4'], startTimeMillis: 11 },
  ];
  assert.deepEqual(failingNodes(nodes).map((n) => n.id), ['3', '5']);
  assert.deepEqual(failingNodes([{ id: '1', status: 'SUCCESS' }]), []);
});

// --- why it failed -----------------------------------------------------------------------------

test('the failing step of a build is the step, with its own output — and a stage that never ran is not it', { skip }, async () => {
  const { call, add } = setup(shRoutes());
  const server = await add();
  const found = await call('failingStep', { server, path: 'fail-sh', number: 1 });
  assert.equal(found.found, true);
  assert.equal(found.via, 'steps');
  assert.equal(found.source, 'jenkins');
  assert.deepEqual(found.stage, { name: 'Test', id: '11' });
  assert.equal(found.step.name, 'Shell Script');
  assert.match(found.step.description, /echo FAIL: 3 tests failed/);
  assert.equal(found.error, 'script returned exit code 3');
  assert.match(found.log.text, /FAIL: 3 tests failed at \/tmp\/build-12345\/x\.java:88/);
  assert.equal(found.log.truncated, false);
  assert.deepEqual(found.others, [], 'Deploy was reported failed by Jenkins; its only step passed, so it never ran');
  assert.deepEqual(found.restartable, ['Build', 'Test']);
  assert.equal(JSON.stringify(found).includes('SECRET-TOKEN'), false);
});

test('a finished build\'s failing step is read once, and then answered from this computer — even when Jenkins is gone', { skip }, async () => {
  const { fake, call, add } = setup(shRoutes());
  const server = await add();
  await call('failingStep', { server, path: 'fail-sh', number: 1 });
  const before = fake.calls.length;
  const again = await call('failingStep', { server, path: 'fail-sh', number: 1 });
  assert.equal(fake.calls.length, before, 'no request at all');
  assert.equal(again.source, 'local');
  assert.equal(again.step.name, 'Shell Script');
  fake.down = true;
  assert.equal((await call('failingStep', { server, path: 'fail-sh', number: 1 })).found, true, 'and with Jenkins down');
});

test('asked twice at once, it is one question', { skip }, async () => {
  const { fake, call, add } = setup(shRoutes());
  const server = await add();
  const both = await Promise.all([call('failingStep', { server, path: 'fail-sh', number: 1 }), call('failingStep', { server, path: 'fail-sh', number: 1 })]);
  assert.deepEqual(both[0], both[1]);
  assert.equal(fake.count(/wfapi\/describe$/) , 3, 'one for the build and one for each of the two failing-looking stages');
});

test('parallel branches that fail together are the failing step and the others; a failure in a post action is found though its stage passed', { skip }, async () => {
  const parallel = {
    status: 'FAILED',
    stages: [
      { id: '6', name: 'Build', status: 'SUCCESS', startTimeMillis: 1000 },
      { id: '11', name: 'Checks', status: 'SUCCESS', startTimeMillis: 1100 },
      { id: '21', name: 'Unit', status: 'FAILED', startTimeMillis: 1200, error: { message: 'script returned exit code 4' } },
      { id: '23', name: 'Integration', status: 'FAILED', startTimeMillis: 1210, error: { message: 'script returned exit code 5' } },
      { id: '40', name: 'Deploy', status: 'FAILED', startTimeMillis: 2000, error: { message: 'script returned exit code 4' } },
    ],
  };
  const step = (id, error, desc) => ({ stageFlowNodes: [{ id, name: 'Shell Script', status: 'FAILED', error: { message: error }, parameterDescription: desc, parentNodes: ['p'], startTimeMillis: 1 }] });
  const base = '/job/par/1';
  const { call, add } = setup({
    [`GET ${base}/wfapi/describe`]: reply(parallel),
    [`GET ${base}/execution/node/21/wfapi/describe`]: reply(step('26', 'script returned exit code 4', 'echo unit failed; exit 4')),
    [`GET ${base}/execution/node/23/wfapi/describe`]: reply(step('28', 'script returned exit code 5', 'echo integration failed; exit 5')),
    [`GET ${base}/execution/node/40/wfapi/describe`]: reply(NODE_DEPLOY_SKIPPED),
    [`GET ${base}/execution/node/26/wfapi/log`]: reply({ text: '+ echo unit failed\nunit failed\n+ exit 4\n', hasMore: false }),
    [`GET ${base}/api/json`]: reply({ actions: [] }),
    // A post action that fails inside a stage Jenkins calls successful.
    '/job/post/1/wfapi/describe': reply({ status: 'FAILED', stages: [{ id: '6', name: 'Build', status: 'SUCCESS', startTimeMillis: 1 }, { id: '11', name: 'Declarative: Post Actions', status: 'SUCCESS', startTimeMillis: 2 }] }),
    'GET /job/post/1/wfapi/describe': reply({ status: 'FAILED', stages: [{ id: '6', name: 'Build', status: 'SUCCESS', startTimeMillis: 1 }, { id: '11', name: 'Declarative: Post Actions', status: 'SUCCESS', startTimeMillis: 2 }] }),
    'GET /job/post/1/execution/node/11/wfapi/describe': reply({ stageFlowNodes: [{ id: '12', name: 'Shell Script', status: 'FAILED', error: { message: 'script returned exit code 7' }, parameterDescription: 'echo cleanup broke; exit 7', parentNodes: ['11'] }] }),
    'GET /job/post/1/execution/node/12/wfapi/log': reply({ text: '+ exit 7\n', hasMore: true }),
    'GET /job/post/1/api/json': reply({ actions: [] }),
  });
  const server = await add();
  const p = await call('failingStep', { server, path: 'par', number: 1 });
  assert.equal(p.stage.name, 'Unit');
  assert.equal(p.error, 'script returned exit code 4');
  assert.deepEqual(p.others.map((o) => [o.stage, o.error]), [['Integration', 'script returned exit code 5']]);
  assert.equal(p.restartable, null, 'a build that offers no restart says so');
  const post = await call('failingStep', { server, path: 'post', number: 1 });
  assert.equal(post.stage.name, 'Declarative: Post Actions');
  assert.equal(post.step.description, 'echo cleanup broke; exit 7');
  assert.equal(post.log.truncated, true, 'Jenkins said there was more before what it sent');
});

test('a console is the answer when there are no steps: a freestyle job, a scripted one with nothing to say', { skip }, async () => {
  const text = 'Started by user ana\ncompiling\n+ echo ERROR: boom in module core\nERROR: boom in module core\n+ exit 1\nBuild step \'Execute shell\' marked build as failure\nFinished: FAILURE\n';
  const { call, add } = setup({
    'GET /job/free/1/api/json': reply({ building: false, result: 'FAILURE' }),
    'GET /job/free/1/logText/progressiveText': consoleRoute(text),
  });
  const server = await add();
  const f = await call('failingStep', { server, path: 'free', number: 1 });
  assert.equal(f.found, true);
  assert.equal(f.via, 'console');
  assert.equal(f.stage, null);
  assert.equal(f.step, null);
  assert.equal(f.error, 'ERROR: boom in module core', 'what the program said, not the shell\'s trace of the command');
  assert.match(f.log.text, /boom in module core/);
});

test('a build that passed, one still running, one that is not there, and one that failed without saying why', { skip }, async () => {
  const { call, refused, add } = setup({
    'GET /job/ok/1/wfapi/describe': reply({ status: 'SUCCESS', stages: [{ id: '6', name: 'Build', status: 'SUCCESS' }] }),
    'GET /job/run/1/wfapi/describe': reply({ status: 'IN_PROGRESS', stages: [{ id: '6', name: 'Build', status: 'IN_PROGRESS', startTimeMillis: 1 }] }),
    'GET /job/quiet/1/api/json': reply({ building: false, result: 'FAILURE' }),
    'GET /job/quiet/1/logText/progressiveText': consoleRoute('Started\nall quiet\nnothing to see\n'),
  });
  const server = await add();
  assert.deepEqual(await call('failingStep', { server, path: 'ok', number: 1 }), { found: false, reason: 'passed', status: 'success', source: 'jenkins' });
  assert.equal((await call('failingStep', { server, path: 'run', number: 1 })).reason, 'running');
  const quiet = await call('failingStep', { server, path: 'quiet', number: 1 });
  assert.equal(quiet.found, false);
  assert.equal(quiet.reason, 'no-error-found');
  assert.match(quiet.log.text, /nothing to see/, 'the end of the console is there anyway');
  assert.match(await refused('failingStep', { server, path: 'gone', number: 3 }), /nothing there/);
  assert.match(await refused('failingStep', { server, path: 'ok', number: 0 }), /build number/);
  assert.match(await refused('failingStep', { server, path: '../x', number: 1 }), /not a name Jenkins could have/);
});

test('when Jenkins has discarded the build, what the archive kept of it answers', { skip }, async () => {
  const { fake, service, call, add } = setup({});
  const server = await add();
  keep(service, server, 'old', 7, 'failed', 'Started\n+ make\nmake: *** [all] Error 2\nERROR: certificate has expired\nFinished: FAILURE\n');
  const found = await call('failingStep', { server, path: 'old', number: 7 });
  assert.equal(found.source, 'local');
  assert.equal(found.via, 'console');
  assert.equal(found.found, true);
  assert.match(found.log.text, /certificate has expired/);
  fake.down = true;
  assert.equal((await call('failingStep', { server, path: 'old', number: 7 })).source, 'local');
});

test('what Ask Claude is handed names the failing step and its output', { skip }, async () => {
  const build = { number: 1, result: 'FAILURE', building: false, timestamp: 1000, duration: 5000, actions: [{ causes: [{ shortDescription: 'Started by user ana' }] }], changeSets: [] };
  const log = 'Started by user ana\n[Pipeline] sh\n+ echo FAIL\nFAIL: 3 tests failed\n+ exit 3\nERROR: script returned exit code 3\nFinished: FAILURE\n';
  const { call, add } = setup({
    ...shRoutes(),
    'GET /job/fail-sh/1/api/json': ({ search }) => (search.includes('restartableStages') ? reply({ actions: [{ restartEnabled: true, restartableStages: ['Test'] }] }) : reply(build)),
    'GET /job/fail-sh/1/logText/progressiveText': consoleRoute(log),
  });
  const server = await add();
  const brief = await call('brief', { server, path: 'fail-sh', number: 1 });
  assert.match(brief.text, /The failing step: stage "Test", step "Shell Script" \(echo FAIL: 3 tests failed/);
  assert.match(brief.text, /Output of the failing step:/);
  assert.match(brief.text, /End of the log:/);
});

// --- why it does not run -----------------------------------------------------------------------

const AGENT = (over = {}) => ({
  displayName: 'Built-In Node', offline: false, numExecutors: 2, idle: false, assignedLabels: [{ name: 'built-in' }],
  executors: [{ currentExecutable: { url: 'x', timestamp: 0, estimatedDuration: 90_000 } }, { currentExecutable: { url: 'y', timestamp: 0, estimatedDuration: 60_000 } }], oneOffExecutors: [],
  monitorData: { 'hudson.node_monitors.DiskSpaceMonitor': { size: 141_000 * 1048576, threshold: 1073741824 } }, ...over,
});

function whyRoutes({ job = {}, items = [], agents = [AGENT()] } = {}) {
  return {
    'GET /job/deploy/api/json': reply({ buildable: true, color: 'blue', inQueue: false, queueItem: null, concurrentBuild: false, lastBuild: { number: 4, building: false }, ...job }),
    'GET /queue/api/json': reply({ items }),
    'GET /computer/api/json': reply({ computer: agents }),
  };
}

test('a build waiting for an executor says so, and how long it expects to wait', { skip }, async () => {
  const item = { id: 5, why: 'Waiting for next available executor', blocked: false, stuck: false, buildable: true, inQueueSince: 1000, task: { url: 'https://ci.test/job/deploy/' } };
  const { call, add } = setup(whyRoutes({ items: [item] }), { now: () => 30_000 });
  const server = await add();
  const r = await call('whyNotRunning', { server, path: 'deploy' });
  assert.equal(r.state, 'queued');
  assert.deepEqual(r.reasons.map((x) => x.code), ['waiting-executor']);
  assert.equal(r.waitSeconds, 30, 'the one that frees first: 60 s of a minute\'s estimate, 30 s in');
  assert.match(r.advice, /Nothing is wrong: it starts when an executor frees up, in about 30 s/);
  assert.equal(r.queueItem.id, 5);
  assert.equal(r.agents[0].busy, 2);
  assert.equal(r.agents[0].total, 2);
  assert.equal(r.agents[0].diskFreeMB, 141_000);
});

test('a label nobody has is said to be impossible, and an agent that is offline is named with its reason', { skip }, async () => {
  const label = { id: 28, why: '‘Jenkins’ doesn’t have label ‘nonexistent-label’', stuck: true, buildable: true, inQueueSince: 1, task: { url: 'job/deploy/2/' } };
  const { call, add } = setup(whyRoutes({ items: [label] }));
  const server = await add();
  const r = await call('whyNotRunning', { server, path: 'deploy' });
  assert.deepEqual(r.reasons.map((x) => x.code), ['no-node-with-label', 'stuck']);
  assert.match(r.reasons[0].text, /No agent has the label ‘nonexistent-label’/);
  assert.equal(r.advice, 'Add that label to an agent, or change the label the job asks for.');

  const off = { id: 9, why: 'All nodes of label ‘arm’ are offline', stuck: true, buildable: true, task: { url: 'https://ci.test/job/deploy/' } };
  const arm = AGENT({ displayName: 'arm-02', offline: true, offlineCauseReason: 'Disconnected by ana', assignedLabels: [{ name: 'arm' }, { name: 'arm-02' }], executors: [] });
  const { call: call2, add: add2 } = setup(whyRoutes({ items: [off], agents: [AGENT(), arm] }));
  const r2 = await call2('whyNotRunning', { server: await add2(), path: 'deploy' });
  assert.ok(r2.reasons.some((x) => x.code === 'node-offline' && /arm-02 is offline: Disconnected by ana/.test(x.text)));
  assert.equal(r2.agents.find((a) => a.name === 'arm-02').offline, true);
});

test('quiet period, a build already running, an upstream that is building, a disabled job, and nothing at all', { skip }, async () => {
  const mk = (why, extra = {}) => ({ id: 1, why, buildable: false, blocked: Boolean(extra.blocked), stuck: false, task: { url: 'https://ci.test/job/deploy/' } });
  const cases = [
    [mk('In the quiet period. Expires in 4.2 sec'), 'quiet-period', 5],
    [mk('Build #2 is already in progress (ETA: N/A)', { blocked: true }), 'concurrent-build', null],
    [mk('Upstream project ‘up’ is already building', { blocked: true }), 'blocked-by-upstream', null],
  ];
  for (const [item, code, wait] of cases) {
    const { call, add } = setup(whyRoutes({ items: [item] }));
    const r = await call('whyNotRunning', { server: await add(), path: 'deploy' });
    assert.equal(r.state, 'queued', code);
    assert.equal(r.reasons[0].code, code);
    assert.equal(r.waitSeconds, wait, code);
    assert.equal(r.queueItem.blocked, item.blocked);
  }
  const disabled = setup(whyRoutes({ job: { buildable: false, color: 'disabled' } }));
  const d = await disabled.call('whyNotRunning', { server: await disabled.add(), path: 'deploy' });
  assert.deepEqual([d.state, d.reasons[0].code], ['disabled', 'disabled']);
  const idle = setup(whyRoutes());
  const i = await idle.call('whyNotRunning', { server: await idle.add(), path: 'deploy' });
  assert.deepEqual([i.state, i.reasons, i.running], ['idle', [], null]);
  const running = setup(whyRoutes({ job: { lastBuild: { number: 9, building: true, timestamp: 5 } } }));
  const r = await running.call('whyNotRunning', { server: await running.add(), path: 'deploy' });
  assert.deepEqual([r.state, r.running.number], ['running', 9]);
});

test('an agent low on disk is a reason on its own, with the figure', { skip }, async () => {
  const low = AGENT({ displayName: 'build-3', monitorData: { 'hudson.node_monitors.DiskSpaceMonitor': { size: 300 * 1048576, threshold: 1073741824 } } });
  const { call, add } = setup(whyRoutes({ agents: [low] }));
  const r = await call('whyNotRunning', { server: await add(), path: 'deploy' });
  const disk = r.reasons.find((x) => x.code === 'disk-low');
  assert.match(disk.text, /build-3 is low on disk \(300 MB free\)/);
  assert.equal(r.agents[0].diskLow, true);
});

test('a server that does not let this user read the queue or the agents still gets an answer about the job', { skip }, async () => {
  const routes = whyRoutes();
  delete routes['GET /queue/api/json'];
  delete routes['GET /computer/api/json'];
  const { call, add } = setup(routes);
  const r = await call('whyNotRunning', { server: await add(), path: 'deploy' });
  assert.equal(r.state, 'idle');
  assert.deepEqual(r.agents, []);
});

test('asked again within moments it is not asked of Jenkins again', { skip }, async () => {
  const { fake, call, add } = setup(whyRoutes());
  const server = await add();
  await call('whyNotRunning', { server, path: 'deploy' });
  const before = fake.calls.length;
  await call('whyNotRunning', { server, path: 'deploy' });
  assert.equal(fake.calls.length, before);
});

// --- the Jenkinsfile ---------------------------------------------------------------------------------

const VALIDATE_ERRORS = 'Errors encountered validating Jenkinsfile:\nWorkflowScript: 5: Expected one of "steps", "stages", or "parallel" for stage "b" @ line 5, column 5.\n       stage("b") { }\n       ^\n\nWorkflowScript: 9: unexpected token: } @ line 9, column 1.\n';

test('a Declarative Jenkinsfile is checked by Jenkins, and what it says comes back as lines and columns', { skip }, async () => {
  const { fake, call, add } = setup({
    'POST /pipeline-model-converter/validate': ({ init }) => reply(/stage\("b"\)/.test(decodeURIComponent(init.body)) ? VALIDATE_ERRORS : 'Jenkinsfile successfully validated.\n'),
  });
  const server = await add();
  assert.deepEqual(await call('lint', { server, text: 'pipeline { agent any\n stages { stage("a") { steps { echo "x" } } } }' }), { available: true, valid: true, errors: [] });
  const bad = await call('lint', { server, text: 'pipeline {\n  agent any\n  stages {\n    stage("b") { }\n  }\n}' });
  assert.equal(bad.valid, false);
  assert.equal('ok' in bad, false, '`ok: false` is how the host knows a call failed; a Jenkinsfile with errors is an answer');
  assert.deepEqual(bad.errors, [
    { line: 5, column: 5, message: 'Expected one of "steps", "stages", or "parallel" for stage "b"' },
    { line: 9, column: 1, message: 'unexpected token: }' },
  ]);
  // The whole file goes in one field, encoded, so a `&` in it is still part of it.
  assert.match(fake.calls[1].body, /^jenkinsfile=pipeline%20%7B/);
});

test('a scripted pipeline is said to be unlintable without asking Jenkins; no validator and a huge file are said too', { skip }, async () => {
  const { fake, call, refused, add } = setup({});
  const server = await add();
  assert.deepEqual(await call('lint', { server, text: 'node {\n  echo "hi"\n}' }), { available: true, valid: null, reason: 'scripted', errors: [] });
  assert.deepEqual(await call('lint', { server, text: '// pipeline { is a comment\nnode { }' }), { available: true, valid: null, reason: 'scripted', errors: [] });
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await call('lint', { server, text: 'pipeline { agent any }' }), { available: false, valid: null, errors: [] }, 'the plugin is not there: a 404');
  assert.match(await refused('lint', { server, text: '' }), /no Jenkinsfile/);
  assert.match(await refused('lint', { server, text: `pipeline {${'x'.repeat(600_000)}}` }), /too big/);
  assert.match(await refused('lint', { server, text: 'pipeline {\u0000}' }), /not a text file/);
});

test('an answer Jenkins gives that this does not recognise is shown rather than turned into "valid"', { skip }, async () => {
  const { call, add } = setup({ 'POST /pipeline-model-converter/validate': reply('Something unforeseen happened here') });
  const r = await call('lint', { server: await add(), text: 'pipeline { agent any }' });
  assert.equal(r.valid, false);
  assert.match(r.errors[0].message, /Something unforeseen/);
});

function replayRoutes(post) {
  const form = `<form method="POST" action="run"><textarea name="_.mainScript" rows="5">pipeline { agent any\n stages { stage("a") { steps { echo &quot;hi&quot; } } } }</textarea>
    <textarea name="_.Script1" rows="5">def hi() { echo "hi" }\nreturn this</textarea></form>`;
  return {
    'GET /job/loads/2/replay/': reply(form),
    'GET /job/loads/api/json': reply({ nextBuildNumber: 3 }),
    'POST /job/loads/2/replay/run': post ?? reply('', { status: 302 }),
  };
}

test('the script of a build comes out of its replay form, with the scripts it loaded', { skip }, async () => {
  const { call, refused, add } = setup({ ...replayRoutes(), 'GET /job/locked/1/replay/': reply('', { status: 403 }) });
  const server = await add();
  const r = await call('replayScript', { server, path: 'loads', number: 2 });
  assert.equal(r.script, 'pipeline { agent any\n stages { stage("a") { steps { echo "hi" } } } }');
  assert.deepEqual(r.loadedScripts, [{ name: 'Script1', script: 'def hi() { echo "hi" }\nreturn this' }]);
  assert.equal(r.truncated, false);
  assert.match(await refused('replayScript', { server, path: 'locked', number: 1 }), /needs the Replay permission/);
  assert.match(await refused('replayScript', { server, path: 'free', number: 1 }), /cannot be replayed/);
});

test('a replay is posted the way Jenkins\' form posts it — json and all — with the scripts it loaded sent back as they were', { skip }, async () => {
  const { fake, call, refused, add } = setup(replayRoutes());
  const server = await add();
  const r = await call('replay', { server, path: 'loads', number: 2, script: 'pipeline { agent any\n stages { stage("x") { steps { echo "a & b" } } } }' });
  assert.deepEqual([r.ok, r.expectedNumber], [true, 3]);
  assert.match(r.hint, /whatever access the job has/);
  const post = fake.calls.find((c) => c.key === 'POST /job/loads/2/replay/run');
  const form = new URLSearchParams(post.body);
  const json = JSON.parse(form.get('json'));
  assert.equal(json.mainScript, 'pipeline { agent any\n stages { stage("x") { steps { echo "a & b" } } } }');
  assert.equal(json.Script1, 'def hi() { echo "hi" }\nreturn this', 'unchanged, because the person did not change it');
  assert.equal(form.get('mainScript'), json.mainScript);
  // A loaded script that was edited goes as edited.
  await call('replay', { server, path: 'loads', number: 2, script: 'pipeline { }', loadedScripts: { Script1: 'edited' } });
  assert.equal(JSON.parse(new URLSearchParams(fake.calls.filter((c) => c.key === 'POST /job/loads/2/replay/run')[1].body).get('json')).Script1, 'edited');

  assert.match(await refused('replay', { server, path: 'loads', number: 2, script: '' }), /no script/);
  assert.match(await refused('replay', { server, path: 'loads', number: 2, script: 'a\u0000b' }), /not a text script/);
  assert.match(await refused('replay', { server, path: 'loads', number: 2, script: 'x'.repeat(600_000) }), /too big/);
});

test('a replay Jenkins refuses is said plainly, and a script is never in what is said', { skip }, async () => {
  const { refused, add } = setup(replayRoutes(reply('', { status: 403 })));
  const server = await add();
  const secret = 'pipeline { /* SECRET-SCRIPT-BODY */ }';
  const message = await refused('replay', { server, path: 'loads', number: 2, script: secret });
  assert.match(message, /needs the Replay permission/);
  assert.equal(message.includes('SECRET-SCRIPT-BODY'), false);
  const bad = setup(replayRoutes(reply('', { status: 400 })));
  assert.match(await bad.refused('replay', { server: await bad.add(), path: 'loads', number: 2, script: secret }), /did not accept that replay/);
});

test('a build is restarted from a stage Jenkins offers, and from no other', { skip }, async () => {
  const restart = ({ init }) => { void init; return reply('', { status: 302 }); };
  const { fake, call, refused, add } = setup({
    'GET /job/fail-sh/1/api/json': reply({ actions: [{}, { restartEnabled: true, restartableStages: ['Build', 'Test'] }] }),
    'GET /job/fail-sh/api/json': reply({ nextBuildNumber: 2 }),
    'POST /job/fail-sh/1/restart/restart': restart,
    'GET /job/free/1/api/json': reply({ actions: [{ _class: 'hudson.model.CauseAction' }] }),
    'GET /job/off/1/api/json': reply({ actions: [{ restartEnabled: false, restartableStages: [] }] }),
  });
  const server = await add();
  const r = await call('restartFromStage', { server, path: 'fail-sh', number: 1, stage: 'Test' });
  assert.deepEqual([r.ok, r.expectedNumber], [true, 2]);
  assert.equal(JSON.parse(new URLSearchParams(fake.calls.find((c) => c.key === 'POST /job/fail-sh/1/restart/restart').body).get('json')).stageName, 'Test');
  assert.match(await refused('restartFromStage', { server, path: 'fail-sh', number: 1, stage: 'Deploy' }), /can restart that build from "Build", "Test", not from "Deploy"/);
  assert.match(await refused('restartFromStage', { server, path: 'free', number: 1, stage: 'x' }), /Declarative Pipeline/);
  assert.match(await refused('restartFromStage', { server, path: 'off', number: 1, stage: 'x' }), /Declarative Pipeline/);
  assert.match(await refused('restartFromStage', { server, path: 'fail-sh', number: 1, stage: '' }), /stage is missing/);
  assert.equal(fake.count(/restart\/restart/), 1, 'nothing was posted for the ones that were refused');
});

// --- what the archive remembers ----------------------------------------------------------------------

const CERT = (date) => `Started by user ana\n[Pipeline] sh\n+ ./deploy.sh\nconnecting to /var/run/deploy-${date.length}/sock\nERROR: certificate has expired (notAfter=${date})\nERROR: script returned exit code 1\nFinished: FAILURE\n`;

test('what the archive kept is searchable by any part of a word, case does not matter, and a quote cannot break it', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  keep(service, server, 'team/deploy', 1, 'failed', CERT('2026-10-01'));
  keep(service, server, 'team/web', 2, 'success', 'Started\nAll good\nDeployed to "staging" (quote) with \\ backslash\n');
  const found = await call('searchArchive', { server, q: 'CERTIFICATE has exp' });
  assert.equal(found.mode, 'fts');
  assert.deepEqual(found.hits.map((h) => [h.kind, h.path, h.number, h.status]), [['log', 'team/deploy', 1, 'failed']]);
  assert.equal(found.hits[0].snippet, 'ERROR: certificate has expired (notAfter=2026-10-01)');
  assert.equal(found.hits[0].line, 5, 'a console kept whole has its own line numbers');
  assert.deepEqual(found.indexed, { builds: 2, of: 2, pending: 0 });
  // Characters that mean something to a search are text here.
  for (const q of ['"staging" (quote)', 'with \\ back', '""', 'AND OR NOT', 'NEAR(', 'staging*', "it's", 'a"b"c', '-- ;']) {
    const r = await call('searchArchive', { server, q });
    assert.ok(Array.isArray(r.hits), q);
  }
  assert.equal((await call('searchArchive', { server, q: '"staging" (quote)' })).hits.length, 1);
  assert.equal((await call('searchArchive', { server, q: 'zzz-nothing-like-this' })).hits.length, 0);
});

test('every word of the question has to be there; a question of only short words is answered by scanning, and the answer says so', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  keep(service, server, 'a', 1, 'failed', 'alpha beta gamma\nERROR: disk full\n');
  keep(service, server, 'a', 2, 'failed', 'alpha only\nERROR: out of memory\n');
  assert.deepEqual((await call('searchArchive', { server, q: 'alpha gamma' })).hits.map((h) => h.number), [1]);
  assert.deepEqual((await call('searchArchive', { server, q: 'alpha delta' })).hits, []);
  const short = await call('searchArchive', { server, q: 'ok' });
  assert.equal(short.mode, 'scan');
  const scan = await call('searchArchive', { server, q: 'of memory' });
  assert.equal(scan.mode, 'fts', 'the long word is found by the index, and the short one has only to be in what it found');
  assert.deepEqual(scan.hits.map((h) => h.number), [2]);
  assert.deepEqual((await call('searchArchive', { server, q: 'of nothing' })).hits, []);
  assert.equal(scan.hits[0].snippet, 'ERROR: out of memory', 'the line with the whole of what was asked, not just the first word');
});

test('results come newest first, a page at a time, from where the last one left off, and can be limited to a job or a server', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  for (let n = 1; n <= 7; n += 1) keep(service, server, n <= 4 ? 'team/a' : 'other/b', n, 'failed', `ERROR: needle number ${n}\n`);
  const seen = [];
  let before = null;
  for (let page = 0; page < 10; page += 1) {
    const r = await call('searchArchive', { server, q: 'needle number', limit: 3, ...(before ? { before } : {}) });
    seen.push(...r.hits.map((h) => h.number));
    assert.equal(r.total, 7);
    before = r.nextBefore;
    if (!before) break;
  }
  assert.deepEqual(seen, [7, 6, 5, 4, 3, 2, 1], 'no hit twice, none missed');
  assert.deepEqual((await call('searchArchive', { server, q: 'needle', path: 'team' })).hits.map((h) => h.number), [4, 3, 2, 1], 'a folder');
  assert.deepEqual((await call('searchArchive', { server, q: 'needle', path: 'team/a' })).hits.length, 4);
  assert.deepEqual((await call('searchArchive', { server, q: 'needle', path: 'tea' })).hits, [], 'a prefix of a name is not a folder');
  assert.equal((await call('searchArchive', { server, q: 'needle', limit: 1000 })).hits.length, 7);
  assert.deepEqual((await call('searchArchive', { q: 'needle', limit: 2 })).hits.length, 2, 'every server when none is named');
});

test('a search asks for what it needs: two characters, nothing hostile, a place in the results that is a place', { skip }, async () => {
  const { refused, add } = setup();
  const server = await add();
  assert.match(await refused('searchArchive', { server, q: 'a' }), /at least two/);
  assert.match(await refused('searchArchive', { server, q: '' }), /at least two/);
  assert.match(await refused('searchArchive', { server, q: 'x'.repeat(201) }), /too long/);
  assert.match(await refused('searchArchive', { server, q: 'ok', before: '1; DROP TABLE jx_doc' }), /not a place/);
  assert.match(await refused('searchArchive', { server: 'nope', q: 'ok' }), /not set up/);
  assert.match(await refused('searchArchive', { server, q: 'ok', path: 'a\u0000b' }), /not a name/);
});

test('without trigram search the same question is answered by scanning, and says so', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  service.extras.fts = false;
  keep(service, server, 'a', 1, 'failed', 'ERROR: certificate has expired\n');
  const r = await call('searchArchive', { server, q: 'certificate' });
  assert.equal(r.mode, 'scan');
  assert.equal(r.hits.length, 1);
});

test('a note is written once and found by search, and survives the console it was about', { skip }, async () => {
  const { call, service, add, refused } = setup();
  const server = await add();
  keep(service, server, 'team/deploy', 4, 'failed', CERT('2026-10-01'));
  const note = await call('noteSet', { server, path: 'team/deploy', number: 4, text: 'failed because the cert expired — rotated it on the 2nd' });
  assert.equal(note.note.number, 4);
  await call('noteSet', { server, path: 'team/deploy', text: 'the deploy job is flaky on Mondays' });
  assert.deepEqual((await call('notes', { server, path: 'team/deploy', number: 4 })).notes.map((n) => n.number), [4, 0], 'the build\'s and the job\'s');
  assert.equal((await call('notes', { server, path: 'team/deploy' })).notes.length, 2);
  assert.deepEqual((await call('searchArchive', { server, q: 'rotated it' })).hits.map((h) => [h.kind, h.number]), [['note', 4]]);
  // Said again, it is replaced, not added.
  await call('noteSet', { server, path: 'team/deploy', number: 4, text: 'rotated the certificate' });
  assert.equal((await call('notes', { server, path: 'team/deploy', number: 4 })).notes[0].text, 'rotated the certificate');
  assert.equal((await call('searchArchive', { server, q: 'rotated it' })).hits.length, 0, 'the old words are no longer found');
  // The console goes (evicted, or forgotten as a build) and the note stays.
  service.archive.forget(server, { path: 'team/deploy', number: 4 });
  await service.extras.maintain();
  assert.equal((await call('notes', { server, path: 'team/deploy', number: 4 })).notes.length, 2);
  assert.equal((await call('searchArchive', { server, q: 'rotated the certificate' })).hits.length, 1);
  assert.deepEqual(await call('noteDelete', { server, path: 'team/deploy', number: 4 }), { ok: true, removed: 1 });
  assert.equal((await call('searchArchive', { server, q: 'rotated the certificate' })).hits.length, 0);
  // Asked sensibly.
  assert.match(await refused('noteSet', { server, path: 'x', number: 1, text: '   ' }), /note is missing/);
  assert.match(await refused('noteSet', { server, path: 'x', number: 1, text: 'n'.repeat(2001) }), /longer than 2000/);
  assert.match(await refused('noteSet', { server, path: 'x', number: -3, text: 'n' }), /build number/);
  const control = await call('noteSet', { server, path: 'x', number: 1, text: 'a\u0000b\u0007c\td\ne' });
  assert.equal(control.note.text, 'abc\td\ne', 'a tab and a line break are text; the rest is not');
});

test('forgetting a build, a job or a server takes its notes, signatures, failing steps and index with it', { skip }, async () => {
  const { call, service, add } = setup(shRoutes());
  const server = await add();
  keep(service, server, 'team/deploy', 1, 'failed', CERT('2026-10-01'));
  keep(service, server, 'team/deploy', 2, 'failed', CERT('2026-11-01'));
  keep(service, server, 'team/web', 1, 'failed', CERT('2026-12-01'));
  await call('noteSet', { server, path: 'team/deploy', number: 1, text: 'note on one' });
  await call('noteSet', { server, path: 'team/web', number: 1, text: 'note on web' });
  await call('presetSave', { server, path: 'team/deploy', name: 'p', values: { A: '1' } });
  await call('failingStep', { server, path: 'fail-sh', number: 1 });
  await call('seenBefore', { server, path: 'team/deploy', number: 1 });
  const count = (table) => service.extras.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  assert.deepEqual([count('jx_note'), count('jx_sig'), count('jx_step'), count('jx_doc')], [2, 3, 1, 5]);

  await call('forget', { server, path: 'team/deploy', number: 1 });
  await service.extras.purge({ budgetMs: 5000 });
  assert.deepEqual([count('jx_note'), count('jx_sig'), count('jx_doc')], [1, 2, 3], 'one build');
  await call('forget', { server, path: 'team/deploy' });
  await service.extras.purge({ budgetMs: 5000 });
  assert.deepEqual([count('jx_sig'), count('jx_preset')], [1, 0], 'one job, its parameter sets too');
  await call('forget', { server });
  await service.extras.purge({ budgetMs: 5000 });
  assert.deepEqual([count('jx_note'), count('jx_sig'), count('jx_step'), count('jx_doc'), count('jx_indexed')], [0, 0, 0, 0, 0], 'a whole server');
  assert.deepEqual((await call('searchArchive', { server, q: 'certificate' })).hits, []);
});

test('deleting a server deletes what was kept about it', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  keep(service, server, 'a', 1, 'failed', CERT('2026-10-01'));
  await call('noteSet', { server, path: 'a', number: 1, text: 'hello there' });
  await call('deleteServer', { id: server });
  await service.extras.purge({ budgetMs: 5000 });
  assert.equal(service.extras.db.prepare('SELECT count(*) AS n FROM jx_note').get().n, 0);
  assert.equal(service.extras.db.prepare('SELECT count(*) AS n FROM jx_doc').get().n, 0);
});

test('the index does not outlive the console it was made from, and a console kept again is indexed again', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  keep(service, server, 'a', 1, 'failed', 'ERROR: first version of the story\n', 1_000);
  assert.equal((await call('searchArchive', { server, q: 'first version' })).hits.length, 1);
  service.archive.forget(server, { path: 'a', number: 1 });
  await service.extras.maintain();
  assert.equal((await call('searchArchive', { server, q: 'first version' })).hits.length, 0, 'evicted');
  keep(service, server, 'a', 1, 'failed', 'ERROR: second version of the story\n', 2_000);
  assert.equal((await call('searchArchive', { server, q: 'second version' })).hits.length, 1, 'kept again');
  assert.equal((await call('searchArchive', { server, q: 'first version' })).hits.length, 0);
});

test('"seen before" shows the matching line of each build, who it was, and what fixed it last time', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  keep(service, server, 'team/deploy', 10, 'failed', CERT('2026-09-01'));
  keep(service, server, 'team/deploy', 11, 'success', 'Started\nAll good\n');
  keep(service, server, 'team/web', 3, 'failed', CERT('2026-09-15'));
  keep(service, server, 'team/deploy', 12, 'failed', CERT('2026-10-01'));
  keep(service, server, 'team/deploy', 13, 'failed', 'ERROR: something else entirely\n');
  await call('noteSet', { server, path: 'team/deploy', number: 11, text: 'rotated the certificate' });
  const seen = await call('seenBefore', { server, path: 'team/deploy', number: 12 });
  assert.equal(seen.found, true);
  assert.equal(seen.text, 'ERROR: certificate has expired (notAfter=2026-10-01)', 'this build\'s own line');
  assert.equal(seen.count, 3);
  assert.equal(seen.sameJob, 2);
  assert.deepEqual(seen.occurrences.map((o) => [o.path, o.number, o.text]), [
    ['team/deploy', 10, 'ERROR: certificate has expired (notAfter=2026-09-01)'],
    ['team/web', 3, 'ERROR: certificate has expired (notAfter=2026-09-15)'],
  ], 'newest first (by when the build ran), each with its own line');
  assert.deepEqual([seen.fixedBy.path, seen.fixedBy.number, seen.fixedBy.note], ['team/deploy', 11, 'rotated the certificate']);
  assert.ok(seen.firstSeen <= seen.lastSeen);
  const other = await call('seenBefore', { server, path: 'team/deploy', number: 13 });
  assert.equal(other.count, 1);
  assert.deepEqual(other.occurrences, []);
  assert.equal(other.fixedBy, null);
});

test('"seen before" says why there is nothing to compare rather than inventing something', { skip }, async () => {
  const { call, service, add } = setup({
    'GET /job/live/1/api/json': reply({ building: false, result: 'FAILURE', timestamp: 5 }),
    'GET /job/live/1/logText/progressiveText': consoleRoute('Started\nERROR: freshly broken thing\nFinished: FAILURE\n'),
    'GET /job/run/1/api/json': reply({ building: true }),
    'GET /job/quiet/1/api/json': reply({ building: false, result: 'FAILURE', timestamp: 5 }),
    'GET /job/quiet/1/logText/progressiveText': consoleRoute('Started\nnothing wrong said\n'),
  });
  const server = await add();
  keep(service, server, 'ok', 1, 'success', 'fine\n');
  keep(service, server, 'aborted', 1, 'aborted', 'ERROR: stopped by a person\n');
  assert.deepEqual(await call('seenBefore', { server, path: 'ok', number: 1 }), { found: false, reason: 'not-failed' });
  assert.deepEqual(await call('seenBefore', { server, path: 'aborted', number: 1 }), { found: false, reason: 'not-failed' });
  assert.deepEqual(await call('seenBefore', { server, path: 'run', number: 1 }), { found: false, reason: 'running' });
  assert.deepEqual(await call('seenBefore', { server, path: 'quiet', number: 1 }), { found: false, reason: 'no-error-found' });
  // A build that is not archived is read from Jenkins, and what is learned is kept.
  const live = await call('seenBefore', { server, path: 'live', number: 1 });
  assert.equal(live.found, true);
  assert.equal(live.text, 'ERROR: freshly broken thing');
  assert.equal(live.count, 1);
});

// --- links ----------------------------------------------------------------------------------------

test('a link is built from the server\'s own address and a job\'s own name, never from anything else', { skip }, async () => {
  const opened = [];
  const { call, refused, add } = setup({}, { openExternal: (url) => opened.push(url) });
  const server = await add();
  const url = async (args) => (await call('link', { server, ...args })).url;
  assert.equal(await url({}), 'https://ci.test/');
  assert.equal(await url({ path: 'team/deploy' }), 'https://ci.test/job/team/job/deploy/');
  assert.equal(await url({ path: 'team/deploy', number: 7 }), 'https://ci.test/job/team/job/deploy/7/');
  assert.equal(await url({ path: 'team/deploy', number: 7, part: 'console' }), 'https://ci.test/job/team/job/deploy/7/console');
  assert.equal(await url({ path: 'team/deploy', number: 7, part: 'stages' }), 'https://ci.test/job/team/job/deploy/7/flowGraphTable/');
  assert.equal(await url({ path: 'team/deploy', number: 7, part: 'input' }), 'https://ci.test/job/team/job/deploy/7/input/');
  assert.equal(await url({ path: 'team/deploy', number: 7, part: 'replay' }), 'https://ci.test/job/team/job/deploy/7/replay/');
  assert.equal(await url({ part: 'queue' }), 'https://ci.test/');
  assert.equal(await url({ part: 'agents' }), 'https://ci.test/computer/');
  assert.equal(await url({ path: 'a b/ü%2Fx' }), 'https://ci.test/job/a%20b/job/%C3%BC%252Fx/', 'a branch name Jenkins already spells with %2F stays that one name');
  assert.match(await refused('link', { server, number: 4 }), /which job/);
  assert.match(await refused('link', { server, part: 'console' }), /needs a build/);
  assert.match(await refused('link', { server, path: 'x', part: 'console' }), /needs a build/);
  assert.match(await refused('link', { server, path: 'x', part: 'nonsense' }), /no "nonsense" page/);
  assert.match(await refused('link', { server, path: 'x', number: 1, part: 'pipeline-graph' }), /Pipeline Graph View/);
  assert.match(await refused('link', { server, path: '../admin' }), /not a name Jenkins could have/);
  assert.match(await refused('link', { server, path: 'a/../b' }), /not a name Jenkins could have/);
  assert.match(await refused('link', { server, path: '///' }), /job is missing/);
  assert.match(await refused('link', { server: 'nope' }), /not set up/);
  // Opened, only after the same checks.
  assert.deepEqual(await call('openInBrowser', { server, path: 'team/deploy', number: 7 }), { ok: true, url: 'https://ci.test/job/team/job/deploy/7/' });
  assert.deepEqual(opened, ['https://ci.test/job/team/job/deploy/7/']);
  assert.match(await refused('openInBrowser', { server, path: '../x' }), /not a name/);
  assert.equal(opened.length, 1);
});

test('without a way to open a browser, opening one says so', { skip }, async () => {
  const { refused, add } = setup();
  assert.match(await refused('openInBrowser', { server: await add(), path: 'x' }), /not available here/);
});

test('whatever a job is called, its link stays under the server\'s own address and one job path', { skip }, async () => {
  const { call, add } = setup();
  const server = await add();
  let seed = 12345;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const alphabet = ['a', 'B', '7', ' ', '/', '.', '..', '%', '%2e', '%2F', '\\', '?', '#', '@', ':', '\n', '\u0000', 'é', '<', '"', '-', '_'];
  let ok = 0;
  for (let i = 0; i < 3000; i += 1) {
    const path = Array.from({ length: 1 + (next() % 5) }, () => Array.from({ length: next() % 4 }, () => alphabet[next() % alphabet.length]).join('')).join(next() % 2 ? '/' : '');
    const r = await call('link', { server, path }).catch((e) => ({ error: e.message }));
    if (r.error) continue;
    ok += 1;
    const url = new URL(r.url);
    assert.equal(url.origin, 'https://ci.test', path);
    assert.equal(url.search, '', path);
    assert.equal(url.hash, '', path);
    if (path === '') { assert.equal(url.pathname, '/', 'no job at all is the home page'); continue; }
    assert.match(url.pathname, /^\/job\/[^/]+(\/job\/[^/]+)*\/$/, `${JSON.stringify(path)} → ${url.pathname}`);
    assert.equal(url.pathname.split('/').includes('..'), false);
  }
  assert.ok(ok > 100, 'and plenty of them were names');
});

// --- parameter sets ---------------------------------------------------------------------------------

test('a parameter set is kept for a job, without its passwords — the job\'s own and the ones that are named like one', { skip }, async () => {
  const { call, refused, add } = setup({
    'GET /job/deploy/api/json': reply({
      _class: 'hudson.model.FreeStyleProject', name: 'deploy', fullName: 'deploy', color: 'blue', buildable: true,
      property: [{ parameterDefinitions: [
        { name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['staging', 'production'], defaultParameterValue: { value: 'staging' } },
        { name: 'REGISTRY_LOGIN', type: 'PasswordParameterDefinition', defaultParameterValue: { value: 'x' } },
      ] }], builds: [],
    }),
  });
  const server = await add();
  const saved = await call('presetSave', { server, path: 'deploy', name: 'staging hotfix', values: { ENV: 'staging', DRY: true, COUNT: 3, REGISTRY_LOGIN: 'p', API_TOKEN: 't' } });
  assert.deepEqual(saved.preset.values, { ENV: 'staging', DRY: 'true', COUNT: '3' });
  assert.deepEqual(saved.dropped.sort(), ['API_TOKEN', 'REGISTRY_LOGIN']);
  assert.equal(JSON.stringify(await call('presets', { server, path: 'deploy' })).includes('"t"'), false);
  // Saved again under the same name it is replaced.
  await call('presetSave', { server, path: 'deploy', name: 'staging hotfix', values: { ENV: 'production' } });
  assert.deepEqual((await call('presets', { server, path: 'deploy' })).presets.map((p) => [p.name, p.values]), [['staging hotfix', { ENV: 'production' }]]);
  assert.match(await refused('presetSave', { server, path: 'deploy', name: 'x', values: { A: { b: 1 } } }), /has to be text, a number or true\/false/);
  assert.match(await refused('presetSave', { server, path: 'deploy', name: 'x', values: { A: 'v'.repeat(4001) } }), /too long/);
  assert.match(await refused('presetSave', { server, path: 'deploy', name: '', values: {} }), /name is missing/);
  assert.match(await refused('presetSave', { server, path: 'deploy', name: 'x', values: [] }), /values are missing/);
  assert.match(await refused('presetSave', { server, path: 'deploy', name: 'x', values: { 'a\u0000b': '1' } }), /name that Jenkins could not have/);
  assert.match(await refused('presetSave', { server, path: 'deploy', name: 'x', values: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`P${i}`, '1'])) }), /at most 100/);
  assert.deepEqual(await call('presetDelete', { server, path: 'deploy', name: 'staging hotfix' }), { ok: true, removed: 1 });
  assert.deepEqual(await call('presetDelete', { server, path: 'deploy', name: 'staging hotfix' }), { ok: true, removed: 0 });
});

test('a job keeps twenty parameter sets, and replacing one is not adding one', { skip }, async () => {
  const { call, refused, add } = setup({ 'GET /job/deploy/api/json': reply({ name: 'deploy', fullName: 'deploy', color: 'blue', buildable: true, builds: [] }) });
  const server = await add();
  for (let i = 0; i < 20; i += 1) await call('presetSave', { server, path: 'deploy', name: `set ${i}`, values: { A: String(i) } });
  assert.match(await refused('presetSave', { server, path: 'deploy', name: 'one too many', values: {} }), /at most 20/);
  await call('presetSave', { server, path: 'deploy', name: 'set 3', values: { A: 'changed' } });
  assert.equal((await call('presets', { server, path: 'deploy' })).presets.length, 20);
  // Another job has its own.
  await call('presetSave', { server, path: 'other', name: 'one', values: {} });
});

test('when the job cannot be read the names still decide what is a secret', { skip }, async () => {
  const { call, add } = setup();
  const r = await call('presetSave', { server: await add(), path: 'deploy', name: 'x', values: { ENV: 'a', DB_PASSWORD: 'p' } });
  assert.deepEqual([r.preset.values, r.dropped], [{ ENV: 'a' }, ['DB_PASSWORD']]);
});

// --- all of it, together --------------------------------------------------------------------------------

test('every one of these is a verb of the service and nothing else is reachable by their names', { skip }, async () => {
  const { service } = setup();
  const names = ['failingStep', 'whyNotRunning', 'lint', 'replayScript', 'searchArchive', 'seenBefore', 'notes', 'link', 'presets', 'replay', 'restartFromStage', 'noteSet', 'noteDelete', 'openInBrowser', 'presetSave', 'presetDelete'];
  for (const name of names) assert.equal(typeof service.verbs[name], 'function', name);
  for (const bad of ['constructor', '__proto__', 'verbs', 'stop', 'forget', 'indexSome', 'maintain', 'step']) {
    assert.equal((await service.call(bad, {})).ok, false, bad);
  }
});

test('hostile arguments get an answer and never a crash, a stack or a token', { skip }, async () => {
  const { service, add } = setup(shRoutes());
  const server = await add();
  const weird = [undefined, null, 0, -1, 1e21, NaN, '', ' ', 'x'.repeat(5000), '\u0000', '../..', { __proto__: { x: 1 } }, [], [1, 2], { a: { b: { c: 1 } } }, true, '1;DROP TABLE jx_doc', '%00', '\n'];
  const names = ['failingStep', 'whyNotRunning', 'lint', 'replayScript', 'searchArchive', 'seenBefore', 'notes', 'link', 'presets', 'replay', 'restartFromStage', 'noteSet', 'noteDelete', 'openInBrowser', 'presetSave', 'presetDelete'];
  for (const name of names) {
    for (const value of weird) {
      const args = { server, path: value, number: value, text: value, q: value, name: value, values: value, script: value, stage: value, part: value, limit: value, before: value };
      const result = await service.call(name, args);
      assert.ok(result && typeof result === 'object', `${name} ${JSON.stringify(value)}`);
      if (result.ok === false) {
        assert.equal(typeof result.error, 'string');
        assert.ok(result.error.length <= 400 && !result.error.includes('\n    at '), `${name}: ${result.error.slice(0, 100)}`);
        assert.equal(result.error.includes('SECRET-TOKEN'), false);
      }
    }
  }
});

test('five hundred consoles are indexed and searched quickly, and the index stays a fraction of their text', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  const filler = (n, seed) => Array.from({ length: n }, (_, i) => `[${seed}] compiling module ${i} of the build with options --release --jobs ${i % 8}`).join('\n');
  for (let n = 1; n <= 500; n += 1) {
    const text = `${filler(200, n)}\n${n % 10 === 0 ? `ERROR: certificate has expired (notAfter=2026-10-${String(n % 28 + 1).padStart(2, '0')})` : 'BUILD OK'}\n${filler(20, n)}`;
    keep(service, server, `team/job-${n % 25}`, n, n % 10 === 0 ? 'failed' : 'success', text, 1_000_000 + n);
  }
  let began = Date.now();
  while ((await service.extras.indexSome({ budgetMs: 1000, max: 100 })) > 0);
  const indexMs = Date.now() - began;
  began = Date.now();
  const hit = await call('searchArchive', { server, q: 'certificate has expired', limit: 50 });
  const searchMs = Date.now() - began;
  assert.equal(hit.total, 50);
  assert.deepEqual(hit.indexed, { builds: 500, of: 500, pending: 0 });
  began = Date.now();
  await call('searchArchive', { server, q: 'zzz not here at all' });
  const missMs = Date.now() - began;
  const text = service.extras.db.prepare('SELECT sum(length(text)) AS n FROM jx_doc').get().n;
  assert.ok(indexMs < 10_000, `indexing took ${indexMs} ms`);
  assert.ok(searchMs < 1000, `search took ${searchMs} ms`);
  assert.ok(missMs < 1000, `a search with no hit took ${missMs} ms`);
  assert.ok(text < 500 * 40_000, `${text} characters indexed`);
  const seen = await call('seenBefore', { server, path: 'team/job-10', number: 10 });
  assert.equal(seen.count, 50);
  if (process.env.JENKINS_EXTRAS_TIMINGS) console.log(`index ${indexMs} ms, search ${searchMs} ms, miss ${missMs} ms, ${text} characters`);
});

// =====================================================================================================
// The independent review (R2): what was quadratic, what blocked, what collided, what was kept in memory.
// =====================================================================================================

const took = async (fn) => { const began = process.hrtime.bigint(); const value = await fn(); return { ms: Number(process.hrtime.bigint() - began) / 1e6, value }; };

/** The longest the event loop was kept from running while `fn` did its work, in ms. */
async function loopGap(fn) {
  let last = process.hrtime.bigint();
  let worst = 0;
  const timer = setInterval(() => { const now = process.hrtime.bigint(); worst = Math.max(worst, Number(now - last) / 1e6); last = now; }, 1);
  try { await fn(); } finally { clearInterval(timer); }
  return worst;
}

test('a Jenkinsfile that is built to make the checker slow is checked in linear time, and one that is too big is refused at the door', { skip }, async () => {
  const { call, refused, add } = setup({ 'POST /pipeline-model-converter/validate': reply('Jenkinsfile successfully validated.\n') });
  const server = await add();
  const hostile = {
    'comment openers': '/* a '.repeat(100_000),
    'blank lines': `${'\n'.repeat(500_000)}x`,
    'spaces': `${' '.repeat(500_000)}x`,
    'line comments': ' //'.repeat(170_000),
    'the word itself': 'pipeline'.repeat(60_000),
    'the word, spaced': '\n\n pipeline   '.repeat(36_000),
    'closed comments': '/**/ pipeline '.repeat(35_000),
  };
  for (const [label, text] of Object.entries(hostile)) {
    assert.ok(text.length <= 512 * 1024, label);
    const { ms } = await took(() => call('lint', { server, text }));
    assert.ok(ms < 200, `${label}: ${ms.toFixed(0)} ms`);
  }
  const big = await took(() => refused('lint', { server, text: '/* a '.repeat(400_000) }));
  assert.match(big.value, /too big/);
  assert.ok(big.ms < 50, `refused in ${big.ms.toFixed(0)} ms`);
  // Comments are still comments, and the word after them still counts.
  assert.equal((await call('lint', { server, text: '/* pipeline { */ node { }' })).reason, 'scripted');
  assert.equal((await call('lint', { server, text: '/* x */\n  pipeline\n{ agent any }' })).valid, true);
});

test('what Jenkins says about a Jenkinsfile is read in linear time, however it is padded', { skip }, async () => {
  const padded = (text) => ({ 'POST /pipeline-model-converter/validate': reply(text) });
  for (const answer of [
    `Errors encountered validating Jenkinsfile:\nWorkflowScript: 1: x${' '.repeat(250_000)}`,
    `WorkflowScript: 1: x @ line 1, column 1.${' '.repeat(250_000)}\n`,
    `${'WorkflowScript: 1: x\n'.repeat(12_000)}`,
    `WorkflowScript: 1: ${'x '.repeat(120_000)}@ line`,
  ]) {
    const { call, add } = setup(padded(answer));
    const { ms, value } = await took(async () => call('lint', { server: await add(), text: 'pipeline { agent any }' }));
    assert.ok(ms < 200, `${answer.slice(0, 40)}… ${ms.toFixed(0)} ms`);
    assert.equal(value.valid, false);
    assert.ok(value.errors.length <= 50 && value.errors.every((e) => e.message.length <= 300));
  }
});

test('a replay form that is built to make the parser slow is read in linear time', { skip }, async () => {
  const MB2 = 2 * 1024 * 1024;
  const hostile = {
    'openers': '<textarea '.repeat(200_000),
    'openers, tagged': '<textarea x>'.repeat(170_000),
    'named, never closed': '<textarea name="_.a">'.repeat(95_000),
    'named, closed': '<textarea name="_.a">x</textarea>'.repeat(60_000),
    'a tag that never ends': `<textarea name="_.mainScript" ${'x '.repeat(900_000)}`,
    'entities': `<textarea name="_.mainScript">${'&amp;#x41;'.repeat(190_000)}</textarea>`,
    'lookalikes': '<textareas name="_.a"></textareas>'.repeat(55_000),
  };
  for (const [label, html] of Object.entries(hostile)) {
    assert.ok(html.length <= MB2 + 100, label);
    const { ms } = await took(async () => scriptsOf(html));
    assert.ok(ms < 200, `${label}: ${ms.toFixed(0)} ms`);
  }
  assert.equal(scriptsOf('<textareas name="_.mainScript">x</textareas>').main, null, 'only a textarea is a textarea');
  assert.equal(scriptsOf('<textarea\n  name="_.mainScript">x</textarea>').main, 'x', 'a tag can span lines');
  assert.equal(scriptsOf('<TEXTAREA name="_.mainScript">x</TEXTAREA>').main, null, 'Jenkins writes it in lower case');
  // And through the verb, from a hostile Jenkins.
  const { call, refused, add } = setup({ 'GET /job/x/1/replay/': reply('<textarea '.repeat(200_000)) });
  const { ms, value } = await took(async () => refused('replayScript', { server: await add(), path: 'x', number: 1 }));
  assert.match(value, /did not show a script/);
  assert.ok(ms < 300, `${ms.toFixed(0)} ms`);
  void call;
});

/** A corpus of consoles in the index, with their archive rows, as large as the test asks. */
function corpus(service, server, { docs, size, failedEvery = 1 }) {
  const words = ['error', 'build', 'compile', 'module', 'timeout', 'connection', 'refused', 'deploy', 'docker', 'pull', 'image', 'kube', 'pod', 'agent', 'stage'];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const line = () => Array.from({ length: 10 }, () => `${words[rnd() % words.length]}${rnd() % 1000}`).join(' ');
  const base = []; let n = 0;
  while (n < size) { const l = line(); base.push(l); n += l.length + 1; }
  const text = base.join('\n');
  for (let i = 0; i < docs; i += 1) {
    keep(service, server, `job${i % 50}`, i + 1, i % failedEvery === 0 ? 'failed' : 'success', 'tiny', 1_000_000 + i);
    service.extras.indexConsole(server, `job${i % 50}`, i + 1, `${text}\nunique${i}`, { status: 'failed', at: 1_000_000 + i });
  }
}

test('a search of a large archive never holds the event loop for long, whatever it asks for', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  service.extras.redact = null;
  corpus(service, server, { docs: 400, size: 100_000 });
  assert.deepEqual((await call('searchArchive', { server, q: 'unique17' })).indexed, { builds: 400, of: 400, pending: 0 });
  for (const q of ['error', 'connection refused', 'unique17', 'zz nothing', 'db', 'ok', 'xx yy']) {
    let result;
    const gap = await loopGap(async () => { result = await call('searchArchive', { server, q, limit: 50 }); });
    assert.ok(gap < 100, `${JSON.stringify(q)}: the loop was held for ${gap.toFixed(0)} ms`);
    assert.ok(result.hits.length >= 0 && result.hits.length <= 50);
  }
  const common = await call('searchArchive', { server, q: 'connection refused', limit: 20 });
  assert.equal(common.hits.length, 20);
  assert.equal(common.truncated, true);
  assert.deepEqual(common.hits.map((h) => h.number), Array.from({ length: 20 }, (_, i) => 400 - i), 'newest first, as before');
  assert.equal((await call('searchArchive', { server, q: 'unique399' })).hits[0].number, 400);
});

test('a search of a huge archive (3000 consoles of 100 KB) holds the loop for under 100 ms', { skip: skip || !process.env.JENKINS_EXTRAS_HEAVY }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  service.extras.redact = null;
  corpus(service, server, { docs: 3000, size: 100_000 });
  for (const q of ['error', 'connection refused', 'unique17', 'zz nothing', 'db']) {
    const began = Date.now();
    const gap = await loopGap(async () => { await call('searchArchive', { server, q }); });
    assert.ok(gap < 100, `${q}: ${gap.toFixed(0)} ms held`);
    if (process.env.JENKINS_EXTRAS_TIMINGS) console.log(`${q}: total ${Date.now() - began} ms, loop held ${gap.toFixed(0)} ms`);
  }
});

test('the search results of a console that is gone are never shown, even before anything has tidied up', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  keep(service, server, 'a', 1, 'failed', 'ERROR: needle in the first console\n', 1_000);
  keep(service, server, 'a', 2, 'failed', 'ERROR: needle in the second console\n', 2_000);
  assert.equal((await call('searchArchive', { server, q: 'needle in' })).hits.length, 2);
  service.archive.forget(server, { path: 'a', number: 1 });
  assert.deepEqual((await call('searchArchive', { server, q: 'needle in' })).hits.map((h) => h.number), [2], 'no tidy-up has run');
  assert.equal((await call('searchArchive', { server, q: 'first console' })).hits.length, 0);
  assert.equal((await call('searchArchive', { server, q: 'ok' })).hits.length, 0, 'nor by a scan');
  service.archive.forget(server);
  assert.deepEqual((await call('searchArchive', { server, q: 'needle in' })).hits, []);
});

test('forgetting a server\'s consoles is done in SQL: no console text is ever read into memory, and the index is left consistent', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  service.extras.redact = null;
  corpus(service, server, { docs: 120, size: 60_000 });
  await call('noteSet', { server, path: 'job1', number: 2, text: 'a note stays out of this' });
  const db = service.extras.db;
  let longest = 0;
  const real = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = real(sql);
    for (const name of ['all', 'get']) {
      const original = statement[name].bind(statement);
      statement[name] = (...args) => {
        const out = original(...args);
        for (const row of Array.isArray(out) ? out : [out]) for (const value of Object.values(row ?? {})) if (typeof value === 'string') longest = Math.max(longest, value.length);
        return out;
      };
    }
    return statement;
  };
  const gap = await loopGap(async () => { service.extras.forget(server); await service.extras.purge({ budgetMs: 10_000 }); });
  db.prepare = real;
  assert.ok(longest < 5000, `a string of ${longest} characters was read into memory`);
  assert.ok(gap < 100, `the loop was held for ${gap.toFixed(0)} ms`);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jx_doc').get().n, 0);
  assert.deepEqual(db.prepare("INSERT INTO jx_fts (jx_fts, rank) VALUES ('integrity-check', 1)").run().changes >= 0, true, 'the index agrees with what it indexes');
  assert.equal(db.prepare("SELECT count(*) AS n FROM jx_fts WHERE jx_fts MATCH 'unique17'").get().n, 0, 'nothing of a forgotten console is findable');
  assert.deepEqual((await call('searchArchive', { server, q: 'connection refused' })).hits, []);
});

test('what is hidden by forgetting is hidden at once, and what the search holds is taken out in the background', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  keep(service, server, 'a', 1, 'failed', 'ERROR: needle one\n');
  keep(service, server, 'b', 1, 'failed', 'ERROR: needle two\n');
  assert.equal((await call('searchArchive', { server, q: 'needle' })).hits.length, 2);
  await call('forget', { server, path: 'a' });
  assert.deepEqual((await call('searchArchive', { server, q: 'needle' })).hits.map((h) => h.path), ['b'], 'at once');
  await service.extras.purge({ budgetMs: 5000 });
  assert.equal(service.extras.db.prepare("SELECT count(*) AS n FROM jx_doc WHERE path = 'a'").get().n, 0, 'and then gone');
  // Eviction of two hundred consoles at once is not tidied a hundred at a time.
  for (let n = 1; n <= 250; n += 1) keep(service, server, 'many', n, 'failed', `ERROR: crowd member ${n}\n`);
  await service.extras.indexSome({ budgetMs: 10_000, max: 300 });
  assert.equal((await call('searchArchive', { server, q: 'crowd member', limit: 100 })).hits.length, 100);
  service.archive.forget(server, { path: 'many' });
  await service.extras.maintain();
  assert.equal((await call('searchArchive', { server, q: 'crowd member' })).hits.length, 0);
  await service.extras.purge({ budgetMs: 5000 });
  assert.equal(service.extras.db.prepare("SELECT count(*) AS n FROM jx_doc WHERE path = 'many'").get().n, 0);
});

// --- what counts as "the same failure" ----------------------------------------------------------------

test('a summary that says nothing failed is not an error, and a real one after it is', () => {
  const benign = [
    'Tests: 0 failed, 12 passed', 'Tests run: 12, Failures: 0, Errors: 0, Skipped: 0', '0 errors, 0 warnings', 'no errors found',
    'errors: 0', 'failed: 0', 'FAILED: 0', 'Failures: 0', '0 failures', 'Found 0 failing tests', 'Completed without errors', 'Build finished with zero failures',
  ];
  for (const line of benign) assert.deepEqual(errorLines(line), [], line);
  const real = ['Tests: 2 failed, 10 passed', 'FAILED: 3', 'ERROR: real problem', '1 error generated.', 'Errors: 1', 'error: cannot find symbol', 'FAILURE: Build failed with an exception.'];
  for (const line of real) assert.equal(errorLines(line).length, 1, line);
  assert.equal(errorLines('Tests: 0 failed, 12 passed\nERROR: real problem')[0].line, 'ERROR: real problem');
  assert.equal(signatureOf('Tests: 0 failed, 12 passed\nBuild succeeded'), null);
  assert.equal(errorWindow('Tests: 0 failed\nall good\n').found, false);
});

test('the same failure is one signature however the ports, processes, pods and line numbers fall; another failure is another', () => {
  const sig = (line) => signatureOf(line)?.sig;
  const same = [
    ['ERROR: Connection refused: db.internal:5432 (pid 4411)', 'ERROR: Connection refused: db.internal:5432 (pid 99812)'],
    ['ERROR: connect to 10.0.0.7:49321 failed: connection refused', 'ERROR: connect to 10.0.0.7:51873 failed: connection refused'],
    ['ERROR: Pod agent-7d9f8c6b5-x2k4p is offline', 'ERROR: Pod agent-6c8e7b5a4-k9m3q is offline'],
    ['ERROR: node agent-x2k4p lost', 'ERROR: node agent-k9m3q lost'],
    ['error: cannot find symbol Foo at /home/jenkins/ws/x/y.java:42', 'error: cannot find symbol Foo at /var/lib/ws/other/y.java:97'],
    ['ERROR: boom at Foo.java:10:5', 'ERROR: boom at Foo.java:99:12'],
    ['ERROR: x failed\nWARN timed out waiting', 'ERROR: x failed'],
    ['ERROR: x failed', 'ERROR: x failed\nERROR: and then something else broke'],
    ['ERROR: certificate has expired (notAfter=2026-10-01T10:00:00Z) after 41s', 'ERROR: certificate has expired (notAfter=2027-01-30T01:02:03Z) after 3s'],
  ];
  for (const [a, b] of same) assert.equal(sig(a), sig(b), `${a} | ${b}`);
  const different = [
    ['ERROR: Connection refused: localhost:5432', 'ERROR: Connection refused: localhost:8080'],
    ['ERROR: test FooServiceTest.shouldCreate failed', 'ERROR: test BarServiceTest.shouldDelete failed'],
    ['ERROR: script returned exit code 3', 'ERROR: script returned exit code 5'],
    ['ERROR: HTTP 502 from the registry', 'ERROR: HTTP 404 from the registry'],
    ['ERROR: out of memory', 'ERROR: out of disk space'],
    ['ERROR: certificate has expired', 'ERROR: certificate is not yet valid'],
    ['FAILED: 3', 'ERROR: 3'],
  ];
  for (const [a, b] of different) assert.notEqual(sig(a), sig(b), `${a} | ${b}`);
  // The evidence is the line as it was; the key is only what stayed.
  const one = signatureOf('x\nERROR: Connection refused: db.internal:5432 (pid 4411)\ny');
  assert.equal(one.text, 'ERROR: Connection refused: db.internal:5432 (pid 4411)');
  assert.match(one.normalized, /db\.internal:5432/);
  assert.match(one.normalized, /pid <n>/);
});

test('a build has one signature, whether it was worked out from the archive or from what Jenkins sends now', { skip }, async () => {
  const filler = 'compiling module of the build with some options\n'.repeat(12_000);
  const log = `Started by user ana\nERROR: early failure at the very beginning (pid 1234)\n${filler}INFO: later\nERROR: a different later failure (pid 5678)\nFinished: FAILURE\n`;
  assert.ok(log.length > 400_000);
  const { call, service, add } = setup({
    'GET /job/live/1/api/json': reply({ building: false, result: 'FAILURE', timestamp: 5 }),
    'GET /job/live/1/logText/progressiveText': consoleRoute(log),
  });
  const server = await add();
  keep(service, server, 'archived', 1, 'failed', log);
  await service.extras.indexSome({ budgetMs: 5000, max: 10 });
  const fromArchive = await call('seenBefore', { server, path: 'archived', number: 1 });
  const fromJenkins = await call('seenBefore', { server, path: 'live', number: 1 });
  assert.equal(fromArchive.signature, fromJenkins.signature);
  assert.equal(fromArchive.text, fromJenkins.text);
});

// --- what is kept out of the index, and out of the answers -------------------------------------------------

const LEAKY = 'Started\n+ docker login -u ana\npassword=hunter2-very-secret\nusing gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789 to clone\nERROR: pull failed for postgres://ana:topsecretpw@db.internal/app\nFinished: FAILURE\n';

test('a secret in a console is not in the index, so it is neither found nor shown by a search', { skip }, async () => {
  const { call, service, add } = setup();
  const server = await add();
  keep(service, server, 'a', 1, 'failed', LEAKY);
  const gone = await call('searchArchive', { server, q: 'hunter2-very-secret' });
  assert.deepEqual(gone.hits, [], 'a search cannot be used to find out a secret');
  assert.deepEqual((await call('searchArchive', { server, q: 'abcdefghijklmnopqrstuvwxyz0123456789' })).hits, []);
  const around = await call('searchArchive', { server, q: 'pull failed for' });
  assert.equal(around.hits.length, 1);
  assert.equal(around.hits[0].snippet.includes('topsecretpw'), false, around.hits[0].snippet);
  assert.match(around.hits[0].snippet, /REDACTED/);
  const seen = await call('seenBefore', { server, path: 'a', number: 1 });
  assert.equal(JSON.stringify(seen).includes('topsecretpw'), false);
  // The words around a secret are still words.
  assert.equal((await call('searchArchive', { server, q: 'docker login' })).hits.length, 1);
});

test('a caller that will pass what it gets to somebody else asks for the redacted view, and a different redactor can be plugged in', { skip }, async () => {
  const leak = { ...shRoutes() };
  leak['GET /job/fail-sh/1/execution/node/13/wfapi/log'] = reply({ text: '+ curl -H "Authorization: Bearer abc123tokenvalue456" https://x\nERROR: 401 password=hunter2-very-secret\n', hasMore: false });
  const { call, add, service } = setup(leak);
  const server = await add();
  const plain = await call('failingStep', { server, path: 'fail-sh', number: 1 });
  assert.match(plain.log.text, /hunter2-very-secret/, 'the person looking at their own build sees it as it was');
  const masked = await call('failingStep', { server, path: 'fail-sh', number: 1, redacted: true });
  assert.equal(JSON.stringify(masked).includes('hunter2-very-secret'), false);
  assert.equal(JSON.stringify(masked).includes('abc123tokenvalue456'), false);
  assert.match(masked.log.text, /REDACTED/);
  // The kept answer is not changed by being asked for masked once.
  assert.match((await call('failingStep', { server, path: 'fail-sh', number: 1 })).log.text, /hunter2-very-secret/);
  service.extras.redact = (text) => text.replaceAll('hunter2', '<<mine>>');
  const mine = await call('failingStep', { server, path: 'fail-sh', number: 1, redacted: true });
  assert.match(mine.log.text, /<<mine>>/);
  // A redactor that throws is not a reason to show the text.
  service.extras.redact = () => { throw new Error('boom'); };
  const refusal = await service.call('failingStep', { server, path: 'fail-sh', number: 1, redacted: true });
  assert.equal(refusal.ok, false);
  assert.equal(JSON.stringify(refusal).includes('hunter2'), false);
});

test('parameter sets keep no value that looks like a secret, and call a name a secret only when one of its words is', { skip }, async () => {
  const { call, add } = setup({ 'GET /job/deploy/api/json': reply({ name: 'deploy', fullName: 'deploy', color: 'blue', buildable: true, builds: [] }) });
  const server = await add();
  const saved = await call('presetSave', {
    server, path: 'deploy', name: 'mixed',
    values: {
      CONN: 'postgres://u:hunter2@db/x', ARGS: '--auth=Bearer abc.def', GH: ['gh','p_abcdefghijklmnopqrstuvwxyz0123456789'].join(''), AWS: ['AK','IAIOSFODNN7EXAMPLE'].join(''),
      BLOB: 'QWxhZGRpbjpvcGVuIHNlc2FtZSBhbmQgc29tZSBtb3JlIHRleHQgdG8gbWFrZSBpdCBsb25n', URL: 'https://example.com/path', ENV: 'staging', VERSION: '1.2.3',
      PWD: 'x', PAT: 'x', AUTH: 'x', CERT: 'x', PRIVATE_KEY_PATH: 'x', apiKey: 'x', DB_PASSWD: 'x', KEYSTORE_ALIAS: 'release', MONKEY: 'banana', SECRET_SANTA: 'x',
    },
  });
  assert.deepEqual(Object.keys(saved.preset.values).sort(), ['ENV', 'KEYSTORE_ALIAS', 'MONKEY', 'URL', 'VERSION']);
  assert.deepEqual(saved.dropped.sort(), ['ARGS', 'AUTH', 'AWS', 'BLOB', 'CERT', 'CONN', 'DB_PASSWD', 'GH', 'PAT', 'PRIVATE_KEY_PATH', 'PWD', 'SECRET_SANTA', 'apiKey']);
});

test('the queue and the agents are asked of Jenkins once for every job asked about within a few seconds', { skip }, async () => {
  const routes = whyRoutes();
  routes['GET /job/deploy2/api/json'] = reply({ buildable: true, color: 'blue', inQueue: false, queueItem: null, lastBuild: { number: 1, building: false } });
  const { fake, call, add } = setup(routes);
  const server = await add();
  await Promise.all([call('whyNotRunning', { server, path: 'deploy' }), call('whyNotRunning', { server, path: 'deploy2' })]);
  assert.equal(fake.count(/\/queue\/api\/json$/), 1);
  assert.equal(fake.count(/\/computer\/api\/json$/), 1);
});
