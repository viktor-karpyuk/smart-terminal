'use strict';

/**
 * Everything the server keeps, in one SQLite file.
 *
 * Secrets are never stored as themselves: passwords as scrypt hashes, tokens
 * and invite codes as SHA-256 of the random value handed out. A stolen copy of
 * this file signs nobody in.
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  pass_hash TEXT,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE TABLE IF NOT EXISTS pending (
  state TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('device', 'web')),
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (
  token_id TEXT PRIMARY KEY REFERENCES tokens(id),
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('repo', 'ticket')),
  key TEXT NOT NULL,
  minutes REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind, key)
);
CREATE TABLE IF NOT EXISTS days (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  minutes REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS audit (
  at INTEGER NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
CREATE TABLE IF NOT EXISTS usage_days (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  account TEXT NOT NULL,
  session_left_min INTEGER,
  week_left_min INTEGER,
  ran_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, account)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

class Store {
  constructor(file, { now = Date.now } = {}) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // Columns added after the first release, added to a database made before them.
    const userColumns = new Set(this.all('PRAGMA table_info(users)').map((c) => c.name));
    if (!userColumns.has('team')) this.db.exec("ALTER TABLE users ADD COLUMN team TEXT NOT NULL DEFAULT ''");
    // The teams a person leads, as a JSON list of team names: a lead sees and looks after those teams' people.
    if (!userColumns.has('leads')) this.db.exec("ALTER TABLE users ADD COLUMN leads TEXT NOT NULL DEFAULT '[]'");
    this.now = now;
  }

  close() { this.db.close(); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }

  // --- settings ------------------------------------------------------------
  setting(key, fallback = null) {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  // --- users -------------------------------------------------------------------
  userByEmail(email) { return this.get('SELECT * FROM users WHERE email = ?', String(email).trim().toLowerCase()); }
  user(id) { return this.get('SELECT * FROM users WHERE id = ?', id); }
  users() { return this.all('SELECT * FROM users ORDER BY role, name, email'); }
  createUser({ email, name = '', role, passHash = null }) {
    const id = crypto.randomUUID();
    this.run('INSERT INTO users (id, email, name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, String(email).trim().toLowerCase(), String(name).trim(), role, passHash, this.now());
    return this.user(id);
  }
  setPassword(userId, passHash) { this.run('UPDATE users SET pass_hash = ? WHERE id = ?', passHash, userId); }
  updateUser(userId, { name, role, team, leads }) {
    if (leads !== undefined) this.run('UPDATE users SET leads = ? WHERE id = ?', JSON.stringify(leads), userId);
    if (team !== undefined) this.run('UPDATE users SET team = ? WHERE id = ?', String(team).trim().slice(0, 60), userId);
    if (name !== undefined) this.run('UPDATE users SET name = ? WHERE id = ?', String(name).trim(), userId);
    if (role !== undefined) this.run('UPDATE users SET role = ? WHERE id = ?', role, userId);
  }
  tokensOf(userId) {
    return this.all('SELECT id, kind, label, created_at, last_seen_at FROM tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC', userId, this.now());
  }
  setDisabled(userId, disabled) {
    this.run('UPDATE users SET disabled_at = ? WHERE id = ?', disabled ? this.now() : null, userId);
    if (disabled) this.run('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', this.now(), userId);
  }

  // --- short-lived things: an SSO sign-in in flight, a code waiting for the app --
  putPending(state, kind, data, ttlMs) {
    this.run('DELETE FROM pending WHERE expires_at < ?', this.now());
    this.run('INSERT INTO pending (state, kind, data, expires_at) VALUES (?, ?, ?, ?)', sha256(state), kind, JSON.stringify(data), this.now() + ttlMs);
  }
  /** Taken once: a second read of the same state finds nothing. */
  takePending(state, kind) {
    const row = this.get('SELECT * FROM pending WHERE state = ? AND kind = ?', sha256(state), kind);
    if (!row) return null;
    this.run('DELETE FROM pending WHERE state = ?', sha256(state));
    return row.expires_at < this.now() ? null : JSON.parse(row.data);
  }

  // --- tokens ----------------------------------------------------------------
  issueToken(userId, { kind, label = '', days }) {
    const secret = crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    this.run('INSERT INTO tokens (id, user_id, hash, kind, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, userId, sha256(secret), kind, String(label).slice(0, 120), this.now(), this.now(), this.now() + days * 86_400_000);
    return { id, secret: `${id}.${secret}` };
  }
  /** The token's row and its user, if the token is live. */
  resolveToken(value, kind) {
    const [id, secret] = String(value ?? '').split('.');
    if (!id || !secret) return null;
    const row = this.get('SELECT * FROM tokens WHERE id = ?', id);
    if (!row || row.kind !== kind || row.revoked_at || row.expires_at < this.now()) return null;
    const given = Buffer.from(sha256(secret));
    const kept = Buffer.from(row.hash);
    if (given.length !== kept.length || !crypto.timingSafeEqual(given, kept)) return null;
    const user = this.user(row.user_id);
    if (!user || user.disabled_at) return null;
    this.run('UPDATE tokens SET last_seen_at = ? WHERE id = ?', this.now(), id);
    return { token: row, user };
  }
  revokeToken(id) { this.run('UPDATE tokens SET revoked_at = ? WHERE id = ?', this.now(), id); }
  devices() {
    return this.all("SELECT * FROM tokens WHERE kind = 'device' AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC", this.now());
  }

  // --- reports ---------------------------------------------------------------
  saveSnapshot(tokenId, userId, payload) {
    this.run('INSERT INTO snapshots (token_id, user_id, at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(token_id) DO UPDATE SET at = excluded.at, payload = excluded.payload, user_id = excluded.user_id',
      tokenId, userId, this.now(), JSON.stringify(payload));
  }
  /** The app on that device said it is closing: it stops counting as online now, not minutes later. */
  markGone(tokenId) {
    this.run("UPDATE snapshots SET payload = json_set(payload, '$.gone', json('true')) WHERE token_id = ?", tokenId);
  }
  snapshots() {
    return this.all('SELECT s.*, t.label FROM snapshots s JOIN tokens t ON t.id = s.token_id WHERE t.revoked_at IS NULL')
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  addMinutes(userId, day, kind, key, minutes) {
    this.run(`INSERT INTO activity (user_id, day, kind, key, minutes) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, day, kind, key) DO UPDATE SET minutes = minutes + excluded.minutes`, userId, day, kind, key, minutes);
  }
  /** Time worked in a day, counted once however many repositories it touched. */
  addDayMinutes(userId, day, minutes) {
    this.run(`INSERT INTO days (user_id, day, minutes) VALUES (?, ?, ?)
      ON CONFLICT(user_id, day) DO UPDATE SET minutes = minutes + excluded.minutes`, userId, day, minutes);
  }
  daysOf(userId, since) {
    return this.all('SELECT day, minutes FROM days WHERE user_id = ? AND day >= ? ORDER BY day', userId, since);
  }
  // --- what administrators did, and who signed in ----------------------------------
  log(actorId, action, target = '', detail = '') {
    this.run('INSERT INTO audit (at, actor_id, action, target, detail) VALUES (?, ?, ?, ?, ?)',
      this.now(), actorId, action, String(target).slice(0, 200), String(detail).slice(0, 500));
  }
  auditLog(limit = 200) {
    return this.all(`SELECT a.at, a.action, a.target, a.detail, u.email AS actor_email, u.name AS actor_name
      FROM audit a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.at DESC LIMIT ?`, Math.min(1000, limit));
  }
  activityRows(since) {
    return this.all(`SELECT a.day, a.kind, a.key, a.minutes, u.email, u.name FROM activity a JOIN users u ON u.id = a.user_id
      WHERE a.day >= ? ORDER BY a.day, u.email, a.kind, a.minutes DESC`, since);
  }
  dayRows(since) {
    return this.all('SELECT d.day, d.minutes, u.email, u.name FROM days d JOIN users u ON u.id = d.user_id WHERE d.day >= ? ORDER BY d.day, u.email', since);
  }
  /** The lowest each account got to in a day, and whether its session ran out. */
  noteUsage(userId, day, account, sessionLeft, weekLeft) {
    this.run(`INSERT INTO usage_days (user_id, day, account, session_left_min, week_left_min, ran_out) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, day, account) DO UPDATE SET
        session_left_min = CASE WHEN excluded.session_left_min IS NULL THEN session_left_min WHEN session_left_min IS NULL THEN excluded.session_left_min ELSE MIN(session_left_min, excluded.session_left_min) END,
        week_left_min = CASE WHEN excluded.week_left_min IS NULL THEN week_left_min WHEN week_left_min IS NULL THEN excluded.week_left_min ELSE MIN(week_left_min, excluded.week_left_min) END,
        ran_out = MAX(ran_out, excluded.ran_out)`,
      userId, day, String(account).slice(0, 80), sessionLeft, weekLeft, sessionLeft != null && sessionLeft <= 0 ? 1 : 0);
  }
  usageSince(day) {
    return this.all(`SELECT user_id, SUM(ran_out) AS days_ran_out, MIN(week_left_min) AS lowest_week, MIN(session_left_min) AS lowest_session
      FROM usage_days WHERE day >= ? GROUP BY user_id`, day);
  }
  /** Delete what is older than the company keeps. Accounts, devices and the log are not touched. */
  forgetBefore(day) {
    let n = 0;
    for (const table of ['activity', 'days', 'usage_days']) n += Number(this.run(`DELETE FROM ${table} WHERE day < ?`, day).changes);
    return n;
  }
  backupTo(file) {
    this.db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`);
  }
  activitySince(day) {
    return this.all('SELECT user_id, kind, key, SUM(minutes) AS minutes FROM activity WHERE day >= ? GROUP BY user_id, kind, key', day);
  }
}

module.exports = { Store, sha256 };
