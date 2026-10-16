'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoName, ticketsIn, buildReport } = require('../electron/org-report');
const { OrgService } = require('../electron/org-service');

const PATTERN = '\\b[A-Z][A-Z0-9]{1,9}-\\d{1,6}\\b';
const NOW = Date.parse('2026-10-14T15:00:00Z');

test('a repository is named owner/name, without the credentials a remote may carry', () => {
  assert.equal(repoName('https://viktor:s3cret@bitbucket.org/kubrik/timelog-api.git'), 'kubrik/timelog-api');
  assert.equal(repoName('git@github.com:acme/api.git'), 'acme/api');
  assert.equal(repoName('ssh://git@host:7999/team/repo'), 'team/repo');
  assert.equal(repoName(''), '');
});

test('tickets come from the branch in any case, and from titles as written', () => {
  assert.deepEqual(ticketsIn(['feature/ks-142-totals', 'Fix utf-8 for TLB-9', 'KS-142 again'], PATTERN, { anyCase: [0] }), ['KS-142', 'TLB-9']);
  assert.deepEqual(ticketsIn(['x'], '('), [], 'a broken pattern finds nothing rather than throwing');
});

test('the report says what each session is in, and nothing more', () => {
  const report = buildReport({
    sessions: [
      { kind: 'claude', title: 'totals', cwd: '/Users/ana/acme/api', profileName: 'Kubrik', lastWorkedAt: NOW - 30_000, lastOutputAt: NOW - 5_000 },
      { kind: 'shell', title: 'zsh', cwd: '/Users/ana/notes', profileName: 'Kubrik', lastWorkedAt: NOW - 3_600_000 },
    ],
    repos: new Map([['/Users/ana/acme/api', { root: '/Users/ana/acme/api', remote: 'git@github.com:acme/api.git', branch: 'feature/KS-142-totals', subject: 'Totals TLB-9' }]]),
    accounts: [{ name: 'Kubrik', email: 'ana@acme.com', plan: 'max', usage: { readAt: NOW, session: { percentUsed: 30, resets: '3pm' }, week: { percentUsed: 70, resets: 'Oct 20' } } }],
    policy: { ticketPattern: PATTERN, sharePaths: false },
    appVersion: '0.8.43',
    paused: false,
    now: NOW,
    intervalSeconds: 120,
  });
  assert.deepEqual(report.sessions[0], {
    kind: 'claude', title: 'totals', folder: 'api', path: '', repo: 'acme/api', branch: 'feature/KS-142-totals',
    tickets: ['KS-142', 'TLB-9'], account: 'Kubrik', busy: true, active: true,
  });
  assert.equal(report.sessions[1].active, false, 'an hour without anything is not active');
  assert.equal(report.sessions[1].repo, '', 'not a repository');
  assert.equal(report.accounts[0].weekUsed, 70);
  assert.ok(!JSON.stringify(report).includes('/Users/ana'), 'no path unless the company asked');
  assert.equal(buildReport({ sessions: [], repos: new Map(), accounts: [], policy: { sharePaths: true, ticketPattern: PATTERN }, paused: false, now: NOW, intervalSeconds: 120 }).sessions.length, 0);
});

test('paused, the report says only that', () => {
  const r = buildReport({ sessions: [{ title: 'x', cwd: '/a' }], repos: new Map(), accounts: [{ name: 'a' }], policy: {}, paused: true, now: NOW, intervalSeconds: 60 });
  assert.deepEqual(r.sessions, []);
  assert.deepEqual(r.accounts, []);
  assert.equal(r.paused, true);
});

function service({ answers = {} } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'org-app-')), 'organization.json');
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const route = new URL(url).pathname;
    const answer = answers[route] ?? { status: 404, body: { error: 'no' } };
    const a = typeof answer === 'function' ? answer(init) : answer;
    return { ok: a.status < 300, status: a.status, json: async () => a.body };
  };
  const s = new OrgService({
    file,
    secrets: { encrypt: (t) => `enc:${t}`, decrypt: (c) => c.replace(/^enc:/, '') },
    fetch,
    openExternal: () => {},
    gather: async () => ({ sessions: [{ kind: 'shell', title: 't', cwd: '/w/app', profileName: 'P', lastWorkedAt: Date.now() }], repos: new Map(), accounts: [] }),
    appVersion: '9.9.9',
  });
  return { s, calls, file };
}

