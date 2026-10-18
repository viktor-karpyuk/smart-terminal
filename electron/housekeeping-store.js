'use strict';

/**
 * What housekeeping remembers between runs, in the app's own database.
 *
 * Three small tables. `hk_root`: the folders the person asked to be looked
 * through for worktrees and build caches, beyond the ones the app finds on its
 * own. `hk_size`: the last measurement of each path, so the panel opens on
 * numbers rather than on a wait. `hk_log`: what was removed, when, and how much
 * it gave back — the panel's answer to "what did that just do".
 */

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS hk_root (
     path     TEXT PRIMARY KEY,
     added_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS hk_size (
     path        TEXT PRIMARY KEY,
     bytes       INTEGER NOT NULL,
     files       INTEGER NOT NULL DEFAULT 0,
     mtime       INTEGER NOT NULL DEFAULT 0,
     measured_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS hk_log (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     at     INTEGER NOT NULL,
     action TEXT NOT NULL,
     kind   TEXT NOT NULL,
     label  TEXT NOT NULL,
     bytes  INTEGER NOT NULL DEFAULT 0,
     ok     INTEGER NOT NULL DEFAULT 1,
     detail TEXT
   );
   CREATE INDEX IF NOT EXISTS hk_log_at ON hk_log (at DESC);`,
];

class HousekeepingStore {
  constructor(db) {
    this.db = db;
    this.#migrate();
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS hk_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM hk_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO hk_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) {
      throw new Error(`The housekeeping tables are at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    }
    for (let version = row.version; version < MIGRATIONS.length; version++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE hk_schema SET version = ?').run(version + 1);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  // --- roots ------------------------------------------------------------------

  roots() {
    return this.db.prepare('SELECT path, added_at AS addedAt FROM hk_root ORDER BY added_at').all();
  }

  addRoot(folder) {
    this.db.prepare('INSERT OR IGNORE INTO hk_root (path, added_at) VALUES (?, ?)').run(folder, Date.now());
  }

  removeRoot(folder) {
    return this.db.prepare('DELETE FROM hk_root WHERE path = ?').run(folder).changes > 0;
  }

  // --- sizes ------------------------------------------------------------------

  sizes() {
    return this.db
      .prepare('SELECT path, bytes, files, mtime, measured_at AS measuredAt FROM hk_size')
      .all();
  }

  rememberSize(target, { bytes, files = 0, mtime = 0, measuredAt = Date.now() }) {
    this.db
      .prepare(
        `INSERT INTO hk_size (path, bytes, files, mtime, measured_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes, files = excluded.files, mtime = excluded.mtime, measured_at = excluded.measured_at`,
      )
      .run(target, bytes, files, mtime, measuredAt);
  }

  forgetSize(target) {
    this.db.prepare('DELETE FROM hk_size WHERE path = ?').run(target);
  }

  // --- log --------------------------------------------------------------------

  log({ action, kind, label, bytes = 0, ok = true, detail = null, at = Date.now() }) {
    this.db
      .prepare('INSERT INTO hk_log (at, action, kind, label, bytes, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(at, action, kind, label, bytes, ok ? 1 : 0, detail);
  }

  recentLog(limit = 50) {
    return this.db
      .prepare('SELECT id, at, action, kind, label, bytes, ok, detail FROM hk_log ORDER BY at DESC, id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ ...row, ok: Boolean(row.ok) }));
  }

  /** Keep the log from growing without bound: a year is more than anybody reads back. */
  trimLog({ keepDays = 365 } = {}) {
    return this.db.prepare('DELETE FROM hk_log WHERE at < ?').run(Date.now() - keepDays * 86_400_000).changes;
  }
}

module.exports = { HousekeepingStore, MIGRATIONS };
