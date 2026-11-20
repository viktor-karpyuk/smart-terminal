'use strict';

/**
 * The Databases panel: the parts of it that are logic rather than drawing.
 *
 * A panel is one script in a sandboxed frame, so there is nothing to import.
 * Each piece is extracted from the panel as it ships and run in an empty
 * context — a copy in a test would be a copy that drifts. What is checked is
 * what a person would notice when it is wrong: an edit sent for a row that was
 * also deleted, a number sorted as text, a keyword offered in the middle of a
 * column list, a name quoted for the wrong engine.
 *
 * And the promises that cannot be seen in a screenshot: that nothing a
 * database says is ever read as markup, and that every call the panel makes is
 * one the app routes and permits.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'extensions', 'databases');
const html = fs.readFileSync(path.join(dir, 'panel.html'), 'utf8');
const source = /<script>([\s\S]*)<\/script>/.exec(html)[1];

/** The named top-level declarations, each taken whole, evaluated together. */
function fromPanel(names, globals = {}) {
  const boundary = /\n {2}(?![ }\])])\S/g;
  const pieces = names.map((name) => {
    const at = source.search(new RegExp(`\\n {2}(?:var|function) ${name}\\b`));
    assert.ok(at >= 0, `the panel no longer defines ${name}`);
    boundary.lastIndex = at + 1;
    const next = boundary.exec(source);
    return source.slice(at, next ? next.index : source.length).trimEnd();
  });
  const context = vm.createContext({ ...globals });
  vm.runInContext(`${pieces.join('\n')}\n;this.__out = { ${names.join(', ')} };`, context);
  return context.__out;
}

const P = fromPanel([
  'KEYWORDS', 'KEYWORD_SET', 'qi', 'qname', 'fmtBytes', 'fmtCount', 'fmtMs', 'ago', 'isNumeric', 'sqlTokens', 'wordAt', 'suggest',
  'buildChanges', 'changeCount', 'sortedOrder', 'pretty', 'scriptFor', 'explainOf', 'resultWords',
  'planRows', 'compact', 'rates', 'niceTop', 'dashboardCharts', 'maintenanceFor', 'tableSubs', 'serverSubs',
  'guessMapping', 'importProblems', 'shellLabel',
  'ERD', 'erdModel', 'erdSize', 'erdLayout', 'erdRowY', 'erdPath',
  'plainDef', 'retarget', 'snapshotColumnSql', 'schemaDiff',
  'MORE', 'reportTarget',
  'FORMAT_CLAUSES', 'FORMAT_STARTS', 'JOIN_WORDS', 'formatSql', 'flowSql',
  'PRIVILEGES', 'grantKind', 'granteeSql', 'grantSql', 'roleFromRow', 'membershipChange',
  'TYPE_HINTS', 'defaultSql', 'designColumns', 'designProblems', 'columnSql', 'createTableSql', 'alterTableSql', 'designScript',
]);
/** Out of the panel's context and into this one, so deepEqual compares values and not realms. */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('names are quoted the way the app quotes them', () => {
  const S = require('../electron/rdb-sql');
  for (const engine of ['postgres', 'mysql', 'sqlite']) {
    for (const name of ['order', 'we"ird', 'we`ird', 'Mixed Case']) {
      assert.equal(P.qi(engine, name), S.quoteIdent(engine, name));
      assert.equal(P.qname(engine, 'sch', name), S.qualified(engine, 'sch', name));
    }
  }
});

test('sizes, counts and times are said in the unit that fits', () => {
  assert.equal(P.fmtBytes(0), '0 B');
  assert.equal(P.fmtBytes(1536), '1.5 KB');
  assert.equal(P.fmtBytes(48 * 1024), '48 KB');
  assert.equal(P.fmtBytes(null), '');
  assert.equal(P.fmtCount(48112), '48,112');
  assert.equal(P.fmtCount(null), '');
  assert.equal(P.fmtMs(12), '12 ms');
  assert.equal(P.fmtMs(1500), '1.50 s');
  assert.equal(P.fmtMs(125000), '2 min 5 s');
  const now = 1_700_000_000_000;
  assert.equal(P.ago(now - 10_000, now), 'just now');
  assert.equal(P.ago(now - 5 * 60_000, now), '5 min ago');
  assert.equal(P.ago(now - 3 * 3600_000, now), '3 h ago');
});

test('SQL is coloured by what each piece is, not by what it looks like', () => {
  const tokens = plain(P.sqlTokens("select \"from\" from t /* drop */ where n = 42 and s = 'it''s'"));
  const of = (text) => tokens.find((token) => token.s === text)?.t;
  assert.equal(of('select'), 'kw', 'lower case is a keyword too');
  assert.equal(of('"from"'), 'id', 'a quoted name is a name, whatever it spells');
  assert.equal(of('/* drop */'), 'com');
  assert.equal(of('42'), 'num');
  assert.equal(of("'it''s'"), 'str');
  // Nothing is lost on the way: the pieces put back together are the text.
  const sql = "SELECT $tag$ body; 'x' $tag$, `a``b`, 1.5e3 FROM \"t\"\n-- end";
  assert.equal(plain(P.sqlTokens(sql)).map((token) => token.s).join(''), sql);
  assert.equal(plain(P.sqlTokens("SELECT 'unterminated")).map((token) => token.s).join(''), "SELECT 'unterminated");
});

test('completion offers tables and the columns of what the query mentions, and after a dot only what belongs there', () => {
  const known = {
    tables: [{ name: 'customer', schema: 'public', kind: 'table' }, { name: 'customer_note', schema: 'public', kind: 'table' }, { name: 'audit', schema: 'ops', kind: 'view' }],
    columns: { customer: ['id', 'name', 'created_at'], audit: ['at'] },
    schemas: ['public', 'ops'],
    mentioned: ['customer'],
  };
  const texts = (list) => plain(list).map((one) => one.text);
  assert.deepEqual(texts(P.suggest('cu', '', known)), ['customer', 'customer_note', 'CURRENT_TIMESTAMP', 'CURRENT_DATE']);
  assert.deepEqual(texts(P.suggest('cr', '', known)), ['created_at', 'CROSS', 'CREATE']);
  assert.deepEqual(texts(P.suggest('s', '', known)), [], 'one letter is not enough to interrupt for');
  assert.ok(texts(P.suggest('s', '', known, true)).includes('SELECT'), 'unless it was asked for');
  assert.deepEqual(texts(P.suggest('', 'customer', known)), ['id', 'name', 'created_at']);
  assert.deepEqual(texts(P.suggest('n', 'CUSTOMER', known)), ['name']);
  assert.deepEqual(texts(P.suggest('', 'ops', known)), ['audit']);
  assert.deepEqual(texts(P.suggest('', 'nothing', known)), []);
  assert.deepEqual(texts(P.suggest('customer', '', known)), ['customer_note'], 'what is already typed is not offered back');

  assert.deepEqual(plain(P.wordAt('SELECT c.na', 11)), { word: 'na', qualifier: 'c', start: 9 });
  assert.deepEqual(plain(P.wordAt('SELECT c.', 9)), { word: '', qualifier: 'c', start: 9 });
  assert.deepEqual(plain(P.wordAt('SELECT * FROM cu', 16)), { word: 'cu', qualifier: '', start: 14 });
  assert.deepEqual(plain(P.wordAt('SELECT ', 7)), { word: '', qualifier: '', start: 7 });
});

