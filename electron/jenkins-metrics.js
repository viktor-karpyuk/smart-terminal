'use strict';

/**
 * What a Jenkins dashboard is made of: a history of builds, and how busy the
 * server was while they ran.
 *
 * Jenkins answers "what is the state of every job?" well and "what happened
 * between ten and noon?" not at all: it keeps each build in its own folder and
 * remembers nothing about the server as a whole. This keeps summaries — one
 * line per build, one line per minute — and answers the questions a lead asks
 * of a CI server from them: what is running, what ran at a given moment, how
 * many failed, what is slower than it used to be, what keeps breaking.
 *
 * Two classes, apart on purpose.
 *
 * `JenkinsMetrics` is the store and the arithmetic: tables, upserts, queries.
 * It knows nothing of Jenkins and does no I/O but its database, so every
 * number it gives can be tested with rows put in by hand.
 *
 * `MetricsCollector` is what feeds it: it watches what the poller sees, fills
 * the holes a poller cannot see (two builds of one job finishing between two
 * looks), reads the executors for builds that run side by side, takes one
 * sample of the server's load a minute, and walks the history of a server once,
 * in the background, a few requests at a time.
 *
 * Its own tables (`jm_`), its own schema counter, in whatever database it is
 * given — the archive's file, so that deleting what Jenkins left on this
 * computer deletes this too. Summaries only: no console, no parameter, no
 * credential. What it keeps about a person is the name Jenkins gave the
 * trigger ("Started by user ana"), which Jenkins shows to anyone who can read
 * the build.
 *
 * Time. Every build's times are Jenkins' own, in Jenkins' own clock; samples
 * use the local clock, rounded to the minute. When the two clocks differ the
 * difference is measured (from the HTTP `Date` header) and used to say how long
 * a running build has been running, and said in `notes` when it is large.
 */

// Background work waits for a person's reads (jenkins-api.js). The thread that answers big questions never walks, and needs none of it.
let background = (fn) => fn();
/** The error the service passes on with its `code` (a plain one loses it). */
let JenkinsError = class extends Error { constructor(message, status = 0, code = null) { super(message); if (code) this.code = code; } };
const { INACTIVE_FOLDER } = require('./jenkins-board');
try { ({ background, JenkinsError } = require('./jenkins-api')); } catch { /* not there: everything runs as it did */ }

const DAY = 86_400_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** The slices a dashboard can be asked for, and how finely each is cut. */
const RANGES = {
  '1h': { ms: HOUR, bucket: MINUTE },
  '24h': { ms: DAY, bucket: 15 * MINUTE },
  '7d': { ms: 7 * DAY, bucket: 3 * HOUR },
  '30d': { ms: 30 * DAY, bucket: 12 * HOUR },
};

/** A running build is flagged when it has run this much longer than Jenkins expected. */
const STUCK_FACTOR = 2;
const STUCK_SLACK_MS = 10 * MINUTE;
/** With no estimate to compare to, a build is flagged after this long. */
const STUCK_NO_ESTIMATE_MS = 6 * HOUR;
/** A build seen running and never seen finishing is let go after this: Jenkins forgot it, or was reset. */
const OPEN_MAX_AGE_MS = 3 * DAY;
const MAX_LIVE_RUNS = 50;
const MAX_TIMELINE = 2000;
const MAX_TOP = 10;

/**
 * Flaky is alternation: the job passes and fails again and again, in short failures. One outage (pass, pass, fail, fail, pass, pass) is an incident, and a
 * job that breaks for good a few times is a set of incidents: neither is flaky. `turns` are the builds where the result changed, with their position (`rn`)
 * among the job's decided builds and `n`, how many there are.
 */
function isFlaky(turns) {
  const n = turns[0].n;
  if (n < 4 || turns.length - 1 < 3) return false;
  const lengths = [];
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].result !== 'failed') continue;
    const end = i + 1 < turns.length ? turns[i + 1].rn : n + 1;
    lengths.push(end - turns[i].rn);
  }
  if (lengths.length < 2) return false;
  return lengths.reduce((a, b) => a + b, 0) / lengths.length <= 2;
}
const MAX_BUILDS_PER_SERVER = 400_000;
const MAX_TEXT = 200;
/** The questions that touch a lot of rows, and that a worker thread may answer in the place of this one (see `offload`). */
const OFFLOADABLE = new Set(['dashboard', 'heatmapData', 'perPath', 'redJobs', 'recoveriesIn', 'runningAt', 'habits', 'timeline', 'deliveryStats']);
/** Where the worker's file is: beside this one, and in a packaged app in the unpacked folder, since a Worker cannot be read out of an asar. */
function workerPath(dir, sep = require('node:path').sep) {
  return require('node:path').join(dir, 'jenkins-metrics-worker.js').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}
