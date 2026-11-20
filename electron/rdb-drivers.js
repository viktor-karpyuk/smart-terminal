'use strict';

const fs = require('node:fs');
const { quoteIdent, qualified } = require('./rdb-sql');

/**
 * The Databases extension: the three engines, each behind the same few calls.
 *
 * A session is one live connection. `run` is what a person asked for — one
 * statement, an answer capped at a number of rows, every value as text or
 * NULL. `all` is what the app asks on its own behalf to draw the tree. And a
 * catalog is the set of questions that tree is made of, asked the way each
 * engine wants them asked and answered in one shape.
 *
 * Text, because a query tool shows what the server said: a `numeric` that
 * became a JavaScript number has already lost digits, and a timestamp that
 * became a Date has been moved to this computer's time zone.
 *
 * The drivers are required when a connection is opened, not when the app
 * starts, so a machine that never opens a PostgreSQL never loads its client.
 */

const CONNECT_TIMEOUT = 10_000;
/** One cell, as far as a grid shows it. Past this it is cut, and marked so it is not edited by accident. */
const CELL_MAX = 100_000;
const BINARY_SHOWN = 4096;

/** Something a server sent, as the text a cell shows. Returns [text, wasCut]. */
function cell(value) {
  if (value === null || value === undefined) return [null, false];
  if (typeof value === 'string') return value.length > CELL_MAX ? [value.slice(0, CELL_MAX), true] : [value, false];
  if (value instanceof Uint8Array) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    // Text that happens to be stored as bytes reads as text; anything else is shown as what it is.
    const text = buffer.toString('utf8');
    // eslint-disable-next-line no-control-regex
    if (!text.includes('�') && !/[\u0000-\u0008\u000e-\u001f]/.test(text)) return cell(text);
    const cut = buffer.length > BINARY_SHOWN;
    return [`\\x${buffer.subarray(0, BINARY_SHOWN).toString('hex')}`, cut || true];
  }
  if (value instanceof Date) return [Number.isNaN(value.getTime()) ? 'Invalid date' : value.toISOString(), false];
  if (typeof value === 'object') {
    try { return cell(JSON.stringify(value)); } catch { return [String(value), false]; }
  }
  return [String(value), false];
}

/** Rows of anything, as rows of text — and which cells were cut on the way. */
function grid(columns, rawRows, { maxRows, rowCount = null, command = '' } = {}) {
  const truncated = Number.isFinite(maxRows) && rawRows.length > maxRows;
  const kept = truncated ? rawRows.slice(0, maxRows) : rawRows;
  const clipped = [];
  const rows = kept.map((row, r) => row.map((value, c) => {
    const [text, cut] = cell(value);
    if (cut) clipped.push(`${r}:${c}`);
    return text;
  }));
  return { columns, rows, rowCount: rowCount ?? rows.length, command, truncated, clipped };
}

function yes(value) {
  return value === true || value === 't' || value === 'true' || value === 1 || value === '1' || value === 'YES';
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function list(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * An error, as something a person can act on.
 *
 * A server's own message is kept whole — it names the column, the relation,
 * the line — and its detail and hint travel with it. What is rewritten is the
 * network's vocabulary, which says ECONNREFUSED where it means "nothing is
 * listening there".
 */
class RdbError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'RdbError';
    Object.assign(this, extra);
  }
}

function explain(error, config = {}) {
  if (error instanceof RdbError) return error;
  const where = config.engine === 'sqlite' ? String(config.file ?? '') : `${config.host || 'localhost'}:${config.port || ''}`;
  const code = String(error?.code ?? '');
  const message = String(error?.sqlMessage ?? error?.message ?? error ?? 'It did not say why');
  if (code === 'ECONNREFUSED') return new RdbError(`Nothing is listening at ${where}. Is the server running, and is that the port?`, { code });
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new RdbError(`The host "${config.host}" could not be found.`, { code });
  if (code === 'ETIMEDOUT' || /timeout/i.test(message) && !error?.severity) return new RdbError(`${where} did not answer in time. A firewall or a VPN that is off does this.`, { code: code || 'ETIMEDOUT' });
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'PROTOCOL_CONNECTION_LOST') return new RdbError(`The connection to ${where} was closed by the other side.`, { code });
  if (/does not support SSL|SSL connection is required|no pg_hba.conf entry.*(SSL|encryption)/i.test(message)) {
    return new RdbError(`${message}. Change the SSL setting of this connection.`, { code });
  }
  if (/self.signed certificate|unable to verify the first certificate|certificate has expired/i.test(message)) {
    return new RdbError(`The server's certificate could not be verified (${message}). Use "SSL, without verifying" if this server is one you trust.`, { code });
  }
  const extra = { code };
  if (error?.detail) extra.detail = String(error.detail);
  if (error?.hint) extra.hint = String(error.hint);
  if (error?.position) extra.position = Number(error.position);
  return new RdbError(message.replace(/^SQLITE_ERROR: /, ''), extra);
}

function sslOf(config) {
  if (config.ssl === 'verify') return { rejectUnauthorized: true };
  if (config.ssl === 'on') return { rejectUnauthorized: false };
  return undefined;
}

// ───────────────────────────────────────────────────────────── PostgreSQL ──

/** Every value as the text the server sent. */
const PG_TEXT = { getTypeParser: () => (value) => value };

class PgSession {
  constructor(config, client) {
    this.engine = 'postgres';
    this.config = config;
    this.client = client;
    this.closed = false;
    this.txn = 'idle';
    this.notices = [];
    this.typeNames = new Map();
    this.line = Promise.resolve();
    client.on('notice', (notice) => {
      if (this.notices.length < 200) this.notices.push(String(notice?.message ?? '').slice(0, 2000));
    });
    // Without a listener an idle connection dropping would be an uncaught exception.
    client.on('error', () => { this.closed = true; });
    client.on('end', () => { this.closed = true; });
    client.connection?.on('readyForQuery', (message) => {
      this.txn = message?.status === 'T' ? 'open' : message?.status === 'E' ? 'failed' : 'idle';
    });
  }

  static async open(config) {
    const { Client } = require('pg');
    const client = new Client({
      host: config.host || 'localhost',
      port: Number(config.port) || 5432,
      user: config.user || undefined,
      password: config.password || undefined,
      database: config.database || 'postgres',
      ssl: sslOf(config),
      connectionTimeoutMillis: CONNECT_TIMEOUT,
      application_name: 'Smart Terminal',
      keepAlive: true,
      types: PG_TEXT,
    });
    try {
      await client.connect();
    } catch (error) {
      try { await client.end(); } catch { /* it never opened */ }
      throw explain(error, config);
    }
    const session = new PgSession(config, client);
    // The server's own refusal, under whatever is typed. The service refuses first; this is for what it misread.
    if (config.readOnly) await session.all('SET default_transaction_read_only = on');
    return session;
  }

  /** One at a time: the catalog asks several things together, and this client wants them in a line. */
  all(sql, params = []) {
    const run = this.line.then(() => this.client.query({ text: sql, values: params, types: PG_TEXT }));
    this.line = run.then(() => {}, () => {});
    return run.then((result) => result.rows, (error) => { throw explain(error, this.config); });
  }

  async #types(oids) {
    const missing = [...new Set(oids)].filter((oid) => !this.typeNames.has(oid));
    if (missing.length) {
      try {
        const found = await this.client.query({
          text: 'SELECT oid, pg_catalog.format_type(oid, NULL) AS name FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])',
          values: [missing],
          types: PG_TEXT,
        });
        for (const row of found.rows) this.typeNames.set(Number(row.oid), row.name);
      } catch {
        // In a failed transaction nothing can be asked; the columns go without their types.
      }
    }
    return oids.map((oid) => this.typeNames.get(oid) ?? '');
  }

  /**
   * One statement, read through a cursor: the server is asked for one row more
   * than will be shown and then told to stop, so `SELECT * FROM` a table of
   * forty million rows costs what a page of it costs.
   */
  async run(sql, params = [], { maxRows = 1000 } = {}) {
    const Cursor = require('pg-cursor');
    this.notices = [];
    const cursor = this.client.query(new Cursor(sql, params, { rowMode: 'array', types: PG_TEXT }));
    const read = await new Promise((resolve, reject) => {
      cursor.read(maxRows + 1, (error, rows, result) => (error ? reject(explain(error, this.config)) : resolve({ rows, result })));
    });
    await cursor.close();
    const fields = read.result?.fields ?? [];
    const names = await this.#types(fields.map((field) => field.dataTypeID));
    const columns = fields.map((field, index) => ({ name: field.name, type: names[index] }));
    const truncated = read.rows.length > maxRows;
    const out = grid(columns, read.rows, {
      maxRows,
      // A cursor that was stopped early was never told how many there were.
      rowCount: truncated ? null : (read.result?.rowCount ?? read.rows.length),
      command: String(read.result?.command ?? ''),
    });
    if (truncated) out.rowCount = null;
    out.notices = this.notices;
    return out;
  }

  /** Ask the server to stop what this session is doing, from a second connection: this one is busy. */
  async cancel() {
    const pid = this.client.processID;
    if (!pid) return false;
    const other = await PgSession.open({ ...this.config, readOnly: false });
    try {
      await other.all('SELECT pg_cancel_backend($1)', [pid]);
      return true;
    } finally {
      await other.close();
    }
  }

  async close() {
    this.closed = true;
    try { await this.client.end(); } catch { /* already gone */ }
  }
}

const PG_KINDS = { r: 'table', p: 'table', v: 'view', m: 'matview', f: 'foreign', S: 'sequence' };
const PG_CONSTRAINTS = { p: 'PRIMARY KEY', u: 'UNIQUE', f: 'FOREIGN KEY', c: 'CHECK', x: 'EXCLUDE', t: 'TRIGGER' };
const PG_ROUTINES = { f: 'function', p: 'procedure', a: 'aggregate', w: 'window' };

/** The oid of a relation named by its schema and its name, as a subquery taking $1 and $2. */
const PG_REL = '(SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2)';

/**
 * The questions behind the pages that are only ever read: a table's statistics,
 * what depends on it, who may touch it, what the server is holding locked, how
 * it is configured. Each is a list of sections, and each section one SELECT —
 * so a page is whatever the server answers, with nothing here to keep in step
 * with it.
 */
