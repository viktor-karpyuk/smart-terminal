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
    this.db.prepare("UPDATE rdb_saved SET connection = '' WHERE connection = ?").run(key);
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