test('signing in keeps the token encrypted and never hands it to the panel, then reports', async () => {
  const policy = { orgName: 'Acme', reportEveryMinutes: 2, ticketPattern: PATTERN, sharePaths: false };
  const { s, calls, file } = service({ answers: {
    '/api/app/login': { status: 200, body: { ok: true, token: 'tok-1', user: { email: 'ana@acme.com' }, policy } },
    '/api/app/report': { status: 200, body: { ok: true, policy } },
  } });
  const out = await s.loginWithPassword({ server: 'https://org.acme.com/', email: 'ana@acme.com', password: 'pw' });
  s.stop();
  assert.equal(out.signedIn, true);
  assert.ok(!JSON.stringify(out).includes('tok-1'), 'the panel never sees the token');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'enc:tok-1');
  await new Promise((r) => setTimeout(r, 20));
  const report = calls.find((c) => c.url === 'https://org.acme.com/api/app/report');
  assert.equal(report.init.headers.authorization, 'Bearer tok-1');
  assert.equal(JSON.parse(report.init.body).sessions[0].folder, 'app');
  assert.equal(s.overview().lastReport.sessions.length, 1, 'the panel can read exactly what went');
});

test('only https, unless the server is on this machine', () => {
  const { s } = service();
  assert.throws(() => s.serverUrl('http://org.acme.com'), /https/);
  assert.equal(s.serverUrl('http://localhost:8787/'), 'http://localhost:8787');
  assert.throws(() => s.serverUrl('not a url'), /server address/);
});

test('a device the company signed out stops reporting and says so', async () => {
  const { s } = service({ answers: { '/api/app/report': { status: 401, body: { error: 'signed out' } } } });
  s.save({ server: 'https://org.acme.com', token: 'enc:t', user: { email: 'a@acme.com' }, policy: { reportEveryMinutes: 2 } });
  await s.sendNow();
  assert.equal(s.overview().signedIn, false);
  assert.match(s.overview().lastError, /signed this device out/);
});

test('closing says goodbye to the server, and a server that does not answer never holds the quit up', async () => {
  const { s, calls } = service({ answers: { '/api/app/bye': { status: 200, body: { ok: true } } } });
  await s.goodbye();
  assert.equal(calls.length, 0, 'a machine that never signed in says nothing');
  s.save({ server: 'https://org.acme.com', token: 'enc:t', user: { email: 'a@acme.com' } });
  await s.goodbye();
  assert.equal(calls.at(-1).url, 'https://org.acme.com/api/app/bye');
  assert.equal(calls.at(-1).init.headers.authorization, 'Bearer t');

  s.fetch = () => new Promise(() => {});
  const started = Date.now();
  await s.goodbye({ timeoutMs: 50 });
  assert.ok(Date.now() - started < 1000);
});

test('the first report goes out seconds after the app opens, not an interval later', async () => {
  const { s, calls } = service({ answers: { '/api/app/report': { status: 200, body: { ok: true } } } });
  s.save({ server: 'https://org.acme.com', token: 'enc:t', user: { email: 'a@acme.com' }, policy: { reportEveryMinutes: 2 } });
  const delays = [];
  const real = global.setTimeout;
  global.setTimeout = (fn, ms) => { delays.push(ms); return real(() => {}, 0); };
  try { s.start(); } finally { global.setTimeout = real; }
  s.stop();
  assert.ok(delays[0] <= 10_000, `first report after ${delays[0]} ms`);
  assert.equal(calls.length, 0);
});

test('pausing sends at once, and sends nothing about the work', async () => {
  const bodies = [];
  const { s } = service({ answers: { '/api/app/report': (init) => { bodies.push(JSON.parse(init.body)); return { status: 200, body: { ok: true } }; } } });
  s.save({ server: 'https://org.acme.com', token: 'enc:t', user: { email: 'a@acme.com' }, policy: { reportEveryMinutes: 2, ticketPattern: PATTERN } });
  s.setPaused(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bodies.at(-1).paused, true);
  assert.deepEqual(bodies.at(-1).sessions, []);
});

