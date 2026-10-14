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

test('pausing sends at once, and sends nothing about the work', async () => {
  const bodies = [];
  const { s } = service({ answers: { '/api/app/report': (init) => { bodies.push(JSON.parse(init.body)); return { status: 200, body: { ok: true } }; } } });
  s.save({ server: 'https://org.acme.com', token: 'enc:t', user: { email: 'a@acme.com' }, policy: { reportEveryMinutes: 2, ticketPattern: PATTERN } });
  s.setPaused(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bodies.at(-1).paused, true);
  assert.deepEqual(bodies.at(-1).sessions, []);
});
