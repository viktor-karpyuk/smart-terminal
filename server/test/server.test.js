'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('../src/app');
const { hashPassword } = require('../src/auth');

// ── a fake identity provider, with a real RSA key ────────────────────────────
function fakeIdp({ issuer = 'https://idp.example', email = 'dev@acme.com', verified = true, aud = 'client-1', badSig = false } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const sign = (claims) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const key = badSig ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : privateKey;
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
  };
  const fetch = async (url, init = {}) => {
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url === `${issuer}/jwks`) return json({ keys: [jwk] });
    if (url === `${issuer}/token`) {
      const form = new URLSearchParams(init.body);
      const held = codes.get(form.get('code'));
      if (!held) return json({ error: 'invalid_grant' }, 400);
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url');
      if (challenge !== held.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
      return json({ id_token: sign({ iss: issuer, aud, sub: 'u1', email, email_verified: verified, name: 'Dev One', nonce: held.nonce, exp: Math.floor(Date.now() / 1000) + 600 }) });
    }
    return json({}, 404);
  };
  /** What the browser does at the provider: comes back with a code. */
  const authorize = (location) => {
    const u = new URL(location);
    const code = crypto.randomBytes(8).toString('hex');
    codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge') });
    return { code, state: u.searchParams.get('state'), redirect: u.searchParams.get('redirect_uri') };
  };
  return { fetch, authorize, issuer };
}

async function boot(idp, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-'));
  const realFetch = globalThis.fetch;
  const { server, store } = createServer({ dbFile: path.join(dir, 'org.db'), publicUrl: 'http://localhost:1', fetch: idp ? idp.fetch : realFetch, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, token, cookie, headers = {} } = {}) => {
    const res = await realFetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  const admin = store.createUser({ email: 'boss@acme.com', name: 'Boss', role: 'admin', passHash: await hashPassword('correct horse battery') });
  const webLogin = async (email = 'boss@acme.com', password = 'correct horse battery') => {
    const r = await call('POST', '/api/web/login', { body: { email, password } });
    return r.headers.get('set-cookie')?.split(';')[0];
  };
  return { server, store, call, admin, webLogin, close: () => new Promise((r) => server.close(r)) };
}

test('an administrator makes an account with a password; the app signs in and reports', async () => {
  const s = await boot();
  try {
    const cookie = await s.webLogin();
    const made = await s.call('POST', '/api/admin/users', { cookie, body: { email: 'Ana@Acme.com', name: 'Ana', role: 'member' } });
    assert.equal(made.status, 201);
    assert.match(made.json.password, /^[\w-]{20,}$/, 'a generated password, shown once');

    const login = await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: made.json.password, device: 'Ana MacBook' } });
    assert.equal(login.status, 200);
    assert.equal(login.json.policy.reportEveryMinutes, 2);
    const token = login.json.token;

    const report = {
      appVersion: '0.8.42',
      sessions: [
        { kind: 'claude', title: 'KS-142 invoices', folder: 'api', repo: 'acme/api', branch: 'feature/KS-142-totals', tickets: ['KS-142'], busy: true, active: true, path: '/Users/ana/acme/api' },
        { kind: 'shell', title: 'zsh', folder: 'web', repo: 'acme/web', branch: 'main', tickets: [], active: false },
      ],
      accounts: [{ name: 'Kubrik', sessionUsed: 30, sessionResets: '3pm', weekUsed: 70, weekResets: 'Oct 20' }],
    };
    assert.equal((await s.call('POST', '/api/app/report', { token, body: report })).status, 200);

    const view = await s.call('GET', '/api/web/overview', { cookie });
    const ana = view.json.people.find((p) => p.email === 'ana@acme.com');
    assert.equal(ana.online, true);
    assert.equal(ana.sessions.length, 2);
    assert.equal(ana.sessions[0].path, '', 'full paths are not kept unless the company turned that on');
    assert.equal(ana.accounts[0].sessionUsed, 30);
    assert.deepEqual(ana.repos.map((r) => r.key), ['acme/api'], 'only the session that worked counts');
    assert.deepEqual(view.json.tickets.map((t) => t.key), ['KS-142']);
  } finally { await s.close(); }
});

test('wrong passwords, unknown accounts and too many tries are refused alike', async () => {
  const s = await boot();
  try {
    const bad = await s.call('POST', '/api/app/login', { body: { email: 'boss@acme.com', password: 'nope' } });
    const none = await s.call('POST', '/api/app/login', { body: { email: 'ghost@acme.com', password: 'nope' } });
    assert.equal(bad.status, 401);
    assert.equal(none.json.error, bad.json.error, 'the answer does not say which accounts exist');
    for (let i = 0; i < 9; i += 1) await s.call('POST', '/api/app/login', { body: { email: 'boss@acme.com', password: 'nope' } });
    assert.equal((await s.call('POST', '/api/app/login', { body: { email: 'boss@acme.com', password: 'correct horse battery' } })).status, 429);
  } finally { await s.close(); }
});

