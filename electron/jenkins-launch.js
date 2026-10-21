'use strict';

const crypto = require('node:crypto');
const { JenkinsError, jobPath, segment } = require('./jenkins-api');
const { familyOf, vocabulary } = require('./jenkins-board');
const { ActiveChoices } = require('./jenkins-active-choices');

const REACTIVE = /^(cascadechoice|dynamicreference)parameter$/;

/**
 * Starting builds, and everything a person wants around the click.
 *
 * What to start next (the launchpad), what it will be started with and where
 * each value came from (the parameter plan), whether it can be started at all
 * (the launch plan), starting many at once in order or together, moving one
 * environment's build to the next, starting one later, and what was started
 * before. Each is a verb on the Jenkins service; this file is all of them, so
 * that the service stays the one door and this stays one piece.
 *
 * Four decisions are worth stating rather than discovering.
 *
 * **A secret is never kept.** A launch is recorded with the values of its
 * ordinary parameters and only the *names* of the secret ones — a password type,
 * or a name that sounds like one — so "run it again" knows to ask for them. A
 * schedule would have to keep the value until it fires, so a schedule that
 * carries one is refused: run that one now.
 *
 * **Nothing old is run on its own.** A schedule fires while the app is open. If
 * the machine slept through it, or the app was closed, it is *missed* — shown,
 * for the person to run now or dismiss — never fired late; a deploy meant for
 * six o'clock does not start at nine because the lid was opened. A batch that
 * the app was closed in the middle of is *interrupted*, and nothing resumes it.
 *
 * **Many at once is validated before any starts.** One job that is disabled, or
 * needs a password nobody gave, refuses the whole batch (naming it), because a
 * deploy chain half-started is worse than one not started. The same request
 * twice within ten seconds is one batch, and at most twenty launches a minute
 * leave this app: a runaway loop is a rate, not an outage.
 *
 * **A launch is followed to the end.** Starting a job gives a place in the
 * queue, not a build: the queue item is asked until it says which build it
 * became (or that it was cancelled), and then that build until it ends. That is
 * what lets the history say how each one finished, a sequential batch start its
 * next, and a notification say a build ended. All of it survives a restart,
 * because it lives in the table and not in a timer.
 *
 * Its own tables (`jl_*`) in the archive's file, with their own schema counter:
 * the archive is a file a person may delete, and everything here goes with it.
 */

const HISTORY_PER_SERVER = 5000;
const HISTORY_DAYS = 90;
const BATCH_MAX = 20;
const PARAMS_MAX = 100;
const VALUE_MAX = 4000;
const RATE_MAX = 20;
const RATE_WINDOW_MS = 60_000;
const IDEMPOTENT_MS = 10_000;
const STAGGER_MS = 250;
const SCHEDULE_MIN_MS = 30_000;
const SCHEDULE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const SCHEDULES_PER_SERVER = 50;
/** How late a schedule may fire and still be what the person asked for. */
const LATE_MS = 2 * 60_000;
/** What a schedule for something that looks like production may be late by: a deploy meant for six is not one for a laptop that woke at 6:01. */
const LATE_PROD_MS = 45_000;
/** A schedule that was missed is told once and then let go. */
const MISSED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const SCHEDULE_BEAT_MS = 30_000;
const RESOLVE_MS = 3000;
/** A launch Jenkins never says anything more about is let go of after this. */
const LOST_AFTER_MS = 6 * 60 * 60 * 1000;
/** How long a queue item may be missing, with no build to show for it, before it is called lost. */
const QUEUE_GONE_MS = 10 * 60_000;
const DEFS_TTL_MS = 5 * 60_000;
const TILES_EACH = 8;
const TILES_FAILING = 12;
const TILE_DEFS_MAX = 24;
const PLAN_PARALLEL = 4;
const PROMOTE_COMMITS_MAX = 30;
const PROMOTE_SCAN = 8;
const BATCH_EVENT_MS = 300;
const NOTE_MAX = 300;
/** What a launch decision may rely on of the index: a few seconds old, not the quarter-minute that search and the smart views live with. */
const INDEX_AGE_MS = 4000;

