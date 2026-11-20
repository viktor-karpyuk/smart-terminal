'use strict';

/**
 * Stepping through a PL/pgSQL function.
 *
 * PostgreSQL cannot do this by itself: it is the `pldbgapi` extension that
 * can, with its plugin loaded into the server at start. What it offers is a
 * conversation between two connections. One, the target, is told to stop on a
 * function and then calls it — and that call does not come back until the
 * function has run to its end. The other, the debugger, is told where the
 * target is waiting, and from then on asks it to take a step, to carry on, or
 * what its variables hold.
 *
 * So a debugging run is two sessions that belong to nobody else, and they are
 * held here rather than among the connections a panel shares: a target frozen
 * on line six must not be the connection the tree is read through.
 *
 * Two things the extension does that are worth knowing before reading on. The
 * line it reports after a step is one more than the line it means, while the
 * stack it gives is right — so the stack is where the line is read from. And
 * when the function ends there is no "finished" answer: the step fails because
 * the target has gone, and the call on the other connection comes back.
 */

const { quoteIdent } = require('./rdb-sql');

/** How long the target may take to reach the function's first line. */
const BREAK_MS = 15000;

class DebugError extends Error {}

const yes = (value) => value === true || value === 't' || value === 'true';

/**
 * What there is to know about a routine before stepping through it: whether
 * the server can, and what the routine takes.
 */
async function describe(session, oid) {
  const [row] = await session.all(
    `SELECT p.proname AS name, n.nspname AS schema, l.lanname AS language, coalesce(to_jsonb(p)->>'prokind', 'f') AS kind, p.proretset AS returns_set,
            pg_catalog.format_type(p.prorettype, NULL) AS returns,
            (SELECT array_to_json(array_agg(pg_catalog.format_type(t.oid, NULL) ORDER BY a.ord))
               FROM unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY a(oid, ord) JOIN pg_catalog.pg_type t ON t.oid = a.oid) AS types,
            array_to_json(p.proargnames) AS names, array_to_json(p.proargmodes) AS modes, p.pronargdefaults AS defaults,
            (SELECT x.nspname FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace x ON x.oid = e.extnamespace WHERE e.extname = 'pldbgapi') AS api,
            current_setting('shared_preload_libraries') AS preloaded
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE p.oid = $1::oid`,
    [String(oid)],
  );
  if (!row) throw new DebugError('That routine is not there any more');
  const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value) ?? [];
  const types = parse(row.types);
  const names = parse(row.names);
  const modes = parse(row.modes);
  const args = types.map((type, index) => ({ name: names[index] || `$${index + 1}`, type, mode: modes[index] ?? 'i' }));
  // The trailing inputs are the ones with defaults.
  const inputs = args.filter((arg) => arg.mode === 'i' || arg.mode === 'b' || arg.mode === 'v');
  const defaults = Number(row.defaults) || 0;
  inputs.forEach((arg, index) => { arg.optional = index >= inputs.length - defaults; });
  let cannot = '';
  if (row.language !== 'plpgsql') cannot = `This is written in ${row.language}. Only PL/pgSQL can be stepped through.`;
  else if (!row.api) cannot = 'The debugger is not installed in this database. It is the pldbgapi extension: CREATE EXTENSION pldbgapi, as a superuser.';
  else if (!/\bplugin_debugger\b/.test(String(row.preloaded ?? ''))) cannot = 'The debugger is installed but not loaded: add plugin_debugger to shared_preload_libraries and restart the server.';
  else if (row.kind !== 'f' && row.kind !== 'p') cannot = 'Only functions and procedures can be stepped through.';
  return {
    oid: String(oid),
    name: row.name,
    schema: row.schema,
    kind: row.kind === 'p' ? 'procedure' : 'function',
    returns: row.returns,
    returnsSet: yes(row.returns_set),
    args,
    api: row.api ?? null,
    cannot,
  };
}

/**
 * The call that runs a routine with what somebody typed. Values go as
 * parameters and are cast to the type the routine declares, so nothing typed
 * is ever part of the statement. A procedure's OUT arguments are places, not
 * values, and are given nothing.
 */
function callStatement(info, values) {
  const params = [];
  const parts = [];
  let given = 0;
  for (const arg of info.args) {
    const input = arg.mode === 'i' || arg.mode === 'b' || arg.mode === 'v';
    if (!input) {
      if (info.kind === 'procedure' && arg.mode === 'o') parts.push('NULL');
      continue;
    }
    const value = values?.[given];
    given += 1;
    // Left out, with a default: the routine's own default stands. Every one after it must be left out too.
    if ((value === undefined || value === null) && arg.optional && values?.slice(given).every((one) => one === undefined || one === null)) break;
    params.push(value === undefined ? null : value);
    parts.push(`${arg.mode === 'v' ? 'VARIADIC ' : ''}$${params.length}::${arg.type}`);
  }
  const name = `${quoteIdent('postgres', info.schema)}.${quoteIdent('postgres', info.name)}`;
  return { sql: info.kind === 'procedure' ? `CALL ${name}(${parts.join(', ')})` : `SELECT * FROM ${name}(${parts.join(', ')})`, params };
}

/**
 * One run of one routine under the debugger.
 *
 * `target` and `control` are two driver sessions on the same database that
 * nothing else uses. `control.all` asks; `target.run` makes the call.
 */
class DebugRun {
  constructor({ target, control, info }) {
    this.target = target;
    this.control = control;
    this.info = info;
    this.api = quoteIdent('postgres', info.api);
    this.handle = null;
    /** What the call came back with, once it has: `{ result }` or `{ error }`. */
    this.outcome = null;
    this.sources = new Map();
    /** Whether a step has been asked for and has not answered. */
    this.stepping = false;
    this.used = Date.now();
  }