test('a device token stops working when its account is disabled or the device is signed out', async () => {
  const s = await boot();
  try {
    const cookie = await s.webLogin();
    const made = await s.call('POST', '/api/admin/users', { cookie, body: { email: 'leo@acme.com', role: 'member' } });
    const { token } = (await s.call('POST', '/api/app/login', { body: { email: 'leo@acme.com', password: made.json.password } })).json;
    assert.equal((await s.call('GET', '/api/app/me', { token })).status, 200);
    await s.call('PATCH', `/api/admin/users/${made.json.user.id}`, { cookie, body: { disabled: true } });
    assert.equal((await s.call('GET', '/api/app/me', { token })).status, 401);
    assert.equal((await s.call('GET', '/api/app/me', { token: `${token}x` })).status, 401);
  } finally { await s.close(); }
});

test('members cannot reach the backoffice, and see only themselves', async () => {
  const s = await boot();
  try {
    const cookie = await s.webLogin();
    const made = await s.call('POST', '/api/admin/users', { cookie, body: { email: 'mia@acme.com', role: 'member' } });
    const mia = await s.webLogin('mia@acme.com', made.json.password);
    assert.equal((await s.call('GET', '/api/admin/users', { cookie: mia })).status, 403);
    assert.equal((await s.call('PUT', '/api/admin/settings', { cookie: mia, body: { orgName: 'x' } })).status, 403);
    assert.equal((await s.call('GET', '/api/web/overview', { cookie: mia })).status, 403, 'the team view is the administrators\' and the leads\'');
  } finally { await s.close(); }
});

test('everybody sees their own stats, a day counted once however many repositories it touched', async () => {
  const s = await boot();
  try {
    const cookie = await s.webLogin();
    const made = await s.call('POST', '/api/admin/users', { cookie, body: { email: 'mia@acme.com', name: 'Mia', role: 'member' } });
    const other = await s.call('POST', '/api/admin/users', { cookie, body: { email: 'leo@acme.com', role: 'member' } });
    const mia = (await s.call('POST', '/api/app/login', { body: { email: 'mia@acme.com', password: made.json.password } })).json.token;
    const leo = (await s.call('POST', '/api/app/login', { body: { email: 'leo@acme.com', password: other.json.password } })).json.token;
    const two = { sessions: [
      { kind: 'claude', title: 'a', repo: 'acme/api', tickets: ['KS-1'], active: true },
      { kind: 'claude', title: 'b', repo: 'acme/web', tickets: [], active: true },
    ], accounts: [{ name: 'Mia', sessionUsed: 40, weekUsed: 10 }] };
    await s.call('POST', '/api/app/report', { token: mia, body: two });
    await s.call('POST', '/api/app/report', { token: leo, body: { sessions: [{ kind: 'shell', title: 'x', repo: 'acme/secret', active: true }] } });

    const fromApp = await s.call('GET', '/api/app/stats', { token: mia });
    assert.equal(fromApp.status, 200);
    assert.equal(fromApp.json.days.length, 7);
    assert.equal(fromApp.json.days.at(-1).minutes, 2, 'two repositories at once is two minutes of work, not four');
    assert.deepEqual(fromApp.json.repos.map((r) => r.key).sort(), ['acme/api', 'acme/web']);
    assert.deepEqual(fromApp.json.tickets.map((t) => t.key), ['KS-1']);
    assert.equal(fromApp.json.accounts[0].sessionUsed, 40);
    assert.ok(!JSON.stringify(fromApp.json).includes('acme/secret'), 'nobody else\'s work');

    const miaWeb = await s.webLogin('mia@acme.com', made.json.password);
    const fromWeb = await s.call('GET', '/api/web/stats', { cookie: miaWeb });
    assert.deepEqual(fromWeb.json.repos, fromApp.json.repos);
  } finally { await s.close(); }
});

