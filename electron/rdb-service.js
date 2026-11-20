'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { RdbStore } = require('./rdb-store');
const drivers = require('./rdb-drivers');
const { Tunnels } = require('./rdb-tunnel');
const watch = require('./rdb-watch');
const debug = require('./rdb-debug');
const sql = require('./rdb-sql');

/** PostgreSQL answers in text here, MySQL in numbers: both mean the same. */
const yes = (value) => value === true || value === 't' || value === 'true' || value === 1 || value === '1';

/**
 * The Databases extension, on the app's side of the door.
 *
 * A panel names a connection by id and says what it wants; this opens the
 * connection with the password only this process can read, asks, and answers
 * with rows of text. A panel never holds a credential, never names an address
 * to connect to except through `saveConnection` and `testConnection`, and
 * cannot reach the network at all.
 *
 * Connections are kept open while they are being used and let go when they are
 * not. Browsing has one per database, shared by the tree and the grids; every
 * query tab has its own — so a BEGIN typed in one tab is that tab's
 * transaction and nobody else's, which is what somebody typing BEGIN means.
 */

const MAX_SESSIONS = 24;
const IDLE_MS = 10 * 60_000;
/** How many routines may be stepped through at once, and how long one may sit untouched. Each holds two connections. */
const MAX_DEBUGS = 4;
const DEBUG_IDLE_MS = 20 * 60_000;

/** What each kind of alert is, in the few words a notification has room for. */
const ALERT_TITLES = {
  blocked: 'sessions stuck on a lock',
  long_query: 'a statement running for a long time',
  idle_transaction: 'a transaction left open',
  connections: 'connections running out',
  wraparound: 'transaction ids running out',
  dead_rows: 'dead rows piling up',
  deadlocks: 'deadlocks',
  cache: 'reading from disk',
  slower: 'a statement got slower',
  growth: 'growing fast',
};
/** A tab with a transaction open is waited for longer: closing it rolls the work back. */
const IDLE_IN_TRANSACTION_MS = 60 * 60_000;
const SWEEP_MS = 60_000;
const QUERY_ROWS_DEFAULT = 1000;
const QUERY_ROWS_MAX = 20_000;
const SCRIPT_MAX = 2_000_000;
const STATEMENTS_MAX = 500;
const EXPORT_ROWS_MAX = 500_000;
const CHANGES_MAX = 2000;
const REPORT_ROWS_MAX = 2000;
const IMPORT_ROWS_MAX = 5_000_000;
/** A script opened into an editor. Past this it is a dump, and a dump is restored, not edited. */
const SCRIPT_FILE_MAX = 5 * 1024 * 1024;
/** How much of a file is read to show what is in it before anything is imported. */
const IMPORT_PEEK = 256 * 1024;
/** A password file written for a terminal is there for as long as the client takes to read it. */
const SHELL_SECRET_MS = 60_000;

/** A value that is one word to a shell. Quoted only when it has to be, and refused rather than escaped when it holds a quote. */
function shellWord(value, what) {
  const text = String(value ?? '');
  if (!text) throw new Error(`${what} is missing`);
  if (/^[A-Za-z0-9_.@:/+=-]+$/.test(text)) return text;
  if (text.includes("'") || /[\u0000-\u001f]/.test(text)) throw new Error(`${what} contains a character this cannot pass to a shell safely`);
  return `'${text}'`;
}
/** A dump of a big database takes as long as it takes; this is only so a hung one ends. */
const DUMP_TIMEOUT = 6 * 60 * 60_000;

/** Where the dump tools install themselves, for an app that was not started from a terminal and has the bare system PATH. */
const TOOL_DIRS = [
  '/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/opt/libpq/bin', '/usr/local/opt/libpq/bin',
  '/Applications/Postgres.app/Contents/Versions/latest/bin', '/usr/local/mysql/bin', '/opt/homebrew/opt/mysql-client/bin', '/usr/bin',
];

function findTool(name) {
  const dirs = [...String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...TOOL_DIRS];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not there */ }
  }
  return null;
}

/** Run a tool to its end. Its password travels in the environment, never on the command line, where `ps` would show it. */
function runTool(file, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let errors = '';
    const timer = setTimeout(() => child.kill(), DUMP_TIMEOUT);
    child.stderr.on('data', (chunk) => { if (errors.length < 20_000) errors += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(errors.trim());
      else {
        // The line that says what went wrong, not the forty lines of SQL the tool prints after it.
        const lines = errors.trim().split('\n');
        const said = lines.filter((line) => /\b(error|fatal)\b/i.test(line)).slice(0, 4);
        reject(new Error((said.length ? said : lines.slice(-6)).join('\n').slice(0, 1500) || `${path.basename(file)} ended with code ${code}`));
      }
    });
    if (input) input.pipe(child.stdin);
  });
}

class RdbService {
  /**
   * @param {object} deps
   * @param {object} deps.db                 the app's database (node:sqlite)
   * @param {{encrypt:Function, decrypt:Function}} deps.secrets
   * @param {Function} [deps.pickFile]       () => Promise<string|null> — a database file the person chose
   * @param {Function} [deps.saveFile]       ({suggestedName, extension, build}) => Promise<{name}|null>
   * @param {Function} [deps.open]           how a connection is opened; the drivers', unless a test says otherwise
   * @param {Function} [deps.pickSavePath]   ({suggestedName, extension}) => Promise<string|null> — where a backup goes
   * @param {Function} [deps.pickBackup]     () => Promise<string|null> — a backup file the person chose
   * @param {Function} [deps.findTool]       (name) => path of pg_dump and friends, or null
   * @param {Function} [deps.runTool]        (file, args, {env, input}) => Promise<string>
   */
  constructor({ db, secrets, pickFile, saveFile, open, pickSavePath, pickBackup, findTool: find, runTool: run, pickCsv, pickScript, scratch, tunnels, notify, now }) {
    /** () => Promise<string|null> — a .sql file the person chose to open in an editor. */
    this.pickScript = pickScript ?? (async () => null);
    /** () => Promise<string|null> — a delimited file the person chose to import. */
    this.pickCsv = pickCsv ?? (async () => null);
    /** Where a terminal's password file lives for the minute it exists. */
    this.scratch = scratch ?? os.tmpdir();
    /** token → the file a preview was shown of. The panel holds the token; the path never leaves this process. */
    this.imports = new Map();
    this.shellSecrets = new Set();
    this.pickSavePath = pickSavePath ?? (async () => null);
    this.pickBackup = pickBackup ?? (async () => null);
    this.findTool = find ?? findTool;
    this.runTool = run ?? runTool;
    this.store = new RdbStore(db, secrets);
    this.pickFile = pickFile ?? (async () => null);
    this.saveFile = saveFile ?? (async () => null);
    this.open = open ?? drivers.open;
    /** connection id → the ssh that carries it, for the connections that go through another machine. */
    this.tunnels = tunnels ?? new Tunnels();
    /** ({ title, body }) => void — told when a watched server has something new wrong with it. */
    this.notify = notify ?? (() => {});
    this.now = now ?? (() => Date.now());
    /** connection id → why its last reading could not be taken */
    this.watchErrors = new Map();
    this.watching = new Set();
    this.lastPrune = 0;
    /** key → { session, opening, tail, used, id } */
    this.sessions = new Map();
    /** connection id → what last went wrong in a query, for a Claude session to be handed */
    this.failures = new Map();
    /** token → a routine being stepped through, with the two connections that is */
    this.debugs = new Map();
    /** connection id → the plan last asked for there, for the same purpose */
    this.plans = new Map();
    this.timer = null;
    this.verbs = this.#verbs();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.#sweep(); this.watchTick().catch(() => {}); }, SWEEP_MS);
    this.timer.unref?.();
  }

