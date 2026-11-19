'use strict';

/**
 * What the Jenkins extension remembers: the servers it was given, which jobs
 * were starred, and which builds somebody asked to hear about.
 *
 * Its own tables in the app's database, prefixed `jk_`, created if they are not
 * there — the same way the Teams extension keeps its own, and for the same
 * reason: a feature that can be uninstalled should not own a numbered
 * migration in the app's history.
 *
 * A token goes in encrypted and never comes back out to a panel.
 */

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS jk_server (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     url TEXT NOT NULL,
     user TEXT NOT NULL DEFAULT '',
     token TEXT NOT NULL DEFAULT '',
     position INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE IF NOT EXISTS jk_favorite (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     PRIMARY KEY (server, path)
   );
   CREATE TABLE IF NOT EXISTS jk_follow (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     since TEXT NOT NULL,
     PRIMARY KEY (server, path, number)
   );`,
  // Settings that belong to the extension as a whole: what is kept of finished builds, and for how long.
  // Here and not with the archive, which is a file a person may delete without losing them.
  `CREATE TABLE IF NOT EXISTS jk_setting (k TEXT PRIMARY KEY, v TEXT NOT NULL);`,
  // What notifications are made of. A job's state is how it stood the last time a build of it was judged — its last
  // outcome that was not neutral (an aborted build says nothing) — and the number of the last build judged, so that what
  // happens to a job is told once, in order, whether it was seen as it happened or found out afterwards. (What the person
  // started through the app is followed from here too: `source` says which, so that it can be told "the one you started".)
  `ALTER TABLE jk_follow ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
   CREATE TABLE IF NOT EXISTS jk_state (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     settled TEXT,
     seen INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (server, path)
   );`,
  // A certificate the person looked at and trusted for one server: its fingerprint and the host it was trusted for.
  `ALTER TABLE jk_server ADD COLUMN cert TEXT;`,
];

/** What one person could plausibly mean, and what keeps a runaway caller from filling the database. */
const MAX_FAVORITES = 500;
const MAX_FOLLOWS = 100;

function parseCert(text) {
  try {
    const value = text ? JSON.parse(text) : null;
    return value && /^[0-9a-f]{64}$/.test(value.fingerprint) && typeof value.host === 'string' ? { fingerprint: value.fingerprint, host: value.host } : null;
  } catch { return null; }
}

class JenkinsStore {
  constructor(db, secrets) {
    this.db = db;
    this.secrets = secrets ?? {
      encrypt: (text) => Buffer.from(text).toString('base64'),
      decrypt: (cipher) => Buffer.from(cipher, 'base64').toString(),
    };
    this.#migrate();
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS jk_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM jk_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO jk_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) {
      throw new Error(`The Jenkins tables are at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    }
    for (let version = row.version; version < MIGRATIONS.length; version++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE jk_schema SET version = ?').run(version + 1);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  // --- settings ---------------------------------------------------------------

  setting(key, fallback = null) {
    const row = this.db.prepare('SELECT v FROM jk_setting WHERE k = ?').get(String(key));
    return row ? row.v : fallback;
  }

  setSetting(key, value) {
    if (value === null || value === undefined) this.db.prepare('DELETE FROM jk_setting WHERE k = ?').run(String(key));
    else this.db.prepare('INSERT INTO jk_setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(String(key), String(value));
  }

  // --- servers ----------------------------------------------------------------

  /** Every server, without its token. */
  servers() {
    return this.db.prepare('SELECT id, name, url, user, position, cert, token <> \'\' AS hasToken FROM jk_server ORDER BY position, name').all()
      .map((row) => ({ id: row.id, name: row.name, url: row.url, user: row.user, hasToken: Boolean(row.hasToken), trustedCertificate: Boolean(row.cert) }));
  }

  /**
   * One server with its token. A token the system can no longer decrypt — the
   * keychain was reset, the profile moved — comes back as `tokenError` rather
   * than as a throw: everything about the server would otherwise fail with a
   * message about ciphertext, and the one thing to do is to type it again.
   */
  server(id) {
    const row = this.db.prepare('SELECT id, name, url, user, token, cert FROM jk_server WHERE id = ?').get(String(id));
    if (!row) return null;
    let token = '';
    let tokenError = false;
    if (row.token) {
      try { token = this.secrets.decrypt(row.token); } catch { tokenError = true; }
    }
    return { id: row.id, name: row.name, url: row.url, user: row.user, token, tokenError, cert: parseCert(row.cert) };
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM jk_server').get().n;
  }

  /**
   * Add or change one. A blank token on an existing server keeps the one it has
   * — which the service only allows while the address and the user are the
   * ones it was saved with. An id that is not a server is an error, not a new
   * server under a name the caller chose.
   */
  saveServer({ id, name, url, user = '', token = '' }) {
    const existing = id ? this.db.prepare('SELECT token FROM jk_server WHERE id = ?').get(String(id)) : null;
    if (id && !existing) throw new Error('That Jenkins is not set up here');
    const key = id || `jk-${Math.random().toString(36).slice(2, 10)}`;
    const cipher = token ? this.secrets.encrypt(String(token)) : (existing?.token ?? '');
    if (existing) {
      this.db.prepare('UPDATE jk_server SET name = ?, url = ?, user = ?, token = ? WHERE id = ?').run(name, url, user, cipher, key);
    } else {
      const position = this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM jk_server').get().next;
      this.db.prepare('INSERT INTO jk_server (id, name, url, user, token, position) VALUES (?, ?, ?, ?, ?, ?)').run(key, name, url, user, cipher, position);
    }
    return key;
  }

  /** The certificate trusted for a server: `{ fingerprint, host }` (SHA-256, lowercase hex), or null. */
  setCert(id, cert) {
    this.db.prepare('UPDATE jk_server SET cert = ? WHERE id = ?').run(cert ? JSON.stringify({ fingerprint: cert.fingerprint, host: cert.host }) : null, String(id));
  }

  /** Every certificate trusted for any server: `[{ host, fingerprint }]`. What the connection layer asks. */
  certs() {
    return this.db.prepare('SELECT cert FROM jk_server WHERE cert IS NOT NULL').all().map((row) => parseCert(row.cert)).filter(Boolean);
  }

  deleteServer(id) {
    for (const table of ['jk_favorite', 'jk_follow', 'jk_state']) this.db.prepare(`DELETE FROM ${table} WHERE server = ?`).run(String(id));
    const prefix = `notify.${id}.`;
    this.db.prepare('DELETE FROM jk_setting WHERE substr(k, 1, ?) = ?').run(prefix.length, prefix);
    this.db.prepare('DELETE FROM jk_server WHERE id = ?').run(String(id));
  }

  // --- favorites --------------------------------------------------------------

  favorites(server) {
    return this.db.prepare('SELECT path FROM jk_favorite WHERE server = ? ORDER BY path').all(String(server)).map((row) => row.path);
  }

  setFavorite(server, path, on) {
    if (on && this.favorites(server).length >= MAX_FAVORITES && !this.favorites(server).includes(String(path))) {
      throw new Error(`That is already ${MAX_FAVORITES} favorites on this server; remove one first`);
    }
    if (on) this.db.prepare('INSERT OR IGNORE INTO jk_favorite (server, path) VALUES (?, ?)').run(String(server), String(path));
    else this.db.prepare('DELETE FROM jk_favorite WHERE server = ? AND path = ?').run(String(server), String(path));
  }

  // --- follows ----------------------------------------------------------------

  follows(server = null) {
    const rows = server
      ? this.db.prepare('SELECT server, path, number, since, source FROM jk_follow WHERE server = ? ORDER BY since').all(String(server))
      : this.db.prepare('SELECT server, path, number, since, source FROM jk_follow ORDER BY since').all();
    return rows.map((row) => ({ server: row.server, path: row.path, number: row.number, since: row.since, source: row.source }));
  }

  /** `source` is why: 'user' for a build somebody asked to hear about, 'launch' for one they started. */
  setFollow(server, path, number, on, at = new Date().toISOString(), source = 'user') {
    if (on && this.follows().length >= MAX_FOLLOWS) throw new Error(`You are already following ${MAX_FOLLOWS} builds; let some finish first`);
    if (on) this.db.prepare('INSERT OR IGNORE INTO jk_follow (server, path, number, since, source) VALUES (?, ?, ?, ?, ?)').run(String(server), String(path), Number(number), at, source === 'launch' ? 'launch' : 'user');
    else this.db.prepare('DELETE FROM jk_follow WHERE server = ? AND path = ? AND number = ?').run(String(server), String(path), Number(number));
  }

  isFollowed(server, path, number) {
    return Boolean(this.db.prepare('SELECT 1 AS x FROM jk_follow WHERE server = ? AND path = ? AND number = ?').get(String(server), String(path), Number(number)));
  }

  // --- how jobs stand ---------------------------------------------------------

  /** `{ settled, seen }` for a job, or null if no build of it was ever judged. */
  state(server, path) {
    const row = this.db.prepare('SELECT settled, seen FROM jk_state WHERE server = ? AND path = ?').get(String(server), String(path));
    return row ? { settled: row.settled ?? null, seen: row.seen } : null;
  }

  setState(server, path, { settled, seen }) {
    this.db.prepare(
      `INSERT INTO jk_state (server, path, settled, seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (server, path) DO UPDATE SET settled = excluded.settled, seen = excluded.seen`,
    ).run(String(server), String(path), settled ?? null, Number(seen) || 0);
  }

  /** Every job on a server with a state: what to compare with after a restart. */
  states(server) {
    return new Map(this.db.prepare('SELECT path, settled, seen FROM jk_state WHERE server = ?').all(String(server)).map((row) => [row.path, { settled: row.settled ?? null, seen: row.seen }]));
  }

  forgetState(server, path = null) {
    if (path === null) this.db.prepare('DELETE FROM jk_state WHERE server = ?').run(String(server));
    else this.db.prepare('DELETE FROM jk_state WHERE server = ? AND path = ?').run(String(server), String(path));
  }
}

module.exports = { JenkinsStore, MAX_FAVORITES, MAX_FOLLOWS };
