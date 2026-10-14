'use strict';

/**
 * Signing in with Microsoft, Google, or any OpenID Connect provider.
 *
 * Authorization code flow with PKCE, a state and a nonce. The ID token is
 * checked here, with nothing taken on trust: its signature against the
 * provider's published keys, its issuer, its audience, its expiry and the
 * nonce this server sent. Only then is its e-mail address read, and only a
 * verified one is accepted.
 */
const crypto = require('node:crypto');

/** What a provider needs, with Microsoft and Google filled in. */
function issuerFor(provider) {
  if (provider.type === 'microsoft') return `https://login.microsoftonline.com/${provider.tenant || 'organizations'}/v2.0`;
  if (provider.type === 'google') return 'https://accounts.google.com';
  return String(provider.issuer || '').replace(/\/+$/, '');
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

function client({ fetch, now = Date.now }) {
  const discovered = new Map();
  const keys = new Map();

  async function discover(provider) {
    const issuer = issuerFor(provider);
    const held = discovered.get(issuer);
    if (held && now() - held.at < 3_600_000) return held.doc;
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`the provider's configuration answered ${res.status}`);
    const doc = await res.json();
    discovered.set(issuer, { at: now(), doc });
    return doc;
  }

  async function keyFor(doc, kid, { refresh = false } = {}) {
    let held = keys.get(doc.jwks_uri);
    if (!held || refresh || now() - held.at > 3_600_000) {
      const res = await fetch(doc.jwks_uri);
      if (!res.ok) throw new Error(`the provider's keys answered ${res.status}`);
      held = { at: now(), keys: (await res.json()).keys ?? [] };
      keys.set(doc.jwks_uri, held);
    }
    return held.keys.find((key) => key.kid === kid) ?? null;
  }

  /** Where to send the browser, and what to keep until it comes back. */
  async function start(provider, redirectUri) {
    const doc = await discover(provider);
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const { verifier, challenge } = pkce();
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return { url: url.toString(), state, keep: { nonce, verifier, redirectUri } };
  }

  /** The code the provider sent back, exchanged and checked. Returns who it is. */
  async function finish(provider, code, keep) {
    const doc = await discover(provider);
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: keep.redirectUri,
        client_id: provider.clientId,
        client_secret: provider.clientSecret || '',
        code_verifier: keep.verifier,
      }).toString(),
    });
    const tokens = await res.json().catch(() => ({}));
    if (!res.ok || !tokens.id_token) throw new Error(tokens.error_description || `the provider answered ${res.status}`);
    const claims = await verifyIdToken(doc, provider, tokens.id_token, keep.nonce);
    const email = String(claims.email || claims.preferred_username || '').toLowerCase();
    // Google says whether the address was verified; Microsoft's organizational
    // accounts are the tenant's own, so their address is the account.
    const verified = claims.email_verified === true || claims.email_verified === 'true' || provider.type === 'microsoft';
    if (!email.includes('@') || !verified) throw new Error('The provider did not vouch for an e-mail address.');
    return { email, name: String(claims.name || '').slice(0, 120), subject: String(claims.sub || '') };
  }

  async function verifyIdToken(doc, provider, token, nonce) {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || !s) throw new Error('The ID token is not a JWT.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (header.alg !== 'RS256') throw new Error(`The ID token is signed with ${header.alg}, not RS256.`);
    let jwk = await keyFor(doc, header.kid);
    if (!jwk) jwk = await keyFor(doc, header.kid, { refresh: true });
    if (!jwk) throw new Error('The ID token is signed with a key the provider does not publish.');
    const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) throw new Error('The ID token signature does not verify.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    const seconds = now() / 1000;
    // Microsoft's multi-tenant discovery publishes "{tenantid}" in its issuer.
    const issuer = String(doc.issuer).replace('{tenantid}', claims.tid ?? '');
    if (claims.iss !== issuer) throw new Error('The ID token is from another issuer.');
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(provider.clientId)) throw new Error('The ID token is for another application.');
    if (!(claims.exp > seconds - 60)) throw new Error('The ID token has expired.');
    if (claims.nonce !== nonce) throw new Error('The ID token answers a different sign-in.');
    if (provider.type === 'microsoft' && provider.tenant && !['organizations', 'common'].includes(provider.tenant) && claims.tid !== provider.tenant) {
      throw new Error('That account belongs to another organization.');
    }
    return claims;
  }

  return { start, finish, verifyIdToken, discover };
}

module.exports = { client, issuerFor, pkce };