  /** Every connection closed. An open transaction is rolled back by the server when its connection goes. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const file of this.shellSecrets) fs.rmSync(file, { force: true });
    this.shellSecrets.clear();
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((entry) => entry.session?.close()));
    const runs = [...this.debugs.values()];
    this.debugs.clear();
    await Promise.allSettled(runs.map((held) => held.run.stop()));
    this.tunnels.closeAll();
  }

  async call(name, args = {}) {
    // Own keys only: `constructor` and `toString` are on every object and are not verbs.
    const verb = Object.hasOwn(this.verbs, name) ? this.verbs[name] : null;
    if (!verb) return { ok: false, error: `No such Databases action: ${String(name).slice(0, 60)}` };
    try {
      const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      return (await verb(given)) ?? { ok: true };
    } catch (error) {
      return { ok: false, ...this.#words(error, args?.id) };
    }
  }

  /** What an error says to a panel: the server's own words, with this connection's password taken out if it is in them. */
  #words(error, id) {
    let message = String(error?.message ?? error ?? 'It did not say why').slice(0, 4000);
    let secret = '';
    try { secret = id ? (this.store.secret(id)?.password ?? '') : ''; } catch { secret = ''; }
    if (secret.length >= 4) message = message.split(secret).join('••••••');
    const out = { error: message };
    for (const key of ['detail', 'hint', 'code', 'position']) if (error?.[key] !== undefined && error[key] !== '') out[key] = error[key];
    return out;
  }

  // ─────────────────────────────────────────────────────────── connections ──

  #config(id, database) {
    const config = this.store.secret(id);
    if (!config) throw new Error('That connection is not known any more');
    // SQLite has one database and it is the file.
    if (config.engine !== 'sqlite' && database) config.database = String(database);
    return config;
  }

  /**
   * Where to actually connect. A connection that goes through another machine
   * is reached at a port on this one, with the tunnel opened if it has to be;
   * the name the certificate was issued for stays the server's own.
   */
  async #through(config, key) {
    if (config.engine === 'sqlite' || !config.sshHost) return config;
    const local = await this.tunnels.through(
      key,
      { host: config.sshHost, port: config.sshPort, user: config.sshUser, key: config.sshKey },
      { host: config.host || 'localhost', port: config.port || (config.engine === 'mysql' ? 3306 : 5432) },
    );
    return { ...config, host: local.host, port: local.port, tlsHost: config.host, via: `${config.host || 'localhost'}:${config.port || (config.engine === 'mysql' ? 3306 : 5432)}` };
  }

  /** Open it, and when what failed was the far end of a tunnel, say that — the port on this machine means nothing to anybody. */
  async #opened(config) {
    try {
      return await this.open(config);
    } catch (error) {
      if (config.via && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'PROTOCOL_CONNECTION_LOST'].includes(error?.code)) {
        throw new drivers.RdbError(`${config.sshHost} let you in over SSH, but could not reach the database at ${config.via} from there`);
      }
      throw error;
    }
  }

  async #reach(id, database) {
    return this.#through(this.#config(id, database), String(id));
  }

  #key(id, database, purpose) {
    return `${id}\u0000${database ?? ''}\u0000${purpose}`;
  }

  /** The live connection for a purpose, opened if it has to be. Two callers arriving together share one opening. */
  async #entry(id, database, purpose = 'browse') {
    const key = this.#key(id, database, purpose);
    let entry = this.sessions.get(key);
    if (entry?.session?.closed) {
      this.sessions.delete(key);
      entry = null;
    }
    if (!entry) {
      await this.#makeRoom();
      entry = { id: String(id), key, session: null, tail: Promise.resolve(), used: Date.now(), opening: null };
      entry.opening = Promise.resolve()
        .then(() => this.#reach(id, database))
        .then((config) => this.#opened(config))
        .then((session) => { entry.session = session; return session; });
      this.sessions.set(key, entry);
      entry.opening.catch(() => {
        if (this.sessions.get(key) === entry) this.sessions.delete(key);
      });
    }
    await entry.opening;
    entry.used = Date.now();
    return entry;
  }

  /** One thing at a time on a connection: a page read inside a transaction must not have a stranger's statement in the middle of it. */
  #locked(entry, work) {
    const run = entry.tail.then(() => work(entry.session));
    entry.tail = run.then(() => {}, () => {});
    return run.finally(() => { entry.used = Date.now(); });
  }

  async #browse(id, database, work) {
    const entry = await this.#entry(id, database, 'browse');
    return this.#locked(entry, work);
  }

  /** One more thing asked of a run. When it has ended, its connections are let go and the answer says how it ended. */
  async #debugging(args, work) {
    const token = String(args.token ?? '');
    const held = this.debugs.get(token);
    if (!held || held.id !== String(args.id)) throw new Error('That run is over');
    try {
      const state = await work(held.run);
      if (state.done) {
        this.debugs.delete(token);
        await held.run.stop();
      }
      return { ok: true, token: state.done ? null : token, ...state };
    } catch (error) {
      this.debugs.delete(token);
      await held.run.stop();
      throw error;
    }
  }

  /**
   * Read the watched servers that are due. Called on the sweep's clock and safe
   * to call at any time: a server already being read is left alone, and one
   * that cannot be reached is remembered as such and tried again next time.
   */
  async watchTick() {
    const now = this.now();
    if (now - this.lastPrune > 6 * 3600_000) {
      this.lastPrune = now;
      this.store.pruneReadings(now - watch.WATCH_KEEP_MS);
    }
    const due = this.store.watched().filter((id) => {
      const last = this.store.lastReadingAt(id);
      return last === null || now - last >= watch.WATCH_EVERY_MS - 5000;
    });
    await Promise.allSettled(due.map((id) => this.#read(id)));
  }

  async #read(id) {
    if (this.watching.has(id)) return;
    this.watching.add(id);
    try {
      const connection = this.#connection(id);
      const reading = await this.#browse(id, '', (session) => this.#reading(session, () => watch.collect(connection.engine, session)));
      if (!reading) return;
      reading.server.at = this.now();
      const since = reading.server.at - 26 * 3600_000;
      const history = this.store.readings(id, since, { statements: true });
      // What the statements cost since the reading before, kept with this one so a chart need not work it out again.
      reading.server.interval_ms = watch.statementDeltas(history.at(-1)?.statements, reading.statements).reduce((sum, one) => sum + one.ms, 0);
      this.store.addReading(id, reading.server, reading.statements);
      const fresh = this.store.judged(id, watch.judge(history, reading), reading.server.at);
      this.watchErrors.delete(id);
      for (const one of fresh) {
        try { this.notify({ title: `${connection.name}: ${ALERT_TITLES[one.rule] ?? 'something to look at'}`, body: one.message, connection: id }); } catch { /* a notification that cannot be shown is not a reason to stop watching */ }
      }
    } catch (error) {
      this.watchErrors.set(id, this.#words(error, id).error);
    } finally {
      this.watching.delete(id);
    }
  }

  async #makeRoom() {
    if (this.sessions.size < MAX_SESSIONS) return;
    const idle = [...this.sessions.values()]
      .filter((entry) => entry.session && entry.session.txn === 'idle')
      .sort((a, b) => a.used - b.used)[0];
    if (!idle) throw new Error(`There are already ${MAX_SESSIONS} connections open. Close a query tab.`);
    this.sessions.delete(idle.key);
    await idle.session.close();
  }

  #sweep() {
    const now = Date.now();
    for (const entry of this.sessions.values()) {
      if (!entry.session) continue;
      const limit = entry.session.txn === 'idle' ? IDLE_MS : IDLE_IN_TRANSACTION_MS;
      if (entry.session.closed || now - entry.used > limit) {
        this.sessions.delete(entry.key);
        entry.session.close().catch(() => {});
      }
    }
    // A routine somebody stopped stepping through and walked away from is holding a connection frozen on a line.
    for (const [token, held] of this.debugs) {
      if (now - held.run.used > DEBUG_IDLE_MS) {
        this.debugs.delete(token);
        held.run.stop().catch(() => {});
      }
    }
    // A tunnel outlives its last connection by the same patience, and no longer.
    const inUse = new Set([...this.sessions.values()].map((entry) => entry.id).concat([...this.debugs.values()].map((held) => held.id)));
    for (const key of this.tunnels.keys()) {
      if (!inUse.has(key) && this.tunnels.idle(key, IDLE_MS)) this.tunnels.close(key);
    }
  }

  async #closeAll(id) {
    const mine = [...this.sessions.values()].filter((entry) => entry.id === String(id));
    for (const entry of mine) this.sessions.delete(entry.key);
    await Promise.allSettled(mine.map((entry) => entry.session?.close()));
    for (const [token, held] of this.debugs) {
      if (held.id !== String(id)) continue;
      this.debugs.delete(token);
      await held.run.stop();
    }
    this.tunnels.close(String(id));
  }

  #isOpen(id) {
    for (const entry of this.sessions.values()) if (entry.id === id && entry.session && !entry.session.closed) return true;
    return false;
  }

  #connection(id) {
    const connection = this.store.connection(id);
    if (!connection) throw new Error('That connection is not known any more');
    return connection;
  }

  /** Read inside a transaction that cannot write, so a filter somebody typed is held to reading by the server. */
  async #reading(session, work) {
    if (session.engine === 'sqlite') return work();
    const begin = drivers.catalog(session.engine).begin(true);
    await session.all(begin);
    try {
      return await work();
    } finally {
      await session.all('ROLLBACK').catch(() => {});
    }
  }

  // ───────────────────────────────────────────────────────────────── verbs ──

  #verbs() {
    const store = this.store;
    return {
      overview: () => ({
        ok: true,
        connections: ((alerts) => store.connections().map((connection) => ({ ...connection, open: this.#isOpen(connection.id), alerts: alerts.get(connection.id) ?? 0 })))(store.openAlerts()),
        saved: store.saved(),
      }),

      parseUrl: (args) => {
        const found = sql.parseUrl(args.text);
        return found ? { ok: true, connection: found } : { ok: false, error: 'That does not read as a database URL' };
      },

      saveConnection: async (args) => {
        const saved = store.save(args.connection ?? {});
        // What was open was opened with the old settings.
        await this.#closeAll(saved.id);
        return { ok: true, connection: saved };
      },

      /**
       * Whether a connection works, before it is saved or after it was changed.
       * A password that was not typed is the stored one — the form never had it.
       */
      testConnection: async (args) => {
        const given = args.connection ?? {};
        const clean = RdbStore.clean(given);
        let password = typeof given.password === 'string' ? given.password : '';
        if (!password && given.id && given.clearPassword !== true) password = store.secret(given.id)?.password ?? '';
        const started = Date.now();
        // A tunnel of its own, gone when the test is: what is being tested may not be what is saved.
        const trial = `test:${crypto.randomUUID()}`;
        try {
          const config = await this.#through({ ...clean, password }, trial);
          const session = await this.#opened(config);
          try {
            const info = await drivers.catalog(config.engine).info(session);
            return { ok: true, version: String(info.version ?? '').slice(0, 200), ms: Date.now() - started };
          } finally {
            await session.close();
          }
        } finally {
          this.tunnels.close(trial);
        }
      },

      deleteConnection: async (args) => {
        await this.#closeAll(args.id);
        store.remove(args.id);
        this.failures.delete(String(args.id));
        return { ok: true };
      },

      disconnect: async (args) => {
        await this.#closeAll(args.id);
        return { ok: true };
      },

      pickFile: async () => {
        const file = await this.pickFile();
        return file ? { ok: true, file } : { ok: false, error: 'No file was chosen', cancelled: true };
      },

      // ── the tree ──

      databases: async (args) => {
        const connection = this.#connection(args.id);
        const catalog = drivers.catalog(connection.engine);
        return this.#browse(args.id, '', async (session) => ({
          ok: true,
          databases: await catalog.databases(session),
          current: connection.engine === 'sqlite' ? 'main' : String((await catalog.info(session)).database ?? connection.database ?? ''),
        }));
      },

      schemas: async (args) => {
        const connection = this.#connection(args.id);
        return this.#browse(args.id, args.database, async (session) => ({
          ok: true,
          schemas: await drivers.catalog(connection.engine).schemas(session),
        }));
      },

      objects: async (args) => {
        const connection = this.#connection(args.id);
        return this.#browse(args.id, args.database, async (session) => ({
          ok: true,
          ...(await drivers.catalog(connection.engine).objects(session, this.#schema(connection, args))),
        }));
      },

      table: async (args) => {
        const connection = this.#connection(args.id);
        return this.#browse(args.id, args.database, async (session) => ({
          ok: true,
          table: await drivers.catalog(connection.engine).table(session, this.#schema(connection, args), String(args.name ?? '')),
        }));
      },

      routine: async (args) => {
        const connection = this.#connection(args.id);
        return this.#browse(args.id, args.database, async (session) => ({
          ok: true,
          ...(await drivers.catalog(connection.engine).routine(session, this.#schema(connection, args), String(args.routine ?? ''))),
        }));
      },

      info: async (args) => {
        const connection = this.#connection(args.id);
        return this.#browse(args.id, args.database, async (session) => ({
          ok: true,
          info: await drivers.catalog(connection.engine).info(session),
        }));
      },

      // ── a table's rows ──

      rows: async (args) => {
        const connection = this.#connection(args.id);
        const text = sql.selectPage({
          engine: connection.engine,
          schema: this.#schema(connection, args),
          table: String(args.name ?? ''),
          where: args.where,
          orderBy: args.orderBy,
          limit: args.limit,
          offset: args.offset,
        });
        const size = sql.pageSize(args.limit);
        const started = Date.now();
        return this.#browse(args.id, args.database, (session) => this.#reading(session, async () => {
          const result = await session.run(text, [], { maxRows: size });
          return { ok: true, ...result, sql: text, ms: Date.now() - started, offset: Math.max(0, Math.floor(Number(args.offset)) || 0), limit: size };
        }));
      },

      /** How many rows there are behind the pages. Its own call, because on a big table it is the slow one. */
      count: async (args) => {
        const connection = this.#connection(args.id);
        const text = sql.countRows({ engine: connection.engine, schema: this.#schema(connection, args), table: String(args.name ?? ''), where: args.where });
        return this.#browse(args.id, args.database, (session) => this.#reading(session, async () => {
          const result = await session.run(text, [], { maxRows: 1 });
          return { ok: true, count: Number(result.rows[0]?.[0] ?? 0) };
        }));
      },

      /**
       * What the grid changed, made real — all of it or none of it.
       *
       * The key is read from the catalog here rather than taken from the panel,
       * and every UPDATE and DELETE has to find exactly one row: none means
       * somebody else changed or removed it first, and more than one means the
       * key is not one.
       */
      applyChanges: async (args) => {
        const connection = this.#connection(args.id);
        if (connection.readOnly) throw new Error('This connection is read-only');
        const schema = this.#schema(connection, args);
        const name = String(args.name ?? '');
        const changes = args.changes && typeof args.changes === 'object' ? args.changes : {};
        const total = ['inserts', 'updates', 'deletes'].reduce((n, kind) => n + (Array.isArray(changes[kind]) ? changes[kind].length : 0), 0);
        if (!total) return { ok: true, applied: 0 };
        if (total > CHANGES_MAX) throw new Error(`That is ${total} changes at once; this saves up to ${CHANGES_MAX}`);
        const catalog = drivers.catalog(connection.engine);
        return this.#browse(args.id, args.database, async (session) => {
          const table = await catalog.table(session, schema, name);
          const known = new Set(table.columns.map((column) => column.name));
          const statements = sql.changeStatements({ engine: connection.engine, schema, table: name, key: table.key, changes });
          for (const change of [...(changes.updates ?? []).map((one) => one?.set), ...(changes.inserts ?? [])]) {
            for (const column of Object.keys(change ?? {})) if (!known.has(column)) throw new Error(`${name} has no column "${column}"`);
          }
          await session.all(catalog.begin(false));
          try {
            for (const statement of statements) {
              const result = await session.run(statement.sql, statement.params, { maxRows: 1 });
              if (statement.kind !== 'insert' && result.rowCount !== 1) {
                throw new Error(
                  result.rowCount === 0
                    ? 'A row was changed or removed by somebody else since it was read. Nothing was saved; read the table again.'
                    : `A ${statement.kind} would have touched ${result.rowCount} rows instead of one. Nothing was saved.`,
                );
              }
            }
            await session.all('COMMIT');
          } catch (error) {
            await session.all('ROLLBACK').catch(() => {});
            throw error;
          }
          store.remember({ connection: connection.id, database: args.database, sql: statements.map((one) => one.sql).join(';\n'), ms: 0, ok: true, note: `${statements.length} change(s) from the grid` });
          return { ok: true, applied: statements.length };
        });
      },

      // ── the query tool ──

      query: (args) => this.#query(args),

      cancel: async (args) => {
        const entry = this.sessions.get(this.#key(args.id, args.database, `q:${String(args.tab ?? '')}`));
        if (!entry?.session) return { ok: true, cancelled: false };
        // Not through the lock: the lock is held by the very statement being cancelled.
        return { ok: true, cancelled: await entry.session.cancel() };
      },

      closeTab: async (args) => {
        const key = this.#key(args.id, args.database, `q:${String(args.tab ?? '')}`);
        const entry = this.sessions.get(key);
        if (entry) {
          this.sessions.delete(key);
          await entry.session?.close();
        }
        return { ok: true };
      },

      /**
       * A query's whole answer, written to a file the person chooses.
       *
       * It is run again, because what the grid holds is the first page of it.
       * That is why it has to be one statement that only reads: running
       * somebody's UPDATE a second time to "export" it would be a surprise.
       */
      export: async (args) => {
        const connection = this.#connection(args.id);
        const text = String(args.sql ?? '');
        const statements = sql.scan(text, connection.engine);
        if (statements.length !== 1 || sql.classify(statements[0].bare).kind !== 'read') {
          throw new Error('Only one statement that reads can be exported');
        }
        const format = ['csv', 'json', 'sql'].includes(args.format) ? args.format : 'csv';
        let rows = 0;
        let truncated = false;
        const done = await this.saveFile({
          suggestedName: `${String(args.name || 'query').replace(/[^\w.-]+/g, '_').slice(0, 60)}.${format}`,
          extension: format,
          build: async () => {
            const entry = await this.#entry(args.id, args.database, 'export');
            const result = await this.#locked(entry, (session) => this.#reading(session, () => session.run(statements[0].text, [], { maxRows: EXPORT_ROWS_MAX })));
            rows = result.rows.length;
            truncated = result.truncated;
            if (format === 'json') return sql.toJson(result.columns, result.rows);
            if (format === 'sql') return sql.toInserts(connection.engine, args.schema ? String(args.schema) : null, String(args.table ?? ''), result.columns, result.rows);
            return sql.toCsv(result.columns, result.rows);
          },
        });
        if (!done) return { ok: false, error: 'Nothing was exported', cancelled: true };
        return { ok: true, file: done.name, rows, truncated };
      },

      history: (args) => ({ ok: true, history: store.history(args.id, { q: args.q, limit: args.limit }) }),
      clearHistory: (args) => { store.clearHistory(args.id); return { ok: true }; },
      saveQuery: (args) => ({ ok: true, id: store.saveQuery(args), saved: store.saved() }),
      deleteQuery: (args) => { store.deleteQuery(args.id); return { ok: true, saved: store.saved() }; },

      // ── the server ──

      activity: async (args) => {
        const connection = this.#connection(args.id);
        const asked = drivers.catalog(connection.engine).activity();
        if (!asked) return { ok: true, supported: false };
        return this.#browse(args.id, args.database, async (session) => ({
          ok: true,
          supported: true,
          key: asked.key,
          ...(await session.run(asked.sql, [], { maxRows: 2000 })),
        }));
      },

      roles: async (args) => {
        const connection = this.#connection(args.id);
        const asked = drivers.catalog(connection.engine).roles();
        if (!asked) return { ok: true, supported: false };
        return this.#browse(args.id, args.database, async (session) => ({
          ok: true,
          supported: true,
          ...(await session.run(asked, [], { maxRows: 5000 })),
        }));
      },

      /** Stop what another session is doing, or end the session itself. */
      kill: async (args) => {
        const connection = this.#connection(args.id);
        return this.#browse(args.id, args.database, async (session) => ({
          ok: true,
          done: await drivers.catalog(connection.engine).kill(session, args.pid, args.hard === true),
        }));
      },

      /**
       * A page that is only read: a table's statistics, what depends on it, the
       * server's locks or its configuration. Each section is asked on its own,
       * so one the role may not read says so without taking the others with it.
       */
      report: async (args) => {
        const connection = this.#connection(args.id);
        const sections = drivers.catalog(connection.engine).reports(String(args.kind ?? ''), {
          schema: this.#schema(connection, args),
          name: String(args.name ?? ''),
          q: String(args.q ?? '').slice(0, 200),
        });
        if (!sections) return { ok: true, supported: false };
        const out = [];
        for (const section of sections) {
          const head = { title: section.title, note: section.note ?? '', vertical: section.vertical === true, filter: section.filter === true, open: section.open === true };
          try {
            // A section about something that may not be installed asks first, and says so in words instead of failing in the server's.
            if (section.requires && connection.engine === 'postgres') {
              const there = await this.#browse(args.id, args.database, (session) => this.#reading(session, () => session.all('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS there', [section.requires])));
              if (!yes(there[0]?.there)) {
                out.push({ ...head, absent: section.absent ?? 'Not installed in this database.', columns: [], rows: [] });
                continue;
              }
            }
            const result = await this.#browse(args.id, args.database, (session) => this.#reading(session, () => session.run(section.sql, section.params ?? [], { maxRows: REPORT_ROWS_MAX })));
            out.push({ ...head, columns: result.columns, rows: result.rows, truncated: result.truncated });
          } catch (error) {
            out.push({ ...head, error: this.#words(error, args.id).error });
          }
        }
        return { ok: true, supported: true, sections: out };
      },

      /** Everything a schema defines, for comparing it with another. Read inside a transaction, so it is one moment of the schema and not several. */
      snapshot: async (args) => {
        const connection = this.#connection(args.id);
        const schema = this.#schema(connection, args);
        const snapshot = await this.#browse(args.id, args.database, (session) => this.#reading(session, () => drivers.catalog(connection.engine).snapshot(session, schema)));
        return { ok: true, engine: connection.engine, schema, snapshot };
      },

      /** The server's counters, for a dashboard to subtract one reading from the next. */
      metrics: async (args) => {
        const connection = this.#connection(args.id);
        const sample = await this.#browse(args.id, args.database, (session) => drivers.catalog(connection.engine).metrics(session));
        return sample ? { ok: true, supported: true, sample } : { ok: true, supported: false };
      },

      /** Whether a routine can be stepped through, and what it takes. */
      debugInfo: async (args) => {
        const connection = this.#connection(args.id);
        if (connection.engine !== 'postgres') return { ok: true, cannot: 'Only PostgreSQL has a debugger for its procedures.' };
        const info = await this.#browse(args.id, args.database, (session) => this.#reading(session, () => debug.describe(session, args.routine)));
        return { ok: true, ...info, api: undefined, cannot: info.cannot || (connection.readOnly ? 'This connection is read-only, and stepping through a routine runs it.' : '') };
      },

      /**
       * Run a routine and stop on its first line. Two connections of its own:
       * one that makes the call and waits, one that steps it.
       */
      debugStart: async (args) => {
        const connection = this.#connection(args.id);
        if (connection.engine !== 'postgres') throw new Error('Only PostgreSQL has a debugger for its procedures');
        if (connection.readOnly) throw new Error('This connection is read-only, and stepping through a routine runs it');
        if (this.debugs.size >= MAX_DEBUGS) throw new Error('Too many routines are being stepped through already. Stop one.');
        const info = await this.#browse(args.id, args.database, (session) => this.#reading(session, () => debug.describe(session, args.routine)));
        if (info.cannot) throw new Error(info.cannot);
        const config = await this.#reach(args.id, args.database);
        const target = await this.#opened(config);
        let control;
        try { control = await this.#opened(config); } catch (error) { await target.close(); throw error; }
        const run = new debug.DebugRun({ target, control, info });
        const token = crypto.randomUUID();
        try {
          const state = await run.start(Array.isArray(args.args) ? args.args.map((one) => (one === null || one === undefined ? null : String(one))) : []);
          if (state.done) { await run.stop(); return { ok: true, token: null, ...state }; }
          this.debugs.set(token, { run, id: connection.id });
          return { ok: true, token, ...state };
        } catch (error) {
          await run.stop();
          throw error;
        }
      },

      debugStep: async (args) => this.#debugging(args, (run) => run.step(String(args.action ?? ''))),
      debugBreak: async (args) => this.#debugging(args, (run) => run.breakpoint(args.func, args.line, args.on === true)),

      debugStop: async (args) => {
        const held = this.debugs.get(String(args.token ?? ''));
        if (held && held.id === String(args.id)) {
          this.debugs.delete(String(args.token));
          await held.run.stop();
        }
        return { ok: true };
      },

      /** One pgAgent job, or the lists a form for a new one offers. Read in the database pgAgent lives in, which is the one asked about. */
      job: async (args) => {
        const connection = this.#connection(args.id);
        if (connection.engine !== 'postgres') return { ok: true, installed: false };
        const found = await this.#browse(args.id, args.database, (session) => this.#reading(session, () => drivers.catalog('postgres').job(session, args.job ?? null)));
        return { ok: true, ...found };
      },

      /** Have a server read every few minutes, or stop. Turning it on takes the first reading at once, so the page is not empty. */
      watch: async (args) => {
        const connection = this.#connection(args.id);
        if (connection.engine === 'sqlite') throw new Error('A SQLite file has no server to watch');
        store.setWatch(connection.id, args.on === true);
        if (args.on === true) await this.#read(connection.id);
        else this.watchErrors.delete(connection.id);
        return { ok: true, watching: args.on === true };
      },

      /** One more reading now, rather than at the next tick. */
      readNow: async (args) => {
        const connection = this.#connection(args.id);
        if (!connection.watch) throw new Error('This server is not being watched');
        await this.#read(connection.id);
        const error = this.watchErrors.get(connection.id);
        if (error) throw new Error(error);
        return { ok: true };
      },

      /** What the readings of a window add up to: the charts, the statements and what was said. */
      trends: (args) => {
        const connection = this.#connection(args.id);
        const hours = Math.min(Math.max(Number(args.hours) || 24, 1), 24 * 7);
        const until = this.now();
        const from = until - hours * 3600_000;
        const readings = store.readings(connection.id, from).map((one) => one.server);
        return {
          ok: true,
          watching: connection.watch,
          everyMinutes: watch.WATCH_EVERY_MS / 60_000,
          keptDays: watch.WATCH_KEEP_MS / 86_400_000,
          hours,
          error: this.watchErrors.get(connection.id) ?? null,
          readings: readings.length,
          lastAt: readings.at(-1)?.at ?? null,
          tracked: readings.at(-1)?.tracked !== false,
          points: watch.trend(readings),
          statements: watch.statementTrends(store.statementReadings(connection.id, from), store.statementTexts(connection.id), from, until).slice(0, 50),
          alerts: store.alerts(connection.id),
        };
      },

      dismissAlert: (args) => {
        const connection = this.#connection(args.id);
        store.dismissAlert(connection.id, args.alert);
        return { ok: true };
      },

      /** A .sql file into an editor. The system's dialog chooses it; the panel is told its name and its text, never where it is. */
      openScript: async () => {
        const file = await this.pickScript();
        if (!file) return { ok: false, error: 'No file was chosen', cancelled: true };
        const size = fs.statSync(file).size;
        if (size > SCRIPT_FILE_MAX) throw new Error(`${path.basename(file)} is ${Math.round(size / 1024 / 1024)} MB. A file that size is a dump: restore it from the database's menu instead of opening it here.`);
        const text = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
        if (text.includes('\u0000')) throw new Error(`${path.basename(file)} is not text`);
        return { ok: true, name: path.basename(file), text };
      },

      /** What is in an editor, to a file the person chooses. */
      saveScript: async (args) => {
        const text = String(args.text ?? '');
        const suggested = String(args.name || 'query').replace(/[^\w. -]+/g, '_').slice(0, 80);
        const done = await this.saveFile({ title: 'Save script', suggestedName: /\.sql$/i.test(suggested) ? suggested : `${suggested}.sql`, extension: 'sql', build: async () => (text.endsWith('\n') ? text : `${text}\n`) });
        return done ? { ok: true, name: done.name } : { ok: false, error: 'Nothing was saved', cancelled: true };
      },

      role: (args) => this.#role(args),
      importPreview: (args) => this.#importPreview(args),
      importRun: (args) => this.#importRun(args),
      shellCommand: (args) => this.#shellCommand(args),

      backup: (args) => this.#backup(args),
      restore: (args) => this.#restore(args),

      brief: (args) => this.#brief(args),
    };
  }

  /** The schema a call is about. In MySQL that is the database itself; in SQLite there is none. */
  #schema(connection, args) {
    if (connection.engine === 'sqlite') return null;
    if (connection.engine === 'mysql') return String(args.database || args.schema || connection.database || '');
    return String(args.schema || 'public');
  }

  /**
   * Run what was typed: every statement in turn, on the tab's own connection,
   * stopping at the first that fails.
   *
   * A read-only connection sends nothing that is not plainly a read. The
   * server is told the same thing when the connection opens, so this is the
   * first of two refusals and the one with the clearer sentence.
   */
  async #query(args) {
    const connection = this.#connection(args.id);
    const text = String(args.sql ?? '');
    if (text.length > SCRIPT_MAX) throw new Error('That script is too long to run from here');
    const statements = sql.scan(text, connection.engine);
    if (!statements.length) throw new Error('There is nothing to run');
    if (statements.length > STATEMENTS_MAX) throw new Error(`That is ${statements.length} statements; this runs up to ${STATEMENTS_MAX} at a time`);
    const kinds = statements.map((statement) => sql.classify(statement.bare));
    if (connection.readOnly) {
      const refused = kinds.find((one) => one.kind !== 'read');
      if (refused) throw new Error(`This connection is read-only, so ${refused.verb || 'that'} was not sent`);
    }
    const asked = Math.floor(Number(args.maxRows));
    const maxRows = Number.isFinite(asked) && asked > 0 ? Math.min(asked, QUERY_ROWS_MAX) : QUERY_ROWS_DEFAULT;
    const entry = await this.#entry(args.id, args.database, `q:${String(args.tab ?? 'default')}`);
    const started = Date.now();

    return this.#locked(entry, async (session) => {
      const results = [];
      let failed = null;
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        const began = Date.now();
        try {
          const result = await session.run(statement.text, [], { maxRows });
          // `at` is where the statement sits in what was sent, so the panel can find the whole of it again (to export it).
          results.push({ ...result, statement: statement.text.slice(0, 400), at: [statement.start, statement.end], kind: kinds[index].kind, verb: kinds[index].verb, ms: Date.now() - began });
          // A plan that was just looked at is what a Claude session is handed when it is asked about: remembered here, never sent by a panel.
          if (/^EXPLAIN\b/i.test(statement.bare)) {
            this.plans.set(connection.id, {
              database: String(args.database ?? ''),
              sql: statement.text.replace(/^\s*EXPLAIN\s*((\([^)]*\)|ANALYZE\b|VERBOSE\b|FORMAT\s*=\s*\w+)\s*)*/i, '').slice(0, 8000),
              analyzed: /^EXPLAIN\s*(\([^)]*\bANALYZE\b[^)]*\)|ANALYZE\b)/i.test(statement.bare),
              plan: result.rows.map((row) => row[0]).join('\n').slice(0, 30_000),
              at: Date.now(),
            });
          }
        } catch (error) {
          const words = this.#words(error, args.id);
          // Where in the whole script, not where in the one statement: that is the number the editor shows.
          const before = text.slice(0, statement.start);
          const lead = text.slice(statement.start).length - text.slice(statement.start).trimStart().length;
          const within = words.position ? statement.text.slice(0, Math.max(0, words.position - 1)) : '';
          const line = before.split('\n').length + text.slice(statement.start, statement.start + lead).split('\n').length - 1 + within.split('\n').length - 1;
          failed = { ...words, line, statement: statement.text.slice(0, 400), index, ms: Date.now() - began };
          results.push({ error: failed, statement: failed.statement, kind: kinds[index].kind, verb: kinds[index].verb, ms: failed.ms });
          break;
        }
      }
      const ms = Date.now() - started;
      if (failed) this.failures.set(connection.id, { database: String(args.database ?? ''), sql: statements[failed.index].text.slice(0, 8000), error: failed, at: Date.now() });
      else this.failures.delete(connection.id);
      const last = results[results.length - 1];
      this.store.remember({
        connection: connection.id,
        database: args.database,
        sql: text,
        ms,
        ok: !failed,
        note: failed ? failed.error.slice(0, 200) : last?.columns?.length ? `${last.rowCount ?? `${last.rows.length}+`} row(s)` : `${last?.rowCount ?? 0} affected`,
      });
      return {
        ok: true,
        results,
        ms,
        ran: results.length,
        of: statements.length,
        txn: session.txn,
        // Something a tree shows may have changed.
        changed: results.some((one) => !one.error && one.kind === 'ddl'),
      };
    });
  }

  /**
   * Make, change or drop a role. Written here rather than by the panel because
   * of the one thing in it that must not travel: the password is in what is
   * sent to the server and nowhere else — not in the preview, not in the
   * history, not in an error.
   */
  async #role(args) {
    const connection = this.#connection(args.id);
    if (connection.engine === 'sqlite') throw new Error('A SQLite file has no roles');
    const statements = sql.roleStatements(connection.engine, String(args.action ?? ''), args.role);
    const shown = statements.map((one) => `${one.shown};`).join('\n');
    if (args.preview === true) return { ok: true, sql: shown };
    if (connection.readOnly) throw new Error('This connection is read-only');
    if (!statements.length) return { ok: true, statements: 0 };
    const catalog = drivers.catalog(connection.engine);
    const password = typeof args.role?.password === 'string' ? args.role.password : '';
    const started = Date.now();
    return this.#browse(args.id, args.database, async (session) => {
      // PostgreSQL can take back a role half made; MySQL cannot, and says so by not pretending.
      const transactional = connection.engine === 'postgres' && statements.length > 1;
      if (transactional) await session.all(catalog.begin(false));
      try {
        for (const statement of statements) await session.run(statement.sql, [], { maxRows: 1 });
        if (transactional) await session.all('COMMIT');
      } catch (error) {
        if (transactional) await session.all('ROLLBACK').catch(() => {});
        const words = this.#words(error, args.id);
        let message = words.error + (words.detail ? ` — ${words.detail}` : '');
        if (password.length >= 3) message = message.split(password).join('••••••');
        this.store.remember({ connection: connection.id, database: args.database, sql: shown, ms: Date.now() - started, ok: false, note: message.slice(0, 200) });
        throw new Error(message);
      }
      this.store.remember({ connection: connection.id, database: args.database, sql: shown, ms: Date.now() - started, ok: true, note: `${statements.length} statement(s)` });
      return { ok: true, statements: statements.length };
    });
  }

  /**
   * The first rows of a file somebody chose, and the table they are going into.
   * Nothing is imported yet: this is what the mapping is decided from.
   */
  async #importPreview(args) {
    const connection = this.#connection(args.id);
    if (connection.readOnly) throw new Error('This connection is read-only');
    const schema = this.#schema(connection, args);
    const name = String(args.name ?? '');
    const table = await this.#browse(args.id, args.database, (session) => drivers.catalog(connection.engine).table(session, schema, name));
    if (table.kind !== 'table') throw new Error(`Rows are imported into a table, and ${name} is a ${table.kind}`);
    const file = await this.pickCsv();
    if (!file) return { ok: false, error: 'No file was chosen', cancelled: true };
    const size = fs.statSync(file).size;
    const buffer = Buffer.alloc(Math.min(size, IMPORT_PEEK));
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
    const head = buffer.toString('utf8');
    const delimiter = ['comma', 'semicolon', 'tab', 'pipe'].includes(args.delimiter)
      ? { comma: ',', semicolon: ';', tab: '\t', pipe: '|' }[args.delimiter]
      : sql.sniffDelimiter(head);
    const reader = sql.csvReader(delimiter);
    const rows = reader.feed(head);
    // The whole file was read: its last line is a row too. Otherwise it may be half of one.
    if (size <= IMPORT_PEEK) rows.push(...reader.end());
    const token = crypto.randomUUID();
    this.imports.set(token, { file, delimiter, id: connection.id, database: String(args.database ?? ''), schema, name });
    while (this.imports.size > 8) this.imports.delete(this.imports.keys().next().value);
    return {
      ok: true,
      token,
      file: path.basename(file),
      size,
      delimiter: { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[delimiter],
      sample: rows.slice(0, 6).map((row) => row.map((field) => sql.csvValue(field, false)).map((value) => (value === null ? '' : String(value).slice(0, 200)))),
      columns: table.columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable, filled: column.default !== null && column.default !== undefined || Boolean(column.extra) })),
    };
  }

  /**
   * The file, into the table: read a piece at a time, sent in batches, inside
   * one transaction — so a file with a bad row on line forty thousand leaves
   * the table exactly as it was.
   */
  async #importRun(args) {
    const job = this.imports.get(String(args.token ?? ''));
    if (!job || job.id !== String(args.id ?? '')) throw new Error('That file is not waiting to be imported any more; choose it again');
    const connection = this.#connection(job.id);
    if (connection.readOnly) throw new Error('This connection is read-only');
    const mapping = (Array.isArray(args.mapping) ? args.mapping : [])
      .map((one) => ({ from: Number(one?.from), to: String(one?.to ?? '') }))
      .filter((one) => Number.isInteger(one.from) && one.from >= 0 && one.to);
    if (!mapping.length) throw new Error('No column was chosen to import into');
    if (new Set(mapping.map((one) => one.to)).size !== mapping.length) throw new Error('Two columns of the file are going into the same column of the table');
    const catalog = drivers.catalog(connection.engine);
    const entry = await this.#entry(job.id, job.database, 'import');
    const started = Date.now();
    const columns = mapping.map((one) => one.to);
    const size = sql.batchSize(columns.length);
    const emptyAsNull = args.emptyAsNull !== false;
    let count = 0;
    return this.#locked(entry, async (session) => {
      const table = await catalog.table(session, job.schema, job.name);
      const known = new Set(table.columns.map((column) => column.name));
      for (const column of columns) if (!known.has(column)) throw new Error(`${job.name} has no column "${column}"`);
      const reader = sql.csvReader(job.delimiter);
      let skip = args.header !== false;
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const statement = sql.insertBatch({ engine: connection.engine, schema: job.schema, table: job.name, columns, rows: batch });
        await session.run(statement.sql, statement.params, { maxRows: 1 });
        count += batch.length;
        batch = [];
      };
      const take = async (rows) => {
        for (const row of rows) {
          if (skip) { skip = false; continue; }
          batch.push(mapping.map((one) => sql.csvValue(row[one.from], emptyAsNull)));
          if (count + batch.length > IMPORT_ROWS_MAX) throw new Error(`That file has more than ${IMPORT_ROWS_MAX} rows`);
          if (batch.length >= size) await flush();
        }
      };
      await session.all(catalog.begin(false));
      try {
        for await (const chunk of fs.createReadStream(job.file, { encoding: 'utf8', highWaterMark: 1 << 20 })) await take(reader.feed(chunk));
        await take(reader.end());
        await flush();
        await session.all('COMMIT');
      } catch (error) {
        await session.all('ROLLBACK').catch(() => {});
        const words = this.#words(error, job.id);
        // Which rows were being sent when it failed: the file's own numbering, header included.
        const first = count + (args.header !== false ? 2 : 1);
        throw new Error(`${words.error}${words.detail ? ` — ${words.detail}` : ''}\n\nIt failed in rows ${first}–${first + Math.max(0, batch.length - 1)} of the file. Nothing was imported.`);
      }
      this.imports.delete(String(args.token));
      this.store.remember({ connection: connection.id, database: job.database, sql: `-- imported ${count} row(s) into ${job.name} from ${path.basename(job.file)}`, ms: Date.now() - started, ok: true, note: `${count} row(s)` });
      return { ok: true, rows: count, ms: Date.now() - started };
    });
  }

  /**
   * The command line that puts a person in the database's own client, already
   * connected. Written here from named parts — the panel says which connection,
   * and writes none of it.
   *
   * A password cannot go on a command line, where it would sit in the terminal
   * and in the shell's history. It goes in a file only this user can read, which
   * the client is pointed at, and which is gone a minute later.
   */
  async #shellCommand(args) {
    const connection = this.#connection(args.id);
    const config = await this.#reach(args.id, args.database);
    // A terminal is somebody's to close: its tunnel stays until the connection is disconnected or the app quits.
    if (config.tlsHost !== undefined) this.tunnels.hold(String(args.id));
    const secret = (text) => {
      const file = path.join(this.scratch, `st-db-${crypto.randomUUID()}`);
      fs.mkdirSync(this.scratch, { recursive: true });
      fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
      this.shellSecrets.add(file);
      const timer = setTimeout(() => { fs.rmSync(file, { force: true }); this.shellSecrets.delete(file); }, SHELL_SECRET_MS);
      timer.unref?.();
      return file;
    };
    if (connection.engine === 'sqlite') {
      const tool = this.#tool('sqlite3', 'a SQLite shell');
      return { ok: true, title: `sqlite ${connection.name}`, command: `${shellWord(tool, 'The tool')}${connection.readOnly ? ' -readonly' : ''} ${shellWord(config.file, 'The file')}` };
    }
    const host = config.host || 'localhost';
    if (connection.engine === 'postgres') {
      const tool = this.#tool('psql', 'a psql shell');
      const port = String(config.port || 5432);
      const parts = [];
      if (config.password) {
        const escaped = (value) => String(value).replace(/[\\:]/g, '\\$&');
        parts.push(`PGPASSFILE=${shellWord(secret(`${escaped(host)}:${port}:*:${escaped(config.user || '*')}:${escaped(config.password)}\n`), 'The password file')}`);
      }
      if (config.ssl !== 'off') parts.push(`PGSSLMODE=${config.ssl === 'verify' ? 'verify-full' : 'require'}`);
      if (connection.readOnly) parts.push("PGOPTIONS='-c default_transaction_read_only=on'");
      parts.push(shellWord(tool, 'The tool'), '-h', shellWord(host, 'The host'), '-p', port);
      if (config.user) parts.push('-U', shellWord(config.user, 'The user'));
      parts.push('-d', shellWord(config.database || 'postgres', 'The database'));
      return { ok: true, title: `psql ${config.database || connection.name}`, command: parts.join(' ') };
    }
    const tool = this.#tool('mysql', 'a mysql shell');
    const parts = [shellWord(tool, 'The tool')];
    // Has to be the first option, or the client ignores it.
    if (config.password) parts.push(`--defaults-extra-file=${shellWord(secret(`[client]\npassword="${String(config.password).replace(/[\\"]/g, '\\$&')}"\n`), 'The password file')}`);
    parts.push('-h', shellWord(host, 'The host'), '-P', String(config.port || 3306));
    if (config.user) parts.push('-u', shellWord(config.user, 'The user'));
    if (connection.readOnly) parts.push("--init-command='SET SESSION TRANSACTION READ ONLY'");
    const database = String(args.database || config.database || '');
    if (database) parts.push(shellWord(database, 'The database'));
    return { ok: true, title: `mysql ${database || connection.name}`, command: parts.join(' ') };
  }

  #toolEnv(config) {
    if (config.engine === 'mysql') return { MYSQL_PWD: config.password || '' };
    return {
      PGPASSWORD: config.password || '',
      PGSSLMODE: config.ssl === 'verify' ? 'verify-full' : config.ssl === 'on' ? 'require' : 'prefer',
      PGCONNECT_TIMEOUT: '10',
    };
  }

  #tool(name, what) {
    const found = this.findTool(name);
    if (!found) throw new Error(`${name} is not installed on this computer, and ${what} is done with it. Install the database's client tools and try again.`);
    return found;
  }

  /**
   * A backup, made by the database's own tool — pg_dump, mysqldump — because a
   * backup is only worth having if the tool that restores it wrote it. SQLite
   * is a file, and its backup is a copy made by SQLite itself.
   *
   * The place is asked for first; cancelling the dialog runs nothing.
   */
  async #backup(args) {
    const connection = this.#connection(args.id);
    const config = await this.#reach(args.id, args.database);
    const release = this.tunnels.hold(String(args.id));
    try {
      return await this.#backupThrough(args, connection, config);
    } finally {
      release();
    }
  }

  async #backupThrough(args, connection, config) {
    const table = args.name ? String(args.name) : '';
    const schema = this.#schema(connection, args);
    const custom = connection.engine === 'postgres' && args.format === 'custom';
    const extension = connection.engine === 'sqlite' ? 'sqlite' : custom ? 'dump' : 'sql';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const base = `${table || config.database || connection.name}-${stamp}`.replace(/[^\w.-]+/g, '_');
    const tool = connection.engine === 'postgres' ? this.#tool('pg_dump', 'a backup') : connection.engine === 'mysql' ? this.#tool('mysqldump', 'a backup') : null;
    const target = await this.pickSavePath({ suggestedName: `${base}.${extension}`, extension });
    if (!target) return { ok: false, error: 'Nothing was backed up', cancelled: true };
    const started = Date.now();
    if (connection.engine === 'sqlite') {
      try { fs.rmSync(target, { force: true }); } catch { /* VACUUM INTO refuses a file that exists */ }
      await this.#browse(args.id, args.database, (session) => session.run(`VACUUM INTO ${sql.literal(target)}`));
    } else if (connection.engine === 'postgres') {
      const flags = ['-h', config.host || 'localhost', '-p', String(config.port || 5432), '-d', config.database || 'postgres', '-F', custom ? 'c' : 'p', '-f', target, '--no-password'];
      if (config.user) flags.push('-U', config.user);
      if (args.schemaOnly === true) flags.push('--schema-only');
      if (table) flags.push('-t', sql.qualified('postgres', schema, table));
      await this.runTool(tool, flags, { env: this.#toolEnv(config) });
    } else {
      const flags = ['-h', config.host || 'localhost', '-P', String(config.port || 3306), `--result-file=${target}`, '--single-transaction', '--routines'];
      if (config.user) flags.push('-u', config.user);
      if (args.schemaOnly === true) flags.push('--no-data');
      flags.push(String(args.database || config.database || ''));
      if (table) flags.push(table);
      await this.runTool(tool, flags, { env: this.#toolEnv(config) });
    }
    let size = null;
    try { size = fs.statSync(target).size; } catch { /* it was written a moment ago */ }
    return { ok: true, file: path.basename(target), size, ms: Date.now() - started };
  }

  /**
   * A backup put back. What the file says is created; what it replaces is
   * replaced — which is why the app asks first, and why a read-only connection
   * does not restore at all.
   */
  async #restore(args) {
    const connection = this.#connection(args.id);
    if (connection.readOnly) throw new Error('This connection is read-only');
    if (connection.engine === 'sqlite') throw new Error('A SQLite database is a file: to restore one, put the file back.');
    const config = await this.#reach(args.id, args.database);
    const release = this.tunnels.hold(String(args.id));
    try {
      return await this.#restoreThrough(args, connection, config);
    } finally {
      release();
    }
  }

  async #restoreThrough(args, connection, config) {
    const plainTool = connection.engine === 'postgres' ? this.#tool('psql', 'restoring a .sql file') : this.#tool('mysql', 'a restore');
    const source = await this.pickBackup();
    if (!source) return { ok: false, error: 'Nothing was restored', cancelled: true };
    const started = Date.now();
    let notes = '';
    if (connection.engine === 'postgres') {
      const common = ['-h', config.host || 'localhost', '-p', String(config.port || 5432), '-d', config.database || 'postgres', '--no-password'];
      if (config.user) common.push('-U', config.user);
      // pg_dump's own formats begin with "PGDMP"; anything else is SQL for psql.
      const head = Buffer.alloc(5);
      const fd = fs.openSync(source, 'r');
      try { fs.readSync(fd, head, 0, 5, 0); } finally { fs.closeSync(fd); }
      if (head.toString('latin1') === 'PGDMP') {
        notes = await this.runTool(this.#tool('pg_restore', 'restoring this file'), [...common, '--no-owner', '--exit-on-error', source], { env: this.#toolEnv(config) });
      } else {
        notes = await this.runTool(plainTool, [...common, '-v', 'ON_ERROR_STOP=1', '-q', '-f', source], { env: this.#toolEnv(config) });
      }
    } else {
      const flags = ['-h', config.host || 'localhost', '-P', String(config.port || 3306)];
      if (config.user) flags.push('-u', config.user);
      flags.push(String(args.database || config.database || ''));
      notes = await this.runTool(plainTool, flags, { env: this.#toolEnv(config), input: fs.createReadStream(source) });
    }
    return { ok: true, file: path.basename(source), ms: Date.now() - started, notes: notes.slice(-600) };
  }

  /**
   * What a Claude session is handed about a table, or about the statement that
   * just failed. Gathered and worded here: the panel says which, and writes none of it.
   */
  async #brief(args) {
    const connection = this.#connection(args.id);
    const engine = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' }[connection.engine];
    const where = `the ${engine} connection "${connection.name}"${args.database ? `, database ${args.database}` : ''}`;
    if (args.failed) {
      const failure = this.failures.get(connection.id);
      if (!failure) throw new Error('Nothing has failed on this connection');
      const lines = [
        `A statement I ran from Smart Terminal's Databases panel failed on ${where}.`,
        '',
        '```sql',
        failure.sql,
        '```',
        '',
        `The server said: ${failure.error.error}`,
      ];
      if (failure.error.detail) lines.push(`Detail: ${failure.error.detail}`);
      if (failure.error.hint) lines.push(`Hint: ${failure.error.hint}`);
      lines.push('', 'Explain what is wrong with it and write the statement the way it should be. Do not run anything against the database yourself.');
      return { ok: true, title: 'failed query', text: lines.join('\n') };
    }
    if (args.explained || args.qid) return this.#statementBrief(connection, args, where);
    const schema = this.#schema(connection, args);
    const name = String(args.name ?? '');
    const table = await this.#browse(args.id, args.database, (session) => drivers.catalog(connection.engine).table(session, schema, name));
    const lines = [
      `I am looking at ${table.kind === 'view' ? 'the view' : 'the table'} ${schema ? `${schema}.` : ''}${name} on ${where}, in Smart Terminal's Databases panel.`,
      '',
      '```sql',
      String(table.ddl ?? '').slice(0, 12_000),
      '```',
    ];
    if (table.stats.rows !== null) lines.push('', `It holds about ${table.stats.rows} rows.`);
    if (table.referencedBy.length) {
      lines.push('', 'Referenced by:', ...table.referencedBy.slice(0, 30).map((one) => `- ${one.schema ? `${one.schema}.` : ''}${one.table} (${one.name})`));
    }
    lines.push('', 'Tell me what this is for as far as its definition shows, and anything about its design worth a second look — missing indexes on foreign keys, types that do not fit, constraints that are absent. Do not run anything against the database yourself.');
    return { ok: true, title: name, text: lines.join('\n') };
  }

  /**
   * A statement that is slow, with what somebody would need to say why: the
   * statement, what it has cost, its plan, and the tables it reads with their
   * indexes. The statement is one the app already knows — the plan last asked
   * for on this connection, or one the server keeps counters for, named by its
   * id — so what a session is handed was never written by a panel.
   */
  async #statementBrief(connection, args, where) {
    const engine = connection.engine;
    const read = (work) => this.#browse(args.id, args.database, (session) => this.#reading(session, () => work(session)));
    let text = '';
    let plan = '';
    let analyzed = false;
    const facts = [];
    if (args.explained) {
      const kept = this.plans.get(connection.id);
      if (!kept) throw new Error('No plan has been asked for on this connection');
      ({ sql: text, plan, analyzed } = kept);
    } else {
      const qid = String(args.qid ?? '');
      const found = await read((session) => drivers.catalog(engine).statement?.(session, qid)).catch(() => null);
      text = found?.text ?? this.store.statementText(connection.id, qid) ?? '';
      if (!text) throw new Error('The server no longer remembers that statement');
      if (found) {
        facts.push(`The server has run it ${found.calls} times for ${Math.round(found.ms)} ms in total: ${found.calls > 0 ? (found.ms / found.calls).toFixed(2) : '?'} ms a call, ${found.calls > 0 ? Math.round(found.rows / found.calls) : '?'} rows a call.`);
        if (found.more) facts.push(found.more);
      }
      const trend = watch.statementTrends(this.store.statementReadings(connection.id, this.now() - 7 * 86_400_000), new Map(), this.now() - 7 * 86_400_000, this.now()).find((one) => one.qid === qid);
      if (trend?.change) facts.push(`Over the readings this app has kept, it went from ${trend.meanBefore.toFixed(2)} ms a call to ${trend.meanNow.toFixed(2)} ms.`);
      // Its placeholders stand for values the server did not keep, so the plan asked for is the one for any value.
      plan = await read((session) => drivers.catalog(engine).genericPlan?.(session, text)).catch(() => '') ?? '';
    }
    const lines = [`This statement is slow on ${where}, and I am looking at it in Smart Terminal's Databases panel.`, '', '```sql', text.slice(0, 8000), '```'];
    if (facts.length) lines.push('', ...facts);
    if (plan) lines.push('', analyzed ? 'Its plan, as it actually ran:' : 'Its plan, as the planner estimates it (not run):', '', '```', String(plan).slice(0, 20_000), '```');
    const schema = this.#schema(connection, args);
    for (const one of sql.tablesIn(text).slice(0, 4)) {
      const table = await this.#browse(args.id, args.database, (session) => drivers.catalog(engine).table(session, engine === 'postgres' ? (one.schema ?? schema) : schema, one.name)).catch(() => null);
      if (!table?.ddl) continue;
      lines.push('', `The table ${one.name}${table.stats?.rows !== null && table.stats?.rows !== undefined ? `, about ${table.stats.rows} rows` : ''}:`, '', '```sql', String(table.ddl).slice(0, 5000), '```');
    }
    lines.push('', 'Say why it is slow and what would make it faster — an index, a rewrite, a setting — with the statement for each, and what each would cost. Do not run anything against the database yourself.');
    return { ok: true, title: 'slow statement', text: lines.join('\n') };
  }
}

module.exports = { RdbService, QUERY_ROWS_MAX, MAX_SESSIONS };