test('what the grid changed is three lists, each row named by its key as it was read', () => {
  const columns = [{ name: 'id' }, { name: 'name' }, { name: 'note' }];
  const rows = [['1', 'Ana', null], ['2', 'Beto', 'x'], ['3', 'Cata', 'y']];
  const changes = plain(P.buildChanges(
    columns, ['id'], rows,
    { 0: { name: 'Ana María', note: null }, 1: { id: '20' }, 2: { name: 'edited and then deleted' } },
    { 2: true },
    [{ name: 'Dora', note: undefined }, {}],
  ));
  assert.deepEqual(changes.deletes, [{ id: '3' }]);
  assert.deepEqual(changes.updates, [
    { key: { id: '1' }, set: { name: 'Ana María' } },
    // The key itself changed: the row is still found by what it was.
    { key: { id: '2' }, set: { id: '20' } },
  ]);
  assert.deepEqual(changes.inserts, [{ name: 'Dora' }, {}], 'a cell nobody filled in is left to its default');
  assert.equal(P.changeCount(changes), 5);
  // An edit that puts back what was there is not a change.
  assert.equal(P.changeCount(P.buildChanges(columns, ['id'], rows, { 0: { name: 'Ana' } }, {}, [])), 0);
  // A deleted mark that was taken back is not a delete.
  assert.equal(P.changeCount(P.buildChanges(columns, ['id'], rows, {}, { 1: false }, [])), 0);
  const two = plain(P.buildChanges([{ name: 'a' }, { name: 'b' }, { name: 'v' }], ['a', 'b'], [['1', '2', 'x']], {}, { 0: true }, []));
  assert.deepEqual(two.deletes, [{ a: '1', b: '2' }]);
});

test('a result sorts numbers as numbers and keeps NULL at the end either way', () => {
  const rows = [['10'], ['9'], [null], ['100'], ['-1']];
  assert.deepEqual(plain(P.sortedOrder(rows, 0, false, true)), [4, 1, 0, 3, 2]);
  assert.deepEqual(plain(P.sortedOrder(rows, 0, true, true)), [3, 0, 1, 4, 2]);
  assert.deepEqual(plain(P.sortedOrder(rows, 0, false, false)), [4, 0, 3, 1, 2], 'as text when the column is text');
  assert.equal(P.isNumeric('numeric(12,2)'), true);
  assert.equal(P.isNumeric('bigint'), true);
  assert.equal(P.isNumeric('longlong'), true);
  assert.equal(P.isNumeric('character varying'), false);
  assert.equal(P.isNumeric('interval'), false);
  assert.equal(P.isNumeric('int4'), true);
  assert.equal(P.isNumeric('double precision'), true);
});

test('a value is laid out when it is JSON and left alone when it only looks like it', () => {
  assert.equal(P.pretty('{"a":1,"b":[2]}'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  assert.equal(P.pretty('{not json'), '{not json');
  assert.equal(P.pretty('plain'), 'plain');
});

test('the scripts the tree writes are for the engine they will run on', () => {
  assert.equal(P.scriptFor('select', 'postgres', 'public', 'customer', ['id', 'name']), 'SELECT "id", "name"\nFROM "public"."customer"\nLIMIT 100;');
  assert.equal(P.scriptFor('select', 'mysql', 'shop', 't', []), 'SELECT *\nFROM `shop`.`t`\nLIMIT 100;');
  assert.match(P.scriptFor('insert', 'sqlite', null, 't', ['a', 'b']), /^INSERT INTO "t" \("a", "b"\)\nVALUES \(\?, \?\);$/);
  // The ones that would touch every row are written so that they cannot run until somebody finishes them.
  assert.match(P.scriptFor('delete', 'postgres', 'public', 't'), /WHERE \/\* condition \*\/;$/);
  assert.match(P.scriptFor('update', 'postgres', 'public', 't', ['a']), /WHERE \/\* condition \*\/;$/);
  assert.match(P.scriptFor('createTable', 'postgres', 'app', ''), /GENERATED ALWAYS AS IDENTITY/);
  assert.match(P.scriptFor('createTable', 'mysql', 'app', ''), /AUTO_INCREMENT/);
  assert.match(P.scriptFor('createTable', 'sqlite', null, ''), /AUTOINCREMENT/);
  assert.equal(P.explainOf('postgres', 'SELECT 1;', false), 'EXPLAIN (FORMAT JSON) SELECT 1');
  assert.equal(P.explainOf('postgres', 'SELECT 1', true), 'EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) SELECT 1');
  assert.equal(P.explainOf('sqlite', 'SELECT 1', false), 'EXPLAIN QUERY PLAN SELECT 1');
  assert.equal(P.explainOf('mysql', 'SELECT 1', true), 'EXPLAIN ANALYZE SELECT 1');
});

test('a result says in one line what happened', () => {
  assert.equal(P.resultWords({ columns: [{ name: 'a' }], rows: [[1]], rowCount: 1 }), '1 row');
  assert.equal(P.resultWords({ columns: [{ name: 'a' }], rows: new Array(1000).fill([1]), rowCount: null }), '1000+ rows', 'stopped early: there are more, and how many is not known');
  assert.equal(P.resultWords({ columns: [], rows: [], rowCount: 3, command: 'UPDATE' }), 'UPDATE · 3 affected');
  assert.equal(P.resultWords({ error: { error: 'x' } }), 'failed');
});

test('a plan is read as where the time went, node by node, and says what looks wrong', () => {
  const json = JSON.stringify([{
    Plan: {
      'Node Type': 'Sort', 'Sort Key': ['(count(*)) DESC'], 'Plan Rows': 3, 'Actual Rows': 3, 'Actual Loops': 1, 'Actual Total Time': 20, 'Total Cost': 900,
      Plans: [{
        'Node Type': 'Hash Join', 'Join Type': 'Left', 'Hash Cond': '(l.n = c.id)', 'Plan Rows': 100, 'Actual Rows': 6800, 'Actual Loops': 1, 'Actual Total Time': 19, 'Total Cost': 800,
        Plans: [
          { 'Node Type': 'Seq Scan', 'Relation Name': 'load_t', Alias: 'l', Filter: "(v ~~ 'a%'::text)", 'Rows Removed by Filter': 98000, 'Plan Rows': 7000, 'Actual Rows': 6800, 'Actual Loops': 1, 'Actual Total Time': 17, 'Total Cost': 700 },
          { 'Node Type': 'Index Scan', 'Relation Name': 'customer', Alias: 'customer', 'Index Name': 'customer_pkey', 'Plan Rows': 1, 'Actual Rows': 1, 'Actual Loops': 3, 'Actual Total Time': 0.5, 'Total Cost': 8 },
        ],
      }],
    },
    'Planning Time': 0.8,
    'Execution Time': 20.4,
  }]);
  const plan = plain(P.planRows(json));
  assert.equal(plan.analyzed, true);
  assert.deepEqual(plan.rows.map((row) => `${row.depth}:${row.type}`), ['0:Sort', '1:Left Hash Join', '2:Seq Scan', '2:Index Scan']);
  // A node's own time is what is left after its children's; a looped node counts every loop.
  assert.deepEqual(plan.rows.map((row) => Number(row.own.toFixed(2))), [1, 0.5, 17, 1.5]);
  assert.equal(Math.round(plan.rows[2].share * 100), 85);
  assert.equal(plan.rows[2].what, "on load_t l · (v ~~ 'a%'::text)");
  assert.equal(plan.rows[3].what, 'on customer · using customer_pkey');
  assert.deepEqual(plan.rows[1].flags, ['estimated 100 rows, got 6.8k']);
  assert.deepEqual(plan.rows[2].flags, ['read 105k rows to keep 6.8k']);
  assert.deepEqual(plan.rows[0].flags, []);
  assert.equal(plan.execution, 20.4);

  // Not run: there are no times, and the planner's cost stands in for them.
  const planned = plain(P.planRows(JSON.stringify([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 't', 'Plan Rows': 10, 'Total Cost': 12.5 } }])));
  assert.equal(planned.analyzed, false);
  assert.equal(planned.rows[0].rows, null);
  assert.equal(planned.rows[0].own, 12.5);
  assert.equal(planned.execution, null);
  assert.equal(P.planRows('Seq Scan on t  (cost=0.00..1.00)'), null, 'a plan that is not JSON is shown as the text it is');
  assert.equal(P.planRows('{"not":"a plan"}'), null);
});

