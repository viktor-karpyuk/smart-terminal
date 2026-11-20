'use strict';

/**
 * Stepping through a PL/pgSQL routine.
 *
 * The extension that does it is not on a test machine, so the two connections
 * here are stand-ins that answer the way the real one was seen to. What is
 * held is what the app adds: that nothing typed for an argument is ever part of
 * the statement, that the end of a run is known by the call coming back — the
 * step itself sometimes fails and sometimes never answers — and that a run
 * that is stopped lets go of both connections.
 */

const test = require('node:test');
const assert = require('node:assert');

const { DebugRun, describe, callStatement } = require('../electron/rdb-debug');

const FN = {
  oid: '16702', name: 'order_total', schema: 'public', kind: 'function', api: 'public',
  args: [{ name: 'p_customer', type: 'integer', mode: 'i', optional: false }, { name: 'p_bonus', type: 'numeric', mode: 'i', optional: true }],
};

test('what was typed goes as parameters, cast to what the routine declares', () => {
  assert.deepEqual(callStatement(FN, ['5', '1.5']), { sql: 'SELECT * FROM "public"."order_total"($1::integer, $2::numeric)', params: ['5', '1.5'] });
  // Left out with a default: the routine's own default stands.
  assert.deepEqual(callStatement(FN, ['5', null]), { sql: 'SELECT * FROM "public"."order_total"($1::integer)', params: ['5'] });
  assert.deepEqual(callStatement(FN, ['5']), { sql: 'SELECT * FROM "public"."order_total"($1::integer)', params: ['5'] });
  // Nothing typed where there is no default is NULL, said as a parameter.
  assert.deepEqual(callStatement(FN, [null, '2']), { sql: 'SELECT * FROM "public"."order_total"($1::integer, $2::numeric)', params: [null, '2'] });
  // Whatever is typed, it is a value.
  const nasty = callStatement(FN, ["1); DROP TABLE orders; --", '0']);
  assert.equal(nasty.sql, 'SELECT * FROM "public"."order_total"($1::integer, $2::numeric)');
  assert.equal(nasty.params[0], '1); DROP TABLE orders; --');
  // A name is quoted, however it was made.
  assert.match(callStatement({ ...FN, schema: 'we"ird', name: 'Fn', args: [] }, []).sql, /^SELECT \* FROM "we""ird"\."Fn"\(\)$/);

  const proc = { oid: '1', name: 'note_it', schema: 'public', kind: 'procedure', api: 'public',
    args: [{ name: 'p_text', type: 'text', mode: 'i', optional: false }, { name: 'p_out', type: 'integer', mode: 'o' }, { name: 'p_count', type: 'integer', mode: 'b', optional: true }] };
  // A procedure's OUT argument is a place and is given nothing; a function's is not an argument at all.
  assert.deepEqual(callStatement(proc, ['hello', '2']), { sql: 'CALL "public"."note_it"($1::text, NULL, $2::integer)', params: ['hello', '2'] });
  assert.equal(callStatement({ ...proc, kind: 'function' }, ['hello', '2']).sql, 'SELECT * FROM "public"."note_it"($1::text, $2::integer)');
  assert.equal(callStatement({ ...FN, args: [{ name: 'rest', type: 'integer[]', mode: 'v' }] }, ['{1,2}']).sql, 'SELECT * FROM "public"."order_total"(VARIADIC $1::integer[])');
});

test('a routine that cannot be stepped through says why, and what would make it so', async () => {
  const row = { name: 'f', schema: 'public', language: 'plpgsql', kind: 'f', returns_set: 'f', returns: 'integer', types: '["integer","numeric","text"]', names: '["a","b","c"]', modes: null, defaults: '1', api: 'public', preloaded: 'pg_stat_statements, plugin_debugger' };
  const ask = (over) => describe({ all: async () => [{ ...row, ...over }] }, '1');
  const ok = await ask({});
  assert.equal(ok.cannot, '');
  assert.deepEqual(ok.args.map((arg) => [arg.name, arg.type, arg.mode, arg.optional]), [['a', 'integer', 'i', false], ['b', 'numeric', 'i', false], ['c', 'text', 'i', true]]);
  assert.match((await ask({ language: 'sql' })).cannot, /written in sql/);
  assert.match((await ask({ api: null })).cannot, /CREATE EXTENSION pldbgapi/);
  assert.match((await ask({ preloaded: 'pg_stat_statements' })).cannot, /add plugin_debugger to shared_preload_libraries/);
  assert.match((await ask({ kind: 'a' })).cannot, /Only functions and procedures/);
  await assert.rejects(describe({ all: async () => [] }, '1'), /not there any more/);
});