/** A worker that does not answer in this long has failed, and the question is asked here instead. */
const WORKER_MS = 60_000;
const WORKER_IDLE_MS = 2 * MINUTE;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS jm_build (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     queued_at INTEGER,
     started_at INTEGER NOT NULL,
     ended_at INTEGER,
     duration INTEGER,
     estimated INTEGER,
     result TEXT,
     agent TEXT,
     cause TEXT,
     who TEXT,
     stage TEXT,
     stage_checked INTEGER NOT NULL DEFAULT 0,
     seen_at INTEGER NOT NULL,
     PRIMARY KEY (server, path, number)
   ) WITHOUT ROWID;
   CREATE INDEX IF NOT EXISTS jm_build_start ON jm_build (server, started_at);
   CREATE INDEX IF NOT EXISTS jm_build_end ON jm_build (server, ended_at);
   CREATE TABLE IF NOT EXISTS jm_sample (
     server TEXT NOT NULL,
     t INTEGER NOT NULL,
     running INTEGER NOT NULL,
     queued INTEGER NOT NULL,
     busy INTEGER NOT NULL,
     total INTEGER NOT NULL,
     offline INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (server, t)
   ) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS jm_server (
     server TEXT PRIMARY KEY,
     first_seen INTEGER,
     since INTEGER,
     active INTEGER NOT NULL DEFAULT 0,
     backfill TEXT NOT NULL DEFAULT 'none',
     window_start INTEGER,
     skew_ms INTEGER
   );
   CREATE TABLE IF NOT EXISTS jm_folder (
     server TEXT NOT NULL,
     folder TEXT NOT NULL,
     done INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (server, folder)
   ) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS jm_job (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     from_ts INTEGER NOT NULL,
     PRIMARY KEY (server, path)
   ) WITHOUT ROWID;`,
  // Per-job questions (a streak, the last failure) walk one job's builds by time, not the whole server's; and a build that was seen
  // waiting is rare enough to deserve an index of its own. The board's own settings live here too.
  `CREATE INDEX IF NOT EXISTS jm_build_job ON jm_build (server, path, ended_at);
   CREATE INDEX IF NOT EXISTS jm_build_queued ON jm_build (server, started_at) WHERE queued_at IS NOT NULL;
   CREATE TABLE IF NOT EXISTS jm_board (
     server TEXT PRIMARY KEY,
     settings TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS jm_param (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     number INTEGER NOT NULL,
     name TEXT,
     value TEXT,
     PRIMARY KEY (server, path, number)
   ) WITHOUT ROWID;`,
  // Jobs that are not alive any more as far as "red now" goes: deleted from Jenkins, disabled, or in a folder marked old.
  `CREATE TABLE IF NOT EXISTS jm_dead (
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     why TEXT NOT NULL,
     PRIMARY KEY (server, path)
   ) WITHOUT ROWID;`,
];

// --- small pure things ---------------------------------------------------------

const text = (value, max = MAX_TEXT) => {
  const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return clean || null;
};
/** A whole number held to `[low, high]`: anything outside it is brought to the edge. For settings, where "too much" means "as much as allowed". */
const whole = (value, low, high) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.floor(n))) : null;
};
/** A whole number inside `[low, high]`, or null: for what identifies a build or an instant, where a wrong number is not a nearby right one. */
const strict = (value, low, high) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= low && n <= high ? Math.floor(n) : null;
};

/** Nearest-rank percentile of an ascending list; null for an empty one. With one sample every percentile is that sample. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** The middle of an ascending list; for an even count the mean of the two middles, rounded. */
function middle(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** The result a build ended with, as the rest of the extension spells it. NOT_BUILT and anything unknown is `none`. */
function resultOf(status) {
  return status === 'success' || status === 'failed' || status === 'unstable' || status === 'aborted' ? status : 'none';
}

/**
 * Who or what started a build, from Jenkins' causes. A person (`user`), another
 * job (`upstream`), a change in the repository (`scm`), a schedule (`timer`),
 * or something else; and a short label for it that groups like with like.
 */
function triggerOf(causes) {
  for (const cause of Array.isArray(causes) ? causes : []) {
    if (cause?.user) return { cause: 'user', who: text(cause.user, 100) };
  }
  for (const cause of Array.isArray(causes) ? causes : []) {
    if (cause?.upstream) return { cause: 'upstream', who: text(`upstream: ${cause.upstream}`, 120) };
  }
  const first = (Array.isArray(causes) ? causes : []).map((cause) => String(cause?.text ?? '')).find(Boolean) ?? '';
  // Jenkins' way of saying nothing was recorded: not a trigger worth counting.
  if (!first || /legacy code|no cause information/i.test(first)) return { cause: 'unknown', who: null };
  if (/scm|source code|commit|push|web ?hook|branch indexing|pull request|merge request|\bchange\b/i.test(first)) return { cause: 'scm', who: 'SCM change' };
  if (/timer|schedul|cron|periodic/i.test(first)) return { cause: 'timer', who: 'timer' };
  if (/remote|rest|api|script/i.test(first)) return { cause: 'remote', who: 'remote' };
  return { cause: 'other', who: text(first.replace(/^started by\s*/i, ''), 80) };
}

/** Jobs a person would call deployments, by name. A heuristic, and reported as one. */
const DEPLOY_NAME = /(^|[\s/_.-])(deploy|deployment|release|publish|rollout|promote)([\s/_.-]|$)/i;

const RESULTS = new Set(['success', 'failed', 'unstable', 'aborted', 'none']);

/** What a trigger in a filter means as a label to match: a kind of trigger, or a person. */
function triggerWanted(trigger) {
  const t = String(trigger).trim().toLowerCase();
  if (t === 'scm') return { eq: 'scm change' };
  if (t === 'upstream') return { like: 'upstream: %' };
  return { eq: t };
}

/**
 * What a page is about: a folder, a pattern in the names, a branch, a trigger,
 * a result, the builds of the person who is looking, the jobs of a view. Held
 * to what is known, trimmed, and nothing else: it comes from a panel.
 */
function normalizeScope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  const str = (value, max) => {
    const clean = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
    return clean || null;
  };
  const folder = str(raw.folder, 1000)?.replace(/^\/+|\/+$/g, '');
  if (folder) out.folder = folder;
  const view = str(raw.view, 500);
  if (view) out.view = view;
  const pattern = str(raw.pattern, 200);
  if (pattern) out.pattern = pattern;
  const branch = str(raw.branch, 300);
  if (branch) out.branch = branch;
  const trigger = str(raw.trigger, 120);
  if (trigger) out.trigger = trigger;
  if (raw.mine === true) out.mine = true;
  if (typeof raw.result === 'string' && RESULTS.has(raw.result)) out.result = raw.result;
  return out;
}

/** The same scope, always spelled the same way, for keeping an answer under. */
function scopeKey(scope) {
  const sc = scope && typeof scope === 'object' ? scope : {};
  return JSON.stringify(['folder', 'view', 'pattern', 'branch', 'trigger', 'mine', 'result', 'user', 'pathsKey'].map((k) => sc[k] ?? null));
}

/** A short fingerprint of a list of paths, to tell two lists apart without keeping them. */
function fingerprint(list) {
  let h = 2166136261;
  for (const item of list) for (let i = 0; i < item.length; i += 1) { h ^= item.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `${list.length}:${h.toString(36)}`;
}

const likeEscape = (text) => String(text).replace(/[\\%_]/g, '\\$&');
/** A name pattern as LIKE: `*` and `?` as wildcards, anything else a word, and a pattern with no wildcard is "contains". */
function likePattern(pattern) {
  const wild = /[*?]/.test(pattern);
  const body = likeEscape(pattern).replace(/\*/g, '%').replace(/\?/g, '_');
  return wild ? body : `%${body}%`;
}

/** Whether a path is inside the scope, for what is not in the database: the builds running now. */
function matchScope(scope, path, trigger = null) {
  const sc = scope ?? {};
  if (sc.folder && !path.startsWith(`${sc.folder}/`)) return false;
  if (sc.pattern) {
    const wild = /[*?]/.test(sc.pattern);
    const source = sc.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    if (!new RegExp(wild ? `^${source}$` : source, 'i').test(path)) return false;
  }
  if (sc.branch && !(path === sc.branch || path.endsWith(`/${sc.branch}`))) return false;
  if (sc.paths && !sc.pathSet?.has(path)) return false;
  if (sc.trigger) {
    const label = String(trigger ?? '').toLowerCase();
    const wanted = triggerWanted(sc.trigger);
    if (wanted.like ? !label.startsWith(wanted.like.slice(0, -1)) : label !== wanted.eq) return false;
  }
  if (sc.user && trigger !== sc.user) return false;
  return true;
}

function rangeOf(range) {
  return RANGES[String(range)] ? String(range) : '24h';
}

// --- the store -----------------------------------------------------------------

class JenkinsMetrics {
  constructor(db, { now = Date.now, retentionDays = 90, sampleKeepDays = 14, readOnly = false, workerMs = WORKER_MS } = {}) {
    this.db = db;
    this.workerMs = workerMs;
    this.inflight = new Map();
    this.now = now;
    this.worker = null;
    this.workerOff = false;
    this.asking = new Map();
    this.askId = 0;
    this.retentionMs = Math.min(365, Math.max(7, whole(retentionDays, 7, 365) ?? 90)) * DAY;
    this.sampleKeepMs = Math.min(this.retentionMs, Math.max(1, whole(sampleKeepDays, 1, 365) ?? 14) * DAY);
    this.depth = 0;
    this.lastPrune = 0;
    // A handle that cannot write has nothing to migrate: that is for the one that can.
    if (!readOnly) this.#migrate();
  }

  /** The file the history is in, or null when it is not in one (memory): the place a worker thread has to open. */
  #file() {
    try {
      const file = this.db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
      return file || null;
    } catch { return null; }
  }

  /**
   * Answer a question about a lot of rows without stopping the app: in a worker thread with a read-only handle, when the
   * history is in a file (it is, in the app) and a thread can be had, and here — in the same way, a little slower to
   * answer and not slower to start — when it is not, or when the thread fails. `inline` is how to answer here when the
   * caller can do it in pieces; without it the whole answer is computed at once.
   */
  async offload(method, args = [], { inline = null } = {}) {
    if (!OFFLOADABLE.has(method)) throw new Error(`${String(method)} is not a question that can be asked of a thread`);
    const here = () => (inline ? inline() : this[method](...args));
    const file = this.workerOff || this.depth > 0 ? null : this.#file();
    if (!file) return here();
    // The same question asked while it is being answered is one question.
    let key = null;
    try { key = `${method}\n${JSON.stringify(args)}`; } catch { key = null; }
    const held = key && this.inflight.get(key);
    if (held) return held;
    const run = (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await this.#ask(file, method, args);
        } catch (error) {
          // A thread that could not be had (no worker support, a packaged file it cannot open) is not asked again: the one case where the question is answered here.
          if (error?.fatal) { this.workerOff = true; return here(); }
          // A thread that was stopped because ANOTHER question was too slow is started again, once.
          if (error?.restart && attempt === 0) continue;
          // Too slow, or a real error: answered as such. Running the same heavy question on the main thread would stop the whole app for it.
          throw error;
        }
      }
    })();
    if (key) {
      this.inflight.set(key, run);
      const forget = () => { if (this.inflight.get(key) === run) this.inflight.delete(key); };
      run.then(forget, forget);
    }
    return run;
  }

  #ask(file, method, args) {
    return new Promise((resolve, reject) => {
      let worker = this.worker;
      if (!worker) {
        try {
          const { Worker } = require('node:worker_threads');
          const path = require('node:path');
          /*
           * A Worker is started by Node's own loader, which cannot read inside an
           * asar archive the way Electron's patched fs can. The packaged app keeps
           * these files unpacked beside it (see asarUnpack), so point there.
           */
          const file = workerPath(__dirname);
          worker = new Worker(file);
        } catch (error) {
          reject(Object.assign(new Error(String(error?.message ?? error)), { fatal: true }));
          return;
        }
        worker.unref();
        worker.on('message', ({ id, value, error }) => {
          const entry = this.asking.get(id);
          if (!entry) return;
          this.asking.delete(id);
          clearTimeout(entry.timer);
          if (error) entry.reject(new Error(error)); else entry.resolve(value);
          this.#rest();
        });
        const lost = (error, fatal) => {
          // A thread that was already replaced (stopped on purpose) speaks for nobody.
          if (this.worker !== worker) return;
          this.worker = null;
          for (const [id, entry] of this.asking) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error(String(error?.message ?? 'The worker stopped')), { fatal })); this.asking.delete(id); }
        };
        worker.on('error', (error) => lost(error, true));
        worker.on('exit', () => lost(new Error('The worker stopped'), false));
        this.worker = worker;
      }
      this.askId += 1;
      const id = this.askId;
      const timer = setTimeout(() => {
        this.asking.delete(id);
        reject(new JenkinsError('That is taking too long to add up: try a shorter range or a narrower filter', 0, 'slow'));
        // The thread is still at it: it is stopped, not left to finish a question nobody waits for. Whatever else was asked of it is asked again of the next one.
        this.#stop(worker, true);
      }, this.workerMs);
      timer.unref?.();
      this.asking.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, file, now: this.now(), method, args });
      } catch (error) {
        // What cannot be copied across (a function in the arguments) is asked here.
        this.asking.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** A thread nobody has asked anything of for a while is let go; the next question starts another. */
  #rest() {
    clearTimeout(this.restTimer);
    if (this.asking.size) return;
    this.restTimer = setTimeout(() => this.close(), WORKER_IDLE_MS);
    this.restTimer.unref?.();
  }

  /** Stop a thread now; what was waiting on it is told to ask again. */
  #stop(worker, restart) {
    if (this.worker === worker) this.worker = null;
    for (const [id, entry] of this.asking) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error('The worker was restarted'), { restart })); this.asking.delete(id); }
    try { void worker?.terminate(); } catch { /* it is gone */ }
  }

  /** Let go of the thread, if there is one. */
  close() {
    clearTimeout(this.restTimer);
    const worker = this.worker;
    this.worker = null;
    for (const [id, entry] of this.asking) { clearTimeout(entry.timer); entry.reject(new Error('The history was closed')); this.asking.delete(id); }
    try { void worker?.terminate(); } catch { /* it is gone */ }
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS jm_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM jm_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO jm_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) {
      throw new Error(`The Jenkins history is at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    }
    for (let version = row.version; version < MIGRATIONS.length; version += 1) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE jm_schema SET version = ?').run(version + 1);
      });
    }
  }

  /** One transaction; one inside another joins it. */
  transaction(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN');
    this.depth = 1;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* it was already over */ }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  #all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  #get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  #run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  // --- recording ---------------------------------------------------------------

  /**
   * One build, as Jenkins described it. Stored once however many times it is
   * seen: a later look that finds it finished wins, and a later look that finds
   * it running never takes the finish away.
   *
   * `build`: `{ number, status ('running' or a result), timestamp, duration,
   * estimated?, agent?, causes? | cause/who?, queuedAt? }`. Returns whether it
   * was stored — a build with no start time cannot be placed in time.
   */
  upsertBuild(server, path, build, at = this.now()) {
    const started = strict(build.timestamp, 1, 4e12);
    const number = strict(build.number, 1, 2_000_000_000);
    const where = text(path, 2000);
    if (!started || !number || !where) return false;
    const running = build.running === true || build.status === 'running';
    const duration = running ? null : whole(Number(build.duration) || 0, 0, 400 * DAY);
    const ended = running ? null : started + duration;
    const found = build.cause !== undefined ? { cause: build.cause, who: build.who ?? null } : (build.causes ? triggerOf(build.causes) : { cause: null, who: null });
    this.#run(
      `INSERT INTO jm_build (server, path, number, queued_at, started_at, ended_at, duration, estimated, result, agent, cause, who, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (server, path, number) DO UPDATE SET
         started_at = excluded.started_at,
         ended_at   = CASE WHEN excluded.ended_at IS NOT NULL THEN excluded.ended_at ELSE jm_build.ended_at END,
         duration   = CASE WHEN excluded.ended_at IS NOT NULL THEN excluded.duration ELSE jm_build.duration END,
         result     = CASE WHEN excluded.ended_at IS NOT NULL THEN excluded.result ELSE jm_build.result END,
         estimated  = COALESCE(excluded.estimated, jm_build.estimated),
         queued_at  = COALESCE(jm_build.queued_at, excluded.queued_at),
         agent      = COALESCE(excluded.agent, jm_build.agent),
         cause      = COALESCE(excluded.cause, jm_build.cause),
         who        = COALESCE(excluded.who, jm_build.who),
         seen_at    = excluded.seen_at`,
      String(server), where, number,
      strict(build.queuedAt, 1, 4e12), started, ended, duration,
      strict(build.estimated, 1, 400 * DAY),
      running ? null : resultOf(build.status),
      text(build.agent), found.cause ?? null, text(found.who, 120), at,
    );
    return true;
  }

  upsertMany(server, path, builds, at = this.now()) {
    let stored = 0;
    this.transaction(() => { for (const build of builds) if (this.upsertBuild(server, path, build, at)) stored += 1; });
    return stored;
  }

  /** The highest build number kept for each job of a server: where looking for what is new starts. */
  watermarks(server) {
    return new Map(this.#all('SELECT path, MAX(number) AS n FROM jm_build WHERE server = ? GROUP BY path', String(server)).map((row) => [row.path, row.n]));
  }

  /** Builds seen running and not yet seen finishing. */
  openBuilds(server) {
    return this.#all('SELECT path, number, started_at FROM jm_build WHERE server = ? AND ended_at IS NULL', String(server))
      .map((row) => ({ path: row.path, number: row.number, startedAt: row.started_at }));
  }

  /** What is kept about running builds that have no trigger yet: `[{path, number}]`. */
  withoutCause(server, limit = 10) {
    return this.#all('SELECT path, number FROM jm_build WHERE server = ? AND ended_at IS NULL AND cause IS NULL ORDER BY started_at DESC LIMIT ?', String(server), limit)
      .map((row) => ({ path: row.path, number: row.number }));
  }

  recordSample(server, { t, running, queued, busy, total, offline = 0 }) {
    const at = strict(t, 1, 4e12);
    if (!at) return false;
    this.#run(
      'INSERT OR REPLACE INTO jm_sample (server, t, running, queued, busy, total, offline) VALUES (?, ?, ?, ?, ?, ?, ?)',
      String(server), Math.floor(at / MINUTE) * MINUTE,
      whole(running, 0, 1e6) ?? 0, whole(queued, 0, 1e6) ?? 0, whole(busy, 0, 1e6) ?? 0, whole(total, 0, 1e6) ?? 0, whole(offline, 0, 1e6) ?? 0,
    );
    return true;
  }

  hasSample(server, t) {
    return Boolean(this.#get('SELECT 1 AS x FROM jm_sample WHERE server = ? AND t = ?', String(server), Math.floor(t / MINUTE) * MINUTE));
  }

  // --- a server's standing -------------------------------------------------------

  serverRow(server) {
    return this.#get('SELECT first_seen, since, active, backfill, window_start, skew_ms FROM jm_server WHERE server = ?', String(server)) ?? null;
  }

  /**
   * Whether a dashboard has ever been opened for this server. Until one has,
   * only what the poller already knows is kept: no extra request is made of a
   * Jenkins on behalf of a page nobody has looked at. From then on the load is
   * sampled and the history gathered, and it stays so across restarts.
   */
  isActive(server) {
    return Boolean(this.serverRow(server)?.active);
  }

  activate(server) {
    this.#ensureServer(server);
    this.#run('UPDATE jm_server SET active = 1 WHERE server = ?', String(server));
  }

  #ensureServer(server) {
    this.#run('INSERT OR IGNORE INTO jm_server (server) VALUES (?)', String(server));
  }

  /** The first time a server was looked at: where history is known to begin, until a backfill says it begins earlier. */
  noteSeen(server, at = this.now()) {
    this.#ensureServer(server);
    this.#run('UPDATE jm_server SET first_seen = COALESCE(first_seen, ?), since = COALESCE(since, ?) WHERE server = ?', at, at, String(server));
  }

  setSkew(server, ms) {
    this.#ensureServer(server);
    this.#run('UPDATE jm_server SET skew_ms = ? WHERE server = ?', whole(ms, -7 * DAY, 7 * DAY), String(server));
  }

  setBackfill(server, state, { windowStart } = {}) {
    this.#ensureServer(server);
    this.#run('UPDATE jm_server SET backfill = ? WHERE server = ?', String(state), String(server));
    if (windowStart) this.#run('UPDATE jm_server SET window_start = ? WHERE server = ?', strict(windowStart, 1, 4e12), String(server));
    // Done: history is complete back to where the walk began.
    if (state === 'done') this.#run('UPDATE jm_server SET since = window_start WHERE server = ? AND window_start IS NOT NULL', String(server));
  }

  /** Folders still to walk, and how many there are in all. Starting again after a restart picks up where it stopped. */
  planFolders(server, folders) {
    this.transaction(() => { for (const folder of folders) this.#run('INSERT OR IGNORE INTO jm_folder (server, folder) VALUES (?, ?)', String(server), String(folder)); });
  }

  foldersLeft(server) { return this.#all('SELECT folder FROM jm_folder WHERE server = ? AND done = 0 ORDER BY folder', String(server)).map((row) => row.folder); }
  folderDone(server, folder) { this.#run('UPDATE jm_folder SET done = 1 WHERE server = ? AND folder = ?', String(server), String(folder)); }
  folderProgress(server) {
    const row = this.#get('SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM jm_folder WHERE server = ?', String(server));
    return { done: row.done, total: row.total };
  }
  clearFolders(server) { this.#run('DELETE FROM jm_folder WHERE server = ?', String(server)); }

  /** A job with more builds in the window than were read: history for it is complete only from `fromTs`. */
  setJobFrom(server, path, fromTs) {
    if (fromTs === null) this.#run('DELETE FROM jm_job WHERE server = ? AND path = ?', String(server), String(path));
    else this.#run('INSERT OR REPLACE INTO jm_job (server, path, from_ts) VALUES (?, ?, ?)', String(server), String(path), strict(fromTs, 1, 4e12));
  }
  cappedJobs(server) { return this.#all('SELECT path, from_ts FROM jm_job WHERE server = ? ORDER BY from_ts DESC', String(server)).map((row) => ({ path: row.path, from: row.from_ts })); }

  // --- stages of failures --------------------------------------------------------

  /** Failed builds in a slice whose failing stage has not been looked up yet, by job, most first. */
  unchecked(server, from, to, limit = 10, scope = null) {
    const sc = this.#scope(scope);
    return this.#all(
      `SELECT path, COUNT(*) AS n FROM jm_build WHERE server = ?${sc.sql} AND result = 'failed' AND stage_checked = 0 AND ended_at >= ? AND ended_at < ?
       GROUP BY path ORDER BY n DESC, path LIMIT ?`,
      String(server), ...sc.params, from, to, limit,
    ).map((row) => row.path);
  }

  /** Record what a job's runs said about where each failed; every failed build of it in the slice is then settled. */
  setStages(server, path, byNumber, from, to) {
    this.transaction(() => {
      const rows = this.#all(
        `SELECT number FROM jm_build WHERE server = ? AND path = ? AND result = 'failed' AND stage_checked = 0 AND ended_at >= ? AND ended_at < ?`,
        String(server), String(path), from, to,
      );
      for (const { number } of rows) {
        this.#run('UPDATE jm_build SET stage = ?, stage_checked = 1 WHERE server = ? AND path = ? AND number = ?', text(byNumber.get(number), 100), String(server), String(path), number);
      }
    });
  }

  /** Every failed build of a job that has no stages to find is settled: nothing will ever be learned about where they failed. */
  settleJob(server, path) {
    this.#run(`UPDATE jm_build SET stage_checked = 1 WHERE server = ? AND path = ? AND result = 'failed' AND stage_checked = 0`, String(server), String(path));
  }

  // --- housekeeping ----------------------------------------------------------------

  /** Old history is let go; a server's file does not grow for as long as it is used. Hourly at most. */
  prune(now = this.now(), { force = false } = {}) {
    if (!force && now - this.lastPrune < HOUR) return false;
    this.lastPrune = now;
    this.transaction(() => {
      // Seen running and never seen finishing: Jenkins forgot it. Finished as unknown, when last seen.
      this.#run("UPDATE jm_build SET ended_at = seen_at, duration = MAX(0, seen_at - started_at), result = 'none' WHERE ended_at IS NULL AND seen_at < ?", now - OPEN_MAX_AGE_MS);
      this.#run('DELETE FROM jm_build WHERE COALESCE(ended_at, started_at) < ?', now - this.retentionMs);
      this.#run('DELETE FROM jm_param WHERE NOT EXISTS (SELECT 1 FROM jm_build b WHERE b.server = jm_param.server AND b.path = jm_param.path AND b.number = jm_param.number)');
      this.#run('DELETE FROM jm_sample WHERE t < ?', now - this.retentionMs);
      // Minute samples for two weeks; after that, one in five.
      this.#run('DELETE FROM jm_sample WHERE t < ? AND (t / 60000) % 5 != 0', now - this.sampleKeepMs);
      // A server that grew without bound is cut at its oldest.
      for (const { server, n } of this.#all('SELECT server, COUNT(*) AS n FROM jm_build GROUP BY server HAVING n > ?', MAX_BUILDS_PER_SERVER)) {
        this.#run(
          `DELETE FROM jm_build WHERE server = ? AND (path, number) IN (SELECT path, number FROM jm_build WHERE server = ? ORDER BY COALESCE(ended_at, started_at) ASC LIMIT ?)`,
          server, server, n - MAX_BUILDS_PER_SERVER,
        );
      }
    });
    return true;
  }

  /** What was worked out about a server and kept for a minute is no longer true when part of its history is gone. */
  #dropCache(server) {
    for (const key of [...(this.regressionCache?.keys() ?? [])]) if (key.startsWith(`${server}|`)) this.regressionCache.delete(key);
  }

  forgetServer(server) {
    this.#dropCache(server);
    this.transaction(() => {
      for (const table of ['jm_build', 'jm_sample', 'jm_server', 'jm_folder', 'jm_job', 'jm_board', 'jm_param', 'jm_dead']) this.#run(`DELETE FROM ${table} WHERE server = ?`, String(server));
    });
  }

  forgetJob(server, path) {
    this.#dropCache(server);
    this.transaction(() => {
      this.#run('DELETE FROM jm_build WHERE server = ? AND path = ?', String(server), String(path));
      this.#run('DELETE FROM jm_job WHERE server = ? AND path = ?', String(server), String(path));
      this.#run('DELETE FROM jm_param WHERE server = ? AND path = ?', String(server), String(path));
      this.#run('DELETE FROM jm_dead WHERE server = ? AND path = ?', String(server), String(path));
    });
  }

  /** The jobs that no longer count as red (`path → why`), replacing what was said before. Returns whether anything changed. */
  setDead(server, dead) {
    const s = String(server);
    const next = new Map(dead);
    const now = new Map(this.#all('SELECT path, why FROM jm_dead WHERE server = ?', s).map((row) => [row.path, row.why]));
    let same = next.size === now.size;
    if (same) for (const [path, why] of next) if (now.get(path) !== why) { same = false; break; }
    if (same) return false;
    this.#dropCache(s);
    this.transaction(() => {
      this.#run('DELETE FROM jm_dead WHERE server = ?', s);
      for (const [path, why] of next) this.#run('INSERT INTO jm_dead (server, path, why) VALUES (?, ?, ?)', s, path, why);
    });
    return true;
  }

  /** Paths with builds kept, for telling which jobs have been deleted. */
  knownPaths(server) {
    return this.#all('SELECT DISTINCT path FROM jm_build WHERE server = ?', String(server)).map((row) => row.path);
  }

  forgetBuild(server, path, number) {
    this.#dropCache(server);
    this.#run('DELETE FROM jm_build WHERE server = ? AND path = ? AND number = ?', String(server), String(path), strict(number, 1, 2_000_000_000) ?? 0);
    this.#run('DELETE FROM jm_param WHERE server = ? AND path = ? AND number = ?', String(server), String(path), strict(number, 1, 2_000_000_000) ?? 0);
  }

  stats(server = null) {
    const rows = server
      ? this.#all('SELECT server, COUNT(*) AS builds FROM jm_build WHERE server = ? GROUP BY server', String(server))
      : this.#all('SELECT server, COUNT(*) AS builds FROM jm_build GROUP BY server');
    return rows;
  }

  // --- coverage ------------------------------------------------------------------

  /** Where history is complete from, and whether it is for a slice that begins at `from`. */
  coverage(server, from, { backfill = null } = {}) {
    const row = this.serverRow(server);
    const since = row?.since ?? null;
    const truncatedJobs = since === null ? 0 : this.#get('SELECT COUNT(*) AS n FROM jm_job WHERE server = ? AND from_ts > ?', String(server), from).n;
    const done = row?.backfill === 'done';
    return {
      from: since,
      complete: since !== null && done && since <= from && truncatedJobs === 0,
      backfill: backfill ?? (row && row.backfill !== 'none' ? { ...this.folderProgress(server), running: row.backfill === 'running' } : null),
      truncatedJobs,
    };
  }

  // --- scope ---------------------------------------------------------------------------

  /**
   * The part of a WHERE clause that says which builds a page is about, with its
   * parameters, to follow `server = ?`. Whatever a page asks, every number on
   * it is asked through this: a filter that applied to the totals and not the
   * lists would be two pages that disagree.
   */
  #scope(scope) {
    const sc = scope && typeof scope === 'object' ? scope : {};
    const sql = [];
    const params = [];
    // A folder is a range of the primary key (everything from `folder/` up to `folder0`, the next character after the slash): an index scan, where LIKE is a scan of everything.
    if (sc.folder) { sql.push('path >= ? AND path < ?'); params.push(`${sc.folder}/`, `${sc.folder}0`); }
    if (sc.pattern) { sql.push("path LIKE ? ESCAPE '\\'"); params.push(likePattern(sc.pattern)); }
    if (sc.branch) { sql.push("(path = ? OR path LIKE ? ESCAPE '\\')"); params.push(sc.branch, `%/${likeEscape(sc.branch)}`); }
    if (sc.trigger) {
      // By the label a person sees: "ana", "SCM change", "timer", "upstream: x". The words `scm`, `timer`, `remote` and `upstream` name the kinds.
      const wanted = triggerWanted(sc.trigger);
      if (wanted.like) { sql.push('who LIKE ?'); params.push(wanted.like); }
      else { sql.push('lower(who) = ?'); params.push(wanted.eq); }
    }
    if (sc.user) { sql.push('who = ?'); params.push(sc.user); }
    if (sc.result) { sql.push('result = ?'); params.push(sc.result); }
    if (sc.paths) { sql.push('path IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(sc.paths.slice(0, 5000))); }
    return { sql: sql.length ? ` AND ${sql.join(' AND ')}` : '', params };
  }

  /** Public, for what is built on top of the store (the board, the heatmap, the insights). */
  scopeOf(scope) { return this.#scope(scope); }

  // --- the dashboard ---------------------------------------------------------------------

  /**
   * Everything one dashboard page says about a slice of history, as a list of
   * steps that fill one answer, so that a caller with other things to do can
   * take a breath between them (`dashboard` just runs them all). Every number
   * is about the same builds. `live` (what is running now) is given: it comes
   * from Jenkins.
   */
  dashboardPlan(server, { range = '24h', utcOffsetMinutes = 0, now = this.now(), live = null, staleJobs = null, notes = [], backfill = null, scope = null } = {}) {
    const key = rangeOf(range);
    const { ms: length, bucket } = RANGES[key];
    const to = now;
    const from = to - length;
    const before = from - length;
    const s = String(server);
    const offset = (whole(utcOffsetMinutes, -14 * 60, 14 * 60) ?? 0) * MINUTE;
    const sc = this.#scope(scope);
    const base = (extra = '') => `server = ?${sc.sql}${extra}`;
    const P = (...rest) => [s, ...sc.params, ...rest];

    const out = {
      asOf: now, range: key, from, to, now, bucketMs: bucket,
      coverage: this.coverage(s, from, { backfill }),
      live: live ?? emptyLive(),
    };
    // The period before is compared only when the history reaches back that far: a number against a window nobody recorded is "new" for no reason.
    const prevOk = this.coverage(s, before).complete;
    out.coverage.previousComplete = prevOk;
    const ctx = {};

    // One pass over the slice for what every other number needs: how each result ended up, how long they took, and where failures failed.
    const grouped = (a, b) => {
      const counts = { success: 0, failed: 0, unstable: 0, aborted: 0, none: 0 };
      const ms = { all: 0, decided: 0 };
      let known = 0;
      for (const row of this.#all(
        `SELECT result, COUNT(*) AS n, COALESCE(SUM(duration), 0) AS dur, SUM(CASE WHEN stage IS NOT NULL THEN 1 ELSE 0 END) AS known
         FROM jm_build WHERE ${base(' AND ended_at >= ? AND ended_at < ?')} GROUP BY result`,
        ...P(a, b),
      )) {
        if (!(row.result in counts)) continue;
        counts[row.result] = row.n;
        ms.all += row.dur;
        if (row.result === 'success' || row.result === 'failed' || row.result === 'unstable') ms.decided += row.dur;
        if (row.result === 'failed') known = row.known;
      }
      return { counts, ms, known };
    };
    const durations = (a, b) => this.#all(
      `SELECT duration FROM jm_build WHERE ${base(` AND ended_at >= ? AND ended_at < ? AND result IN ('success','failed','unstable')`)} ORDER BY duration`,
      ...P(a, b),
    ).map((row) => row.duration);
    const started = (a, b) => this.#get(`SELECT COUNT(*) AS n FROM jm_build WHERE ${base(' AND started_at >= ? AND started_at < ?')}`, ...P(a, b)).n;
    const rate = (c) => {
      const n = c.success + c.failed + c.unstable;
      return n ? c.success / n : null;
    };
    const stats = (list) => ({
      n: list.length,
      avg: list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null,
      p50: middle(list),
      p95: percentile(list, 0.95),
      total: list.reduce((a, b) => a + b, 0),
    });
    const count = (c) => c.success + c.failed + c.unstable + c.aborted + c.none;

    const steps = [
      () => {
        ctx.now = grouped(from, to);
        ctx.prev = grouped(before, from);
        ctx.cur = stats(durations(from, to));
        ctx.prv = stats(durations(before, from));
        // Queue wait: from when a build was seen queued to when it began. Only for builds this app watched queue up.
        const waits = this.#all(
          `SELECT started_at - queued_at AS wait FROM jm_build WHERE ${base(' AND started_at >= ? AND started_at < ? AND queued_at IS NOT NULL AND started_at >= queued_at')} ORDER BY wait`,
          ...P(from, to),
        ).map((row) => row.wait);
        const a = ctx.now.counts;
        const b = ctx.prev.counts;
        const pv = (value) => (prevOk ? value : null);
        out.kpi = {
          finished: { count: count(a), prev: pv(count(b)) },
          success: { count: a.success, prev: pv(b.success) },
          failed: { count: a.failed, prev: pv(b.failed) },
          unstable: { count: a.unstable, prev: pv(b.unstable) },
          aborted: { count: a.aborted, prev: pv(b.aborted) },
          started: { count: started(from, to), prev: prevOk ? started(before, from) : null },
          rate: { value: rate(a), prev: prevOk ? rate(b) : null },
          duration: {
            n: ctx.cur.n, avg: ctx.cur.avg, p50: ctx.cur.p50, p95: ctx.cur.p95, total: ctx.cur.total,
            prevAvg: pv(ctx.prv.avg), prevP50: pv(ctx.prv.p50), prevP95: pv(ctx.prv.p95), prevTotal: pv(ctx.prv.total),
          },
          queueWait: { n: waits.length, avg: waits.length ? Math.round(waits.reduce((x, y) => x + y, 0) / waits.length) : null, p95: percentile(waits, 0.95) },
        };
      },
      () => { out.buckets = this.#buckets(s, sc, from, to, bucket); },
      () => { Object.assign(out, this.#when(s, sc, from, to, offset)); },
      () => {
        ctx.perPath = this.perPath(s, scope, from, to);
        out.failures = this.#failures(s, sc, scope, from, to, ctx);
      },
      () => { out.perf = this.#perf(s, sc, from, to, now); },
      () => {
        out.activity = {
          ...this.#activity(s, sc, from, to, length, ctx),
          staleJobs,
          executorHours: Math.round(ctx.now.ms.all / HOUR * 10) / 10,
          agentFlaps: this.#flaps(s, from, to),
        };
        out.capacity = this.#capacity(s, sc, from, to, ctx);
        out.notes = [...notes];
        if (!prevOk) out.notes.push(`History does not reach back far enough to compare with the ${key} before: no comparison is shown.`);
        if (scope && Object.keys(scope).length) out.notes.push('Filtered: every number and list here is about the builds that match. The load of the server (the series under the numbers) is the whole server\'s.');
      },
    ];
    return { steps, result: () => out };
  }

  dashboard(server, options = {}) {
    const plan = this.dashboardPlan(server, options);
    for (const step of plan.steps) step();
    return plan.result();
  }

  /** What each job did in a slice: how many decided, how many failed, how many ran, how long they held executors. */
  perPath(server, scope, from, to) {
    const sc = this.#scope(scope);
    return this.#all(
      `SELECT path,
              SUM(CASE WHEN result IN ('success','failed','unstable') THEN 1 ELSE 0 END) AS runs,
              SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed,
              COUNT(*) AS n, COALESCE(SUM(duration), 0) AS ms
       FROM jm_build WHERE server = ?${sc.sql} AND ended_at >= ? AND ended_at < ? GROUP BY path`,
      String(server), ...sc.params, from, to,
    );
  }

  /** Builds cut by the time they were started and finished in, with the server's load alongside. */
  #buckets(s, sc, from, to, bucket) {
    const first = Math.floor(from / bucket) * bucket;
    const last = Math.floor((to - 1) / bucket) * bucket;
    const out = new Map();
    for (let t = first; t <= last; t += bucket) {
      out.set(t, { t, started: 0, success: 0, failed: 0, unstable: 0, aborted: 0, runningMax: null, queuedMax: null, busyMax: null, executorsTotal: null });
    }
    // Whole-number arithmetic is done on a literal: a number bound to a statement is a REAL, and a real divides with a fraction.
    const w = Math.max(1, Math.trunc(bucket));
    for (const row of this.#all(`SELECT (started_at / ${w}) * ${w} AS t, COUNT(*) AS n FROM jm_build WHERE server = ?${sc.sql} AND started_at >= ? AND started_at < ? GROUP BY t`, s, ...sc.params, from, to)) {
      const one = out.get(row.t);
      if (one) one.started = row.n;
    }
    for (const row of this.#all(`SELECT (ended_at / ${w}) * ${w} AS t, result, COUNT(*) AS n FROM jm_build WHERE server = ?${sc.sql} AND ended_at >= ? AND ended_at < ? GROUP BY t, result`, s, ...sc.params, from, to)) {
      const one = out.get(row.t);
      if (one && row.result in one) one[row.result] = row.n;
    }
    for (const row of this.#all(
      `SELECT (t / ${w}) * ${w} AS b, MAX(running) AS r, MAX(queued) AS q, MAX(busy) AS u, MAX(total) AS e FROM jm_sample WHERE server = ? AND t >= ? AND t < ? GROUP BY b`,
      s, from, to,
    )) {
      const one = out.get(row.b);
      if (one) { one.runningMax = row.r; one.queuedMax = row.q; one.busyMax = row.u; one.executorsTotal = row.e; }
    }
    return [...out.values()];
  }

  /** When builds start: by hour of the day and day of the week, in the asker's own offset. One pass. */
  #when(s, sc, from, to, offset) {
    const byHour = new Array(24).fill(0);
    const byWeekday = new Array(7).fill(0);
    const off = Math.trunc(offset);
    // Day 0 of the epoch was a Thursday.
    for (const row of this.#all(
      `SELECT (((started_at + ${off}) / 3600000) % 24) AS h, ((((started_at + ${off}) / 86400000) + 4) % 7) AS d, COUNT(*) AS n
       FROM jm_build WHERE server = ?${sc.sql} AND started_at >= ? AND started_at < ? GROUP BY h, d`,
      s, ...sc.params, from, to,
    )) {
      if (row.h >= 0 && row.h < 24) byHour[row.h] += row.n;
      if (row.d >= 0 && row.d < 7) byWeekday[row.d] += row.n;
    }
    return { byHour, byWeekday };
  }

  #failures(s, sc, scope, from, to, ctx) {
    const topJobs = ctx.perPath
      .filter((row) => row.failed > 0)
      .sort((a, b) => b.failed - a.failed || b.runs - a.runs || (a.path < b.path ? -1 : 1))
      .slice(0, MAX_TOP)
      .map((row) => {
        const last = this.#get(`SELECT number, ended_at FROM jm_build WHERE server = ? AND path = ? AND result = 'failed' AND ended_at >= ? AND ended_at < ? ORDER BY ended_at DESC, number DESC LIMIT 1`, s, row.path, from, to);
        return {
          path: row.path, runs: row.runs, failed: row.failed, rate: row.runs ? row.failed / row.runs : 0,
          streak: this.streak(s, row.path),
          lastFailure: last ? { number: last.number, timestamp: last.ended_at } : null,
        };
      });

    const byStage = this.#all(
      `SELECT stage, COUNT(*) AS n FROM jm_build WHERE server = ?${sc.sql} AND result = 'failed' AND ended_at >= ? AND ended_at < ? AND stage IS NOT NULL GROUP BY stage ORDER BY n DESC, stage LIMIT ?`,
      s, ...sc.params, from, to, MAX_TOP,
    ).map((row) => ({ stage: row.stage, count: row.n }));

    const { flaky, incidents, recoveries } = this.#transitions(s, sc, from, to);
    ctx.recoveries = recoveries;
    return {
      topJobs,
      byStage,
      stageCoverage: { known: ctx.now.known, failed: ctx.now.counts.failed },
      flaky: flaky.slice(0, MAX_TOP),
      mttrMs: middle(incidents.durations),
      mttrP90Ms: percentile(incidents.durations, 0.9),
      incidents: incidents.count,
      open: this.#open(s, sc),
    };
  }

  /** How many failed builds in a row a job ends with: zero if its latest decided build passed or was unstable. */
  streak(s, path) {
    let n = 0;
    for (const row of this.#all(`SELECT result FROM jm_build WHERE server = ? AND path = ? AND result IN ('success','failed','unstable') ORDER BY ended_at DESC, number DESC LIMIT 500`, String(s), path)) {
      if (row.result !== 'failed') break;
      n += 1;
    }
    return n;
  }

  /**
   * Jobs whose latest decided build failed: red right now. One pass over the
   * server's builds with a window function. (A correlated subquery asking "is
   * this the newest?" of every failed build looked at every build of the
   * server for each of them, and took minutes at two hundred thousand.)
   */
  #open(s, sc) {
    return this.#get(
      `SELECT COUNT(*) AS n FROM (
         SELECT result, ROW_NUMBER() OVER (PARTITION BY path ORDER BY ended_at DESC, number DESC) AS rn
         FROM jm_build WHERE server = ?${sc.sql} AND result IN ('success','failed','unstable')
           AND NOT EXISTS (SELECT 1 FROM jm_dead d WHERE d.server = jm_build.server AND d.path = jm_build.path)
       ) WHERE rn = 1 AND result = 'failed'`,
      s, ...sc.params,
    ).n;
  }

  /**
   * The jobs that are red now, newest failure first, with when they turned red
   * and how many builds ago. With `oldest`, the ones that have been red the
   * longest: chosen among the `scan` most recent ones, which for a server with
   * that many red jobs is a good enough answer to "what has been broken longest".
   */
  redJobs(server, scope = null, { limit = 30, oldest = false, scan = 200 } = {}) {
    const s = String(server);
    const sc = this.#scope(scope);
    const rows = this.#all(
      `SELECT path, number, ended_at FROM (
         SELECT path, number, ended_at, result, ROW_NUMBER() OVER (PARTITION BY path ORDER BY ended_at DESC, number DESC) AS rn
         FROM jm_build WHERE server = ?${sc.sql} AND result IN ('success','failed','unstable')
           AND NOT EXISTS (SELECT 1 FROM jm_dead d WHERE d.server = jm_build.server AND d.path = jm_build.path)
       ) WHERE rn = 1 AND result = 'failed' ORDER BY ended_at DESC LIMIT ?`,
      s, ...sc.params, oldest ? Math.max(limit, scan) : limit,
    );
    const found = rows.map((row) => {
      let since = row.ended_at;
      let builds = 0;
      let firstNumber = row.number;
      for (const one of this.#all(`SELECT result, number, ended_at FROM jm_build WHERE server = ? AND path = ? AND result IN ('success','failed','unstable') ORDER BY ended_at DESC, number DESC LIMIT 500`, s, row.path)) {
        if (one.result !== 'failed') break;
        since = one.ended_at;
        firstNumber = one.number;
        builds += 1;
      }
      return { path: row.path, lastNumber: row.number, lastEndedAt: row.ended_at, since, firstNumber, builds };
    });
    return oldest ? found.sort((a, b) => a.since - b.since || (a.path < b.path ? -1 : 1)).slice(0, limit) : found;
  }

  /**
   * Only the turns in a job's history, read by the database: a build whose
   * result differs from the one before it. A flaky job is one with many; an
   * incident is a turn to failed and the turn back. Everything else — most of a
   * server's builds — never leaves it.
   */
  #transitions(s, sc, from, to) {
    const rows = this.#all(
      `SELECT path, result, ended_at, n, rn FROM (
         SELECT path, CASE WHEN result = 'failed' THEN 'failed' ELSE 'success' END AS result, ended_at, number,
                LAG(CASE WHEN result = 'failed' THEN 'failed' ELSE 'success' END) OVER (PARTITION BY path ORDER BY ended_at, number) AS prev,
                ROW_NUMBER() OVER (PARTITION BY path ORDER BY ended_at, number) AS rn,
                COUNT(*) OVER (PARTITION BY path) AS n
         FROM jm_build WHERE server = ?${sc.sql} AND result IN ('success','failed','unstable') AND ended_at >= ? AND ended_at < ?
       ) WHERE prev IS NULL OR prev != result ORDER BY path, ended_at`,
      s, ...sc.params, from, to,
    );
    const flaky = [];
    const durations = [];
    const recoveries = [];
    let count = 0;
    let at = 0;
    while (at < rows.length) {
      let end = at;
      while (end < rows.length && rows[end].path === rows[at].path) end += 1;
      const turns = rows.slice(at, end);
      const path = turns[0].path;
      if (isFlaky(turns)) flaky.push({ path, flips: turns.length - 1, runs: turns[0].n });
      // Where the slice begins the job may already have been failing: that is the end of an older incident, not the start of one.
      let start = null;
      let inherited = false;
      if (turns[0].result === 'failed') {
        const prior = this.#get(`SELECT result FROM jm_build WHERE server = ? AND path = ? AND result IN ('success','failed','unstable') AND ended_at < ? ORDER BY ended_at DESC, number DESC LIMIT 1`, s, path, from);
        inherited = prior?.result === 'failed';
      } else {
        const prior = this.#get(`SELECT result FROM jm_build WHERE server = ? AND path = ? AND result IN ('success','failed','unstable') AND ended_at < ? ORDER BY ended_at DESC, number DESC LIMIT 1`, s, path, from);
        inherited = prior?.result === 'failed';
      }
      for (let i = 0; i < turns.length; i += 1) {
        const turn = turns[i];
        if (turn.result === 'failed') {
          if (i === 0 && inherited) { start = null; continue; }
          start = turn.ended_at;
          count += 1;
        } else if (start !== null) {
          durations.push(Math.max(0, turn.ended_at - start));
          recoveries.push({ path, start, end: turn.ended_at });
          start = null;
        } else if (i === 0 && inherited) {
          // Passing again after a failure that began before the slice: a recovery all the same, of unknown start.
          recoveries.push({ path, start: null, end: turn.ended_at });
        }
      }
      at = end;
    }
    flaky.sort((a, b) => b.flips - a.flips || b.runs - a.runs || (a.path < b.path ? -1 : 1));
    return { flaky, incidents: { count, durations: durations.sort((a, b) => a - b) }, recoveries };
  }

  #perf(s, sc, from, to, now) {
    const slowest = this.#all(
      `SELECT path, number, duration FROM jm_build WHERE server = ?${sc.sql} AND ended_at >= ? AND ended_at < ? AND result IN ('success','failed','unstable') ORDER BY duration DESC, path LIMIT 5`,
      s, ...sc.params, from, to,
    ).map((row) => ({ path: row.path, number: row.number, duration: row.duration }));
    return { regressions: this.#regressions(s, sc, now), slowest };
  }

  /** What has got slower, whatever slice is looked at: the same for a minute at a time, because it reads a month of builds. */
  #regressions(s, sc, now) {
    const key = `${s}|${sc.sql}|${JSON.stringify(sc.params)}`;
    const held = this.regressionCache?.get(key);
    if (held && now - held.at < MINUTE && now >= held.at) return held.value;
    const value = this.#computeRegressions(s, sc, now);
    this.regressionCache ??= new Map();
    this.regressionCache.set(key, { at: now, value });
    while (this.regressionCache.size > 40) this.regressionCache.delete(this.regressionCache.keys().next().value);
    return value;
  }

  #computeRegressions(s, sc, now) {
    // Median of the last five successful builds against the twenty before them, for every job with enough history.
    const regressions = [];
    let path = null;
    let list = [];
    const flush = () => {
      if (path === null || list.length < 8) return;
      const recent = list.slice(0, 5).sort((a, b) => a - b);
      const older = list.slice(5, 25).sort((a, b) => a - b);
      const now_ = middle(recent);
      const was = middle(older);
      if (was > 0 && now_ / was >= 1.3) regressions.push({ path, now: now_, before: was, ratio: Math.round((now_ / was) * 100) / 100 });
    };
    for (const row of this.#all(
      `SELECT path, duration FROM (
         SELECT path, duration, ended_at, number, ROW_NUMBER() OVER (PARTITION BY path ORDER BY ended_at DESC, number DESC) AS rn
         FROM jm_build WHERE server = ?${sc.sql} AND result = 'success' AND ended_at >= ? AND ended_at < ?
       ) WHERE rn <= 25 ORDER BY path, rn`,
      s, ...sc.params, now - 30 * DAY, now + 1,
    )) {
      if (row.path !== path) { flush(); path = row.path; list = []; }
      list.push(row.duration);
    }
    flush();
    regressions.sort((a, b) => b.ratio - a.ratio || (a.path < b.path ? -1 : 1));
    return regressions.slice(0, MAX_TOP);
  }

  #activity(s, sc, from, to, length, ctx) {
    const mostBuilt = this.#all(`SELECT path, COUNT(*) AS runs FROM jm_build WHERE server = ?${sc.sql} AND started_at >= ? AND started_at < ? GROUP BY path ORDER BY runs DESC, path LIMIT ?`, s, ...sc.params, from, to, MAX_TOP)
      .map((row) => ({ path: row.path, runs: row.runs }));
    const triggers = this.#all(`SELECT who AS name, COUNT(*) AS runs FROM jm_build WHERE server = ?${sc.sql} AND started_at >= ? AND started_at < ? AND who IS NOT NULL GROUP BY who ORDER BY runs DESC, who LIMIT ?`, s, ...sc.params, from, to, MAX_TOP)
      .map((row) => ({ name: row.name, runs: row.runs }));
    // Deployments, by the name of the job: a guess, and reported as one.
    let jobs = 0;
    let finished = 0;
    let failed = 0;
    let passed = 0;
    for (const row of ctx.perPath) {
      if (!DEPLOY_NAME.test(row.path) || !row.runs) continue;
      jobs += 1;
      finished += row.runs;
      failed += row.failed;
      passed += row.success;
    }
    const days = length / DAY;
    return {
      mostBuilt,
      triggers,
      deploys: { jobs, finished, failed, successRate: finished ? passed / finished : null, perDay: Math.round((finished / days) * 100) / 100 },
    };
  }

  /** Where the executor time went, by job and by top-level folder; and how much of what was available was used. */
  #capacity(s, sc, from, to, ctx) {
    const total = ctx.now.ms.all || 0;
    const rounded = (ms) => Math.round(ms / HOUR * 100) / 100;
    const byJob = [...ctx.perPath].sort((a, b) => b.ms - a.ms || (a.path < b.path ? -1 : 1)).slice(0, MAX_TOP)
      .map((row) => ({ path: row.path, hours: rounded(row.ms), share: total ? row.ms / total : 0 }));
    const folders = new Map();
    for (const row of ctx.perPath) {
      const folder = row.path.includes('/') ? row.path.slice(0, row.path.indexOf('/')) : '';
      folders.set(folder, (folders.get(folder) ?? 0) + row.ms);
    }
    const byFolder = [...folders].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_TOP)
      .map(([folder, ms]) => ({ folder, hours: rounded(ms), share: total ? ms / total : 0 }));
    // Samples are a minute each: their sum is executor-minutes, busy and available. Only over the time there are samples for.
    const load = this.#get('SELECT COUNT(*) AS n, COALESCE(SUM(busy), 0) AS busy, COALESCE(SUM(total), 0) AS total FROM jm_sample WHERE server = ? AND t >= ? AND t < ?', s, from, to);
    return {
      byJob,
      byFolder,
      utilisation: {
        busyHours: Math.round(load.busy / 60 * 100) / 100,
        availableHours: Math.round(load.total / 60 * 100) / 100,
        ratio: load.total ? Math.min(1, load.busy / load.total) : null,
        sampleMinutes: load.n,
      },
    };
  }

  /** How often the number of agents that are offline changed between two samples: a flapping agent shows up as a high number. */
  #flaps(s, from, to) {
    let flaps = 0;
    let last = null;
    for (const row of this.#all('SELECT offline FROM jm_sample WHERE server = ? AND t >= ? AND t < ? ORDER BY t', s, from, to)) {
      if (last !== null && row.offline !== last) flaps += 1;
      last = row.offline;
    }
    return flaps;
  }

  // --- what is built on top: the board, the heatmap, the insights --------------------------------

  /** The newest build of each of these jobs (by number), with who started it and when it began and ended. */
  latestBuilds(server, paths) {
    if (!paths.length) return new Map();
    const rows = this.#all(
      `SELECT path, number, started_at, ended_at, duration, result, who, cause, queued_at, agent FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY path ORDER BY number DESC) AS rn FROM jm_build
         WHERE server = ? AND path IN (SELECT value FROM json_each(?))
       ) WHERE rn = 1`,
      String(server), JSON.stringify(paths),
    );
    return new Map(rows.map((row) => [row.path, {
      number: row.number, startedAt: row.started_at, endedAt: row.ended_at, duration: row.duration, result: row.result,
      who: row.who, cause: row.cause, queuedAt: row.queued_at, agent: row.agent,
    }]));
  }

  /** The newest successful build of each of these jobs. */
  latestSuccess(server, paths) {
    if (!paths.length) return new Map();
    const rows = this.#all(
      `SELECT path, number, ended_at FROM (
         SELECT path, number, ended_at, ROW_NUMBER() OVER (PARTITION BY path ORDER BY ended_at DESC, number DESC) AS rn FROM jm_build
         WHERE server = ? AND result = 'success' AND path IN (SELECT value FROM json_each(?))
       ) WHERE rn = 1`,
      String(server), JSON.stringify(paths),
    );
    return new Map(rows.map((row) => [row.path, { number: row.number, endedAt: row.ended_at }]));
  }

  /** How many successful builds of a job finished after an instant, and when the first of them did. Capped: "99" is "more than a few". */
  successesAfter(server, path, after, cap = 99) {
    const row = this.#get(
      `SELECT COUNT(*) AS n, MIN(ended_at) AS oldest FROM (SELECT ended_at FROM jm_build WHERE server = ? AND path = ? AND result = 'success' AND ended_at > ? ORDER BY ended_at LIMIT ?)`,
      String(server), String(path), after, cap,
    );
    return { count: row.n, oldest: row.oldest };
  }

  /** The parameter a build was started with that says which version it is, kept: a build never changes. */
  paramOf(server, path, number) {
    const row = this.#get('SELECT name, value FROM jm_param WHERE server = ? AND path = ? AND number = ?', String(server), String(path), number);
    return row ? { name: row.name, value: row.value, known: true } : { name: null, value: null, known: false };
  }

  setParam(server, path, number, name, value) {
    this.#run('INSERT OR REPLACE INTO jm_param (server, path, number, name, value) VALUES (?, ?, ?, ?, ?)', String(server), String(path), strict(number, 1, 2_000_000_000) ?? 0, text(name, 100), text(value, 100));
  }

  boardSettings(server) {
    const row = this.#get('SELECT settings FROM jm_board WHERE server = ?', String(server));
    try { return row ? JSON.parse(row.settings) : {}; } catch { return {}; }
  }

  saveBoardSettings(server, settings) {
    this.#run('INSERT OR REPLACE INTO jm_board (server, settings) VALUES (?, ?)', String(server), JSON.stringify(settings));
  }

  /**
   * Jobs by days: how many builds of each ended on each day, for the jobs that
   * failed most (or ran most) in the slice. `offsetMs` puts the days where the
   * asker's midnight is. Returns `{ total, jobs: [{ path, total, failed }], cells: Map<path, Map<day, {s,f,o,w}>> }`.
   */
  heatmapData(server, scope, { from, to, offsetMs = 0, limit = 60, sort = 'failed' }) {
    const s = String(server);
    const sc = this.#scope(scope);
    const off = Math.trunc(offsetMs);
    const total = this.#get(`SELECT COUNT(DISTINCT path) AS n FROM jm_build WHERE server = ?${sc.sql} AND ended_at >= ? AND ended_at < ?`, s, ...sc.params, from, to).n;
    const order = sort === 'activity' ? 'total DESC, failed DESC' : 'failed DESC, total DESC';
    const jobs = this.#all(
      `SELECT path, COUNT(*) AS total, SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM jm_build WHERE server = ?${sc.sql} AND ended_at >= ? AND ended_at < ? GROUP BY path ORDER BY ${order}, path LIMIT ?`,
      s, ...sc.params, from, to, limit,
    );
    const cells = new Map(jobs.map((job) => [job.path, new Map()]));
    if (jobs.length) {
      const worst = { failed: 4, unstable: 3, aborted: 2, none: 2, success: 1 };
      for (const row of this.#all(
        `SELECT path, ((ended_at + ${off}) / 86400000) AS d, result, COUNT(*) AS n FROM jm_build
         WHERE server = ? AND path IN (SELECT value FROM json_each(?)) AND ended_at >= ? AND ended_at < ? GROUP BY path, d, result`,
        s, JSON.stringify(jobs.map((job) => job.path)), from, to,
      )) {
        const byDay = cells.get(row.path);
        const cell = byDay.get(row.d) ?? { s: 0, f: 0, o: 0, u: 0, w: 0 };
        if (row.result === 'success') cell.s += row.n;
        else if (row.result === 'failed') cell.f += row.n;
        else {
          cell.o += row.n;
          if (row.result === 'unstable') cell.u += row.n;
        }
        cell.w = Math.max(cell.w, worst[row.result] ?? 0);
        byDay.set(row.d, cell);
      }
    }
    return { total, jobs, cells };
  }

  /** Jobs that were failing and passed again in a slice: `{ path, start, end }`, `start` null when the failure began before it. */
  recoveriesIn(server, scope, from, to) {
    return this.#transitions(String(server), this.#scope(scope), from, to).recoveries;
  }

  /** What was built in the last stretch, newest first: the ticker of a wall screen. */
  finished(server, scope, limit = 20) {
    const sc = this.#scope(scope);
    return this.#all(
      `SELECT path, number, result, ended_at, duration FROM jm_build WHERE server = ?${sc.sql} AND ended_at IS NOT NULL ORDER BY ended_at DESC, number DESC LIMIT ?`,
      String(server), ...sc.params, limit,
    ).map((row) => ({ path: row.path, number: row.number, result: row.result ?? 'none', endedAt: row.ended_at, duration: row.duration }));
  }

  /**
   * The recent habits of every job that has been built often enough to have any: for "has gone quiet". `slots` says at which hours of
   * the day it builds (UTC; `slot` = hour, plus 24 on a Saturday or Sunday): how many builds, on how many different days.
   */
  habits(server, scope, { since, minBuilds = 8, limit = 400 }) {
    const sc = this.#scope(scope);
    const rows = this.#all(
      `SELECT path, COUNT(*) AS n, MIN(started_at) AS first, MAX(started_at) AS last FROM jm_build
       WHERE server = ?${sc.sql} AND started_at >= ? GROUP BY path HAVING n >= ? ORDER BY n DESC LIMIT ?`,
      String(server), ...sc.params, since, minBuilds, limit,
    ).map((row) => ({ path: row.path, builds: row.n, first: row.first, last: row.last, slots: {} }));
    if (rows.length) {
      const byPath = new Map(rows.map((row) => [row.path, row]));
      for (const row of this.#all(
        `SELECT path, (CASE WHEN ((started_at / 86400000 + 4) % 7) IN (0, 6) THEN 24 ELSE 0 END + (started_at / 3600000) % 24) AS slot, COUNT(*) AS n, COUNT(DISTINCT started_at / 86400000) AS days FROM jm_build
         WHERE server = ? AND started_at >= ? AND path IN (SELECT value FROM json_each(?)) GROUP BY path, slot`,
        String(server), since, JSON.stringify(rows.map((one) => one.path)),
      )) byPath.get(row.path).slots[row.slot] = { n: row.n, days: row.days };
    }
    return rows;
  }

  /** How long the builds of a job usually take: the 95th percentile of its last thirty finished builds. */
  usualDuration(server, path) {
    const list = this.#all(`SELECT duration FROM jm_build WHERE server = ? AND path = ? AND result IN ('success','failed','unstable') ORDER BY ended_at DESC, number DESC LIMIT 30`, String(server), String(path))
      .map((row) => row.duration).sort((a, b) => a - b);
    return list.length >= 5 ? { p50: middle(list), p95: percentile(list, 0.95), n: list.length } : null;
  }

  /** How many results (of the last `count`) before an instant were successes, in a row: "red after N greens". */
  greensBefore(server, path, before, limit = 60) {
    let n = 0;
    for (const row of this.#all(`SELECT result FROM jm_build WHERE server = ? AND path = ? AND result IN ('success','failed','unstable') AND ended_at < ? ORDER BY ended_at DESC, number DESC LIMIT ?`, String(server), String(path), before, limit)) {
      if (row.result !== 'success') break;
      n += 1;
    }
    return n;
  }

  /** Builds of a job that failed between two instants. */
  failuresBetween(server, path, from, to) {
    return this.#get(`SELECT COUNT(*) AS n FROM jm_build WHERE server = ? AND path = ? AND result = 'failed' AND ended_at >= ? AND ended_at <= ?`, String(server), String(path), from, to).n;
  }

  /** The kept samples of the server's load in a slice, oldest first. */
  samples(server, from, to) {
    return this.#all('SELECT t, running, queued, busy, total, offline FROM jm_sample WHERE server = ? AND t >= ? AND t < ? ORDER BY t', String(server), from, to);
  }

  /** What the jobs that are the last stage of a pipeline of environments did: deployments, how many failed, how long to recover. */
  deliveryStats(server, paths, { from, to, scope = null }) {
    const s = String(server);
    const within = scope?.paths ? paths.filter((path) => (scope.pathSet ?? new Set(scope.paths)).has(path)) : paths;
    const sc = this.#scope({ ...(scope ?? {}), paths: within });
    const counts = { success: 0, failed: 0, unstable: 0 };
    for (const row of this.#all(`SELECT result, COUNT(*) AS n FROM jm_build WHERE server = ?${sc.sql} AND ended_at >= ? AND ended_at < ? AND result IN ('success','failed','unstable') GROUP BY result`, s, ...sc.params, from, to)) counts[row.result] = row.n;
    const deploys = counts.success + counts.failed + counts.unstable;
    const { incidents } = this.#transitions(s, sc, from, to);
    return {
      jobs: within.length,
      deploys,
      failed: counts.failed,
      successRate: deploys ? counts.success / deploys : null,
      failedShare: deploys ? counts.failed / deploys : null,
      mttrMs: middle(incidents.durations),
      mttrP90Ms: percentile(incidents.durations, 0.9),
      incidents: incidents.count,
    };
  }

  // --- the timeline ----------------------------------------------------------------

  /** Builds that overlapped `[from, to]`: began before and ended after counts. Newest `cap` kept, oldest first. */
  timeline(server, { from, to, now = this.now(), cap = MAX_TIMELINE, scope = null } = {}) {
    const s = String(server);
    const sc = this.#scope(scope);
    const rows = this.#all(
      `SELECT path, number, started_at, ended_at, result, agent, who FROM jm_build
       WHERE server = ?${sc.sql} AND started_at < ? AND COALESCE(ended_at, ?) > ?
       ORDER BY started_at DESC, path, number DESC LIMIT ?`,
      s, ...sc.params, to, now, from, cap + 1,
    );
    const truncated = rows.length > cap;
    const runs = rows.slice(0, cap).reverse().map((row) => ({
      path: row.path, number: row.number, start: row.started_at, end: row.ended_at,
      status: row.ended_at === null ? 'running' : (row.result ?? 'none'), agent: row.agent, trigger: row.who,
    }));
    return { from, to, coverageFrom: this.serverRow(s)?.since ?? null, truncated, cap, runs };
  }

  /** What was running at one instant, and how loaded the server was then. */
  runningAt(server, at, { now = this.now(), cap = 500, scope = null } = {}) {
    const s = String(server);
    const sc = this.#scope(scope);
    const rows = this.#all(
      `SELECT path, number, started_at, ended_at, result, agent FROM jm_build
       WHERE server = ?${sc.sql} AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?)
       ORDER BY started_at, path LIMIT ?`,
      s, ...sc.params, at, at, cap + 1,
    );
    const sample = this.#get('SELECT t, running, queued, busy, total FROM jm_sample WHERE server = ? AND t BETWEEN ? AND ? ORDER BY ABS(t - ?) LIMIT 1', s, at - 90_000, at + 90_000, at);
    const since = this.serverRow(s)?.since ?? null;
    const covered = since !== null && at >= since && at <= now;
    return {
      at,
      requestedAt: at,
      covered,
      coverageFrom: since,
      truncated: rows.length > cap,
      running: rows.slice(0, cap).map((row) => ({
        path: row.path, number: row.number, start: row.started_at, end: row.ended_at, elapsedAtThen: Math.max(0, Math.round(at - row.started_at)),
        stage: null, agent: row.agent, status: row.ended_at === null ? 'running' : (row.result ?? 'none'),
      })),
      load: sample ? { running: sample.running, queued: sample.queued, busy: sample.busy, executorsTotal: sample.total } : null,
      sampleAt: sample ? sample.t : null,
    };
  }
}