test('a counter read twice is a rate, and one that went backwards is a restart, not a negative', () => {
  const samples = [{ at: 0, commits: 100 }, { at: 2000, commits: 300 }, { at: 5000, commits: 300 }, { at: 8000, commits: 30 }, { at: 9000, commits: 80 }];
  assert.deepEqual(plain(P.rates(samples, 'commits')), [100, 0, 0, 50]);
  assert.deepEqual(plain(P.rates([{ at: 0, commits: 1 }], 'commits')), []);
  assert.equal(P.niceTop(0), 1);
  assert.equal(P.niceTop(0.4), 1);
  assert.equal(P.niceTop(7), 10);
  assert.equal(P.niceTop(130), 200);
  assert.equal(P.niceTop(2000), 2000);
  assert.equal(P.niceTop(6600), 10000);
  assert.equal(P.compact(950), '950');
  assert.equal(P.compact(1200), '1.2k');
  assert.equal(P.compact(104748), '105k');
  assert.equal(P.compact(3400000), '3.4M');
  assert.equal(P.compact(1.26), '1.3');
  assert.equal(P.compact(0), '0');
});

test('every chart of the dashboard has one measure and no more series than there are colours for', () => {
  for (const engine of ['postgres', 'mysql']) {
    for (const chart of plain(P.dashboardCharts(engine))) {
      assert.ok(chart.series.length >= 1 && chart.series.length <= 3, chart.title);
      assert.equal(new Set(chart.series.map((one) => one[0])).size, chart.series.length);
    }
  }
  assert.match(source, /var SERIES_COLORS = \[[^\]]*\];/);
  assert.equal(/SERIES_COLORS\[[^\]]*%/.test(source), false, 'colours are assigned in order, never cycled');
});

test('upkeep and the views offered are the engine\'s own', () => {
  const labels = (engine, name) => plain(P.maintenanceFor(engine, 'public', name)).map((one) => one[1]);
  assert.deepEqual(labels('postgres', 't'), ['VACUUM "public"."t"', 'VACUUM (ANALYZE) "public"."t"', 'ANALYZE "public"."t"', 'REINDEX TABLE "public"."t"', 'VACUUM (FULL) "public"."t"']);
  assert.deepEqual(labels('postgres', ''), ['VACUUM', 'VACUUM (ANALYZE)', 'ANALYZE']);
  assert.deepEqual(labels('mysql', 't'), ['ANALYZE TABLE `public`.`t`', 'OPTIMIZE TABLE `public`.`t`']);
  assert.deepEqual(labels('sqlite', ''), ['VACUUM', 'ANALYZE']);
  const subs = (list) => plain(list).map((one) => one[0]);
  assert.deepEqual(subs(P.tableSubs('postgres')), ['data', 'structure', 'stats', 'deps', 'privs', 'ddl']);
  assert.deepEqual(subs(P.tableSubs('sqlite')), ['data', 'structure', 'ddl']);
  assert.deepEqual(subs(P.serverSubs('sqlite')), ['databases']);
  assert.ok(subs(P.serverSubs('postgres')).includes('replication'));
  assert.equal(subs(P.serverSubs('mysql')).includes('replication'), false);
  // Performance is the server's to answer: both servers have the page, a file has none.
  assert.ok(subs(P.serverSubs('postgres')).includes('performance'));
  assert.ok(subs(P.serverSubs('mysql')).includes('performance'));
});

test('a file\'s columns are matched to the table\'s by name, or by position when it has no names', () => {
  const columns = [
    { name: 'id', nullable: false, filled: true }, { name: 'full_name', nullable: false, filled: false },
    { name: 'email', nullable: true, filled: false }, { name: 'created_at', nullable: false, filled: true },
  ];
  assert.deepEqual(plain(P.guessMapping(['Full Name', 'E-MAIL', 'whatever', 'Created At', 'email'], columns, true)), ['full_name', 'email', '', 'created_at', ''], 'a column is taken once');
  assert.deepEqual(plain(P.guessMapping(['1', 'Ana', 'ana@x.io'], columns, false)), ['id', 'full_name', 'email']);
  assert.deepEqual(plain(P.guessMapping(['a', 'b', 'c', 'd', 'e', 'f'], columns, false)).slice(4), ['', '']);

  assert.equal(P.importProblems(['full_name', 'email'], columns), '');
  assert.equal(P.importProblems(['', 'email'], columns), 'Nothing fills full_name, which cannot be empty.', 'a column with a default or an identity fills itself');
  assert.equal(P.importProblems(['', ''], columns), 'Choose at least one column to import into.');
  assert.equal(P.importProblems(['email', 'full_name', 'email'], columns), 'Two columns of the file are going into email.');
  assert.equal(P.shellLabel('postgres'), 'Open psql here');
});

// --- comparing schemas ------------------------------------------------------------

const snap = (schema, over) => ({ schema, snapshot: { tables: [], views: [], sequences: [], routines: [], ...over } });
const tcol = (name, type, over) => ({ name, type, nullable: true, default: null, extra: '', comment: '', ...over });

test('a definition is compared without the name of the schema it was said in', () => {
  assert.equal(P.plainDef('CREATE INDEX i ON app.customer  USING btree (id);', 'app'), 'CREATE INDEX i ON customer USING btree (id)');
  assert.equal(P.plainDef('SELECT "My App".t.id FROM "My App".t', 'My App'), 'SELECT t.id FROM t');
  assert.equal(P.plainDef("nextval('app.seq'::regclass)", 'app'), "nextval('seq'::regclass)");
  assert.equal(P.plainDef('SELECT app_user.id, snapp.x FROM t', 'app'), 'SELECT app_user.id, snapp.x FROM t', 'only the schema itself, not a name that contains it');
  assert.equal(P.retarget('postgres', 'REFERENCES app.customer(id)', 'app', 'staging'), 'REFERENCES staging.customer(id)');
  assert.equal(P.retarget('postgres', 'FROM app.t JOIN "app".u ON true', 'app', 'My Stage'), 'FROM "My Stage".t JOIN "My Stage".u ON true');
  assert.equal(P.retarget('mysql', 'from `a`.`t`', 'a', 'b'), 'from `b`.`t`');
  assert.equal(P.retarget('postgres', 'FROM app.t', 'app', 'app'), 'FROM app.t');
});

test('two schemas that say the same thing under different names are the same', () => {
  const table = (schema) => ({
    name: 'invoice',
    columns: [tcol('id', 'integer', { nullable: false, default: `nextval('${schema}.invoice_id_seq'::regclass)` }), tcol('total', 'numeric(12,2)')],
    indexes: [{ name: 'invoice_total', definition: `CREATE INDEX invoice_total ON ${schema}.invoice USING btree (total)` }],
    constraints: [{ name: 'invoice_c_fkey', type: 'FOREIGN KEY', definition: `FOREIGN KEY (id) REFERENCES ${schema}.customer(id)` }],
  });
  const side = (schema) => snap(schema, {
    tables: [table(schema)],
    views: [{ name: 'big', kind: 'view', definition: ` SELECT id\n   FROM ${schema}.invoice;` }],
    sequences: [{ name: 'invoice_id_seq' }],
    routines: [{ name: 'owed(bigint)', kind: 'function', definition: `CREATE OR REPLACE FUNCTION ${schema}.owed(bigint) RETURNS numeric AS $$ SELECT 1 $$` }],
  });
  const diff = plain(P.schemaDiff('postgres', side('app'), side('staging'), { drops: true }));
  assert.deepEqual(diff.counts, { same: 4, different: 0, missing: 0, extra: 0 });
  assert.equal(diff.script, '');
});