const PG_REPORTS = {
  tableStats: ({ schema, name }) => [
    {
      title: 'Activity',
      vertical: true,
      note: 'Counted since the statistics were last reset.',
      sql: `SELECT seq_scan AS "sequential scans", seq_tup_read AS "rows read by them", idx_scan AS "index scans",
                   idx_tup_fetch AS "rows fetched by them", n_tup_ins AS inserted, n_tup_upd AS updated, n_tup_del AS deleted,
                   n_tup_hot_upd AS "HOT updates", n_live_tup AS "live rows", n_dead_tup AS "dead rows",
                   date_trunc('second', last_vacuum)::text AS "last vacuum", date_trunc('second', last_autovacuum)::text AS "last autovacuum",
                   date_trunc('second', last_analyze)::text AS "last analyze", date_trunc('second', last_autoanalyze)::text AS "last autoanalyze"
              FROM pg_catalog.pg_stat_all_tables WHERE relid = ${PG_REL}`,
      params: [schema, name],
    },
    {
      title: 'Cache',
      vertical: true,
      sql: `SELECT heap_blks_read AS "table blocks read from disk", heap_blks_hit AS "found in cache",
                   round(100.0 * heap_blks_hit / nullif(heap_blks_hit + heap_blks_read, 0), 1) AS "table hit %",
                   idx_blks_read AS "index blocks read from disk", idx_blks_hit AS "index blocks in cache",
                   round(100.0 * idx_blks_hit / nullif(idx_blks_hit + idx_blks_read, 0), 1) AS "index hit %"
              FROM pg_catalog.pg_statio_all_tables WHERE relid = ${PG_REL}`,
      params: [schema, name],
    },
    {
      title: 'Index usage',
      note: 'An index with no scans is one the planner has not chosen since the statistics were reset.',
      sql: `SELECT s.indexrelname AS index, s.idx_scan AS scans, s.idx_tup_read AS "entries read", s.idx_tup_fetch AS "rows fetched",
                   pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(s.indexrelid)) AS size,
                   CASE WHEN x.indisprimary THEN 'primary key' WHEN x.indisunique THEN 'unique' ELSE '' END AS kind
              FROM pg_catalog.pg_stat_all_indexes s JOIN pg_catalog.pg_index x ON x.indexrelid = s.indexrelid
             WHERE s.relid = ${PG_REL} ORDER BY s.idx_scan, s.indexrelname`,
      params: [schema, name],
    },
    {
      title: 'Columns, as the planner sees them',
      note: 'From the last ANALYZE.',
      sql: `SELECT attname AS "column", round(null_frac::numeric * 100, 1) AS "null %", n_distinct AS distinct, avg_width AS "avg bytes",
                   round(correlation::numeric, 2) AS correlation, left(most_common_vals::text, 160) AS "most common"
              FROM pg_catalog.pg_stats WHERE schemaname = $1 AND tablename = $2 ORDER BY attname`,
      params: [schema, name],
    },
  ],

  dependencies: ({ schema, name }) => [
    {
      title: 'What depends on this',
      note: 'Dropping this takes these with it, or is refused because of them.',
      sql: `SELECT DISTINCT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) AS object,
                   CASE d.deptype WHEN 'n' THEN 'normal' WHEN 'a' THEN 'auto' WHEN 'i' THEN 'internal' WHEN 'e' THEN 'extension' ELSE d.deptype::text END AS kind
              FROM pg_catalog.pg_depend d
             WHERE d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = ${PG_REL}
               AND NOT (d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = d.refobjid)
             ORDER BY 1 LIMIT 500`,
      params: [schema, name],
    },
    {
      title: 'What this depends on',
      sql: `SELECT DISTINCT pg_catalog.pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) AS object,
                   CASE d.deptype WHEN 'n' THEN 'normal' WHEN 'a' THEN 'auto' WHEN 'i' THEN 'internal' WHEN 'e' THEN 'extension' ELSE d.deptype::text END AS kind
              FROM pg_catalog.pg_depend d
             WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = ${PG_REL}
               AND NOT (d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = d.objid)
             ORDER BY 1 LIMIT 500`,
      params: [schema, name],
    },
  ],

  privileges: ({ schema, name }) => [
    {
      title: 'Who may do what',
      sql: `SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges,
                   bool_or(is_grantable = 'YES') AS "may grant", string_agg(DISTINCT grantor, ', ') AS "granted by"
              FROM information_schema.role_table_grants WHERE table_schema = $1 AND table_name = $2
             GROUP BY grantee ORDER BY grantee`,
      params: [schema, name],
    },
    {
      title: 'Row-level security policies',
      sql: `SELECT policyname AS policy, cmd AS "applies to", array_to_string(roles, ', ') AS roles, permissive, qual AS "using", with_check AS "with check"
              FROM pg_catalog.pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY 1`,
      params: [schema, name],
    },
  ],

  locks: () => [
    {
      title: 'Sessions that are waiting, and who they wait for',
      sql: `SELECT a.pid, a.usename AS "user", a.datname AS database, array_to_string(pg_catalog.pg_blocking_pids(a.pid), ', ') AS "blocked by",
                   date_trunc('second', now() - a.query_start)::text AS waiting, left(a.query, 400) AS query
              FROM pg_catalog.pg_stat_activity a
             WHERE cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0 ORDER BY a.query_start`,
    },
    {
      title: 'Locks held and asked for',
      sql: `SELECT l.pid, a.usename AS "user", l.locktype AS kind,
                   CASE WHEN l.relation IS NOT NULL THEN l.relation::regclass::text ELSE coalesce(l.transactionid::text, l.virtualxid, '') END AS "on",
                   l.mode, l.granted, a.state, left(a.query, 200) AS query
              FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
             WHERE l.pid <> pg_backend_pid() AND (l.database IS NULL OR l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))
             ORDER BY l.granted, l.pid LIMIT 1000`,
    },
  ],

  settings: () => [
    {
      title: 'Configuration',
      filter: true,
      sql: `SELECT name, setting AS value, coalesce(unit, '') AS unit, category, source, pending_restart AS "needs restart", short_desc AS what
              FROM pg_catalog.pg_settings ORDER BY name`,
    },
  ],

  prepared: () => [
    {
      title: 'Prepared transactions',
      note: 'Two-phase transactions waiting for a COMMIT PREPARED. A forgotten one holds its locks and stops vacuum.',
      sql: `SELECT gid, transaction::text AS xid, owner, database, date_trunc('second', prepared)::text AS prepared FROM pg_catalog.pg_prepared_xacts ORDER BY prepared`,
    },
  ],

  tablespaces: () => [
    {
      title: 'Tablespaces',
      sql: `SELECT spcname AS tablespace, pg_catalog.pg_get_userbyid(spcowner) AS owner, pg_catalog.pg_tablespace_location(oid) AS location,
                   pg_catalog.pg_size_pretty(pg_catalog.pg_tablespace_size(oid)) AS size FROM pg_catalog.pg_tablespace ORDER BY 1`,
    },
  ],

  replication: () => [
    {
      title: 'Standbys receiving from this server',
      sql: `SELECT application_name AS standby, client_addr::text AS client, state, sync_state AS sync,
                   pg_catalog.pg_size_pretty(pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), replay_lsn)) AS "replay lag", replay_lag::text AS "lag time"
              FROM pg_catalog.pg_stat_replication ORDER BY 1`,
    },
    {
      title: 'Replication slots',
      sql: `SELECT slot_name AS slot, slot_type AS kind, database, active, pg_catalog.pg_size_pretty(pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), restart_lsn)) AS "WAL kept"
              FROM pg_catalog.pg_replication_slots ORDER BY 1`,
    },
  ],

  extensions: () => [
    {
      title: 'Installed in this database',
      sql: `SELECT e.extname AS extension, e.extversion AS version, n.nspname AS schema, c.description AS what
              FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
              LEFT JOIN pg_catalog.pg_description c ON c.objoid = e.oid AND c.classoid = 'pg_catalog.pg_extension'::regclass ORDER BY 1`,
    },
    {
      title: 'Available to install',
      filter: true,
      sql: `SELECT name AS extension, default_version AS version, comment AS what FROM pg_catalog.pg_available_extensions WHERE installed_version IS NULL ORDER BY 1`,
    },
  ],

  triggers: ({ schema }) => [
    {
      title: 'Triggers',
      open: true,
      sql: `SELECT c.relname AS "table", t.tgname AS trigger, CASE WHEN t.tgenabled = 'D' THEN 'disabled' ELSE 'enabled' END AS state,
                   p.proname AS function, pg_catalog.pg_get_triggerdef(t.oid, true) AS definition
              FROM pg_catalog.pg_trigger t
              JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
             WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1, 2`,
      params: [schema],
    },
  ],

  rules: ({ schema }) => [
    {
      title: 'Rules',
      open: true,
      note: 'A view is a rule called _RETURN; those are left out.',
      sql: `SELECT tablename AS "table", rulename AS rule, definition FROM pg_catalog.pg_rules WHERE schemaname = $1 AND rulename <> '_RETURN' ORDER BY 1, 2`,
      params: [schema],
    },
  ],

  indexes: ({ schema }) => [
    {
      title: 'Indexes, largest first',
      open: true,
      filter: true,
      note: 'An index with no scans is one the planner has not chosen since the statistics were reset.',
      sql: `SELECT t.relname AS "table", i.relname AS index, pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(i.oid)) AS size,
                   coalesce(s.idx_scan, 0) AS scans,
                   CASE WHEN x.indisprimary THEN 'primary key' WHEN x.indisunique THEN 'unique' ELSE '' END AS kind,
                   CASE WHEN x.indisvalid THEN '' ELSE 'INVALID' END AS state, pg_catalog.pg_get_indexdef(i.oid) AS definition
              FROM pg_catalog.pg_index x
              JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
              JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
              LEFT JOIN pg_catalog.pg_stat_all_indexes s ON s.indexrelid = i.oid
             WHERE n.nspname = $1 ORDER BY pg_catalog.pg_relation_size(i.oid) DESC, 1, 2 LIMIT 2000`,
      params: [schema],
    },
  ],

  partitions: ({ schema }) => [
    {
      title: 'Partitioned tables',
      open: true,
      sql: `SELECT c.relname AS "table", pg_catalog.pg_get_partkeydef(c.oid) AS "partitioned by",
                   (SELECT count(*) FROM pg_catalog.pg_inherits i WHERE i.inhparent = c.oid) AS partitions
              FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relkind = 'p' ORDER BY 1`,
      params: [schema],
    },
    {
      title: 'Partitions',
      open: true,
      filter: true,
      sql: `SELECT c.relname AS "table", p.relname AS "partition of", pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS bounds,
                   pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid)) AS size,
                   CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS "rows, about"
              FROM pg_catalog.pg_inherits i
              JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
              JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relispartition ORDER BY 2, 1 LIMIT 2000`,
      params: [schema],
    },
  ],

  policies: ({ schema }) => [
    {
      title: 'Tables with row-level security on',
      open: true,
      sql: `SELECT c.relname AS "table", CASE WHEN c.relforcerowsecurity THEN 'also for its owner' ELSE 'not for its owner' END AS applies
              FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relrowsecurity ORDER BY 1`,
      params: [schema],
    },
    {
      title: 'Policies',
      open: true,
      sql: `SELECT tablename AS "table", policyname AS policy, cmd AS "applies to", array_to_string(roles, ', ') AS roles, permissive,
                   qual AS "using", with_check AS "with check"
              FROM pg_catalog.pg_policies WHERE schemaname = $1 ORDER BY 1, 2`,
      params: [schema],
    },
  ],

  foreign: () => [
    {
      title: 'Foreign data wrappers',
      sql: `SELECT fdwname AS wrapper, pg_catalog.pg_get_userbyid(fdwowner) AS owner, array_to_string(fdwoptions, ', ') AS options
              FROM pg_catalog.pg_foreign_data_wrapper ORDER BY 1`,
    },
    {
      title: 'Foreign servers',
      sql: `SELECT s.srvname AS server, w.fdwname AS wrapper, s.srvtype AS type, s.srvversion AS version, array_to_string(s.srvoptions, ', ') AS options
              FROM pg_catalog.pg_foreign_server s JOIN pg_catalog.pg_foreign_data_wrapper w ON w.oid = s.srvfdw ORDER BY 1`,
    },
    {
      title: 'User mappings',
      // Who is mapped, and nothing of how: a mapping's options are where the remote password is kept.
      note: 'Their options are not shown: that is where a remote password lives.',
      sql: `SELECT srvname AS server, coalesce(usename, 'PUBLIC') AS "user" FROM pg_catalog.pg_user_mappings ORDER BY 1, 2`,
    },
  ],

  publications: () => [
    {
      title: 'Publications',
      sql: `SELECT pubname AS publication, pg_catalog.pg_get_userbyid(pubowner) AS owner, puballtables AS "all tables",
                   pubinsert AS inserts, pubupdate AS updates, pubdelete AS deletes, pubtruncate AS truncates
              FROM pg_catalog.pg_publication ORDER BY 1`,
    },
    {
      title: 'What they publish',
      open: true,
      sql: `SELECT pubname AS publication, schemaname AS schema, tablename AS "table" FROM pg_catalog.pg_publication_tables ORDER BY 1, 2, 3 LIMIT 2000`,
    },
    {
      title: 'Subscriptions',
      note: 'Where each connects to is not shown: a connection string holds a password.',
      sql: `SELECT subname AS subscription, subenabled AS enabled, array_to_string(subpublications, ', ') AS publications, subslotname AS slot
              FROM pg_catalog.pg_subscription WHERE subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) ORDER BY 1`,
    },
  ],

  eventTriggers: () => [
    {
      title: 'Event triggers',
      sql: `SELECT evtname AS trigger, evtevent AS event, evtfoid::regproc::text AS function,
                   CASE evtenabled WHEN 'D' THEN 'disabled' ELSE 'enabled' END AS state, array_to_string(evttags, ', ') AS "only for"
              FROM pg_catalog.pg_event_trigger ORDER BY 1`,
    },
  ],

  languages: () => [
    {
      title: 'Procedural languages',
      sql: `SELECT lanname AS language, lanpltrusted AS trusted, pg_catalog.pg_get_userbyid(lanowner) AS owner FROM pg_catalog.pg_language WHERE lanispl ORDER BY 1`,
    },
    {
      title: 'Casts somebody added',
      sql: `SELECT pg_catalog.format_type(castsource, NULL) AS "from", pg_catalog.format_type(casttarget, NULL) AS "to",
                   CASE castcontext WHEN 'i' THEN 'implicit' WHEN 'a' THEN 'in assignment' ELSE 'explicit' END AS "when",
                   CASE WHEN castfunc = 0 THEN '' ELSE castfunc::regproc::text END AS function
              FROM pg_catalog.pg_cast WHERE oid >= 16384 ORDER BY 1, 2`,
    },
  ],

  types: ({ schema }) => [
    {
      title: 'Types and domains',
      sql: `SELECT t.typname AS name,
                   CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain' WHEN 'c' THEN 'composite' WHEN 'r' THEN 'range' ELSE t.typtype::text END AS kind,
                   CASE t.typtype
                     WHEN 'e' THEN (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid)
                     WHEN 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod)
                     ELSE '' END AS definition
              FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = $1 AND t.typtype IN ('e', 'd', 'r')
                OR n.nspname = $1 AND t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')
             ORDER BY 1`,
      params: [schema],
    },
  ],

  /**
   * Why it is slow, asked of the server itself. Every section is one question a
   * person would otherwise have to know the catalog to ask, and each note says
   * what the answer is good for — a list of numbers nobody can act on is not a
   * diagnosis. Nothing here changes anything; what to do about it is a statement
   * the person writes.
   */
  performance: () => [
    {
      title: 'Statements that cost the most time in total',
      note: 'From pg_stat_statements, since its counters were last reset. A statement is here because it is slow, or because it is run very often — the calls column says which. What reads the catalog, the questions on this page among them, is left out. If this section is an error, the extension is not installed: add pg_stat_statements to shared_preload_libraries, restart, and CREATE EXTENSION pg_stat_statements.',
      open: true,
      sql: `SELECT round(s.total_exec_time::numeric / 1000, 1) AS "total s", s.calls, round(s.mean_exec_time::numeric, 2) AS "mean ms",
                   round(s.max_exec_time::numeric, 1) AS "max ms", s.rows,
                   round((100 * s.total_exec_time / nullif(sum(s.total_exec_time) OVER (), 0))::numeric, 1) AS "% of all",
                   s.shared_blks_read AS "blocks from disk", s.temp_blks_written AS "temp blocks", left(s.query, 600) AS statement
              FROM pg_stat_statements s
             WHERE s.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) AND s.query NOT LIKE '%pg\\_catalog.%'
             ORDER BY s.total_exec_time DESC LIMIT 25`,
    },
    {
      title: 'Statements that are slow every time',
      note: 'The slowest on average, among those run more than five times. These are the ones an index or a rewrite helps most: run one under Explain.',
      open: true,
      sql: `SELECT round(s.mean_exec_time::numeric, 1) AS "mean ms", round(s.stddev_exec_time::numeric, 1) AS "± ms", s.calls,
                   round((s.rows::numeric / nullif(s.calls, 0)), 1) AS "rows per call", left(s.query, 600) AS statement
              FROM pg_stat_statements s
             WHERE s.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) AND s.calls > 5 AND s.query NOT LIKE '%pg\\_catalog.%'
             ORDER BY s.mean_exec_time DESC LIMIT 25`,
    },
    {
      title: 'Running for a long time right now',
      note: 'Active for more than thirty seconds, or holding a transaction open while doing nothing for more than a minute. An idle transaction keeps its locks and stops vacuum from cleaning behind it.',
      open: true,
      sql: `SELECT a.pid, a.usename AS "user", a.application_name AS application, a.state,
                   date_trunc('second', now() - coalesce(a.query_start, a.xact_start))::text AS "for",
                   a.wait_event_type AS "waiting on", left(a.query, 400) AS query
              FROM pg_catalog.pg_stat_activity a
             WHERE a.pid <> pg_backend_pid() AND a.datname = current_database()
               AND ((a.state = 'active' AND now() - a.query_start > interval '30 seconds')
                 OR (a.state LIKE 'idle in transaction%' AND now() - a.state_change > interval '1 minute'))
             ORDER BY coalesce(a.query_start, a.xact_start)`,
    },
    {
      title: 'Tables read from end to end',
      note: 'Tables of more than ten thousand rows that are scanned whole more often than through an index. The rows-per-scan column is what each of those scans read: a large number there, on a table that is asked for a few rows at a time, is a missing index.',
      open: true,
      sql: `SELECT t.schemaname AS schema, t.relname AS "table", t.seq_scan AS "whole scans", coalesce(t.idx_scan, 0) AS "index scans",
                   t.seq_tup_read / nullif(t.seq_scan, 0) AS "rows per scan", t.n_live_tup AS "rows",
                   pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(t.relid)) AS size
              FROM pg_catalog.pg_stat_user_tables t
             WHERE t.n_live_tup > 10000 AND t.seq_scan > coalesce(t.idx_scan, 0)
             ORDER BY t.seq_tup_read DESC LIMIT 50`,
    },
    {
      title: 'Foreign keys with no index behind them',
      note: 'Deleting or re-keying a row of the table referred to has to look for its children, and without an index on these columns that is a scan of the whole child table, under a lock. Joins from parent to child pay the same.',
      open: true,
      sql: `SELECT n.nspname AS schema, cl.relname AS "table", c.conname AS "foreign key",
                   (SELECT string_agg(a.attname, ', ' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
                   c.confrelid::regclass::text AS "refers to", nullif(cl.reltuples, -1)::bigint AS "rows (estimate)",
                   pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(c.conrelid)) AS size
              FROM pg_catalog.pg_constraint c
              JOIN pg_catalog.pg_class cl ON cl.oid = c.conrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
             WHERE c.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND NOT EXISTS (
                     SELECT 1 FROM pg_catalog.pg_index i
                      WHERE i.indrelid = c.conrelid AND i.indpred IS NULL AND i.indnkeyatts >= cardinality(c.conkey)
                        AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
                        AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)
             ORDER BY pg_catalog.pg_relation_size(c.conrelid) DESC LIMIT 200`,
    },
    {
      title: 'Indexes nothing has used',
      note: 'Never scanned since the statistics were last reset, and not there to keep anything unique. Every write to the table still pays for them. Look at how long the statistics cover before dropping one — an index used once a month by a report looks the same as one used never.',
      open: true,
      sql: `SELECT i.schemaname AS schema, i.relname AS "table", i.indexrelname AS index,
                   pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(i.indexrelid)) AS size, t.n_tup_ins + t.n_tup_upd + t.n_tup_del AS "writes it slowed",
                   coalesce((SELECT date_trunc('second', d.stats_reset)::text FROM pg_catalog.pg_stat_database d WHERE d.datname = current_database()), 'never reset') AS "counted since"
              FROM pg_catalog.pg_stat_user_indexes i
              JOIN pg_catalog.pg_index x ON x.indexrelid = i.indexrelid
              JOIN pg_catalog.pg_stat_user_tables t ON t.relid = i.relid
             WHERE i.idx_scan = 0 AND NOT x.indisunique AND NOT x.indisprimary
               AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = i.indexrelid)
             ORDER BY pg_catalog.pg_relation_size(i.indexrelid) DESC LIMIT 200`,
    },
    {
      title: 'Indexes that say the same thing twice',
      note: 'The same columns, in the same order, with the same condition. All but one can go; keep the one a constraint stands on.',
      open: true,
      sql: `SELECT n.nspname AS schema, cl.relname AS "table", string_agg(x.indexrelid::regclass::text, ', ' ORDER BY x.indexrelid) AS indexes, count(*) AS copies,
                   pg_catalog.pg_size_pretty(sum(pg_catalog.pg_relation_size(x.indexrelid))::bigint) AS "size together"
              FROM pg_catalog.pg_index x
              JOIN pg_catalog.pg_class cl ON cl.oid = x.indrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
             WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
             GROUP BY n.nspname, cl.relname, x.indrelid, x.indkey::text, x.indclass::text, x.indoption::text,
                      coalesce(pg_catalog.pg_get_expr(x.indexprs, x.indrelid), ''), coalesce(pg_catalog.pg_get_expr(x.indpred, x.indrelid), '')
            HAVING count(*) > 1
             ORDER BY sum(pg_catalog.pg_relation_size(x.indexrelid)) DESC LIMIT 200`,
    },
    {
      title: 'Tables carrying dead rows',
      note: 'Rows that were updated or deleted and not yet cleaned away: more than a thousand of them and more than a tenth of the table. They are read by every scan. A table that stays on this list is one autovacuum is not keeping up with, or one a long transaction is holding back.',
      open: true,
      sql: `SELECT t.schemaname AS schema, t.relname AS "table", t.n_dead_tup AS "dead rows", t.n_live_tup AS "live rows",
                   round(100.0 * t.n_dead_tup / nullif(t.n_live_tup + t.n_dead_tup, 0), 1) AS "dead %",
                   coalesce(date_trunc('second', greatest(t.last_vacuum, t.last_autovacuum))::text, 'never') AS "last vacuumed",
                   coalesce(date_trunc('second', greatest(t.last_analyze, t.last_autoanalyze))::text, 'never') AS "last analysed",
                   pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(t.relid)) AS size
              FROM pg_catalog.pg_stat_user_tables t
             WHERE t.n_dead_tup > 1000 AND t.n_dead_tup > 0.1 * (t.n_live_tup + t.n_dead_tup)
             ORDER BY t.n_dead_tup DESC LIMIT 100`,
    },
    {
      title: 'Tables the planner has never been told about',
      note: 'Never analysed, with rows in them. The planner is guessing their size, and a wrong guess is how a good query gets a bad plan. ANALYZE is in each table\'s menu.',
      open: true,
      sql: `SELECT t.schemaname AS schema, t.relname AS "table", t.n_live_tup AS "rows", t.n_mod_since_analyze AS "changed since"
              FROM pg_catalog.pg_stat_user_tables t
             WHERE t.last_analyze IS NULL AND t.last_autoanalyze IS NULL AND t.n_live_tup > 0
             ORDER BY t.n_live_tup DESC LIMIT 100`,
    },
    {
      title: 'This database, as a whole',
      note: 'A cache hit rate under 99% on a database that is busy means memory is short for what is being asked. Temporary files are sorts and hashes that did not fit in work_mem. Deadlocks and rollbacks are counted since the statistics were reset.',
      open: true,
      vertical: true,
      sql: `SELECT round(100.0 * d.blks_hit / nullif(d.blks_hit + d.blks_read, 0), 2) AS "cache hit %",
                   d.temp_files AS "temporary files", pg_catalog.pg_size_pretty(d.temp_bytes) AS "temporary bytes",
                   d.deadlocks, round(100.0 * d.xact_rollback / nullif(d.xact_commit + d.xact_rollback, 0), 2) AS "rolled back %",
                   d.numbackends AS connections, pg_catalog.age(b.datfrozenxid) AS "transaction id age",
                   round(100.0 * pg_catalog.age(b.datfrozenxid) / 2000000000, 1) AS "% of the way to wraparound",
                   coalesce(date_trunc('second', d.stats_reset)::text, 'never reset') AS "counted since"
              FROM pg_catalog.pg_stat_database d JOIN pg_catalog.pg_database b ON b.oid = d.datid
             WHERE d.datname = current_database()`,
    },
  ],

  search: ({ q }) => [
    {
      title: 'Found',
      open: true,
      sql: `SELECT * FROM (
              SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index' ELSE 'relation' END AS kind,
                     n.nspname AS schema, c.relname AS name, coalesce((SELECT t.relname FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid = x.indrelid WHERE x.indexrelid = c.oid), '') AS "table"
                FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'i') AND c.relname ILIKE $1
              UNION ALL
              SELECT 'column', n.nspname, a.attname, c.relname
                FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attname ILIKE $1
              UNION ALL
              SELECT 'function', n.nspname, p.proname, ''
                FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE p.proname ILIKE $1
            ) found
            WHERE schema !~ '^pg_' AND schema <> 'information_schema'
            ORDER BY (kind = 'table') DESC, (kind = 'view') DESC, kind, schema, name LIMIT 300`,
      params: [`%${String(q ?? '').replace(/[\\%_]/g, '\\$&')}%`],
    },
  ],
};