/** What is running and queued, narrowed to what a scope is about. The executors and agents are the whole server's, whatever is asked. */
function scoped(live, scope) {
  if (!live || !scope || !Object.keys(scope).length) return live;
  const runs = live.runs.filter((run) => matchScope(scope, run.path, run.trigger));
  // A queued item has no trigger to compare with: when the scope is about who or how, it cannot be said to match.
  const queue = scope.trigger || scope.user || scope.result ? [] : live.queue.filter((item) => matchScope(scope, item.path));
  return {
    ...live,
    runs,
    queue,
    running: runs.length,
    queued: queue.length,
    stuck: runs.filter((run) => run.stuck).length + queue.filter((item) => item.stuck).length,
  };
}

function emptyLive() {
  return {
    running: 0, queued: 0, stuck: 0,
    executors: { busy: 0, total: 0 },
    agents: { total: 0, offline: 0, list: [] },
    runs: [], queue: [],
  };
}

// --- the collector -------------------------------------------------------------------

const LIVE_CACHE_MS = 5000;
const GAP_JOBS_PER_POLL = 12;
const GAP_MAX_BUILDS = 50;
const GAP_RETRY_MS = 5 * MINUTE;
const DEAD_CHECK_MS = 5 * MINUTE;
const ENRICH_BUDGET_MS = 2500;
/** A dashboard computed this recently is the answer: a panel that re-reads on every event asks for the same page many times a second. */
const DASH_CACHE_MS = 5000;
const VIEW_CACHE_MS = 60_000;
const ME_CACHE_MS = 10 * MINUTE;
/** Between the steps of a big answer the process gets to do what else it was asked. */
const breathe = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Feeds the store from Jenkins. Nothing here is on the path of a panel call
 * except `dashboard`, `timeline` and `runningAt`; everything else runs after a
 * poll, never in front of it, never twice at once for one server.
 *
 * `options.stagesNow(id, api, rows)` — where each running job is, as a
 * `Map<path, stage>`; the service's own cached lookup. `options.sleep` — a
 * pause between requests of the background walk.
 */