test('sessions in a never-shared folder are counted and nothing else is said about them', () => {
  const report = buildReport({
    sessions: [
      { kind: 'claude', title: 'secret', cwd: '/Users/ana/personal/diary' },
      { kind: 'shell', title: 'also secret', cwd: '/Users/ana/personal' },
      { kind: 'shell', title: 'work', cwd: '/Users/ana/personality-app' },
    ],
    repos: new Map(), accounts: [], policy: { ticketPattern: '', sharePaths: true },
    appVersion: 't', paused: false, now: 0, intervalSeconds: 120, privateFolders: ['/Users/ana/personal/'],
  });
  assert.equal(report.hiddenSessions, 2);
  assert.deepEqual(report.sessions.map((s) => s.title), ['work']);
  assert.ok(!JSON.stringify(report).includes('secret'));
});

const { OrgRelay, RecentOutput } = require('../electron/org-relay');

/** A WebSocket the test plays the server side of. */
function fakeSockets() {
  const made = [];
  class FakeWs {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      made.push(this);
      setImmediate(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(text) { this.sent.push(JSON.parse(text)); }
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    say(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
  }
  return { FakeWs, made };
}

test('the relay offers what is open, opens it for the browser, and types what comes back', async () => {
  const { FakeWs, made } = fakeSockets();
  const typed = [];
  const told = [];
  const relay = new OrgRelay({
    WebSocketImpl: FakeWs,
    sessions: () => [
      { id: 's1', title: 'API', kind: 'shell', cwd: '/Users/ana/acme/api' },
      { id: 's2', title: 'Diary', kind: 'shell', cwd: '/Users/ana/personal/diary' },
    ],
    attach: (id) => (id === 's1' ? { ptyId: 'p1', cols: 100, rows: 30, kind: 'shell', title: 'API', replay: '$ ' } : null),
    write: (ptyId, data) => typed.push([ptyId, data]),
    isPrivate: (cwd) => cwd.startsWith('/Users/ana/personal'),
    notify: (title, body) => told.push(body),
  });
  relay.start('https://org.acme.com', 'tok.en');
  await new Promise((r) => setImmediate(r));
  const ws = made[0];
  assert.equal(ws.url, 'wss://org.acme.com/api/app/relay');
  assert.deepEqual(ws.sent[0], { t: 'hello', token: 'tok.en' });

  ws.say({ t: 'welcome' });
  assert.equal(relay.status().connected, true);
  assert.deepEqual(ws.sent[1], { t: 'sessions', list: [{ id: 's1', title: 'API', kind: 'shell', folder: 'api', repo: '' }] }, 'the never-shared one is not offered');

  ws.say({ t: 'open', ch: 'c2', session: 's2', from: 'Chrome on macOS' });
  assert.equal(ws.sent.at(-1).t, 'refused', 'even when asked for by id');

  ws.say({ t: 'open', ch: 'c1', session: 's1', from: 'Chrome on macOS' });
  assert.deepEqual(ws.sent.at(-1), { t: 'opened', ch: 'c1', cols: 100, rows: 30, title: 'API', replay: '$ ' });
  assert.match(told[0], /API, from Chrome on macOS/);
  assert.equal(relay.status().viewers.length, 1);

  ws.say({ t: 'in', ch: 'c1', data: 'ls\r' });
  assert.deepEqual(typed, [['p1', 'ls\r']]);
  relay.output('p1', 'README.md\r\n');
  relay.output('p9', 'not this one');
  assert.deepEqual(ws.sent.at(-1), { t: 'out', ch: 'c1', data: 'README.md\r\n' });
  relay.resized('p1', 120, 40);
  assert.deepEqual(ws.sent.at(-1), { t: 'size', ch: 'c1', cols: 120, rows: 40 });

  relay.disconnect();
  assert.deepEqual(ws.sent.at(-1), { t: 'ended', ch: 'c1', reason: 'Closed from Smart Terminal.' });
  assert.equal(relay.status().viewers.length, 0);
  relay.stop();
});

test('a phone takes the session at its own width, and gives the app its size back when it closes', async () => {
  const { FakeWs, made } = fakeSockets();
  const sized = [];
  const relay = new OrgRelay({
    WebSocketImpl: FakeWs,
    sessions: () => [{ id: 's1', title: 'API', kind: 'claude', cwd: '/w/api' }],
    attach: () => ({ ptyId: 'p1', cols: 100, rows: 30, kind: 'claude', title: 'API', replay: '' }),
    write: () => {},
    resize: (ptyId, cols, rows) => sized.push([ptyId, cols, rows]),
  });
  relay.start('https://org.acme.com', 't');
  await new Promise((r) => setImmediate(r));
  const ws = made[0];
  ws.say({ t: 'welcome' });
  ws.say({ t: 'open', ch: 'phone', session: 's1', from: 'Safari on iOS' });
  ws.say({ t: 'open', ch: 'laptop', session: 's1', from: 'Chrome on macOS' });

  ws.say({ t: 'resize', ch: 'phone', cols: 46, rows: 25 });
  assert.deepEqual(sized.at(-1), ['p1', 46, 25]);
  assert.equal(relay.drives('p1'), true);
  assert.deepEqual(ws.sent.at(-1), { t: 'size', ch: 'laptop', cols: 46, rows: 25 }, 'the other browser follows');

  // The app resizes meanwhile: kept for later, not applied, not sent.
  const before = ws.sent.length;
  relay.resized('p1', 110, 32);
  assert.equal(ws.sent.length, before);

  ws.say({ t: 'close', ch: 'phone' });
  assert.deepEqual(sized.at(-1), ['p1', 110, 32], 'back to the app\'s latest size');
  assert.equal(relay.drives('p1'), false);
  assert.deepEqual(ws.sent.at(-1), { t: 'size', ch: 'laptop', cols: 110, rows: 32 });

  // Giving it back by asking, and only the browser that has it can.
  ws.say({ t: 'resize', ch: 'laptop', cols: 60, rows: 20 });
  ws.say({ t: 'open', ch: 'other', session: 's1', from: 'Firefox on Linux' });
  ws.say({ t: 'resize', ch: 'other', release: true });
  assert.equal(relay.drives('p1'), true);
  ws.say({ t: 'resize', ch: 'laptop', release: true });
  assert.deepEqual(sized.at(-1), ['p1', 110, 32]);

  // Lost connection: nobody is left holding it.
  ws.say({ t: 'resize', ch: 'laptop', cols: 60, rows: 20 });
  ws.close(1006);
  assert.deepEqual(sized.at(-1), ['p1', 110, 32]);
  relay.stop();
});

test('a relay the server refuses as signed out stops trying; one cut off tries again', async () => {
  const { FakeWs, made } = fakeSockets();
  const relay = new OrgRelay({ WebSocketImpl: FakeWs, sessions: () => [], attach: () => null, write: () => {} });
  relay.start('http://localhost:8787', 't');
  await new Promise((r) => setImmediate(r));
  made[0].close(4001);
  assert.equal(relay.target, null);
  assert.match(relay.status().error, /Sign in again/);

  relay.start('http://localhost:8787', 't2');
  await new Promise((r) => setImmediate(r));
  assert.equal(made[1].url, 'ws://localhost:8787/api/app/relay');
  made[1].close(1006);
  assert.ok(relay.retryTimer, 'tries again later');
  relay.stop();
  assert.equal(relay.retryTimer, null);
});

test('recent output is cut at a line break, never inside an escape', () => {
  const recent = new RecentOutput(20);
  recent.add('p', 'first line\r\n\x1b[1msecond\x1b[0m line\r\nthird');
  assert.ok(recent.get('p').length <= 20);
  assert.ok(!recent.get('p').startsWith('[') && !recent.get('p').startsWith('\x1b[0m'));
  assert.match(recent.get('p'), /third$/);
});