const postgres = {
  reports: (kind, args) => (Object.hasOwn(PG_REPORTS, kind) ? PG_REPORTS[kind](args ?? {}) : null),

  /**
   * Everything a schema defines, read in a handful of queries rather than a
   * handful per table: what a comparison of two schemas is made from.
   * Partitions are left to their parents, and what an extension brought is
   * left to the extension.
   */
  async snapshot(session, schema) {
    const columns = await session.all(
      `SELECT c.relname AS "table", a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity AS identity, to_jsonb(a)->>'attgenerated' AS generated
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname, a.attnum`,
      [schema],
    );
    const indexes = await session.all(
      `SELECT t.relname AS "table", i.relname AS name, pg_catalog.pg_get_indexdef(x.indexrelid) AS definition
         FROM pg_catalog.pg_index x
         JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
         JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relkind IN ('r', 'p') AND NOT t.relispartition
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid = x.indexrelid)
        ORDER BY 1, 2`,
      [schema],
    );
    const constraints = await session.all(
      `SELECT c.relname AS "table", con.conname AS name, con.contype AS type, pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
              (SELECT array_to_json(array_agg(att.attname ORDER BY u.ord))
                 FROM unnest(con.conkey) WITH ORDINALITY AS u(num, ord)
                 JOIN pg_catalog.pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.num) AS columns,
              fn.nspname AS ref_schema, fc.relname AS ref_table,
              (SELECT array_to_json(array_agg(att.attname ORDER BY u.ord))
                 FROM unnest(con.confkey) WITH ORDINALITY AS u(num, ord)
                 JOIN pg_catalog.pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.num) AS ref_columns
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
         LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
        WHERE n.nspname = $1 AND con.contype IN ('p', 'u', 'f', 'c', 'x') AND NOT c.relispartition AND con.conparentid = 0
        ORDER BY 1, 2`,
      [schema],
    );
    const views = await session.all(
      `SELECT c.relname AS name, c.relkind AS kind, pg_catalog.pg_get_viewdef(c.oid, true) AS definition
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') ORDER BY 1`,
      [schema],
    );
    const sequences = await session.all(
      `SELECT c.relname AS name
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'S'
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = c.oid AND d.classid = 'pg_catalog.pg_class'::regclass AND d.deptype = 'i')
        ORDER BY 1`,
      [schema],
    );
    const routines = await session.all(
      `SELECT p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS name,
              CASE to_jsonb(p)->>'prokind' WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind, pg_catalog.pg_get_functiondef(p.oid) AS definition
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND coalesce(to_jsonb(p)->>'prokind', 'f') IN ('f', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.classid = 'pg_catalog.pg_proc'::regclass AND d.deptype = 'e')
        ORDER BY 1 LIMIT 3000`,
      [schema],
    );
    const tables = new Map();
    for (const row of columns) {
      const table = tables.get(row.table) ?? { name: row.table, columns: [], indexes: [], constraints: [] };
      if (row.name !== null) {
        table.columns.push({
          name: row.name,
          type: row.type,
          nullable: yes(row.nullable),
          default: row.generated === 's' ? null : row.default,
          extra: row.identity === 'a' ? 'identity (always)' : row.identity === 'd' ? 'identity' : row.generated === 's' ? `generated: ${row.default}` : '',
          comment: '',
        });
      }
      tables.set(row.table, table);
    }
    for (const row of indexes) tables.get(row.table)?.indexes.push({ name: row.name, definition: row.definition });
    for (const row of constraints) {
      const table = tables.get(row.table);
      if (!table) continue;
      const constraint = { name: row.name, type: PG_CONSTRAINTS[row.type] ?? row.type, definition: row.definition, columns: list(row.columns) };
      if (row.type === 'f') Object.assign(constraint, { refSchema: row.ref_schema, refTable: row.ref_table, refColumns: list(row.ref_columns) });
      if (row.type === 'p') table.key = constraint.columns;
      table.constraints.push(constraint);
    }
    return {
      tables: [...tables.values()],
      views: views.map((row) => ({ name: row.name, kind: row.kind === 'm' ? 'matview' : 'view', definition: String(row.definition ?? '').trim() })),
      sequences: sequences.map((row) => ({ name: row.name })),
      routines: routines.map((row) => ({ name: row.name, kind: row.kind, definition: String(row.definition ?? '').trim() })),
    };
  },

  /** The counters a dashboard is drawn from. Read twice and subtracted, they are rates. */
  async metrics(session) {
    const [row] = await session.all(
      `SELECT extract(epoch FROM now()) * 1000 AS at,
              (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend') AS sessions,
              (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active') AS active,
              (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE wait_event_type = 'Lock') AS waiting,
              sum(xact_commit) AS commits, sum(xact_rollback) AS rollbacks,
              sum(tup_inserted) AS inserted, sum(tup_updated) AS updated, sum(tup_deleted) AS deleted,
              sum(tup_fetched) AS fetched, sum(tup_returned) AS returned,
              sum(blks_read) AS blocks_read, sum(blks_hit) AS blocks_hit
         FROM pg_catalog.pg_stat_database`,
    );
    return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value) || 0]));
  },

  async databases(session) {
    const rows = await session.all(
      `SELECT d.datname AS name, pg_catalog.pg_get_userbyid(d.datdba) AS owner,
              pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
              CASE WHEN pg_catalog.has_database_privilege(d.datname, 'CONNECT') THEN pg_catalog.pg_database_size(d.datname) END AS size
         FROM pg_catalog.pg_database d
        WHERE NOT d.datistemplate AND d.datallowconn
        ORDER BY d.datname`,
    );
    return rows.map((row) => ({ name: row.name, owner: row.owner, encoding: row.encoding, size: number(row.size), system: false }));
  },

  async schemas(session) {
    const rows = await session.all(
      `SELECT n.nspname AS name, pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
              (n.nspname ~ '^pg_' OR n.nspname = 'information_schema') AS system
         FROM pg_catalog.pg_namespace n
        WHERE n.nspname !~ '^pg_(toast|temp)'
        ORDER BY 3, 1`,
    );
    return rows.map((row) => ({ name: row.name, owner: row.owner, system: yes(row.system) }));
  },

  async objects(session, schema) {
    const [relations, routines] = await Promise.all([
      session.all(
        `SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS rows,
                CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_catalog.pg_total_relation_size(c.oid) END AS size,
                pg_catalog.obj_description(c.oid, 'pg_class') AS comment, c.relkind = 'p' AS partitioned,
                CASE WHEN c.relispartition THEN (SELECT p.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class p ON p.oid = i.inhparent WHERE i.inhrelid = c.oid LIMIT 1) END AS parent
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          ORDER BY c.relname`,
        [schema],
      ),
      session.all(
        `SELECT p.oid, p.proname AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
                pg_catalog.pg_get_function_result(p.oid) AS returns, to_jsonb(p)->>'prokind' AS kind
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1
          ORDER BY 2, 3
          LIMIT 5000`,
        [schema],
      ),
    ]);
    return {
      relations: relations.map((row) => ({
        name: row.name,
        // A partition is a table, and is listed apart from the tables people made by hand: there may be hundreds.
        kind: row.parent ? 'partition' : PG_KINDS[row.kind] ?? 'table',
        parent: row.parent ?? null,
        // Never analysed, PostgreSQL says -1: that is "unknown", not "minus one row".
        rows: number(row.rows) !== null && number(row.rows) >= 0 ? number(row.rows) : null,
        size: number(row.size),
        comment: row.comment ?? '',
        partitioned: yes(row.partitioned),
      })),
      routines: routines.map((row) => ({
        id: row.oid,
        name: row.name,
        args: row.args ?? '',
        returns: row.returns ?? '',
        kind: PG_ROUTINES[row.kind] ?? 'function',
      })),
    };
  },

  async table(session, schema, name) {
    const [head] = await session.all(
      `SELECT c.oid, c.relkind AS kind, c.reltuples::bigint AS rows, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
              CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_catalog.pg_total_relation_size(c.oid) END AS size,
              CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_catalog.pg_indexes_size(c.oid) END AS index_size,
              pg_catalog.obj_description(c.oid, 'pg_class') AS comment
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name],
    );
    if (!head) throw new RdbError(`${schema}.${name} is not there any more`);
    const oid = head.oid;
    const kind = PG_KINDS[head.kind] ?? 'table';
    const [columns, indexes, constraints, referencedBy, triggers] = await Promise.all([
      session.all(
        `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "default", pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
                a.attidentity AS identity, to_jsonb(a)->>'attgenerated' AS generated
           FROM pg_catalog.pg_attribute a
           LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [oid],
      ),
      session.all(
        `SELECT i.relname AS name, x.indisunique AS "unique", x.indisprimary AS "primary",
                pg_catalog.pg_get_indexdef(x.indexrelid) AS definition, am.amname AS method,
                pg_catalog.pg_relation_size(x.indexrelid) AS size,
                (SELECT string_agg(pg_catalog.pg_get_indexdef(x.indexrelid, k, true), ', ' ORDER BY k)
                   FROM generate_series(1, x.indnatts) AS k) AS columns
           FROM pg_catalog.pg_index x
           JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
           JOIN pg_catalog.pg_am am ON am.oid = i.relam
          WHERE x.indrelid = $1
          ORDER BY x.indisprimary DESC, i.relname`,
        [oid],
      ),
      session.all(
        `SELECT con.conname AS name, con.contype AS type, pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
                (SELECT array_to_json(array_agg(att.attname ORDER BY u.ord))
                   FROM unnest(con.conkey) WITH ORDINALITY AS u(num, ord)
                   JOIN pg_catalog.pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.num) AS columns,
                fn.nspname AS ref_schema, fc.relname AS ref_table,
                (SELECT array_to_json(array_agg(att.attname ORDER BY u.ord))
                   FROM unnest(con.confkey) WITH ORDINALITY AS u(num, ord)
                   JOIN pg_catalog.pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.num) AS ref_columns
           FROM pg_catalog.pg_constraint con
           LEFT JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
           LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
          WHERE con.conrelid = $1 AND con.contype <> 'n'
          ORDER BY con.contype, con.conname`,
        [oid],
      ),
      session.all(
        `SELECT n.nspname AS schema, c.relname AS "table", con.conname AS name,
                pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
           FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE con.confrelid = $1 AND con.contype = 'f'
          ORDER BY 1, 2, 3`,
        [oid],
      ),
      session.all(
        `SELECT t.tgname AS name, pg_catalog.pg_get_triggerdef(t.oid, true) AS definition
           FROM pg_catalog.pg_trigger t WHERE t.tgrelid = $1 AND NOT t.tgisinternal ORDER BY 1`,
        [oid],
      ),
    ]);

    const primary = constraints.find((one) => one.type === 'p');
    const key = primary ? list(primary.columns) : [];
    const out = {
      kind,
      key,
      columns: columns.map((row) => ({
        name: row.name,
        type: row.type,
        nullable: yes(row.nullable),
        default: row.default,
        comment: row.comment ?? '',
        pk: key.includes(row.name),
        extra: row.identity === 'a' ? 'identity (always)' : row.identity === 'd' ? 'identity' : row.generated === 's' ? 'generated' : '',
      })),
      indexes: indexes.map((row) => ({
        name: row.name,
        columns: row.columns ?? '',
        unique: yes(row.unique),
        primary: yes(row.primary),
        method: row.method,
        size: number(row.size),
        definition: row.definition,
      })),
      constraints: constraints.map((row) => ({ name: row.name, type: PG_CONSTRAINTS[row.type] ?? row.type, definition: row.definition })),
      foreignKeys: constraints.filter((row) => row.type === 'f').map((row) => ({
        name: row.name,
        columns: list(row.columns),
        refSchema: row.ref_schema,
        refTable: row.ref_table,
        refColumns: list(row.ref_columns),
        definition: row.definition,
      })),
      referencedBy: referencedBy.map((row) => ({ schema: row.schema, table: row.table, name: row.name, definition: row.definition })),
      triggers: triggers.map((row) => ({ name: row.name, definition: row.definition })),
      stats: {
        rows: number(head.rows) !== null && number(head.rows) >= 0 ? number(head.rows) : null,
        size: number(head.size),
        indexSize: number(head.index_size),
        owner: head.owner,
        comment: head.comment ?? '',
      },
    };

    const target = qualified('postgres', schema, name);
    if (kind === 'view' || kind === 'matview') {
      const [view] = await session.all('SELECT pg_catalog.pg_get_viewdef($1::oid, true) AS definition', [oid]);
      out.ddl = `CREATE ${kind === 'matview' ? 'MATERIALIZED VIEW' : 'OR REPLACE VIEW'} ${target} AS\n${view?.definition ?? ''}`;
    } else if (kind === 'sequence') {
      out.ddl = `CREATE SEQUENCE ${target};`;
    } else {
      out.ddl = pgTableDdl(target, out, constraints);
    }
    return out;
  },

  async routine(session, _schema, id) {
    const [row] = await session.all('SELECT pg_catalog.pg_get_functiondef($1::oid) AS definition', [id]);
    return { ddl: row?.definition ?? '' };
  },

  activity: () => ({
    sql: `SELECT pid, usename AS "user", datname AS database, application_name AS application, client_addr::text AS client,
                 state, wait_event_type || ': ' || wait_event AS waiting,
                 date_trunc('second', now() - query_start)::text AS running, backend_type AS type, left(query, 2000) AS query
            FROM pg_catalog.pg_stat_activity
           WHERE pid <> pg_backend_pid() AND (backend_type = 'client backend' OR state IS NOT NULL)
           ORDER BY (state = 'active') DESC, query_start`,
    key: 'pid',
  }),

  roles: () => `SELECT r.rolname AS role, r.rolcanlogin AS login, r.rolsuper AS superuser, r.rolcreatedb AS "create db",
                       r.rolcreaterole AS "create role", r.rolreplication AS replication, r.rolconnlimit AS "conn limit",
                       r.rolvaliduntil::text AS "valid until",
                       (SELECT string_agg(g.rolname, ', ' ORDER BY g.rolname) FROM pg_catalog.pg_auth_members m
                          JOIN pg_catalog.pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS "member of"
                  FROM pg_catalog.pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY 1`,

  async info(session) {
    const [row] = await session.all(
      `SELECT version() AS version, current_user AS "user", current_database() AS database,
              pg_catalog.pg_postmaster_start_time()::text AS started, current_setting('max_connections') AS max_connections,
              (SELECT count(*) FROM pg_catalog.pg_stat_activity) AS connections`,
    );
    return row ?? {};
  },

  async kill(session, pid, hard) {
    const id = Number(pid);
    if (!Number.isInteger(id)) throw new RdbError('That is not a session id');
    const [row] = await session.all(`SELECT ${hard ? 'pg_terminate_backend' : 'pg_cancel_backend'}($1) AS done`, [id]);
    return yes(row?.done);
  },

  begin: (readOnly) => (readOnly ? 'BEGIN READ ONLY' : 'BEGIN'),
};