/** What a masked value looks like when Jenkins's own record of a build is read. */
const MASK = '••••••';
/** Parameters whose value is, in practice, "which version" — what two environments' builds are compared by. */
const VERSION_LIKE = /^(version|tag|image|image_?tag|image_?version|release|build_?number|commit|sha|revision|rev|git_?(commit|sha|ref|branch)|branch|ref)$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const VALUE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const TERMINAL = new Set(['success', 'failed', 'unstable', 'aborted', 'lost', 'error']);
const ITEM_TERMINAL = new Set(['success', 'failed', 'unstable', 'aborted', 'error', 'skipped']);
const SOURCES = new Set(['manual', 'runMany', 'retry', 'promote', 'schedule']);

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS jl_launch (
     id INTEGER PRIMARY KEY,
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     params TEXT NOT NULL DEFAULT '{}',
     needs TEXT NOT NULL DEFAULT '[]',
     source TEXT NOT NULL,
     batch TEXT,
     from_path TEXT,
     from_number INTEGER,
     queue_id INTEGER,
     after_number INTEGER,
     number INTEGER,
     state TEXT NOT NULL,
     error TEXT,
     at INTEGER NOT NULL,
     started_at INTEGER,
     ended_at INTEGER,
     checked_at INTEGER NOT NULL,
     follow INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX IF NOT EXISTS jl_launch_job ON jl_launch (server, path, id);
   CREATE INDEX IF NOT EXISTS jl_launch_open ON jl_launch (state);
   CREATE INDEX IF NOT EXISTS jl_launch_at ON jl_launch (server, at);
   CREATE INDEX IF NOT EXISTS jl_launch_batch ON jl_launch (batch);
   CREATE TABLE IF NOT EXISTS jl_batch (
     id TEXT PRIMARY KEY,
     server TEXT NOT NULL,
     mode TEXT NOT NULL,
     stop_on_failure INTEGER NOT NULL,
     follow INTEGER NOT NULL,
     source TEXT NOT NULL,
     items TEXT NOT NULL,
     state TEXT NOT NULL,
     at INTEGER NOT NULL,
     updated INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS jl_batch_server ON jl_batch (server, at);
   CREATE TABLE IF NOT EXISTS jl_schedule (
     id TEXT PRIMARY KEY,
     server TEXT NOT NULL,
     path TEXT NOT NULL,
     params TEXT NOT NULL,
     at INTEGER NOT NULL,
     note TEXT,
     state TEXT NOT NULL,
     created INTEGER NOT NULL,
     fired_at INTEGER,
     launch_id INTEGER,
     error TEXT
   );
   CREATE INDEX IF NOT EXISTS jl_schedule_due ON jl_schedule (state, at);
   CREATE INDEX IF NOT EXISTS jl_schedule_server ON jl_schedule (server, at);`,
  // What was done on purpose that a launch's parameters do not say: an unstable build promoted, an older one, a busy target.
  'ALTER TABLE jl_launch ADD COLUMN note TEXT;',
];

// --- arguments ---------------------------------------------------------------------

function needText(value, what, max = 500) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!text) throw new JenkinsError(`${what} is missing`);
  if (text.length > max) throw new JenkinsError(`${what} is too long`);
  return text;
}

/** A job's name has no control characters (Jenkins will not make one that has), and the database ends a string at a NUL. */
function needPath(value, what = 'job') {
  const path = needText(value, what, 2000);
  if (CONTROL.test(path)) throw new JenkinsError(`${what} is not a name Jenkins could have`);
  if (!path.replace(/^\/+|\/+$/g, '')) throw new JenkinsError(`${what} is missing`);
  // The same check the requests will make, said now and in words.
  jobPath(path);
  return path.replace(/^\/+|\/+$/g, '');
}

function needInt(value, what, min = 0, max = 2_000_000_000) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) throw new JenkinsError(`${what} is missing`);
  return n;
}

const clip = (text, max) => String(text ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Parameters as text by name, or an error that says which one is wrong. */
function paramsIn(value, what = 'parameters') {
  const params = Object.create(null);
  if (value === undefined || value === null) return params;
  if (typeof value !== 'object' || Array.isArray(value)) throw new JenkinsError(`${what} have to be a list of names and values`);
  const entries = Object.entries(value);
  if (entries.length > PARAMS_MAX) throw new JenkinsError('That is more parameters than a job takes');
  for (const [name, raw] of entries) {
    segment(name, 'A parameter name');
    if (raw !== null && !['string', 'number', 'boolean'].includes(typeof raw)) throw new JenkinsError(`The value of ${clip(name, 40)} has to be text, a number or yes/no`);
    const text = String(raw ?? '');
    if (text.length > VALUE_MAX) throw new JenkinsError(`The value of ${clip(name, 40)} is longer than ${VALUE_MAX} characters`);
    // A newline is a value (a text parameter); a character that is not text is not one.
    if (VALUE_CONTROL.test(text)) throw new JenkinsError(`The value of ${clip(name, 40)} has characters that are not text`);
    params[name] = text;
  }
  return params;
}

const asText = (value) => (value === null || value === undefined ? '' : typeof value === 'boolean' ? String(value) : String(value));

function safeJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function median(list) {
  const sorted = list.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** `map` with at most `limit` in flight; the order of the results is the order of the input. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      out[at] = await fn(items[at], at);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Whether a parameter's name is the name of a secret: by its words, not by a substring — `API_KEY`, `apiKey`,
 * `DB_PASSWORD`, `PWD`, `PAT`, `AUTH_HEADER` and `PRIVATE_KEY` are, `KEYSTORE_ALIAS` and `MONKEY` are not.
 */
const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'pass', 'passphrase', 'secret', 'secrets', 'token', 'tokens', 'key', 'keys', 'credential', 'credentials', 'cred', 'creds', 'auth', 'authorization', 'bearer', 'pat', 'private', 'cert', 'certificate']);
const SECRET_COMPOUND = /apikey|accesskey|secretkey|privatekey|authtoken|passwd|password|credential/i;
const wordsOf = (name) => String(name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function isSecretName(name) {
  return wordsOf(name).some((word) => SECRET_WORDS.has(word)) || SECRET_COMPOUND.test(String(name ?? ''));
}

/**
 * Whether a value is a credential, whatever its parameter is called: a URL with a password in it, a bearer header,
 * a token of a service that has a recognisable shape, a JWT, an access key id — or forty characters or more of
 * letters and digits with no dot or slash to say it is anything else (a hash of a commit is not one).
 */
function looksSecretValue(value) {
  const text = String(value ?? '');
  if (text.length < 8) return false;
  if (/:\/\/[^/@\s]+:[^@\s]+@/.test(text)) return true;
  if (/\bBearer\s+\S{6,}/i.test(text)) return true;
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}/.test(text)) return true;
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) return true;
  if (/\bxox[abprs]-[A-Za-z0-9-]{10,}/.test(text)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(text)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  if (text.length >= 40 && /^[A-Za-z0-9+_=-]+$/.test(text) && /[A-Za-z]/.test(text) && /[0-9]/.test(text) && !/^[0-9a-f]+$/i.test(text)) return true;
  return false;
}

const isSecretParam = (definition) => Boolean(definition?.secret) || isSecretName(definition?.name);

/**
 * A job's parameters, with what was given: what is sent, what is kept (no secret), and which
 * secrets were part of it. `defs` are the job's own definitions (`api.job().parameters`).
 * A parameter is a secret by its definition, by its name, or by what its value looks like.
 */
function splitSecrets(defs, given) {
  const secretNames = new Set((defs ?? []).filter(isSecretParam).map((one) => one.name));
  const kept = {};
  const needs = [];
  for (const [name, value] of Object.entries(given ?? {})) {
    if (secretNames.has(name) || isSecretName(name) || looksSecretValue(value)) needs.push(name);
    else kept[name] = value;
  }
  for (const name of secretNames) if (!needs.includes(name)) needs.push(name);
  return { kept, needs };
}

/** What a definition needs the person to say: no default to fall back on, and not a yes/no or a pick. */
const isRequired = (definition) => !definition.secret && definition.default === '' && definition.type !== 'boolean' && !definition.choices;

// --- naming families: which jobs are the same service in another environment --------
//
// Worked out in jenkins-board.js, the function the dashboard's board uses, so that what is offered
// for promotion is exactly what the board shows — including the words a person added for their own
// environments (`HOM` for staging) in the board's settings.

/** The environment a word means on this server (`production` → `PROD`), or null. */
const envWordOf = (text, settings) => vocabulary(settings)[String(text ?? '').trim().toUpperCase()] ?? null;

/** The environments a text names, in order: `api.dev.example.com` names DEV; `1.4.0` names none. */
function envsIn(text, settings) {
  const words = vocabulary(settings);
  return String(text ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean).map((one) => words[one.toUpperCase()]).filter(Boolean);
}
const looksProdPath = (path, settings) => envsIn(path, settings).includes('PROD');
const looksProdValue = (value, settings) => envWordOf(value, settings) === 'PROD';

/** Parameters that say where something goes rather than what: environment, namespace, cluster, host, region… */
const WHERE_WORDS = new Set(['env', 'environment', 'stage', 'namespace', 'ns', 'cluster', 'context', 'profile', 'region', 'zone', 'host', 'hostname', 'url', 'uri', 'endpoint', 'domain', 'server', 'account', 'tenant', 'bucket', 'db', 'database', 'target']);
const whereName = (name) => wordsOf(name).some((word) => WHERE_WORDS.has(word));
/** A host name or a URL: where something is, never what. A version is not one (`1.2.3` ends in a number). */
const isHostLike = (value) => /:\/\//.test(value) || /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:\/\S*)?$/.test(value);
/** A value that belongs to an environment: it names one, or it is an address. */
const envSpecific = (value, settings) => envsIn(value, settings).length > 0 || isHostLike(String(value ?? ''));
/** A family in a folder nobody wants promoted into: old, deprecated, archived. */
const OLD_FAMILY = /\b(?:deprecated|obsolete|legacy|archived?|do not use|old)\b/i;

// --- the module ----------------------------------------------------------------------

class Launch {
  /**
   * @param {{
   *   archive: object | null,                         the console archive (its file is shared; its tables are not)
   *   on: (serverId: string, look?: boolean) => { server: object, api: object },
   *   index?: (serverId: string, options?: { maxAge?: number }) => Promise<{ rows: Map<string, object>, truncated?: boolean }>,
   *   favorites?: (serverId: string) => string[],
   *   follow?: (serverId: string, path: string, number: number) => void,
   *   presets?: (serverId: string, path: string) => Promise<{ presets: object[] }> | { presets: object[] },
   *   deepWhy?: (serverId: string, path: string) => Promise<object>,         asked of a plan with `deep`
   *   boardSettings?: (serverId: string) => object,                          what a person tuned about environments (jenkins-board.js)
   *   emit?: (event: object) => void,
   *   notify?: (title: string, body: string, place?: object) => void,
   *   nudge?: (serverId: string, path: string) => void,
   *   now?: () => number,
   *   sleep?: (ms: number) => Promise<void>,
   *   isClosed?: () => boolean,
   * }} options
   */
  constructor({
    archive, on, index = null, favorites = () => [], follow = () => {}, presets = null, deepWhy = null, boardSettings = () => ({}), emit = () => {}, notify = () => {}, nudge = () => {},
    now = Date.now, sleep, isClosed = () => false, resolveMs = RESOLVE_MS, staggerMs = STAGGER_MS, maintain = true,
  }) {
    this.archive = archive ?? null;
    this.db = archive?.db ?? null;
    this.on = on;
    this.index = index;
    this.favorites = favorites;
    this.follow = follow;
    this.presets = presets;
    this.deepWhy = deepWhy;
    this.boardSettings = boardSettings;
    this.emitter = emit;
    this.notifier = notify;
    this.nudge = nudge;
    this.now = now;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
    this.isClosed = isClosed;
    this.staggerMs = staggerMs;
    this.resolveMs = resolveMs;
    this.error = null;
    /** Whether this runs its own clocks. A test drives it by hand with `poll()` and `runDue()`. */
    this.maintain = maintain;
    this.stopped = false;
    this.ticking = false;
    this.timer = null;
    this.beat = null;
    /** batch id → { cancelled, params: [full parameters of each item — the only place a secret is held, and only in memory] } */
    this.live = new Map();
    /** launch id → the promises waiting for it to end. */
    this.waiters = new Map();
    /** When each launch left this app, for the rate. */
    this.window = [];
    /** hash of a request → { at, batchId | result }: the same click twice is one batch, one promotion, one schedule. */
    this.recent = new Map();
    /** hash of a request being made right now → its promise: a second click while the first is still being checked joins it. */
    this.inflight = new Map();
    /** server\npath → when this app last started it, so that two different requests for one job a moment apart are noticed. */
    this.lastAt = new Map();
    /** server\npath → { at, job }: a job's definition, kept a few minutes. */
    this.defs = new Map();
    this.batchTimers = new Map();
    this.inserts = 0;
    if (this.db) {
      try {
        this.#migrate();
        this.#afterRestart();
      } catch (error) {
        this.db = null;
        this.error = String(error?.message ?? error).split('\n')[0].slice(0, 200);
      }
    }
    if (this.db && maintain) {
      this.timer = setInterval(() => { void this.#tick(); }, resolveMs);
      this.timer.unref?.();
      this.#arm();
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.beat) clearTimeout(this.beat);
    this.beat = null;
    for (const timer of this.batchTimers.values()) clearTimeout(timer);
    this.batchTimers.clear();
    // Whoever is waiting for a launch to end is told it did not: the batch was stopped, not finished.
    for (const list of this.waiters.values()) for (const resolve of list) resolve(null);
    this.waiters.clear();
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS jl_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM jl_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO jl_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) throw new Error(`The launch tables are at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    for (let version = row.version; version < MIGRATIONS.length; version += 1) {
      this.#tx(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE jl_schema SET version = ?').run(version + 1);
      });
    }
  }

  /**
   * What a restart leaves half-done. A batch that was running is interrupted and what it had not started is
   * skipped — never resumed: the person who clicked is not necessarily there, and a deploy chain that carries on
   * by itself on the next launch is exactly what must not happen. A schedule whose time passed while nothing
   * was running is missed, for the person to decide. Launches already in Jenkins keep being followed.
   */
  #afterRestart() {
    const now = this.now();
    for (const row of this.db.prepare("SELECT id, items FROM jl_batch WHERE state = 'running'").all()) {
      const items = safeJson(row.items, []).map((item) => (item.state === 'waiting' ? { ...item, state: 'skipped', error: 'Smart Terminal was closed before this one started' } : item));
      this.db.prepare("UPDATE jl_batch SET state = 'interrupted', items = ?, updated = ? WHERE id = ?").run(JSON.stringify(items), now, row.id);
    }
    // A schedule that was being started when the app closed: whether it ran is not known, and it must not sit "starting" for ever.
    this.db.prepare("UPDATE jl_schedule SET state = 'missed', error = 'Smart Terminal stopped while this was starting — check Jenkins to see whether it ran' WHERE state = 'firing'").run();
    // What is past its time is missed — by less for what looks like production.
    for (const row of this.db.prepare("SELECT id, path, at FROM jl_schedule WHERE state = 'scheduled' AND at < ?").all(now - LATE_PROD_MS)) {
      if (now - row.at > (looksProdPath(row.path) ? LATE_PROD_MS : LATE_MS)) {
        this.db.prepare("UPDATE jl_schedule SET state = 'missed', error = 'Smart Terminal was not running at that time' WHERE id = ?").run(row.id);
      }
    }
    // A missed schedule is said once, and let go after a week.
    this.db.prepare("DELETE FROM jl_schedule WHERE state = 'missed' AND at < ?").run(now - MISSED_KEEP_MS);
  }

  /** The archive's own transaction when there is one, so that the two never begin twice. */
  #tx(fn) {
    if (this.archive?.transaction) return this.archive.transaction(fn);
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

  #need() {
    if (!this.db) throw new JenkinsError(`The local archive could not be opened${this.error ? `: ${this.error}` : ''}, so launches cannot be tracked`);
    return this.db;
  }

  emit(event) {
    if (this.stopped || this.isClosed()) return;
    try { this.emitter(event); } catch { /* a listener that throws must not stop a batch */ }
  }

  notify(title, body, place) {
    if (this.stopped || this.isClosed()) return;
    try { this.notifier(clip(title, 120), clip(body, 120), place); } catch { /* the same */ }
  }

  /** One look at every launch in flight: what the clock does every few seconds, for whoever needs it done now. */
  async poll() {
    await this.#tick();
  }

  /** The schedules that are due, now: what the schedule clock does. */
  async runDue() {
    await this.#due();
  }

  // --- the verbs ---------------------------------------------------------------------

  verbs() {
    const serverOf = (args) => this.on(needText(args.server, 'server', 100));
    return {
      launchpad: async (args) => this.#launchpad(serverOf(args)),
      launchHistory: async (args) => this.#history({ ...serverOf(args), args }),
      paramPlan: async (args) => this.#paramPlan({ ...serverOf(args), path: needPath(args.path), fromNumber: args.fromNumber === undefined || args.fromNumber === null ? null : needInt(args.fromNumber, 'build number', 1) }),
      paramRefresh: async (args) => this.#paramRefresh({ ...serverOf(args), path: needPath(args.path), values: args.values }),
      launchPlan: async (args) => this.#launchPlan({ ...serverOf(args), args }),
      promoteCandidates: async (args) => this.#candidates({ ...serverOf(args), path: needPath(args.path), number: args.number === undefined || args.number === null ? null : needInt(args.number, 'build number', 1) }),
      schedules: async (args) => this.#schedules(serverOf(args)),

      runMany: async (args) => this.#runMany({ ...serverOf(args), args }),
      promote: async (args) => this.#promote({ ...serverOf(args), args }),
      scheduleRun: async (args) => this.#scheduleRun({ ...serverOf(args), args }),
      scheduleCancel: async (args) => this.#cancel({ ...serverOf(args), id: needText(args.id, 'id', 100) }),
    };
  }

  // --- history -----------------------------------------------------------------------

  #insert(row) {
    const db = this.#need();
    const at = row.at ?? this.now();
    const result = db.prepare(
      `INSERT INTO jl_launch (server, path, params, needs, source, batch, from_path, from_number, queue_id, after_number, number, state, error, at, checked_at, follow, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.server, row.path, JSON.stringify(row.params ?? {}), JSON.stringify(row.needs ?? []), SOURCES.has(row.source) ? row.source : 'manual', row.batch ?? null,
      row.from?.path ?? null, row.from?.number ?? null, row.queueId ?? null, row.after ?? null, null, row.state, row.error ? clip(row.error, 300) : null, at, at, row.follow === false ? 0 : 1, row.note ? clip(row.note, 300) : null,
    );
    this.inserts += 1;
    if (this.inserts % 40 === 1) this.#prune(row.server);
    return Number(result.lastInsertRowid);
  }

  /** The history is a convenience with a bound: ninety days, and the newest five thousand per server. */
  #prune(server) {
    const db = this.db;
    const cutoff = this.now() - HISTORY_DAYS * 86_400_000;
    db.prepare("DELETE FROM jl_launch WHERE server = ? AND at < ? AND state NOT IN ('queued', 'running')").run(server, cutoff);
    db.prepare(
      `DELETE FROM jl_launch WHERE server = ? AND state NOT IN ('queued', 'running') AND id NOT IN (SELECT id FROM jl_launch WHERE server = ? ORDER BY id DESC LIMIT ?)`,
    ).run(server, server, HISTORY_PER_SERVER);
    db.prepare("DELETE FROM jl_batch WHERE server = ? AND state != 'running' AND at < ?").run(server, cutoff);
    db.prepare("DELETE FROM jl_schedule WHERE server = ? AND state NOT IN ('scheduled', 'missed') AND created < ?").run(server, cutoff);
    db.prepare("DELETE FROM jl_schedule WHERE server = ? AND state = 'missed' AND at < ?").run(server, this.now() - MISSED_KEEP_MS);
  }

  #update(id, fields) {
    const columns = { state: 'state', error: 'error', number: 'number', startedAt: 'started_at', endedAt: 'ended_at', checkedAt: 'checked_at', queueId: 'queue_id' };
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!columns[key]) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(key === 'error' && value ? clip(value, 300) : value);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE jl_launch SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  #shape(row) {
    return {
      id: row.id,
      path: row.path,
      number: row.number ?? null,
      queueId: row.queue_id ?? null,
      state: row.state,
      source: row.source,
      batch: row.batch ?? null,
      from: row.from_path ? { path: row.from_path, number: row.from_number ?? null } : null,
      params: safeJson(row.params, {}),
      needsInput: safeJson(row.needs, []),
      at: row.at,
      startedAt: row.started_at ?? null,
      endedAt: row.ended_at ?? null,
      durationMs: row.started_at && row.ended_at ? Math.max(0, row.ended_at - row.started_at) : null,
      error: row.error ?? null,
      note: row.note ?? null,
      follow: Boolean(row.follow),
    };
  }

  /**
   * A launch made through this app, recorded after the fact: what the `run` verb does. The build it became is
   * found afterwards, and followed to the end like any other.
   */
  record(serverId, path, params, queued, { source = 'manual', defs = null, after = null, follow = true, from = null, batch = null } = {}) {
    if (!this.db) return null;
    try {
      const { kept, needs } = splitSecrets(defs, params ?? {});
      // Counted against the minute's launches, never refused for it: it has already been started, and a batch looking at the rate should see it.
      this.window.push(this.now());
      this.lastAt.set(`${serverId}\n${path}`, this.now());
      const id = this.#insert({ server: serverId, path, params: kept, needs, source, batch, from, queueId: queued?.queued ?? null, after, state: 'queued', follow });
      this.#changed(this.#row(id));
      this.#soon();
      return id;
    } catch {
      // A history that cannot be written must not stop a build that was started.
      return null;
    }
  }

  #row(id) {
    return this.db.prepare('SELECT * FROM jl_launch WHERE id = ?').get(id);
  }

  #history({ server, args }) {
    const db = this.#need();
    const limit = args.limit === undefined ? 50 : Math.min(200, needInt(args.limit, 'limit', 1));
    const where = ['server = ?'];
    const values = [server.id];
    if (args.path !== undefined && args.path !== null) { where.push('path = ?'); values.push(needPath(args.path)); }
    if (args.batch !== undefined && args.batch !== null) { where.push('batch = ?'); values.push(needText(args.batch, 'batch', 100)); }
    if (args.before !== undefined && args.before !== null) { where.push('id < ?'); values.push(needInt(args.before, 'before', 1)); }
    const rows = db.prepare(`SELECT * FROM jl_launch WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...values, limit + 1);
    return {
      rows: rows.slice(0, limit).map((row) => this.#shape(row)),
      more: rows.length > limit,
      batches: db.prepare('SELECT * FROM jl_batch WHERE server = ? ORDER BY at DESC LIMIT 10').all(server.id).map((row) => this.#batchShape(row)),
    };
  }

  /** What `forget` forgets: a build's launches, a job's, or a server's — and, for a server or a job, what was scheduled. */
  forget(server, { path = null, number = null } = {}) {
    if (!this.db) return;
    this.#tx(() => {
      if (path !== null && number !== null) {
        this.db.prepare('DELETE FROM jl_launch WHERE server = ? AND path = ? AND number = ?').run(server, path, number);
      } else if (path !== null) {
        this.db.prepare('DELETE FROM jl_launch WHERE server = ? AND path = ?').run(server, path);
        this.db.prepare('DELETE FROM jl_schedule WHERE server = ? AND path = ?').run(server, path);
      } else {
        this.db.prepare('DELETE FROM jl_launch WHERE server = ?').run(server);
        this.db.prepare('DELETE FROM jl_batch WHERE server = ?').run(server);
        this.db.prepare('DELETE FROM jl_schedule WHERE server = ?').run(server);
        for (const key of [...this.defs.keys()]) if (key.startsWith(`${server}\n`)) this.defs.delete(key);
      }
    });
    this.#arm();
  }

  // --- following a launch to the end ---------------------------------------------------

  /** Soon, not at once: Jenkins has not had a moment to put it in the queue. */
  #soon() {
    if (this.stopped) return;
    const timer = setTimeout(() => { void this.#tick(); }, 1200);
    timer.unref?.();
  }

  /** How long to leave a launch alone: often at first, then less, then rarely. */
  #interval(age) {
    if (age < 2 * 60_000) return 0;
    if (age < 30 * 60_000) return 10_000;
    return 60_000;
  }

  async #tick() {
    if (this.ticking || this.stopped || this.isClosed() || !this.db) return;
    this.ticking = true;
    try {
      const now = this.now();
      const rows = this.db.prepare("SELECT * FROM jl_launch WHERE state IN ('queued', 'running') ORDER BY checked_at ASC LIMIT 40").all();
      const due = rows.filter((row) => now - row.checked_at >= this.#interval(now - row.at));
      await mapLimit(due, 3, async (row) => {
        try {
          await this.#resolve(row);
        } catch {
          // Jenkins not answering is not a verdict: look again later. One that has said nothing for hours is let go.
          this.#update(row.id, { checkedAt: this.now() });
          if (this.now() - row.at > LOST_AFTER_MS) this.#settle(row, 'lost', 'Jenkins did not say how it ended');
        }
      });
    } finally {
      this.ticking = false;
    }
  }

  async #getJson(api, path) {
    const reply = await api.rawGet(path);
    if (reply.tooBig) throw new JenkinsError('Jenkins sent more than this app will read');
    return JSON.parse(reply.bytes.toString('utf8'));
  }

  /** One step for one launch: the queue item that became a build, or the build that ended. */
  async #resolve(row) {
    let held;
    try {
      held = this.on(row.server, false);
    } catch {
      this.#settle(row, 'lost', 'That Jenkins is no longer set up here');
      return;
    }
    const { api } = held;
    const now = this.now();
    let current = row;
    if (current.state === 'queued') {
      const found = await this.#whichBuild(api, current);
      if (found === 'cancelled') { this.#settle(current, 'lost', 'It was taken out of the Jenkins queue'); return; }
      if (!found) {
        this.#update(current.id, { checkedAt: now });
        if (now - current.at > QUEUE_GONE_MS && (found === false)) this.#settle(current, 'lost', 'Jenkins no longer knows it and no build of it was found');
        return;
      }
      this.#update(current.id, { state: 'running', number: found.number, startedAt: found.timestamp ?? now, checkedAt: now });
      current = this.#row(current.id);
      if (current.follow) { try { this.follow(current.server, current.path, found.number); } catch { /* the follows are full: it is still in the history */ } }
      this.#changed(current);
      this.nudge(current.server, current.path);
    }
    if (current.state === 'running' && current.number) {
      const build = await this.#getJson(api, `${jobPath(current.path)}/${current.number}/api/json?tree=building,result,duration,timestamp`);
      if (build.building === false && build.result) {
        const state = { SUCCESS: 'success', FAILURE: 'failed', UNSTABLE: 'unstable', ABORTED: 'aborted', NOT_BUILT: 'aborted' }[build.result] ?? 'failed';
        const ended = Number.isFinite(build.timestamp) && Number.isFinite(build.duration) && build.duration >= 0 ? build.timestamp + build.duration : now;
        this.#settle(current, state, null, ended);
        return;
      }
      this.#update(current.id, { checkedAt: now });
    }
  }

  /**
   * Which build a queued launch became: `{ number, timestamp }`; `'cancelled'`; `null` while it still waits; `false`
   * when Jenkins has no record of the queue item and no build can be matched to it (a queue item is remembered
   * for a few minutes after it starts, so this is asked soon, and the builds of the job are the second place to look).
   */
  async #whichBuild(api, row) {
    let item = null;
    let known = true;
    if (row.queue_id) {
      try {
        item = await this.#getJson(api, `/queue/item/${Number(row.queue_id)}/api/json?tree=id,cancelled,why,task[fullName],executable[number,timestamp]`);
      } catch (error) {
        if (error.status !== 404) throw error;
        known = false;
      }
    } else {
      known = false;
    }
    // Queue numbers start again when Jenkins does: an item with that number may be another job's, or its build older than this launch.
    // Nothing is taken for this launch that cannot be.
    if (item && ((item.task?.fullName && item.task.fullName !== row.path) || (item.executable?.number !== undefined && item.executable.number <= (row.after_number ?? 0)))) {
      item = null;
      known = false;
    }
    if (item?.executable?.number) return { number: item.executable.number, timestamp: item.executable.timestamp ?? null };
    if (item?.cancelled) return 'cancelled';
    if (item) return null;
    // Not in the queue (any more): a build of the job that carries the queue id and started after this launch, or, for a server
    // that does not say, the first one since.
    const body = await this.#getJson(api, `${jobPath(row.path)}/api/json?tree=builds[number,queueId,timestamp]{0,15}`);
    const builds = body.builds ?? [];
    const after = (one) => one.number > (row.after_number ?? 0) && (one.timestamp ?? Infinity) >= row.at - 15_000;
    let match = row.queue_id ? builds.find((one) => one.queueId === row.queue_id && after(one)) : null;
    // No queue address to match by (Jenkins did not say, or does not record it): the first build since that is not
    // already another launch's. Two launches of one job at once can swap places; neither is lost.
    if (!match && (!row.queue_id || builds.every((one) => one.queueId === undefined || one.queueId === null))) {
      const taken = new Set(this.db.prepare('SELECT number FROM jl_launch WHERE server = ? AND path = ? AND number IS NOT NULL').all(row.server, row.path).map((one) => one.number));
      match = builds.filter((one) => after(one) && !taken.has(one.number)).sort((a, b) => a.number - b.number)[0] ?? null;
    }
    if (match) return { number: match.number, timestamp: match.timestamp ?? null };
    return known ? null : false;
  }

  /** A launch has ended, one way or another: say so, and let what was waiting for it go on. */
  #settle(row, state, error, endedAt = this.now()) {
    this.#update(row.id, { state, error: error ?? null, endedAt, checkedAt: this.now() });
    this.#changed(this.#row(row.id));
  }

  /** Every change of a launch: the event, the batch it belongs to, whoever was waiting for it. */
  #changed(row) {
    if (!row) return;
    this.emit({ type: 'launch', server: row.server, id: row.id, path: row.path, ...(row.number ? { number: row.number } : {}), state: row.state, source: row.source, ...(row.batch ? { batch: row.batch } : {}) });
    if (row.batch) this.#batchLaunchChanged(row);
    if (TERMINAL.has(row.state)) {
      const list = this.waiters.get(row.id);
      if (list) {
        this.waiters.delete(row.id);
        for (const resolve of list) resolve(row.state);
      }
    }
  }

  /** Resolves with the state a launch ends in; with null if this app is being stopped first. */
  #until(id) {
    const row = this.#row(id);
    if (!row) return Promise.resolve('lost');
    if (TERMINAL.has(row.state)) return Promise.resolve(row.state);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  // --- what a job needs, and what it is going to get -----------------------------------

  /** A job's definition, kept a few minutes: a launchpad of twenty tiles should not be twenty requests every time. */
  async #job(serverId, api, path, { builds = 0, fresh = false } = {}) {
    const key = `${serverId}\n${path}`;
    const held = this.defs.get(key);
    if (!fresh && held && this.now() - held.at < DEFS_TTL_MS && held.builds >= builds) return held.job;
    const job = await api.job(path, { builds });
    this.defs.set(key, { at: this.now(), job, builds });
    return job;
  }

  #sourceOf(label) {
    return label;
  }

  /** Read a build's own parameters: `[{ name, value, masked }]`, a secret's value never what it was. */
  async #buildParams(api, path, number) {
    const build = await api.build(path, number);
    return { build, params: (build.parameters ?? []).map((one) => ({ name: one.name, value: one.value, masked: one.value === MASK || one.value === undefined || isSecretName(one.name) || looksSecretValue(one.value) })) };
  }

  /**
   * What the reactive parameters of a job (Active Choices) hold, for the values the form starts from. Best effort, and
   * quiet: a job without the plugin, or a Jenkins that does not answer, leaves its parameters the plain fields they were.
   * Returns `{ NAME: { choices, selected, labels } | { blocks } | { error } }`.
   */
  async #reactive(api, path, defs, valueOf) {
    const reactive = defs.filter((one) => REACTIVE.test(one.type));
    if (!reactive.length) return {};
    const choices = new ActiveChoices(api);
    let session;
    try {
      session = await choices.read(jobPath(path));
    } catch {
      return {};
    }
    if (!session) return {};
    const found = {};
    for (const param of session.params) {
      if (param.initial) found[param.name] = { refs: param.refs, ...(param.initial.blocks ? { blocks: param.initial.blocks } : { choices: param.initial.choices, selected: param.initial.selected, labels: param.initial.labels }) };
    }
    // The page was built with each parameter at its own default. If the form starts anywhere else, what the page holds is for another question.
    const pageValue = (one) => (one.default !== '' && one.default !== undefined ? asText(one.default) : (one.choices?.[0] ?? ''));
    const elsewhere = session.params.some((param) => param.refs.some((name) => {
      const own = defs.find((one) => one.name === name);
      if (!own || REACTIVE.test(own.type)) return false;
      const wanted = valueOf(own);
      return wanted !== null && wanted !== undefined && String(wanted) !== String(pageValue(own));
    }));
    if (!elsewhere) return found;
    const values = {};
    for (const one of defs) {
      const wanted = valueOf(one);
      if (wanted !== null && wanted !== undefined) values[one.name] = String(wanted);
    }
    try {
      const fresh = await choices.refresh(jobPath(path), values);
      for (const [name, result] of Object.entries(fresh)) found[name] = { refs: found[name]?.refs ?? [], ...result };
    } catch {
      // What was read is for the wrong question: said so, rather than shown.
      for (const param of session.params) found[param.name] = { error: 'Jenkins did not answer for these values' };
    }
    return found;
  }

  /** A reactive parameter's definition, as a row of the form would have it. */
  #withReactive(definition, got) {
    if (!got) return definition;
    if (got.error) return { ...definition, type: 'string', choices: null, reactiveError: got.error };
    if (got.blocks) return { ...definition, type: 'display', choices: null, default: '', view: got.blocks, reactive: true, refs: got.refs ?? [] };
    if (got.choices?.length) return { ...definition, type: 'choice', choices: got.choices, choiceLabels: got.labels && Object.keys(got.labels).length ? got.labels : null, default: got.selected ?? got.choices[0], reactive: true, refs: got.refs ?? [] };
    return definition;
  }

  /**
   * The reactive parameters of a form for the values it has now: what a change of `LIB` does to `BUMP`. Asked of the job's
   * own script on Jenkins, once per change the panel settles on. `values` is the form's, by name; only what a reactive
   * parameter names is sent on.
   */
  async #paramRefresh({ api, path, values }) {
    const given = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const clean = {};
    for (const [name, value] of Object.entries(given).slice(0, 200)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') clean[String(name).slice(0, 120)] = String(value).slice(0, 500);
    }
    const job = await api.job(path, { builds: 0 });
    const reactive = (job.parameters ?? []).filter((one) => REACTIVE.test(one.type));
    if (!reactive.length) return { params: {} };
    const got = await new ActiveChoices(api).refresh(jobPath(path), clean);
    const params = {};
    for (const one of reactive) {
      const result = got[one.name];
      if (!result) continue;
      params[one.name] = result.error ? { error: result.error } : result.blocks ? { view: result.blocks } : { choices: result.choices, selected: result.selected ?? result.choices?.[0] ?? null, ...(result.labels && Object.keys(result.labels).length ? { labels: result.labels } : {}) };
    }
    return { params };
  }

  async #paramPlan({ server, api, path, fromNumber }) {
    const settings = this.#settings(server.id);
    const job = await this.#job(server.id, api, path, { builds: 20, fresh: true });
    let defs = job.parameters ?? [];
    const db = this.#need();
    // Where a value can come from, best first: the build asked about, the last one launched from here, the last that passed.
    const sources = [];
    if (fromNumber) {
      const { params } = await this.#buildParams(api, path, fromNumber);
      sources.push({ source: `build #${fromNumber}`, values: Object.fromEntries(params.filter((one) => !one.masked).map((one) => [one.name, asText(one.value)])), masked: new Set(params.filter((one) => one.masked).map((one) => one.name)) });
    }
    const mine = db.prepare("SELECT params FROM jl_launch WHERE server = ? AND path = ? AND state != 'error' ORDER BY id DESC LIMIT 1").get(server.id, path);
    if (mine) sources.push({ source: 'last run by me', values: safeJson(mine.params, {}), masked: new Set() });
    const passed = (job.builds ?? []).find((one) => one.status === 'success');
    if (passed && passed.number !== fromNumber) {
      try {
        const { params } = await this.#buildParams(api, path, passed.number);
        sources.push({ source: 'last successful build', values: Object.fromEntries(params.filter((one) => !one.masked).map((one) => [one.name, asText(one.value)])), masked: new Set(params.filter((one) => one.masked).map((one) => one.name)) });
      } catch { /* a build Jenkins no longer has: the other sources still stand */ }
    }
    if (defs.some((one) => REACTIVE.test(one.type))) {
      // The value each parameter would start from, in the order the form picks them.
      const startOf = (definition) => {
        if (isSecretParam(definition)) return null;
        for (const one of sources) if (Object.prototype.hasOwnProperty.call(one.values, definition.name)) return one.values[definition.name];
        return definition.default === '' || definition.default === undefined ? null : asText(definition.default);
      };
      const got = await this.#reactive(api, path, defs, startOf);
      defs = defs.map((one) => (REACTIVE.test(one.type) ? this.#withReactive(one, got[one.name]) : one));
    }
    const rows = defs.map((definition) => {
      const secret = isSecretParam(definition);
      const valueOk = (value) => !definition.choices || definition.choices.map(String).includes(String(value));
      const options = [];
      if (!secret && definition.type !== 'display') {
        for (const one of sources) if (Object.prototype.hasOwnProperty.call(one.values, definition.name)) options.push({ source: one.source, value: one.values[definition.name] });
        const own = definition.default === '' || definition.default === undefined ? null : asText(definition.default);
        if (own !== null) options.push({ source: 'default', value: own });
      }
      // The first that the job would still accept: a version that is no longer one of the choices is not a suggestion.
      const picked = options.find((one) => valueOk(one.value)) ?? null;
      return {
        name: definition.name,
        type: definition.type,
        description: definition.description ?? '',
        default: secret ? '' : definition.default,
        choices: definition.choices ?? null,
        ...(definition.choiceLabels ? { choiceLabels: definition.choiceLabels } : {}),
        ...(definition.type === 'display' ? { view: definition.view } : {}),
        ...(definition.reactive ? { reactive: true, refs: definition.refs ?? [] } : {}),
        ...(definition.reactiveError ? { reactiveError: definition.reactiveError } : {}),
        secret,
        required: definition.type === 'display' ? false : isRequired(definition),
        suggested: picked ? picked.value : null,
        source: picked ? picked.source : null,
        others: options.filter((one) => one !== picked).slice(0, 3),
        needsInput: secret,
        choiceOk: picked ? true : !options.length,
        looksProd: Boolean(picked && looksProdValue(picked.value, settings)),
      };
    });
    let presets = [];
    if (this.presets) {
      try {
        const reply = await this.presets(server.id, path);
        presets = (reply?.presets ?? []).map((one) => ({ name: one.name, values: one.values ?? {}, covers: Object.keys(one.values ?? {}).filter((name) => defs.some((d) => d.name === name)) }));
      } catch { /* presets are a nicety */ }
    }
    const sent = rows.filter((one) => one.suggested !== null || one.secret);
    const body = sent.map((one) => `${encodeURIComponent(one.name)}=${one.secret ? '••••' : encodeURIComponent(one.suggested)}`).join('&');
    return {
      path,
      buildable: job.buildable !== false,
      inQueue: Boolean(job.inQueue),
      looksProd: looksProdPath(path, settings) || rows.some((one) => one.looksProd),
      fromNumber: fromNumber ?? null,
      params: rows,
      presets,
      callPreview: {
        method: 'POST',
        url: `${server.url}${jobPath(path)}/${defs.length ? 'buildWithParameters' : 'build'}`,
        body: defs.length ? body : '',
      },
    };
  }

  /** One item of a plan: can it be launched, with what, and what should the person know first. */
  async #planItem({ server, api, item, index, deep = false }) {
    const settings = this.#settings(server.id);
    const out = {
      path: item.path, exists: false, buildable: false, ok: false, ready: false, running: false, inQueue: false, looksProd: looksProdPath(item.path, settings),
      hasParams: false, last: null, expectedMs: null, params: {}, fromNumber: item.fromNumber ?? null, missing: [], needsInput: [], unknown: [], badChoice: [],
      warnings: [], errors: [],
    };
    let given;
    try {
      given = paramsIn(item.params, 'The parameters');
    } catch (error) {
      out.errors.push(error.message);
      return out;
    }
    let job;
    try {
      job = await this.#job(server.id, api, item.path, { builds: 20, fresh: true });
    } catch (error) {
      out.errors.push(error.status === 404 ? `${item.path} does not exist on this Jenkins` : String(error.message ?? error));
      return out;
    }
    out.exists = true;
    out.buildable = job.buildable !== false;
    out.inQueue = Boolean(job.inQueue);
    const row = index?.rows?.get(item.path) ?? null;
    out.running = Boolean(row?.running) || (job.builds ?? [])[0]?.running === true;
    const newest = (job.builds ?? [])[0] ?? null;
    out.last = newest ? { number: newest.number, status: newest.status, timestamp: newest.timestamp ?? null } : null;
    out.expectedMs = median((job.builds ?? []).filter((one) => one.status === 'success').map((one) => one.duration));
    const defs = job.parameters ?? [];
    out.hasParams = defs.length > 0;
    if (!out.buildable) out.errors.push(`${item.path} is disabled — enable it in Jenkins first`);
    const known = new Set(defs.map((one) => one.name));
    for (const name of Object.keys(given)) if (!known.has(name)) out.unknown.push(name);
    if (out.unknown.length) out.warnings.push(`Jenkins has no parameter called ${out.unknown.slice(0, 3).join(', ')}${out.unknown.length > 3 ? '…' : ''}`);
    for (const definition of defs) {
      const secret = isSecretParam(definition);
      const has = Object.prototype.hasOwnProperty.call(given, definition.name);
      if (has && definition.choices && !definition.choices.map(String).includes(given[definition.name])) {
        out.badChoice.push({ name: definition.name, value: clip(given[definition.name], 60), choices: definition.choices.slice(0, 20) });
        out.errors.push(`${definition.name} has to be one of ${definition.choices.slice(0, 6).join(', ')}${definition.choices.length > 6 ? '…' : ''}`);
      }
      if (secret) {
        if (!has) out.needsInput.push(definition.name);
        continue;
      }
      if (has) {
        out.params[definition.name] = given[definition.name];
        if (looksProdValue(given[definition.name], settings)) out.looksProd = true;
      } else if (isRequired(definition)) {
        out.missing.push(definition.name);
      }
    }
    if (out.missing.length) out.warnings.push(`${out.missing.slice(0, 3).join(', ')} has no default and was not given: Jenkins gets an empty value`);
    if (out.needsInput.length) out.warnings.push(`${out.needsInput.slice(0, 3).join(', ')} has to be typed: a secret is never filled in for you`);
    if (out.looksProd) out.warnings.push('looks like production');
    if (out.running) out.warnings.push('a build of it is running now');
    else if (out.inQueue) out.warnings.push('a build of it is already waiting in the queue');
    if (out.expectedMs === null && out.exists) out.warnings.push('it has no successful build to say how long it takes');
    if (deep && this.deepWhy) {
      try {
        const why = await this.deepWhy(server.id, item.path);
        out.agents = why?.agents ?? null;
        for (const reason of why?.reasons ?? []) if (reason.code !== 'idle') out.warnings.push(reason.text);
      } catch { /* the plan does not depend on it */ }
    }
    out.ok = out.errors.length === 0;
    out.ready = out.ok && out.needsInput.length === 0;
    return out;
  }

  async #launchPlan({ server, api, args }) {
    let items;
    let truncated = false;
    if (args.retryFailed) {
      const index = this.index ? await this.index(server.id, { maxAge: INDEX_AGE_MS }) : { rows: new Map() };
      const scope = args.scope && typeof args.scope === 'object' ? args.scope : {};
      let allowed = null;
      if (scope.view) {
        try { allowed = new Set((await api.viewJobs(needText(scope.view, 'view', 500))).map((one) => one.path)); } catch { allowed = new Set(); }
      }
      const prefix = scope.folder ? `${needText(scope.folder, 'folder', 500).replace(/\/+$/, '')}/` : null;
      const failing = [...index.rows.values()]
        .filter((row) => row.kind === 'job' && !row.running && (row.status === 'failed' || row.status === 'unstable'))
        .filter((row) => (!prefix || row.path.startsWith(prefix)) && (!allowed || allowed.has(row.path)))
        .sort((a, b) => (b.last?.timestamp ?? 0) - (a.last?.timestamp ?? 0));
      truncated = failing.length > BATCH_MAX;
      // With the parameters it failed with: "run it again" means the same, not the defaults.
      items = await mapLimit(failing.slice(0, BATCH_MAX), PLAN_PARALLEL, async (row) => {
        const item = { path: row.path, params: {}, fromNumber: row.last?.number ?? null };
        if (row.last?.number) {
          try {
            const { params } = await this.#buildParams(api, row.path, row.last.number);
            item.params = Object.fromEntries(params.filter((one) => !one.masked).map((one) => [one.name, asText(one.value)]));
          } catch { /* a build Jenkins no longer has: it is run with the defaults */ }
        }
        return item;
      });
    } else {
      if (!Array.isArray(args.items) || !args.items.length) throw new JenkinsError('There is nothing to plan');
      if (args.items.length > BATCH_MAX) throw new JenkinsError(`At most ${BATCH_MAX} jobs at a time`);
      items = args.items.map((one, at) => {
        if (!one || typeof one !== 'object') throw new JenkinsError(`Item ${at + 1} is not a job`);
        return { path: needPath(one.path), params: one.params ?? {} };
      });
    }
    const index = this.index ? await this.index(server.id, { maxAge: INDEX_AGE_MS }).catch(() => null) : null;
    const planned = await mapLimit(items, PLAN_PARALLEL, (item) => this.#planItem({ server, api, item, index, deep: args.deep === true }));
    const counts = {
      items: planned.length,
      ok: planned.filter((one) => one.ok).length,
      errors: planned.filter((one) => !one.ok).length,
      warnings: planned.reduce((sum, one) => sum + one.warnings.length, 0),
      needsInput: planned.filter((one) => one.needsInput.length).length,
      prod: planned.filter((one) => one.looksProd).length,
      running: planned.filter((one) => one.running).length,
    };
    const warnings = [];
    if (counts.running) warnings.push(`${counts.running} of these ${counts.running === 1 ? 'is' : 'are'} already running`);
    for (const one of planned.filter((p) => p.looksProd).slice(0, 3)) warnings.push(`${one.path} looks like production`);
    if (counts.needsInput) warnings.push(`${counts.needsInput} need${counts.needsInput === 1 ? 's' : ''} a secret typed`);
    // `valid`, never `ok`: the host reads a top-level `ok:false` as a call that failed, and a plan with problems in it is the answer.
    return { valid: counts.errors === 0, ready: planned.every((one) => one.ready), truncated, counts, warnings, items: planned };
  }

  // --- launching ----------------------------------------------------------------------

  /** Milliseconds until another launch may leave this app (0 when one may now, and then one is counted). */
  #slot(take = true) {
    const now = this.now();
    this.window = this.window.filter((at) => now - at < RATE_WINDOW_MS);
    if (this.window.length >= RATE_MAX) return Math.max(1, RATE_WINDOW_MS - (now - this.window[0]));
    if (take) this.window.push(now);
    return 0;
  }

  #tooFast(wait) {
    return new JenkinsError(`That is more than ${RATE_MAX} launches in a minute — wait ${Math.ceil(wait / 1000)} seconds`);
  }

  /**
   * Refuses to start a job that this app started a moment ago on another request: a second deploy within ten
   * seconds is almost always a second click, and when it is not, `force` says so.
   */
  #guardRecent(serverId, paths, force = false) {
    if (force) return;
    const now = this.now();
    for (const [key, at] of this.lastAt) if (now - at >= IDEMPOTENT_MS) this.lastAt.delete(key);
    const hot = paths.map((path) => ({ path, at: this.lastAt.get(`${serverId}\n${path}`) })).filter((one) => one.at !== undefined);
    if (!hot.length) return;
    const secs = Math.max(1, Math.round((now - hot[0].at) / 1000));
    throw new JenkinsError(`${hot[0].path} was started ${secs} second${secs === 1 ? '' : 's'} ago by another request${hot.length > 1 ? ` (and ${hot.length - 1} more)` : ''} — start it again only on purpose (force)`);
  }

  /** One launch: checked, started, recorded. What the other verbs are made of. */
  async #launch({ server, api, path, params, source, batch = null, from = null, follow = true, force = false, note = null }) {
    this.#need();
    const given = paramsIn(params);
    const job = await this.#job(server.id, api, path, { builds: 0, fresh: true });
    if (job.buildable === false) throw new JenkinsError(`${path} is disabled — enable it in Jenkins first`);
    const { kept, needs } = splitSecrets(job.parameters, given);
    if (!force) {
      const wait = this.#slot();
      if (wait) throw this.#tooFast(wait);
    }
    const at = this.now();
    let queued;
    try {
      queued = await api.run(path, given, (job.parameters ?? []).length > 0);
    } catch (error) {
      const id = this.#insert({ server: server.id, path, params: kept, needs, source, batch, from, state: 'error', error: String(error?.message ?? error), at, follow, note });
      this.#changed(this.#row(id));
      throw error;
    }
    this.lastAt.set(`${server.id}\n${path}`, this.now());
    const id = this.#insert({ server: server.id, path, params: kept, needs, source, batch, from, queueId: queued?.queued ?? null, after: job.newest ?? null, state: 'queued', at, follow, note });
    this.#changed(this.#row(id));
    this.nudge(server.id, path);
    this.#soon();
    return { id, queueId: queued?.queued ?? null };
  }

  /** The whole request as one hash — the jobs, what they are started with and every option — so that two clicks of the same button are one batch. */
  #hash(server, mode, items, options = {}) {
    return crypto.createHash('sha1').update(JSON.stringify([server, mode, options, items.map((one) => [one.path, Object.entries(one.params ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))])])).digest('hex');
  }

  async #runMany({ server, api, args }) {
    const db = this.#need();
    if (!Array.isArray(args.items) || !args.items.length) throw new JenkinsError('There is nothing to run');
    if (args.items.length > BATCH_MAX) throw new JenkinsError(`At most ${BATCH_MAX} jobs at a time`);
    const mode = args.mode === 'sequential' ? 'sequential' : 'parallel';
    const stopOnFailure = args.stopOnFailure === undefined ? mode === 'sequential' : args.stopOnFailure === true;
    const follow = args.follow !== false;
    const source = args.source === 'retry' ? 'retry' : 'runMany';
    const items = args.items.map((one, at) => {
      if (!one || typeof one !== 'object') throw new JenkinsError(`Item ${at + 1} is not a job`);
      return { path: needPath(one.path), params: paramsIn(one.params) };
    });
    // Everything up to here is synchronous, so that what follows is decided before anything else can start:
    // the same request while this one is being checked joins it, and one a moment ago is that batch.
    const hash = this.#hash(server.id, mode, items, { stopOnFailure, skipInvalid: args.skipInvalid === true, follow, source });
    const flying = this.inflight.get(hash);
    if (flying) return flying.then((result) => ({ ...result, deduplicated: true }));
    const now = this.now();
    for (const [key, held] of this.recent) if (now - held.at > IDEMPOTENT_MS) this.recent.delete(key);
    const earlier = this.recent.get(hash);
    if (earlier?.batchId) {
      const found = db.prepare('SELECT * FROM jl_batch WHERE id = ?').get(earlier.batchId);
      if (found) return { ...this.#batchShape(found), deduplicated: true };
    }
    const work = this.#runManyWork({ server, api, args, db, mode, stopOnFailure, follow, source, items, hash, now }).finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, work);
    return work;
  }

  async #runManyWork({ server, api, args, db, mode, stopOnFailure, follow, source, items, hash, now }) {
    this.#guardRecent(server.id, items.map((one) => one.path), args.force === true);
    const wait = this.#slot(false);
    if (wait || this.window.length + items.length > RATE_MAX) throw this.#tooFast(wait || RATE_WINDOW_MS - (now - (this.window[0] ?? now)));
    // Every item is looked at before any is started: half a deploy chain is worse than none.
    const index = this.index ? await this.index(server.id, { maxAge: INDEX_AGE_MS }).catch(() => null) : null;
    const plans = await mapLimit(items, PLAN_PARALLEL, (item) => this.#planItem({ server, api, item, index }));
    const bad = plans.map((plan, at) => ({ plan, at })).filter(({ plan }) => !plan.ok || plan.needsInput.length);
    if (bad.length && args.skipInvalid !== true) {
      const why = bad.slice(0, 4).map(({ plan }) => `${plan.path}: ${plan.errors[0] ?? `${plan.needsInput[0]} has to be typed — a batch cannot ask`}`).join('; ');
      throw new JenkinsError(`Nothing was started. ${bad.length === 1 ? 'One job cannot run' : `${bad.length} jobs cannot run`} — ${why}`);
    }
    const id = `batch-${crypto.randomBytes(4).toString('hex')}`;
    const record = items.map((item, at) => {
      const plan = plans[at];
      const refused = !plan.ok || plan.needsInput.length;
      return { path: item.path, params: plan.params, needs: plan.needsInput, state: refused ? 'error' : 'waiting', error: refused ? (plan.errors[0] ?? `${plan.needsInput[0]} has to be typed — a batch cannot ask`) : null };
    });
    db.prepare('INSERT INTO jl_batch (id, server, mode, stop_on_failure, follow, source, items, state, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, server.id, mode, stopOnFailure ? 1 : 0, follow ? 1 : 0, source, JSON.stringify(record), 'running', now, now);
    this.live.set(id, { cancelled: false, params: items.map((item) => item.params) });
    this.recent.set(hash, { at: now, batchId: id });
    const batch = db.prepare('SELECT * FROM jl_batch WHERE id = ?').get(id);
    // Not awaited: the answer is "started", and the rest arrives as events.
    void this.#drive(id).catch(() => {});
    return { ...this.#batchShape(batch), deduplicated: false };
  }

  #batchShape(row) {
    const items = safeJson(row.items, []);
    return {
      batchId: row.id,
      id: row.id,
      mode: row.mode,
      stopOnFailure: Boolean(row.stop_on_failure),
      state: row.state,
      at: row.at,
      done: row.state !== 'running',
      items: items.map((one) => ({ path: one.path, state: one.state, ...(one.launchId ? { launchId: one.launchId } : {}), ...(one.queueId ? { queueId: one.queueId } : {}), ...(one.number ? { number: one.number } : {}), ...(one.error ? { error: one.error } : {}) })),
    };
  }

  #counts(items) {
    const counts = { success: 0, failed: 0, running: 0, queued: 0, waiting: 0, skipped: 0, error: 0 };
    for (const item of items) {
      const key = item.state === 'unstable' || item.state === 'aborted' ? 'failed' : item.state;
      if (key in counts) counts[key] += 1;
    }
    return counts;
  }

  #batchSave(batch, items, state = batch.state) {
    this.db.prepare('UPDATE jl_batch SET items = ?, state = ?, updated = ? WHERE id = ?').run(JSON.stringify(items), state, this.now(), batch.id);
  }

  /** The batch's event, at most one every 300 ms and always the last one. */
  #batchEvent(id, final = false) {
    if (this.stopped) return;
    const send = () => {
      this.batchTimers.delete(id);
      const row = this.db?.prepare('SELECT * FROM jl_batch WHERE id = ?').get(id);
      if (!row) return;
      const shape = this.#batchShape(row);
      this.emit({ type: 'batch', server: row.server, batchId: id, mode: row.mode, state: row.state, done: shape.done, items: shape.items, counts: this.#counts(safeJson(row.items, [])) });
    };
    if (final) {
      const held = this.batchTimers.get(id);
      if (held) clearTimeout(held);
      send();
      return;
    }
    if (this.batchTimers.has(id)) return;
    const timer = setTimeout(send, BATCH_EVENT_MS);
    timer.unref?.();
    this.batchTimers.set(id, timer);
  }

  /** What a launch's change means for the batch it belongs to: its item's state, and whether that was the last. */
  #batchLaunchChanged(launch) {
    const row = this.db.prepare('SELECT * FROM jl_batch WHERE id = ?').get(launch.batch);
    if (!row) return;
    const items = safeJson(row.items, []);
    const item = items.find((one) => one.launchId === launch.id);
    if (!item) return;
    item.state = launch.state === 'lost' ? 'error' : launch.state;
    if (launch.state === 'lost' && launch.error) item.error = launch.error;
    if (launch.number) item.number = launch.number;
    this.#batchSave(row, items);
    this.#batchMaybeDone(row.id);
    this.#batchEvent(row.id);
  }

  #batchMaybeDone(id) {
    const row = this.db.prepare('SELECT * FROM jl_batch WHERE id = ?').get(id);
    if (!row || row.state !== 'running') return;
    const items = safeJson(row.items, []);
    if (!items.every((one) => ITEM_TERMINAL.has(one.state))) return;
    // The driver is done with it too, or it would be told twice.
    this.#batchSave(row, items, 'done');
    this.live.delete(id);
    this.#batchEvent(id, true);
    if (items.length > 1) {
      const counts = this.#counts(items);
      const bits = [counts.success && `${counts.success} passed`, counts.failed && `${counts.failed} failed`, counts.error && `${counts.error} did not start`, counts.skipped && `${counts.skipped} skipped`].filter(Boolean);
      this.notify(`${items.length} builds finished`, bits.join(' · ') || 'Done', { server: row.server, page: { type: 'home' } });
    }
  }

  /** Starts a batch's items: all at once (a few hundred milliseconds apart), or one after another. */
  async #drive(id) {
    const live = this.live.get(id);
    if (!live) return;
    let row = this.db.prepare('SELECT * FROM jl_batch WHERE id = ?').get(id);
    if (!row) return;
    const mode = row.mode;
    const stopOnFailure = Boolean(row.stop_on_failure);
    const follow = Boolean(row.follow);
    const source = row.source;
    let held;
    try {
      held = this.on(row.server);
    } catch (error) {
      this.#skipRest(id, `${String(error?.message ?? error)}`, true);
      return;
    }
    const count = safeJson(row.items, []).length;
    for (let at = 0; at < count; at += 1) {
      if (live.cancelled || this.stopped || this.isClosed()) break;
      row = this.db.prepare('SELECT * FROM jl_batch WHERE id = ?').get(id);
      const items = safeJson(row?.items, []);
      const item = items[at];
      if (!item || item.state !== 'waiting') continue;
      if (mode === 'parallel' && at > 0) await this.sleep(this.staggerMs);
      if (live.cancelled || this.stopped || this.isClosed()) break;
      // The batch was accepted: a launch that has to wait for the rate waits, it is not refused halfway.
      for (let waited = 0; waited < 5; waited += 1) {
        const wait = this.#slot(false);
        if (!wait) break;
        await this.sleep(Math.min(wait, 15_000));
      }
      let outcome = null;
      try {
        const started = await this.#launch({ server: held.server, api: held.api, path: item.path, params: live.params[at], source, batch: id, follow });
        this.#itemSet(id, at, { state: 'queued', launchId: started.id, ...(started.queueId ? { queueId: started.queueId } : {}) });
        outcome = started.id;
      } catch (error) {
        this.#itemSet(id, at, { state: 'error', error: clip(error?.message ?? error, 200) });
      }
      if (mode === 'sequential') {
        const final = outcome === null ? 'error' : await this.#until(outcome);
        if (final === null) return; // the app is stopping: nothing more is started, and nothing is said
        if (final !== 'success' && stopOnFailure) {
          this.#skipRest(id, 'An earlier one did not pass');
          return;
        }
      }
    }
    if (live.cancelled) this.#skipRest(id, 'Cancelled');
    else if (!this.stopped) this.#batchMaybeDone(id);
  }

  #itemSet(id, at, fields) {
    const row = this.db.prepare('SELECT * FROM jl_batch WHERE id = ?').get(id);
    if (!row) return;
    const items = safeJson(row.items, []);
    if (!items[at]) return;
    items[at] = { ...items[at], ...fields };
    this.#batchSave(row, items);
    this.#batchMaybeDone(id);
    this.#batchEvent(id);
  }

  /** What had not started is skipped, with the reason; what had started is left alone. */
  #skipRest(id, reason, error = false) {
    const row = this.db.prepare('SELECT * FROM jl_batch WHERE id = ?').get(id);
    if (!row) return;
    const items = safeJson(row.items, []).map((one) => (one.state === 'waiting' ? { ...one, state: error ? 'error' : 'skipped', error: reason } : one));
    this.#batchSave(row, items);
    this.#batchMaybeDone(id);
    this.#batchEvent(id, true);
  }

  // --- the launchpad ------------------------------------------------------------------

  async #launchpad({ server, api }) {
    const settings = this.#settings(server.id);
    const db = this.#need();
    const index = this.index ? await this.index(server.id, { maxAge: INDEX_AGE_MS }).catch(() => ({ rows: new Map() })) : { rows: new Map() };
    const rows = index.rows ?? new Map();
    const recent = db.prepare("SELECT path, MAX(id) AS id FROM jl_launch WHERE server = ? AND state != 'error' GROUP BY path ORDER BY id DESC LIMIT ?").all(server.id, TILES_EACH).map((one) => one.path);
    const cutoff = this.now() - HISTORY_DAYS * 86_400_000;
    const frequent = db.prepare("SELECT path, COUNT(*) AS n FROM jl_launch WHERE server = ? AND at >= ? AND state != 'error' GROUP BY path HAVING COUNT(*) >= 2 ORDER BY n DESC, MAX(id) DESC LIMIT ?").all(server.id, cutoff, TILES_EACH);
    const counts = new Map(db.prepare("SELECT path, COUNT(*) AS n, MAX(at) AS last FROM jl_launch WHERE server = ? AND state != 'error' GROUP BY path").all(server.id).map((one) => [one.path, one]));
    const favorites = this.favorites(server.id).slice(0, 40);
    const failing = [...rows.values()]
      .filter((row) => row.kind === 'job' && !row.running && (row.status === 'failed' || row.status === 'unstable'))
      .sort((a, b) => (b.last?.timestamp ?? 0) - (a.last?.timestamp ?? 0))
      .slice(0, TILES_FAILING)
      .map((row) => row.path);
    const wanted = [...new Set([...favorites, ...recent, ...frequent.map((one) => one.path), ...failing])];
    // A definition for each tile, from what was kept or the first few asked for, a few at a time.
    const defs = new Map();
    const missing = [];
    for (const path of wanted) {
      const held = this.defs.get(`${server.id}\n${path}`);
      if (held && this.now() - held.at < DEFS_TTL_MS) defs.set(path, held.job);
      else missing.push(path);
    }
    await mapLimit(missing.slice(0, TILE_DEFS_MAX), PLAN_PARALLEL, async (path) => {
      try { defs.set(path, await this.#job(server.id, api, path, { builds: 0 })); } catch { /* a job that cannot be read is a tile without a form answer */ }
    });
    const last = (path) => db.prepare("SELECT params, needs FROM jl_launch WHERE server = ? AND path = ? AND state != 'error' ORDER BY id DESC LIMIT 1").get(server.id, path);
    const tile = (path, why) => {
      const row = rows.get(path) ?? null;
      const job = defs.get(path) ?? null;
      const used = counts.get(path);
      const mine = last(path);
      const parts = path.split('/');
      const definitions = job?.parameters ?? null;
      return {
        path,
        name: parts[parts.length - 1],
        folder: parts.slice(0, -1).join('/'),
        why,
        status: row?.status ?? job?.status ?? 'none',
        running: Boolean(row?.running),
        last: row?.last ? { number: row.last.number, status: row.last.status, timestamp: row.last.timestamp ?? null, duration: row.last.duration ?? 0 } : null,
        runs: used?.n ?? 0,
        lastLaunchAt: used?.last ?? null,
        lastParams: mine ? safeJson(mine.params, {}) : null,
        needsInput: mine ? safeJson(mine.needs, []) : [],
        hasParams: definitions ? definitions.length > 0 : null,
        needsForm: definitions ? definitions.some((one) => isSecretParam(one) || isRequired(one)) : null,
        buildable: job ? job.buildable !== false : null,
        inQueue: job ? Boolean(job.inQueue) : null,
        looksProd: looksProdPath(path, settings),
      };
    };
    const whyOf = new Map();
    const tag = (path, why) => whyOf.set(path, [...(whyOf.get(path) ?? []), why]);
    favorites.forEach((path) => tag(path, 'favorite'));
    recent.forEach((path) => tag(path, 'recent'));
    frequent.forEach((one) => tag(one.path, 'frequent'));
    failing.forEach((path) => tag(path, 'failing'));
    const tiles = new Map(wanted.map((path) => [path, tile(path, whyOf.get(path) ?? [])]));
    const pick = (paths, max) => paths.slice(0, max).map((path) => tiles.get(path)).filter(Boolean);
    const open = db.prepare("SELECT * FROM jl_batch WHERE server = ? AND state = 'running' ORDER BY at DESC LIMIT 5").all(server.id).map((row) => this.#batchShape(row));
    return {
      asOf: this.now(),
      favorites: pick(favorites, TILES_EACH * 2),
      recent: pick(recent, TILES_EACH),
      frequent: pick(frequent.map((one) => one.path), TILES_EACH),
      failing: pick(failing, TILES_FAILING),
      batches: open,
      schedules: this.#schedules({ server }).schedules.filter((one) => one.state === 'scheduled' || one.state === 'missed').slice(0, 5),
    };
  }

  // --- promoting: one environment's build to the next ---------------------------------

  /** What this server's board was told about environments; the defaults when it cannot say. */
  #settings(serverId) {
    try { return this.boardSettings(serverId) ?? {}; } catch { return {}; }
  }

  /** The build asked about, or the newest success, from a job's recent builds. */
  #pickSource(job, number) {
    const builds = job.builds ?? [];
    if (number) return builds.find((one) => one.number === number) ?? { number, status: 'none' };
    return builds.find((one) => one.status === 'success') ?? null;
  }

  /**
   * What a promotion would start the target with, and what stands in the way — decided here so that the person
   * sees it before anything is asked of them, and the verb that starts it refuses on exactly the same grounds.
   *
   * What is copied from the build is only what says *what* is deployed: a version, a tag, an image, a branch, a
   * commit — with a parameter of the same name in the target, and a value that does not belong to the source
   * environment. Everything that says *where* (an environment, a namespace, a cluster, a host, a URL, anything that
   * names DEV) is never carried over: it is shown with its source value and the target's own default, and the
   * target's default is used only when it has one. A version that has no parameter of that name in the target is a
   * choice to be made (`blocked`), and a target version that nobody gave a value is not left to its default: what
   * the default is, is whatever somebody typed there last.
   *
   * `needsInput[i].blocking` is whether nothing may start until it is answered.
   */
  #proposal(sourceParams, targetDefs, targetEnv, settings = {}, targetLabel = 'The target') {
    const byName = new Map(targetDefs.map((one) => [one.name, one]));
    const params = {};
    const copied = [];
    const needsInput = [];
    const blocked = [];
    const unmatched = [];
    let environment = null;
    const defaultOf = (definition) => (definition.default === undefined || definition.default === null ? '' : asText(definition.default));
    const accepts = (definition, value) => !definition.choices || definition.choices.map(String).includes(String(value));
    const pointAtTarget = (definition) => {
      const choice = definition.choices ? definition.choices.find((one) => envWordOf(one, settings) === targetEnv) : undefined;
      if (choice === undefined) return false;
      params[definition.name] = String(choice);
      copied.push({ name: definition.name, value: String(choice), how: 'environment' });
      environment = environment ?? { name: definition.name, value: String(choice) };
      return true;
    };
    const seen = new Set();
    for (const one of sourceParams) {
      seen.add(one.name);
      const definition = byName.get(one.name);
      const version = VERSION_LIKE.test(one.name);
      if (!definition) {
        if (version && !one.masked) {
          blocked.push({
            name: one.name,
            sourceValue: asText(one.value),
            reason: `${targetLabel} has no parameter called ${one.name} — choose how to map ${one.name} to one of its parameters, give the value yourself, or leave it behind on purpose (skip)`,
            candidates: targetDefs.filter((other) => VERSION_LIKE.test(other.name) && !isSecretParam(other)).map((other) => other.name),
          });
        } else unmatched.push(one.name);
        continue;
      }
      if (isSecretParam(definition) || one.masked) {
        needsInput.push({ name: one.name, kind: 'secret', blocking: true, reason: 'a secret is never copied from one build to another' });
        continue;
      }
      const value = asText(one.value);
      const own = defaultOf(definition);
      if (version) {
        const named = envsIn(value, settings)[0];
        if (named || isHostLike(value)) {
          needsInput.push({ name: one.name, kind: 'environment', blocking: true, reason: `${value} looks like it belongs to ${named ?? 'the source environment'} — give the version to deploy`, sourceValue: value, targetDefault: own, choices: definition.choices ?? null });
        } else if (!accepts(definition, value)) {
          needsInput.push({ name: one.name, kind: 'required', blocking: true, reason: `${value} is not one of ${targetLabel}'s choices for ${one.name}`, sourceValue: value, targetDefault: own, choices: definition.choices });
        } else {
          params[one.name] = value;
          copied.push({ name: one.name, value, how: 'copied' });
        }
        continue;
      }
      if (whereName(one.name) || envSpecific(value, settings)) {
        if (whereName(one.name) && pointAtTarget(definition)) continue;
        needsInput.push({
          name: one.name,
          kind: 'environment',
          // The target's own default is where it goes; with none, nothing safe is left to start with.
          blocking: own === '',
          reason: `it holds a value of the source environment (${clip(value, 60)}), which is not carried over${own === '' ? ' — and there is no default of its own to use' : ''}`,
          sourceValue: value,
          targetDefault: own,
          choices: definition.choices ?? null,
        });
        continue;
      }
      if (value !== own) {
        needsInput.push({ name: one.name, kind: 'other', blocking: false, reason: 'it differs from the target\'s default and is not copied — give it if you want it', sourceValue: value, targetDefault: own, choices: definition.choices ?? null });
      }
    }
    for (const definition of targetDefs) {
      if (seen.has(definition.name)) continue;
      if (isSecretParam(definition)) {
        needsInput.push({ name: definition.name, kind: 'secret', blocking: true, reason: 'a secret has to be typed' });
      } else if (VERSION_LIKE.test(definition.name)) {
        needsInput.push({ name: definition.name, kind: 'required', blocking: true, reason: `what gets deployed has to be chosen, not left to the default (${defaultOf(definition) || 'none'})`, targetDefault: defaultOf(definition), choices: definition.choices ?? null });
      } else if (whereName(definition.name) && pointAtTarget(definition)) {
        // The parameter that says where it goes: pointed at the environment the target is for.
      } else if (isRequired(definition)) {
        needsInput.push({ name: definition.name, kind: 'required', blocking: false, reason: 'it has no default and the build has no value for it: Jenkins gets an empty value', choices: definition.choices ?? null });
      }
    }
    return { params, copied, needsInput, blocked, unmatched, environment, ready: !needsInput.some((one) => one.blocking) && blocked.length === 0 };
  }

  /** Whether the board was told to hide this job (by its path, or a folder above it). */
  #hidden(settings, path) {
    const hide = Array.isArray(settings?.hide) ? settings.hide.map(String) : [];
    return hide.some((one) => one && (one === path || path.startsWith(`${one}/`)));
  }

  /**
   * Why a target should not be promoted to without being asked: hidden on the board, in an old family, or claimed by two
   * jobs. The board's own function says which of the last two (`inactive`, `ambiguous`); what it will not pair it does not
   * offer, and neither does this.
   */
  #targetTrouble(settings, family, target) {
    const hide = Array.isArray(settings?.hide) ? settings.hide.map(String) : [];
    if (this.#hidden(settings, target.path) || (family?.key && hide.includes(family.key))) {
      return { code: 'hidden', override: null, text: `${target.path} is hidden on the board — show it there before promoting to it` };
    }
    if (family?.inactive || target.path.split('/').some((segment) => OLD_FAMILY.test(segment))) {
      return { code: 'deprecated', override: 'allowDeprecated', text: `${target.path} is in a folder marked old or deprecated — promote there only on purpose (allowDeprecated)` };
    }
    if (family?.ambiguous) {
      const claimed = family.candidates?.[target.env] ?? [target.path, ...(family.extras ?? [])];
      return { code: 'ambiguous', override: null, text: `Two jobs claim ${target.env}: ${claimed.slice(0, 3).join(', ')} — say which one with "to", or settle it in the board's settings (rowOverrides)` };
    }
    return null;
  }

  async #candidates({ server, api, path, number }) {
    const index = this.index ? await this.index(server.id, { maxAge: INDEX_AGE_MS }) : { rows: new Map() };
    const settings = this.#settings(server.id);
    const family = familyOf(index.rows, path, settings);
    const out = { path, family: family ? { base: family.service, env: family.me.env, rank: family.me.rank } : null, from: null, candidates: [], none: null };
    if (!family) {
      out.none = { reason: this.#hidden(settings, path) ? 'This job is hidden on the board' : 'This job is not named for an environment (DEV, QA, STAGING, PROD…)' };
      return out;
    }
    if (family.single) { out.none = { reason: `No other environment of ${family.service} was found next to it` }; return out; }
    // What comes after this environment, from the family's own members: the board says `downstream` is empty for a family it will
    // not pair, and what is shown then is why, not nothing.
    const after = family.members.filter((one) => one.rank > family.me.rank);
    if (!after.length) { out.none = { reason: `${family.me.env} is the last environment of ${family.service}` }; return out; }
    const source = await this.#job(server.id, api, path, { builds: 20, fresh: true });
    const picked = this.#pickSource(source, number);
    let sourceParams = [];
    if (picked) {
      try { sourceParams = (await this.#buildParams(api, path, picked.number)).params; } catch { /* the plan says what it could not read */ }
    }
    let blocked = null;
    if (!picked) blocked = 'no successful build';
    else if (picked.running) blocked = 'running';
    else if (picked.status && picked.status !== 'success') blocked = picked.status;
    const latest = (source.builds ?? []).find((one) => one.status === 'success') ?? null;
    out.from = picked
      ? { number: picked.number, status: picked.status, timestamp: picked.timestamp ?? null, params: Object.fromEntries(sourceParams.filter((one) => !one.masked).map((one) => [one.name, asText(one.value)])), blocked, latestSuccess: latest?.number ?? null }
      : { number: null, status: 'none', timestamp: null, params: {}, blocked, latestSuccess: null };
    // The nearest environment after this one; further ones are reached through it, one step at a time.
    out.candidates = [await this.#candidate({ server, api, from: path, picked, sourceParams, sourceJob: source, target: after[0], blocked, settings, family, latest })];
    return out;
  }

  async #candidate({ server, api, from, picked, sourceParams, sourceJob, target, blocked, settings = {}, family = null, latest = null }) {
    const job = await this.#job(server.id, api, target.path, { builds: 20, fresh: true });
    const defs = job.parameters ?? [];
    const lastPassed = (job.builds ?? []).find((one) => one.status === 'success') ?? null;
    const proposal = this.#proposal(sourceParams, defs, target.env, settings, target.path.split('/').pop());
    const out = {
      path: target.path,
      env: target.env,
      rank: target.rank,
      looksProd: looksProdPath(target.path, settings) || target.env === 'PROD',
      running: Boolean(target.row?.running) || (job.builds ?? [])[0]?.running === true,
      inQueue: Boolean(job.inQueue),
      buildable: job.buildable !== false,
      last: lastPassed ? { number: lastPassed.number, status: lastPassed.status, timestamp: lastPassed.timestamp ?? null } : ((job.builds ?? [])[0] ? { number: job.builds[0].number, status: job.builds[0].status, timestamp: job.builds[0].timestamp ?? null } : null),
      deployed: { sourceNumber: null, how: null, params: {} },
      ahead: null,
      drift: null,
      commits: [],
      proposal,
      warnings: [],
      canPromote: true,
      reason: null,
      override: null,
    };
    // What the target has: promoted from this app, or the source build whose version-like parameters it carries.
    const history = this.db.prepare("SELECT from_number FROM jl_launch WHERE server = ? AND path = ? AND from_path = ? AND state = 'success' ORDER BY id DESC LIMIT 1").get(server.id, target.path, from);
    let targetParams = [];
    if (lastPassed) {
      try { targetParams = (await this.#buildParams(api, target.path, lastPassed.number)).params.filter((one) => !one.masked); } catch { /* it has no parameters to compare */ }
    }
    out.deployed.params = Object.fromEntries(targetParams.map((one) => [one.name, asText(one.value)]));
    if (history?.from_number) {
      out.deployed.sourceNumber = history.from_number;
      out.deployed.how = 'history';
    } else if (targetParams.some((one) => VERSION_LIKE.test(one.name))) {
      const keys = targetParams.filter((one) => VERSION_LIKE.test(one.name));
      const passes = (sourceJob.builds ?? []).filter((one) => one.status === 'success').slice(0, PROMOTE_SCAN);
      const read = await mapLimit(passes, PLAN_PARALLEL, async (one) => {
        try { return { number: one.number, params: (await this.#buildParams(api, from, one.number)).params }; } catch { return null; }
      });
      const hit = read.find((one) => one && keys.every((key) => one.params.some((p) => p.name === key.name && asText(p.value) === asText(key.value))));
      if (hit) { out.deployed.sourceNumber = hit.number; out.deployed.how = 'params'; }
    }
    if (out.deployed.sourceNumber !== null && picked) {
      const newer = (sourceJob.builds ?? []).filter((one) => one.status === 'success' && one.number > out.deployed.sourceNumber && one.number <= picked.number);
      out.ahead = newer.length;
      out.drift = newer.length;
      if (picked.number > out.deployed.sourceNumber) out.commits = await this.#commitsBetween(api, from, out.deployed.sourceNumber, picked.number);
    }
    // What stands in the way, in the order it matters; the first is the reason, and `override` is what would lift it (null: nothing does).
    const trouble = this.#targetTrouble(settings, family, target);
    const older = picked && picked.status === 'success' && latest && picked.number < latest.number;
    if (blocked) {
      out.canPromote = false;
      out.reason = blocked === 'no successful build' ? 'There is no successful build to promote' : blocked === 'running' ? 'That build is still running' : blocked === 'unstable' ? 'That build is unstable — promote it only on purpose (allowUnstable)' : `That build ${blocked === 'failed' ? 'failed' : `was ${blocked}`}`;
      out.override = blocked === 'unstable' ? 'allowUnstable' : null;
    } else if (!out.buildable) { out.canPromote = false; out.reason = `${target.path} is disabled`; }
    else if (trouble) { out.canPromote = false; out.reason = trouble.text; out.override = trouble.override; }
    else if (older) { out.canPromote = false; out.reason = `A newer build (#${latest.number}) passed since — promote that one, or allowOlder`; out.override = 'allowOlder'; }
    else if (out.running || out.inQueue) { out.canPromote = false; out.reason = out.running ? `${target.path} is running now — wait for it, or promote anyway` : `${target.path} already has a build waiting — wait for it, or promote anyway`; out.override = 'allowBusy'; }
    if (older) out.warnings.push(`A newer build (#${latest.number}) passed since`);
    if (out.looksProd) out.warnings.push('This looks like production');
    const blocking = proposal.needsInput.filter((one) => one.blocking).map((one) => one.name);
    if (blocking.length) out.warnings.push(`${blocking.slice(0, 3).join(', ')} ${blocking.length === 1 ? 'has' : 'have'} to be given before it can start`);
    if (proposal.blocked.length) out.warnings.push(`${proposal.blocked.map((one) => one.name).slice(0, 3).join(', ')}: choose how to map ${proposal.blocked.length === 1 ? 'it' : 'them'}`);
    if (out.deployed.sourceNumber !== null && picked && picked.number === out.deployed.sourceNumber) out.warnings.push('That build is already what the target last ran');
    return out;
  }

  /** The commits of the successful builds after `from` up to `to`, newest first, in one request. */
  async #commitsBetween(api, path, from, to) {
    try {
      const body = await this.#getJson(api, `${jobPath(path)}/api/json?tree=builds[number,changeSets[items[commitId,msg,author[fullName]]{0,20}]]{0,${Math.min(60, to - from + 5)}}`);
      const commits = [];
      for (const build of body.builds ?? []) {
        if (build.number <= from || build.number > to) continue;
        for (const set of build.changeSets ?? []) {
          for (const item of set.items ?? []) {
            if (commits.length >= PROMOTE_COMMITS_MAX) return commits;
            commits.push({ number: build.number, id: String(item.commitId ?? '').slice(0, 8), message: clip(String(item.msg ?? '').split('\n')[0], 140), author: clip(item.author?.fullName ?? '', 60) });
          }
        }
      }
      return commits;
    } catch {
      return [];
    }
  }

  /** Something done on purpose that the parameters do not say, in a few words, for the history. */
  #noteOf(parts) {
    return parts.filter(Boolean).join('; ') || null;
  }

  async #promote({ server, api, args }) {
    this.#need();
    const from = args.from && typeof args.from === 'object' ? args.from : null;
    if (!from) throw new JenkinsError('Say which build to promote');
    const fromPath = needPath(from.path, 'The source job');
    const fromNumber = needInt(from.number, 'The source build number', 1);
    const overrides = paramsIn(args.overrides, 'The overrides');
    const map = args.map === undefined || args.map === null ? {} : args.map;
    if (typeof map !== 'object' || Array.isArray(map)) throw new JenkinsError('map has to say which source parameter goes to which target parameter');
    const skip = args.skip === undefined || args.skip === null ? [] : args.skip;
    if (!Array.isArray(skip) || skip.some((one) => typeof one !== 'string')) throw new JenkinsError('skip has to be a list of source parameter names');
    const toArg = typeof args.to === 'string' && args.to.trim() ? needPath(args.to, 'The target job') : (args.to && typeof args.to === 'object' && args.to.path ? needPath(args.to.path, 'The target job') : null);
    // The same request made again while it is being made, or a moment ago, is that one: a deploy is not done twice by a double click.
    const flags = ['allowUnstable', 'allowOlder', 'allowBusy', 'allowDeprecated', 'follow'].map((one) => args[one] === true || (one === 'follow' && args[one] !== false));
    const hash = crypto.createHash('sha1').update(JSON.stringify(['promote', server.id, fromPath, fromNumber, toArg, flags, Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1)), Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)), [...skip].sort()])).digest('hex');
    const flying = this.inflight.get(hash);
    if (flying) return flying.then((result) => ({ ...result, deduplicated: true }));
    const earlier = this.recent.get(hash);
    if (earlier && this.now() - earlier.at < IDEMPOTENT_MS && earlier.result) return { ...earlier.result, deduplicated: true };
    const work = this.#promoteWork({ server, api, args, fromPath, fromNumber, overrides, map, skip, toArg })
      .then((result) => { this.recent.set(hash, { at: this.now(), result }); return result; })
      .finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, work);
    return work;
  }

  async #promoteWork({ server, api, args, fromPath, fromNumber, overrides, map, skip, toArg }) {
    const sourceBuild = await api.build(fromPath, fromNumber);
    if (sourceBuild.running) throw new JenkinsError(`${fromPath} #${fromNumber} is still running — promote it when it has passed`);
    // Only a build that is unstable can be promoted on request: one that failed or was aborted is not a thing to ship.
    const unstable = sourceBuild.status === 'unstable';
    if (sourceBuild.status !== 'success' && !(unstable && args.allowUnstable === true)) {
      throw new JenkinsError(`${fromPath} #${fromNumber} did not pass (${sourceBuild.status}) — a build that failed is not promoted${unstable ? '; an unstable one only with allowUnstable' : ''}`);
    }
    const index = this.index ? await this.index(server.id, { maxAge: INDEX_AGE_MS }) : { rows: new Map() };
    const settings = this.#settings(server.id);
    if (this.#hidden(settings, fromPath)) throw new JenkinsError(`${fromPath} is hidden on the board — show it there before promoting from it`);
    const familyFrom = familyOf(index.rows, fromPath, settings);
    let toPath = toArg;
    let target = null;
    if (!toPath) {
      if (!familyFrom) throw new JenkinsError(`${fromPath} is not named for an environment, so there is no next one — say which job to promote to`);
      const after = familyFrom.members.filter((one) => one.rank > familyFrom.me.rank);
      if (!after.length) throw new JenkinsError(`${fromPath} is already the last environment of its family — say which job to promote to`);
      target = after[0];
      toPath = target.path;
    }
    if (toPath === fromPath) throw new JenkinsError('A build is promoted to another job, not to itself');
    const familyTo = familyOf(index.rows, toPath, settings);
    // An explicit target is the person's decision about the pair; what was chosen for them has to be sure of itself.
    const trouble = !toArg
      ? this.#targetTrouble(settings, familyFrom, target)
      : this.#targetTrouble(settings, familyTo && !familyTo.ambiguous ? familyTo : familyTo ? { ...familyTo, ambiguous: false } : null, { path: toPath, env: familyTo?.me.env ?? null });
    if (trouble && !(trouble.override && args[trouble.override] === true)) throw new JenkinsError(trouble.text);
    const source = await this.#job(server.id, api, fromPath, { builds: 20, fresh: true });
    const latest = (source.builds ?? []).find((one) => one.status === 'success') ?? null;
    const older = sourceBuild.status === 'success' && latest && fromNumber < latest.number;
    if (older && args.allowOlder !== true) throw new JenkinsError(`A newer build (#${latest.number}) passed since — promote that one, or allowOlder`);
    const targetJob = await this.#job(server.id, api, toPath, { builds: 1, fresh: true });
    if (targetJob.buildable === false) throw new JenkinsError(`${toPath} is disabled — enable it in Jenkins first`);
    // A second deploy on top of one in progress is how two versions end up half-installed: said, and the person decides.
    const busy = Boolean(index.rows?.get?.(toPath)?.running) || targetJob.inQueue || (targetJob.builds ?? [])[0]?.running === true;
    if (busy && args.allowBusy !== true) throw new JenkinsError(`${toPath} is ${targetJob.inQueue ? 'already waiting for a build' : 'running now'} — wait for it, or promote anyway`);
    this.#guardRecent(server.id, [toPath], args.force === true);

    const defs = targetJob.parameters ?? [];
    const sourceParams = (sourceBuild.parameters ?? []).map((one) => ({ name: one.name, value: one.value, masked: one.value === MASK || one.value === undefined || isSecretName(one.name) || looksSecretValue(one.value) }));
    const plan = this.#proposal(sourceParams, defs, familyTo?.me.env ?? null, settings, toPath.split('/').pop());
    // What the person gave: a source parameter sent to a target parameter of another name, and values typed in.
    const byName = new Map(defs.map((one) => [one.name, one]));
    const given = {};
    const choiceOk = (definition, value) => !definition.choices || definition.choices.map(String).includes(String(value));
    for (const [sourceName, targetName] of Object.entries(map)) {
      const one = sourceParams.find((other) => other.name === sourceName);
      if (!one) throw new JenkinsError(`${fromPath} #${fromNumber} has no parameter called ${clip(sourceName, 40)} to map`);
      const definition = byName.get(String(targetName));
      if (!definition) throw new JenkinsError(`${clip(String(targetName), 40)} is not a parameter of ${toPath}`);
      if (one.masked || isSecretParam(definition)) throw new JenkinsError(`${clip(sourceName, 40)} is a secret: type it, it is never copied`);
      const value = asText(one.value);
      if (envsIn(value, settings).length || isHostLike(value)) throw new JenkinsError(`${clip(sourceName, 40)} (${clip(value, 40)}) belongs to the source environment — give the value yourself in overrides`);
      if (!choiceOk(definition, value)) throw new JenkinsError(`${value} is not one of ${toPath}'s choices for ${definition.name}`);
      given[definition.name] = value;
    }
    for (const [name, value] of Object.entries(overrides)) {
      const definition = byName.get(name);
      if (!definition) throw new JenkinsError(`${clip(name, 40)} is not a parameter of ${toPath}`);
      if (!choiceOk(definition, value)) throw new JenkinsError(`${clip(value, 40)} is not one of ${toPath}'s choices for ${definition.name}`);
      given[name] = value;
    }
    // Nothing starts until every question that decides what is deployed has an answer.
    const unresolved = [
      ...plan.needsInput.filter((one) => one.blocking && !Object.prototype.hasOwnProperty.call(given, one.name)).map((one) => `${one.name} (${one.reason})`),
      ...plan.blocked.filter((one) => !Object.prototype.hasOwnProperty.call(map, one.name) && !skip.includes(one.name) && !one.candidates.some((name) => Object.prototype.hasOwnProperty.call(given, name))).map((one) => `${one.name} (${one.reason})`),
    ];
    if (unresolved.length) {
      throw new JenkinsError(`Nothing was started. ${unresolved.length === 1 ? 'One thing has' : `${unresolved.length} things have`} to be settled first — ${unresolved.slice(0, 4).join('; ')}${unresolved.length > 4 ? '…' : ''}`);
    }
    const params = { ...plan.params, ...given };
    const notes = this.#noteOf([
      unstable ? `Promoted an unstable build (#${fromNumber}) on request` : null,
      older ? `Promoted an older build (#${fromNumber}; #${latest.number} is newer)` : null,
      busy ? `Started while ${toPath} was busy` : null,
      toArg && !familyFrom?.downstream.some((one) => one.path === toPath) ? `Promoted to ${toPath}, which is not the next environment` : null,
      skip.length && plan.blocked.some((one) => skip.includes(one.name)) ? `Left behind on purpose: ${plan.blocked.filter((one) => skip.includes(one.name)).map((one) => one.name).join(', ')}` : null,
      args.allowDeprecated === true && toPath.split('/').some((segment) => OLD_FAMILY.test(segment)) ? 'Promoted into a deprecated family on request' : null,
    ]);
    const started = await this.#launch({ server, api, path: toPath, params, source: 'promote', from: { path: fromPath, number: fromNumber }, follow: args.follow !== false, note: notes });
    const kept = splitSecrets(defs, params).kept;
    return {
      ok: true,
      launchId: started.id,
      queueId: started.queueId,
      to: toPath,
      from: { path: fromPath, number: fromNumber },
      params: kept,
      copied: plan.copied,
      given: Object.keys(given),
      notes: notes ? notes.split('; ') : [],
      followed: args.follow !== false,
    };
  }

  // --- scheduling -----------------------------------------------------------------------

  #scheduleShape(row) {
    return {
      id: row.id,
      path: row.path,
      params: safeJson(row.params, {}),
      at: row.at,
      inMs: row.state === 'scheduled' ? row.at - this.now() : null,
      note: row.note ?? null,
      state: row.state,
      firedAt: row.fired_at ?? null,
      launchId: row.launch_id ?? null,
      error: row.error ?? null,
    };
  }

  #schedules({ server }) {
    const db = this.#need();
    const open = db.prepare("SELECT * FROM jl_schedule WHERE server = ? AND state IN ('scheduled', 'missed') ORDER BY at ASC").all(server.id);
    const closed = db.prepare("SELECT * FROM jl_schedule WHERE server = ? AND state NOT IN ('scheduled', 'missed') ORDER BY at DESC LIMIT 10").all(server.id);
    return { schedules: [...open, ...closed].map((row) => this.#scheduleShape(row)) };
  }

  async #scheduleRun({ server, api, args }) {
    const db = this.#need();
    const path = needPath(args.path);
    const at = typeof args.at === 'string' && /^\d+$/.test(args.at.trim()) ? Number(args.at) : args.at;
    if (!Number.isFinite(at)) throw new JenkinsError('Say when it should run');
    const now = this.now();
    if (at < now + SCHEDULE_MIN_MS) throw new JenkinsError(`That is too soon — a schedule is at least ${SCHEDULE_MIN_MS / 1000} seconds ahead; run it now instead`);
    if (at > now + SCHEDULE_MAX_MS) throw new JenkinsError('That is too far ahead — a schedule is at most 30 days away, and only runs while Smart Terminal is open');
    const given = paramsIn(args.params);
    const note = typeof args.note === 'string' && args.note.trim() ? clip(args.note, NOTE_MAX) : null;
    // The same schedule asked for twice — at once or later — is one: it fires once.
    const sorted = JSON.stringify(Object.entries(given).sort(([a1], [b1]) => (a1 < b1 ? -1 : 1)));
    const hash = crypto.createHash('sha1').update(JSON.stringify(['schedule', server.id, path, Math.floor(at), sorted, note])).digest('hex');
    const flying = this.inflight.get(hash);
    if (flying) return flying.then((result) => ({ ...result, deduplicated: true }));
    const same = db.prepare("SELECT * FROM jl_schedule WHERE server = ? AND path = ? AND at = ? AND state = 'scheduled'").all(server.id, path, Math.floor(at))
      .find((row) => JSON.stringify(Object.entries(safeJson(row.params, {})).sort(([a1], [b1]) => (a1 < b1 ? -1 : 1))) === sorted && (row.note ?? null) === note);
    if (same) return { id: same.id, path, at: same.at, state: 'scheduled', deduplicated: true };
    const work = this.#scheduleWork({ server, api, db, path, at, given, note, now }).finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, work);
    return work;
  }

  async #scheduleWork({ server, api, db, path, at, given, note, now }) {
    const job = await this.#job(server.id, api, path, { builds: 0, fresh: true });
    if (job.buildable === false) throw new JenkinsError(`${path} is disabled — enable it in Jenkins first`);
    const { kept, needs } = splitSecrets(job.parameters, given);
    // A job with a secret parameter cannot be scheduled at all: what is typed now cannot be kept, and a run that starts
    // later would start with the secret empty.
    if (needs.length) throw new JenkinsError(`${needs.slice(0, 3).join(', ')} ${needs.length === 1 ? 'is a secret' : 'are secrets'}, and a secret is never kept — run this one now instead`);
    if (db.prepare("SELECT COUNT(*) AS n FROM jl_schedule WHERE server = ? AND state IN ('scheduled', 'missed')").get(server.id).n >= SCHEDULES_PER_SERVER) {
      throw new JenkinsError(`There are already ${SCHEDULES_PER_SERVER} schedules on this Jenkins — cancel one first`);
    }
    const id = `sched-${crypto.randomBytes(4).toString('hex')}`;
    db.prepare("INSERT INTO jl_schedule (id, server, path, params, at, note, state, created) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)").run(id, server.id, path, JSON.stringify(kept), Math.floor(at), note, now);
    this.#arm();
    return { id, path, at: Math.floor(at), state: 'scheduled' };
  }

  /** The next look at the schedules: when the earliest is due, and at least every half minute so that waking from sleep is noticed. */
  #arm() {
    if (this.stopped || !this.db || !this.maintain) return;
    if (this.beat) clearTimeout(this.beat);
    this.beat = null;
    let next = null;
    try { next = this.db.prepare("SELECT MIN(at) AS at FROM jl_schedule WHERE state = 'scheduled'").get()?.at ?? null; } catch { return; }
    if (next === null) return;
    const wait = Math.max(50, Math.min(SCHEDULE_BEAT_MS, next - this.now()));
    this.beat = setTimeout(() => { this.beat = null; void this.#due(); }, wait);
    this.beat.unref?.();
  }

  async #due() {
    if (this.stopped || this.isClosed() || !this.db) return;
    const now = this.now();
    const rows = this.db.prepare("SELECT * FROM jl_schedule WHERE state = 'scheduled' AND at <= ? ORDER BY at ASC").all(now);
    for (const row of rows) {
      // Claimed first: a second beat finding it still scheduled would run it twice.
      const claimed = this.db.prepare("UPDATE jl_schedule SET state = 'firing' WHERE id = ? AND state = 'scheduled'").run(row.id);
      if (!claimed.changes) continue;
      await this.#fire(row, now).catch(() => {});
    }
    this.#arm();
  }

  async #fire(row, now) {
    const place = (extra) => ({ server: row.server, page: { type: 'job', path: row.path, ...extra } });
    // Late is missed, not fired late: the machine slept, or something else was in the way — and what looks like production waits less for it.
    if (now - row.at > (looksProdPath(row.path, this.#settings(row.server)) ? LATE_PROD_MS : LATE_MS)) {
      this.db.prepare("UPDATE jl_schedule SET state = 'missed', error = ? WHERE id = ?").run('Smart Terminal was asleep or busy at that time', row.id);
      this.emit({ type: 'schedule', server: row.server, id: row.id, path: row.path, state: 'missed' });
      this.notify(`Missed: ${row.path}`, 'It was meant to run earlier and was not started. Run it now, or dismiss it.', place());
      return;
    }
    try {
      const { server, api } = this.on(row.server);
      const started = await this.#launch({ server, api, path: row.path, params: safeJson(row.params, {}), source: 'schedule' });
      this.db.prepare("UPDATE jl_schedule SET state = 'fired', fired_at = ?, launch_id = ?, error = NULL WHERE id = ?").run(this.now(), started.id, row.id);
      this.emit({ type: 'schedule', server: row.server, id: row.id, path: row.path, state: 'fired', launchId: started.id });
      this.notify(`Started: ${row.path}`, row.note ? `Scheduled run · ${row.note}` : 'Scheduled run', place());
    } catch (error) {
      const message = clip(error?.message ?? error, 200);
      this.db.prepare("UPDATE jl_schedule SET state = 'failed', error = ? WHERE id = ?").run(message, row.id);
      this.emit({ type: 'schedule', server: row.server, id: row.id, path: row.path, state: 'failed', error: message });
      this.notify(`Did not start: ${row.path}`, message, place());
    }
  }

  #cancel({ server, id }) {
    const db = this.#need();
    if (id.startsWith('sched-')) {
      const row = db.prepare('SELECT * FROM jl_schedule WHERE id = ? AND server = ?').get(id, server.id);
      if (!row) throw new JenkinsError('That schedule is not here any more');
      if (!['scheduled', 'missed'].includes(row.state)) throw new JenkinsError(`That schedule has already ${row.state === 'fired' ? 'run' : row.state}`);
      db.prepare("UPDATE jl_schedule SET state = 'cancelled' WHERE id = ?").run(id);
      this.#arm();
      return { ok: true, id, state: 'cancelled' };
    }
    if (id.startsWith('batch-')) {
      const row = db.prepare('SELECT * FROM jl_batch WHERE id = ? AND server = ?').get(id, server.id);
      if (!row) throw new JenkinsError('That batch is not here any more');
      if (row.state !== 'running') throw new JenkinsError('That batch has already finished');
      const live = this.live.get(id);
      if (live) live.cancelled = true;
      const items = safeJson(row.items, []);
      const skipped = items.filter((one) => one.state === 'waiting').length;
      const leftRunning = items.filter((one) => one.state === 'queued' || one.state === 'running').length;
      const marked = items.map((one) => (one.state === 'waiting' ? { ...one, state: 'skipped', error: 'Cancelled' } : one));
      this.#batchSave(row, marked, leftRunning ? 'cancelled' : 'cancelled');
      // Whoever was waiting for an item of it goes on to find the batch cancelled.
      for (const item of marked) if (item.launchId) { const list = this.waiters.get(item.launchId); if (list) { this.waiters.delete(item.launchId); for (const resolve of list) resolve('aborted'); } }
      this.live.delete(id);
      this.#batchEvent(id, true);
      return { ok: true, id, state: 'cancelled', skipped, leftRunning };
    }
    throw new JenkinsError('That is not a schedule or a batch');
  }
}

module.exports = { Launch, familyOf, splitSecrets, paramsIn, LATE_MS, RATE_MAX, SCHEDULE_MIN_MS };
