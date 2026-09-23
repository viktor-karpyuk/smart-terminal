'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Where the Teams extension keeps what it knows.
 *
 * Its own tables and its own version counter, in the app's database beside the
 * reviewer's: two extensions sharing one file is fine, two extensions sharing a
 * migration counter is a build of one silently running the other's migrations.
 *
 * Nothing here is about pull requests, builds or clusters. A person, an app
 * that asked, a message and what became of it — the whole point of this being
 * an extension of its own is that it can be handed anything.
 */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tm_setting (k TEXT PRIMARY KEY, v TEXT);
   CREATE TABLE IF NOT EXISTS tm_person (
     id TEXT PRIMARY KEY,
     /* How an extension names them: 'bitbucket:bchavez', 'github:viktor', 'email:a@b.c', 'rota:payments'. */
     handle TEXT NOT NULL UNIQUE,
     display TEXT NOT NULL DEFAULT '',
     /* Who they are in Teams. Null until somebody or something works it out. */
     address TEXT,
     /* EMAIL when matched by address on its own, HAND when a person chose. */
     matched_by TEXT,
     last_sent_at TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS tm_app (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL DEFAULT '',
     /* ALLOW, ASK (stop and show me), DENY. A new one starts at ASK. */
     stance TEXT NOT NULL DEFAULT 'ASK',
     daily_cap INTEGER NOT NULL DEFAULT 5,
     first_seen_at TEXT NOT NULL,
     last_asked_at TEXT
   );
   CREATE TABLE IF NOT EXISTS tm_message (
     id TEXT PRIMARY KEY,
     app_id TEXT NOT NULL,
     /* The sender's own idea of what this message is about; the same one is never sent twice. */
     dedupe_key TEXT,
     person_id TEXT,
     to_label TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL DEFAULT '',
     payload TEXT NOT NULL DEFAULT '{}',
     /* WAITING (for you), SENDING (in flight), SENT, FAILED, HELD (a repeat, or out of hours), SKIPPED */
     state TEXT NOT NULL,
     reason TEXT,
     created_at TEXT NOT NULL,
     sent_at TEXT,
     attempts INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS tm_message_when ON tm_message(created_at DESC);
   CREATE INDEX IF NOT EXISTS tm_message_key ON tm_message(dedupe_key, state)`,
];

const now = () => new Date().toISOString();
const nul = (value) => (value === undefined || value === '' ? null : value);

const personRow = (row) =>
  row && {
    id: row.id,
    handle: row.handle,
    display: row.display || row.handle,
    address: row.address ?? null,
    matchedBy: row.matched_by ?? null,
    lastSentAt: row.last_sent_at ?? null,
  };

const appRow = (row) =>
  row && {
    id: row.id,
    name: row.name || row.id,
    stance: row.stance,
    dailyCap: Number(row.daily_cap) || 0,
    firstSeenAt: row.first_seen_at,
    lastAskedAt: row.last_asked_at ?? null,
  };

const messageRow = (row) =>
  row && {
    id: row.id,
    appId: row.app_id,
    key: row.dedupe_key ?? null,
    personId: row.person_id ?? null,
    to: row.to_label,
    title: row.title,
    body: row.body,
    payload: JSON.parse(row.payload || '{}'),
    state: row.state,
    reason: row.reason ?? null,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? null,
    attempts: Number(row.attempts) || 0,
  };

class TeamsStore {
  constructor(db, secrets) {
    this.db = db;
    this.secrets = secrets ?? {
      encrypt: (text) => Buffer.from(text).toString('base64'),
      decrypt: (cipher) => Buffer.from(cipher, 'base64').toString(),
    };
    this.#migrate();
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS tm_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM tm_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO tm_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) {
      throw new Error(`The Teams tables are at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    }
    for (let version = row.version; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE tm_schema SET version = ?').run(version + 1);
      });
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  // --- settings --------------------------------------------------------------

  setting(key, fallback = null) {
    const row = this.get('SELECT v FROM tm_setting WHERE k = ?', key);
    return row ? row.v : fallback;
  }

  setSetting(key, value) {
    if (value === null || value === undefined) this.run('DELETE FROM tm_setting WHERE k = ?', key);
    else this.run('INSERT INTO tm_setting (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, String(value));
  }

  /** A secret goes in encrypted and never comes back out to a panel. */
  setSecret(key, value) {
    if (!value) { this.run('DELETE FROM tm_setting WHERE k = ?', key); return; }
    this.setSetting(key, this.secrets.encrypt(String(value)));
  }

  secret(key) {
    const stored = this.setting(key);
    if (!stored) return null;
    try {
      return this.secrets.decrypt(stored);
    } catch {
      // A machine that cannot read its own keychain must not send with a
      // half-remembered secret; it says nothing rather than guessing.
      return null;
    }
  }

  // --- people ----------------------------------------------------------------

  people() {
    return this.all('SELECT * FROM tm_person ORDER BY display COLLATE NOCASE, handle').map(personRow);
  }

  person(handle) {
    return personRow(this.get('SELECT * FROM tm_person WHERE handle = ?', String(handle)));
  }

  /** Remember somebody an extension named, whether or not we can reach them yet. */
  rememberPerson({ handle, display = '', address = null, matchedBy = null }) {
    const existing = this.get('SELECT * FROM tm_person WHERE handle = ?', String(handle));
    if (existing) {
      /*
       * A choice outranks a guess.
       *
       * This used to take whatever address was passed, so a send that could
       * work one out from the handle overwrote one somebody had picked by hand
       * — while the row went on saying "matched by you". A guess fills an empty
       * seat and never takes an occupied one.
       */
      const keepAddress = existing.matched_by === 'HAND' || !address;
      this.run(
        'UPDATE tm_person SET display = COALESCE(NULLIF(?, \'\'), display), address = COALESCE(?, address), matched_by = COALESCE(?, matched_by) WHERE id = ?',
        display, keepAddress ? null : nul(address), keepAddress ? null : nul(matchedBy), existing.id,
      );
      return this.person(handle);
    }
    this.run(
      'INSERT INTO tm_person (id, handle, display, address, matched_by, created_at) VALUES (?,?,?,?,?,?)',
      randomUUID(), String(handle), display || String(handle), nul(address), nul(matchedBy), now(),
    );
    return this.person(handle);
  }

  /** A person matched by hand; the choice outranks anything worked out later. */
  matchPerson(handle, address) {
    this.rememberPerson({ handle });
    this.run('UPDATE tm_person SET address = ?, matched_by = ? WHERE handle = ?', nul(address), address ? 'HAND' : null, String(handle));
    return this.person(handle);
  }

  notePersonSent(handle) {
    this.run('UPDATE tm_person SET last_sent_at = ? WHERE handle = ?', now(), String(handle));
  }

  // --- the extensions that ask ------------------------------------------------

  apps() {
    return this.all('SELECT * FROM tm_app ORDER BY name COLLATE NOCASE').map(appRow);
  }

  app(id) {
    return appRow(this.get('SELECT * FROM tm_app WHERE id = ?', String(id)));
  }

  /**
   * The first time something asks, it is written down as ASK rather than
   * refused: the answer belongs to a person, and a silent refusal teaches them
   * nothing about what wanted to speak.
   */
  seeApp(id, name = '') {
    const existing = this.app(id);
    if (existing) {
      if (name && name !== existing.name) this.run('UPDATE tm_app SET name = ? WHERE id = ?', name, String(id));
      return this.app(id);
    }
    this.run('INSERT INTO tm_app (id, name, stance, daily_cap, first_seen_at) VALUES (?,?,?,?,?)',
      String(id), name || String(id), 'ASK', 5, now());
    return this.app(id);
  }

  setAppStance(id, stance) {
    this.seeApp(id);
    this.run('UPDATE tm_app SET stance = ? WHERE id = ?', stance, String(id));
    return this.app(id);
  }

  setAppCap(id, cap) {
    this.seeApp(id);
    this.run('UPDATE tm_app SET daily_cap = ? WHERE id = ?', Math.max(0, Number(cap) || 0), String(id));
    return this.app(id);
  }

  noteAppAsked(id) {
    this.run('UPDATE tm_app SET last_asked_at = ? WHERE id = ?', now(), String(id));
  }

  // --- messages ---------------------------------------------------------------

  messages({ limit = 100 } = {}) {
    return this.all('SELECT * FROM tm_message ORDER BY created_at DESC LIMIT ?', Math.max(1, Number(limit) || 100)).map(messageRow);
  }

  message(id) {
    return messageRow(this.get('SELECT * FROM tm_message WHERE id = ?', String(id)));
  }

  waiting() {
    return this.all("SELECT * FROM tm_message WHERE state = 'WAITING' ORDER BY created_at").map(messageRow);
  }

  addMessage({ appId, key = null, personId = null, to = '', title = '', body = '', payload = {}, state, reason = null }) {
    const id = randomUUID();
    this.run(
      'INSERT INTO tm_message (id, app_id, dedupe_key, person_id, to_label, title, body, payload, state, reason, created_at, sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, String(appId), nul(key), nul(personId), to, title, body, JSON.stringify(payload ?? {}), state, nul(reason), now(),
      // Only a message that has actually gone carries the time it went.
      state === 'SENT' ? now() : null,
    );
    return this.message(id);
  }

  markSent(id) {
    this.run("UPDATE tm_message SET state = 'SENT', sent_at = ?, reason = NULL, attempts = attempts + 1 WHERE id = ?", now(), String(id));
  }

  markFailed(id, reason) {
    this.run("UPDATE tm_message SET state = 'FAILED', reason = ?, attempts = attempts + 1 WHERE id = ?", String(reason ?? '').slice(0, 500), String(id));
  }

  markSkipped(id, reason) {
    this.run("UPDATE tm_message SET state = 'SKIPPED', reason = ? WHERE id = ?", String(reason ?? '').slice(0, 500), String(id));
  }

  /**
   * Whether this exact thing has already been said.
   *
   * Only a message that actually went counts: one that failed, or that is still
   * waiting for somebody to press Send, has not been said to anybody yet.
   */
  alreadySent(key, withinMs, at = Date.now()) {
    if (!key) return null;
    const since = new Date(at - withinMs).toISOString();
    return messageRow(this.get(
      "SELECT * FROM tm_message WHERE dedupe_key = ? AND state = 'SENT' AND sent_at >= ? ORDER BY sent_at DESC LIMIT 1",
      String(key), since,
    ));
  }

  /** How many this app has actually sent since a moment. */
  sentSince(appId, sinceIso) {
    const row = this.get("SELECT COUNT(*) AS n FROM tm_message WHERE app_id = ? AND state = 'SENT' AND sent_at >= ?", String(appId), sinceIso);
    return Number(row?.n) || 0;
  }

  /** How many one person has had since a moment, whoever sent them. */
  sentToSince(personId, sinceIso) {
    if (!personId) return 0;
    const row = this.get("SELECT COUNT(*) AS n FROM tm_message WHERE person_id = ? AND state = 'SENT' AND sent_at >= ?", String(personId), sinceIso);
    return Number(row?.n) || 0;
  }
}

module.exports = { TeamsStore, MIGRATIONS, personRow, appRow, messageRow };
