'use strict';

/**
 * The Jenkins client against a Jenkins that is not there.
 *
 * What is checked is what can go wrong in the middle: a name that turns into a
 * route, a refusal read as an outage, a crumb that goes stale, a console that
 * is asked for twice. Every request the real thing would make is answered here.
 */

const test = require('node:test');
const assert = require('node:assert');

const { JenkinsApi, JenkinsError, segment, jobPath, viewPath, normalizeBase, statusOf, resultStatus } = require('../electron/jenkins-api');

function reply(body, { status = 200, headers = {} } = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => raw.toString(),
    // Bytes, as a real response has them: a body is not always text that survives being text.
    arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length),
  };
}

/** Line ends as Jenkins sends them: CRLF in the body, whatever the file has. */
function crlf(buffer) {
  const out = [];
  for (const byte of buffer) { if (byte === 0x0a) out.push(0x0d); out.push(byte); }
  return Buffer.from(out);
}

/** A fetch that records what it was asked and answers from a table of `METHOD path` → reply. */
function jenkins(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method ?? 'GET'} ${pathname}`;
    calls.push({ key, search, headers: init.headers ?? {}, body: init.body });
    const answer = routes[key] ?? routes[`${key}${search}`];
    if (!answer) return reply('', { status: 404 });
    return typeof answer === 'function' ? answer({ search, init, calls }) : answer;
  };
  return { fetch, calls };
}

const api = (routes, extra = {}) => {
  const fake = jenkins(routes);
  return { client: new JenkinsApi({ base: 'https://ci.example.com', user: 'ana', token: 't0k3n', fetch: fake.fetch, ...extra }), calls: fake.calls };
};

test('a name can only ever be a name', () => {
  assert.equal(segment('backend'), 'backend');
  for (const bad of ['', '  ', '..', '.', 'a/b', 'a\\b', 'x\u0000y', 'x\ny']) {
    assert.throws(() => segment(bad), JenkinsError, JSON.stringify(bad));
  }
  assert.equal(jobPath('team/app/main'), '/job/team/job/app/job/main');
  assert.equal(jobPath(''), '');
  assert.equal(jobPath('/team/app/'), '/job/team/job/app');
  // A branch with a slash in it is a job whose NAME is the text `feature%2Fx` (a name cannot hold a slash): its address is that
  // name encoded like any other, `feature%252Fx`. Verified on a real Jenkins: it answers there, and 404s at `feature%2Fx`.
  assert.equal(jobPath('app/feature%2Fx'), '/job/app/job/feature%252Fx');
  assert.equal(jobPath('app/feature%2fx'), '/job/app/job/feature%252fx');
  // Any other percent is just a character, so an encoded way out of a folder is not one.
  assert.equal(jobPath('app/100%'), '/job/app/job/100%25');
  assert.equal(jobPath('app/%2e%2e'), '/job/app/job/%252e%252e');
  assert.throws(() => jobPath('team/../admin'), JenkinsError);
  assert.equal(viewPath('QA/Smoke'), '/view/QA/view/Smoke');
  assert.equal(viewPath('QA/a%2Fb'), '/view/QA/view/a%252Fb', 'a view is a name like a job is');
  assert.throws(() => viewPath('QA/..'), JenkinsError);
});

test('an address is reduced to where Jenkins is served from', () => {
  assert.equal(normalizeBase('https://ci.example.com/'), 'https://ci.example.com');
  assert.equal(normalizeBase('http://ci.local:8080/jenkins/'), 'http://ci.local:8080/jenkins');
  assert.throws(() => normalizeBase('ci.example.com'), /not an address/);
  assert.throws(() => normalizeBase('ftp://ci'), /http or https/);
  assert.throws(() => normalizeBase('https://ana:secret@ci.example.com'), /own fields/);
});

test('colors and results become the statuses a panel draws', () => {
  assert.deepEqual(statusOf('blue'), { status: 'success', running: false });
  assert.deepEqual(statusOf('red_anime'), { status: 'failed', running: true });
  assert.deepEqual(statusOf('notbuilt'), { status: 'none', running: false });
  assert.deepEqual(statusOf('disabled'), { status: 'disabled', running: false });
  assert.equal(statusOf('blue', true).running, true);
  assert.equal(resultStatus('FAILURE'), 'failed');
  assert.equal(resultStatus(null), null);
});

test('every request carries the credentials, and a refusal is not an outage', async () => {
  const { client, calls } = api({
    'GET /api/json': reply({ jobs: [] }, { headers: { 'x-jenkins': '2.452' } }),
    'GET /me/api/json': reply({ fullName: 'Ana R.' }),
    'GET /job/locked/api/json': reply('', { status: 403 }),
    'GET /job/gone/api/json': reply('', { status: 404 }),
    'GET /job/moved/api/json': reply('', { status: 302, headers: { location: '/login' } }),
    'GET /job/bad/api/json': reply('', { status: 401 }),
    'GET /job/html/api/json': reply('<html>login</html>'),
  });
  const who = await client.ping();
  assert.deepEqual(who, { version: '2.452', user: 'Ana R.', description: '' });
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('ana:t0k3n').toString('base64')}`);

  await assert.rejects(client.job('locked'), (e) => e.status === 403 && /does not allow/.test(e.message));
  await assert.rejects(client.job('gone'), (e) => e.status === 404);
  await assert.rejects(client.job('moved'), (e) => e.status === 401 && /login page/.test(e.message));
  await assert.rejects(client.job('bad'), (e) => e.status === 401 && /user and token/.test(e.message));
  await assert.rejects(client.job('html'), /not like Jenkins does/);
});

test('a server that does not answer is said to be unreachable, not to have refused', async () => {
  const client = new JenkinsApi({
    base: 'https://ci.example.com',
    fetch: async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; },
  });
  await assert.rejects(client.queue(), /Could not reach Jenkins: ECONNREFUSED/);
});

test('a folder is read as rows, with what a table needs and nothing else', async () => {
  const { client, calls } = api({
    'GET /job/team/api/json': reply({
      jobs: [
        { _class: 'com.cloudbees.hudson.plugins.folder.Folder', name: 'app', fullName: 'team/app', color: undefined, jobs: [{ name: 'x' }, { name: 'y' }] },
        {
          _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name: 'main', fullName: 'team/main', color: 'red', description: 'the trunk',
          lastBuild: { number: 12, result: 'FAILURE', building: false, timestamp: 1700000000000, duration: 61000 }, healthReport: [{ score: 40 }],
        },
        { _class: 'hudson.model.FreeStyleProject', name: 'nightly', fullName: 'team/nightly', color: 'blue_anime', lastBuild: { number: 3, result: null, building: true, timestamp: 1700000001000, duration: 0 } },
      ],
    }),
  });
  const rows = await client.children('team');
  assert.match(calls[0].search, /tree=jobs\[/);
  assert.deepEqual(rows.map((r) => [r.kind, r.path, r.status, r.running]), [
    ['folder', 'team/app', 'none', false],
    ['job', 'team/main', 'failed', false],
    ['job', 'team/nightly', 'success', true],
  ]);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[1].last.status, 'failed');
  assert.equal(rows[1].health, 40);
  assert.equal(rows[2].last.status, 'running');
});

