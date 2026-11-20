'use strict';

const crypto = require('node:crypto');
const { ENGINES } = require('./rdb-sql');
const { sshHostOk, sshUserOk } = require('./rdb-tunnel');

/**
 * What the Databases extension remembers: the connections it was given, what
 * was run through them, and the queries somebody chose to keep.
 *
 * Its own tables in the app's database, prefixed `rdb_`, created if they are
 * not there — the same way Jenkins and Teams keep theirs.
 *
 * A password goes in encrypted and never comes back out to a panel: what a
 * panel is told about a connection says only whether it has one.
 */

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS rdb_connection (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     engine TEXT NOT NULL,
     host TEXT NOT NULL DEFAULT '',
     port INTEGER,
     user TEXT NOT NULL DEFAULT '',
     password TEXT NOT NULL DEFAULT '',
     database TEXT NOT NULL DEFAULT '',
     file TEXT NOT NULL DEFAULT '',
     ssl TEXT NOT NULL DEFAULT 'off',
     read_only INTEGER NOT NULL DEFAULT 0,
     production INTEGER NOT NULL DEFAULT 0,
     position INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE IF NOT EXISTS rdb_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     connection TEXT NOT NULL,
     database TEXT NOT NULL DEFAULT '',
     sql TEXT NOT NULL,
     at INTEGER NOT NULL,
     ms INTEGER NOT NULL DEFAULT 0,
     ok INTEGER NOT NULL DEFAULT 1,
     note TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX IF NOT EXISTS rdb_history_recent ON rdb_history (connection, id DESC);
   CREATE TABLE IF NOT EXISTS rdb_saved (
     id TEXT PRIMARY KEY,
     connection TEXT NOT NULL DEFAULT '',
     name TEXT NOT NULL,
     sql TEXT NOT NULL,
     at INTEGER NOT NULL
   );`,
  // Reaching a database through another machine. No secret here: the tunnel is the person's own ssh, with their keys.
  `ALTER TABLE rdb_connection ADD COLUMN ssh_host TEXT NOT NULL DEFAULT '';
   ALTER TABLE rdb_connection ADD COLUMN ssh_port INTEGER;
   ALTER TABLE rdb_connection ADD COLUMN ssh_user TEXT NOT NULL DEFAULT '';
   ALTER TABLE rdb_connection ADD COLUMN ssh_key TEXT NOT NULL DEFAULT '';`,
  // Watching a server over time: its readings, what its statements cost at each, and what was said about them.
  `ALTER TABLE rdb_connection ADD COLUMN watch INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE IF NOT EXISTS rdb_sample (
     connection TEXT NOT NULL,
     at INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (connection, at)
   );
   CREATE TABLE IF NOT EXISTS rdb_statement (
     connection TEXT NOT NULL,
     qid TEXT NOT NULL,
     text TEXT NOT NULL,
     PRIMARY KEY (connection, qid)
   );
   CREATE TABLE IF NOT EXISTS rdb_statement_sample (
     connection TEXT NOT NULL,
     at INTEGER NOT NULL,
     qid TEXT NOT NULL,
     calls INTEGER NOT NULL,
     ms REAL NOT NULL,
     PRIMARY KEY (connection, at, qid)
   );
   CREATE TABLE IF NOT EXISTS rdb_alert (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     connection TEXT NOT NULL,
     rule TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     message TEXT NOT NULL,
     first_at INTEGER NOT NULL,
     last_at INTEGER NOT NULL,
     closed_at INTEGER,
     dismissed INTEGER NOT NULL DEFAULT 0
   );`,
];

const MAX_CONNECTIONS = 200;
/** What is kept of what was run, per connection. Past it the oldest go. */
const HISTORY_KEPT = 300;
const HISTORY_SQL_MAX = 20_000;
const MAX_SAVED = 500;
const DEFAULT_PORTS = { postgres: 5432, mysql: 3306 };

class RdbStore {
  constructor(db, secrets) {
    this.db = db;
    this.secrets = secrets;
    db.exec('CREATE TABLE IF NOT EXISTS rdb_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const row = db.prepare("SELECT v FROM rdb_meta WHERE k = 'version'").get();
    let version = Number(row?.v ?? 0);
    for (; version < MIGRATIONS.length; version += 1) {
      db.exec(MIGRATIONS[version]);
      db.prepare("INSERT INTO rdb_meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(String(version + 1));
    }
  }

  /** A connection as a panel may see it: everything but the password. */
  #shown(row) {
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      host: row.host,
      port: row.port,
      user: row.user,
      database: row.database,
      file: row.file,
      ssl: row.ssl,
      readOnly: row.read_only === 1,
      production: row.production === 1,
      sshHost: row.ssh_host ?? '',
      sshPort: row.ssh_port ?? null,
      sshUser: row.ssh_user ?? '',
      sshKey: row.ssh_key ?? '',
      watch: row.watch === 1,
      hasPassword: Boolean(row.password),
    };
  }

  connections() {
    return this.db.prepare('SELECT * FROM rdb_connection ORDER BY position, name').all().map((row) => this.#shown(row));
  }

  connection(id) {
    const row = this.db.prepare('SELECT * FROM rdb_connection WHERE id = ?').get(String(id ?? ''));
    return row ? this.#shown(row) : null;
  }

  /** The same connection with its password in the clear. For opening it, and for nothing that leaves this process. */
  secret(id) {
    const row = this.db.prepare('SELECT * FROM rdb_connection WHERE id = ?').get(String(id ?? ''));
    if (!row) return null;
    return { ...this.#shown(row), password: row.password ? this.secrets.decrypt(row.password) : '' };
  }

  /** What a form sent, checked and made regular. Throws with a sentence when it is not a connection. */
  static clean(input) {
    const given = input && typeof input === 'object' ? input : {};
    const engine = String(given.engine ?? '');
    if (!ENGINES.includes(engine)) throw new Error('Choose PostgreSQL, MySQL or SQLite');
    const text = (value, max = 300) => String(value ?? '').trim().slice(0, max);
    const out = {
      engine,
      name: text(given.name, 80),
      host: '',
      port: null,
      user: '',
      database: '',
      file: '',
      ssl: 'off',
      readOnly: given.readOnly === true,
      production: given.production === true,
      sshHost: '',
      sshPort: null,
      sshUser: '',
      sshKey: '',
    };
    if (engine === 'sqlite') {
      out.file = text(given.file, 1000);
      if (!out.file) throw new Error('Choose the database file');
      if (!out.name) out.name = out.file.split(/[\\/]/).pop();
      return out;
    }
    out.host = text(given.host, 255) || 'localhost';
    if (/[\s/@]/.test(out.host)) throw new Error('The host is a name or an address, with nothing else in it');
    const port = given.port === '' || given.port === null || given.port === undefined ? DEFAULT_PORTS[engine] : Number(given.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The port is a number between 1 and 65535');
    out.port = port;
    out.user = text(given.user, 128);
    out.database = text(given.database, 128);
    out.ssl = ['off', 'on', 'verify'].includes(given.ssl) ? given.ssl : 'off';
    out.sshHost = text(given.sshHost, 255);
    if (out.sshHost) {
      if (!sshHostOk(out.sshHost)) throw new Error('The SSH host is a name or an address, with nothing else in it');
      out.sshUser = text(given.sshUser, 64);
      if (out.sshUser && !sshUserOk(out.sshUser)) throw new Error('The SSH user is a login name, with nothing else in it');
      if (given.sshPort !== '' && given.sshPort !== null && given.sshPort !== undefined) {
        const sshPort = Number(given.sshPort);
        if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('The SSH port is a number between 1 and 65535');
        out.sshPort = sshPort;
      }
      out.sshKey = text(given.sshKey, 1000);
    }
    if (!out.name) out.name = `${out.database || out.user || engine}@${out.host}`;
    return out;
  }

  /**
   * Add a connection, or change one.
   *
   * A password that was not typed is a password left as it was: the form never
   * had the old one to send back, so an empty field cannot mean "erase it".
   * `clearPassword` says that out loud.
   */
  save(input) {
    const clean = RdbStore.clean(input);
    const id = input?.id ? String(input.id) : null;
    const existing = id ? this.db.prepare('SELECT * FROM rdb_connection WHERE id = ?').get(id) : null;
    if (id && !existing) throw new Error('That connection is not known any more');
    let password = existing?.password ?? '';
    if (typeof input?.password === 'string' && input.password !== '') password = this.secrets.encrypt(input.password);
    else if (input?.clearPassword === true) password = '';
    if (clean.engine === 'sqlite') password = '';

    if (existing) {
      this.db
        .prepare(
          `UPDATE rdb_connection SET name = ?, engine = ?, host = ?, port = ?, user = ?, password = ?, database = ?, file = ?,
                  ssl = ?, read_only = ?, production = ?, ssh_host = ?, ssh_port = ?, ssh_user = ?, ssh_key = ? WHERE id = ?`,
        )
        .run(clean.name, clean.engine, clean.host, clean.port, clean.user, password, clean.database, clean.file, clean.ssl, clean.readOnly ? 1 : 0, clean.production ? 1 : 0,
          clean.sshHost, clean.sshPort, clean.sshUser, clean.sshKey, id);
      return this.connection(id);
    }
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM rdb_connection').get().n;
    if (count >= MAX_CONNECTIONS) throw new Error(`There are already ${MAX_CONNECTIONS} connections`);
    const fresh = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO rdb_connection (id, name, engine, host, port, user, password, database, file, ssl, read_only, production, position, ssh_host, ssh_port, ssh_user, ssh_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fresh, clean.name, clean.engine, clean.host, clean.port, clean.user, password, clean.database, clean.file, clean.ssl, clean.readOnly ? 1 : 0, clean.production ? 1 : 0, count,
        clean.sshHost, clean.sshPort, clean.sshUser, clean.sshKey);
    return this.connection(fresh);
  }

  remove(id) {
    const key = String(id ?? '');
    this.db.prepare('DELETE FROM rdb_connection WHERE id = ?').run(key);
    this.db.prepare('DELETE FROM rdb_history WHERE connection = ?').run(key);
    for (const table of ['rdb_sample', 'rdb_statement', 'rdb_statement_sample', 'rdb_alert']) this.db.prepare(`DELETE FROM ${table} WHERE connection = ?`).run(key);
    this.db.prepare("UPDATE rdb_saved SET connection = '' WHERE connection = ?").run(key);
  }

  // ─────────────────────────────────────────────────────────────── watching ──

  setWatch(id, on) {
    this.db.prepare('UPDATE rdb_connection SET watch = ? WHERE id = ?').run(on ? 1 : 0, String(id ?? ''));
  }

  watched() {
    return this.db.prepare('SELECT id FROM rdb_connection WHERE watch = 1').all().map((row) => row.id);
  }

  /** One reading, with what each statement had cost by then. All of it or none: half a reading would read as a server that stopped. */
  addReading(connection, server, statements) {
    const id = String(connection);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR REPLACE INTO rdb_sample (connection, at, data) VALUES (?, ?, ?)').run(id, server.at, JSON.stringify(server));
      const text = this.db.prepare('INSERT INTO rdb_statement (connection, qid, text) VALUES (?, ?, ?) ON CONFLICT (connection, qid) DO UPDATE SET text = excluded.text');
      const cost = this.db.prepare('INSERT OR REPLACE INTO rdb_statement_sample (connection, at, qid, calls, ms) VALUES (?, ?, ?, ?, ?)');
      for (const one of statements) {
        text.run(id, one.qid, String(one.text).slice(0, 2000));
        cost.run(id, server.at, one.qid, Math.round(one.calls), one.ms);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Readings since a moment, oldest first, each with its statements when asked for. */
  readings(connection, since, { statements = false } = {}) {
    const id = String(connection);
    const rows = this.db.prepare('SELECT at, data FROM rdb_sample WHERE connection = ? AND at >= ? ORDER BY at').all(id, since);
    const out = rows.map((row) => ({ server: JSON.parse(row.data), statements: [] }));
    if (statements && out.length) {
      const byAt = new Map(out.map((one) => [one.server.at, one]));
      const texts = this.statementTexts(id);
      for (const row of this.statementReadings(id, since)) byAt.get(row.at)?.statements.push({ qid: row.qid, calls: row.calls, ms: row.ms, text: texts.get(row.qid) ?? '' });
    }
    return out;
  }

  lastReadingAt(connection) {
    return this.db.prepare('SELECT max(at) AS at FROM rdb_sample WHERE connection = ?').get(String(connection))?.at ?? null;
  }

  statementReadings(connection, since) {
    return this.db.prepare('SELECT at, qid, calls, ms FROM rdb_statement_sample WHERE connection = ? AND at >= ? ORDER BY at').all(String(connection), since);
  }

  statementTexts(connection) {
    return new Map(this.db.prepare('SELECT qid, text FROM rdb_statement WHERE connection = ?').all(String(connection)).map((row) => [row.qid, row.text]));
  }

  statementText(connection, qid) {
    return this.db.prepare('SELECT text FROM rdb_statement WHERE connection = ? AND qid = ?').get(String(connection), String(qid))?.text ?? null;
  }

  /**
   * What a reading found. Something still wrong is the same alert, seen again;
   * something no longer found is closed. The answer is the ones that are new,
   * which are the only ones worth interrupting anybody for.
   */
  judged(connection, found, at) {
    const id = String(connection);
    const open = this.db.prepare('SELECT * FROM rdb_alert WHERE connection = ? AND closed_at IS NULL').all(id);
    const key = (one) => `${one.rule}\u0000${one.subject ?? ''}`;
    const still = new Map(found.map((one) => [key(one), one]));
    const fresh = [];
    for (const row of open) {
      const again = still.get(key(row));
      if (again) {
        this.db.prepare('UPDATE rdb_alert SET last_at = ?, message = ? WHERE id = ?').run(at, again.message, row.id);
        still.delete(key(row));
      } else {
        this.db.prepare('UPDATE rdb_alert SET closed_at = ? WHERE id = ?').run(at, row.id);
      }
    }
    for (const one of still.values()) {
      // Told once and dismissed, it is not said again for a day however often it is found.
      const quiet = this.db.prepare('SELECT 1 FROM rdb_alert WHERE connection = ? AND rule = ? AND subject = ? AND dismissed = 1 AND last_at > ?').get(id, one.rule, one.subject ?? '', at - 86_400_000);
      const made = this.db.prepare('INSERT INTO rdb_alert (connection, rule, subject, message, first_at, last_at, dismissed) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, one.rule, one.subject ?? '', one.message, at, at, quiet ? 1 : 0);
      if (!quiet) fresh.push({ id: Number(made.lastInsertRowid), ...one });
    }
    return fresh;
  }

  alerts(connection, { limit = 40 } = {}) {
    return this.db
      .prepare('SELECT id, rule, subject, message, first_at, last_at, closed_at, dismissed FROM rdb_alert WHERE connection = ? ORDER BY (closed_at IS NULL) DESC, last_at DESC LIMIT ?')
      .all(String(connection), limit)
      .map((row) => ({ id: row.id, rule: row.rule, subject: row.subject, message: row.message, firstAt: row.first_at, lastAt: row.last_at, closedAt: row.closed_at, dismissed: row.dismissed === 1 }));
  }

  /** How many things are wrong on each connection right now and have not been waved away. */
  openAlerts() {
    return new Map(this.db.prepare('SELECT connection, count(*) AS n FROM rdb_alert WHERE closed_at IS NULL AND dismissed = 0 GROUP BY connection').all().map((row) => [row.connection, row.n]));
  }

  dismissAlert(connection, id) {
    this.db.prepare('UPDATE rdb_alert SET dismissed = 1 WHERE connection = ? AND id = ?').run(String(connection), Number(id));
  }

  pruneReadings(before) {
    this.db.prepare('DELETE FROM rdb_sample WHERE at < ?').run(before);
    this.db.prepare('DELETE FROM rdb_statement_sample WHERE at < ?').run(before);
    this.db.prepare('DELETE FROM rdb_alert WHERE closed_at IS NOT NULL AND closed_at < ?').run(before);
    this.db.prepare('DELETE FROM rdb_statement WHERE NOT EXISTS (SELECT 1 FROM rdb_statement_sample s WHERE s.connection = rdb_statement.connection AND s.qid = rdb_statement.qid)').run();
  }

  remember({ connection, database, sql, ms, ok, note }) {
    const text = String(sql ?? '').trim();
    if (!text) return;
    this.db
      .prepare('INSERT INTO rdb_history (connection, database, sql, at, ms, ok, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(connection), String(database ?? ''), text.slice(0, HISTORY_SQL_MAX), Date.now(), Math.round(Number(ms) || 0), ok ? 1 : 0, String(note ?? '').slice(0, 300));
    this.db
      .prepare(
        `DELETE FROM rdb_history WHERE connection = ? AND id NOT IN
           (SELECT id FROM rdb_history WHERE connection = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(String(connection), String(connection), HISTORY_KEPT);
  }

  history(connection, { q = '', limit = 100 } = {}) {
    const like = `%${String(q).replace(/[\\%_]/g, '\\$&')}%`;
    return this.db
      .prepare(
        `SELECT id, database, sql, at, ms, ok, note FROM rdb_history
          WHERE connection = ? AND sql LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`,
      )
      .all(String(connection ?? ''), like, Math.min(300, Math.max(1, Number(limit) || 100)))
      .map((row) => ({ ...row, ok: row.ok === 1 }));
  }

  clearHistory(connection) {
    this.db.prepare('DELETE FROM rdb_history WHERE connection = ?').run(String(connection ?? ''));
  }

  saved() {
    return this.db.prepare('SELECT id, connection, name, sql, at FROM rdb_saved ORDER BY name COLLATE NOCASE').all();
  }

  saveQuery({ id, connection, name, sql }) {
    const title = String(name ?? '').trim().slice(0, 120);
    const text = String(sql ?? '').trim().slice(0, 200_000);
    if (!title) throw new Error('Give the query a name');
    if (!text) throw new Error('There is nothing to save');
    if (id) {
      this.db.prepare('UPDATE rdb_saved SET name = ?, sql = ?, at = ? WHERE id = ?').run(title, text, Date.now(), String(id));
      return String(id);
    }
    if (this.db.prepare('SELECT COUNT(*) AS n FROM rdb_saved').get().n >= MAX_SAVED) throw new Error(`There are already ${MAX_SAVED} saved queries`);
    const fresh = crypto.randomUUID();
    this.db.prepare('INSERT INTO rdb_saved (id, connection, name, sql, at) VALUES (?, ?, ?, ?, ?)').run(fresh, String(connection ?? ''), title, text, Date.now());
    return fresh;
  }

  deleteQuery(id) {
    this.db.prepare('DELETE FROM rdb_saved WHERE id = ?').run(String(id ?? ''));
  }
}

module.exports = { RdbStore, HISTORY_KEPT, DEFAULT_PORTS };