/** A table's CREATE statement, put back together from what the catalog says about it. */
function pgTableDdl(target, table, rawConstraints) {
  const lines = table.columns.map((column) => {
    let line = `    ${quoteIdent('postgres', column.name)} ${column.type}`;
    if (column.extra.startsWith('identity')) line += ` GENERATED ${column.extra.includes('always') ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
    else if (column.extra === 'generated') line += ` GENERATED ALWAYS AS (${column.default}) STORED`;
    else if (column.default !== null && column.default !== undefined) line += ` DEFAULT ${column.default}`;
    if (!column.nullable) line += ' NOT NULL';
    return line;
  });
  for (const constraint of rawConstraints) {
    if (constraint.type === 't') continue;
    lines.push(`    CONSTRAINT ${quoteIdent('postgres', constraint.name)} ${constraint.definition}`);
  }
  const backing = new Set(rawConstraints.map((constraint) => constraint.name));
  const parts = [`CREATE TABLE ${target} (\n${lines.join(',\n')}\n);`];
  const indexes = table.indexes.filter((index) => !backing.has(index.name)).map((index) => `${index.definition};`);
  if (indexes.length) parts.push(indexes.join('\n'));
  const comments = [];
  if (table.stats.comment) comments.push(`COMMENT ON TABLE ${target} IS '${table.stats.comment.replace(/'/g, "''")}';`);
  for (const column of table.columns) {
    if (column.comment) comments.push(`COMMENT ON COLUMN ${target}.${quoteIdent('postgres', column.name)} IS '${column.comment.replace(/'/g, "''")}';`);
  }
  if (comments.length) parts.push(comments.join('\n'));
  if (table.triggers.length) parts.push(table.triggers.map((trigger) => `${trigger.definition};`).join('\n'));
  return parts.join('\n\n');
}

