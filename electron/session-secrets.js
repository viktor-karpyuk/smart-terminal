'use strict';

const crypto = require('node:crypto');

/**
 * What each session knows that no other session does.
 *
 * A session used to prove who it was by saying so. `from` is an id, and the
 * roster hands every session the id of every other one, so any session could
 * speak as any other: borrow its rate limit, hide behind its refusals, put its
 * name on a question shown to the person. The app now hands each session a
 * random secret when it starts it — in that session's own environment, in no
 * roster and in no answer — and the bridge asks for it.
 *
 * What this is and is not. It stops a session from being another one by
 * knowing its id, which is everything the review found. It does not make
 * sessions strangers: they are the same user's processes, and a process that
 * can read another's environment (`ps eww`, `/proc/<pid>/environ`) can read its
 * secret. That is deliberate hostility, not a mistake a model makes, and the
 * rest of what a session can do to another one is already open to it. The app
 * keeps only a digest, so a memory dump of the app does not hand out every
 * session's secret either.
 */
class SessionSecrets {
  constructor() {
    /** session id → sha256 of its secret */
    this.map = new Map();
  }

  /** A new secret for a session that is starting, replacing any it had. An id-less session has nothing to prove. */
  issue(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId : '';
    if (!id) return '';
    const secret = crypto.randomBytes(16).toString('hex');
    this.map.set(id, digest(secret));
    return secret;
  }

  /** Whether this is the secret that session was given. Compared as digests, so neither length nor content shows in the time it takes. */
  verify(sessionId, secret) {
    if (typeof sessionId !== 'string' || typeof secret !== 'string' || !secret) return false;
    const known = this.map.get(sessionId);
    if (!known) return false;
    return crypto.timingSafeEqual(known, digest(secret));
  }

  forget(sessionId) {
    this.map.delete(sessionId);
  }
}

const digest = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

module.exports = { SessionSecrets };