class MetricsCollector {
  constructor({ db, now = Date.now, stagesNow = null, sleep = null, backfillDays = 7, perJob = 30, deepJob = 200, concurrency = 2, pause = 40, retentionDays = 90 }) {
    this.now = now;
    this.store = new JenkinsMetrics(db, { now, retentionDays });
    this.stagesNow = stagesNow;
    // A short pause between requests of the walk: kept alive, so that what was started is finished (`stop()` ends it at the next one).
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.backfillMs = Math.max(1, whole(backfillDays, 1, 90) ?? 7) * DAY;
    this.perJob = Math.min(200, Math.max(5, whole(perJob, 5, 200) ?? 30));
    this.deepJob = Math.min(500, Math.max(this.perJob, whole(deepJob, 5, 500) ?? 200));
    this.concurrency = Math.min(4, Math.max(1, whole(concurrency, 1, 4) ?? 2));
    this.pause = Math.max(0, whole(pause, 0, 5000) ?? 40);
    this.closed = false;
    /** server id → a counter bumped when the server is forgotten: what was in flight for it is dropped. */
    this.generation = new Map();
    this.busy = new Set();
    this.marks = new Map();
    /** server id → jobs whose missed builds are still waiting to be read; how many builds were too many to read; when a failing job is tried again. */
    this.pending = new Map();
    this.deadCheck = new Map();
    this.skipped = new Map();
    this.gapRetry = new Map();
    this.backfills = new Map();
    this.liveCache = new Map();
    /** server id → Map<path, since>: what was seen waiting in the queue, to tell how long a build waited. */
    this.queueSeen = new Map();
    this.skew = new Map();
    this.lastStage = new Map();
    /** `server\npath` → when it was found not to be a pipeline: its stages are not asked for again for a day. */
    this.noStages = new Map();
    /** What a page was last computed as, and when; one in flight is shared. */
    this.dashCache = new Map();
    this.viewCache = new Map();
    this.meCache = new Map();
  }