// ────────────────────────────────────────────────────────── MySQL, MariaDB ──

/** Everything as text; bytes as bytes, to be read as text only if that is what they are. */
function mysqlCast(field, next) {
  const type = String(field.type ?? '');
  if (/BLOB|BINARY|GEOMETRY|BIT/.test(type)) return field.buffer();
  if (type === 'NULL') return next();
  return field.string();
}

class MysqlSession {
  constructor(config, connection, types) {
    this.engine = 'mysql';
    this.config = config;
    this.connection = connection;
    this.types = types;
    this.closed = false;
    this.txn = 'idle';
    connection.on('error', () => { this.closed = true; });
    connection.on('end', () => { this.closed = true; });
  }

  static async open(config) {
    const mysql = require('mysql2/promise');
    const { Types } = require('mysql2');
    let connection;
    try {
      connection = await mysql.createConnection({
        host: config.host || 'localhost',
        port: Number(config.port) || 3306,
        user: config.user || undefined,
        password: config.password || undefined,
        database: config.database || undefined,
        ssl: sslOf(config),
        connectTimeout: CONNECT_TIMEOUT,
        typeCast: mysqlCast,
        multipleStatements: false,
        charset: 'utf8mb4',
      });
    } catch (error) {
      throw explain(error, config);
    }
    const session = new MysqlSession(config, connection, Types);
    if (config.readOnly) await session.all('SET SESSION TRANSACTION READ ONLY');
    return session;
  }

  async all(sql, params = []) {
    try {
      const [rows] = await this.connection.query({ sql, values: params });
      return Array.isArray(rows) ? rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)[0]]))) : [];
    } catch (error) {
      throw explain(error, this.config);
    }
  }

  /**
   * One statement. MySQL has a setting made for exactly this: a SELECT with no
   * LIMIT of its own stops at `sql_select_limit`, on the server, before the
   * rows are sent.
   */
  async run(sql, params = [], { maxRows = 1000 } = {}) {
    try {
      await this.connection.query(`SET SESSION sql_select_limit = ${Math.max(1, Math.floor(maxRows)) + 1}`);
      let rows;
      let fields;
      try {
        [rows, fields] = await this.connection.query({ sql, values: params, rowsAsArray: true });
      } finally {
        if (!this.closed) await this.connection.query('SET SESSION sql_select_limit = DEFAULT').catch(() => {});
      }
      // A procedure answers with several results; the first is the one shown.
      if (Array.isArray(fields) && Array.isArray(fields[0])) {
        fields = fields[0];
        rows = rows[0];
      }
      if (!Array.isArray(rows)) {
        const header = rows ?? {};
        if (typeof header.serverStatus === 'number') this.txn = header.serverStatus & 1 ? 'open' : 'idle';
        const out = grid([], [], { rowCount: Number(header.affectedRows ?? 0), command: '' });
        out.notices = header.info ? [String(header.info)] : [];
        return out;
      }
      const columns = (fields ?? []).map((field) => ({ name: field.name, type: String(this.types[field.columnType] ?? '').toLowerCase() }));
      const out = grid(columns, rows, { maxRows });
      if (out.truncated) out.rowCount = null;
      out.notices = [];
      return out;
    } catch (error) {
      throw explain(error, this.config);
    }
  }

  async cancel() {
    const id = Number(this.connection.threadId ?? this.connection.connection?.threadId);
    if (!Number.isInteger(id)) return false;
    const other = await MysqlSession.open({ ...this.config, readOnly: false });
    try {
      await other.all(`KILL QUERY ${id}`);
      return true;
    } finally {
      await other.close();
    }
  }

  async close() {
    this.closed = true;
    try { await this.connection.end(); } catch { try { this.connection.destroy(); } catch { /* already gone */ } }
  }
}

const MYSQL_SYSTEM = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

