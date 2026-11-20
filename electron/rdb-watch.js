'use strict';

/**
 * Watching a server over time.
 *
 * The Performance page answers "what is slow now". This answers what that page
 * cannot: what changed. A reading is taken every few minutes from the servers
 * somebody asked to have watched, kept on this computer for a week, and each
 * one is judged against the ones before it — so a statement that got three
 * times slower since yesterday, a lock nobody has let go of, or a transaction
 * counter halfway to wrapping round is said while there is still time to do
 * something about it, not found afterwards.
 *
 * Everything here is pure, or is SQL: reading a server and keeping the reading
 * are the service's and the store's. That is what lets every rule be tested
 * with a handful of numbers and no server.
 */

/** How often a watched server is read. Often enough to see a bad hour; seldom enough to be nothing to the server. */
const WATCH_EVERY_MS = 5 * 60 * 1000;
/** How long readings are kept. */
const WATCH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How many statements a reading remembers the counters of. */
const WATCH_STATEMENTS = 60;
/** How many points a chart is given, whatever the window. */
const TREND_POINTS = 100;

/**
 * One reading of a PostgreSQL server, as one row. The counters are the
 * server's running totals: what happened between two readings is the
 * difference, which is why a reading alone says little.
 */
const PG_SERVER = `
  SELECT (SELECT count(*) FROM pg_catalog.pg_stat_activity a WHERE a.backend_type = 'client backend') AS sessions,
         (SELECT setting::int FROM pg_catalog.pg_settings WHERE name = 'max_connections') AS max_connections,
         (SELECT count(*) FROM pg_catalog.pg_stat_activity a WHERE a.backend_type = 'client backend' AND a.state = 'active' AND a.pid <> pg_backend_pid()) AS active,
         (SELECT count(*) FROM pg_catalog.pg_stat_activity a WHERE a.state LIKE 'idle in transaction%') AS idle_tx,
         (SELECT count(*) FROM pg_catalog.pg_stat_activity a WHERE cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0) AS blocked,
         (SELECT coalesce(max(extract(epoch FROM now() - a.query_start)), 0)::bigint FROM pg_catalog.pg_stat_activity a
           WHERE a.backend_type = 'client backend' AND a.state = 'active' AND a.pid <> pg_backend_pid()) AS longest_active_s,
         (SELECT coalesce(max(extract(epoch FROM now() - a.state_change)), 0)::bigint FROM pg_catalog.pg_stat_activity a
           WHERE a.state LIKE 'idle in transaction%') AS longest_idle_tx_s,
         d.xact_commit AS commits, d.xact_rollback AS rollbacks, d.blks_read, d.blks_hit, d.temp_bytes, d.deadlocks,
         pg_catalog.pg_database_size(d.datid) AS size, pg_catalog.age(b.datfrozenxid) AS xid_age,
         (SELECT coalesce(sum(t.n_dead_tup), 0) FROM pg_catalog.pg_stat_user_tables t) AS dead,
         (SELECT coalesce(sum(t.n_live_tup), 0) FROM pg_catalog.pg_stat_user_tables t) AS live
    FROM pg_catalog.pg_stat_database d JOIN pg_catalog.pg_database b ON b.oid = d.datid
   WHERE d.datname = current_database()`;

const PG_HAS_STATEMENTS = "SELECT pg_catalog.to_regclass('pg_stat_statements') IS NOT NULL AS there";

/** Summed over the roles that ran it: the question is what the statement costs, not who paid. */
const PG_STATEMENTS = `
  SELECT s.queryid::text AS qid, left(max(s.query), 2000) AS text, sum(s.calls) AS calls, sum(s.total_exec_time) AS ms, sum(s.rows) AS rows
    FROM pg_stat_statements s
   WHERE s.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) AND s.queryid IS NOT NULL
     AND s.query NOT LIKE '%pg\\_catalog.%' AND s.query !~* '^\\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|SET|SHOW|RESET)\\M'
   GROUP BY s.queryid ORDER BY sum(s.total_exec_time) DESC LIMIT ${WATCH_STATEMENTS}`;