test('a change from the browser must be JSON from this site', async () => {
  const s = await boot();
  try {
    const cookie = await s.webLogin();
    const form = await s.call('POST', '/api/admin/users', { cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
    const elsewhere = await s.call('POST', '/api/admin/users', { cookie, body: { email: 'x@acme.com' }, headers: { origin: 'https://evil.example' } });
    assert.equal(elsewhere.status, 403);
  } finally { await s.close(); }
});

async function withSso(idpOptions, provider = {}) {
  const idp = fakeIdp(idpOptions);
  const s = await boot(idp);
  const cookie = await s.webLogin();
  await s.call('PUT', '/api/admin/settings', { cookie, body: { providers: [{ id: 'acme', type: 'oidc', issuer: idp.issuer, clientId: 'client-1', clientSecret: 's', ...provider }] } });
  return { s, idp };
}

test('the app signs in with SSO: browser to the provider, a one-time code back to the app, PKCE to exchange it', async () => {
  const { s, idp } = await withSso({ email: 'dev@acme.com' });
  try {
    s.store.createUser({ email: 'dev@acme.com', role: 'member' });
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const start = await s.call('GET', `/auth/acme/start?for=app&state=app-state-1&challenge=${challenge}&redirect=${encodeURIComponent('http://127.0.0.1:53111/callback')}`);
    assert.equal(start.status, 302);
    const at = idp.authorize(start.headers.get('location'));
    const back = await s.call('GET', `/auth/callback?code=${at.code}&state=${at.state}`);
    assert.equal(back.status, 302);
    const toApp = new URL(back.headers.get('location'));
    assert.equal(toApp.origin + toApp.pathname, 'http://127.0.0.1:53111/callback');
    assert.equal(toApp.searchParams.get('state'), 'app-state-1');

    const stolen = await s.call('POST', '/api/app/exchange', { body: { code: toApp.searchParams.get('code'), verifier: 'not-the-verifier' } });
    assert.equal(stolen.status, 400, 'a code is no use without the app\'s verifier');
    // A failed exchange spends the code: it is single use either way.
    const again = await s.call('POST', '/api/app/exchange', { body: { code: toApp.searchParams.get('code'), verifier } });
    assert.equal(again.status, 400);
  } finally { await s.close(); }
});

test('SSO hands the app a token when everything matches', async () => {
  const { s, idp } = await withSso({ email: 'dev@acme.com' });
  try {
    s.store.createUser({ email: 'dev@acme.com', role: 'member' });
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const start = await s.call('GET', `/auth/acme/start?for=app&state=st&challenge=${challenge}&redirect=${encodeURIComponent('http://127.0.0.1:53111/callback')}`);
    const at = idp.authorize(start.headers.get('location'));
    const back = new URL((await s.call('GET', `/auth/callback?code=${at.code}&state=${at.state}`)).headers.get('location'));
    const done = await s.call('POST', '/api/app/exchange', { body: { code: back.searchParams.get('code'), verifier, device: 'laptop' } });
    assert.equal(done.status, 200);
    assert.equal(done.json.user.email, 'dev@acme.com');
    assert.equal((await s.call('GET', '/api/app/me', { token: done.json.token })).status, 200);
  } finally { await s.close(); }
});

test('SSO refuses people with no account, forged tokens and other applications', async () => {
  for (const [what, idpOptions, expect] of [
    ['no account', { email: 'stranger@acme.com' }, /no account here/],
    ['a bad signature', { email: 'dev@acme.com', badSig: true }, /signature/],
    ['another audience', { email: 'dev@acme.com', aud: 'someone-else' }, /another application/],
    ['an unverified address', { email: 'dev@acme.com', verified: false }, /did not vouch/],
  ]) {
    const { s, idp } = await withSso(idpOptions);
    try {
      s.store.createUser({ email: 'dev@acme.com', role: 'member' });
      const start = await s.call('GET', '/auth/acme/start');
      const at = idp.authorize(start.headers.get('location'));
      const back = await s.call('GET', `/auth/callback?code=${at.code}&state=${at.state}`);
      assert.match(back.text, expect, what);
      assert.equal(back.headers.get('set-cookie'), null, `${what}: no session`);
    } finally { await s.close(); }
  }
});

test('a domain the company allowed lets its people in as developers; a callback is single use', async () => {
  const { s, idp } = await withSso({ email: 'new@acme.com' }, { allowDomains: 'acme.com' });
  try {
    const start = await s.call('GET', '/auth/acme/start');
    const at = idp.authorize(start.headers.get('location'));
    const back = await s.call('GET', `/auth/callback?code=${at.code}&state=${at.state}`);
    assert.equal(back.status, 302);
    assert.match(back.headers.get('set-cookie'), /org_session=.+HttpOnly/);
    assert.equal(s.store.userByEmail('new@acme.com').role, 'member');
    const replay = await s.call('GET', `/auth/callback?code=${at.code}&state=${at.state}`);
    assert.equal(replay.status, 400);
  } finally { await s.close(); }
});

test('the app may only be sent back to its own loopback address', async () => {
  const { s } = await withSso({});
  try {
    const challenge = 'x'.repeat(43);
    const evil = await s.call('GET', `/auth/acme/start?for=app&state=s&challenge=${challenge}&redirect=${encodeURIComponent('https://evil.example/callback')}`);
    assert.equal(evil.status, 400);
  } finally { await s.close(); }
});

test('settings never send a client secret back, and a blank one keeps it', async () => {
  const { s } = await withSso({});
  try {
    const cookie = await s.webLogin();
    const got = await s.call('GET', '/api/admin/settings', { cookie });
    assert.equal(got.json.providers[0].hasSecret, true);
    assert.equal(got.json.providers[0].clientSecret, undefined);
    await s.call('PUT', '/api/admin/settings', { cookie, body: { providers: [{ ...got.json.providers[0], clientSecret: '' }] } });
    assert.equal(s.store.setting('org').providers[0].clientSecret, 's');
  } finally { await s.close(); }
});

test('a person changes their own password; other browsers are signed out, devices are not', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    const made = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', role: 'member' } });
    const first = await s.webLogin('ana@acme.com', made.json.password);
    const second = await s.webLogin('ana@acme.com', made.json.password);
    const { token } = (await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: made.json.password, device: 'laptop' } })).json;
    assert.equal((await s.call('POST', '/api/web/password', { cookie: first, body: { current: 'wrong', next: 'a brand new password' } })).status, 400);
    assert.equal((await s.call('POST', '/api/web/password', { cookie: first, body: { current: made.json.password, next: 'short' } })).status, 400);
    assert.equal((await s.call('POST', '/api/web/password', { cookie: first, body: { current: made.json.password, next: 'a brand new password' } })).status, 200);
    assert.equal((await s.call('GET', '/api/web/account', { cookie: first })).status, 200, 'this browser stays');
    assert.equal((await s.call('GET', '/api/web/account', { cookie: second })).status, 401, 'other browsers are signed out');
    assert.equal((await s.call('GET', '/api/app/me', { token })).status, 200, 'devices stay signed in');
    assert.equal((await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: 'a brand new password' } })).status, 200);
  } finally { await s.close(); }
});