test('what differs is said in words and fixed in SQL, in an order that can run', () => {
  const model = snap('app', {
    sequences: [{ name: 'ticket_no' }],
    tables: [
      { name: 'customer', columns: [tcol('id', 'bigint', { nullable: false, extra: 'identity (always)' }), tcol('name', 'varchar(120)', { nullable: false }), tcol('tier', 'text', { default: "'free'::text" })],
        indexes: [{ name: 'customer_name', definition: 'CREATE INDEX customer_name ON app.customer USING btree (name)' }],
        constraints: [{ name: 'customer_pkey', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' }] },
      { name: 'invoice', columns: [tcol('id', 'integer', { nullable: false }), tcol('customer_id', 'bigint')], indexes: [],
        constraints: [{ name: 'invoice_pkey', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' }, { name: 'invoice_customer_fkey', type: 'FOREIGN KEY', definition: 'FOREIGN KEY (customer_id) REFERENCES app.customer(id)' }] },
    ],
    views: [{ name: 'rich', kind: 'view', definition: 'SELECT id, name FROM app.customer;' }],
  });
  const changed = snap('staging', {
    tables: [
      { name: 'customer', columns: [tcol('id', 'bigint', { nullable: false, extra: 'identity (always)' }), tcol('name', 'varchar(80)'), tcol('legacy', 'text')],
        indexes: [{ name: 'customer_name', definition: 'CREATE INDEX customer_name ON staging.customer USING btree (legacy)' }, { name: 'old_index', definition: 'CREATE INDEX old_index ON staging.customer USING btree (legacy)' }],
        constraints: [{ name: 'customer_pkey', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' }] },
      { name: 'forgotten', columns: [tcol('id', 'integer')], indexes: [], constraints: [] },
    ],
    views: [{ name: 'rich', kind: 'view', definition: 'SELECT id FROM staging.customer;' }, { name: 'old_view', kind: 'view', definition: 'SELECT 1;' }],
  });

  const kept = plain(P.schemaDiff('postgres', model, changed, { drops: false }));
  assert.deepEqual(kept.counts, { same: 0, different: 2, missing: 2, extra: 2 });
  const customer = kept.items.find((item) => item.name === 'customer');
  assert.deepEqual(customer.notes, [
    'name: varchar(80) → varchar(120)', 'name: NOT NULL in the second', 'Column tier is only in the second', 'Column legacy is only in the first',
    'Index customer_name differs', 'Index old_index is only in the first',
  ]);
  // Finding out something is only on one side is not wanting it gone.
  assert.equal(/DROP (TABLE|VIEW|COLUMN)|old_index/.test(kept.script), false);
  assert.match(kept.script, /^-- Sequences only in the second\nCREATE SEQUENCE "staging"\."ticket_no";/);
  assert.match(kept.script, /CREATE TABLE "staging"\."invoice" \(\n {2}"id" integer NOT NULL,\n {2}"customer_id" bigint,\n {2}CONSTRAINT "invoice_pkey" PRIMARY KEY \(id\)\n\);/);
  assert.match(kept.script, /ALTER TABLE "staging"\."customer" ADD COLUMN "tier" text DEFAULT 'free'::text;/);
  assert.match(kept.script, /DROP INDEX "staging"\."customer_name";\nCREATE INDEX customer_name ON staging\.customer USING btree \(name\);/, 'an index that differs is replaced, and said about the right schema');
  assert.match(kept.script, /CREATE OR REPLACE VIEW "staging"\."rich" AS\nSELECT id, name FROM staging\.customer;/);
  // A foreign key waits until the table it points at is there.
  assert.ok(kept.script.indexOf('ADD CONSTRAINT "invoice_customer_fkey" FOREIGN KEY (customer_id) REFERENCES staging.customer(id)') > kept.script.indexOf('CREATE TABLE "staging"."invoice"'));
  const order = ['-- Sequences', '-- Tables only', '-- Columns', '-- Indexes', '-- Foreign keys', '-- Views'].map((head) => kept.script.indexOf(head));
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  const dropped = plain(P.schemaDiff('postgres', model, changed, { drops: true }));
  assert.match(dropped.script, /DROP TABLE "staging"\."forgotten";/);
  assert.match(dropped.script, /DROP VIEW "staging"\."old_view";/);
  assert.match(dropped.script, /ALTER TABLE "staging"\."customer" DROP COLUMN "legacy";/);
  // An index goes with the column it is on: it is dropped before the column, never after.
  assert.ok(dropped.script.indexOf('DROP INDEX "staging"."old_index"') < dropped.script.indexOf('DROP COLUMN "legacy"'));
  assert.ok(dropped.script.indexOf('DROP INDEX "staging"."old_index"') >= 0);
});

test('MySQL compares what no form shows too, and SQLite says what it cannot do', () => {
  const side = (schema, column) => snap(schema, { tables: [{ name: 't', columns: [column], indexes: [{ name: 'PRIMARY', definition: 'PRIMARY KEY (`id`)' }, { name: 'fk', implied: true, definition: 'INDEX `fk` (`id`)' }], constraints: [] }] });
  const stamped = tcol('seen', 'timestamp', { default: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP', comment: 'last seen' });
  const plainOne = tcol('seen', 'timestamp', { default: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED' });
  const diff = plain(P.schemaDiff('mysql', side('a', stamped), side('b', plainOne), {}));
  assert.deepEqual(diff.items[0].notes, ['seen: its attributes or its comment differ']);
  assert.equal(diff.script, "-- Columns\nALTER TABLE `b`.`t`\n  MODIFY COLUMN `seen` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'last seen';");
  assert.equal(plain(P.schemaDiff('mysql', side('a', plainOne), side('b', plainOne), {})).counts.same, 1, 'DEFAULT_GENERATED is not an attribute, and the index a foreign key brings is not compared');

  const lite = (ddl) => ({ schema: null, snapshot: { tables: [{ name: 't', ddl, columns: [], indexes: [], constraints: [] }], views: [], sequences: [], routines: [] } });
  const sqlite = plain(P.schemaDiff('sqlite', lite('CREATE TABLE t (a text, b int)'), lite('CREATE TABLE t (a text)'), {}));
  assert.equal(sqlite.items[0].status, 'different');
  assert.match(sqlite.items[0].notes[0], /SQLite cannot change a table in place/);
  assert.equal(sqlite.script, '');
  assert.equal(plain(P.schemaDiff('sqlite', lite('CREATE TABLE t (a  text)'), lite('CREATE TABLE t (a text)'), {})).counts.same, 1, 'spacing is not a difference');
});

// --- the diagram -------------------------------------------------------------------

const erdSnapshot = {
  schema: 'app',
  tables: [
    { name: 'country', key: ['code'], columns: [tcol('code', 'character(2)', { nullable: false }), tcol('name', 'text')], constraints: [] },
    { name: 'customer', key: ['id'], columns: [tcol('id', 'bigint', { nullable: false }), tcol('country_code', 'character(2)'), tcol('referred_by', 'bigint'), tcol('tenant', 'integer')],
      constraints: [
        { name: 'customer_country', type: 'FOREIGN KEY', columns: ['country_code'], refSchema: 'app', refTable: 'country', refColumns: ['code'] },
        { name: 'customer_self', type: 'FOREIGN KEY', columns: ['referred_by'], refSchema: 'app', refTable: 'customer', refColumns: ['id'] },
        { name: 'customer_tenant', type: 'FOREIGN KEY', columns: ['tenant'], refSchema: 'core', refTable: 'tenant', refColumns: ['id'] },
        { name: 'customer_pkey', type: 'PRIMARY KEY', columns: ['id'] },
      ] },
    { name: 'invoice', key: ['id'], columns: [tcol('id', 'bigint', { nullable: false }), tcol('customer_id', 'bigint', { nullable: false })],
      constraints: [{ name: 'invoice_customer', type: 'FOREIGN KEY', columns: ['customer_id'], refSchema: 'app', refTable: 'customer', refColumns: ['id'] }] },
    { name: 'setting', key: ['key'], columns: [tcol('key', 'text', { nullable: false })], constraints: [] },
  ],
};

test('a schema becomes boxes and lines: keys marked, and a key into another schema named rather than drawn', () => {
  const model = plain(P.erdModel(erdSnapshot));
  assert.deepEqual(model.links.map((link) => `${link.from}.${link.columns} → ${link.to}.${link.refColumns}`), ['customer.country_code → country.code', 'customer.referred_by → customer.id', 'invoice.customer_id → customer.id']);
  const customer = model.tables.find((table) => table.name === 'customer');
  assert.deepEqual(customer.columns.map((column) => [column.name, column.pk, column.fk]), [['id', true, ''], ['country_code', false, 'country'], ['referred_by', false, 'customer'], ['tenant', false, 'core.tenant']]);
});

test('tables are set out left to right by what refers to what, and nothing overlaps', () => {
  const model = P.erdModel(erdSnapshot);
  const boxes = plain(P.erdLayout(model));
  assert.deepEqual(Object.keys(boxes).sort(), ['country', 'customer', 'invoice', 'setting']);
  assert.ok(boxes.country.x < boxes.customer.x && boxes.customer.x < boxes.invoice.x, 'each table is to the right of what it refers to');
  assert.ok(boxes.setting.y > Math.max(boxes.country.y, boxes.customer.y, boxes.invoice.y), 'a table with no line is out of the way, below');
  const all = Object.values(boxes);
  for (const a of all) for (const b of all) {
    if (a === b) continue;
    assert.equal(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, false, 'two boxes overlap');
  }
  // A cycle is broken, not followed for ever.
  const loop = { schema: 's', tables: ['a', 'b', 'c'].map((name, i, list) => ({ name, key: ['id'], columns: [tcol('id', 'int'), tcol('next', 'int')], constraints: [{ name: `${name}_fk`, type: 'FOREIGN KEY', columns: ['next'], refSchema: 's', refTable: list[(i + 1) % 3], refColumns: ['id'] }] })) };
  assert.equal(Object.keys(plain(P.erdLayout(P.erdModel(loop)))).length, 3);
  // Many tables in one layer are folded into columns rather than one tower.
  const wide = { schema: 's', tables: [{ name: 'hub', key: ['id'], columns: [tcol('id', 'int')], constraints: [] }].concat(Array.from({ length: 20 }, (_, i) => ({ name: `spoke_${String(i).padStart(2, '0')}`, key: [], columns: [tcol('hub_id', 'int')], constraints: [{ name: `fk${i}`, type: 'FOREIGN KEY', columns: ['hub_id'], refSchema: 's', refTable: 'hub', refColumns: ['id'] }] }))) };
  const spread = Object.values(plain(P.erdLayout(P.erdModel(wide))));
  assert.ok(new Set(spread.map((one) => one.x)).size >= 4);
  for (const a of spread) for (const b of spread) if (a !== b) assert.equal(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, false);
});

test('a line runs from the column that holds the key to the column it names', () => {
  const model = P.erdModel(erdSnapshot);
  const boxes = P.erdLayout(model);
  const link = plain(model.links).find((one) => one.from === 'invoice');
  const path = plain(P.erdPath(link, model, boxes));
  const from = plain(boxes.invoice);
  const to = plain(boxes.customer);
  assert.equal(path.fx, from.x, 'it leaves the side that faces the other table');
  assert.equal(path.x, to.x + to.w);
  assert.equal(path.fy, from.y + 24 + 1 * 17 + 8.5, 'at the height of customer_id, the second column');
  assert.equal(path.y, to.y + 24 + 8.5, 'and arrives at the height of id, the first');
  // A table that refers to itself is joined round one side, not through its own box.
  const self = plain(P.erdPath(plain(model.links).find((one) => one.from === one.to), model, boxes));
  assert.equal(self.fx, to.x + to.w);
  assert.equal(self.x, to.x + to.w);
  assert.equal(P.erdPath({ from: 'gone', to: 'customer', columns: [], refColumns: [] }, model, boxes), null);
  // A column past the ones shown is where the line that says "more" is.
  const tall = { name: 't', columns: Array.from({ length: 40 }, (_, i) => ({ name: `c${i}` })) };
  assert.equal(P.erdRowY(tall, { x: 0, y: 0, w: 100, h: 0 }, 'c39'), 24 + 14 * 17 + 8.5);
  assert.equal(P.erdSize(tall).h, 24 + 15 * 17 + 6);
});

// --- the rest of the tree --------------------------------------------------------

test('every page listed under More is one its engine can answer', () => {
  const drivers = require('../electron/rdb-drivers');
  const more = plain(P.MORE);
  let pages = 0;
  for (const level of ['schema', 'database']) {
    for (const [engine, list] of Object.entries(more[level])) {
      for (const [kind, label] of list) {
        pages += 1;
        const sections = drivers.catalog(engine).reports(kind, { schema: 's', name: 't', q: '' });
        assert.ok(Array.isArray(sections) && sections.length > 0, `${engine} has no ${kind} page, and the tree offers "${label}"`);
        for (const section of sections) assert.ok(section.title && section.sql, `${engine} ${kind}`);
      }
    }
  }
  assert.ok(pages >= 15);
  // And the other way: nothing an engine does not have is offered for it.
  assert.equal(more.database.mysql, undefined);
  assert.equal(drivers.catalog('mysql').reports('policies', {}), null);
  assert.equal(drivers.catalog('sqlite').reports('partitions', {}), null);
});

test('a row of a page that names a table leads to that table', () => {
  const columns = (names) => names.map((name) => ({ name }));
  assert.deepEqual(plain(P.reportTarget(columns(['table', 'trigger', 'state']), ['doc', 'doc_touch', 'enabled'], 'app')), { schema: 'app', table: 'doc' });
  assert.deepEqual(plain(P.reportTarget(columns(['publication', 'schema', 'table']), ['docs', 'other', 'doc'], 'app')), { schema: 'other', table: 'doc' }, 'the row\'s own schema wins');
  assert.equal(P.reportTarget(columns(['wrapper', 'owner']), ['postgres_fdw', 'postgres'], 'app'), null);
  assert.equal(P.reportTarget(columns(['table', 'x']), [null, 'y'], 'app'), null);
});

test('nothing a page shows is where a remote password is kept', () => {
  const drivers = require('../electron/rdb-drivers');
  const text = JSON.stringify([...drivers.catalog('postgres').reports('foreign', {}), ...drivers.catalog('postgres').reports('publications', {})]);
  assert.equal(/umoptions|subconninfo/.test(text), false, 'a user mapping\'s options and a subscription\'s connection string hold passwords');
});

// --- the formatter ---------------------------------------------------------------

const FORMAT_CORPUS = [
  "select c.id, c.name, count(o.line) as lines, sum(o.qty) from customer c left join order_line o on o.customer_id = c.id and o.qty > 0 where c.name like 'a%' and (c.balance > 10 or c.vip) and c.created between '2026-01-01' and '2026-12-31' group by c.id, c.name having count(*) > 1 order by lines desc nulls last limit 10 offset 5;",
  'select * from t',
  "with recent as (select id, total from invoice where issued_at > now() - interval '7 days'), big as (select id from recent where total > 100) select r.id, r.total::numeric(12,2), extract(year from now()) from recent r join big b using (id) where r.id in (select id from big) -- only the big ones\norder by 2 desc",
  "insert into t (a, b) values (1, 'x;y'), (2, null) on conflict (a) do update set b = excluded.b returning *; update t set a = 1, b = coalesce(b, 'z') where id = 3; delete from t where a is distinct from b",
  'create table x (id int primary key, n text);\nselect distinct a from x union all select b from y',
  "select case when a > 1 and b < 2 then 'x' else 'y' end as k, t.\"from\", t.select from t where a = any(array[1,2]) and j->>'k' = 'v' and x<=y",
  'explain analyze select 1',
  "SELECT $$ body; with select from $$, 'it''s' /* keep ; this */ FROM t",
  'select a from t where b in (select c from u where d = (select max(e) from v)) for update',
  "select a -- first\n, b -- second\nfrom t -- the table\nwhere x = 1 -- why",
  'select trim(both from a), substring(b from 2 for 3), a is not distinct from b from t full outer join u on true cross join v natural join w',
  'select 1;;  ; select 2',
  '',
  "select 'unterminated",
  'select `a`, `from` from `t` where `b` = 1 limit 5',
  'with x as (select 1) insert into t select * from x returning id',
  'select count(*) filter (where a > 1) over (partition by b order by c) from t',
];

test('formatting moves whitespace and capitalises keywords, and changes nothing else', () => {
  const tokens = (sql) => plain(P.sqlTokens(sql)).filter((token) => !(token.t === 'ws' && /^\s+$/.test(token.s))).map((token) => (token.t === 'kw' ? token.s.toUpperCase() : token.s)).filter((text) => text !== ';');
  for (const sql of FORMAT_CORPUS) {
    const out = P.formatSql(sql);
    assert.deepEqual(tokens(out), tokens(sql), sql);
    assert.equal(P.formatSql(out), out, `formatting what is already formatted changes it: ${sql}`);
  }
});

test('a query is laid out a clause to a line, with its conditions under its WHERE', () => {
  assert.equal(P.formatSql("select c.id, c.name from customer c left join order_line o on o.customer_id = c.id where c.name like 'a%' and (c.vip or c.balance > 10) and c.created between 1 and 2 order by 1 limit 10;"), [
    'SELECT',
    '  c.id,',
    '  c.name',
    'FROM customer c',
    'LEFT JOIN order_line o ON o.customer_id = c.id',
    "WHERE c.name LIKE 'a%'",
    '  AND (c.vip OR c.balance > 10)',
    // The AND of a BETWEEN belongs to the BETWEEN.
    '  AND c.created BETWEEN 1 AND 2',
    'ORDER BY 1',
    'LIMIT 10;',
  ].join('\n'));
  assert.equal(P.formatSql('select * from t'), 'SELECT *\nFROM t', 'one column stays on the line of its SELECT, and no semicolon is invented');
  assert.equal(P.formatSql('select a from t where b in (select c from u)'), 'SELECT a\nFROM t\nWHERE b IN (\n  SELECT c\n  FROM u\n)');
  assert.equal(P.formatSql('update t set a = 1, b = 2 where id = 3'), 'UPDATE t\nSET\n  a = 1,\n  b = 2\nWHERE id = 3');
  assert.equal(P.formatSql('delete from t where a = 1;select 1'), 'DELETE FROM t\nWHERE a = 1;\n\nSELECT 1');
});

test('what was written together stays together, and what is not a query is left exactly as typed', () => {
  assert.match(P.formatSql('select t.select, x::int, f(a), a<=b, j->>\'k\' from t'), /t\.select,\n {2}x::int,\n {2}f\(a\),\n {2}a<=b,\n {2}j->>'k'/);
  assert.match(P.formatSql('select extract(year from d), trim(both from a) from t'), /extract\(year FROM d\),\n {2}trim\(both FROM a\)\nFROM t/, 'a FROM inside a function is not a clause');
  const ddl = 'create  table x (\n  id int primary key,\n  n text\n)';
  assert.equal(P.formatSql(ddl), ddl);
  const body = "create function f() returns int as $$ select 1 from t where a = 1 $$ language sql";
  assert.equal(P.formatSql(body), body);
  // A line comment ends at its line, so what follows it starts a new one.
  assert.equal(P.formatSql('select a -- first\nfrom t'), 'SELECT a -- first\nFROM t');
});

// --- roles and grants ----------------------------------------------------------

test('a grant is one statement per kind of thing, with only the privileges that kind takes', () => {
  const form = {
    revoke: false, withGrant: false, schemaUsage: true, schema: 'app',
    objects: [
      { kind: 'table', schema: 'app', name: 'customer' }, { kind: 'view', schema: 'app', name: 'rich' }, { kind: 'sequence', schema: 'app', name: 'customer_id_seq' },
      { kind: 'function', schema: 'app', name: 'total', args: 'integer, text' }, { kind: 'procedure', schema: 'app', name: 'purge', args: '' },
    ],
    roles: [{ name: 'readers' }, { name: 'Ana María' }],
    privileges: ['table:SELECT', 'table:UPDATE', 'sequence:USAGE', 'routine:EXECUTE', 'table:EXECUTE'],
  };
  assert.deepEqual(plain(P.grantSql('postgres', form)), [
    'GRANT USAGE ON SCHEMA "app" TO "readers", "Ana María"',
    'GRANT SELECT, UPDATE ON TABLE "app"."customer", "app"."rich" TO "readers", "Ana María"',
    'GRANT USAGE ON SEQUENCE "app"."customer_id_seq" TO "readers", "Ana María"',
    'GRANT EXECUTE ON FUNCTION "app"."total"(integer, text) TO "readers", "Ana María"',
    'GRANT EXECUTE ON PROCEDURE "app"."purge"() TO "readers", "Ana María"',
  ]);
  // Taking away says FROM, never offers the option to pass it on, and leaves the schema alone.
  assert.deepEqual(plain(P.grantSql('postgres', { ...form, revoke: true, withGrant: true, objects: form.objects.slice(0, 1), privileges: ['table:DELETE'] })), [
    'REVOKE DELETE ON TABLE "app"."customer" FROM "readers", "Ana María"',
  ]);
  assert.match(P.grantSql('postgres', { ...form, schemaUsage: false, withGrant: true, objects: form.objects.slice(0, 1) })[0], /TO "readers", "Ana María" WITH GRANT OPTION$/);
  assert.deepEqual(plain(P.grantSql('postgres', { ...form, roles: [] })), []);
  assert.deepEqual(plain(P.grantSql('postgres', { ...form, objects: [] })), []);
  assert.deepEqual(plain(P.grantSql('postgres', { ...form, schemaUsage: false, privileges: ['sequence:USAGE'], objects: form.objects.slice(0, 1) })), [], 'a privilege of another kind is not sent to be refused');
});

test('MySQL grants on one table at a time, to a user at a host', () => {
  const form = { revoke: false, withGrant: false, objects: [{ kind: 'table', schema: 'shop', name: 'a' }, { kind: 'view', schema: 'shop', name: 'b' }], roles: [{ name: 'app', host: '10.%' }, { name: "o'b\\", host: '' }], privileges: ['SELECT', 'INDEX', 'table:SELECT'] };
  assert.deepEqual(plain(P.grantSql('mysql', form)), [
    "GRANT SELECT, INDEX ON `shop`.`a` TO 'app'@'10.%', 'o''b\\\\'@'%'",
    "GRANT SELECT, INDEX ON `shop`.`b` TO 'app'@'10.%', 'o''b\\\\'@'%'",
  ]);
  // The same account the app writes when it makes the user.
  const S = require('../electron/rdb-sql');
  for (const [user, host] of [['app', '10.%'], ["o'b\\", ''], ['x', '%']]) assert.equal(P.granteeSql('mysql', { name: user, host }), S.mysqlAccount(user, host));
});

test('a role is read off its row, and its groups change by what was ticked and unticked', () => {
  const columns = ['role', 'login', 'superuser', 'create db', 'create role', 'replication', 'conn limit', 'valid until', 'member of'].map((name) => ({ name }));
  const role = plain(P.roleFromRow('postgres', columns, ['ana', 't', 'f', 't', 'f', 'f', '-1', null, 'readers, writers']));
  assert.deepEqual(role, { name: 'ana', newName: 'ana', password: '', login: true, superuser: false, createdb: true, createrole: false, replication: false, connectionLimit: '', validUntil: '', memberOf: ['readers', 'writers'] });
  assert.equal(P.roleFromRow('postgres', columns, ['b', 'f', 'f', 'f', 'f', 'f', '10', '2027-01-31 00:00:00+00', null]).connectionLimit, '10');
  assert.deepEqual(plain(P.roleFromRow('postgres', columns, ['b', 'f', 'f', 'f', 'f', 'f', '-1', 'infinity', null]).memberOf), []);
  assert.deepEqual(plain(P.roleFromRow('mysql', [{ name: 'user' }, { name: 'host' }, { name: 'plugin' }], ['app', '%', 'x'])), { name: 'app', host: '%', password: '', locked: null, newName: 'app' });
  assert.deepEqual(plain(P.membershipChange(['readers', 'writers'], ['writers', 'admins'])), { grant: ['admins'], revoke: ['readers'] });
  assert.deepEqual(plain(P.membershipChange([], [])), { grant: [], revoke: [] });
});

// --- the table designer --------------------------------------------------------

const col = (over) => ({ original: null, name: 'c', type: 'text', notNull: false, def: '', pk: false, extra: '', comment: '', ...over });
/** A column as it was read, so a change to it can be told from no change. */
const kept = (over) => {
  const column = col({ original: over.name, ...over });
  return { ...column, was: { type: column.type, notNull: column.notNull, def: column.def } };
};

test('a new table is written for the engine it is made on', () => {
  const columns = [col({ name: 'id', type: 'bigserial', notNull: true, pk: true }), col({ name: 'Full Name', type: 'varchar(80)', notNull: true }), col({ name: 'balance', type: 'numeric(12,2)', def: '0' })];
  assert.equal(P.createTableSql('postgres', 'app', 'customer', columns),
    'CREATE TABLE "app"."customer" (\n  "id" bigserial NOT NULL,\n  "Full Name" varchar(80) NOT NULL,\n  "balance" numeric(12,2) DEFAULT 0,\n  PRIMARY KEY ("id")\n)');
  assert.match(P.createTableSql('mysql', 'shop', 't', [col({ name: 'a', type: 'int', pk: true }), col({ name: 'b', type: 'int', pk: true })]), /^CREATE TABLE `shop`\.`t` \(\n {2}`a` int,\n {2}`b` int,\n {2}PRIMARY KEY \(`a`, `b`\)\n\)$/);
  assert.match(P.createTableSql('sqlite', null, 't', [col({ name: 'a' })]), /^CREATE TABLE "t" \(\n {2}"a" text\n\)$/);
  assert.equal(P.designProblems('', columns), 'The table needs a name.');
  assert.equal(P.designProblems('t', []), 'A table needs at least one column.');
  assert.equal(P.designProblems('t', [col({ name: ' ' })]), 'Column 1 needs a name.');
  assert.equal(P.designProblems('t', [col({ name: 'a', type: '' })]), 'a needs a type.');
  assert.equal(P.designProblems('t', [col({ name: 'a' }), col({ name: 'A' })]), 'Two columns are called A.');
  assert.equal(P.designProblems('t', columns), '');
});

test('PostgreSQL gets one statement per change, and nothing for a column left alone', () => {
  const made = plain(P.alterTableSql('postgres', 'public', 'customer', [
    kept({ name: 'id', type: 'integer', notNull: true }),
    { ...kept({ name: 'name', type: 'character varying(80)', notNull: true }), name: 'full_name', type: 'text', notNull: false },
    { ...kept({ name: 'balance', type: 'numeric(12,2)', def: '0' }), def: '' },
    { ...kept({ name: 'note', type: 'text' }), def: "'none'", notNull: true },
    col({ name: 'created_at', type: 'timestamptz', def: 'now()', notNull: true }),
  ], ['legacy'], 'client'));
  assert.deepEqual(made.statements, [
    'ALTER TABLE "public"."customer" DROP COLUMN "legacy"',
    'ALTER TABLE "public"."customer" RENAME COLUMN "name" TO "full_name"',
    'ALTER TABLE "public"."customer" ALTER COLUMN "full_name" TYPE text USING "full_name"::text',
    'ALTER TABLE "public"."customer" ALTER COLUMN "full_name" DROP NOT NULL',
    'ALTER TABLE "public"."customer" ALTER COLUMN "balance" DROP DEFAULT',
    'ALTER TABLE "public"."customer" ALTER COLUMN "note" SET DEFAULT \'none\'',
    'ALTER TABLE "public"."customer" ALTER COLUMN "note" SET NOT NULL',
    'ALTER TABLE "public"."customer" ADD COLUMN "created_at" timestamptz DEFAULT now() NOT NULL',
    // Last, so that everything before it still finds the table by the name it has.
    'ALTER TABLE "public"."customer" RENAME TO "client"',
  ]);
  assert.deepEqual(made.cannot, []);
  assert.deepEqual(plain(P.alterTableSql('postgres', 'public', 't', [kept({ name: 'a', type: 'Integer' })], [], 't')).statements, [], 'the case of a type is not a change');
  // Several statements travel in a transaction, so one the server refuses takes the others back.
  assert.equal(P.designScript('postgres', ['A', 'B']), 'BEGIN;\nA;\nB;\nCOMMIT;');
  assert.equal(P.designScript('postgres', ['A']), 'A;');
  assert.equal(P.designScript('postgres', []), '');
});

test('MySQL restates the whole column, keeps what the form does not show, and sends it as one statement', () => {
  const made = plain(P.alterTableSql('mysql', 'shop', 'customer', [
    { ...kept({ name: 'id', type: 'bigint', notNull: true, extra: 'auto_increment' }), type: 'int' },
    { ...kept({ name: 'name', type: 'varchar(80)', notNull: true, comment: "the person's name" }), name: 'full_name' },
    { ...kept({ name: 'seen', type: 'timestamp', def: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' }), notNull: true },
    col({ name: 'note', type: 'text' }),
  ], ['legacy'], 'customer'));
  assert.deepEqual(made.statements, [
    'ALTER TABLE `shop`.`customer`\n  DROP COLUMN `legacy`,\n  MODIFY COLUMN `id` int NOT NULL AUTO_INCREMENT,\n'
    + "  CHANGE COLUMN `name` `full_name` varchar(80) NOT NULL COMMENT 'the person''s name',\n"
    + '  MODIFY COLUMN `seen` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  ADD COLUMN `note` text NULL',
  ]);
  assert.equal(P.designScript('mysql', made.statements.concat(['RENAME TABLE a TO b'])).includes('BEGIN'), false, 'MySQL cannot undo table changes; pretending otherwise would be a lie');
  assert.deepEqual(plain(P.alterTableSql('mysql', 'shop', 't', [], [], 'u')).statements, ['RENAME TABLE `shop`.`t` TO `shop`.`u`']);
});

test('a MySQL default is told apart: a literal gets its quotes back, an expression does not', () => {
  assert.equal(P.defaultSql('mysql', { default: 'abc', extra: '' }), "'abc'");
  assert.equal(P.defaultSql('mysql', { default: "it's", extra: '' }), "'it''s'");
  assert.equal(P.defaultSql('mysql', { default: '0.00', extra: '' }), '0.00');
  assert.equal(P.defaultSql('mysql', { default: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED' }), 'CURRENT_TIMESTAMP');
  assert.equal(P.defaultSql('mysql', { default: 'uuid()', extra: 'DEFAULT_GENERATED' }), '(uuid())');
  assert.equal(P.defaultSql('mysql', { default: null, extra: '' }), '');
  assert.equal(P.defaultSql('postgres', { default: "'abc'::text", extra: '' }), "'abc'::text");
  const [id, total] = plain(P.designColumns('postgres', { columns: [
    { name: 'id', type: 'integer', nullable: false, default: null, pk: true, extra: 'identity (always)', comment: '' },
    { name: 'total', type: 'numeric', nullable: true, default: '(a + b)', pk: false, extra: 'generated', comment: '' },
  ] }));
  assert.equal(id.locked, false);
  assert.equal(total.locked, true, 'a column the server computes is not redefined from a form');
});

test('SQLite adds, drops and renames, and says what it cannot do instead of trying', () => {
  const made = plain(P.alterTableSql('sqlite', null, 't', [
    { ...kept({ name: 'a', type: 'text' }), name: 'b', type: 'integer' },
    col({ name: 'c', type: 'real', def: '0' }),
  ], ['old'], 't2'));
  assert.deepEqual(made.statements, ['ALTER TABLE "t" DROP COLUMN "old"', 'ALTER TABLE "t" RENAME COLUMN "a" TO "b"', 'ALTER TABLE "t" ADD COLUMN "c" real DEFAULT 0', 'ALTER TABLE "t" RENAME TO "t2"']);
  assert.deepEqual(made.cannot, ['SQLite cannot change the type, the default or the NOT NULL of b once it exists.']);
});

test('dropping a column from the designer is asked about; loosening a rule is not', () => {
  const host = require('../.test-build/lib/extensionHost.js');
  const script = (statements) => P.designScript('postgres', statements);
  const drop = plain(P.alterTableSql('postgres', 'public', 't', [kept({ name: 'a' })], ['b'], 't')).statements;
  assert.match(host.needsConsent('db.query', { connectionName: 'orders', engine: 'postgres', sql: script(drop) }), /ALTER TABLE … DROP/);
  const loosen = plain(P.alterTableSql('postgres', 'public', 't', [{ ...kept({ name: 'a', notNull: true, def: '0' }), notNull: false, def: '' }], [], 't')).statements;
  assert.equal(loosen.length, 2);
  assert.equal(host.needsConsent('db.query', { connectionName: 'orders', engine: 'postgres', sql: script(loosen) }), null);
  const mysql = plain(P.alterTableSql('mysql', 's', 't', [], ['b'], 't')).statements;
  assert.match(host.needsConsent('db.query', { connectionName: 'orders', engine: 'mysql', sql: P.designScript('mysql', mysql) }), /ALTER TABLE … DROP/);
});

// --- promises that cannot be seen in a screenshot ------------------------------

test('nothing a database says is ever read as markup', () => {
  // Table names, cell values, error messages, comments on columns: all of it belongs to other people.
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'srcdoc', 'DOMParser', 'eval(', 'new Function', 'setAttribute(\'on']) {
    assert.equal(source.includes(bad), false, `the panel uses ${bad}`);
  }
  assert.equal(/\bsetTimeout\(\s*['"`]/.test(source), false, 'a timer given a string is eval');
  assert.equal(/\.href\s*=|\.src\s*=|location\s*=|window\.open/.test(source), false, 'a server\'s text must not become an address');
  assert.equal(/\bfetch\(|XMLHttpRequest|WebSocket/.test(source), false, 'the panel asks the app; it does not reach a network');
});

test('the panel has no form element: its frame is sandboxed without allow-forms', () => {
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/<form\b/.test(code), false);
  assert.equal(/h\('form'|createElement\('form'\)/.test(code), false);
});

test('every call the panel makes is one the app routes, permits and answers', () => {
  const host = require('../.test-build/lib/extensionHost.js');
  const used = new Set();
  for (const [, name] of source.matchAll(/\bcall\('(\w+)'/g)) used.add(name);
  for (const [, name] of source.matchAll(/host\.call\('db\.(\w+)'/g)) used.add(name);
  assert.ok(used.size >= 20, `found only ${[...used].join(', ')}`);
  const shipped = { trusted: false, permissions: ['db.read', 'db.write', 'terminal'] };
  // The verbs the service really has, read from its source so this needs no database to run.
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'rdb-service.js'), 'utf8');
  for (const name of used) {
    assert.notEqual(host.route(`db.${name}`), null, `the app does not route db.${name}`);
    assert.equal(host.permitted(shipped, `db.${name}`), true, `db.${name} needs a permission nobody asked for`);
    // `ask` and `shell` are the app's own doors: it gathers what they need and opens the session or the terminal itself.
    if (name !== 'ask' && name !== 'shell') assert.ok(new RegExp(`\\n {6}${name}: `).test(service), `the service has no verb ${name}`);
  }
  for (const name of ['query', 'rows', 'applyChanges', 'table', 'export', 'kill', 'cancel']) assert.ok(used.has(name), `the panel does not use ${name}`);
});

test('every call that may stop and ask says which connection it is about', () => {
  // The question is written by the app from these; without them it would say "this connection".
  for (const verb of ['query', 'applyChanges', 'kill', 'export', 'backup', 'restore', 'role']) {
    const calls = [...source.matchAll(new RegExp(`call\\('${verb}', ([^\\n]*)`, 'g'))];
    assert.ok(calls.length > 0, verb);
    // `payload()` is the role form's own arguments, which start from `where(conn, …)`.
    for (const [, args] of calls) assert.match(args, /^(Object\.assign\()?(where\(|payload\(\))/, `${verb} is called without saying where`);
  }
  assert.match(source, /call\('deleteConnection', \{ id: conn\.id, connectionName: conn\.name \}\)/);
});

test('the manifest offers the panel from the activity bar, with an icon the app knows', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf8'));
  const { panelViews, PANEL_ICONS, validate } = require('../electron/extensions');
  assert.equal(validate(manifest), null);
  const [panel] = panelViews([{ ...manifest, status: 'installed', enabled: true, builtIn: true, dir }]);
  assert.equal(panel.id, 'databases');
  assert.equal(panel.launcher, true);
  assert.ok(PANEL_ICONS.includes(panel.icon));
  assert.equal(panel.error, undefined);
});

test('what is dropped goes in an order the server will take', () => {
  const empty = snap('app', {});
  const full = snap('staging', {
    // A sequence a column owns goes with its table, so its own DROP must not fail for that.
    sequences: [{ name: 'orders_id_seq' }],
    tables: [
      { name: 'customer', columns: [tcol('id', 'integer', { nullable: false })], indexes: [], constraints: [{ name: 'customer_pkey', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' }] },
      { name: 'orders', columns: [tcol('id', 'integer'), tcol('customer_id', 'integer')], indexes: [],
        constraints: [{ name: 'orders_customer_fkey', type: 'FOREIGN KEY', definition: 'FOREIGN KEY (customer_id) REFERENCES staging.customer(id)', refTable: 'customer' }] },
    ],
    views: [{ name: 'busy', kind: 'view', definition: 'SELECT id FROM staging.orders;' }],
  });
  const script = plain(P.schemaDiff('postgres', empty, full, { drops: true })).script;
  const at = (text) => { const found = script.indexOf(text); assert.ok(found >= 0, text); return found; };
  assert.ok(at('DROP VIEW "staging"."busy"') < at('DROP TABLE "staging"."orders"'));
  // The table that is referred to waits for the one that refers to it.
  assert.ok(at('DROP TABLE "staging"."orders"') < at('DROP TABLE "staging"."customer"'));
  assert.ok(at('DROP TABLE "staging"."customer"') < at('DROP SEQUENCE IF EXISTS "staging"."orders_id_seq"'));
});