const MYSQL_REPORTS = {
  tableStats: ({ schema, name }) => [
    {
      title: 'The table',
      vertical: true,
      note: 'InnoDB estimates its row count; it is not a count.',
      open: true,
      sql: `SELECT ENGINE AS engine, ROW_FORMAT AS \`row format\`, TABLE_ROWS AS \`rows, about\`, AVG_ROW_LENGTH AS \`avg row bytes\`,
                   DATA_LENGTH AS \`data bytes\`, INDEX_LENGTH AS \`index bytes\`, DATA_FREE AS \`free bytes\`, AUTO_INCREMENT AS \`next auto increment\`,
                   CREATE_TIME AS created, UPDATE_TIME AS updated, TABLE_COLLATION AS collation
              FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      params: [schema, name],
    },
    {
      title: 'Index cardinality',
      sql: `SELECT INDEX_NAME AS \`index\`, SEQ_IN_INDEX AS position, COLUMN_NAME AS \`column\`, CARDINALITY AS cardinality, NULLABLE AS nullable, INDEX_TYPE AS kind
              FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      params: [schema, name],
    },
  ],
  privileges: ({ schema, name }) => [
    {
      title: 'On this table',
      sql: `SELECT GRANTEE AS grantee, GROUP_CONCAT(PRIVILEGE_TYPE ORDER BY PRIVILEGE_TYPE SEPARATOR ', ') AS privileges, MAX(IS_GRANTABLE) AS \`may grant\`
              FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY GRANTEE ORDER BY 1`,
      params: [schema, name],
    },
    {
      title: 'On its database',
      sql: `SELECT GRANTEE AS grantee, GROUP_CONCAT(PRIVILEGE_TYPE ORDER BY PRIVILEGE_TYPE SEPARATOR ', ') AS privileges, MAX(IS_GRANTABLE) AS \`may grant\`
              FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = ? GROUP BY GRANTEE ORDER BY 1`,
      params: [schema],
    },
  ],
  locks: () => [
    {
      title: 'Sessions that are waiting, and who they wait for',
      sql: `SELECT waiting_pid AS pid, blocking_pid AS \`blocked by\`, wait_age AS waiting, locked_table AS \`on\`, LEFT(waiting_query, 400) AS query, LEFT(blocking_query, 200) AS \`blocking query\`
              FROM sys.innodb_lock_waits ORDER BY wait_age DESC`,
    },
  ],
  triggers: ({ schema }) => [
    {
      title: 'Triggers',
      open: true,
      sql: `SELECT EVENT_OBJECT_TABLE AS \`table\`, TRIGGER_NAME AS \`trigger\`, ACTION_TIMING AS \`when\`, EVENT_MANIPULATION AS \`on\`, LEFT(ACTION_STATEMENT, 400) AS body
              FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY 1, 2`,
      params: [schema],
    },
  ],
  events: ({ schema }) => [
    {
      title: 'Scheduled events',
      sql: `SELECT EVENT_NAME AS event, STATUS AS state, EVENT_TYPE AS kind, CONCAT_WS(' ', INTERVAL_VALUE, INTERVAL_FIELD) AS every,
                   LAST_EXECUTED AS \`last ran\`, LEFT(EVENT_DEFINITION, 400) AS body
              FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY 1`,
      params: [schema],
    },
  ],
  indexes: ({ schema }) => [
    {
      title: 'Indexes',
      open: true,
      filter: true,
      sql: `SELECT TABLE_NAME AS \`table\`, INDEX_NAME AS \`index\`, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS \`columns\`,
                   IF(MAX(NON_UNIQUE) = 0, 'unique', '') AS kind, MAX(INDEX_TYPE) AS method, MAX(CARDINALITY) AS cardinality
              FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME ORDER BY 1, 2 LIMIT 2000`,
      params: [schema],
    },
  ],
  partitions: ({ schema }) => [
    {
      title: 'Partitions',
      open: true,
      filter: true,
      sql: `SELECT TABLE_NAME AS \`table\`, PARTITION_NAME AS \`partition\`, PARTITION_METHOD AS method, PARTITION_EXPRESSION AS \`by\`,
                   PARTITION_DESCRIPTION AS bounds, TABLE_ROWS AS \`rows, about\`, DATA_LENGTH + INDEX_LENGTH AS bytes
              FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = ? AND PARTITION_NAME IS NOT NULL ORDER BY 1, PARTITION_ORDINAL_POSITION LIMIT 2000`,
      params: [schema],
    },
  ],
  settings: () => [
    { title: 'Configuration', filter: true, sql: 'SELECT VARIABLE_NAME AS name, VARIABLE_VALUE AS value FROM performance_schema.global_variables ORDER BY 1' },
  ],
  /** Why it is slow, asked of the server itself — see the note on the PostgreSQL one. */
  performance: ({ schema }) => [
    {
      title: 'Statements that cost the most time in total',
      note: 'From the performance schema, since the server started or its summaries were truncated. A statement is here because it is slow, or because it is run very often — the calls column says which. Empty when performance_schema is off.',
      open: true,
      sql: `SELECT ROUND(SUM_TIMER_WAIT / 1e12, 1) AS \`total s\`, COUNT_STAR AS calls, ROUND(AVG_TIMER_WAIT / 1e9, 2) AS \`mean ms\`, ROUND(MAX_TIMER_WAIT / 1e9, 1) AS \`max ms\`,
                   SUM_ROWS_EXAMINED AS \`rows read\`, SUM_ROWS_SENT AS \`rows sent\`, SUM_CREATED_TMP_DISK_TABLES AS \`temp tables on disk\`, LEFT(DIGEST_TEXT, 600) AS statement
              FROM performance_schema.events_statements_summary_by_digest
             WHERE SCHEMA_NAME = ? ORDER BY SUM_TIMER_WAIT DESC LIMIT 25`,
      params: [schema],
    },
    {
      title: 'Statements that read far more than they return',
      note: 'Run without an index, or reading more than a hundred rows for each one sent back. These are the ones an index helps most: run one under Explain.',
      open: true,
      sql: `SELECT COUNT_STAR AS calls, SUM_NO_INDEX_USED AS \`without an index\`, ROUND(SUM_ROWS_EXAMINED / NULLIF(COUNT_STAR, 0)) AS \`rows read per call\`,
                   ROUND(SUM_ROWS_SENT / NULLIF(COUNT_STAR, 0), 1) AS \`rows sent per call\`, ROUND(AVG_TIMER_WAIT / 1e9, 2) AS \`mean ms\`, LEFT(DIGEST_TEXT, 600) AS statement
              FROM performance_schema.events_statements_summary_by_digest
             WHERE SCHEMA_NAME = ? AND (SUM_NO_INDEX_USED > 0 OR SUM_ROWS_EXAMINED > 100 * GREATEST(SUM_ROWS_SENT, 1)) AND SUM_ROWS_EXAMINED > 1000
             ORDER BY SUM_ROWS_EXAMINED DESC LIMIT 25`,
      params: [schema],
    },
    {
      title: 'Running for a long time right now',
      note: 'Anything that has been at it for more than thirty seconds.',
      open: true,
      sql: `SELECT ID AS id, USER AS \`user\`, DB AS \`database\`, COMMAND AS command, TIME AS seconds, STATE AS state, LEFT(INFO, 400) AS query
              FROM information_schema.PROCESSLIST
             WHERE COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump', 'Binlog Dump GTID') AND TIME > 30 AND ID <> CONNECTION_ID() ORDER BY TIME DESC`,
    },
    {
      title: 'Transactions left open',
      note: 'Open for more than a minute. An open transaction keeps its locks, and keeps the history every other reader has to wade through.',
      open: true,
      sql: `SELECT trx_mysql_thread_id AS id, trx_state AS state, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS seconds, trx_rows_locked AS \`rows locked\`,
                   trx_rows_modified AS \`rows changed\`, LEFT(trx_query, 400) AS query
              FROM information_schema.INNODB_TRX WHERE trx_started < NOW() - INTERVAL 1 MINUTE ORDER BY trx_started`,
    },
    {
      title: 'Tables read from end to end',
      note: 'Rows read by scans that used no index, since the server started. A big number on a table that is asked for a few rows at a time is a missing index.',
      open: true,
      sql: `SELECT object_name AS \`table\`, rows_full_scanned AS \`rows read by whole scans\`, latency AS \`time spent\`
              FROM sys.schema_tables_with_full_table_scans WHERE object_schema = ? LIMIT 50`,
      params: [schema],
    },
    {
      title: 'Indexes nothing has used',
      note: 'Not read once since the server started, and not a primary key. Every write to the table still pays for them. Look at how long the server has been up before dropping one.',
      open: true,
      sql: `SELECT u.object_name AS \`table\`, u.index_name AS \`index\`,
                   (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime') AS \`server up, seconds\`
              FROM sys.schema_unused_indexes u WHERE u.object_schema = ? ORDER BY 1, 2 LIMIT 200`,
      params: [schema],
    },
    {
      title: 'Indexes another index already covers',
      note: 'The redundant one starts with the same columns as the dominant one, so anything it can answer the other can too. The last column is the statement that removes it — read it first.',
      open: true,
      sql: `SELECT table_name AS \`table\`, redundant_index_name AS redundant, redundant_index_columns AS \`its columns\`,
                   dominant_index_name AS \`covered by\`, dominant_index_columns AS \`whose columns\`, sql_drop_index AS \`to remove it\`
              FROM sys.schema_redundant_indexes WHERE table_schema = ? ORDER BY 1, 2 LIMIT 200`,
      params: [schema],
    },
    {
      title: 'Tables with no primary key',
      note: 'A table with no primary key gets a hidden one, cannot be replicated row by row efficiently, and cannot be edited in the grid.',
      open: true,
      sql: `SELECT t.TABLE_NAME AS \`table\`, t.TABLE_ROWS AS \`rows (estimate)\`, t.ENGINE AS engine
              FROM information_schema.TABLES t
             WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
               AND NOT EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS c
                                WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME AND c.CONSTRAINT_TYPE = 'PRIMARY KEY')
             ORDER BY t.TABLE_ROWS DESC LIMIT 100`,
      params: [schema],
    },
    {
      title: 'Space that could be given back',
      note: 'More than ten megabytes allocated to a table and not used by it — what is left behind by large deletes. OPTIMIZE TABLE rebuilds the table and returns it; on a big table that takes time and a copy.',
      open: true,
      sql: `SELECT TABLE_NAME AS \`table\`, ROUND(DATA_FREE / 1048576, 1) AS \`free MB\`, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1048576, 1) AS \`used MB\`,
                   ROUND(100 * DATA_FREE / NULLIF(DATA_LENGTH + INDEX_LENGTH + DATA_FREE, 0), 1) AS \`free %\`
              FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND DATA_FREE > 10485760 ORDER BY DATA_FREE DESC LIMIT 100`,
      params: [schema],
    },
    {
      title: 'The server, as a whole',
      note: 'A buffer pool hit rate under 99% on a busy server means memory is short. Temporary tables on disk are sorts and groupings that did not fit in memory. Counted since the server started.',
      open: true,
      sql: `SELECT VARIABLE_NAME AS counter, VARIABLE_VALUE AS value FROM performance_schema.global_status
             WHERE VARIABLE_NAME IN ('Uptime', 'Slow_queries', 'Select_scan', 'Select_full_join', 'Sort_merge_passes', 'Created_tmp_disk_tables', 'Created_tmp_tables',
                                     'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', 'Innodb_row_lock_waits', 'Innodb_row_lock_time', 'Aborted_connects', 'Threads_running', 'Max_used_connections')
             ORDER BY 1`,
    },
  ],
  search: ({ q }) => {
    const like = `%${String(q ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    return [
      {
        title: 'Found',
        open: true,
        sql: `SELECT * FROM (
                SELECT IF(TABLE_TYPE LIKE '%VIEW%', 'view', 'table') AS kind, TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, '' AS \`table\`
                  FROM information_schema.TABLES WHERE TABLE_NAME LIKE ?
                UNION ALL
                SELECT 'column', TABLE_SCHEMA, COLUMN_NAME, TABLE_NAME FROM information_schema.COLUMNS WHERE COLUMN_NAME LIKE ?
                UNION ALL
                SELECT LOWER(ROUTINE_TYPE), ROUTINE_SCHEMA, ROUTINE_NAME, '' FROM information_schema.ROUTINES WHERE ROUTINE_NAME LIKE ?
              ) found
              WHERE \`schema\` NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
              ORDER BY (kind = 'table') DESC, kind, \`schema\`, name LIMIT 300`,
        params: [like, like, like],
      },
    ];
  },
};