  async start(values) {
    const { sql, params } = callStatement(this.info, values);
    await this.target.all(`SELECT ${this.api}.plpgsql_oid_debug($1::oid)`, [this.info.oid]);
    this.call = this.target.run(sql, params, { maxRows: 200 }).then(
      (result) => { this.outcome = { result }; },
      (error) => { this.outcome = { error }; },
    );
    // The target says where it is waiting in a notice, on the connection that is busy making the call.
    const deadline = Date.now() + BREAK_MS;
    let port = null;
    while (port === null && !this.outcome && Date.now() < deadline) {
      for (const notice of this.target.notices ?? []) {
        const found = /PLDBGBREAK:(\d+)/.exec(notice);
        if (found) port = Number(found[1]);
      }
      if (port === null) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (port === null) {
      if (this.outcome) return this.state();
      throw new DebugError('The server did not stop on the function. Is plugin_debugger loaded?');
    }
    const [row] = await this.control.all(`SELECT ${this.api}.pldbg_attach_to_port($1::int) AS handle`, [port]);
    this.handle = Number(row.handle);
    return this.state();
  }

  /** `into`, `over` or `continue`. Whatever the extension answers, where the target is now is read from its stack. */
  async step(action) {
    this.used = Date.now();
    if (this.outcome) return this.state();
    const name = { into: 'pldbg_step_into', over: 'pldbg_step_over', continue: 'pldbg_continue' }[action];
    if (!name) throw new DebugError('That is not a step');
    /*
     * Whichever comes first: the step answering, or the call coming back. When
     * the function ends the extension has no answer to give — sometimes the
     * step fails because the target has gone, and sometimes it simply never
     * returns — so the end is known by the call, not by the step.
     */
    this.stepping = true;
    const stepped = this.control.all(`SELECT * FROM ${this.api}.${name}($1::int)`, [this.handle]).then(
      () => { this.stepping = false; return null; },
      (error) => { this.stepping = false; return error; },
    );
    const failed = await Promise.race([stepped, this.call.then(() => null)]);
    if (failed && !this.outcome) {
      await Promise.race([this.call, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (!this.outcome) throw failed;
    }
    return this.state();
  }

  async breakpoint(func, line, on) {
    this.used = Date.now();
    if (this.outcome) return this.state();
    const number = Number(line);
    if (!Number.isInteger(number) || number < 1) throw new DebugError('A breakpoint goes on a line');
    await this.control.all(`SELECT ${this.api}.${on ? 'pldbg_set_breakpoint' : 'pldbg_drop_breakpoint'}($1::int, $2::oid, $3::int)`, [this.handle, String(func), number]);
    return this.state();
  }

  async #source(func) {
    if (!this.sources.has(func)) {
      const [row] = await this.control.all(`SELECT ${this.api}.pldbg_get_source($1::int, $2::oid) AS source`, [this.handle, func]);
      this.sources.set(func, String(row?.source ?? ''));
    }
    return this.sources.get(func);
  }

  /** Where the run is: the stack, the source of the function on top of it, its variables and the breakpoints — or how it ended. */
  async state() {
    if (this.outcome) {
      if (this.outcome.error) return { done: true, error: String(this.outcome.error.message ?? this.outcome.error), detail: this.outcome.error.detail ?? '', notices: this.target.notices ?? [] };
      return { done: true, result: this.outcome.result, notices: this.outcome.result?.notices ?? [] };
    }
    try {
      const stack = (await this.control.all(`SELECT level, targetname, func, linenumber, args FROM ${this.api}.pldbg_get_stack($1::int) ORDER BY level`, [this.handle]))
        .map((row) => ({ level: Number(row.level), name: row.targetname, func: String(row.func), line: Number(row.linenumber), args: row.args ?? '' }));
      const top = stack[0] ?? { func: this.info.oid, line: 0 };
      const variables = (await this.control.all(
        `SELECT name, varclass, linenumber, isconst, pg_catalog.format_type(dtype, NULL) AS type, value FROM ${this.api}.pldbg_get_variables($1::int)`,
        [this.handle],
      )).map((row) => ({ name: row.name, kind: row.varclass === 'A' ? 'argument' : 'local', line: Number(row.linenumber), type: row.type, value: row.value }));
      const breakpoints = (await this.control.all(`SELECT func, linenumber FROM ${this.api}.pldbg_get_breakpoints($1::int)`, [this.handle]))
        .map((row) => ({ func: String(row.func), line: Number(row.linenumber) }))
        // The one with no line is "stop when this function is entered", which is how the run began.
        .filter((one) => one.line > 0);
      return { done: false, func: top.func, line: top.line, stack, source: await this.#source(top.func), variables, breakpoints };
    } catch (error) {
      // It ended between the step and the question.
      await Promise.race([this.call, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (this.outcome) return this.state();
      throw error;
    }
  }

  /** Stop it wherever it is. The target is told to give up, and both connections are let go either way. */
  async stop() {
    // A step still waiting for a target that has gone would hold its connection open on the server: it is told to stop first.
    if (this.stepping) await Promise.race([this.control.cancel?.().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
    try {
      if (this.handle !== null && !this.outcome) {
        await Promise.race([
          this.control.all(`SELECT * FROM ${this.api}.pldbg_abort_target($1::int)`, [this.handle]),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
    } catch { /* it had already ended */ }
    await Promise.allSettled([this.control.close(), this.target.close()]);
  }
}

module.exports = { DebugRun, DebugError, describe, callStatement };
