'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPair, exportJWK, SignJWT } = require('jose');
const { keyring, OPENID_CONFIG } = require('../src/auth');
const { relay, configFrom, MAX_JSON } = require('../src/relay');

const APP_ID = '11111111-2222-3333-4444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE = 'https://smba.trafficmanager.net/amer/';
const NOW = Date.parse('2026-09-24T22:00:00Z');
const config = configFrom({ MicrosoftAppId: APP_ID, MicrosoftAppTenantId: TENANT });

async function setup({ endorsements = ['msteams', 'webchat'] } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', endorsements };
  let fetches = 0;
  const fetch = async (url) => {
    fetches += 1;
    if (url === OPENID_CONFIG) return { ok: true, json: async () => ({ jwks_uri: 'https://keys.example/jwks' }) };
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
  const keys = keyring({ fetch, now: () => NOW });
  const sign = (claims = {}, { kid = 'k1', key = privateKey } = {}) =>
    new SignJWT({ serviceurl: SERVICE, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(claims.iss ?? 'https://api.botframework.com')
      .setAudience(claims.aud ?? APP_ID)
      .setIssuedAt(NOW / 1000 - 60)
      .setExpirationTime(NOW / 1000 + 3600)
      .sign(key);
  return { keys, sign, fetches: () => fetches };
}

const activity = (over = {}) => ({
  type: 'message',
  id: 'act-1',
  text: 'hola',
  channelId: 'msteams',
  serviceUrl: SERVICE,
  conversation: { id: 'a:conv', tenantId: TENANT },
  from: { id: '29:user', aadObjectId: 'user-oid' },
  channelData: { tenant: { id: TENANT } },
  ...over,
});

const call = async (env, token, body) =>
  relay({ authorization: token && `Bearer ${token}`, body: JSON.stringify(body), config, keys: env.keys, now: () => NOW });

test('a signed Teams message from this organisation goes on the queue whole', async () => {
  const env = await setup();
  const result = await call(env, await env.sign(), activity());
  assert.equal(result.status, 200);
  const queued = JSON.parse(result.enqueue);
  assert.equal(queued.activity.text, 'hola');
  assert.equal(queued.receivedAt, new Date(NOW).toISOString());
});

test('no token, a foreign audience, a foreign issuer or a foreign key is refused', async () => {
  const env = await setup();
  assert.equal((await call(env, null, activity())).status, 401);
  assert.equal((await call(env, await env.sign({ aud: 'another-bot' }), activity())).status, 401);
  assert.equal((await call(env, await env.sign({ iss: 'https://evil.example' }), activity())).status, 401);
  const stranger = (await generateKeyPair('RS256')).privateKey;
  assert.equal((await call(env, await env.sign({}, { key: stranger }), activity())).status, 401);
  assert.equal((await call(env, await env.sign({}, { kid: 'unknown' }), activity())).status, 401);
});

test('an activity that names another service than its token is refused', async () => {
  const env = await setup();
  const result = await call(env, await env.sign(), activity({ serviceUrl: 'https://evil.example/' }));
  assert.equal(result.status, 401);
  assert.match(result.reason, /different service/);
});

test('a key not endorsed for the channel is refused', async () => {
  const env = await setup({ endorsements: ['skype'] });
  const result = await call(env, await env.sign(), activity());
  assert.equal(result.status, 401);
  assert.match(result.reason, /endorsed/);
});

test('a message from another organisation is refused even when signed', async () => {
  const env = await setup();
  const other = activity({ channelData: { tenant: { id: 'ffffffff-0000-0000-0000-000000000000' } }, conversation: { id: 'x' } });
  assert.equal((await call(env, await env.sign(), other)).status, 403);
});

test('a channel that is not let through is refused', async () => {
  const env = await setup({ endorsements: ['slack'] });
  const result = await call(env, await env.sign(), activity({ channelId: 'slack' }));
  assert.equal(result.status, 403);
});

test('what is not an activity is a 400, before any key is fetched', async () => {
  const env = await setup();
  assert.equal((await relay({ authorization: 'Bearer x', body: 'not json', config, keys: env.keys })).status, 400);
  assert.equal((await call(env, 'x', { type: 'message' })).status, 400);
  assert.equal(env.fetches(), 0);
});

test('keys are fetched once, not once per message', async () => {
  const env = await setup();
  const token = await env.sign();
  await call(env, token, activity());
  await call(env, token, activity());
  await call(env, token, activity());
  assert.equal(env.fetches(), 2);
});

test('an oversized message loses its attachments and says so, instead of being dropped', async () => {
  const env = await setup();
  const big = activity({ attachments: [{ contentType: 'x', content: 'y'.repeat(MAX_JSON) }] });
  const result = await call(env, await env.sign(), big);
  assert.equal(result.status, 200);
  const queued = JSON.parse(result.enqueue);
  assert.ok(Buffer.byteLength(result.enqueue) <= MAX_JSON);
  assert.equal(queued.activity.truncated, true);
  assert.equal(queued.activity.text, 'hola');
});

test('without an app id and tenant the relay will not start', () => {
  assert.throws(() => configFrom({}), /MicrosoftAppId/);
});
