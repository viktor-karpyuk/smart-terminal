'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gunzip = promisify(zlib.gunzip);

/**
 * What the Jenkins extension keeps of builds that have finished.
 *
 * A finished build does not change, so it is fetched once and kept: its
 * summary, its stages, who changed what, what it was started with, and its
 * console. It stays viewable when Jenkins has discarded it or cannot be
 * reached, and asking again costs nothing. Everything here is built on that:
 * nothing in this file ever rewrites a finished build unless it is told to
 * (`overwrite`), and what the service asks Jenkins for is only what is newer
 * than what is already here.
 *
 * Its own database, not the app's: a console is megabytes, and a person must
 * be able to delete the file. Its own tables, created if they are missing, and
 * its own schema counter, for the same reason the store has one.
 *
 * Four tables, from the most to the least kept:
 *
 *   jk_build  one finished build in full — summary, stages, changes, parameters
 *             (already masked), causes, artifacts. What `saved` pins is never
 *             evicted.
 *   jk_log    its console, gzipped, as text with Jenkins' own markup taken
 *             out. A console that is still being written is here too, as the
 *             part read so far with the offset to go on from — so that opening
 *             it again reads only what is new.
 *   jk_run    the short form of a finished build — number, status, time, and
 *             its stages once they are known. What the list of a job's builds
 *             and the matrix of its stages are made of, so neither has to ask
 *             for a build it has already seen.
 *   jk_job    where a job's sync stands: the build number up to which every
 *             build Jenkins lists is known and finished (`w`), the lowest
 *             number looked at (`lo`) and the newest finished one seen (`seen`).
 *
 * Nothing in them is a credential. Parameters with secret-looking names were
 * masked before they got here. A console is stored as Jenkins printed it, and
 * Jenkins does not mask everything: the file is as private as the rest of the
 * app's data and no more.
 */

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS jk_build (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     status TEXT NOT NULL,
     timestamp INTEGER,
     duration INTEGER NOT NULL DEFAULT 0,
     estimated INTEGER,
     agent TEXT,
     name TEXT,
     description TEXT,
     causes TEXT NOT NULL DEFAULT '[]',
     changes TEXT NOT NULL DEFAULT '[]',
     parameters TEXT NOT NULL DEFAULT '[]',
     artifacts TEXT NOT NULL DEFAULT '[]',
     stages TEXT NOT NULL DEFAULT '[]',
     input TEXT,
     saved INTEGER NOT NULL DEFAULT 0,
     archived_at INTEGER NOT NULL,
     PRIMARY KEY (server, path, number)
   );
   CREATE TABLE IF NOT EXISTS jk_log (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     raw_size INTEGER,
     truncated INTEGER NOT NULL DEFAULT 0,
     skipped INTEGER NOT NULL DEFAULT 0,
     complete INTEGER NOT NULL DEFAULT 1,
     offset INTEGER NOT NULL DEFAULT 0,
     carry BLOB,
     chars INTEGER NOT NULL DEFAULT 0,
     gz BLOB NOT NULL,
     gz_bytes INTEGER NOT NULL,
     archived_at INTEGER NOT NULL,
     PRIMARY KEY (server, path, number)
   );
   CREATE TABLE IF NOT EXISTS jk_run (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     status TEXT NOT NULL,
     timestamp INTEGER,
     duration INTEGER NOT NULL DEFAULT 0,
     estimated INTEGER,
     stages TEXT,
     PRIMARY KEY (server, path, number)
   );
   CREATE TABLE IF NOT EXISTS jk_job (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     lo INTEGER,
     w INTEGER NOT NULL DEFAULT 0,
     seen INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (server, path)
   );`,
  // What the housekeeping asks for in bulk — consoles never finished, the oldest of what is not saved — is found by index
  // and not by reading every row each time something is kept.
  `CREATE INDEX IF NOT EXISTS jk_log_partial ON jk_log (complete, archived_at);
   CREATE INDEX IF NOT EXISTS jk_build_oldest ON jk_build (saved, timestamp);
   CREATE INDEX IF NOT EXISTS jk_log_oldest ON jk_log (archived_at);`,
  // A console read again because what was kept did not agree with Jenkins' own count: said so, rather than silently replaced.
  // `verified`: a console written since pieces say where they begin cannot have been kept twice; one from before is compared with Jenkins once.
  `ALTER TABLE jk_log ADD COLUMN repaired INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE jk_log ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;`,
];

/** The most a console may expand to when it is read back: a console is kept to 20 MB of text, so more than this is not one this app wrote. */
const MAX_LOG_TEXT = 96 * 1024 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A job's name, as a key. Jenkins cannot make one with a control character in
 * it, and the database ends a string at the first NUL — so a name that has one
 * would be kept as a different, shorter name: another job's.
 */
function name(path) {
  if (typeof path !== 'string' || !path || CONTROL.test(path)) throw new Error('That is not a name Jenkins could have');
  return path;
}

/** The newest finished runs kept in short form for each job: more than any list or matrix shows. */
const RUNS_PER_JOB = 200;
/** A console that was being read and never finished is let go after this. */
const PARTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const json = (value, fallback = []) => JSON.stringify(value ?? fallback);
const parse = (text, fallback = []) => {
  try { return text === null || text === undefined ? fallback : JSON.parse(text); } catch { return fallback; }
};

class JenkinsArchive {
  constructor(db) {
    this.db = db;
    this.depth = 0;
    /** What is kept, in bytes, as it has been counted and added to since: reading every row to know it costs more the more is kept. */
    this.size = null;
    this.sizeOps = 0;
    this.#harden();
    this.#migrate();
    this.#private();
  }

  /**
   * What is kept here may include what Jenkins did not mask, so what is deleted
   * has to be gone: a deleted row's bytes stay in the file, in pages nobody
   * uses, unless they are overwritten (`secure_delete`) and the pages given
   * back (`auto_vacuum`, for a database that is being made — it cannot be
   * changed on one that has tables).
   */
  #harden() {
    try {
      if (!this.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n) this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      this.db.exec('PRAGMA secure_delete = ON');
      // Readers do not wait for the writer, nor the writer for them: the history in the same file is read by a thread of its own
      // (jenkins-metrics-worker.js) while the poller writes. (In memory there is nothing to change.)
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch { /* an archive that is not hardened is still an archive */ }
  }

  /** The file, and the ones SQLite keeps beside it, readable by their owner alone. SQLite gives its side files the mode the database has. */
  #private() {
    try {
      const file = this.db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
      if (!file) return;
      for (const one of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
        try { fs.chmodSync(one, 0o600); } catch { /* it does not exist (yet), or is not ours to change */ }
      }
    } catch { /* an in-memory database has no file */ }
  }

  /** Give the pages that deleting freed back to the file, so it shrinks and what was in them is not kept. */
  #reclaim() {
    try { this.db.exec('PRAGMA incremental_vacuum'); } catch { /* not an incremental database: nothing to give back */ }
    // In WAL mode the old pages live on in the log until it is written back and emptied; what was forgotten must not.
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* a reader is in the middle of reading: the next one empties it */ }
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS jk_archive_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM jk_archive_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO jk_archive_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) {
      throw new Error(`The Jenkins archive is at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    }
    for (let version = row.version; version < MIGRATIONS.length; version += 1) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE jk_archive_schema SET version = ?').run(version + 1);
      });
    }
  }

  /** Inside another, it is part of that one: only the outermost begins and ends. */
  transaction(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN');
    this.depth = 1;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  // --- builds ---------------------------------------------------------------

  /** One finished build, as `api.build` gives it, or null. */
  build(server, path, number) {
    const row = this.db.prepare('SELECT * FROM jk_build WHERE server = ? AND path = ? AND number = ?').get(server, path, number);
    if (!row) return null;
    return {
      number: row.number,
      status: row.status,
      running: false,
      timestamp: row.timestamp,
      duration: row.duration,
      ...(row.estimated ? { estimated: row.estimated } : {}),
      path: row.path,
      name: row.name ?? `#${row.number}`,
      description: row.description ?? '',
      agent: row.agent ?? 'built-in',
      causes: parse(row.causes),
      changes: parse(row.changes),
      parameters: parse(row.parameters),
      artifacts: parse(row.artifacts),
      stages: parse(row.stages),
      input: parse(row.input, null),
      saved: row.saved === 1,
      archivedAt: row.archived_at,
    };
  }

  hasBuild(server, path, number) {
    return Boolean(this.db.prepare('SELECT 1 AS x FROM jk_build WHERE server = ? AND path = ? AND number = ?').get(server, path, number));
  }

  /**
   * Keep a finished build — and, with it, its short form in the job's list and
   * its console if there is one. A build that is already here is not touched
   * unless `overwrite`: it was finished when it was kept, and nothing about it
   * can have changed. It can be pinned, though, and that is all that happens.
   *
   * @param build as `api.build` returns it
   * @param log `{ gz, chars, rawSize, truncated, skipped }` or null
   */
  put(server, path, build, log, { pin = false, overwrite = false, now = Date.now() } = {}) {
    name(path);
    let added = 0;
    const result = this.transaction(() => {
      const had = this.hasBuild(server, path, build.number);
      if (!had || overwrite) {
        this.db.prepare(
          `INSERT INTO jk_build (server, path, number, status, timestamp, duration, estimated, agent, name, description, causes, changes, parameters, artifacts, stages, input, saved, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (server, path, number) DO UPDATE SET status = excluded.status, timestamp = excluded.timestamp, duration = excluded.duration,
             estimated = excluded.estimated, agent = excluded.agent, name = excluded.name, description = excluded.description, causes = excluded.causes,
             changes = excluded.changes, parameters = excluded.parameters, artifacts = excluded.artifacts, stages = excluded.stages, input = excluded.input,
             saved = MAX(jk_build.saved, excluded.saved), archived_at = excluded.archived_at`,
        ).run(
          server, path, build.number, build.status, build.timestamp ?? null, build.duration ?? 0, build.estimated ?? null,
          build.agent ?? null, build.name ?? null, build.description ?? null,
          json(build.causes), json(build.changes), json(build.parameters), json(build.artifacts), json(build.stages), build.input ? json(build.input, null) : null,
          pin ? 1 : 0, now,
        );
      } else if (pin) {
        this.db.prepare('UPDATE jk_build SET saved = 1 WHERE server = ? AND path = ? AND number = ?').run(server, path, build.number);
      }
      // Its short form, with its stages: the list and the matrix are made of these.
      this.putRuns(server, path, [{ number: build.number, status: build.status, timestamp: build.timestamp ?? null, duration: build.duration ?? 0, estimated: build.estimated ?? null, stages: build.stages ?? [] }]);
      if (log && (!had || overwrite || !this.hasLog(server, path, build.number, { complete: true }))) this.#putLog(server, path, build.number, log, now);
      this.noteSeen(server, path, build.number);
      if (!had || overwrite) added += 280 + json(build.causes).length + json(build.changes).length + json(build.parameters).length + json(build.artifacts).length + json(build.stages).length * 2 + (log?.gz?.length ?? 0);
      return { had };
    });
    this.#grow(added);
    return result;
  }

  pin(server, path, number, on = true) {
    return this.db.prepare('UPDATE jk_build SET saved = ? WHERE server = ? AND path = ? AND number = ?').run(on ? 1 : 0, server, path, number).changes > 0;
  }

  // --- consoles ---------------------------------------------------------------

  #putLog(server, path, number, log, now) {
    this.db.prepare(
      `INSERT INTO jk_log (server, path, number, raw_size, truncated, skipped, complete, offset, carry, chars, gz, gz_bytes, archived_at, repaired, verified)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, 0, 1)
       ON CONFLICT (server, path, number) DO UPDATE SET raw_size = excluded.raw_size, truncated = excluded.truncated, skipped = excluded.skipped,
         complete = 1, offset = excluded.offset, carry = NULL, chars = excluded.chars, gz = excluded.gz, gz_bytes = excluded.gz_bytes, archived_at = excluded.archived_at,
         repaired = excluded.repaired, verified = 1`,
    ).run(server, path, number, log.rawSize ?? null, log.truncated ? 1 : 0, log.skipped ?? 0, log.rawSize ?? 0, log.chars ?? 0, log.gz, log.gz.length, now);
  }

  /** A console that was compared with Jenkins' own count and agrees. */
  markVerified(server, path, number) {
    this.db.prepare('UPDATE jk_log SET verified = 1 WHERE server = ? AND path = ? AND number = ?').run(server, path, number);
  }

  /** A console kept wrongly, read again whole and put in its place; `repaired` says that it was not the first reading. */
  replaceLog(server, path, number, log, { now = Date.now() } = {}) {
    name(path);
    this.transaction(() => {
      this.#putLog(server, path, number, log, now);
      this.db.prepare('UPDATE jk_log SET repaired = 1 WHERE server = ? AND path = ? AND number = ?').run(server, path, number);
    });
    this.size = null;
  }

  hasLog(server, path, number, { complete = false } = {}) {
    const row = this.db.prepare('SELECT complete FROM jk_log WHERE server = ? AND path = ? AND number = ?').get(server, path, number);
    return Boolean(row) && (!complete || row.complete === 1);
  }

  /** What is stored of a console: how far it got, and the gzipped text. */
  logRow(server, path, number) {
    const row = this.db.prepare('SELECT * FROM jk_log WHERE server = ? AND path = ? AND number = ?').get(server, path, number);
    if (!row) return null;
    return {
      rawSize: row.raw_size, truncated: row.truncated === 1, skipped: row.skipped, complete: row.complete === 1, offset: row.offset,
      carry: row.carry ? Buffer.from(row.carry) : Buffer.alloc(0), chars: row.chars, gz: Buffer.from(row.gz), bytes: row.gz_bytes, archivedAt: row.archived_at, repaired: row.repaired === 1, verified: row.verified === 1,
    };
  }

  /** The console as text. A gzip of several members — a console kept in pieces — is one text. */
  async readLog(server, path, number) {
    const row = this.logRow(server, path, number);
    if (!row) return null;
    let text;
    try {
      text = (await gunzip(row.gz, { maxOutputLength: MAX_LOG_TEXT })).toString('utf8');
    } catch {
      // Not a console this app wrote (too big once expanded, or not gzip at all): it is as if it were not here.
      return null;
    }
    return { ...row, text };
  }

  /**
   * Keep what has been read of a console that is still being written, and
   * where to go on from. Each piece is a gzip member of its own and is added
   * to the end of what is there, so nothing already stored is read or rewritten
   * to add to it. `carry` is the bytes Jenkins sent that are not yet safe to
   * show: they belong in front of what comes next.
   */
  appendLog(server, path, number, { gz, chars, offset, carry, rawSize, truncated, skipped, complete = false, from = null, now = Date.now() }) {
    name(path);
    let applied = true;
    this.transaction(() => {
      const had = this.db.prepare('SELECT gz, offset, complete FROM jk_log WHERE server = ? AND path = ? AND number = ?').get(server, path, number);
      // A piece says where in the console it begins (`from`) and may only be added where what is kept ends: a piece that
      // begins earlier is something already stored (two readers of one build), and one that begins later would leave a hole.
      // Either way it is not added. A console that is complete takes nothing more.
      if (from !== null && (had ? (had.complete === 1 || had.offset !== from) : from !== 0 && !truncated)) { applied = false; return; }
      if (had) {
        // Joined here and not in SQL: its `||` makes text of what it joins, which is the end of a gzip.
        const joined = Buffer.concat([Buffer.from(had.gz), gz]);
        this.db.prepare(
          `UPDATE jk_log SET gz = ?, gz_bytes = ?, chars = chars + ?, offset = ?, carry = ?, raw_size = ?, complete = ?, archived_at = ?
           WHERE server = ? AND path = ? AND number = ?`,
        ).run(joined, joined.length, chars, offset, carry?.length ? carry : null, rawSize ?? null, complete ? 1 : 0, now, server, path, number);
      } else {
        this.db.prepare(
          `INSERT INTO jk_log (server, path, number, raw_size, truncated, skipped, complete, offset, carry, chars, gz, gz_bytes, archived_at, verified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(server, path, number, rawSize ?? null, truncated ? 1 : 0, skipped ?? 0, complete ? 1 : 0, offset, carry?.length ? carry : null, chars, gz, gz.length, now);
      }
    });
    if (applied) this.#grow(gz.length);
    return applied;
  }

  // --- the short form: a job's builds, and its stages -------------------------

  /** The finished runs kept for a job, newest first. `stages` is null for one whose stages were never asked for. */
  runs(server, path, { limit = RUNS_PER_JOB, below = null } = {}) {
    const rows = below === null
      ? this.db.prepare('SELECT * FROM jk_run WHERE server = ? AND path = ? ORDER BY number DESC LIMIT ?').all(server, path, limit)
      : this.db.prepare('SELECT * FROM jk_run WHERE server = ? AND path = ? AND number < ? ORDER BY number DESC LIMIT ?').all(server, path, below, limit);
    return rows.map((row) => ({
      number: row.number, status: row.status, running: false, timestamp: row.timestamp, duration: row.duration,
      ...(row.estimated ? { estimated: row.estimated } : {}), stages: row.stages === null ? null : parse(row.stages),
    }));
  }

  /**
   * Keep finished runs. One already here is not rewritten — it was finished
   * then — except to give it the stages it did not have yet.
   */
  putRuns(server, path, runs) {
    name(path);
    const insert = this.db.prepare(
      `INSERT INTO jk_run (server, path, number, status, timestamp, duration, estimated, stages) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server, path, number) DO UPDATE SET stages = excluded.stages WHERE jk_run.stages IS NULL AND excluded.stages IS NOT NULL`,
    );
    this.transaction(() => {
      for (const run of runs) {
        insert.run(server, path, run.number, run.status, run.timestamp ?? null, run.duration ?? 0, run.estimated ?? null, run.stages === null || run.stages === undefined ? null : json(run.stages));
      }
    });
  }

  job(server, path) {
    const row = this.db.prepare('SELECT lo, w, seen FROM jk_job WHERE server = ? AND path = ?').get(server, path);
    return row ? { lo: row.lo, w: row.w, seen: row.seen } : { lo: null, w: 0, seen: 0 };
  }

  /** Where a job's sync stands now: everything Jenkins lists up to `w` is known and finished, from `lo` on. */
  setJob(server, path, { lo, w, reset = false }) {
    name(path);
    const had = this.job(server, path);
    // What was synced before and what was synced now join up, or they do not: if there is a gap between
    // them nothing can be said about the numbers in it, and only the new range counts.
    const nextLo = reset || had.lo === null ? lo : Math.min(had.lo, lo ?? had.lo);
    this.db.prepare(
      `INSERT INTO jk_job (server, path, lo, w, seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (server, path) DO UPDATE SET lo = excluded.lo, w = ${reset ? 'excluded.w' : 'MAX(jk_job.w, excluded.w)'}`,
    ).run(server, path, nextLo ?? null, Math.max(0, w), had.seen);
  }

  /** A console that was being kept and will not be: its part is dropped, so that the whole is read once it is over. */
  dropPartialLog(server, path, number) {
    this.db.prepare('DELETE FROM jk_log WHERE server = ? AND path = ? AND number = ? AND complete = 0').run(server, path, number);
  }

  /** The newest finished build the poller or a sync has seen for a job. */
  noteSeen(server, path, number) {
    name(path);
    this.db.prepare(
      `INSERT INTO jk_job (server, path, lo, w, seen) VALUES (?, ?, NULL, 0, ?)
       ON CONFLICT (server, path) DO UPDATE SET seen = MAX(jk_job.seen, excluded.seen)`,
    ).run(server, path, number);
  }

  /** Many at once: `[[path, number], …]`. */
  noteSeenMany(server, pairs) {
    this.transaction(() => { for (const [path, number] of pairs) this.noteSeen(server, path, number); });
  }

  /** Every job with something to compare with after a restart: its name and the newest finished build seen. */
  seenJobs(server) {
    return new Map(this.db.prepare('SELECT path, seen FROM jk_job WHERE server = ? AND seen > 0').all(server).map((row) => [row.path, row.seen]));
  }

  /** For each job, the newest finished build seen and when that build began: what tells that a job was made again. */
  seenStamps(server) {
    return new Map(this.db.prepare(
      `SELECT j.path AS path, j.seen AS seen, b.timestamp AS timestamp FROM jk_job j
       LEFT JOIN jk_build b ON b.server = j.server AND b.path = j.path AND b.number = j.seen
       WHERE j.server = ? AND j.seen > 0`,
    ).all(server).map((row) => [row.path, { seen: row.seen, timestamp: row.timestamp ?? null }]));
  }

  // --- what there is ----------------------------------------------------------

  /** Builds kept for one job, newest first, without their bodies. */
  builds(server, path) {
    return this.db.prepare('SELECT number, status, timestamp, duration, saved FROM jk_build WHERE server = ? AND path = ? ORDER BY number DESC').all(server, path)
      .map((row) => ({ number: row.number, status: row.status, timestamp: row.timestamp, duration: row.duration, saved: row.saved === 1 }));
  }

  /** What was kept or let go, added to the running count. Not exact — `bytes()` is — and made exact again every few thousand changes. */
  #grow(n) {
    if (this.size === null) return;
    this.size += n;
    this.sizeOps += 1;
  }

  /** How much is kept, without reading every row to say so: counted once, then kept up as things come and go. */
  #total() {
    if (this.size === null || this.sizeOps >= 5000) {
      this.size = this.bytes();
      this.sizeOps = 0;
    }
    return this.size;
  }

  /** What one build takes: its console, its summary and its short form. */
  #sizeOf(server, path, number) {
    const row = this.db.prepare(
      `SELECT (SELECT COALESCE(gz_bytes, 0) FROM jk_log WHERE server = ?1 AND path = ?2 AND number = ?3) AS l,
              (SELECT LENGTH(causes) + LENGTH(changes) + LENGTH(parameters) + LENGTH(artifacts) + LENGTH(stages) + COALESCE(LENGTH(input), 0) + COALESCE(LENGTH(description), 0) + 200 FROM jk_build WHERE server = ?1 AND path = ?2 AND number = ?3) AS b,
              (SELECT COALESCE(LENGTH(stages), 0) + 80 FROM jk_run WHERE server = ?1 AND path = ?2 AND number = ?3) AS r`,
    ).get(server, path, number);
    return (row.l ?? 0) + (row.b ?? 0) + (row.r ?? 0);
  }

  /** Bytes kept: consoles, builds and short forms. Counted by reading every row: for the count that is kept up, see `#total`. */
  bytes(server = null) {
    const where = server === null ? '' : ' WHERE server = ?';
    const args = server === null ? [] : [server];
    const logs = this.db.prepare(`SELECT COALESCE(SUM(gz_bytes), 0) AS n FROM jk_log${where}`).get(...args).n;
    const builds = this.db.prepare(
      `SELECT COALESCE(SUM(LENGTH(causes) + LENGTH(changes) + LENGTH(parameters) + LENGTH(artifacts) + LENGTH(stages) + COALESCE(LENGTH(input), 0) + COALESCE(LENGTH(description), 0) + 200), 0) AS n FROM jk_build${where}`,
    ).get(...args).n;
    const runs = this.db.prepare(`SELECT COALESCE(SUM(COALESCE(LENGTH(stages), 0) + 80), 0) AS n FROM jk_run${where}`).get(...args).n;
    return logs + builds + runs;
  }

  stats(server = null) {
    const where = server === null ? '' : ' WHERE server = ?';
    const args = server === null ? [] : [server];
    const count = (table, extra = '') => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}${extra ? `${where ? ' AND' : ' WHERE'} ${extra}` : ''}`).get(...args).n;
    const byServer = this.db.prepare('SELECT server, COUNT(*) AS builds FROM jk_build GROUP BY server').all()
      .filter((row) => server === null || row.server === server)
      .map((row) => ({ server: row.server, builds: row.builds, bytes: this.bytes(row.server) }));
    return { builds: count('jk_build'), logs: count('jk_log', 'complete = 1'), bytes: this.bytes(server), pinned: count('jk_build', 'saved = 1'), byServer };
  }

  // --- keeping it in bounds ---------------------------------------------------

  /**
   * Let go of what is over a limit: the oldest first, and never what was
   * pinned. Past `keepPerJob` a build goes with its console; past `maxBytes`
   * it is consoles first, oldest first, and only then the builds themselves.
   * A console that was started and never finished is let go after a week.
   */
  enforce({ keepPerJob, maxBytes }, { server = null, path = null, now = Date.now() } = {}) {
    let evicted = 0;
    // One job's worth, as is done each time something is kept, or all of it, as is done now and then: what takes a look at
    // every row (consoles that never finished, every job's count) is only the second.
    const everything = server === null || path === null;
    this.transaction(() => {
      if (everything) this.db.prepare('DELETE FROM jk_log WHERE complete = 0 AND archived_at < ?').run(now - PARTIAL_MAX_AGE_MS);
      const jobs = everything ? this.db.prepare('SELECT DISTINCT server, path FROM jk_build').all() : [{ server, path }];
      for (const job of jobs) {
        const old = this.db.prepare('SELECT number FROM jk_build WHERE server = ? AND path = ? AND saved = 0 ORDER BY number DESC LIMIT -1 OFFSET ?').all(job.server, job.path, keepPerJob);
        for (const { number } of old) evicted += this.#drop(job.server, job.path, number);
        // The short forms are kept well past that: they are what the list and the matrix are made of.
        this.db.prepare(
          `DELETE FROM jk_run WHERE server = ? AND path = ? AND number IN (SELECT number FROM jk_run WHERE server = ? AND path = ? ORDER BY number DESC LIMIT -1 OFFSET ?)
           AND number NOT IN (SELECT number FROM jk_build WHERE server = ? AND path = ? AND saved = 1)`,
        ).run(job.server, job.path, job.server, job.path, RUNS_PER_JOB, job.server, job.path);
      }
      // Over the size: counted exactly once, and then let go oldest first.
      if (this.#total() > maxBytes) {
        this.size = this.bytes();
        this.sizeOps = 0;
        // Consoles first, the oldest kept first, walking the index and not searching for the oldest again each time:
        // sorting every console to find twenty of them is what made this a minute long on a big archive.
        const pinned = this.db.prepare('SELECT saved FROM jk_build WHERE server = ? AND path = ? AND number = ?');
        const dropLog = this.db.prepare('DELETE FROM jk_log WHERE server = ? AND path = ? AND number = ?');
        // (Walked by time and then by row, so that a hundred consoles kept in the same millisecond are not skipped
        // where one batch ends in the middle of them.)
        let after = { at: -1, rid: -1 };
        while (this.size > maxBytes) {
          const logs = this.db.prepare(
            `SELECT rowid AS rid, server, path, number, gz_bytes, archived_at FROM jk_log
             WHERE archived_at > ?1 OR (archived_at = ?1 AND rowid > ?2) ORDER BY archived_at ASC, rowid ASC LIMIT 500`,
          ).all(after.at, after.rid);
          if (!logs.length) break;
          for (const one of logs) {
            after = { at: one.archived_at, rid: one.rid };
            if (this.size <= maxBytes) break;
            if (pinned.get(one.server, one.path, one.number)?.saved === 1) continue;
            dropLog.run(one.server, one.path, one.number);
            this.size -= one.gz_bytes;
          }
        }
        // Then, if that was not enough, the builds themselves, the oldest first.
        while (this.size > maxBytes) {
          const builds = this.db.prepare('SELECT server, path, number FROM jk_build WHERE saved = 0 ORDER BY timestamp ASC LIMIT 200').all();
          if (!builds.length) break;
          for (const one of builds) {
            if (this.size <= maxBytes) break;
            evicted += this.#drop(one.server, one.path, one.number);
          }
        }
      }
    });
    if (evicted) this.#reclaim();
    return evicted;
  }

  /**
   * What `enforce` would let go of with these limits, and changes nothing: how many builds (the oldest unsaved ones past
   * `keepPerJob` of each job) and about how many bytes (their consoles, and then whatever the size limit asks for besides).
   */
  preview({ keepPerJob, maxBytes }) {
    const over = this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(l.gz_bytes, 0)), 0) AS bytes FROM (
         SELECT server, path, number, ROW_NUMBER() OVER (PARTITION BY server, path ORDER BY number DESC) AS rn FROM jk_build WHERE saved = 0
       ) b LEFT JOIN jk_log l ON l.server = b.server AND l.path = b.path AND l.number = b.number WHERE b.rn > ?`,
    ).get(Math.max(0, Math.floor(keepPerJob)));
    const rest = this.bytes() - over.bytes;
    const bySize = rest > maxBytes ? rest - maxBytes : 0;
    return { builds: over.n, bytes: over.bytes + bySize, bySize };
  }

  #drop(server, path, number) {
    const freed = this.#sizeOf(server, path, number);
    this.db.prepare('DELETE FROM jk_log WHERE server = ? AND path = ? AND number = ?').run(server, path, number);
    this.db.prepare('DELETE FROM jk_run WHERE server = ? AND path = ? AND number = ?').run(server, path, number);
    const gone = this.db.prepare('DELETE FROM jk_build WHERE server = ? AND path = ? AND number = ?').run(server, path, number).changes;
    if (this.size !== null) this.size -= freed;
    return gone;
  }

  /** Remove what is kept of one build, a job, or a whole server. Returns how many builds went. */
  forget(server, { path = null, number = null, keepSaved = false } = {}) {
    this.size = null;
    const removed = this.#forget(server, { path, number, keepSaved });
    this.#reclaim();
    return removed;
  }

  #forget(server, { path, number, keepSaved = false }) {
    return this.transaction(() => {
      // What the person saved is theirs: a job's other builds go, those do not.
      if (keepSaved && path !== null && number === null) {
        const saved = 'number NOT IN (SELECT number FROM jk_build WHERE server = ? AND path = ? AND saved = 1)';
        for (const table of ['jk_log', 'jk_run']) this.db.prepare(`DELETE FROM ${table} WHERE server = ? AND path = ? AND ${saved}`).run(server, path, server, path);
        const removed = this.db.prepare('DELETE FROM jk_build WHERE server = ? AND path = ? AND saved = 0').run(server, path).changes;
        this.db.prepare('DELETE FROM jk_job WHERE server = ? AND path = ?').run(server, path);
        return removed;
      }
      if (path !== null && number !== null) {
        this.db.prepare('DELETE FROM jk_log WHERE server = ? AND path = ? AND number = ?').run(server, path, number);
        this.db.prepare('DELETE FROM jk_run WHERE server = ? AND path = ? AND number = ?').run(server, path, number);
        return this.db.prepare('DELETE FROM jk_build WHERE server = ? AND path = ? AND number = ?').run(server, path, number).changes;
      }
      const clause = path !== null ? ' WHERE server = ? AND path = ?' : ' WHERE server = ?';
      const args = path !== null ? [server, path] : [server];
      const removed = this.db.prepare(`DELETE FROM jk_build${clause}`).run(...args).changes;
      for (const table of ['jk_log', 'jk_run', 'jk_job']) this.db.prepare(`DELETE FROM ${table}${clause}`).run(...args);
      return removed;
    });
  }

  deleteServer(server) {
    this.forget(server);
  }
}

/**
 * Text gzipped as it arrives, so that what is being kept is never also held
 * whole: `write` each piece, `end` for the gzip. The compressed result is what
 * is in memory, which for a console is a small part of it.
 */
function gzipSink() {
  const gzip = zlib.createGzip({ level: 6 });
  const chunks = [];
  let chars = 0;
  gzip.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { gzip.on('end', resolve); gzip.on('error', reject); });
  return {
    get chars() { return chars; },
    write(text) {
      chars += text.length;
      return new Promise((resolve) => { if (gzip.write(text)) resolve(); else gzip.once('drain', resolve); });
    },
    async end() {
      gzip.end();
      await done;
      return Buffer.concat(chunks);
    },
  };
}

module.exports = { JenkinsArchive, gzipSink, RUNS_PER_JOB };