  #gen(id) { return this.generation.get(id) ?? 0; }

  stop() {
    this.closed = true;
    this.store.close();
  }

  forgetServer(id) {
    this.generation.set(id, this.#gen(id) + 1);
    for (const map of [this.marks, this.deadCheck, this.pending, this.skipped, this.gapRetry, this.backfills, this.liveCache, this.queueSeen, this.skew, this.lastStage]) map.delete(id);
    for (const key of [...this.noStages.keys()]) if (key.startsWith(`${id}\n`)) this.noStages.delete(key);
    for (const map of [this.dashCache, this.viewCache]) for (const key of [...map.keys()]) if (key.startsWith(`${id}|`) || key.startsWith(`${id}\n`)) map.delete(key);
    this.meCache.delete(id);
    this.busy.delete(id);
    this.store.forgetServer(id);
  }

  forgetJob(id, path) {
    this.marks.get(id)?.delete(path);
    this.store.forgetJob(id, path);
  }

  forgetBuild(id, path, number) {
    this.store.forgetBuild(id, path, number);
  }

  // --- after every poll -------------------------------------------------------------

  /**
   * What the poller just saw, kept. Called after each look at a server that
   * somebody cares about, so a server nobody watches is not recorded and not
   * sampled. Never throws, never overlaps itself for one server.
   */
  async afterPoll(id, api, index) {
    if (this.closed || !index || this.busy.has(id)) return;
    this.busy.add(id);
    const generation = this.#gen(id);
    try {
      const now = this.now();
      this.store.noteSeen(id, now);
      const marks = this.#marksOf(id);
      const rows = [...index.rows.values()].filter((row) => row.kind === 'job' && row.last);
      const open = new Map(this.store.openBuilds(id).map((one) => [`${one.path}\n${one.number}`, one]));
      const gaps = new Map();
      const active = this.store.isActive(id);
      this.#markDead(id, index, rows, now);

      this.store.transaction(() => {
        for (const row of rows) {
          const number = row.last.number;
          const known = marks.get(row.path);
          if (known === undefined) {
            // Never seen: the newest build is all that is known; the walk of the history fills the rest.
            this.store.upsertBuild(id, row.path, asBuild(row.last), now);
            marks.set(row.path, number);
            continue;
          }
          if (number > known) {
            if (number - known === 1) {
              this.store.upsertBuild(id, row.path, asBuild(row.last), now);
              // A build that began and ended between two looks, or one that has just begun: its trigger is worth asking for.
              gaps.set(row.path, { limit: 2, number: null });
              marks.set(row.path, number);
            } else if (!active) {
              // Nobody asked for this server's history yet: the newest build is kept, and the walk that opening it starts reads the rest.
              this.store.upsertBuild(id, row.path, asBuild(row.last), now);
              marks.set(row.path, number);
            } else {
              // Builds went by unseen (the app was closed, Jenkins was down). The mark stays where it was until they are all read: a gap not read yet is still a gap on the next poll.
              gaps.set(row.path, { limit: Math.min(GAP_MAX_BUILDS, number - known + 1), number, missed: number - known - 1 });
            }
            continue;
          }
          const was = open.get(`${row.path}\n${number}`);
          if (was) {
            // Running when last seen: now it says how it ended.
            this.store.upsertBuild(id, row.path, asBuild(row.last), now);
            if (!row.running && !gaps.has(row.path)) gaps.set(row.path, { limit: 2, number: null });
            open.delete(`${row.path}\n${number}`);
          }
        }
        // Builds seen running whose job has moved on without saying how they ended: ask for the jobs' recent builds.
        const byPath = new Map(rows.map((row) => [row.path, row]));
        for (const one of open.values()) {
          const row = byPath.get(one.path);
          if (row && row.last.number > one.number && !gaps.has(one.path)) gaps.set(one.path, { limit: Math.min(GAP_MAX_BUILDS, row.last.number - one.number + 1), number: null });
        }
      });

      // Nobody has opened this server's dashboard: what the index said is all that is kept, and nothing more is asked of Jenkins.
      if (!active) { this.store.prune(now); return; }
      await background(() => this.#fillGaps(id, api, gaps, generation, marks));
      if (this.#gen(id) !== generation) return;
      await this.#sample(id, api, index, generation);
      this.store.prune(now);
      this.#walk(id, api, index);
    } catch {
      // History is a nicety: whatever went wrong, the poll it follows already did what it was for.
    } finally {
      this.busy.delete(id);
    }
  }

  /** Which jobs no longer count for "red now": disabled, in a folder marked old, or gone from Jenkins (the last looked for every few minutes). */
  #markDead(id, index, rows, now) {
    const dead = new Map();
    for (const row of index.rows.values()) {
      if (row.kind !== 'job') continue;
      if (row.status === 'disabled') dead.set(row.path, 'disabled');
      else if (row.path.includes('/') && INACTIVE_FOLDER.test(row.path.slice(0, row.path.lastIndexOf('/')))) dead.set(row.path, 'inactive');
    }
    let seen = this.deadCheck.get(id);
    // Gone: kept builds of a job the list no longer has. Only when the list is whole.
    if (!index.truncated && index.rows.size && (!seen || now - seen.at >= DEAD_CHECK_MS)) {
      const gone = new Set();
      for (const path of this.store.knownPaths(id)) if (index.rows.get(path)?.kind !== 'job') gone.add(path);
      seen = { at: now, gone };
      this.deadCheck.set(id, seen);
    }
    for (const path of seen?.gone ?? []) if (index.rows.get(path)?.kind !== 'job') dead.set(path, 'deleted');
    this.store.setDead(id, dead);
  }

  #marksOf(id) {
    let marks = this.marks.get(id);
    if (!marks) { marks = this.store.watermarks(id); this.marks.set(id, marks); }
    return marks;
  }

  /** The recent builds of a few jobs, for what the index could not say: a build that came and went, or what started one. */
  async #fillGaps(id, api, gaps, generation, marks) {
    const now = this.now();
    let failing = this.gapRetry.get(id);
    if (!failing) { failing = new Map(); this.gapRetry.set(id, failing); }
    // A few jobs a poll, the ones that failed to answer last time after the ones that have not been tried: a job that cannot be read does not hold the rest back.
    const due = [...gaps].filter(([path]) => (failing.get(path) ?? 0) <= now);
    const wanted = due.slice(0, GAP_JOBS_PER_POLL);
    let next = 0;
    const worker = async () => {
      while (next < wanted.length && !this.closed) {
        const [path, gap] = wanted[next++];
        try {
          const builds = await api.buildsOf(path, { limit: gap.limit });
          if (this.#gen(id) !== generation) return;
          this.store.upsertMany(id, path, builds, this.now());
          failing.delete(path);
          gaps.delete(path);
          // Read all of it (or all of what Jenkins still has): only now has the job caught up.
          if (gap.number !== null) {
            marks.set(path, gap.number);
            if (gap.missed > GAP_MAX_BUILDS - 1) this.skipped.set(id, (this.skipped.get(id) ?? 0) + gap.missed - (GAP_MAX_BUILDS - 1));
          }
        } catch {
          failing.set(path, now + GAP_RETRY_MS);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, wanted.length) }, worker));
    // What is left is waiting for later polls; with a mark that has not moved, the next poll finds it again.
    this.pending.set(id, [...gaps.values()].filter((gap) => gap.number !== null).length);
  }