test('everything reads two levels a request, and one it may not read does not blank the rest', async () => {
  const job = (name, fullName, extra = {}) => ({ _class: 'hudson.model.FreeStyleProject', name, fullName, color: 'blue', ...extra });
  const folder = (name, fullName, jobs) => ({ _class: 'com.cloudbees.hudson.plugins.folder.Folder', name, fullName, jobs });
  const { client, calls } = api({
    // The root, and what is in each folder under it, in one answer.
    'GET /api/json': reply({ jobs: [
      folder('a', 'a', [job('one', 'a/one'), folder('deep', 'a/deep', [{ name: 'two' }]), folder('locked', 'a/locked', [{ name: 'x' }])]),
      job('top', 'top'),
    ] }),
    // The folders found two levels down are read next.
    'GET /job/a/job/deep/api/json': reply({ jobs: [job('two', 'a/deep/two')] }),
    'GET /job/a/job/locked/api/json': reply('', { status: 403 }),
  });
  const rows = await client.everything('');
  assert.deepEqual(rows.filter((r) => r.kind === 'job').map((r) => r.path).sort(), ['a/deep/two', 'a/one', 'top']);
  assert.deepEqual(rows.filter((r) => r.kind === 'folder').map((r) => r.path).sort(), ['a', 'a/deep', 'a/locked']);
  assert.equal(calls.filter((c) => c.key.startsWith('GET /job')).length, 2, 'the root answered for two levels; only the folders below it were asked for');
  assert.equal(rows.truncated, false);
  const tree = decodeURIComponent(calls[0].search);
  assert.equal((tree.match(/jobs\[/g) ?? []).length, 3, 'one request names three levels of jobs');
  assert.ok(tree.includes('jobs[name]'));
});

test('an index stops at its limit and says so', async () => {
  const jobs = Array.from({ length: 50 }, (_, i) => ({ _class: 'hudson.model.FreeStyleProject', name: `j${i}`, fullName: `j${i}`, color: 'blue' }));
  const { client } = api({ 'GET /api/json': reply({ jobs }) });
  const rows = await client.everything('', { maxRows: 10 });
  assert.equal(rows.length, 10);
  assert.equal(rows.truncated, true);
});

test('a job lists its parameters, and a password never carries its default', async () => {
  const { client } = api({
    'GET /job/deploy/api/json': reply({
      _class: 'hudson.model.FreeStyleProject', name: 'deploy', fullName: 'deploy', color: 'blue', buildable: true,
      property: [{
        parameterDefinitions: [
          { name: 'VERSION', type: 'StringParameterDefinition', defaultParameterValue: { value: '0.8.43' }, description: 'what to ship' },
          { name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['staging', 'production'], defaultParameterValue: { value: 'staging' } },
          { name: 'API_KEY', type: 'PasswordParameterDefinition', defaultParameterValue: { value: 'hunter2' } },
          { name: 'DRY', type: 'BooleanParameterDefinition', defaultParameterValue: { value: true } },
        ],
      }],
      builds: [{ number: 5, result: 'SUCCESS', building: false, timestamp: 1, duration: 2 }, { number: 6, building: true, timestamp: 3, duration: 0 }],
    }),
  });
  const job = await client.job('deploy');
  assert.deepEqual(job.parameters.map((p) => [p.name, p.type, p.default, p.secret]), [
    ['VERSION', 'string', '0.8.43', false],
    ['ENV', 'choice', 'staging', false],
    ['API_KEY', 'password', '', true],
    ['DRY', 'boolean', true, false],
  ]);
  assert.deepEqual(job.parameters[1].choices, ['staging', 'production']);
  assert.deepEqual(job.builds.map((b) => b.status), ['success', 'running']);
});

test('a build: stages when the plugin is there, none when it is not, secrets masked', async () => {
  const body = {
    number: 7, result: 'FAILURE', building: false, timestamp: 10, duration: 5000, estimatedDuration: 4000, displayName: '#7', builtOn: 'linux-3',
    actions: [{ causes: [{ shortDescription: 'Started by user Ana' }] }, { parameters: [{ name: 'VERSION', value: '1' }, { name: 'DEPLOY_TOKEN', value: 's3cret' }, { name: 'API_KEY' }] }, {}],
    changeSets: [{ items: [{ commitId: 'a91c3e2b7d00', msg: 'Round refund amounts\n\nlong body', author: { fullName: 'Ana R.' } }] }],
    artifacts: [{ fileName: 'app.jar', relativePath: 'build/app.jar' }],
  };
  const withStages = api({
    'GET /job/x/7/api/json': reply(body),
    'GET /job/x/7/wfapi/describe': reply({ stages: [{ name: 'Build', status: 'SUCCESS', durationMillis: 1000 }, { name: 'Test', status: 'FAILED', durationMillis: 2000 }, { name: 'Deploy', status: 'NOT_EXECUTED', durationMillis: 0 }] }),
  });
  const build = await withStages.client.build('x', 7);
  assert.equal(build.status, 'failed');
  assert.equal(build.agent, 'linux-3');
  assert.deepEqual(build.causes, ['Started by user Ana']);
  assert.deepEqual(build.changes, [{ id: 'a91c3e2b', message: 'Round refund amounts', author: 'Ana R.' }]);
  assert.deepEqual(build.stages.map((s) => s.status), ['success', 'failed', 'skipped']);
  assert.equal(build.parameters.find((p) => p.name === 'DEPLOY_TOKEN').value, '••••••');
  assert.equal(build.parameters.find((p) => p.name === 'API_KEY').value, '••••••', 'Jenkins sends no value for a password; there is one, and it is hidden');
  assert.equal(build.parameters.find((p) => p.name === 'VERSION').value, '1');

  const plain = api({ 'GET /job/x/7/api/json': reply(body) });
  assert.deepEqual((await plain.client.build('x', 7)).stages, []);

  await assert.rejects(plain.client.build('x', 0), /build number/);
  await assert.rejects(plain.client.build('x', 'latest'), /build number/);
});

test('stages Jenkins skipped after a failure are not reported as failures of their own', async () => {
  const build = { number: 3, result: 'FAILURE', building: false, timestamp: 1, duration: 5 };
  const stages = { stages: [
    { name: 'Build', status: 'SUCCESS' }, { name: 'Test', status: 'FAILED' }, { name: 'Deploy', status: 'FAILED' }, { name: 'Notify', status: 'FAILED' },
  ] };
  const log = 'ok\nStage "Deploy" skipped due to earlier failure(s)\nERROR: boom\n';
  const two = api({
    'GET /job/x/3/api/json': reply(build), 'GET /job/x/3/wfapi/describe': reply(stages),
    'GET /job/x/3/logText/progressiveText': reply(log, { headers: { 'x-text-size': String(log.length) } }),
  });
  assert.deepEqual((await two.client.build('x', 3)).stages.map((s) => [s.name, s.status]), [
    ['Build', 'success'], ['Test', 'failed'], ['Deploy', 'skipped'], ['Notify', 'failed'],
  ]);

  // One failure: nothing to correct, so the console is not even asked for.
  const one = api({
    'GET /job/x/3/api/json': reply(build),
    'GET /job/x/3/wfapi/describe': reply({ stages: [{ name: 'Build', status: 'SUCCESS' }, { name: 'Test', status: 'FAILED' }] }),
  });
  await one.client.build('x', 3);
  assert.equal(one.calls.some((c) => c.key.includes('logText')), false);

  // A build still running has skipped nothing yet.
  const running = api({
    'GET /job/x/3/api/json': reply({ ...build, result: null, building: true }),
    'GET /job/x/3/wfapi/describe': reply(stages),
  });
  await running.client.build('x', 3);
  assert.equal(running.calls.some((c) => c.key.includes('logText')), false);
});

test('the console is read from an offset, and says whether more is coming', async () => {
  const { client, calls } = api({
    'GET /job/x/3/logText/progressiveText': ({ search }) => reply(search.includes('start=0') ? 'line one\n' : 'line two\n', {
      headers: { 'x-text-size': search.includes('start=0') ? '9' : '18', 'x-more-data': search.includes('start=0') ? 'true' : '' },
    }),
  });
  const first = await client.log('x', 3);
  assert.deepEqual(first, { text: 'line one\n', next: 9, more: true });
  const second = await client.log('x', 3, first.next);
  assert.deepEqual(second, { text: 'line two\n', next: 18, more: false });
  assert.match(calls[1].search, /start=9/);
  // A negative or garbled offset is a zero, never a different URL.
  await client.log('x', 3, '9&evil=1');
  assert.match(calls[2].search, /^\?start=0$/);
});

test('the console is cleaned of what is only for Jenkins\' own page, and an annotation cut in two is waited for', async () => {
  const note = '\u001b[8mha:////4FPuXvUOZZUpKahJ+pznEKm\u001b[0m';
  const file = `Started by user ${note}ana\nline two\n${note}done\n`;
  // As a real Jenkins: offsets are the file's, and the body has CRLF where the file has LF.
  const body = (from, to) => crlf(Buffer.from(file).subarray(from, to));
  const cut = file.indexOf('done') - 5;                         // Jenkins had written up to the middle of an annotation
  const { client } = api({
    'GET /job/x/1/logText/progressiveText': ({ search }) => {
      const start = Number(new URLSearchParams(search).get('start'));
      return start < cut
        ? reply(body(start, cut), { headers: { 'x-text-size': String(cut), 'x-more-data': 'true' } })
        : reply(body(start), { headers: { 'x-text-size': String(Buffer.byteLength(file)), 'x-more-data': '' } });
    },
  });
  const stream = client.logStream('x', 1);
  const first = await stream.read();
  assert.equal(first.text, 'Started by user ana\nline two\n', 'no annotation, no carriage return, and nothing half-stripped');
  assert.equal(first.more, true);
  assert.equal(first.next, cut, 'the offset is Jenkins\' own, not shortened by what was held: that is what it asks from next');
  const second = await stream.read();
  assert.equal(second.text, 'done\n', 'what was held came back whole in front of what followed, and was stripped');
  assert.equal(second.more, false);
  assert.equal(second.next, Buffer.byteLength(file));
});

test('a chunk that ends inside a character, between CR and LF, or inside the start of an annotation loses nothing', async () => {
  const file = 'caf\u00e9 \u2713 done\nnext line\n';
  const bytes = Buffer.from(file);
  // Every way of cutting the file in two: whatever the first read ends with, the two together are the file.
  for (let cut = 1; cut < bytes.length; cut += 1) {
    const { client } = api({
      'GET /job/x/1/logText/progressiveText': ({ search }) => {
        const start = Number(new URLSearchParams(search).get('start'));
        const to = start < cut ? cut : bytes.length;
        return reply(crlf(bytes.subarray(start, to)), { headers: { 'x-text-size': String(to), 'x-more-data': to < bytes.length ? 'true' : '' } });
      },
    });
    const stream = client.logStream('x', 1);
    let text = '';
    for (let i = 0; i < 4; i += 1) { const r = await stream.read(); text += r.text; if (!r.more) break; }
    assert.equal(text.includes('\uFFFD'), false, `cut at ${cut}`);
  }
});

test('a 403 with no credentials asks for them rather than saying you are not allowed', async () => {
  const fetch = async () => reply('', { status: 403 });
  await assert.rejects(new JenkinsApi({ base: 'https://ci.example.com', fetch }).queue(), /wants a user and an API token/);
  await assert.rejects(new JenkinsApi({ base: 'https://ci.example.com', user: 'a', token: 'b', fetch }).queue(), /does not allow that/);
});

test('running a job: plain, with parameters, and a parameterized job with none given', async () => {
  const crumbs = { 'GET /crumbIssuer/api/json': reply({ crumbRequestField: 'Jenkins-Crumb', crumb: 'abc' }) };
  const { client, calls } = api({
    ...crumbs,
    'POST /job/plain/build': reply('', { status: 201, headers: { location: 'https://ci.example.com/queue/item/77/' } }),
    'POST /job/deploy/buildWithParameters': reply('', { status: 201, headers: { location: 'https://ci.example.com/queue/item/78/' } }),
  });
  assert.deepEqual(await client.run('plain'), { queued: 77 });
  assert.deepEqual(await client.run('deploy', { VERSION: '1.2', ENV: 'staging' }), { queued: 78 });
  assert.deepEqual(await client.run('deploy', null, true), { queued: 78 });

  const post = calls.filter((c) => c.key.startsWith('POST'));
  assert.equal(post[0].headers['Jenkins-Crumb'], 'abc');
  assert.equal(post[1].body, 'VERSION=1.2&ENV=staging');
  assert.equal(post[1].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(post[2].body, '', 'defaults: the form is empty, not missing');
  // The crumb was asked for once, not once per request.
  assert.equal(calls.filter((c) => c.key === 'GET /crumbIssuer/api/json').length, 1);
  await assert.rejects(client.run('deploy', { 'a/b': '1' }), JenkinsError);
});

test('a stale crumb is replaced once, and a server without crumbs still works', async () => {
  let issued = 0;
  let accepted = 'crumb-2';
  const { client } = api({
    'GET /crumbIssuer/api/json': () => reply({ crumbRequestField: 'Jenkins-Crumb', crumb: `crumb-${++issued}` }),
    'POST /job/x/5/stop': ({ init }) => (init.headers['Jenkins-Crumb'] === accepted ? reply('', { status: 302 }) : reply('', { status: 403 })),
  });
  assert.equal((await client.stop('x', 5)).ok, true);
  assert.equal(issued, 2, 'the first crumb was refused and a second one was asked for');

  const noCrumbs = api({ 'POST /job/x/5/kill': reply('', { status: 200 }) });
  assert.deepEqual(await noCrumbs.client.stop('x', 5, { hard: true }), { ok: true });
});

test('views come back nested however deep, and a view\'s jobs are read from the view', async () => {
  const { client, calls } = api({
    'GET /api/json': reply({
      primaryView: { name: 'All' },
      views: [
        { name: 'All', _class: 'hudson.model.AllView' },
        { name: 'QA', _class: 'hudson.plugins.nested_view.NestedView' },
      ],
    }),
    'GET /view/QA/api/json': reply({ views: [{ name: 'Smoke', _class: 'hudson.model.ListView' }, { name: 'Deep', _class: 'hudson.plugins.nested_view.NestedView' }] }),
    'GET /view/QA/view/Deep/api/json': reply({ views: [{ name: 'Deeper', _class: 'hudson.plugins.nested_view.NestedView' }] }),
    'GET /view/QA/view/Deep/view/Deeper/api/json': reply({ views: [{ name: 'Leaf', _class: 'hudson.model.ListView' }] }),
    'GET /view/QA/view/Smoke/api/json': reply({ jobs: [{ _class: 'hudson.model.FreeStyleProject', name: 'smoke-web', fullName: 'smoke-web', color: 'blue' }] }),
  });
  const { views, primary } = await client.views();
  assert.equal(primary, 'All');
  assert.deepEqual(views.map((v) => [v.path, v.nested]), [['All', false], ['QA', true]]);
  assert.deepEqual(views[1].views.map((v) => v.path), ['QA/Smoke', 'QA/Deep']);
  assert.equal(views[1].views[1].views[0].views[0].path, 'QA/Deep/Deeper/Leaf', 'a fourth level is not cut off');
  const rows = await client.viewJobs('QA/Smoke');
  assert.equal(rows[0].path, 'smoke-web');
  assert.equal(calls.at(-1).key, 'GET /view/QA/view/Smoke/api/json');
});

test('the queue says why, and the agents say how busy they are', async () => {
  const { client } = api({
    'GET /queue/api/json': reply({ items: [{ id: 9, why: 'Waiting for next available executor on arm', inQueueSince: 1000, stuck: true, task: { name: 'it', fullName: 'team/it' } }] }),
    'GET /computer/api/json': reply({
      computer: [
        { displayName: 'built-in', offline: false, numExecutors: 2, assignedLabels: [{ name: 'built-in' }], executors: [{ currentExecutable: { url: 'x' } }, {}], oneOffExecutors: [] },
        { displayName: 'arm-02', offline: true, offlineCauseReason: 'Disconnected', numExecutors: 1, assignedLabels: [{ name: 'arm-02' }, { name: 'arm' }], executors: [], oneOffExecutors: [] },
      ],
    }),
    'POST /queue/cancelItem': reply('', { status: 204 }),
  });
  const [item] = await client.queue();
  assert.deepEqual([item.id, item.path, item.stuck], [9, 'team/it', true]);
  const [builtIn, arm] = await client.agents();
  assert.deepEqual([builtIn.busy, builtIn.executors, builtIn.labels], [1, 2, []]);
  assert.deepEqual([arm.offline, arm.reason, arm.labels], [true, 'Disconnected', ['arm']]);
  assert.deepEqual(await client.cancelQueued(9), { ok: true });
  await assert.rejects(client.cancelQueued('9; drop'), /queue item/);
});

// ──────────────────────────────────────────────────────────────────────────────
// Hardening: what the wire does when the other end is not friendly, or not Node.
// ──────────────────────────────────────────────────────────────────────────────

const { stripNotes, holdBack, LogStream, MAX_JSON } = require('../electron/jenkins-api');

/** A tiny deterministic generator: a property test that fails fails the same way again. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('redirects are never followed, and are read the same whether they arrive as a 3xx or as Electron\'s throw', async () => {
  const seen = [];
  const electron = () => { const e = new TypeError('fetch failed'); e.message = 'Redirect was cancelled'; return e; };
  const make = (answer) => new JenkinsApi({
    base: 'https://ci.example.com', user: 'a', token: 'tok',
    fetch: async (url, init) => { seen.push({ url, redirect: init.redirect }); return typeof answer === 'function' ? answer(url, init) : answer; },
  });

  // A GET that is redirected: Jenkins' login page, or an address that moved. Either way: an error that says so, and one request.
  seen.length = 0;
  await assert.rejects(make(reply('', { status: 302, headers: { location: 'https://ci.example.com/login?from=%2F' } })).queue(), (e) => e.status === 401 && /login page/.test(e.message));
  await assert.rejects(make(reply('', { status: 301, headers: { location: 'https://elsewhere.example.net/jenkins/' } })).queue(), (e) => e.status === 302 && /does not follow redirects/.test(e.message));
  await assert.rejects(make(() => { throw electron(); }).queue(), (e) => e.status === 401 && !/Could not reach/.test(e.message), 'Electron throws; that is a redirect, not an outage');
  assert.deepEqual(seen.map((s) => s.redirect), ['manual', 'manual', 'manual'], 'the setting that keeps a token from being sent on');
  assert.equal(seen.length, 3, 'and nothing was asked of any address the redirect named');

  // A POST that is redirected is Jenkins saying it did it: stop answers with a 302 back to the build.
  await assert.doesNotReject(make(reply('', { status: 302, headers: { location: '/job/x/5/' } })).stop('x', 5));
  await assert.doesNotReject(make(() => { throw electron(); }).stop('x', 5));
  await assert.doesNotReject(make(() => { throw electron(); }).stop('x', 5, { hard: true }));
  assert.deepEqual(await make(() => { throw electron(); }).cancelQueued(3), { ok: true, unconfirmed: true }, 'done, as far as anyone can read — the caller looks');
  await assert.rejects(make(reply('', { status: 302, headers: { location: 'https://ci.example.com/login?from=%2F' } })).stop('x', 5), /did not confirm/);
  await assert.rejects(make(reply('', { status: 302, headers: { location: 'https://elsewhere.example.net/job/x/5/' } })).stop('x', 5), /did not confirm/);
  // A real outage still is one.
  await assert.rejects(make(() => { throw new TypeError('fetch failed'); }).stop('x', 5), /Could not reach Jenkins/);
});

test('the time allowed covers reading the answer, not only the first byte of it', async () => {
  const hangs = (init) => ({
    status: 200, headers: { get: () => null },
    body: { getReader: () => ({ read: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))), cancel: async () => {} }) },
  });
  const client = new JenkinsApi({ base: 'https://ci.example.com', fetch: async (url, init) => hangs(init), timeout: 30 });
  const started = Date.now();
  await assert.rejects(client.queue(), /stopped answering/);
  assert.equal(Date.now() - started < 1000, true);
});

test('an answer is read up to a limit, and the rest is not downloaded', async () => {
  let reads = 0;
  let cancelled = false;
  const chunk = new Uint8Array(4 * 1024 * 1024).fill(32);
  const endless = { status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => { reads += 1; return { done: false, value: chunk }; }, cancel: async () => { cancelled = true; } }) } };
  const client = new JenkinsApi({ base: 'https://ci.example.com', fetch: async () => endless });
  await assert.rejects(client.queue(), /more than 24 MB/);
  assert.equal(cancelled, true, 'the download was stopped');
  assert.equal(reads <= Math.ceil(MAX_JSON / chunk.length) + 1, true, `${reads} chunks read: the limit is a limit`);
  // A console read has its own, and says what to do.
  await assert.rejects(client.logRead('x', 1, 0), /grew by more than 16 MB/);
});

test('annotations are stripped in linear time, whatever the text is made of', () => {
  const OPEN = '\u001b[8mha:';
  const CLOSE = '\u001b[0m';
  assert.equal(stripNotes(`a${OPEN}XYZ${CLOSE}b${OPEN}Q${CLOSE}c`), 'abc');
  assert.equal(stripNotes(`a${OPEN}never closed`), `a${OPEN}never closed`, 'an annotation with no end is left alone, not guessed at');
  assert.equal(stripNotes(`${OPEN}${CLOSE}`), '');
  // The input that made `/ESC\[8mha:[\s\S]*?ESC\[0m/g` quadratic: a great many openers and no closer.
  const hostile = OPEN.repeat(200_000);
  const started = process.hrtime.bigint();
  assert.equal(stripNotes(hostile), hostile);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(ms < 500, true, `took ${ms.toFixed(0)} ms for 2 MB of openers`);
  const noisy = (`x${OPEN}y${CLOSE}`).repeat(100_000);
  const t2 = process.hrtime.bigint();
  assert.equal(stripNotes(noisy).length, 100_000);
  assert.equal(Number(process.hrtime.bigint() - t2) / 1e6 < 500, true);
});

test('a token is not on the client, in its errors, or in what is asked of a server that wants a header', async () => {
  const client = new JenkinsApi({ base: 'https://ci.example.com', user: 'ana', token: 'hunter2-hunter2', fetch: async () => { throw new Error('boom hunter2-hunter2'); } });
  assert.equal(JSON.stringify(client).includes('hunter2'), false, 'nothing on the object can be logged by accident');
  assert.equal(Object.keys(client).some((key) => /token|auth|user/i.test(key)), false);
  assert.equal(require('node:util').inspect(client, { showHidden: true, depth: 4 }).includes('hunter2'), false);
  // A fetch that fails says a code or a short phrase.
  const e = await client.queue().catch((x) => x);
  assert.match(e.message, /^Could not reach Jenkins: /);

  // A crumb header is a header only if it looks like one: a server cannot plant another by naming it.
  const sent = [];
  const evil = new JenkinsApi({
    base: 'https://ci.example.com', token: 't',
    fetch: async (url, init) => {
      sent.push(init.headers);
      if (url.endsWith('/crumbIssuer/api/json')) return reply({ crumbRequestField: 'X-Evil\r\nCookie: stolen', crumb: 'abc' });
      return reply('', { status: 201 });
    },
  });
  await evil.run('x');
  assert.equal(sent.every((h) => !Object.keys(h).some((k) => /evil|cookie/i.test(k))), true);
});

test('a name can never be turned into anything but one name, whatever it is made of', () => {
  const next = random(20261016);
  const alphabet = ['a', 'Z', '0', '.', '..', '/', '\\', '%', '%2F', '%2e', '%2E%2E', '\u0000', '\n', '\r', ' ', '\t', '\u007f', '?', '#', '&', '=', ';', '∕', '／', '‮', 'é', '日本', '😀', ':', '@', '*', "'", '"', '<', '>'];
  let accepted = 0;
  for (let i = 0; i < 20000; i += 1) {
    const parts = Array.from({ length: 1 + Math.floor(next() * 4) }, () => Array.from({ length: Math.floor(next() * 6) }, () => alphabet[Math.floor(next() * alphabet.length)]).join(''));
    const path = parts.join('/');
    let out;
    try { out = jobPath(path); } catch (error) { assert.equal(error instanceof JenkinsError, true, `${JSON.stringify(path)} threw something else`); continue; }
    if (!out) continue;
    accepted += 1;
    // Whatever came in, what comes out is /job/<one piece>/job/<one piece>…: no way out, no second path, no query.
    assert.match(out, /^(\/job\/[^/?#\\\s]+)+$/, JSON.stringify(path));
    for (const piece of out.split('/job/').slice(1)) {
      const decoded = decodeURIComponent(piece.replace(/%2F/g, '\ue000'));
      assert.notEqual(decoded, '.', JSON.stringify(path));
      assert.notEqual(decoded, '..', JSON.stringify(path));
      assert.equal(/[\\/\u0000-\u001f]/.test(decoded), false, JSON.stringify(path));
    }
  }
  assert.equal(accepted > 1000, true, 'the generator did produce names that are fine');
  assert.throws(() => jobPath('a'.repeat(501)), /longer than any Jenkins/);
  assert.throws(() => jobPath(Array(40).fill('a').join('/')), /nested deeper/);
  assert.throws(() => jobPath('a/\u007fb'), JenkinsError);
});

test('a console cut anywhere, with annotations and CRLF and multi-byte text in it, always comes out as the file without them', async () => {
  const next = random(7);
  const NOTE = (i) => `\u001b[8mha:////Ab${'x'.repeat(i % 40)}\u001b[0m`;
  for (let round = 0; round < 60; round += 1) {
    // A file: lines of ASCII and multi-byte text, some with an annotation in front, some with a CR in them.
    const lines = Array.from({ length: 5 + Math.floor(next() * 20) }, (_, i) => {
      const body = ['plain line', 'café ✓ 日本語', 'emoji 😀 here', 'progress 50%\rprogress 100%'][Math.floor(next() * 4)];
      return `${next() < 0.5 ? NOTE(i) : ''}${body} ${i}`;
    });
    const file = Buffer.from(`${lines.join('\n')}\n`);
    const expected = `${lines.map((l) => l.replace(/\u001b\[8mha:[^\u001b]*\u001b\[0m/g, '')).join('\n')}\n`;
    // Cut it at random places: each read ends where Jenkins happened to have got to.
    const cuts = Array.from({ length: 1 + Math.floor(next() * 6) }, () => 1 + Math.floor(next() * (file.length - 1))).sort((a, b) => a - b);
    let served = 0;
    const offsets = [];
    const { client } = api({
      'GET /job/x/1/logText/progressiveText': ({ search }) => {
        const start = Number(new URLSearchParams(search).get('start'));
        offsets.push(start);
        const to = cuts.find((c) => c > start) ?? file.length;
        served = to;
        return reply(crlf(file.subarray(start, to)), { headers: { 'x-text-size': String(to), 'x-more-data': to < file.length ? 'true' : '' } });
      },
    });
    const stream = client.logStream('x', 1);
    let text = '';
    for (let i = 0; i < cuts.length + 2; i += 1) {
      const r = await stream.read();
      text += r.text;
      assert.equal(r.next, served, 'the offset is the file\'s, as Jenkins gave it');
      if (!r.more) break;
    }
    assert.equal(text, expected, `round ${round}, cuts ${cuts}`);
    assert.equal(offsets.every((o, i) => i === 0 || o > offsets[i - 1]), true, 'each read starts after the last: nothing was read twice');
  }
});

test('opening a very long console reads its end and not the whole of it', async () => {
  const total = 3_000_000;
  const line = 'a line of build output of a certain length, for the size of it\n';
  const file = Buffer.from(line.repeat(Math.ceil(total / line.length)));
  let bytesServed = 0;
  const requests = [];
  const { client } = api({
    'GET /job/x/1/logText/progressiveText': ({ search }) => {
      const start = Number(new URLSearchParams(search).get('start'));
      requests.push(start);
      // As a real Jenkins: a negative start is the size and no body; one past the end is the whole console again.
      const from = start < 0 ? file.length : start > file.length ? 0 : start;
      const body = file.subarray(from);
      bytesServed += body.length;
      return reply(body, { headers: { 'x-text-size': String(file.length), 'x-more-data': '' } });
    },
  });
  const chunk = await client.logStream('x', 1, { tailBytes: 400_000 }).read();
  assert.equal(chunk.truncated, true);
  assert.equal(chunk.skipped > 2_000_000, true, 'it says how much of the beginning it did not show');
  assert.equal(bytesServed <= 400_000 + 100, true, `${bytesServed} bytes were downloaded, not ${file.length}`);
  assert.equal(requests[0], -1, 'the size is asked for first, with no body');
  assert.equal(chunk.text.startsWith('a line of build output'), true, 'it begins at the start of a line');
  assert.equal(chunk.text.endsWith('\n'), true);
  // A console that fits is read from its start, whole, in one go.
  const small = api({ 'GET /job/x/1/logText/progressiveText': ({ search }) => reply(Number(new URLSearchParams(search).get('start')) < 0 ? '' : 'hello\n', { headers: { 'x-text-size': '6', 'x-more-data': '' } }) });
  const whole = await small.client.logStream('x', 1, { tailBytes: 400_000 }).read();
  assert.deepEqual([whole.text, whole.truncated, whole.skipped], ['hello\n', false, 0]);
});

test('a console of one enormous line is shown from where it was opened, not thrown away looking for a line to begin at', async () => {
  const file = Buffer.from(`${'x'.repeat(1_000_000)}THE END\n`);
  const { client } = api({
    'GET /job/x/1/logText/progressiveText': ({ search }) => {
      const start = Number(new URLSearchParams(search).get('start'));
      return reply(start < 0 ? '' : file.subarray(start), { headers: { 'x-text-size': String(file.length), 'x-more-data': '' } });
    },
  });
  const chunk = await client.logStream('x', 1, { tailBytes: 100_000 }).read();
  assert.equal(chunk.text.length, 100_000);
  assert.equal(chunk.text.endsWith('THE END\n'), true);
  assert.equal(chunk.truncated, true);
});

test('a number put into an address is a number', async () => {
  const { client, calls } = api({ 'GET /job/x/1/logText/progressiveText': reply('', { headers: { 'x-text-size': '0' } }) });
  for (const start of ['1e21', 1e21, -5, '9&evil=1', NaN, Infinity, '0x10', null, undefined, {}]) await client.logRead('x', 1, start);
  assert.equal(calls.every((c) => /^\?start=\d+$/.test(c.search)), true, calls.map((c) => c.search).join(' '));
  assert.equal(calls[0].search, `?start=${Number.MAX_SAFE_INTEGER}`);
  await assert.rejects(client.cancelQueued('1; DROP'), /queue item/);
  await assert.rejects(client.stop('x', 1e12), /build number/);
});

test('stages: which ran, which were skipped, which ran side by side — with the steps to tell them by', async () => {
  const NOOP = [{ name: 'Get contextual object from internal APIs' }];
  const err = { message: 'boom', type: 'hudson.AbortException' };
  const run = (id, status, stages) => ({ id: String(id), status, startTimeMillis: 1000 * id, durationMillis: 3000, stages });
  const real = [{ name: 'Print Message' }];
  const { client, calls } = api({
    'GET /job/p/api/json': reply({ lastBuild: { number: 6 } }),
    'GET /job/p/wfapi/runs': reply([
      run(6, 'FAILED', [
        { name: 'Checkout', status: 'SUCCESS', startTimeMillis: 1000, durationMillis: 20, stageFlowNodes: real },
        { name: 'Lint', status: 'NOT_EXECUTED', startTimeMillis: 1030, durationMillis: 30, stageFlowNodes: NOOP },
        { name: 'Verify', status: 'SUCCESS', startTimeMillis: 1100, durationMillis: 25, stageFlowNodes: [] },
        { name: 'Unit', status: 'SUCCESS', startTimeMillis: 1125, durationMillis: 1000, stageFlowNodes: real },
        { name: 'Integration', status: 'SUCCESS', startTimeMillis: 1130, durationMillis: 2000, stageFlowNodes: real },
        { name: 'Test', status: 'FAILED', startTimeMillis: 3200, durationMillis: 60, error: err, stageFlowNodes: [{ name: 'Error signal' }] },
        { name: 'Deploy', status: 'FAILED', startTimeMillis: 3300, durationMillis: 20, error: err, stageFlowNodes: NOOP },
      ]),
      run(5, 'SUCCESS', [
        { name: 'Checkout', status: 'SUCCESS', startTimeMillis: 500, durationMillis: 40, stageFlowNodes: real },
        { name: 'Test', status: 'SUCCESS', startTimeMillis: 600, durationMillis: 100, stageFlowNodes: real },
        { name: 'Deploy', status: 'SUCCESS', startTimeMillis: 800, durationMillis: 20, stageFlowNodes: real },
      ]),
      run(4, 'PAUSED_PENDING_INPUT', [
        { name: 'Checkout', status: 'SUCCESS', startTimeMillis: 100, durationMillis: 30, stageFlowNodes: real },
        { name: 'Approve', status: 'PAUSED_PENDING_INPUT', startTimeMillis: 200, durationMillis: 5000, stageFlowNodes: real },
      ]),
    ]),
    'GET /job/p/4/wfapi/pendingInputActions': reply([{ id: 'E0abc', message: 'Deploy to prod?', proceedText: 'Ship it', inputs: [] }]),
  });
  const result = await client.stages('p', 3);
  assert.match(calls[1].search, /^\?fullStages=true&since=%234$/, 'only the runs wanted: since the third newest');
  assert.equal(result.available, true);
  // The newest run's order, and a stage only an older run had put after the stage that came before it there.
  assert.deepEqual(result.names, ['Checkout', 'Approve', 'Lint', 'Verify', 'Unit', 'Integration', 'Test', 'Deploy']);
  const [r6, r5, r4] = result.runs;
  assert.deepEqual([r6.number, r6.status, r6.running], [6, 'failed', false]);
  assert.deepEqual(r6.stages.map((s) => [s.name, s.status, s.executed, s.parallel]), [
    ['Checkout', 'success', true, false],
    ['Lint', 'skipped', false, false],
    ['Verify', 'success', true, false],
    ['Unit', 'success', true, true],
    ['Integration', 'success', true, true],
    ['Test', 'failed', true, false],
    ['Deploy', 'skipped', false, false],
  ]);
  assert.equal(r6.stages[5].error, 'boom');
  assert.equal(r6.stages[6].error, null, 'a skipped stage does not carry the error that skipped it');
  assert.deepEqual([r5.status, r5.running], ['success', false]);
  assert.deepEqual([r4.status, r4.running], ['paused', true]);
  const approve = r4.stages[1];
  assert.deepEqual([approve.paused, approve.status, approve.executed], [true, 'paused', true]);
  assert.deepEqual(approve.input, { message: 'Deploy to prod?', id: 'E0abc', ok: 'Ship it', params: [] });
  assert.deepEqual(r4.input, approve.input);
  assert.equal(r6.input, null);
  // Averages are of stages that ran, passed, in runs that ended: not the failed Test of #6, not the paused one of #4.
  assert.deepEqual(result.averages, { Checkout: 30, Test: 100, Deploy: 20, Unit: 1000, Integration: 2000, Verify: 25 });
  // Nothing in what is sent on is what it was worked out from.
  assert.equal('nodes' in r6.stages[0] || 'key' in r6.stages[0], false);
});

test('stages: without the steps, a failed stage with the failed stage\'s error that began after it ended is skipped — and parallel branches failing together are not', async () => {
  const err = { message: 'boom', type: 'hudson.AbortException' };
  const other = { message: 'different', type: 'hudson.AbortException' };
  const mk = (stages) => api({
    'GET /job/p/api/json': reply({ lastBuild: { number: 1 } }),
    'GET /job/p/wfapi/runs': reply([{ id: '1', status: 'FAILED', startTimeMillis: 1, durationMillis: 100, stages }]),
  }).client.stages('p', 1);

  const sequential = await mk([
    { name: 'Build', status: 'SUCCESS', startTimeMillis: 0, durationMillis: 10 },
    { name: 'Test', status: 'FAILED', startTimeMillis: 10, durationMillis: 50, error: err },
    { name: 'Deploy', status: 'FAILED', startTimeMillis: 62, durationMillis: 20, error: err },
    { name: 'Notify', status: 'FAILED', startTimeMillis: 90, durationMillis: 5, error: other },
  ]);
  assert.deepEqual(sequential.runs[0].stages.map((s) => [s.name, s.status, s.executed]), [
    ['Build', 'success', true], ['Test', 'failed', true], ['Deploy', 'skipped', false], ['Notify', 'failed', true],
  ], 'a different error is a different failure');

  const together = await mk([
    { name: 'Unit', status: 'FAILED', startTimeMillis: 10, durationMillis: 500, error: err },
    { name: 'Integration', status: 'FAILED', startTimeMillis: 12, durationMillis: 600, error: err },
  ]);
  assert.deepEqual(together.runs[0].stages.map((s) => [s.status, s.executed, s.parallel]), [['failed', true, true], ['failed', true, true]], 'two branches that fail at once both failed');

  // Right at the end of the one before is still after it: clocks to the millisecond are not exact.
  const touching = await mk([
    { name: 'Test', status: 'FAILED', startTimeMillis: 10, durationMillis: 50, error: err },
    { name: 'Deploy', status: 'FAILED', startTimeMillis: 57, durationMillis: 20, error: err },
  ]);
  assert.equal(touching.runs[0].stages[1].status, 'skipped');

  // With steps of its own a stage failed whatever its error says.
  const real = await api({
    'GET /job/p/api/json': reply({ lastBuild: { number: 1 } }),
    'GET /job/p/wfapi/runs': reply([{ id: '1', status: 'FAILED', startTimeMillis: 1, durationMillis: 100, stages: [
      { name: 'Test', status: 'FAILED', startTimeMillis: 10, durationMillis: 50, error: err, stageFlowNodes: [{ name: 'Error signal' }] },
      { name: 'Again', status: 'FAILED', startTimeMillis: 70, durationMillis: 20, error: err, stageFlowNodes: [{ name: 'Shell Script' }, { name: 'Error signal' }] },
    ] }]),
  }).client.stages('p', 1);
  assert.deepEqual(real.runs[0].stages.map((s) => s.status), ['failed', 'failed']);
});

test('stages: not a pipeline, or no plugin, is "not available" and not an error; a limit is a limit', async () => {
  const none = { available: false, names: [], runs: [], averages: {} };
  const { client } = api({
    'GET /job/free/api/json': reply({ lastBuild: { number: 4 } }),
    // wfapi/runs is 404 for a job that is not a pipeline.
  });
  assert.deepEqual(await client.stages('free', 10), none);
  assert.deepEqual(await client.stages('missing', 10), none);
  await assert.rejects(api({ 'GET /job/x/api/json': reply('', { status: 403 }) }).client.stages('x'), /does not allow/, 'a refusal is still one');

  const seen = [];
  const fake = api({
    'GET /job/p/wfapi/runs': ({ search }) => { seen.push(search); return reply([]); },
  });
  await fake.client.stages('p', 99, { last: 100 });
  await fake.client.stages('p', 0, { last: 100 });
  await fake.client.stages('p', 'x', { last: 100 });
  await fake.client.stages('p', 10, { last: 3 });
  assert.deepEqual(seen, ['?fullStages=true&since=%2371', '?fullStages=true&since=%23100', '?fullStages=true&since=%2391', '?fullStages=true&since=%231'], 'at most 30, at least 1, 10 when it is not a number, never before the first build');
});

test('what a running build is doing now: its stage, or two side by side, or nothing', async () => {
  const stages = (list) => reply({ stages: list.map(([name, status]) => ({ name, status })) });
  const one = api({ 'GET /job/p/3/wfapi/describe': stages([['Build', 'SUCCESS'], ['Test', 'IN_PROGRESS']]) });
  assert.equal(await one.client.currentStage('p', 3), 'Test');
  const par = api({ 'GET /job/p/3/wfapi/describe': stages([['Unit', 'IN_PROGRESS'], ['Integration', 'IN_PROGRESS']]) });
  assert.equal(await par.client.currentStage('p', 3), 'Unit · Integration');
  const paused = api({ 'GET /job/p/3/wfapi/describe': stages([['Approve', 'PAUSED_PENDING_INPUT']]) });
  assert.equal(await paused.client.currentStage('p', 3), 'Approve');
  assert.equal(await api({ 'GET /job/p/3/wfapi/describe': stages([['Build', 'SUCCESS']]) }).client.currentStage('p', 3), null);
  assert.equal(await api({}).client.currentStage('p', 3), null, 'a job with no plugin has no stage to name');
});

test('input a build is waiting for is read, never answered', async () => {
  const { client, calls } = api({
    'GET /job/p/2/api/json': reply({ number: 2, building: true }),
    'GET /job/p/2/wfapi/describe': reply({ stages: [{ name: 'Approve', status: 'PAUSED_PENDING_INPUT', startTimeMillis: 1, durationMillis: 5 }] }),
    'GET /job/p/2/wfapi/pendingInputActions': reply([{ id: 'E1', message: 'Deploy?', proceedText: 'Go', proceedUrl: '/job/p/2/wfapi/inputSubmit?inputId=E1', abortUrl: '/job/p/2/input/E1/abort' }]),
  });
  const build = await client.build('p', 2);
  assert.deepEqual(build.input, { message: 'Deploy?', id: 'E1', ok: 'Go', params: [] });
  assert.equal(build.stages[0].paused, true);
  assert.equal(calls.every((c) => c.key.startsWith('GET')), true, 'only reads: no URL it was given to answer with was called');
  // Not paused: it is not even asked.
  const idle = api({
    'GET /job/p/2/api/json': reply({ number: 2, building: true }),
    'GET /job/p/2/wfapi/describe': reply({ stages: [{ name: 'Build', status: 'IN_PROGRESS' }] }),
  });
  assert.equal((await idle.client.build('p', 2)).input, null);
  assert.equal(idle.calls.some((c) => c.key.includes('pendingInput')), false);
});



// ──────────────────────────────────────────────────────────────────────────────
// Recorded from a real Jenkins (2.541.3, Pipeline Stage View): what it actually sends.
// ──────────────────────────────────────────────────────────────────────────────

/** The console of a freestyle build, as `progressiveText` sent it: 749 bytes in the file, 758 in the body (CRLF), with annotations. */
const REAL_LOG = Buffer.from('U3RhcnRlZCBieSB1c2VyIBtbOG1oYTovLy8vNEEvYjBacnhtUVJ0ZkxOMjc3WWRSZ29qV0NxK0JRNml6Z2RRMEttQXFmMDNBQUFBbFIrTENBQUFBQUFBQVA5Yjg1YUJ0YmlJUVRHak5LVTRQMDh2T1Qrdk9EOG5WYzgzUHlVMXg2T3lJTFVvSnpNdjJ5Ky9KSlVCQWhpWkdCZ3FpaGhrME5TaktEV3pYYjNSZGxMQlVTWUdKazhHdHB6VXZQU1NEQjhHNXRLaW5CSUdJWitzeExKRS9aekV2SFQ5NEpLaXpMeDBhNkJ4VW1qR09VTm9kSHNMZ0F6bUVnWk8vZExpMUNMOXhMeEVBRUQ3UFJpK0FBQUEbWzBtYW5hDQpSdW5uaW5nIGFzIFNZU1RFTQ0KQnVpbGRpbmcgaW4gd29ya3NwYWNlIC92YXIvamVua2luc19ob21lL3dvcmtzcGFjZS9zbG93DQpbc2xvd10gJCAvYmluL3NoIC14ZSAvdG1wL2plbmtpbnM2ODMyOTg5NDc1NzY5MDcyNDkxLnNoDQorIHNsZWVwIDMwMA0KVGVybWluYXRlZA0KQnVpbGQgd2FzIGFib3J0ZWQNCkFib3J0ZWQgYnkgG1s4bWhhOi8vLy80QS9iMFpyeG1RUnRmTE4yNzdZZFJnb2pXQ3ErQlE2aXpnZFEwS21BcWYwM0FBQUFsUitMQ0FBQUFBQUFBUDliODVhQnRiaUlRVEdqTktVNFAwOHZPVCt2T0Q4blZjODNQeVUxeDZPeUlMVW9Kek12MnkrL0pKVUJBaGlaR0JncWloaGswTlNqS0RXelhiM1JkbExCVVNZR0prOEd0cHpVdlBTU0RCOEc1dEtpbkJJR0laK3N4TEpFL1p6RXZIVDk0Sktpekx4MGE2QnhVbWpHT1VOb2RIc0xnQXptRWdaTy9kTGkxQ0w5eEx4RUFFRDdQUmkrQUFBQRtbMG1hbmENCkZpbmlzaGVkOiBBQk9SVEVEDQo=', 'base64');
/** Two runs of a pipeline with a skipped stage, a parallel, a failing stage and the stage that failed with it, trimmed to what is used. */
const REAL_RUNS = [{"id":"6","status":"FAILED","startTimeMillis":1792163909074,"durationMillis":3492,"stages":[{"name":"Checkout","status":"SUCCESS","startTimeMillis":1792163909196,"durationMillis":22,"stageFlowNodes":[{"name":"Print Message"}]},{"name":"Build","status":"SUCCESS","startTimeMillis":1792163909229,"durationMillis":1025,"stageFlowNodes":[{"name":"Sleep"}]},{"name":"Lint","status":"NOT_EXECUTED","startTimeMillis":1792163910265,"durationMillis":32,"stageFlowNodes":[{"name":"Get contextual object from internal APIs"}]},{"name":"Verify","status":"SUCCESS","startTimeMillis":1792163910308,"durationMillis":26,"stageFlowNodes":[]},{"name":"Unit","status":"SUCCESS","startTimeMillis":1792163910334,"durationMillis":1042,"stageFlowNodes":[{"name":"Sleep"}]},{"name":"Integration","status":"SUCCESS","startTimeMillis":1792163910341,"durationMillis":2041,"stageFlowNodes":[{"name":"Sleep"}]},{"name":"Test","status":"FAILED","startTimeMillis":1792163912428,"durationMillis":66,"error":{"message":"boom","type":"hudson.AbortException"},"stageFlowNodes":[{"name":"Error signal"}]},{"name":"Deploy","status":"FAILED","startTimeMillis":1792163912507,"durationMillis":23,"error":{"message":"boom","type":"hudson.AbortException"},"stageFlowNodes":[{"name":"Get contextual object from internal APIs"}]}]},{"id":"5","status":"SUCCESS","startTimeMillis":1792163894065,"durationMillis":3463,"stages":[{"name":"Checkout","status":"SUCCESS","startTimeMillis":1792163894211,"durationMillis":24,"stageFlowNodes":[{"name":"Print Message"}]},{"name":"Build","status":"SUCCESS","startTimeMillis":1792163894245,"durationMillis":1032,"stageFlowNodes":[{"name":"Sleep"}]},{"name":"Lint","status":"NOT_EXECUTED","startTimeMillis":1792163895288,"durationMillis":39,"stageFlowNodes":[{"name":"Get contextual object from internal APIs"}]},{"name":"Verify","status":"SUCCESS","startTimeMillis":1792163895337,"durationMillis":25,"stageFlowNodes":[]},{"name":"Unit","status":"SUCCESS","startTimeMillis":1792163895362,"durationMillis":1044,"stageFlowNodes":[{"name":"Sleep"}]},{"name":"Integration","status":"SUCCESS","startTimeMillis":1792163895369,"durationMillis":2032,"stageFlowNodes":[{"name":"Sleep"}]},{"name":"Test","status":"SUCCESS","startTimeMillis":1792163897437,"durationMillis":39,"stageFlowNodes":[]},{"name":"Deploy","status":"SUCCESS","startTimeMillis":1792163897485,"durationMillis":22,"stageFlowNodes":[{"name":"Print Message"}]}]}];

test('a real console: annotations and CRLF out, and the offset is the file\'s, not the body\'s', async () => {
  assert.equal(REAL_LOG.length, 758, 'the body is longer than the file: that is the point');
  const { client } = api({
    'GET /job/slow/1/logText/progressiveText': ({ search }) => reply(Number(new URLSearchParams(search).get('start')) < 0 ? '' : REAL_LOG, { headers: { 'x-text-size': '749', 'x-more-data': '' } }),
  });
  const chunk = await client.logStream('slow', 1).read();
  assert.equal(chunk.next, 749);
  assert.equal(chunk.text.includes('\u001b'), false);
  assert.equal(chunk.text.includes('\r'), false);
  assert.match(chunk.text, /^Started by user ana\nRunning as SYSTEM\n/);
  assert.match(chunk.text, /Finished: [A-Z]+\n$/);
  // The same body cut where an annotation is, and read in two: nothing is lost or doubled, and the second offset is still the file's.
  const open = REAL_LOG.indexOf('\u001b[8mha:') + 12;
  const halves = api({
    'GET /job/slow/1/logText/progressiveText': ({ search }) => {
      const start = Number(new URLSearchParams(search).get('start'));
      return start === 0 ? reply(REAL_LOG.subarray(0, open), { headers: { 'x-text-size': String(open), 'x-more-data': 'true' } }) : reply(REAL_LOG.subarray(open), { headers: { 'x-text-size': '749', 'x-more-data': '' } });
    },
  }).client.logStream('slow', 1);
  const a = await halves.read();
  const b = await halves.read();
  assert.equal(a.text + b.text, chunk.text);
});

test('real stages: what Jenkins sent for a pipeline with a skipped stage, a parallel and a failure', async () => {
  const { client } = api({
    'GET /job/stages-demo/api/json': reply({ lastBuild: { number: 6 } }),
    'GET /job/stages-demo/wfapi/runs': reply(REAL_RUNS),
  });
  const { runs, names, averages } = await client.stages('stages-demo', 10);
  assert.deepEqual(names, ['Checkout', 'Build', 'Lint', 'Verify', 'Unit', 'Integration', 'Test', 'Deploy']);
  const failed = runs.find((run) => run.number === 6);
  assert.deepEqual(failed.stages.map((s) => `${s.name}:${s.status}${s.parallel ? ':parallel' : ''}`), [
    'Checkout:success', 'Build:success', 'Lint:skipped', 'Verify:success', 'Unit:success:parallel', 'Integration:success:parallel', 'Test:failed', 'Deploy:skipped',
  ]);
  assert.equal(failed.status, 'failed');
  assert.equal(runs.find((run) => run.number === 5).status, 'success');
  assert.deepEqual(Object.keys(averages).sort(), ['Build', 'Checkout', 'Deploy', 'Integration', 'Test', 'Unit', 'Verify']);
  // Without the steps, the guess about the same run is the same as far as the failure goes: that is what makes it a good guess.
  // (A stage skipped by a `when` is NOT_EXECUTED either way; only the one skipped after the failure needs the guess.)
  const bare = JSON.parse(JSON.stringify(REAL_RUNS));
  for (const run of bare) for (const stage of run.stages) delete stage.stageFlowNodes;
  const guessed = await api({ 'GET /job/stages-demo/api/json': reply({ lastBuild: { number: 6 } }), 'GET /job/stages-demo/wfapi/runs': reply(bare) }).client.stages('stages-demo', 10);
  assert.deepEqual(guessed.runs.find((run) => run.number === 6).stages.map((s) => s.status), failed.stages.map((s) => s.status));
});

test('a Jenkins served under a path, and jobs a multibranch project names with %2F', async () => {
  const { client, calls } = api({
    'GET /jenkins/job/app/api/json': reply({ jobs: [
      { _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name: 'feature%2Fx', fullName: 'app/feature%2Fx', color: 'red', lastBuild: { number: 3, result: 'FAILURE' } },
      { _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name: 'main', fullName: 'app/main', color: 'notbuilt' },
    ] }),
    'GET /jenkins/job/app/job/feature%252Fx/api/json': reply({ _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name: 'feature%2Fx', fullName: 'app/feature%2Fx', buildable: true, builds: [] }),
    'POST /jenkins/job/app/job/feature%252Fx/build': reply('', { status: 201, headers: { location: 'https://ci.example.com/jenkins/queue/item/12/' } }),
  }, { base: 'https://ci.example.com/jenkins/' });
  const rows = await client.children('app');
  assert.deepEqual(rows.map((r) => [r.path, r.status, r.last?.number ?? null]), [['app/feature%2Fx', 'failed', 3], ['app/main', 'none', null]]);
  assert.equal((await client.job('app/feature%2Fx')).path, 'app/feature%2Fx');
  assert.deepEqual(await client.run('app/feature%2Fx'), { queued: 12 });
  assert.equal(calls.every((c) => c.key.includes('/jenkins/')), true, 'the path Jenkins is served under is kept on every request');
});

test('every color Jenkins gives a job is a status the panel can draw', () => {
  const cases = { blue: ['success', false], blue_anime: ['success', true], red: ['failed', false], red_anime: ['failed', true], yellow: ['unstable', false], yellow_anime: ['unstable', true],
    notbuilt: ['none', false], notbuilt_anime: ['none', true], grey: ['none', false], grey_anime: ['none', true], aborted: ['aborted', false], aborted_anime: ['aborted', true],
    disabled: ['disabled', false], nobuilt: ['none', false], undefined: ['none', false] };
  for (const [color, [status, running]] of Object.entries(cases)) {
    assert.deepEqual(Object.values(statusOf(color === 'undefined' ? undefined : color)), [status, running], color);
  }
  assert.equal(statusOf('blue', true).running, true, 'a build running says so even when the color does not');
});

test('what a running job is expected to take is on its row, and not on a finished one', async () => {
  const { client } = api({
    'GET /api/json': reply({ jobs: [
      { _class: 'hudson.model.FreeStyleProject', name: 'a', fullName: 'a', color: 'blue_anime', lastBuild: { number: 2, building: true, duration: 0, estimatedDuration: 90000 } },
      { _class: 'hudson.model.FreeStyleProject', name: 'b', fullName: 'b', color: 'blue', lastBuild: { number: 7, building: false, result: 'SUCCESS', duration: 5, estimatedDuration: 8000 } },
      { _class: 'hudson.model.FreeStyleProject', name: 'c', fullName: 'c', color: 'blue_anime', lastBuild: { number: 1, building: true, duration: 0, estimatedDuration: -1 } },
    ] }),
  });
  const [a, b, c] = await client.everything('');
  assert.equal(a.last.estimated, 90000);
  assert.equal('estimated' in b.last, false);
  assert.equal('estimated' in c.last, false, 'Jenkins says -1 when it has no history to guess from');
});

// ──────────────────────────────────────────────────────────────────────────────
// A console read in pieces, over time, from where it was last read.
// ──────────────────────────────────────────────────────────────────────────────

test('a console read in several sittings, each from the offset the last one reached and the carry it left, is the console', async () => {
  const next = random(99);
  const NOTE = (i) => `\u001b[8mha:////Ab${'x'.repeat(i % 30)}\u001b[0m`;
  for (let round = 0; round < 40; round += 1) {
    const lines = Array.from({ length: 5 + Math.floor(next() * 25) }, (_, i) => `${next() < 0.5 ? NOTE(i) : ''}${['plain', 'café ✓ 日本語', 'emoji 😀', 'a\rb'][Math.floor(next() * 4)]} ${i}`);
    const file = Buffer.from(`${lines.join('\n')}\n`);
    const expected = `${lines.map((l) => l.replace(/\u001b\[8mha:[^\u001b]*\u001b\[0m/g, '')).join('\n')}\n`;
    const cuts = Array.from({ length: 1 + Math.floor(next() * 5) }, () => 1 + Math.floor(next() * (file.length - 1))).sort((a, b) => a - b);
    const starts = [];
    const { client } = api({
      'GET /job/x/1/logText/progressiveText': ({ search }) => {
        const start = Number(new URLSearchParams(search).get('start'));
        starts.push(start);
        const to = cuts.find((c) => c > start) ?? file.length;
        return reply(crlf(file.subarray(start, to)), { headers: { 'x-text-size': String(to), 'x-more-data': to < file.length ? 'true' : '' } });
      },
    });
    let text = '';
    let from = 0;
    let carry = Buffer.alloc(0);
    // Each sitting is a new call: what was kept between them is only the offset and the carry, as the archive keeps them.
    for (let sitting = 0; sitting < cuts.length + 2; sitting += 1) {
      const read = await client.logPipe('x', 1, { from, carry, onText: (t) => { text += t; } });
      from = read.next;
      carry = read.carry;
      if (!read.more) break;
    }
    assert.equal(text, expected, `round ${round}, cuts ${cuts}`);
    assert.equal(starts.every((s, i) => i === 0 || s > starts[i - 1]), true, 'never from before where it had got to');
    assert.equal(carry.length, 0, 'finished: nothing is left unsaid');
  }
});

test('a console of tens of megabytes is handed over in small pieces and stops at the end that was asked for', async () => {
  const line = 'one more line of output from a long build, with some length to it\n';
  const file = Buffer.from(`${line.repeat(Math.ceil((30 * 1024 * 1024) / line.length))}THE END\n`);
  const { client } = api({
    'GET /job/x/1/logText/progressiveText': ({ search }) => {
      const start = Number(new URLSearchParams(search).get('start'));
      return reply(start < 0 ? '' : crlf(file.subarray(start)), { headers: { 'x-text-size': String(file.length), 'x-more-data': '' } });
    },
  });
  let biggest = 0;
  let total = 0;
  const read = await client.logToSink('x', 1, { tailBytes: 20 * 1024 * 1024, onText: (t) => { biggest = Math.max(biggest, t.length); total += t.length; } });
  assert.equal(read.truncated, true);
  assert.equal(read.skipped, file.length - 20 * 1024 * 1024);
  assert.equal(biggest <= 70_000, true, `the largest piece held at once was ${biggest} characters, of ${total}`);
  assert.equal(total <= 20 * 1024 * 1024, true);
  assert.equal(total > 19 * 1024 * 1024, true);
  assert.equal(read.rawSize, file.length);
  assert.equal(read.more, false);
  // A longer one than the limit that the body (with its CRLFs) overruns is refused rather than held.
  const huge = api({ 'GET /job/x/1/logText/progressiveText': ({ search }) => reply(Number(new URLSearchParams(search).get('start')) < 0 ? '' : crlf(file), { headers: { 'x-text-size': '100', 'x-more-data': '' } }) });
  await assert.rejects(huge.client.logToSink('x', 1, { tailBytes: 1024, onText: () => {} }), /grew by more than/);
});

test('a job lists as many builds as are newer than what the caller has, and says how far it has got', async () => {
  const seen = [];
  const { client } = api({
    'GET /job/j/api/json': ({ search }) => { seen.push(decodeURIComponent(search)); return reply({ _class: 'hudson.model.FreeStyleProject', name: 'j', fullName: 'j', buildable: true, lastBuild: { number: 9 }, builds: [{ number: 9, result: 'SUCCESS', building: false }] }); },
  });
  const job = await client.job('j', { builds: 1 });
  assert.match(seen[0], /builds\[[^\]]*\]\{0,1\}/);
  assert.deepEqual([job.newest, job.builds.length, job.last.number], [9, 1, 9]);
  await client.job('j', { builds: 0 });
  assert.equal(seen[1].includes('builds['), false, 'none wanted: none asked for');
  assert.equal(seen[1].includes('lastBuild[number]'), true);
  await client.job('j', { builds: 5000 });
  assert.match(seen[2], /\{0,100\}/, 'and never more than a hundred');
  const probe = api({ 'GET /job/j/api/json': reply({ lastBuild: { number: 41 } }) });
  assert.equal(await probe.client.lastNumber('j'), 41);
  assert.equal(await api({ 'GET /job/j/api/json': reply({ lastBuild: null }) }).client.lastNumber('j'), null);
});

test('who the credentials are, and the facts a notification is judged from', async () => {
  const build = (n, extra = {}) => ({ number: n, result: 'FAILURE', building: false, timestamp: n * 1000, duration: 5000, queueId: 40 + n, actions: [{}, { causes: [{ userId: 'ana' }, { userId: 'ana' }, { shortDescription: 'timer' }] }], ...extra });
  const { client } = api({
    'GET /me/api/json': reply({ id: 'ana', fullName: 'Ana R.' }),
    'GET /job/j/4/api/json': reply(build(4)),
    'GET /job/j/api/json': reply({ builds: [build(6, { building: true, result: null }), build(5, { result: 'SUCCESS' }), build(4), build(3)] }),
  });
  assert.deepEqual(await client.me(), { id: 'ana', fullName: 'Ana R.' });
  const facts = await client.buildFacts('j', 4);
  assert.deepEqual([facts.number, facts.status, facts.users, facts.queueId], [4, 'failed', ['ana'], 44]);
  assert.equal(await api({}).client.buildFacts('j', 4), null, 'a build that is gone is not an error');
  // After 3, finished only, oldest first: the running one is not an outcome yet.
  assert.deepEqual((await client.buildsAfter('j', 3, 10)).map((one) => [one.number, one.status]), [[4, 'failed'], [5, 'success']]);
  // Anonymous access has no one to be.
  assert.equal(await api({ 'GET /me/api/json': reply({ fullName: 'anonymous' }) }).client.me(), null);
  assert.equal(await api({ 'GET /me/api/json': reply('', { status: 403 }) }).client.me(), null);
});

test('the front page of a Jenkins that cannot be read is an answer, a folder inside that cannot be is a gap', async () => {
  const { client } = api({ 'GET /api/json': reply('', { status: 403 }) });
  await assert.rejects(client.everything(''), (error) => error.status === 403 && /not allowed to see the jobs/.test(error.message));
  const wrong = api({ 'GET /api/json': reply('', { status: 404 }) });
  await assert.rejects(wrong.client.everything(''), /not the front page of a Jenkins/);
  const inner = api({
    'GET /api/json': reply({ jobs: [{ name: 'open', _class: 'com.cloudbees.hudson.plugins.folder.Folder', fullName: 'open', jobs: [{ name: 'locked', _class: 'com.cloudbees.hudson.plugins.folder.Folder', fullName: 'open/locked', jobs: [] }] }] }),
    'GET /job/open/job/locked/api/json': reply('', { status: 403 }),
  });
  const rows = await inner.client.everything('');
  assert.equal(rows.some((row) => row.path === 'open'), true);
  assert.equal(typeof rows.unreadable, 'number');
});

test('every request carries its own login and no cookies', async () => {
  const seen = [];
  const client = new JenkinsApi({ base: 'https://ci.example.com', user: 'a', token: 't', fetch: async (url, init) => { seen.push(init); return reply({ jobs: [] }); } });
  await client.everything('');
  await client.me().catch(() => {});
  assert.equal(seen.length > 0 && seen.every((init) => init.credentials === 'omit' && init.redirect === 'manual'), true);
});

test('a Jenkins under a context path: executors name builds by it, and a redirect back to the build is understood', async () => {
  const executor = { currentExecutable: { url: 'https://ci.example.com/jenkins/job/team/job/pipe/7/', number: 7, timestamp: 5 } };
  const { client } = api({
    'GET /jenkins/computer/api/json': reply({ computer: [{ displayName: 'built-in', numExecutors: 2, executors: [executor], oneOffExecutors: [], assignedLabels: [] }] }),
    'POST /jenkins/job/team/job/pipe/7/stop': reply('', { status: 302, headers: { location: '/jenkins/job/team/job/pipe/7/' } }),
    'POST /jenkins/queue/cancelItem': reply('', { status: 302, headers: { location: 'https://ci.example.com/jenkins/' } }),
  }, { base: 'https://ci.example.com/jenkins' });
  assert.deepEqual((await client.running()).builds.map((one) => [one.path, one.number]), [['team/pipe', 7]]);
  assert.deepEqual(await client.stop('team/pipe', 7), { ok: true });
  assert.deepEqual(await client.cancelQueued(3), { ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// The places Jenkins is asked from: they are only ever held for one round trip, and are always given back.
// ──────────────────────────────────────────────────────────────────────────────

const { Limiter, bulk, background } = require('../electron/jenkins-api');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Jenkins that answers after `delay` ms, counts how many are in flight at once, and can be made to misbehave. */
function slowJenkins({ delay = 5, folders = 0, behave = null } = {}) {
  const state = { inFlight: 0, peak: 0, total: 0 };
  const fetch = async (url, init = {}) => {
    state.inFlight += 1; state.peak = Math.max(state.peak, state.inFlight); state.total += 1;
    try {
      const mode = behave ? behave(state.total) : 'ok';
      if (mode === 'hang') return await new Promise(() => {});                                              // never answers, never fails, ignores its abort
      if (mode === 'hang-abortable') return await new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      await wait(mode === 'slow' ? delay * 8 : delay);
      if (mode === 'fail') throw new TypeError('fetch failed');
      if (mode === 'half') return { status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => { throw new Error('socket hang up'); }, cancel: async () => {} }) } };
      const { pathname, search } = new URL(url);
      const decoded = decodeURIComponent(search);
      if (/jobs\[/.test(decoded)) {
        const folder = pathname === '/api/json' ? '' : pathname.replace(/\/job\//g, '/').replace(/^\//, '').replace(/\/api\/json$/, '');
        const depth = folder ? folder.split('/').length : 0;
        const jobs = depth === 0
          ? Array.from({ length: folders }, (_, i) => ({ _class: 'com.cloudbees.hudson.plugins.folder.Folder', name: `f${i}`, fullName: `f${i}`, jobs: [{ _class: 'hudson.model.FreeStyleProject', name: 'j', fullName: `f${i}/j`, color: 'blue' }] }))
          : [{ _class: 'hudson.model.FreeStyleProject', name: 'k', fullName: `${folder}/k`, color: 'blue' }];
        return reply({ jobs });
      }
      return reply({ ok: true });
    } finally { state.inFlight -= 1; }
  };
  return { fetch, state };
}
const client = (fake, extra = {}) => new JenkinsApi({ base: 'https://ci.example.com', user: 'a', token: 't', fetch: fake.fetch, ...extra });

test('a fan-out of many requests through two places all completes, and the places come back', async () => {
  const fake = slowJenkins({ folders: 14 });
  const api = client(fake, { limiter: { start: 2, min: 2, max: 2 } });
  const rows = await api.everything('');
  assert.equal(rows.filter((row) => row.kind === 'folder').length, 14);
  // Many at once, several of them nested fan-outs, from several askers.
  const results = await Promise.all([...Array.from({ length: 12 }, () => api.children('')), api.everything(''), bulk(() => api.everything('')), background(() => api.everything(''))]);
  assert.equal(results.length, 15);
  assert.equal(fake.state.peak <= 2, true, `${fake.state.peak} at once through two places`);
  assert.deepEqual([api.limiter.state().active, api.limiter.state().waiting], [0, 0]);
});

test('requests that time out, whether or not the fetch honours its abort, give their places back', async () => {
  let calls = 0;
  const fake = slowJenkins({ behave: () => { calls += 1; return calls <= 8 ? (calls % 2 ? 'hang' : 'hang-abortable') : 'ok'; } });
  const api = client(fake, { timeout: 40, limiter: { start: 4, min: 1, max: 4, growEvery: 0, fastMs: 1000 } });
  const burst = await Promise.allSettled(Array.from({ length: 8 }, () => api.me()));
  assert.equal(burst.every((one) => one.status === 'rejected' && one.reason.code === 'timeout'), true);
  assert.equal(api.limiter.state().active, 0, 'every place is back');
  assert.equal(api.limiter.limit, 1, 'and it has been asked less of');
  for (let i = 0; i < 12; i += 1) await api.children('');
  assert.equal(api.limiter.limit > 1, true, 'it recovers on quick answers');
  assert.equal(api.limiter.state().active, 0);
});

test('whatever goes wrong with a request, every promise settles and no place is lost (seeded)', async () => {
  const rand = random(20260716);
  const modes = ['ok', 'ok', 'ok', 'slow', 'fail', 'half', 'hang', 'hang-abortable'];
  const fake = slowJenkins({ delay: 2, folders: 3, behave: () => modes[Math.floor(rand() * modes.length)] });
  const api = client(fake, { timeout: 30, limiter: { start: 3, min: 1, max: 4, maxWait: 5000 } });
  const asks = [];
  for (let i = 0; i < 300; i += 1) {
    const kind = Math.floor(rand() * 5);
    const run = [() => api.children(''), () => api.everything(''), () => bulk(() => api.children('')), () => background(() => api.queue()), () => api.me()][kind];
    const ask = run();
    ask.catch(() => {});
    asks.push(ask);
    if (rand() < 0.3) await wait(1);
  }
  const outcome = await Promise.race([Promise.allSettled(asks), wait(15_000).then(() => 'stuck')]);
  assert.notEqual(outcome, 'stuck', 'every promise settled');
  assert.deepEqual([api.limiter.state().active, api.limiter.state().waiting], [0, 0], 'and no place is lost, no one waits');
});

test('nobody waits for ever: a place held too long is taken back, and a queue that is too long turns people away', async () => {
  const l = new Limiter({ start: 1, min: 1, max: 1, maxWait: 40 });
  await l.acquire('high', { maxHold: 60 });                                   // taken, and never given back
  const turned = await l.acquire('high', { maxHold: 60 }).then(() => 'got it', (error) => error.code);
  assert.equal(turned, 'slow-wait', 'turned away after its wait');
  await wait(60);
  assert.equal(l.state().leaked, 1, 'the lost place was taken back');
  const again = await l.acquire('high').then((release) => { release(); return 'ok'; });
  assert.equal(again, 'ok');
  // Through the client: a busy server answers "slow", not silence.
  const fake = slowJenkins({ behave: () => 'hang' });
  const api = client(fake, { timeout: 500, limiter: { start: 1, min: 1, max: 1, maxWait: 40 } });
  const first = api.me().catch((error) => error);
  await wait(5);
  const second = await api.me().then(() => 'answered', (error) => error);
  assert.equal(second.code, 'slow');
  assert.match(second.message, /busy/);
  void first;
});

test('a person is not behind a crawl, and the history walk never takes the last place', async () => {
  const l = new Limiter({ start: 3, min: 3, max: 3 });
  const order = [];
  const grab = (lane, name) => l.acquire(lane).then((release) => { order.push(name); return release; });
  const first = await Promise.all([grab('bulk', 'b1'), grab('bulk', 'b2')]);        // two of three places, taken by bulk work
  const b3 = grab('bulk', 'b3'); const low = grab('low', 'low'); const high = grab('high', 'high');
  await wait(5);
  assert.deepEqual(order, ['b1', 'b2', 'high'], 'the last place went to the person, not to more bulk work');
  first[0]();
  await wait(5);
  assert.deepEqual(order, ['b1', 'b2', 'high'], 'two are busy, and the last place is still kept for a person');
  (await high)();
  await wait(5);
  assert.deepEqual(order, ['b1', 'b2', 'high', 'b3'], 'bulk before the history walk');
  first[1](); (await b3)();
  await wait(5);
  assert.equal(order.at(-1), 'low');
  (await low)();
  assert.deepEqual([l.state().active, l.state().waiting], [0, 0]);
});

// ──────────────────────────────────────────────────────────────────────────────
// Review R1: a crumb that could not be fetched once, and a console that takes long to arrive.
// ──────────────────────────────────────────────────────────────────────────────

test('a crumb that could not be fetched once is fetched again, and only a server with no issuer is taken to need none', async () => {
  let crumbCalls = 0;
  let failFirst = true;
  const { client } = api({
    'GET /crumbIssuer/api/json': () => {
      crumbCalls += 1;
      if (failFirst) { failFirst = false; return reply('', { status: 503 }); }
      return reply({ crumbRequestField: 'Jenkins-Crumb', crumb: 'c1' });
    },
    'POST /job/x/build': ({ init }) => (init.headers['Jenkins-Crumb'] === 'c1' ? reply('', { status: 201, headers: { location: 'https://ci.example.com/queue/item/4/' } }) : reply('', { status: 403 })),
  }, { crumbRetryMs: 0 });
  assert.deepEqual(await client.run('x'), { queued: 4 }, 'a refusal after a crumb that could not be had asks for one again, and works');
  assert.equal(crumbCalls, 2);
  assert.deepEqual(await client.run('x'), { queued: 4 });
  assert.equal(crumbCalls, 2, 'and the crumb is kept');
  // No issuer at all (404): that is an answer, kept.
  let asked = 0;
  const none = api({ 'GET /crumbIssuer/api/json': () => { asked += 1; return reply('', { status: 404 }); }, 'POST /job/y/build': reply('', { status: 201 }) });
  await none.client.run('y'); await none.client.run('y'); await none.client.run('y');
  assert.equal(asked, 1);
  // A 403 with no crumb is not blamed on the permission before the crumb has been asked for once more.
  let again = 0;
  const flaky = api({
    'GET /crumbIssuer/api/json': () => { again += 1; return again === 1 ? reply('', { status: 500 }) : reply({ crumbRequestField: 'Jenkins-Crumb', crumb: 'c2' }); },
    'POST /job/z/build': ({ init }) => (init.headers['Jenkins-Crumb'] === 'c2' ? reply('', { status: 201 }) : reply('', { status: 403 })),
  });
  await flaky.client.run('z');
  assert.equal(again, 2, 'a refusal after a crumb that was not had asks for one, once');
});

test('a console that keeps arriving is not cut off by the time allowed for it to begin', async () => {
  // Ten pieces, 30 ms apart: 300 ms in all, with 120 ms allowed between pieces.
  const pieces = Array.from({ length: 10 }, (_, i) => Buffer.from(`line ${i}\n`));
  const slowBody = () => {
    let at = 0;
    return { getReader: () => ({ read: async () => { await wait(30); return at < pieces.length ? { done: false, value: pieces[at++] } : { done: true }; }, cancel: async () => {} }) };
  };
  const make = (extra = {}) => new JenkinsApi({ base: 'https://ci.example.com', user: 'a', token: 't', timeout: 120, ...extra,
    fetch: async () => ({ status: 200, headers: { get: (n) => ({ 'x-text-size': '90', 'x-more-data': '' })[n.toLowerCase()] ?? null }, body: slowBody() }) });
  const read = await make().logRead('j', 1, 0);
  assert.equal(read.bytes.toString().startsWith('line 0'), true, 'a console that takes longer in all than the time allowed is read');
  // One that stops arriving is still given up on.
  const stalls = new JenkinsApi({ base: 'https://ci.example.com', user: 'a', token: 't', timeout: 80,
    fetch: async () => ({ status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) } }) });
  await assert.rejects(stalls.logRead('j', 1, 0), /stopped answering/);
});