const MYSQL_STATUS = `
  SELECT VARIABLE_NAME AS name, VARIABLE_VALUE AS value FROM performance_schema.global_status
   WHERE VARIABLE_NAME IN ('Threads_connected', 'Threads_running', 'Com_commit', 'Com_rollback', 'Questions', 'Innodb_buffer_pool_reads',
                           'Innodb_buffer_pool_read_requests', 'Innodb_row_lock_current_waits', 'Created_tmp_disk_tables', 'Innodb_deadlocks')
  UNION ALL SELECT 'max_connections', @@GLOBAL.max_connections
  UNION ALL SELECT 'longest_active_s', COALESCE(MAX(TIME), 0) FROM information_schema.PROCESSLIST
             WHERE COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump', 'Binlog Dump GTID') AND ID <> CONNECTION_ID()
  UNION ALL SELECT 'idle_tx', COUNT(*) FROM information_schema.INNODB_TRX WHERE trx_started < NOW() - INTERVAL 1 MINUTE
  UNION ALL SELECT 'longest_idle_tx_s', COALESCE(MAX(TIMESTAMPDIFF(SECOND, trx_started, NOW())), 0) FROM information_schema.INNODB_TRX
  UNION ALL SELECT 'size', COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`;

const MYSQL_STATEMENTS = `
  SELECT DIGEST AS qid, LEFT(DIGEST_TEXT, 2000) AS text, COUNT_STAR AS calls, SUM_TIMER_WAIT / 1e9 AS ms, SUM_ROWS_SENT AS \`rows\`
    FROM performance_schema.events_statements_summary_by_digest
   WHERE SCHEMA_NAME = DATABASE() AND DIGEST IS NOT NULL AND DIGEST_TEXT NOT REGEXP '^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|SET|SHOW)( |$)' AND DIGEST_TEXT NOT LIKE '%performance\\_schema%' AND DIGEST_TEXT NOT LIKE '%information\\_schema%'
   ORDER BY SUM_TIMER_WAIT DESC LIMIT ${WATCH_STATEMENTS}`;

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Read a server once. `session` is a driver session; the answer is the same
 * shape for both engines, with a null where an engine has nothing to say.
 */
async function collect(engine, session) {
  const at = Date.now();
  if (engine === 'postgres') {
    const row = (await session.all(PG_SERVER))[0] ?? {};
    const server = { at };
    for (const key of ['sessions', 'max_connections', 'active', 'idle_tx', 'blocked', 'longest_active_s', 'longest_idle_tx_s', 'commits', 'rollbacks',
      'blks_read', 'blks_hit', 'temp_bytes', 'deadlocks', 'size', 'xid_age', 'dead', 'live']) server[key] = number(row[key]);
    const has = (await session.all(PG_HAS_STATEMENTS))[0]?.there;
    const tracked = has === true || has === 't';
    const statements = tracked ? await session.all(PG_STATEMENTS) : [];
    return { server: { ...server, tracked }, statements: statements.map(statementRow) };
  }
  if (engine === 'mysql') {
    const got = Object.fromEntries((await session.all(MYSQL_STATUS)).map((row) => [String(row.name).toLowerCase(), number(row.value)]));
    const reads = got.innodb_buffer_pool_reads ?? 0;
    const server = {
      at,
      sessions: got.threads_connected ?? 0,
      max_connections: got.max_connections ?? 0,
      active: Math.max(0, (got.threads_running ?? 0) - 1),
      idle_tx: got.idle_tx ?? 0,
      blocked: got.innodb_row_lock_current_waits ?? 0,
      longest_active_s: got.longest_active_s ?? 0,
      longest_idle_tx_s: got.longest_idle_tx_s ?? 0,
      // MySQL counts every statement; commits alone miss everything run with autocommit, which is most of it.
      commits: got.questions ?? 0,
      rollbacks: got.com_rollback ?? 0,
      blks_read: reads,
      blks_hit: Math.max(0, (got.innodb_buffer_pool_read_requests ?? 0) - reads),
      temp_bytes: 0,
      deadlocks: got.innodb_deadlocks ?? 0,
      size: got.size ?? 0,
      xid_age: null,
      dead: null,
      live: null,
      tracked: true,
    };
    let statements = [];
    try { statements = await session.all(MYSQL_STATEMENTS); } catch { server.tracked = false; }
    return { server, statements: statements.map(statementRow) };
  }
  return null;
}

function statementRow(row) {
  return { qid: String(row.qid), text: String(row.text ?? ''), calls: number(row.calls), ms: number(row.ms), rows: number(row.rows) };
}

const seconds = (n) => {
  if (n >= 7200) return `${Math.round(n / 3600)} hours`;
  if (n >= 120) return `${Math.round(n / 60)} minutes`;
  return `${Math.round(n)} seconds`;
};

const millis = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : n >= 10 ? `${Math.round(n)} ms` : `${n.toFixed(1)} ms`);

const bytes = (n) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

const short = (text, max = 140) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * What a statement cost between two readings, per statement that ran in
 * between. Counters that went backwards were reset — a restart, or somebody
 * clearing the statistics — and say nothing about the interval.
 */