  /** One sample of the server's load a minute, and what that says about the clocks. */
  async #sample(id, api, index, generation) {
    const now = this.now();
    if (this.store.hasSample(id, now)) return;
    const live = await this.live(id, api, index);
    if (this.#gen(id) !== generation) return;
    this.store.recordSample(id, {
      t: now, running: live.running, queued: live.queued, busy: live.executors.busy, total: live.executors.total, offline: live.agents.offline,
    });
  }

  // --- what is running now ---------------------------------------------------------------

  /**
   * Every build running now, with the agents, the queue and the executors.
   * Kept for a few seconds, and asked of Jenkins once however many ask.
   */
  live(id, api, index, { fresh = false } = {}) {
    const held = this.liveCache.get(id);
    if (!fresh && held && this.now() - held.at < LIVE_CACHE_MS) return held.promise;
    const generation = this.#gen(id);
    const promise = this.#liveNow(id, api, index, generation);
    const entry = { at: this.now(), promise, value: null };
    this.liveCache.set(id, entry);
    promise.then((value) => { entry.value = value; }, () => { if (this.liveCache.get(id) === entry) this.liveCache.delete(id); });
    return promise;
  }

  async #liveNow(id, api, index, generation) {
    const asked = this.now();
    // The poller reads the executors itself, every few seconds, and may have left what it read on the job list: that answer is as good as a new one.
    const snap = index?.runningSnapshot;
    const reuse = snap?.value && asked - snap.at >= 0 && asked - snap.at < 5000 ? snap : null;
    const [executors, queue] = await Promise.all([
      reuse ? Promise.resolve(reuse.value) : api.running().catch((error) => ({ error })),
      api.queue().catch(() => null),
    ]);
    const now = this.now();
    const notes = [];
    // The difference between Jenkins' clock and this one, from the answer's own Date header; the header has one-second resolution.
    let skew = this.skew.get(id) ?? this.store.serverRow(id)?.skew_ms ?? 0;
    if (executors && !executors.error && executors.serverDate) {
      const measured = executors.serverDate - (reuse ? reuse.at : Math.round((asked + now) / 2));
      skew = Math.abs(measured) < 2500 ? 0 : measured;
      this.skew.set(id, skew);
      this.store.setSkew(id, skew);
    }
    if (Math.abs(skew) > 60_000) notes.push(`Jenkins' clock is ${Math.round(Math.abs(skew) / 60000)} minutes ${skew > 0 ? 'ahead of' : 'behind'} this computer's: times of builds are Jenkins', elapsed times are corrected.`);

