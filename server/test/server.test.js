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

async function boot(idp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-'));
  const realFetch = globalThis.fetch;
  const { server, store } = createServer({ dbFile: path.join(dir, 'org.db'), publicUrl: 'http://localhost:1', fetch: idp ? idp.fetch : realFetch });
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
    assert.equal((await s.call('GET', '/api/web/overview', { cookie: mia })).status, 403, 'the team view is the administrators\'');
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
    assert.match(csv.text, /^date,name,email,what,key,minutes\n/);
    assert.match(csv.text, /repo,acme\/api,2/);
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