function statementDeltas(before, after) {
  const was = new Map((before ?? []).map((one) => [one.qid, one]));
  const out = [];
  for (const now of after ?? []) {
    const then = was.get(now.qid);
    if (!then) continue;
    const calls = now.calls - then.calls;
    const ms = now.ms - then.ms;
    if (calls <= 0 || ms < 0) continue;
    out.push({ qid: now.qid, text: now.text, calls, ms, mean: ms / calls });
  }
  return out;
}

/**
 * What is worth saying about this reading.
 *
 * `history` is the readings before it, oldest first, each `{ server, statements }`.
 * The answer is a list of `{ rule, subject, message }`: a rule and a subject
 * together name one thing that is wrong, so the same lock reported five
 * minutes later is the same alert and not a second one.
 *
 * Every rule is about something a person can act on, and each threshold is
 * set where acting early is cheap and late is not. Nothing here is a number
 * that is merely high.
 */
function judge(history, reading) {
  const found = [];
  const say = (rule, subject, message) => found.push({ rule, subject: String(subject), message });
  const now = reading.server;
  const last = history.at(-1) ?? null;
  const before = last?.server ?? null;

  // Twice in a row: a lock held for a moment is how databases work; one still held five minutes later is somebody stuck.
  if (now.blocked > 0 && before && before.blocked > 0) {
    say('blocked', '', `${now.blocked} session${now.blocked === 1 ? ' has' : 's have'} been waiting on a lock for two readings in a row. The Locks page says who holds it.`);
  }
  if (now.longest_active_s > 300) say('long_query', '', `A statement has been running for ${seconds(now.longest_active_s)}. The Activity page says which.`);
  if (now.longest_idle_tx_s > 300) {
    say('idle_transaction', '', `A transaction has been open and doing nothing for ${seconds(now.longest_idle_tx_s)}. It keeps its locks, and on PostgreSQL it stops vacuum from cleaning up behind it.`);
  }
  if (now.max_connections > 0 && now.sessions >= 0.85 * now.max_connections) {
    say('connections', '', `${now.sessions} of ${now.max_connections} connections are in use. When they run out, new ones are refused.`);
  }
  if (now.xid_age !== null && now.xid_age > 1_000_000_000) {
    say('wraparound', '', `Transaction ids are ${Math.round(now.xid_age / 20_000_000)}% of the way to wrapping round. Past 100% the server stops taking writes until it has been vacuumed: find the tables autovacuum is not getting to.`);
  }
  if (now.dead !== null && now.dead > 100_000 && now.dead > 0.2 * (now.dead + now.live)) {
    say('dead_rows', '', `${Math.round((100 * now.dead) / (now.dead + now.live))}% of the rows in this database are dead ones waiting to be cleaned. The Performance page lists the tables.`);
  }
  if (before && now.at > before.at) {
    const deadlocks = now.deadlocks - before.deadlocks;
    if (deadlocks > 0) say('deadlocks', '', `${deadlocks} deadlock${deadlocks === 1 ? '' : 's'} since the last reading. Two transactions took the same locks in opposite orders; the server's log names them.`);
    const read = now.blks_read - before.blks_read;
    const hit = now.blks_hit - before.blks_hit;
    // Only when it was busy: a quiet server reading one cold table is not short of memory.
    if (read >= 0 && hit >= 0 && read + hit > 50_000 && hit / (read + hit) < 0.9) {
      say('cache', '', `Only ${Math.round((100 * hit) / (read + hit))}% of what was read came from memory since the last reading. On a busy server that is memory too small for the work.`);
    }
  }

  // A statement that got slower: its cost per call over this interval against the same over the history before it.
  if (last && history.length >= 3) {
    const first = history[0];
    const baseline = new Map(statementDeltas(first.statements, last.statements).map((one) => [one.qid, one]));
    for (const recent of statementDeltas(last.statements, reading.statements)) {
      const usual = baseline.get(recent.qid);
      // Enough calls on both sides to be an average, and enough time lost to matter.
      if (!usual || usual.calls < 20 || recent.calls < 5 || recent.ms < 1000) continue;
      if (recent.mean >= 3 * usual.mean && recent.mean - usual.mean >= 5) {
        say('slower', recent.qid, `A statement that took ${millis(usual.mean)} a call now takes ${millis(recent.mean)}: ${short(recent.text)}`);
      }
    }
  }

  // Where it is heading: the size a day ago against now, carried forward.
  const dayAgo = history.find((one) => now.at - one.server.at <= 26 * 3600_000 && now.at - one.server.at >= 22 * 3600_000);
  if (dayAgo && dayAgo.server.size > 100 * 1024 * 1024 && now.size > dayAgo.server.size) {
    const perDay = (now.size - dayAgo.server.size) / ((now.at - dayAgo.server.at) / 86_400_000);
    const days = now.size / perDay;
    if (days < 30) say('growth', '', `This database grew ${bytes(perDay)} in the last day and is ${bytes(now.size)}. At that rate it doubles in ${Math.max(1, Math.round(days))} days.`);
  }
  return found;
}