const mysql = {
  reports: (kind, args) => (Object.hasOwn(MYSQL_REPORTS, kind) ? MYSQL_REPORTS[kind](args ?? {}) : null),

  /** Everything a database defines, in a handful of queries. Its indexes and foreign keys come back already written as MySQL writes them. */
  async snapshot(session, schema) {
    const columns = await session.all(
      `SELECT t.TABLE_NAME AS \`table\`, c.COLUMN_NAME AS name, c.COLUMN_TYPE AS type, c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS \`default\`,
              c.EXTRA AS extra, c.COLUMN_COMMENT AS comment
         FROM information_schema.TABLES t
         LEFT JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
        WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE' ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION`,
      [schema],
    );
    const statistics = await session.all(
      `SELECT TABLE_NAME AS \`table\`, INDEX_NAME AS name, MAX(NON_UNIQUE) AS non_unique, MAX(INDEX_TYPE) AS method,
              GROUP_CONCAT(CONCAT('\`', REPLACE(COLUMN_NAME, '\`', '\`\`'), '\`', IF(SUB_PART IS NULL, '', CONCAT('(', SUB_PART, ')'))) ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS cols,
              GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR '\n') AS raw_cols
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME ORDER BY 1, 2`,
      [schema],
    );
    const keys = await session.all(
      `SELECT k.TABLE_NAME AS \`table\`, k.CONSTRAINT_NAME AS name, k.REFERENCED_TABLE_NAME AS ref_table, r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete,
              GROUP_CONCAT(CONCAT('\`', k.COLUMN_NAME, '\`') ORDER BY k.ORDINAL_POSITION SEPARATOR ', ') AS cols,
              GROUP_CONCAT(CONCAT('\`', k.REFERENCED_COLUMN_NAME, '\`') ORDER BY k.ORDINAL_POSITION SEPARATOR ', ') AS ref_cols,
              GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR '\n') AS raw_cols,
              GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR '\n') AS raw_ref_cols
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        GROUP BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.REFERENCED_TABLE_NAME, r.UPDATE_RULE, r.DELETE_RULE ORDER BY 1, 2`,
      [schema],
    );
    const views = await session.all('SELECT TABLE_NAME AS name, VIEW_DEFINITION AS definition FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY 1', [schema]);
    const tables = new Map();
    for (const row of columns) {
      const table = tables.get(row.table) ?? { name: row.table, columns: [], indexes: [], constraints: [] };
      if (row.name !== null) table.columns.push({ name: row.name, type: row.type, nullable: yes(row.nullable), default: row.default, extra: row.extra ?? '', comment: row.comment ?? '' });
      tables.set(row.table, table);
    }
    const foreign = new Set(keys.map((row) => `${row.table}\u0000${row.name}`));
    for (const row of statistics) {
      const table = tables.get(row.table);
      if (!table) continue;
      if (row.name === 'PRIMARY') table.key = String(row.raw_cols ?? '').split('\n').filter(Boolean);
      const fulltext = /FULLTEXT|SPATIAL/.test(row.method ?? '') ? `${row.method} ` : '';
      table.indexes.push({
        name: row.name,
        // The index MySQL makes to carry a foreign key comes and goes with the key.
        implied: foreign.has(`${row.table}\u0000${row.name}`),
        definition: row.name === 'PRIMARY' ? `PRIMARY KEY (${row.cols})` : `${fulltext || (yes(row.non_unique) ? '' : 'UNIQUE ')}INDEX ${quoteIdent('mysql', row.name)} (${row.cols})`,
      });
    }
    for (const row of keys) {
      const rule = (word, value) => (value && value !== 'NO ACTION' && value !== 'RESTRICT' ? ` ON ${word} ${value}` : '');
      tables.get(row.table)?.constraints.push({
        name: row.name,
        type: 'FOREIGN KEY',
        definition: `FOREIGN KEY (${row.cols}) REFERENCES ${quoteIdent('mysql', row.ref_table)} (${row.ref_cols})${rule('DELETE', row.on_delete)}${rule('UPDATE', row.on_update)}`,
        columns: String(row.raw_cols ?? '').split('\n').filter(Boolean),
        refSchema: schema,
        refTable: row.ref_table,
        refColumns: String(row.raw_ref_cols ?? '').split('\n').filter(Boolean),
      });
    }
    return {
      tables: [...tables.values()],
      views: views.map((row) => ({ name: row.name, kind: 'view', definition: String(row.definition ?? '').trim() })),
      sequences: [],
      routines: [],
    };
  },

  async metrics(session) {
    const rows = await session.all(
      `SELECT VARIABLE_NAME AS name, VARIABLE_VALUE AS value FROM performance_schema.global_status
        WHERE VARIABLE_NAME IN ('Threads_connected', 'Threads_running', 'Questions', 'Com_rollback', 'Innodb_rows_inserted', 'Innodb_rows_updated',
                                'Innodb_rows_deleted', 'Innodb_rows_read', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', 'Innodb_row_lock_current_waits')`,
    );
    const got = Object.fromEntries(rows.map((row) => [String(row.name).toLowerCase(), Number(row.value) || 0]));
    const reads = got.innodb_buffer_pool_reads ?? 0;
    return {
      at: Date.now(),
      sessions: got.threads_connected ?? 0,
      active: got.threads_running ?? 0,
      waiting: got.innodb_row_lock_current_waits ?? 0,
      // MySQL counts statements, not transactions: the chart says "queries" for it.
      commits: got.questions ?? 0,
      rollbacks: got.com_rollback ?? 0,
      inserted: got.innodb_rows_inserted ?? 0,
      updated: got.innodb_rows_updated ?? 0,
      deleted: got.innodb_rows_deleted ?? 0,
      fetched: got.innodb_rows_read ?? 0,
      returned: 0,
      blocks_read: reads,
      blocks_hit: Math.max(0, (got.innodb_buffer_pool_read_requests ?? 0) - reads),
    };
  },

  async databases(session) {
    const rows = await session.all(
      `SELECT s.SCHEMA_NAME AS name, s.DEFAULT_CHARACTER_SET_NAME AS encoding,
              (SELECT SUM(t.DATA_LENGTH + t.INDEX_LENGTH) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) AS size
         FROM information_schema.SCHEMATA s ORDER BY 1`,
    );
    return rows
      .map((row) => ({ name: row.name, owner: '', encoding: row.encoding, size: number(row.size), system: MYSQL_SYSTEM.has(String(row.name).toLowerCase()) }))
      .sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));
  },

  /** A database is a schema here; there is no level between it and its tables. */
  schemas: async () => [],

  async objects(session, schema) {
    const [relations, routines] = await Promise.all([
      session.all(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, TABLE_ROWS AS \`rows\`, DATA_LENGTH + INDEX_LENGTH AS size, TABLE_COMMENT AS comment
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1`,
        [schema],
      ),
      session.all(
        `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind, DTD_IDENTIFIER AS returns
           FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY 1`,
        [schema],
      ),
    ]);
    return {
      relations: relations.map((row) => ({
        name: row.name,
        kind: /VIEW/i.test(row.kind ?? '') ? 'view' : 'table',
        rows: number(row.rows),
        size: number(row.size),
        // MySQL writes "VIEW" in a view's comment; that is not a comment.
        comment: row.comment === 'VIEW' ? '' : row.comment ?? '',
        partitioned: false,
      })),
      routines: routines.map((row) => ({
        id: `${String(row.kind).toUpperCase()}:${row.name}`,
        name: row.name,
        args: '',
        returns: row.returns ?? '',
        kind: /PROCEDURE/i.test(row.kind ?? '') ? 'procedure' : 'function',
      })),
    };
  },

  async table(session, schema, name) {
    const [head] = await session.all(
      `SELECT TABLE_TYPE AS kind, TABLE_ROWS AS \`rows\`, DATA_LENGTH + INDEX_LENGTH AS size, INDEX_LENGTH AS index_size,
              TABLE_COMMENT AS comment, ENGINE AS engine, TABLE_COLLATION AS collation
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, name],
    );
    if (!head) throw new RdbError(`${schema}.${name} is not there any more`);
    const kind = /VIEW/i.test(head.kind ?? '') ? 'view' : 'table';
    const [columns, statistics, keys, referencedBy, triggers, checks] = await Promise.all([
      session.all(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS \`default\`,
                COLUMN_KEY AS \`key\`, EXTRA AS extra, COLUMN_COMMENT AS comment
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [schema, name],
      ),
      session.all(
        `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col, INDEX_TYPE AS method
           FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [schema, name],
      ),
      session.all(
        `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS ref_schema,
                k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_col, r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
           FROM information_schema.KEY_COLUMN_USAGE k
           LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
             ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [schema, name],
      ),
      session.all(
        `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, CONSTRAINT_NAME AS name,
                GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ', ') AS cols
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
          GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        [schema, name],
      ),
      session.all(
        `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS body
           FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY 1`,
        [schema, name],
      ),
      session.all(
        `SELECT CONSTRAINT_NAME AS name, CONSTRAINT_TYPE AS type
           FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY 2, 1`,
        [schema, name],
      ),
    ]);

    const byIndex = new Map();
    for (const row of statistics) {
      const index = byIndex.get(row.name) ?? { name: row.name, columns: [], unique: !yes(row.non_unique), primary: row.name === 'PRIMARY', method: row.method, size: null, definition: '' };
      index.columns.push(row.col);
      byIndex.set(row.name, index);
    }
    const indexes = [...byIndex.values()].map((index) => ({ ...index, columns: index.columns.join(', ') }));
    const key = byIndex.get('PRIMARY')?.columns ?? [];
    const byKey = new Map();
    for (const row of keys) {
      const fk = byKey.get(row.name) ?? { name: row.name, columns: [], refSchema: row.ref_schema, refTable: row.ref_table, refColumns: [], onUpdate: row.on_update, onDelete: row.on_delete };
      fk.columns.push(row.col);
      fk.refColumns.push(row.ref_col);
      byKey.set(row.name, fk);
    }
    const foreignKeys = [...byKey.values()].map((fk) => ({
      ...fk,
      definition: `FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.refTable}(${fk.refColumns.join(', ')})${fk.onDelete && fk.onDelete !== 'NO ACTION' && fk.onDelete !== 'RESTRICT' ? ` ON DELETE ${fk.onDelete}` : ''}${fk.onUpdate && fk.onUpdate !== 'NO ACTION' && fk.onUpdate !== 'RESTRICT' ? ` ON UPDATE ${fk.onUpdate}` : ''}`,
    }));

    let ddl = '';
    try {
      const [created] = await session.all(`SHOW CREATE ${kind === 'view' ? 'VIEW' : 'TABLE'} ${qualified('mysql', schema, name)}`);
      ddl = String(created?.['Create Table'] ?? created?.['Create View'] ?? '');
    } catch (error) {
      ddl = `-- ${String(error?.message ?? error)}`;
    }

    return {
      kind,
      key: kind === 'view' ? [] : key,
      columns: columns.map((row) => ({
        name: row.name,
        type: row.type,
        nullable: yes(row.nullable),
        default: row.default,
        comment: row.comment ?? '',
        pk: row.key === 'PRI',
        extra: row.extra ?? '',
      })),
      indexes,
      constraints: checks.map((row) => {
        const fk = byKey.get(row.name);
        const index = byIndex.get(row.name);
        return {
          name: row.name,
          type: row.type,
          definition: fk ? foreignKeys.find((one) => one.name === row.name).definition : index ? `(${index.columns.join(', ')})` : '',
        };
      }),
      foreignKeys,
      referencedBy: referencedBy.map((row) => ({ schema: row.schema, table: row.table, name: row.name, definition: `(${row.cols})` })),
      triggers: triggers.map((row) => ({ name: row.name, definition: `${row.timing} ${row.event}\n${row.body}` })),
      stats: {
        rows: number(head.rows),
        size: number(head.size),
        indexSize: number(head.index_size),
        owner: '',
        comment: head.comment === 'VIEW' ? '' : head.comment ?? '',
        engine: head.engine ?? '',
        collation: head.collation ?? '',
      },
      ddl,
    };
  },

  async routine(session, schema, id) {
    const [kind, ...rest] = String(id).split(':');
    const name = rest.join(':');
    if (kind !== 'PROCEDURE' && kind !== 'FUNCTION') throw new RdbError('That is not a routine');
    const [row] = await session.all(`SHOW CREATE ${kind} ${qualified('mysql', schema, name)}`);
    return { ddl: String(row?.[`Create ${kind === 'PROCEDURE' ? 'Procedure' : 'Function'}`] ?? '') };
  },

  activity: () => ({
    sql: `SELECT ID AS pid, USER AS \`user\`, DB AS \`database\`, HOST AS client, COMMAND AS command, STATE AS state,
                 TIME AS seconds, LEFT(INFO, 2000) AS query
            FROM information_schema.PROCESSLIST
           WHERE ID <> CONNECTION_ID()
           ORDER BY (COMMAND <> 'Sleep') DESC, TIME DESC`,
    key: 'pid',
  }),

  roles: () => 'SELECT User AS `user`, Host AS host, plugin FROM mysql.user ORDER BY 1, 2',

  async info(session) {
    const [row] = await session.all(
      `SELECT VERSION() AS version, CURRENT_USER() AS \`user\`, DATABASE() AS \`database\`, @@hostname AS host,
              @@max_connections AS max_connections,
              (SELECT COUNT(*) FROM information_schema.PROCESSLIST) AS connections`,
    );
    return row ?? {};
  },

  async kill(session, pid, hard) {
    const id = Number(pid);
    if (!Number.isInteger(id)) throw new RdbError('That is not a session id');
    await session.all(`KILL ${hard ? '' : 'QUERY '}${id}`);
    return true;
  },

  begin: (readOnly) => (readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION'),
};