    const byKey = new Map();
    if (executors && !executors.error) {
      for (const one of executors.builds) byKey.set(`${one.path}\n${one.number}`, { path: one.path, number: one.number, start: one.timestamp, estimated: one.estimated, agents: one.agents, waiting: false });
    } else notes.push('The agents could not be read, so builds waiting outside a node and the executors are only what the job list says.');
    // A pipeline waiting for input or in a `sleep` holds no executor: the job list still says it is running.
    for (const row of index?.rows?.values?.() ?? []) {
      if (row.kind !== 'job' || !row.running || !row.last) continue;
      const key = `${row.path}\n${row.last.number}`;
      if (!byKey.has(key)) byKey.set(key, { path: row.path, number: row.last.number, start: row.last.timestamp, estimated: row.last.estimated ?? null, agents: [], waiting: true });
    }

    const stuckAfter = (run) => (run.estimated ? Math.max(run.estimated * STUCK_FACTOR, run.estimated + STUCK_SLACK_MS) : STUCK_NO_ESTIMATE_MS);
    const runs = [];
    for (const run of byKey.values()) {
      if (!run.start) continue;
      const elapsed = Math.max(0, now + skew - run.start);
      runs.push({
        path: run.path, number: run.number, start: run.start, elapsed,
        estimated: run.estimated, progress: run.estimated ? Math.min(0.99, elapsed / run.estimated) : null,
        stage: null, agent: run.agents[0] ?? null, agents: run.agents, trigger: null,
        // `waiting` is what the first readers were given: it means "holds no executor" (`holdsNoExecutor`), not that anybody is asked anything (`waitingForInput`).
        waiting: run.waiting, holdsNoExecutor: run.waiting, waitingForInput: false, stuck: elapsed > stuckAfter(run),
      });
    }
    runs.sort((a, b) => b.start - a.start || (a.path < b.path ? -1 : 1));
    const shown = runs.slice(0, MAX_LIVE_RUNS);

    // Which of these were seen waiting in the queue, and for how long: the only way to know a build's wait.
    const queued = new Map((queue ?? []).map((one) => [one.path, one.since]));
    const seen = this.queueSeen.get(id) ?? new Map();
    for (const [path, since] of queued) if (!seen.has(path) && since) seen.set(path, since);
    this.queueSeen.set(id, seen);

    if (this.#gen(id) === generation) {
      this.store.transaction(() => {
        for (const run of runs.slice(0, 200)) {
          const waited = seen.get(run.path);
          this.store.upsertBuild(id, run.path, {
            number: run.number, timestamp: run.start, running: true, estimated: run.estimated, agent: run.agent,
            queuedAt: waited && waited <= run.start + skew ? waited - skew : undefined,
          }, now);
          // A path that started something is no longer waiting for it.
          if (waited && waited <= run.start + skew) seen.delete(run.path);
        }
      });
      // What started these builds: asked for the few that do not say yet, and kept.
      await this.#causes(id, api, generation);
      for (const run of shown) run.trigger = this.#triggerOf(id, run.path, run.number);
    }

    // Where each one is now: the service's own, cached lookup.
    if (this.stagesNow && shown.length) {
      try {
        const stages = await this.stagesNow(id, api, shown.map((run) => ({ path: run.path, last: { number: run.number } })));
        for (const run of shown) {
          run.stage = stages.get(run.path) ?? null;
          // A pipeline paused for input (the stage says so) is waiting for a person, not stuck.
          if (stages.inputs?.has(run.path)) { run.waitingForInput = true; run.stuck = false; }
        }
      } catch { /* a stage is a nicety */ }
    }