/** Two connections that behave as the extension was seen to: a call that waits, and steps that move a line at a time. */
function pair({ lines = [6, 7, 10], hangAtEnd = false, fail = null } = {}) {
  let at = 0;
  let finish;
  const asked = [];
  const target = {
    notices: [],
    closed: false,
    all: async (text) => { asked.push(text); return [{}]; },
    run: (text, params) => {
      asked.push([text, params]);
      target.notices = [];
      setTimeout(() => target.notices.push('PLDBGBREAK:46'), 5);
      return new Promise((resolve, reject) => { finish = () => (fail ? reject(Object.assign(new Error(fail), { detail: 'in line 9' })) : resolve({ columns: [{ name: 'order_total' }], rows: [['30009.5']], notices: target.notices })); });
    },
    close: async () => { target.closed = true; },
  };
  const control = {
    closed: false,
    cancelled: false,
    all: async (text, params) => {
      asked.push(text);
      if (/pldbg_attach_to_port/.test(text)) { assert.deepEqual(params, [46]); return [{ handle: '1' }]; }
      if (/pldbg_(step_into|step_over|continue)/.test(text)) {
        at += 1;
        if (at >= lines.length) {
          finish();
          if (hangAtEnd) return new Promise(() => {});
          throw new Error('select() failed waiting for target');
        }
        // What it answers is one more than it means: the stack is where the line is read from.
        return [{ func: '16702', linenumber: String(lines[at] + 1) }];
      }
      if (/pldbg_get_stack/.test(text)) return [{ level: '0', targetname: 'order_total(integer,numeric)', func: '16702', linenumber: String(lines[at]), args: 'p_customer=5' }];
      if (/pldbg_get_source/.test(text)) return [{ source: '\nDECLARE\n  v numeric;\nBEGIN\n  x;\n  FOR;\n  v := 1;\n  END LOOP;\n  y;\n  RETURN v;\nEND ' }];
      if (/pldbg_get_variables/.test(text)) return [{ name: 'p_customer', varclass: 'A', linenumber: '0', type: 'integer', value: '5' }, { name: 'v', varclass: 'L', linenumber: '3', type: 'numeric', value: String(at) }];
      if (/pldbg_get_breakpoints/.test(text)) return [{ func: '16702', linenumber: '-1' }, { func: '16702', linenumber: '10' }];
      return [{}];
    },
    cancel: async () => { control.cancelled = true; return true; },
    close: async () => { control.closed = true; },
  };
  return { target, control, asked };
}

test('a run stops on the first line, steps by the stack, and ends when the call comes back', async () => {
  const { target, control, asked } = pair();
  const run = new DebugRun({ target, control, info: FN });
  let state = await run.start(['5', '1.5']);
  assert.equal(asked[0], 'SELECT "public".plpgsql_oid_debug($1::oid)');
  assert.deepEqual(asked[1], ['SELECT * FROM "public"."order_total"($1::integer, $2::numeric)', ['5', '1.5']]);
  assert.deepEqual([state.done, state.func, state.line], [false, '16702', 6]);
  assert.deepEqual(state.variables.map((one) => [one.name, one.kind, one.value]), [['p_customer', 'argument', '5'], ['v', 'local', '0']]);
  // The breakpoint that started the run has no line and is not one somebody set.
  assert.deepEqual(state.breakpoints, [{ func: '16702', line: 10 }]);
  assert.equal(state.source.split('\n')[state.line - 1].trim(), 'FOR;');

  state = await run.step('over');
  assert.equal(state.line, 7);
  state = await run.step('continue');
  assert.equal(state.line, 10);
  state = await run.step('continue');
  assert.deepEqual([state.done, state.result.rows], [true, [['30009.5']]]);
  // Asked again after the end, it says the same and asks the server nothing.
  const count = asked.length;
  assert.equal((await run.step('over')).done, true);
  assert.equal(asked.length, count);
  await assert.rejects(new DebugRun({ ...pair(), info: FN }).step('sideways').then(() => { throw new Error('went'); }), /went|not a step/);
  await run.stop();
  assert.deepEqual([target.closed, control.closed], [true, true]);
});

test('a step that never answers at the end is not waited for, and is told to stop when the run is let go', async () => {
  const { target, control } = pair({ lines: [6], hangAtEnd: true });
  const run = new DebugRun({ target, control, info: FN });
  await run.start(['5']);
  const state = await run.step('continue');
  assert.equal(state.done, true);
  await run.stop();
  assert.equal(control.cancelled, true);
  assert.deepEqual([target.closed, control.closed], [true, true]);
});

test('a routine that raises ends the run with what it raised', async () => {
  const { target, control } = pair({ lines: [6], fail: 'too much: 30018' });
  const run = new DebugRun({ target, control, info: FN });
  await run.start(['5']);
  const state = await run.step('over');
  assert.deepEqual([state.done, state.error, state.detail], [true, 'too much: 30018', 'in line 9']);
  await run.stop();
});

test('stopping half way tells the target to give up and lets both connections go', async () => {
  const { target, control, asked } = pair();
  const run = new DebugRun({ target, control, info: FN });
  await run.start(['5']);
  await run.breakpoint('16702', 9, true);
  assert.ok(asked.some((text) => typeof text === 'string' && /pldbg_set_breakpoint\(\$1::int, \$2::oid, \$3::int\)/.test(text)));
  await assert.rejects(run.breakpoint('16702', 'nine', true), /goes on a line/);
  await run.stop();
  assert.ok(asked.some((text) => typeof text === 'string' && /pldbg_abort_target/.test(text)));
  assert.deepEqual([target.closed, control.closed], [true, true]);
});
