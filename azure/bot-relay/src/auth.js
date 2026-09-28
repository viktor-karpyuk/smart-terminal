'use strict';

/**
 * Is this request really Teams talking to our bot?
 *
 * The messaging endpoint is a public URL, so anybody can POST to it. Only a
 * request signed by the Bot Framework, addressed to this bot's app id, is let
 * through to the queue; everything else would be somebody typing into
 * Smart Terminal from the internet.
 *
 * The rules are the Bot Framework's own for a channel talking to a bot:
 * https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
 */

const { jwtVerify, importJWK, decodeProtectedHeader } = require('jose');

const OPENID_CONFIG = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const ISSUER = 'https://api.botframework.com';
const DAY = 24 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

class AuthError extends Error {}

/**
 * The Bot Framework's signing keys, fetched once a day. An unknown key id gets
 * one early refresh, because keys roll over; asking again on every unknown id
 * would let anybody make us hammer the key endpoint.
 */
function keyring({ fetch, now = Date.now }) {
  let held = null;
  let refreshing = null;

  async function load() {
    const config = await fetch(OPENID_CONFIG);
    if (!config.ok) throw new Error(`the Bot Framework's OpenID configuration answered ${config.status}`);
    const { jwks_uri: jwksUri } = await config.json();
    const keys = await fetch(jwksUri);
    if (!keys.ok) throw new Error(`the Bot Framework's signing keys answered ${keys.status}`);
    const { keys: list = [] } = await keys.json();
    held = { at: now(), keys: new Map(list.map((key) => [key.kid, key])) };
  }

  const refresh = () => {
    refreshing ??= load().finally(() => { refreshing = null; });
    return refreshing;
  };

  return {
    async find(kid) {
      if (!held || now() - held.at > DAY) await refresh();
      let key = held.keys.get(kid);
      if (!key && now() - held.at > FIVE_MINUTES) {
        await refresh();
        key = held.keys.get(kid);
      }
      return key;
    },
  };
}

/**
 * Throws an AuthError saying what was wrong, or returns the token's claims.
 */
async function verify({ authorization, activity, appId, keys, now = Date.now }) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(authorization ?? ''));
  if (!match) throw new AuthError('no bearer token');
  const token = match[1];

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new AuthError('the token is not a JWT');
  }
  if (header.alg !== 'RS256') throw new AuthError(`the token is signed with ${header.alg}, not RS256`);

  const jwk = await keys.find(header.kid);
  if (!jwk) throw new AuthError('the token is signed with a key the Bot Framework does not publish');

  // A key is endorsed for the channels it may sign for. A key for another
  // channel signing a Teams message is not Teams.
  if (Array.isArray(jwk.endorsements) && !jwk.endorsements.includes(activity.channelId)) {
    throw new AuthError(`the signing key is not endorsed for ${activity.channelId}`);
  }

  const key = await importJWK({ kty: jwk.kty, n: jwk.n, e: jwk.e }, 'RS256');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: appId,
      algorithms: ['RS256'],
      clockTolerance: 300,
      currentDate: new Date(now()),
    }));
  } catch (error) {
    throw new AuthError(`the token does not verify: ${error.code || error.message}`);
  }

  // The token names the service it came from; an activity claiming to come
  // from somewhere else would have us answer to an address it chose.
  const claimed = payload.serviceurl ?? payload.serviceUrl;
  if (claimed && trimSlash(claimed) !== trimSlash(activity.serviceUrl)) {
    throw new AuthError('the activity names a different service than its token');
  }
  return payload;
}

const trimSlash = (url) => String(url ?? '').replace(/\/+$/, '');

module.exports = { keyring, verify, AuthError, ISSUER, OPENID_CONFIG };