    const agents = executors && !executors.error ? executors.agents : [];
    const queueRows = (queue ?? []).slice(0, MAX_LIVE_RUNS).map((one) => ({
      id: one.id, path: one.path, since: one.since, waited: one.since ? Math.max(0, now + skew - one.since) : 0, why: one.why, stuck: Boolean(one.stuck), blocked: Boolean(one.blocked),
    }));
    return {
      running: runs.length,
      queued: (queue ?? []).length,
      stuck: runs.filter((run) => run.stuck).length + (queue ?? []).filter((one) => one.stuck).length,
      executors: executors && !executors.error ? executors.executors : { busy: 0, total: 0 },
      agents: {
        total: agents.length,
        offline: agents.filter((one) => one.offline).length,
        list: agents.slice(0, 50).map((one) => ({ name: one.name, offline: one.offline, busy: one.busy, total: one.executors, labels: one.labels.slice(0, 8) })),
      },
      runs: shown,
      queue: queueRows,
      notes,
    };
  }

  async #causes(id, api, generation) {
    const missing = this.store.withoutCause(id, 10);
    if (!missing.length) return;
    const jobs = [...new Set(missing.map((one) => one.path))];
    await Promise.all(jobs.map(async (path) => {
      try {
        const builds = await api.buildsOf(path, { limit: 3 });
        if (this.#gen(id) === generation) this.store.upsertMany(id, path, builds.filter((one) => one.running || one.number), this.now());
      } catch { /* the trigger stays unknown */ }
    }));
  }

  #triggerOf(id, path, number) {
    const row = this.store.db.prepare('SELECT who FROM jm_build WHERE server = ? AND path = ? AND number = ?').get(String(id), String(path), number);
    return row?.who ?? null;
  }

  // --- the walk of the history -----------------------------------------------------------

  /**
   * Once per server, in the background: read what the builds of the last days
   * were, a folder at a time, a few requests at once, with a pause between
   * them. Resumable: what is done stays done, and a restart goes on from there.
   */
  #walk(id, api, index) {
    if (this.closed || this.backfills.has(id)) return;
    const row = this.store.serverRow(id);
    if (row?.backfill === 'done') return;
    const generation = this.#gen(id);
    // Background work: what a person is waiting for is asked of Jenkins first.
    const job = background(() => this.#backfill(id, api, index, generation)).catch(() => {}).finally(() => { if (this.backfills.get(id) === job) this.backfills.delete(id); });
    this.backfills.set(id, job);
  }

  async #backfill(id, api, index, generation) {
    const now = this.now();
    let row = this.store.serverRow(id);
    if (row?.backfill !== 'running' || !row.window_start) this.store.setBackfill(id, 'running', { windowStart: now - this.backfillMs });
    row = this.store.serverRow(id);
    const windowStart = row.window_start;
    if (!this.store.folderProgress(id).total) {
      const folders = new Set();
      for (const one of index.rows.values()) if (one.kind === 'job') folders.add(one.path.includes('/') ? one.path.slice(0, one.path.lastIndexOf('/')) : '');
      this.store.planFolders(id, [...folders]);
    }
    const left = this.store.foldersLeft(id);
    const capped = [];
    let next = 0;
    const worker = async () => {
      while (next < left.length && !this.closed && this.#gen(id) === generation) {
        const folder = left[next++];
        try {
          const { jobs } = await api.foldersBuilds(folder, { limit: this.perJob });
          if (this.#gen(id) !== generation) return;
          this.store.transaction(() => {
            for (const one of jobs) {
              const inside = one.builds.filter((b) => b.timestamp && b.timestamp >= windowStart);
              this.store.upsertMany(id, one.path, inside, this.now());
              // As many as were asked for, and the oldest still inside the window: there may be more.
              if (one.builds.length >= this.perJob && inside.length === one.builds.length) {
                const oldest = Math.min(...inside.map((b) => b.timestamp));
                this.store.setJobFrom(id, one.path, oldest);
                capped.push(one.path);
              }
            }
          });
          this.store.folderDone(id, folder);
        } catch (error) {
          // A folder this user may not read is done; one that failed for another reason is tried again next time.
          if (error?.status === 403 || error?.status === 404) this.store.folderDone(id, folder);
        }
        await this.sleep(this.pause);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, left.length) }, worker));
    if (this.closed || this.#gen(id) !== generation) return;

    // The busiest jobs again, deeper: a job that builds every minute has more than thirty builds in a day.
    const deep = (capped.length ? capped : this.store.cappedJobs(id).map((one) => one.path)).slice(0, 200);
    let at = 0;
    const deeper = async () => {
      while (at < deep.length && !this.closed && this.#gen(id) === generation) {
        const path = deep[at++];
        try {
          const builds = await api.buildsOf(path, { limit: this.deepJob });
          if (this.#gen(id) !== generation) return;
          const inside = builds.filter((b) => b.timestamp && b.timestamp >= windowStart);
          this.store.upsertMany(id, path, inside, this.now());
          // Still more than it read: complete only from the oldest it has. Otherwise, complete.
          this.store.setJobFrom(id, path, builds.length >= this.deepJob && inside.length === builds.length ? Math.min(...inside.map((b) => b.timestamp)) : null);
        } catch { /* it stays marked as incomplete */ }
        await this.sleep(this.pause);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, deep.length) }, deeper));
    if (this.closed || this.#gen(id) !== generation) return;
    // Done keeps its list of folders: "12 of 12" is what the dashboard shows afterwards, and it is a few rows.
    if (this.store.foldersLeft(id).length === 0) this.store.setBackfill(id, 'done');
  }

  // --- the verbs ------------------------------------------------------------------------------

  /**
   * One dashboard: what is running now from Jenkins, everything else from what
   * was kept. The failing stage of the builds that failed is looked up for the
   * few jobs that failed most, within a time budget, and kept for next time.
   */
  /**
   * One dashboard: what is running now from Jenkins, everything else from what
   * was kept. The failing stage of the builds that failed is looked up for the
   * few jobs that failed most, within a time budget, and kept for next time.
   * Kept for a few seconds, and computed once however many ask.
   */
  async dashboard(id, api, index, { range = '24h', utcOffsetMinutes = 0, scope = null } = {}) {
    const key = rangeOf(range);
    const wanted = await this.#scopeFor(id, api, index, scope);
    const offset = whole(utcOffsetMinutes, -14 * 60, 14 * 60) ?? 0;
    const cacheKey = `${id}|${key}|${offset}|${scopeKey(wanted.scope)}`;
    const held = this.dashCache.get(cacheKey);
    if (held && this.now() - held.at < DASH_CACHE_MS) return held.promise;
    const promise = this.#dashboard(id, api, index, key, offset, wanted);
    const entry = { at: this.now(), promise };
    this.dashCache.set(cacheKey, entry);
    promise.catch(() => { if (this.dashCache.get(cacheKey) === entry) this.dashCache.delete(cacheKey); });
    // A few pages at most are kept: one per range and filter somebody has looked at.
    while (this.dashCache.size > 40) this.dashCache.delete(this.dashCache.keys().next().value);
    return promise;
  }

  async #dashboard(id, api, index, key, utcOffsetMinutes, wanted) {
    const now = this.now();
    const scope = wanted.scope;
    this.store.noteSeen(id, now);
    // The first time this page is asked for, the server starts being sampled; the load before this moment was not kept.
    const first = !this.store.isActive(id);
    this.store.activate(id);
    const live = await this.live(id, api, index).catch(() => null);
    const length = RANGES[key].ms;
    await this.#stages(id, api, now - length, now, scope).catch(() => {});
    // The walk starts with the first dashboard, if the poller has not started it yet.
    if (index && !this.backfills.has(id) && this.store.serverRow(id)?.backfill !== 'done' && !this.closed) this.#walk(id, api, index);
    const notes = [...wanted.notes, ...(live?.notes ?? [])];
    const cover = this.store.coverage(id, now - length, { backfill: this.#progress(id) });
    if (first) notes.push('This is the first time the dashboard is opened for this server: the load of the server is recorded from now on, and older builds are being read.');
    else if (cover.from === null) notes.push('There is no history yet: it is being gathered now.');
    else if (cover.from > now - length) notes.push(`History starts ${describeAgo(now - cover.from)} ago: the range is only partly covered.`);
    if (cover.backfill?.running) notes.push(`Reading older builds (${cover.backfill.done} of ${cover.backfill.total} folders).`);
    if (cover.truncatedJobs) notes.push(`${cover.truncatedJobs} very busy ${cover.truncatedJobs === 1 ? 'job has' : 'jobs have'} more builds in this range than were read.`);
    let staleJobs = null;
    if (index?.rows) {
      const cutoff = now - 30 * DAY;
      staleJobs = 0;
      for (const row of index.rows.values()) {
        if (row.kind === 'job' && row.status !== 'disabled' && (row.last?.timestamp ?? 0) < cutoff && matchScope(scope, row.path)) staleJobs += 1;
      }
    }
    if (index?.truncated) notes.push('This Jenkins has more jobs than this app reads: the job list, and some numbers, are a floor.');
    const plan = this.store.dashboardPlan(id, {
      range: key, utcOffsetMinutes, now, live: scoped(live, scope), staleJobs, notes, backfill: cover.backfill, scope,
    });
    // A big history takes a while to add up: a thread of its own adds it up (the window of the app does not stop for it),
    // and where there is none the process breathes between the parts so that nothing else waits for all of it.
    const result = await this.store.offload('dashboard', [id, {
      range: key, utcOffsetMinutes, now, live: scoped(live, scope), staleJobs, notes, backfill: cover.backfill, scope,
    }], { inline: async () => { for (const step of plan.steps) { step(); await breathe(); } return plan.result(); } });
    result.delivery = this.#delivery(id, index, scope, now - length, now, length);
    // Builds that went by while nobody was looking and are not read yet are not in these numbers: complete only when there are none.
    const pending = this.pending.get(id) ?? 0;
    const skipped = this.skipped.get(id) ?? 0;
    result.coverage = { ...result.coverage, pendingGaps: pending, skippedBuilds: skipped };
    if (pending) {
      result.coverage.complete = false;
      result.notes = [...result.notes, `Builds from while this app was not looking are still being read (${pending} ${pending === 1 ? 'job' : 'jobs'} left): the numbers can still grow.`];
    }
    if (skipped) result.notes = [...result.notes, `${skipped} builds from while this app was not looking were too many to read and are not counted.`];
    return result;
  }

  /** Deployments, as far as the board can tell which jobs deploy: the jobs that are the last environment of a service. */
  #delivery(id, index, scope, from, to, length) {
    const none = { env: null, jobs: 0, deploys: 0, perDay: 0, failedShare: null, successRate: null, mttrMs: null, mttrP90Ms: null, incidents: 0 };
    if (!index?.rows) return none;
    const { families } = require('./jenkins-board');
    const { DEFAULT_SETTINGS } = require('./jenkins-board');
    const found = families([...index.rows.values()], { ...DEFAULT_SETTINGS, ...this.store.boardSettings(id) });
    if (found.envs.length < 2) return none;
    const env = found.envs[found.envs.length - 1];
    // A deployment is to a pairing that is known: not one nobody chose between, nor one in a folder that says it is old.
    const paths = found.families.filter((family) => !family.ambiguous && !family.inactive).map((family) => family.members[env]).filter(Boolean);
    if (!paths.length) return none;
    const stats = this.store.deliveryStats(id, paths, { from, to, scope });
    return { env, ...stats, perDay: Math.round((stats.deploys / (length / DAY)) * 100) / 100 };
  }

  // --- what a lead reads off the history (see jenkins-insights.js) -------------------------------------

  boardSettings(id) {
    const { DEFAULT_SETTINGS } = require('./jenkins-board');
    return { ...DEFAULT_SETTINGS, ...this.store.boardSettings(id) };
  }
  saveBoardSettings(id, input) { return require('./jenkins-insights').saveBoardSettings(this, id, input); }
  board(id, api, index, args) { this.store.noteSeen(id, this.now()); return require('./jenkins-insights').board(this, id, api, index, args); }
  heatmap(id, api, index, args) { return require('./jenkins-insights').heatmap(this, id, api, index, args); }
  insights(id, api, index, args) { return require('./jenkins-insights').insights(this, id, api, index, args); }
  report(id, api, index, args) { return require('./jenkins-insights').report(this, id, api, index, args); }
  wallboard(id, api, index, args) { return require('./jenkins-insights').wallboard(this, id, api, index, args); }

  /** A scope as the store understands it, for the verbs that read straight from the history (the timeline, the instant). */
  async resolveScope(id, api, index, raw) {
    return this.#scopeFor(id, api, index, raw);
  }

  /** What the scope means for this server: its views and its user resolved, and what could not be said. */
  async #scopeFor(id, api, index, raw) {
    const asked = normalizeScope(raw);
    const scope = { ...asked };
    delete scope.view;
    delete scope.mine;
    const notes = [];
    if (asked.view) {
      const paths = await this.#viewPaths(id, api, index, asked.view).catch(() => null);
      if (paths) {
        scope.paths = paths;
        scope.pathSet = new Set(paths);
        scope.pathsKey = `${asked.view}#${fingerprint(paths)}`;
      } else {
        // A view that cannot be read has no jobs: showing everything instead would be a lie.
        scope.paths = [];
        scope.pathSet = new Set();
        scope.pathsKey = `${asked.view}#none`;
        notes.push(`The view "${asked.view}" could not be read, so nothing matches it.`);
      }
    }
    if (asked.mine) {
      const me = await this.#me(id, api);
      if (me) scope.user = me.id;
      else { scope.user = '\u0000'; notes.push('Your user could not be determined, so "mine" matches nothing.'); }
    }
    return { scope, notes, asked };
  }

  /** The jobs a view holds: Jenkins' own, or one of the views the app works out. A few seconds old at most a minute. */
  async #viewPaths(id, api, index, view) {
    const key = `${id}\n${view}`;
    const held = this.viewCache.get(key);
    if (held && this.now() - held.at < VIEW_CACHE_MS) return held.paths;
    const jobs = [...(index?.rows?.values?.() ?? [])].filter((row) => row.kind === 'job');
    let paths;
    if (view.startsWith('smart:')) {
      const cutoff = this.now() - 30 * DAY;
      const tests = {
        failing: (row) => (row.status === 'failed' || row.status === 'unstable') && !row.running,
        running: (row) => row.running,
        unstable: (row) => row.status === 'unstable',
        stale: (row) => row.status !== 'disabled' && (row.last?.timestamp ?? 0) < cutoff,
        disabled: (row) => row.status === 'disabled',
      };
      const test = tests[view.slice(6)];
      if (!test) throw new Error('no such view');
      paths = jobs.filter(test).map((row) => row.path);
    } else {
      const set = new Set();
      for (const row of await api.viewJobs(view)) {
        if (row.kind === 'job') set.add(row.path);
        else for (const job of jobs) if (job.path.startsWith(`${row.path}/`)) set.add(job.path);
      }
      paths = [...set];
    }
    paths = paths.slice(0, 5000);
    this.viewCache.set(key, { at: this.now(), paths });
    return paths;
  }

  /** Who the credentials are, for "mine": asked once in a while. */
  async #me(id, api) {
    const held = this.meCache.get(id);
    if (held && this.now() - held.at < (held.value ? ME_CACHE_MS : MINUTE)) return held.value;
    const value = await api.whoami?.().catch(() => null) ?? null;
    this.meCache.set(id, { at: this.now(), value });
    return value;
  }

  #progress(id) {
    const row = this.store.serverRow(id);
    if (!row || row.backfill === 'none') return null;
    return { ...this.store.folderProgress(id), running: row.backfill === 'running' && !this.closed };
  }

  /** Look up where the most-failing jobs' failed builds failed, once each, as long as the budget allows. */
  async #stages(id, api, from, to, scope = null) {
    const asked = this.store.unchecked(id, from, to, 10, scope);
    // What is known not to be a pipeline is settled without asking: there is no stage to find.
    const jobs = [];
    for (const path of asked) {
      const when = this.noStages.get(`${id}\n${path}`);
      if (when !== undefined && this.now() - when < DAY) this.store.settleJob(id, path);
      else jobs.push(path);
    }
    if (!jobs.length) return;
    const generation = this.#gen(id);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && !this.closed) {
        const path = jobs[next++];
        try {
          const { available, runs } = await api.runs(path);
          if (this.#gen(id) !== generation) return;
          const byNumber = new Map();
          if (available) {
            for (const run of runs) {
              const failed = (run.stages ?? []).find((stage) => stage.status === 'failed' && stage.executed !== false);
              if (failed) byNumber.set(run.number, failed.name);
            }
          }
          // A job with no stages (or not a pipeline) is settled too: asking again would say the same.
          if (!available) { this.noStages.set(`${id}\n${path}`, this.now()); this.store.settleJob(id, path); }
          else this.store.setStages(id, path, byNumber, from, to);
        } catch { /* asked again next time */ }
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
    await Promise.race([all, this.sleep(ENRICH_BUDGET_MS)]);
  }

  timeline(id, { range, from, to, scope = null } = {}) {
    const now = this.now();
    let end = strict(to, 1, 4e12) ?? now;
    let start = strict(from, 0, 4e12);
    if (start === null) start = end - RANGES[rangeOf(range)].ms;
    end = Math.min(end, now);
    start = Math.max(start, end - 31 * DAY);
    if (start >= end) start = end - MINUTE;
    return { ...this.store.timeline(id, { from: start, to: end, now, scope }), range: range ? rangeOf(range) : null };
  }

  /**
   * What was running at `at`. For a moment within a couple of minutes of now,
   * the stage each build is in is added from the last look at what is running:
   * what ran before cannot be asked.
   */
  runningAt(id, { at, scope = null } = {}) {
    // The instant asked for, exactly (a cursor on a chart is not a whole millisecond).
    const instant = typeof at === 'number' || (typeof at === 'string' && at.trim() !== '') ? Number(at) : NaN;
    if (!Number.isFinite(instant) || instant < 1 || instant > 4e12) throw new Error('at has to be a time in milliseconds');
    const now = this.now();
    const result = this.store.runningAt(id, instant, { now, scope });
    const held = this.liveCache.get(id);
    if (held?.value && Math.abs(now - instant) < 2 * MINUTE) {
      const stages = new Map(held.value.runs.map((run) => [`${run.path}\n${run.number}`, run.stage]));
      for (const run of result.running) if (run.end === null) run.stage = stages.get(`${run.path}\n${run.number}`) ?? null;
    }
    return result;
  }
}

function asBuild(last) {
  return {
    number: last.number,
    status: last.running ? 'running' : last.status,
    running: Boolean(last.running),
    timestamp: last.timestamp,
    duration: last.duration,
    estimated: last.estimated ?? null,
  };
}

function describeAgo(ms) {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 90) return `${Math.max(1, minutes)} minutes`;
  const hours = Math.round(ms / HOUR);
  if (hours < 72) return `${hours} hours`;
  return `${Math.round(ms / DAY)} days`;
}

module.exports = {
  JenkinsMetrics, MetricsCollector, OFFLOADABLE, workerPath, RANGES, DAY, MINUTE, HOUR,
  percentile, middle, triggerOf, resultOf, rangeOf, DEPLOY_NAME, emptyLive, scoped, normalizeScope, scopeKey, matchScope, likeEscape, likePattern,
};