// ───────────────────────────────────────────────────────────────── SQLite ──

class SqliteSession {
  constructor(config, db) {
    this.engine = 'sqlite';
    this.config = config;
    this.db = db;
    this.closed = false;
    this.txn = 'idle';
  }

  static async open(config) {
    const file = String(config.file ?? '');
    if (!file) throw new RdbError('This connection has no file');
    // Opening a path that is not there makes an empty database of it, which is never what a typo meant.
    if (!fs.existsSync(file)) throw new RdbError(`There is no file at ${file}`);
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch {
      throw new RdbError('This build has no SQLite');
    }
    try {
      const db = new DatabaseSync(file, { readOnly: Boolean(config.readOnly) });
      // Not a database at all is only found out by asking it something.
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return new SqliteSession(config, db);
    } catch (error) {
      throw explain(error, config);
    }
  }

  async all(sql, params = []) {
    try {
      const statement = this.db.prepare(sql);
      statement.setReadBigInts(true);
      return statement.all(...params).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)[0]])));
    } catch (error) {
      throw explain(error, this.config);
    }
  }

  /** One statement. It runs in this process, so the cap is kept by not asking for the next row. */
  async run(sql, params = [], { maxRows = 1000 } = {}) {
    try {
      const statement = this.db.prepare(sql);
      statement.setReadBigInts(true);
      const named = typeof statement.columns === 'function' ? statement.columns() : [];
      if (!named.length) {
        const done = statement.run(...params);
        this.txn = this.db.isTransaction ? 'open' : 'idle';
        const out = grid([], [], { rowCount: Number(done.changes ?? 0), command: '' });
        out.notices = [];
        return out;
      }
      const columns = named.map((column) => ({ name: column.name, type: String(column.type ?? '').toLowerCase() }));
      const rows = [];
      for (const row of statement.iterate(...params)) {
        rows.push(columns.map((column) => row[column.name]));
        if (rows.length > maxRows) break;
      }
      this.txn = this.db.isTransaction ? 'open' : 'idle';
      const out = grid(columns, rows, { maxRows });
      if (out.truncated) out.rowCount = null;
      out.notices = [];
      return out;
    } catch (error) {
      throw explain(error, this.config);
    }
  }

  async cancel() {
    return false;
  }

  async close() {
    this.closed = true;
    try { this.db.close(); } catch { /* already closed */ }
  }
}

const sqlite = {
  reports: (kind, args) => {
    if (kind === 'triggers' || kind === 'indexes') {
      return [{
        title: kind === 'triggers' ? 'Triggers' : 'Indexes',
        open: true,
        sql: `SELECT tbl_name AS "table", name, sql AS definition FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY 1, 2`,
        params: [kind === 'triggers' ? 'trigger' : 'index'],
      }];
    }
    if (kind !== 'search') return null;
    return [{
      title: 'Found',
      open: true,
      sql: `SELECT type AS kind, '' AS schema, name, CASE WHEN type = 'index' THEN tbl_name ELSE '' END AS "table"
              FROM sqlite_master WHERE name LIKE ? ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY (type = 'table') DESC, type, name LIMIT 300`,
      params: [`%${String(args?.q ?? '').replace(/[\\%_]/g, '\\$&')}%`],
    }];
  },
  /** What the file defines, each thing as the statement that made it — which is all SQLite keeps, and all it can be compared by. */
  async snapshot(session) {
    const rows = await session.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY name");
    const tables = rows.filter((row) => row.type === 'table').map((row) => ({ name: row.name, ddl: row.sql, columns: [], indexes: [], constraints: [] }));
    for (const row of rows.filter((one) => one.type === 'index')) tables.find((table) => table.name === row.tbl_name)?.indexes.push({ name: row.name, definition: row.sql });
    // What a diagram is drawn from: the columns, the key, and where each foreign key leads.
    for (const table of tables) {
      const info = await session.all('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid', [table.name]);
      table.columns = info.map((row) => ({ name: row.name, type: row.type ?? '', nullable: !yes(row.notnull), default: row.dflt_value, extra: '', comment: '' }));
      table.key = info.filter((row) => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((row) => row.name);
      const keys = await session.all('SELECT id, "table" AS ref_table, "from" AS col, "to" AS ref_col FROM pragma_foreign_key_list(?) ORDER BY id, seq', [table.name]);
      const byId = new Map();
      for (const row of keys) {
        const one = byId.get(row.id) ?? { name: `fk_${row.id}`, type: 'FOREIGN KEY', definition: '', columns: [], refSchema: null, refTable: row.ref_table, refColumns: [] };
        one.columns.push(row.col);
        if (row.ref_col) one.refColumns.push(row.ref_col);
        byId.set(row.id, one);
      }
      table.constraints = [...byId.values()];
    }
    return {
      tables,
      views: rows.filter((row) => row.type === 'view').map((row) => ({ name: row.name, kind: 'view', definition: row.sql, whole: true })),
      sequences: [],
      routines: rows.filter((row) => row.type === 'trigger').map((row) => ({ name: row.name, kind: 'trigger', definition: row.sql })),
    };
  },

  metrics: async () => null,
  databases: async () => [{ name: 'main', owner: '', encoding: '', size: null, system: false }],
  schemas: async () => [],

  async objects(session) {
    const rows = await session.all(
      `SELECT name, type AS kind FROM sqlite_master
        WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
    );
    return {
      relations: rows.map((row) => ({ name: row.name, kind: row.kind === 'view' ? 'view' : 'table', rows: null, size: null, comment: '', partitioned: false })),
      routines: [],
    };
  },

  async table(session, _schema, name) {
    const [head] = await session.all('SELECT type AS kind, sql FROM sqlite_master WHERE name = ? AND type IN (\'table\', \'view\')', [name]);
    if (!head) throw new RdbError(`${name} is not there any more`);
    const [columns, indexList, keys, others] = await Promise.all([
      session.all('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid', [name]),
      session.all('SELECT name, "unique", origin FROM pragma_index_list(?)', [name]),
      session.all('SELECT id, "table" AS ref_table, "from" AS col, "to" AS ref_col, on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq', [name]),
      session.all('SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN (\'index\', \'trigger\') ORDER BY name', [name]),
    ]);
    const indexes = [];
    for (const row of indexList) {
      const parts = await session.all('SELECT name FROM pragma_index_info(?) ORDER BY seqno', [row.name]);
      indexes.push({
        name: row.name,
        columns: parts.map((part) => part.name ?? '(expression)').join(', '),
        unique: yes(row.unique),
        primary: row.origin === 'pk',
        method: '',
        size: null,
        definition: others.find((other) => other.name === row.name)?.sql ?? '',
      });
    }
    const key = columns
      .filter((column) => Number(column.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((column) => column.name);
    const byKey = new Map();
    for (const row of keys) {
      const fk = byKey.get(row.id) ?? { name: `fk_${row.id}`, columns: [], refSchema: null, refTable: row.ref_table, refColumns: [], onUpdate: row.on_update, onDelete: row.on_delete };
      fk.columns.push(row.col);
      if (row.ref_col) fk.refColumns.push(row.ref_col);
      byKey.set(row.id, fk);
    }
    const foreignKeys = [...byKey.values()].map((fk) => ({
      ...fk,
      definition: `FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.refTable}(${fk.refColumns.join(', ')})`,
    }));
    const triggers = others.filter((other) => other.type === 'trigger').map((other) => ({ name: other.name, definition: other.sql ?? '' }));
    const indexSql = others.filter((other) => other.type === 'index' && other.sql).map((other) => `${other.sql};`);
    const kind = head.kind === 'view' ? 'view' : 'table';
    return {
      kind,
      key: kind === 'view' ? [] : key,
      columns: columns.map((row) => ({
        name: row.name,
        type: row.type ?? '',
        nullable: !yes(row.notnull),
        default: row.dflt_value,
        comment: '',
        pk: Number(row.pk) > 0,
        extra: '',
      })),
      indexes,
      constraints: [],
      foreignKeys,
      referencedBy: [],
      triggers,
      stats: { rows: null, size: null, indexSize: null, owner: '', comment: '' },
      ddl: [`${head.sql ?? ''};`, ...indexSql, ...triggers.map((trigger) => `${trigger.definition};`)].join('\n\n'),
    };
  },

  routine: async () => ({ ddl: '' }),
  activity: () => null,
  roles: () => null,

  async info(session) {
    const [row] = await session.all('SELECT sqlite_version() AS version');
    let size = null;
    try { size = fs.statSync(session.config.file).size; } catch { /* it was there a moment ago */ }
    return { version: `SQLite ${row?.version ?? ''}`, file: session.config.file, size };
  },

  kill: async () => false,
  begin: () => 'BEGIN',
};

const SESSIONS = { postgres: PgSession, mysql: MysqlSession, sqlite: SqliteSession };
const CATALOGS = { postgres, mysql, sqlite };

/** Open a connection. `config` carries the password in the clear and is never kept past this call's session. */
function open(config) {
  const Session = SESSIONS[config?.engine];
  if (!Session) throw new RdbError(`"${String(config?.engine ?? '')}" is not a database this app connects to`);
  return Session.open(config);
}

function catalog(engine) {
  const found = CATALOGS[engine];
  if (!found) throw new RdbError(`"${String(engine ?? '')}" is not a database this app connects to`);
  return found;
}

module.exports = { open, catalog, cell, grid, explain, RdbError, CELL_MAX };
