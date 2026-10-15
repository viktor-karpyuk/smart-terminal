'use strict';

/** Passwords, and a brake on guessing them. */
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // Same work as a real check, so a missing account takes as long as a wrong password.
    await scrypt('x', 'saltsaltsaltsalt', PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p });
    return false;
  }
  const [, N, r, p, salt, key] = parts;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(got, want);
}

/** A password an administrator can hand over: long, and nothing to misread. */
function makePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(18);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out.match(/.{1,6}/g).join('-');
}

function passwordProblem(password) {
  const text = String(password ?? '');
  if (text.length < 10) return 'A password needs at least 10 characters.';
  if (text.length > 200) return 'That password is too long.';
  return null;
}

/** At most `limit` tries per key in `windowMs`. */
function limiter({ limit = 10, windowMs = 15 * 60_000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
    reset(key) { hits.delete(key); },
  };
}

module.exports = { hashPassword, checkPassword, makePassword, passwordProblem, limiter };
