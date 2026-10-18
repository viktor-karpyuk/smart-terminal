'use strict';

/**
 * What housekeeping remembers between runs, in the app's own database.
 *
 * Three small tables. `hk_root`: the folders the person asked to be looked
 * through for worktrees and build caches, beyond the ones the app finds on its
 * own. `hk_size`: the last measurement of each path, so the panel opens on
 * numbers rather than on a wait. `hk_log`: what was removed, when, and how much
 * it gave back — the panel's answer to "what did that just do". `hk_reading`:
 * the monitor's measurements, a month of them, for the trend. `hk_setting`:
 * thresholds and budgets the person changed, and what was already said.
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
  `CREATE TABLE IF NOT EXISTS hk_reading (
     at     INTEGER NOT NULL,
     metric TEXT NOT NULL,
     value  REAL NOT NULL
   );
   CREATE INDEX IF NOT EXISTS hk_reading_metric_at ON hk_reading (metric, at);
   CREATE TABLE IF NOT EXISTS hk_setting (
     key   TEXT PRIMARY KEY,
     value TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS hk_job (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     kind        TEXT NOT NULL,
     title       TEXT NOT NULL,
     status      TEXT NOT NULL,
     ids         TEXT NOT NULL,
     labels      TEXT NOT NULL DEFAULT '{}',
     results     TEXT NOT NULL DEFAULT '{}',
     current     TEXT,
     idx         INTEGER NOT NULL DEFAULT 0,
     freed       INTEGER NOT NULL DEFAULT 0,
     failed      INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     updated_at  INTEGER NOT NULL,
     finished_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS hk_job_status ON hk_job (status, created_at);`,
  `CREATE TABLE IF NOT EXISTS hk_daily (
     day    INTEGER NOT NULL,
     metric TEXT NOT NULL,
     first  REAL NOT NULL,
     last   REAL NOT NULL,
     PRIMARY KEY (day, metric)
   );`,
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

  /** Keep the log from growing without bound: two years, so a year's balance has a year to compare with. */
  trimLog({ keepDays = 730 } = {}) {
    return this.db.prepare('DELETE FROM hk_log WHERE at < ?').run(Date.now() - keepDays * 86_400_000).changes;
  }

  /** What was given back since a time: bytes and actions, by action. */
  logTotals(since = 0) {
    const rows = this.db
      .prepare('SELECT action, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM hk_log WHERE ok = 1 AND at >= ? GROUP BY action')
      .all(since);
    const total = rows.reduce((acc, row) => ({ n: acc.n + row.n, bytes: acc.bytes + row.bytes }), { n: 0, bytes: 0 });
    return { ...total, byAction: Object.fromEntries(rows.map((row) => [row.action, { n: row.n, bytes: row.bytes }])) };
  }

  /** The first and last reading of a metric since a time, for "went from A to B". */
  firstLast(metric, since = 0) {
    const first = this.db.prepare('SELECT at, value FROM hk_reading WHERE metric = ? AND at >= ? ORDER BY at LIMIT 1').get(metric, since);
    const last = this.db.prepare('SELECT at, value FROM hk_reading WHERE metric = ? AND at >= ? ORDER BY at DESC LIMIT 1').get(metric, since);
    return first && last ? { first, last } : null;
  }

  // --- jobs -------------------------------------------------------------------

  createJob({ kind, title, ids, labels = {}, createdAt = Date.now() }) {
    const info = this.db
      .prepare('INSERT INTO hk_job (kind, title, status, ids, labels, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, title, 'queued', JSON.stringify(ids), JSON.stringify(labels), createdAt, createdAt);
    return this.job(Number(info.lastInsertRowid));
  }

  job(id) {
    const row = this.db.prepare('SELECT * FROM hk_job WHERE id = ?').get(id);
    return row ? jobRow(row) : null;
  }

  /** Jobs in the states named (or all), newest first. */
  jobs(statuses = null, limit = 50) {
    const rows = statuses?.length
      ? this.db.prepare(`SELECT * FROM hk_job WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT ?`).all(...statuses, limit)
      : this.db.prepare('SELECT * FROM hk_job ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
    return rows.map(jobRow);
  }

  updateJob(id, patch) {
    const map = { status: 'status', current: 'current', index: 'idx', freed: 'freed', failed: 'failed', startedAt: 'started_at', updatedAt: 'updated_at', finishedAt: 'finished_at' };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(map)) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key]);
      }
    }
    if (patch.results !== undefined) {
      sets.push('results = ?');
      values.push(JSON.stringify(patch.results));
    }
    if (sets.length) this.db.prepare(`UPDATE hk_job SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.job(id);
  }

  deleteJob(id) {
    this.db.prepare('DELETE FROM hk_job WHERE id = ?').run(id);
  }

  /** Finished jobs older than a month go; the log keeps what they gave back. */
  trimJobs({ keepDays = 30 } = {}) {
    return this.db.prepare("DELETE FROM hk_job WHERE status IN ('done','cancelled','failed') AND updated_at < ?").run(Date.now() - keepDays * 86_400_000).changes;
  }

  // --- readings ---------------------------------------------------------------

  recordReading(metric, value, at = Date.now()) {
    this.db.prepare('INSERT INTO hk_reading (at, metric, value) VALUES (?, ?, ?)').run(at, metric, Number(value));
  }

  /** A tick's readings in one transaction: ten inserts are one write to the log, not ten. */
  recordReadings(rows, at = Date.now()) {
    const insert = this.db.prepare('INSERT INTO hk_reading (at, metric, value) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const [metric, value] of rows) insert.run(at, metric, Number(value));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** One metric's readings since a time, oldest first. */
  readings(metric, since = 0) {
    return this.db.prepare('SELECT at, value FROM hk_reading WHERE metric = ? AND at >= ? ORDER BY at').all(metric, since);
  }

  /** A month of readings is enough for a trend; a minute's worth a day for a year is not worth keeping. */
  trimReadings({ keepDays = 30 } = {}) {
    return this.db.prepare('DELETE FROM hk_reading WHERE at < ?').run(Date.now() - keepDays * 86_400_000).changes;
  }

  // --- daily roll-up ------------------------------------------------------------

  /** The first and last value of a metric on a day, kept for years where minute readings are kept a month. */
  rollup(metric, value, at = Date.now()) {
    const day = Math.floor(at / 86_400_000);
    this.db
      .prepare(
        `INSERT INTO hk_daily (day, metric, first, last) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, metric) DO UPDATE SET last = excluded.last`,
      )
      .run(day, metric, Number(value), Number(value));
  }

  /** How a metric moved from the first reading on or after a day to the latest: {from, to, fromDay, toDay}, or null. */
  dailyRange(metric, sinceDay) {
    const first = this.db.prepare('SELECT day, first FROM hk_daily WHERE metric = ? AND day >= ? ORDER BY day LIMIT 1').get(metric, sinceDay);
    const last = this.db.prepare('SELECT day, last FROM hk_daily WHERE metric = ? AND day >= ? ORDER BY day DESC LIMIT 1').get(metric, sinceDay);
    return first && last ? { from: first.first, to: last.last, fromDay: first.day, toDay: last.day } : null;
  }

  trimDaily({ keepDays = 800 } = {}) {
    return this.db.prepare('DELETE FROM hk_daily WHERE day < ?').run(Math.floor(Date.now() / 86_400_000) - keepDays).changes;
  }

  // --- settings ---------------------------------------------------------------

  settings() {
    const out = {};
    for (const row of this.db.prepare('SELECT key, value FROM hk_setting').all()) {
      try {
        out[row.key] = row.value === null ? null : JSON.parse(row.value);
      } catch {
        out[row.key] = null;
      }
    }
    return out;
  }

  setting(key) {
    const row = this.db.prepare('SELECT value FROM hk_setting WHERE key = ?').get(key);
    if (!row) return undefined;
    try {
      return row.value === null ? null : JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO hk_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value === undefined ? null : JSON.stringify(value));
  }
}

function jobRow(row) {
  const parse = (text, fallback) => {
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    ids: parse(row.ids, []),
    labels: parse(row.labels, {}),
    results: parse(row.results, {}),
    current: row.current,
    index: row.idx,
    freed: row.freed,
    failed: row.failed,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

module.exports = { HousekeepingStore, MIGRATIONS };