test('a person signs out their own devices, and only their own', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    const ana = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', role: 'member' } });
    const leo = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'leo@acme.com', role: 'member' } });
    await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: ana.json.password, device: 'ana-mac' } });
    const leoToken = (await s.call('POST', '/api/app/login', { body: { email: 'leo@acme.com', password: leo.json.password, device: 'leo-mac' } })).json.token;
    const anaWeb = await s.webLogin('ana@acme.com', ana.json.password);
    const account = await s.call('GET', '/api/web/account', { cookie: anaWeb });
    assert.deepEqual(account.json.devices.map((d) => d.label), ['ana-mac']);
    const leoDeviceId = leoToken.split('.')[0];
    assert.equal((await s.call('DELETE', `/api/web/devices/${leoDeviceId}`, { cookie: anaWeb })).status, 404, 'not somebody else\'s');
    assert.equal((await s.call('DELETE', `/api/web/devices/${account.json.devices[0].id}`, { cookie: anaWeb })).status, 200);
    assert.equal((await s.call('GET', '/api/web/account', { cookie: anaWeb })).json.devices.length, 0);
  } finally { await s.close(); }
});

test('administrators see one person\'s weeks, a 30-day period, the log, and an export that is safe to open', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    const made = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', name: '=HYPERLINK("x")', role: 'member' } });
    const { token } = (await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: made.json.password, device: 'mac' } })).json;
    await s.call('POST', '/api/app/report', { token, body: { sessions: [{ kind: 'claude', title: 'x', repo: 'acme/api', tickets: ['KS-1'], active: true }] } });

    const person = await s.call('GET', `/api/admin/people/${made.json.user.id}/stats?days=30`, { cookie: admin });
    assert.equal(person.json.days.length, 30);
    assert.equal(person.json.period, 30);
    assert.equal((await s.call('GET', '/api/web/overview?days=30', { cookie: admin })).json.period, 30);

    const csv = await s.call('GET', '/api/admin/export.csv?days=7', { cookie: admin });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.text, /^date,name,email,team,what,key,project,minutes\n/);
    assert.match(csv.text, /repo,acme\/api,,2/);
    assert.match(csv.text, /"'=HYPERLINK\(""x""\)"/, 'a name that looks like a formula is written as text');

    const log = await s.call('GET', '/api/admin/audit', { cookie: admin });
    const actions = log.json.entries.map((e) => e.action);
    for (const a of ['account.created', 'signin.app', 'signin.web', 'export']) assert.ok(actions.includes(a), a);

    const anaWeb = await s.webLogin('ana@acme.com', made.json.password);
    for (const route of [`/api/admin/people/${made.json.user.id}/stats`, '/api/admin/audit', '/api/admin/export.csv']) {
      assert.equal((await s.call('GET', route, { cookie: anaWeb })).status, 403, route);
    }
  } finally { await s.close(); }
});

test('a ticket link must be https and say where the ticket goes; devices are told it', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    assert.equal((await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { ticketUrl: 'http://jira/browse/{ticket}' } })).status, 400);
    assert.equal((await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { ticketUrl: 'https://acme.atlassian.net/browse/' } })).status, 400);
    assert.equal((await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { ticketUrl: 'https://acme.atlassian.net/browse/{ticket}' } })).status, 200);
    const made = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', role: 'member' } });
    const login = await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: made.json.password } });
    assert.equal(login.json.policy.ticketUrl, 'https://acme.atlassian.net/browse/{ticket}');
  } finally { await s.close(); }
});

test('teams and projects: time is grouped by both, and the export says which', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { projects: [
      { name: 'Timelog', patterns: 'acme/timelog-*' },
      { name: 'Terminal', patterns: ['*/smart-terminal'] },
    ] } });
    const ana = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', role: 'member', team: 'Backend' } });
    const leo = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'leo@acme.com', role: 'member' } });
    await s.call('PATCH', `/api/admin/users/${leo.json.user.id}`, { cookie: admin, body: { team: 'Frontend' } });
    const t1 = (await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: ana.json.password } })).json.token;
    const t2 = (await s.call('POST', '/api/app/login', { body: { email: 'leo@acme.com', password: leo.json.password } })).json.token;
    await s.call('POST', '/api/app/report', { token: t1, body: { sessions: [{ kind: 'shell', title: 'a', repo: 'acme/timelog-api', active: true }] } });
    await s.call('POST', '/api/app/report', { token: t2, body: { sessions: [{ kind: 'shell', title: 'b', repo: 'kubrik/smart-terminal', active: true }, { kind: 'shell', title: 'c', repo: 'acme/other', active: true }] } });

    const view = (await s.call('GET', '/api/web/overview', { cookie: admin })).json;
    assert.deepEqual(view.projects.map((p) => p.key).sort(), ['No project', 'Terminal', 'Timelog']);
    assert.deepEqual(view.teams.map((t) => t.key).sort(), ['Backend', 'Frontend']);
    assert.deepEqual(view.teamNames, ['Backend', 'Frontend']);
    assert.equal(view.people.find((p) => p.email === 'ana@acme.com').team, 'Backend');
    const csv = (await s.call('GET', '/api/admin/export.csv', { cookie: admin })).text;
    assert.match(csv, /^date,name,email,team,what,key,project,minutes/);
    assert.match(csv, /Backend,repo,acme\/timelog-api,Timelog,2/);
  } finally { await s.close(); }
});