/**
 * Readings as a chart wants them: at most a hundred points, each the rate or
 * the level over its stretch of time.
 */
function trend(readings, points = TREND_POINTS) {
  if (readings.length < 2) return [];
  const steps = [];
  for (let i = 1; i < readings.length; i += 1) {
    const a = readings[i - 1];
    const b = readings[i];
    const secs = (b.at - a.at) / 1000;
    if (secs <= 0) continue;
    const rate = (key) => {
      const moved = b[key] - a[key];
      return moved >= 0 ? moved / secs : 0;
    };
    const read = Math.max(0, b.blks_read - a.blks_read);
    const hit = Math.max(0, b.blks_hit - a.blks_hit);
    steps.push({
      at: b.at,
      sessions: b.sessions,
      active: b.active,
      blocked: b.blocked,
      commits: rate('commits'),
      rollbacks: rate('rollbacks'),
      // Milliseconds of statement time per second of clock: 1000 is one statement running flat out.
      load: number(b.interval_ms) / secs,
      cache: read + hit > 0 ? (100 * hit) / (read + hit) : 100,
      size: b.size,
      dead: b.dead ?? 0,
    });
  }
  if (steps.length <= points) return steps;
  const out = [];
  const per = steps.length / points;
  for (let i = 0; i < points; i += 1) {
    const slice = steps.slice(Math.floor(i * per), Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1));
    const mean = (key) => slice.reduce((sum, one) => sum + one[key], 0) / slice.length;
    const peak = (key) => Math.max(...slice.map((one) => one[key]));
    out.push({
      at: slice.at(-1).at,
      // Levels are shown at their worst in the stretch: a spike averaged away is a spike nobody sees.
      sessions: peak('sessions'), active: peak('active'), blocked: peak('blocked'),
      commits: mean('commits'), rollbacks: mean('rollbacks'), load: mean('load'), cache: Math.min(...slice.map((one) => one.cache)),
      size: slice.at(-1).size, dead: slice.at(-1).dead,
    });
  }
  return out;
}

/**
 * The statements of a window, with what each cost in it and whether that is
 * more or less a call than in the window before.
 *
 * `rows` are the kept counters, oldest first: `{ at, qid, calls, ms }`.
 */
function statementTrends(rows, texts, from, until) {
  // Halved where the readings are, not where the window is: a server watched since this morning has no first half of a week.
  const inside = rows.filter((row) => row.at >= from && row.at <= until);
  const middle = inside.length ? (inside[0].at + inside.at(-1).at) / 2 : from;
  const byQid = new Map();
  for (const row of inside) {
    const list = byQid.get(row.qid) ?? [];
    list.push(row);
    byQid.set(row.qid, list);
  }
  const out = [];
  for (const [qid, list] of byQid) {
    if (list.length < 2) continue;
    // Summed step by step, so a reset in the middle loses one interval and not the whole window.
    const sum = (part) => {
      let calls = 0;
      let ms = 0;
      for (let i = 1; i < part.length; i += 1) {
        const dc = part[i].calls - part[i - 1].calls;
        const dm = part[i].ms - part[i - 1].ms;
        if (dc > 0 && dm >= 0) { calls += dc; ms += dm; }
      }
      return { calls, ms };
    };
    const whole = sum(list);
    if (whole.calls === 0) continue;
    const early = sum(list.filter((row) => row.at <= middle));
    const late = sum(list.filter((row) => row.at >= middle));
    const meanBefore = early.calls >= 5 ? early.ms / early.calls : null;
    const meanNow = late.calls >= 5 ? late.ms / late.calls : null;
    out.push({
      qid,
      text: texts.get(qid) ?? '',
      calls: whole.calls,
      ms: whole.ms,
      mean: whole.ms / whole.calls,
      meanBefore,
      meanNow,
      change: meanBefore !== null && meanNow !== null && meanBefore > 0 ? meanNow / meanBefore : null,
    });
  }
  return out.sort((a, b) => b.ms - a.ms);
}

module.exports = {
  WATCH_EVERY_MS, WATCH_KEEP_MS, WATCH_STATEMENTS, TREND_POINTS,
  collect, judge, trend, statementDeltas, statementTrends,
};