test('a team lead sees the people in the teams they lead, and nobody else', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    const made = {};
    for (const [email, team] of [['ana@acme.com', 'Backend'], ['leo@acme.com', 'Frontend'], ['eva@acme.com', 'Backend'], ['max@acme.com', '']]) {
      made[email] = (await s.call('POST', '/api/admin/users', { cookie: admin, body: { email, role: 'member', team } })).json;
    }
    // Eva leads Backend, made so from the start; Leo is made a lead of nothing, then of Frontend.
    const eva = made['eva@acme.com'];
    await s.call('PATCH', `/api/admin/users/${eva.user.id}`, { cookie: admin, body: { leads: 'Backend, Backend ,' } });
    const evaCookie = await s.webLogin('eva@acme.com', eva.password);
    const me = (await s.call('GET', '/api/web/me', { cookie: evaCookie })).json.user;
    assert.deepEqual(me.leads, ['Backend']);

    const report = async (email, sessions) => {
      const token = (await s.call('POST', '/api/app/login', { body: { email, password: made[email].password } })).json.token;
      await s.call('POST', '/api/app/report', { token, body: { sessions } });
    };
    await report('ana@acme.com', [
      { kind: 'claude', title: 'login', repo: 'acme/api', branch: 'feature/KBK-12-login', tickets: ['KBK-12'], active: true },
      { kind: 'shell', title: 'logs', repo: 'acme/api', tickets: [], active: false },
    ]);
    await report('leo@acme.com', [{ kind: 'claude', title: 'web', repo: 'acme/web', tickets: ['KBK-40'], active: true }]);

    const view = (await s.call('GET', '/api/web/overview', { cookie: evaCookie })).json;
    assert.deepEqual(view.people.map((p) => p.email).sort(), ['ana@acme.com', 'eva@acme.com']);
    assert.deepEqual(view.scope, ['Backend']);
    assert.deepEqual(view.teamNames, ['Backend']);
    assert.deepEqual(view.tickets.map((t) => t.key), ['KBK-12'], 'Frontend\'s tickets are not counted in');
    const ana = view.people.find((p) => p.email === 'ana@acme.com');
    assert.equal(ana.sessionCount, 2);
    assert.equal(ana.workingSessions, 1);
    assert.equal(ana.claudeSessions, 1);
    assert.deepEqual(ana.openTickets, ['KBK-12']);

    // One of hers, yes; one of somebody else's, as if it did not exist.
    assert.equal((await s.call('GET', `/api/admin/people/${made['ana@acme.com'].user.id}/stats`, { cookie: evaCookie })).status, 200);
    assert.equal((await s.call('GET', `/api/admin/people/${made['leo@acme.com'].user.id}/stats`, { cookie: evaCookie })).status, 404);
    const csv = (await s.call('GET', '/api/admin/export.csv', { cookie: evaCookie })).text;
    assert.match(csv, /ana@acme\.com/);
    assert.doesNotMatch(csv, /leo@acme\.com/);

    // Leading a team is not administering: accounts, settings, the log and devices stay closed.
    assert.equal((await s.call('GET', '/api/admin/users', { cookie: evaCookie })).status, 403);
    assert.equal((await s.call('GET', '/api/admin/settings', { cookie: evaCookie })).status, 403);
    assert.equal((await s.call('GET', '/api/admin/audit', { cookie: evaCookie })).status, 403);
    assert.equal((await s.call('PATCH', `/api/admin/users/${eva.user.id}`, { cookie: evaCookie, body: { leads: ['Frontend'] } })).status, 403);

    // A developer who leads nothing still sees only themselves.
    const max = await s.webLogin('max@acme.com', made['max@acme.com'].password);
    assert.equal((await s.call('GET', '/api/web/overview', { cookie: max })).status, 403);

    // The administrator sees everyone, and the change of lead is in the log.
    assert.equal((await s.call('GET', '/api/web/overview', { cookie: admin })).json.scope, null);
    const log = (await s.call('GET', '/api/admin/audit', { cookie: admin })).json.entries;
    assert.ok(log.some((e) => e.action === 'account.leads' && e.target === 'eva@acme.com' && e.detail === 'Backend'));

    // Taking the lead away closes the view at once.
    await s.call('PATCH', `/api/admin/users/${eva.user.id}`, { cookie: admin, body: { leads: [] } });
    assert.equal((await s.call('GET', '/api/web/overview', { cookie: evaCookie })).status, 403);

    // Made a lead when the account is made.
    const zoe = (await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'zoe@acme.com', role: 'member', team: 'Frontend', leads: ['Frontend'] } })).json;
    assert.deepEqual(zoe.user.leads, ['Frontend']);

    // A team typed in another case is the same team, and is saved the way its people have it.
    await s.call('PATCH', `/api/admin/users/${eva.user.id}`, { cookie: admin, body: { leads: ' backend ' } });
    assert.deepEqual((await s.call('GET', '/api/web/me', { cookie: evaCookie })).json.user.leads, ['Backend']);
    assert.deepEqual((await s.call('GET', '/api/web/overview', { cookie: evaCookie })).json.people.map((p) => p.email).sort(), ['ana@acme.com', 'eva@acme.com']);
  } finally { await s.close(); }
});

test('a developer shows as online from their first report, and as away once the app says it is closing', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    const ana = (await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', role: 'member' } })).json;
    const person = async () => (await s.call('GET', '/api/web/overview', { cookie: admin })).json.people.find((p) => p.email === 'ana@acme.com');
    assert.equal((await person()).online, false);

    const token = (await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: ana.password } })).json.token;
    await s.call('POST', '/api/app/report', { token, body: { sessions: [{ kind: 'shell', title: 'api', repo: 'acme/api', tickets: [], active: false }] } });
    assert.equal((await person()).online, true);
    assert.equal((await person()).sessionCount, 1);

    assert.equal((await s.call('POST', '/api/app/bye', { token, body: {} })).status, 200);
    const gone = await person();
    assert.equal(gone.online, false);
    assert.equal(gone.sessionCount, 0, 'the sessions of a closed app are not shown as open');
    assert.ok(gone.lastSeen, 'when they were last seen is kept');

    // Opening the app again is online again.
    await s.call('POST', '/api/app/report', { token, body: { sessions: [] } });
    assert.equal((await person()).online, true);
    assert.equal((await s.call('POST', '/api/app/bye', { body: {} })).status, 401, 'only a signed-in device says goodbye');
  } finally { await s.close(); }
});

test('usage history: the lowest point each day, and the days the session ran out', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    const ana = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', role: 'member' } });
    const token = (await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: ana.json.password } })).json.token;
    for (const used of [40, 100, 70]) {
      await s.call('POST', '/api/app/report', { token, body: { sessions: [], accounts: [{ name: 'Work', sessionUsed: used, weekUsed: 85 }] } });
    }
    const person = (await s.call('GET', '/api/web/overview', { cookie: admin })).json.people.find((p) => p.email === 'ana@acme.com');
    assert.deepEqual(person.usageHistory, { daysRanOut: 1, lowestWeekLeft: 15, lowestSessionLeft: 0 });
  } finally { await s.close(); }
});

test('private sessions are counted and never described', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    const ana = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', role: 'member' } });
    const token = (await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: ana.json.password } })).json.token;
    await s.call('POST', '/api/app/report', { token, body: { sessions: [{ kind: 'shell', title: 'work', repo: 'acme/api', active: true }], hiddenSessions: 2 } });
    const person = (await s.call('GET', '/api/web/overview', { cookie: admin })).json.people.find((p) => p.email === 'ana@acme.com');
    assert.equal(person.hiddenSessions, 2);
    assert.equal(person.sessions.length, 1);
  } finally { await s.close(); }
});

test('retention: at least 30 days or none, and old activity goes', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    assert.equal((await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { retentionDays: 5 } })).status, 400);
    s.store.addMinutes(s.admin.id, '2020-01-01', 'repo', 'old/repo', 10);
    s.store.addDayMinutes(s.admin.id, '2020-01-01', 10);
    assert.equal((await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { retentionDays: 90 } })).status, 200);
    assert.equal(s.store.get("SELECT COUNT(*) AS n FROM activity WHERE day = '2020-01-01'").n, 0);
    assert.equal(s.store.get("SELECT COUNT(*) AS n FROM days WHERE day = '2020-01-01'").n, 0);
  } finally { await s.close(); }
});

test('a backup is a database that opens and holds the accounts', async () => {
  const s = await boot();
  try {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'org-bk-')), 'copy.db');
    s.store.backupTo(file);
    const { Store } = require('../src/db');
    const copy = new Store(file);
    assert.equal(copy.userByEmail('boss@acme.com').role, 'admin');
    copy.close();
  } finally { await s.close(); }
});

/** A WebSocket that queues what it is told, so a test can wait for the next one. */
function socket(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const inbox = [];
  const waiting = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    const w = waiting.shift();
    if (w) w(m); else inbox.push(m);
  };
  const closed = new Promise((resolve) => { ws.onclose = (event) => resolve(event); });
  return {
    ws,
    closed,
    ready: new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not connect')); }),
    next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiting.push(resolve))),
    send: (m) => ws.send(JSON.stringify(m)),
  };
}

test('the browser reaches its owner\'s session through the device, and nobody else\'s', async () => {
  const s = await boot();
  const wsBase = `ws://127.0.0.1:${s.server.address().port}`;
  const open = [];
  try {
    const admin = await s.webLogin();
    const ana = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', role: 'member' } });
    const login = await s.call('POST', '/api/app/login', { body: { email: 'ana@acme.com', password: ana.json.password, device: 'Ana Mac' } });
    assert.equal(login.json.policy.webTerminal, true);

    const device = socket(`${wsBase}/api/app/relay`);
    open.push(device);
    await device.ready;
    device.send({ t: 'hello', token: login.json.token });
    assert.equal((await device.next()).t, 'welcome');
    device.send({ t: 'sessions', list: [{ id: 's1', title: 'API', kind: 'claude', folder: 'api', repo: 'acme/api' }] });
    await new Promise((r) => setTimeout(r, 50));

    const anaWeb = await s.webLogin('ana@acme.com', ana.json.password);
    const list = (await s.call('GET', '/api/web/terminals', { cookie: anaWeb })).json;
    assert.equal(list.devices.length, 1);
    assert.equal(list.devices[0].label, 'Ana Mac');
    assert.deepEqual(list.devices[0].sessions.map((x) => x.title), ['API']);
    assert.equal((await s.call('GET', '/api/web/terminals', { cookie: admin })).json.devices.length, 0, 'an administrator does not see Ana\'s devices');

    const url = `${wsBase}/api/web/terminal?device=${list.devices[0].id}&session=s1`;
    const stranger = socket(url, { cookie: admin, origin: 'http://localhost:1' });
    open.push(stranger);
    await assert.rejects(stranger.ready, 'an administrator cannot open Ana\'s session');
    const elsewhere = socket(url, { cookie: anaWeb, origin: 'https://evil.example' });
    open.push(elsewhere);
    await assert.rejects(elsewhere.ready, 'a page on another site cannot either');

    const browser = socket(url, { cookie: anaWeb, origin: 'http://localhost:1' });
    open.push(browser);
    await browser.ready;
    const asked = await device.next();
    assert.equal(asked.t, 'open');
    assert.equal(asked.session, 's1');
    device.send({ t: 'opened', ch: asked.ch, cols: 100, rows: 30, title: 'API', replay: 'hello\r\n' });
    assert.deepEqual(await browser.next(), { t: 'opened', cols: 100, rows: 30, title: 'API', replay: 'hello\r\n' });
    browser.send({ t: 'in', data: 'ls\r' });
    assert.deepEqual(await device.next(), { t: 'in', ch: asked.ch, data: 'ls\r' });
    device.send({ t: 'out', ch: asked.ch, data: 'README.md\r\n' });
    assert.deepEqual(await browser.next(), { t: 'out', data: 'README.md\r\n' });

    browser.send({ t: 'resize', cols: 46, rows: 25 });
    assert.deepEqual(await device.next(), { t: 'resize', ch: asked.ch, cols: 46, rows: 25 });
    browser.send({ t: 'resize', release: true });
    assert.deepEqual(await device.next(), { t: 'resize', ch: asked.ch, release: true });

    browser.ws.close();
    assert.deepEqual(await device.next(), { t: 'close', ch: asked.ch });
    const log = (await s.call('GET', '/api/admin/audit', { cookie: admin })).json.entries;
    assert.ok(log.some((e) => e.action === 'terminal.opened' && e.target === 'Ana Mac'));

    // Turned off by the company: the device is let go at once.
    await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { webTerminal: false } });
    assert.equal((await device.closed).code, 4003);
  } finally {
    for (const o of open) try { o.ws.close(); } catch {}
    s.server.closeAllConnections?.();
    await s.close();
  }
});

test('a device that does not say who it is, or says it wrongly, is let go', async () => {
  const s = await boot();
  try {
    const device = socket(`ws://127.0.0.1:${s.server.address().port}/api/app/relay`);
    await device.ready;
    device.send({ t: 'hello', token: 'nope.nope' });
    assert.equal((await device.closed).code, 4001);
  } finally { s.server.closeAllConnections?.(); await s.close(); }
});

/** A pty that echoes what it is typed, and remembers how it was started. */
function fakePty() {
  const started = [];
  const spawn = (file, args, opts) => {
    let onData = () => {};
    let onExit = () => {};
    const pty = {
      file, args, opts, killed: false, size: [opts.cols, opts.rows],
      onData: (fn) => { onData = fn; },
      onExit: (fn) => { onExit = fn; },
      write: (data) => onData(`echo:${data}`),
      resize: (cols, rows) => { pty.size = [cols, rows]; },
      kill: () => { pty.killed = true; },
      exit: (exitCode = 0) => onExit({ exitCode }),
      print: (data) => onData(data),
    };
    started.push(pty);
    return pty;
  };
  return { spawn, started };
}

test('shells on the server: off until the operator and an administrator both say so, and only ever their owner\'s', async () => {
  const pty = fakePty();
  const s = await boot(null, { shellCommand: 'docker run --rm -it "home {user}" img', spawnPty: pty.spawn });
  const wsBase = `ws://127.0.0.1:${s.server.address().port}`;
  const open = [];
  try {
    const admin = await s.webLogin();
    const ana = await s.call('POST', '/api/admin/users', { cookie: admin, body: { email: 'ana@acme.com', role: 'member' } });
    const anaWeb = await s.webLogin('ana@acme.com', ana.json.password);

    // Off by default, even with the operator's command set.
    assert.equal((await s.call('GET', '/api/web/shells', { cookie: anaWeb })).json.allowed, false);
    assert.equal((await s.call('POST', '/api/web/shells', { cookie: anaWeb, body: {} })).status, 403);
    const settings = (await s.call('GET', '/api/admin/settings', { cookie: admin })).json;
    assert.equal(settings.serverShells, 'off');
    assert.equal(settings.shellsAvailable, true);
    assert.equal((await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { serverShells: 'root' } })).status, 400);

    // For administrators only: Ana still cannot.
    await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { serverShells: 'admins' } });
    assert.equal((await s.call('POST', '/api/web/shells', { cookie: anaWeb, body: {} })).status, 403);

    await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { serverShells: 'everyone' } });
    const made = await s.call('POST', '/api/web/shells', { cookie: anaWeb, body: { cols: 90, rows: 20, name: 'Build' } });
    assert.equal(made.status, 200);
    const shell = made.json.shell;
    assert.equal(shell.name, 'Build');
    const started = pty.started[0];
    const anaId = (await s.call('GET', '/api/web/me', { cookie: anaWeb })).json?.user?.id;
    assert.equal(started.file, 'docker');
    assert.deepEqual(started.args.slice(0, 3), ['run', '--rm', '-it']);
    assert.match(started.args[3], /^home [0-9a-f-]{36}$/, '{user} becomes the person\'s id');
    if (anaId) assert.equal(started.args[3], `home ${anaId}`);
    assert.equal(started.opts.env.ORG_DB, undefined, 'nothing of the server\'s own reaches the shell');
    assert.deepEqual(Object.keys(started.opts.env).sort(), ['COLORTERM', 'HOME', 'LANG', 'PATH', 'SMART_TERMINAL_USER', 'TERM']);
    started.print('ready$ ');

    // Only Ana sees it, and only Ana can open or close it.
    assert.equal((await s.call('GET', '/api/web/shells', { cookie: anaWeb })).json.shells.length, 1);
    assert.equal((await s.call('GET', '/api/web/shells', { cookie: admin })).json.shells.length, 0);
    assert.equal((await s.call('DELETE', `/api/web/shells/${shell.id}`, { cookie: admin })).status, 404);
    const url = `${wsBase}/api/web/shell?id=${shell.id}`;
    const stranger = socket(url, { cookie: admin, origin: 'http://localhost:1' });
    open.push(stranger);
    await assert.rejects(stranger.ready, 'an administrator cannot open Ana\'s shell');
    const elsewhere = socket(url, { cookie: anaWeb, origin: 'https://evil.example' });
    open.push(elsewhere);
    await assert.rejects(elsewhere.ready, 'a page on another site cannot either');

    const browser = socket(url, { cookie: anaWeb, origin: 'http://localhost:1' });
    open.push(browser);
    await browser.ready;
    assert.deepEqual(await browser.next(), { t: 'opened', cols: 90, rows: 20, title: 'Build', replay: 'ready$ ' });
    browser.send({ t: 'in', data: 'ls\r' });
    assert.deepEqual(await browser.next(), { t: 'out', data: 'echo:ls\r' });
    browser.send({ t: 'resize', cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(started.size, [120, 40]);

    // Closing the tab leaves it running; narrowing the setting ends it.
    browser.ws.close();
    await browser.closed;
    assert.equal(started.killed, false);
    await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { serverShells: 'admins' } });
    assert.equal(started.killed, true);
    assert.equal((await s.call('GET', '/api/web/shells', { cookie: anaWeb })).json.shells.length, 0);

    const log = (await s.call('GET', '/api/admin/audit', { cookie: admin })).json.entries;
    assert.ok(log.some((e) => e.action === 'shell.started'));
    assert.ok(log.some((e) => e.action === 'shell.ended'));
  } finally {
    for (const o of open) try { o.ws.close(); } catch {}
    s.server.closeAllConnections?.();
    await s.close();
  }
});

test('no shells without the operator\'s command, whatever the setting says', async () => {
  const s = await boot();
  try {
    const admin = await s.webLogin();
    await s.call('PUT', '/api/admin/settings', { cookie: admin, body: { serverShells: 'everyone' } });
    assert.equal((await s.call('GET', '/api/web/shells', { cookie: admin })).json.allowed, false);
    assert.equal((await s.call('POST', '/api/web/shells', { cookie: admin, body: {} })).status, 403);
    const settings = (await s.call('GET', '/api/admin/settings', { cookie: admin })).json;
    assert.equal(settings.shellsAvailable, false);
    assert.match(settings.shellsWhy, /ORG_SHELL_COMMAND/);
  } finally { await s.close(); }
});

test('a shell command is split like a shell would, quotes kept together', () => {
  const { splitCommand } = require('../src/shells');
  assert.deepEqual(splitCommand('docker run -v "home {user}:/home/dev" \'img x\''), ['docker', 'run', '-v', 'home {user}:/home/dev', 'img x']);
  assert.deepEqual(splitCommand(''), []);
});
