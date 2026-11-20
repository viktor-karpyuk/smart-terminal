'use strict';

/**
 * The Databases extension: reading SQL, and writing it.
 *
 * Nothing here opens a connection. What is checked is what goes wrong quietly
 * when it is wrong: a semicolon inside a string ending a statement, a DELETE
 * with no WHERE going unasked about, a read-only connection letting through a
 * statement that only looks like a read, a cell's text ending up in the SQL.
 *
 * The same reading of SQL exists twice — in the main process, which decides
 * what is sent, and in the renderer, which decides what a person is asked —
 * and this file holds the two together.
 */

const test = require('node:test');
const assert = require('node:assert');
const S = require('../electron/rdb-sql');
const H = require('../.test-build/lib/extensionHost');

const CORPUS = [
  ['SELECT 1; SELECT 2', 'postgres'],
  ["SELECT 'a;b' AS x; SELECT \"semi;colon\" FROM t", 'postgres'],
  ['SELECT 1 -- trailing; comment\n; SELECT 2', 'postgres'],
  ['/* DROP TABLE x; */ SELECT 1', 'postgres'],
  ["CREATE FUNCTION f() RETURNS int AS $$ BEGIN DELETE FROM t; RETURN 1; END $$ LANGUAGE plpgsql; SELECT f()", 'postgres'],
  ["DO $body$ BEGIN PERFORM 1; END $body$", 'postgres'],
  ["SELECT 'it''s' ; DELETE FROM t", 'postgres'],
  ["SELECT 'back\\' ; DROP TABLE t; --'", 'postgres'],
  ["SELECT 'back\\' ; DROP TABLE t; --'", 'mysql'],
  ['SELECT 1 # mysql comment; here\n; SELECT `a;b` FROM t', 'mysql'],
  ['SELECT a # b FROM t; SELECT 2', 'postgres'],
  ['UPDATE t SET a = 1', 'postgres'],
  ["UPDATE t SET a = 'WHERE'", 'postgres'],
  ['UPDATE t SET a = 1 WHERE id = 2', 'postgres'],
  ['DELETE FROM t', 'mysql'],
  ['delete from t where id in (select id from u)', 'mysql'],
  ['WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone', 'postgres'],
  ['TRUNCATE TABLE a, b', 'postgres'],
  ['DROP TABLE IF EXISTS "a"."b" CASCADE', 'postgres'],
  ['ALTER TABLE t DROP COLUMN c', 'postgres'],
  ['ALTER TABLE t ADD COLUMN c int', 'postgres'],
  ['ALTER TABLE t ALTER COLUMN c DROP NOT NULL', 'postgres'],
  ['ALTER TABLE t ALTER COLUMN c DROP DEFAULT, DROP COLUMN d', 'postgres'],
  ['ALTER TABLE `t` MODIFY COLUMN `a` int NULL, DROP COLUMN `b`', 'mysql'],
  ['EXPLAIN DELETE FROM t', 'postgres'],
  ['EXPLAIN ANALYZE DELETE FROM t', 'postgres'],
  ['EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1', 'postgres'],
  ['', 'postgres'],
  [' ;; ; ', 'postgres'],
  ['SELECT $1, $2', 'postgres'],
  ["CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO log VALUES ('x;y'); DELETE FROM b; END; SELECT 1", 'sqlite'],
  ['CREATE PROCEDURE p() BEGIN IF x > 1 THEN DELETE FROM t; END IF; SELECT CASE WHEN a THEN 1 ELSE 2 END; END; DROP TABLE u', 'mysql'],
  ['CREATE TABLE begin_log (id int); DELETE FROM begin_log', 'postgres'],
  ['BEGIN; DELETE FROM t; END; SELECT 1', 'postgres'],
];

test('a script is cut where its statements end, and nowhere else', () => {
  const bare = (sql, engine) => S.scan(sql, engine).map((one) => one.bare);
  assert.deepEqual(bare('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2']);
  assert.deepEqual(bare("SELECT 'a;b'; SELECT 2"), ["SELECT ''", 'SELECT 2']);
  assert.deepEqual(bare('SELECT 1 -- no; cut\n; SELECT 2'), ['SELECT 1', 'SELECT 2']);
  assert.equal(S.scan('CREATE FUNCTION f() RETURNS int AS $$ BEGIN DELETE FROM t; RETURN 1; END $$ LANGUAGE plpgsql; SELECT f()').length, 2);
  assert.deepEqual(bare(' ;; ; '), []);
  // What is sent is the statement as it was typed, comments and all.
  const [first] = S.scan("  SELECT 'x' /* why */ FROM t ;");
  assert.equal(first.text, "SELECT 'x' /* why */ FROM t");
});

test('the body of a trigger or a routine is one statement, whatever semicolons are in it', () => {
  const trigger = "CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO log VALUES ('x'); DELETE FROM b; END";
  assert.deepEqual(S.scan(`${trigger}; SELECT 1`).map((one) => one.text), [trigger, 'SELECT 1']);
  const proc = 'CREATE PROCEDURE p() BEGIN IF x > 1 THEN DELETE FROM t; END IF; WHILE y DO SET y = y - 1; END WHILE; SELECT CASE WHEN a THEN 1 ELSE 2 END; END';
  assert.deepEqual(S.scan(`${proc};\nCALL p()`, 'mysql').map((one) => one.text), [proc, 'CALL p()']);
  // What is inside it is still seen: a DELETE with no WHERE in a trigger body is one.
  assert.deepEqual(S.risks(trigger), ['DELETE with no WHERE']);
  // A transaction is not a body: BEGIN on its own is a statement, and so is everything after it.
  assert.equal(S.scan('BEGIN; DELETE FROM t; END; SELECT 1').length, 4);
  assert.equal(S.scan('CREATE TABLE begin_log (id int); SELECT 1').length, 2);
  // PostgreSQL's SQL-standard bodies are counted the same way; its dollar-quoted ones have nothing to count.
  assert.equal(S.scan('CREATE FUNCTION f() RETURNS int BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT f()').length, 2);
  assert.equal(S.scan('CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT f()').length, 2);
});

test('a backslash escapes a quote in MySQL and is only a backslash anywhere else', () => {
  const sql = "SELECT 'back\\' ; DROP TABLE t; --'";
  assert.equal(S.scan(sql, 'mysql').length, 1, 'in MySQL the string runs to the last quote');
  assert.equal(S.scan(sql, 'postgres').length, 2, 'in PostgreSQL it ended at the backslash, and the DROP is real');
  assert.deepEqual(S.risks(sql, 'postgres'), ['DROP TABLE']);
  assert.deepEqual(S.risks(sql, 'mysql'), []);
});

test('where each statement sits in the script is kept, so the whole of it can be found again', () => {
  const sql = 'SELECT 1;\n\nSELECT *\nFROM t;';
  const parts = S.scan(sql);
  assert.equal(sql.slice(parts[1].start, parts[1].end).trim(), 'SELECT *\nFROM t;');
});

test('only what is plainly a read is called a read', () => {
  const kind = (sql) => S.classify(S.scan(sql)[0].bare).kind;
  assert.equal(kind('SELECT * FROM t'), 'read');
  assert.equal(kind('  ( SELECT 1 ) UNION (SELECT 2)'), 'read');
  assert.equal(kind('WITH x AS (SELECT 1) SELECT * FROM x'), 'read');
  assert.equal(kind('SHOW TABLES'), 'read');
  assert.equal(kind('EXPLAIN DELETE FROM t'), 'read', 'a plan is not a run');
  assert.equal(kind('EXPLAIN ANALYZE DELETE FROM t'), 'write', 'EXPLAIN ANALYZE runs what it explains');
  assert.equal(kind('EXPLAIN (ANALYZE, BUFFERS) SELECT 1'), 'read');
  assert.equal(kind('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone'), 'write');
  assert.equal(kind('SELECT * INTO copy FROM t'), 'write');
  assert.equal(kind('INSERT INTO t VALUES (1)'), 'write');
  assert.equal(kind('CALL do_things()'), 'write');
  assert.equal(kind('CREATE TABLE t (id int)'), 'ddl');
  assert.equal(kind('VACUUM'), 'ddl');
  assert.equal(kind('BEGIN'), 'tx');
  assert.equal(kind('SET default_transaction_read_only = off'), 'session');
  assert.equal(kind('PRAGMA writable_schema = 1'), 'other');
  assert.equal(S.readsOnly('SELECT 1; SELECT 2'), true);
  assert.equal(S.readsOnly('SELECT 1; SET x = 1'), false);
  assert.equal(S.readsOnly(''), false, 'nothing is not a read');
});

test('what takes data away is named, and what does not is left alone', () => {
  assert.deepEqual(S.risks('DROP TABLE IF EXISTS a'), ['DROP TABLE']);
  assert.deepEqual(S.risks('truncate a'), ['TRUNCATE']);
  assert.deepEqual(S.risks('DELETE FROM t'), ['DELETE with no WHERE']);
  assert.deepEqual(S.risks('DELETE FROM t WHERE id = 1'), []);
  assert.deepEqual(S.risks("DELETE FROM t -- WHERE id = 1"), ['DELETE with no WHERE'], 'a WHERE in a comment is not a WHERE');
  assert.deepEqual(S.risks("UPDATE t SET note = 'WHERE'"), ['UPDATE with no WHERE'], 'nor is one in a string');
  assert.deepEqual(S.risks('UPDATE t SET a = 1 WHERE id = 2'), []);
  assert.deepEqual(S.risks('ALTER TABLE t DROP COLUMN c'), ['ALTER TABLE … DROP']);
  assert.deepEqual(S.risks('ALTER TABLE t ADD COLUMN c int'), []);
  // Dropping a rule about a column takes no data with it.
  assert.deepEqual(S.risks('ALTER TABLE t ALTER COLUMN c DROP NOT NULL'), []);
  assert.deepEqual(S.risks('ALTER TABLE t ALTER COLUMN c DROP DEFAULT'), []);
  assert.deepEqual(S.risks('ALTER TABLE t ALTER COLUMN c DROP DEFAULT, DROP COLUMN d'), ['ALTER TABLE … DROP']);
  assert.deepEqual(S.risks('ALTER TABLE t DROP CONSTRAINT t_pkey'), ['ALTER TABLE … DROP']);
  assert.deepEqual(S.risks('EXPLAIN DELETE FROM t'), []);
  assert.deepEqual(S.risks('EXPLAIN ANALYZE DELETE FROM t'), ['DELETE with no WHERE']);
  assert.deepEqual(S.risks('EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t'), ['DELETE with no WHERE']);
  assert.deepEqual(S.risks('EXPLAIN (ANALYZE) DROP TABLE t'), ['DROP TABLE']);
  assert.deepEqual(S.risks('SELECT 1; DROP SCHEMA s CASCADE; DELETE FROM t'), ['DROP SCHEMA', 'DELETE with no WHERE']);
  assert.deepEqual(S.risks('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone'), ['DELETE with no WHERE']);
});

test('the app and the panel host read SQL the same way', () => {
  for (const [sql, engine] of CORPUS) {
    assert.deepEqual(H.sqlStatements(sql, engine), S.scan(sql, engine).map((one) => one.bare), sql);
    assert.deepEqual(H.sqlRisks(sql, engine), S.risks(sql, engine), sql);
    // What production is asked about is exactly what is not a read, a transaction word or a setting.
    const writes = S.scan(sql, engine).map((one) => S.classify(one.bare)).filter((one) => !['read', 'tx', 'session'].includes(one.kind));
    assert.equal(H.sqlWrites(sql, engine).length > 0, writes.length > 0, sql);
  }
});

test('names are quoted the way each engine quotes them', () => {
  assert.equal(S.quoteIdent('postgres', 'order'), '"order"');
  assert.equal(S.quoteIdent('postgres', 'we"ird'), '"we""ird"');
  assert.equal(S.quoteIdent('mysql', 'we`ird'), '`we``ird`');
  assert.equal(S.qualified('postgres', 'public', 't'), '"public"."t"');
  assert.equal(S.qualified('sqlite', 'main', 't'), '"t"');
  assert.throws(() => S.quoteIdent('postgres', ''), /missing/);
});

test('a page of a table is built from quoted names and one typed condition', () => {
  assert.equal(
    S.selectPage({ engine: 'postgres', schema: 'public', table: 'customer', where: "name <> 'x'", orderBy: [{ column: 'id', desc: true }], limit: 50, offset: 100 }),
    `SELECT * FROM "public"."customer" WHERE name <> 'x' ORDER BY "id" DESC LIMIT 50 OFFSET 100`,
  );
  assert.equal(S.selectPage({ engine: 'mysql', schema: 'shop', table: 't' }), 'SELECT * FROM `shop`.`t` LIMIT 200');
  assert.equal(S.selectPage({ engine: 'sqlite', table: 't', limit: 999999 }), `SELECT * FROM "t" LIMIT ${S.PAGE_MAX}`);
  assert.throws(() => S.selectPage({ engine: 'postgres', schema: 'public', table: 't', where: 'id = 1; DELETE FROM t' }), /one condition/);
  assert.throws(() => S.countRows({ engine: 'postgres', schema: 'public', table: 't', where: '1=1; DROP TABLE t' }), /one condition/);
  // A semicolon in a string is not a second statement, and a trailing one is only a habit.
  assert.match(S.selectPage({ engine: 'postgres', schema: 'p', table: 't', where: "note = 'a;b';" }), /WHERE note = 'a;b' LIMIT/);
});

test('what the grid changed becomes parameters, never text in the statement', () => {
  const statements = S.changeStatements({
    engine: 'postgres',
    schema: 'public',
    table: 'customer',
    key: ['id'],
    changes: {
      deletes: [{ id: '3' }],
      updates: [{ key: { id: '2' }, set: { name: "Robert'); DROP TABLE students;--", note: null } }],
      inserts: [{ name: 'Dora', balance: '7.5' }, {}],
    },
  });
  assert.deepEqual(statements.map((one) => one.kind), ['delete', 'update', 'insert', 'insert']);
  assert.equal(statements[0].sql, 'DELETE FROM "public"."customer" WHERE "id" = $1');
  assert.deepEqual(statements[0].params, ['3']);
  assert.equal(statements[1].sql, 'UPDATE "public"."customer" SET "name" = $1, "note" = $2 WHERE "id" = $3');
  assert.deepEqual(statements[1].params, ["Robert'); DROP TABLE students;--", null, '2']);
  assert.equal(statements[2].sql, 'INSERT INTO "public"."customer" ("name", "balance") VALUES ($1, $2)');
  assert.equal(statements[3].sql, 'INSERT INTO "public"."customer" DEFAULT VALUES');
  for (const one of statements) assert.equal(/DROP TABLE/.test(one.sql), false);

  const mysql = S.changeStatements({ engine: 'mysql', schema: 'shop', table: 'line', key: ['a', 'b'], changes: { updates: [{ key: { a: '1', b: '2' }, set: { qty: '9' } }], inserts: [{}] } });
  assert.equal(mysql[0].sql, 'UPDATE `shop`.`line` SET `qty` = ? WHERE `a` = ? AND `b` = ?');
  assert.deepEqual(mysql[0].params, ['9', '1', '2']);
  assert.equal(mysql[1].sql, 'INSERT INTO `shop`.`line` () VALUES ()');
});

test('a row with no key, or with half of one, is not guessed at', () => {
  assert.throws(() => S.changeStatements({ engine: 'postgres', schema: 'p', table: 't', key: [], changes: { deletes: [{ id: '1' }] } }), /no primary key/);
  assert.throws(() => S.changeStatements({ engine: 'postgres', schema: 'p', table: 't', key: ['a', 'b'], changes: { deletes: [{ a: '1' }] } }), /key \(b\) is missing/);
  assert.throws(() => S.changeStatements({ engine: 'postgres', schema: 'p', table: 't', key: ['a'], changes: { updates: [{ key: { a: null }, set: { x: '1' } }] } }), /key \(a\) is missing/);
});

test('rows leave as CSV, JSON and INSERTs without losing what was in them', () => {
  const columns = [{ name: 'id' }, { name: 'note' }];
  const rows = [['1', 'plain'], ['2', 'has "quotes", a comma\nand a line'], ['3', null]];
  assert.equal(S.toCsv(columns, rows), 'id,note\r\n1,plain\r\n2,"has ""quotes"", a comma\nand a line"\r\n3,\r\n');
  assert.deepEqual(JSON.parse(S.toJson(columns, rows))[2], { id: '3', note: null });
  assert.equal(
    S.toInserts('postgres', 'public', 't', columns, [['1', "it's"], ['2', null]]),
    `INSERT INTO "public"."t" ("id", "note") VALUES ('1', 'it''s');\nINSERT INTO "public"."t" ("id", "note") VALUES ('2', NULL);\n`,
  );
});

test('a pasted URL fills in a connection', () => {
  assert.deepEqual(S.parseUrl('postgres://ana:p%40ss@db.example.com:6543/orders?sslmode=require'), {
    engine: 'postgres', host: 'db.example.com', port: 6543, user: 'ana', password: 'p@ss', database: 'orders', ssl: 'on',
  });
  assert.equal(S.parseUrl('jdbc:postgresql://localhost/app').port, 5432);
  assert.equal(S.parseUrl('jdbc:mysql://localhost:3307/app?user=root&password=x').user, 'root');
  assert.equal(S.parseUrl('mariadb://u@h/d').engine, 'mysql');
  assert.equal(S.parseUrl('postgres://h/d?sslmode=verify-full').ssl, 'verify');
  assert.deepEqual(S.parseUrl('sqlite:///Users/me/app.db'), { engine: 'sqlite', file: '/Users/me/app.db' });
  assert.equal(S.parseUrl('https://example.com'), null);
  assert.equal(S.parseUrl('not a url'), null);
});

test('a delimited file is read a piece at a time, wherever the pieces happen to be cut', () => {
  const text = '﻿id,name,note\r\n1,"Ana, ""la"" primera",\n2,"two\nlines",""\r\n\n3,x';
  const whole = S.csvReader(',');
  const expected = [...whole.feed(text), ...whole.end()].map((row) => row.map((field) => S.csvValue(field, true)));
  assert.deepEqual(expected, [['id', 'name', 'note'], ['1', 'Ana, "la" primera', null], ['2', 'two\nlines', ''], ['3', 'x']]);
  // Cut anywhere — in the middle of a quote, between CR and LF, inside a doubled quote — it reads the same.
  for (let cut = 1; cut < text.length; cut += 1) {
    const reader = S.csvReader(',');
    const rows = [...reader.feed(text.slice(0, cut)), ...reader.feed(text.slice(cut)), ...reader.end()];
    assert.deepEqual(rows.map((row) => row.map((field) => S.csvValue(field, true))), expected, `cut at ${cut}`);
  }
  // Quoted nothing is an empty text somebody wrote; unquoted nothing is NULL only when asked.
  assert.equal(S.csvValue({ text: '' }, true), '');
  assert.equal(S.csvValue('', true), null);
  assert.equal(S.csvValue('', false), '');
  assert.equal(S.csvValue(undefined, false), null, 'a row shorter than the others has nothing there');
  const tabs = S.csvReader('\t');
  assert.deepEqual([...tabs.feed('a\tb,c\n'), ...tabs.end()], [['a', 'b,c']]);
});

test('the separator of a file is the one its lines agree on', () => {
  assert.equal(S.sniffDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(S.sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(S.sniffDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(S.sniffDelimiter('a|b|c\n1|2|3'), '|');
  assert.equal(S.sniffDelimiter('name,note\n"x;y;z;w",2'), ',', 'a separator inside quotes does not count');
  assert.equal(S.sniffDelimiter('price;note\n1,50;a\n2,75;b'), ';', 'a decimal comma is not a separator');
  assert.equal(S.sniffDelimiter('one column'), ',');
});

test('rows are sent many at a time, every value a parameter, inside what a server accepts', () => {
  const batch = S.insertBatch({ engine: 'postgres', schema: 'public', table: 't', columns: ['a', 'b'], rows: [['1', null], ["x'); DROP TABLE t;--", 'y']] });
  assert.equal(batch.sql, 'INSERT INTO "public"."t" ("a", "b") VALUES ($1, $2), ($3, $4)');
  assert.deepEqual(batch.params, ['1', null, "x'); DROP TABLE t;--", 'y']);
  assert.equal(S.insertBatch({ engine: 'mysql', schema: 's', table: 't', columns: ['a'], rows: [['1'], ['2']] }).sql, 'INSERT INTO `s`.`t` (`a`) VALUES (?), (?)');
  assert.throws(() => S.insertBatch({ engine: 'postgres', schema: 'p', table: 't', columns: [], rows: [[]] }), /No column/);
  for (const columns of [1, 7, 60, 400, 5000]) assert.ok(S.batchSize(columns) * columns <= 65535 && S.batchSize(columns) >= 1, String(columns));
});

test('a role is written with every attribute stated, and its password only in what is sent', () => {
  const made = S.roleStatements('postgres', 'create', { name: 'app user', login: true, createdb: true, password: "p'w $& $' end", connectionLimit: '5', validUntil: '2027-01-31', grant: ['readers', 'we"ird'] });
  assert.equal(made[0].sql, `CREATE ROLE "app user" WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 5 PASSWORD 'p''w $& $'' end' VALID UNTIL '2027-01-31'`);
  assert.equal(made[0].shown, `CREATE ROLE "app user" WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 5 PASSWORD '••••••' VALID UNTIL '2027-01-31'`);
  assert.deepEqual(made.slice(1).map((one) => one.sql), ['GRANT "readers" TO "app user"', 'GRANT "we""ird" TO "app user"']);
  for (const one of made) assert.equal(one.shown.includes("p'w"), false);

  // Changing a role without typing a password leaves the password alone; emptying its date means it no longer expires.
  const changed = S.roleStatements('postgres', 'alter', { name: 'ana', newName: 'ana2', login: false, connectionLimit: '', validUntil: '', revoke: ['writers'] });
  assert.deepEqual(changed.map((one) => one.sql), [
    `ALTER ROLE "ana" WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT -1 VALID UNTIL 'infinity'`,
    'REVOKE "writers" FROM "ana"',
    'ALTER ROLE "ana" RENAME TO "ana2"',
  ]);
  assert.deepEqual(S.roleStatements('postgres', 'drop', { name: 'ana' }).map((one) => one.sql), ['DROP ROLE "ana"']);
  assert.throws(() => S.roleStatements('postgres', 'create', { name: ' ' }), /needs a name/);
  assert.throws(() => S.roleStatements('postgres', 'create', { name: 'a', connectionLimit: 'many' }), /whole number/);
  assert.throws(() => S.roleStatements('postgres', 'explode', { name: 'a' }), /not something done/);
  assert.throws(() => S.roleStatements('sqlite', 'create', { name: 'a' }), /no roles/);
});

test('a MySQL user is a name at a host, and a backslash in either is a backslash', () => {
  assert.deepEqual(S.roleStatements('mysql', 'create', { name: 'app', password: 'a\\b\'c', locked: true }).map((one) => one.sql), [`CREATE USER 'app'@'%' IDENTIFIED BY 'a\\\\b''c' ACCOUNT LOCK`]);
  assert.deepEqual(S.roleStatements('mysql', 'create', { name: 'app', host: '10.0.%' }).map((one) => one.sql), [`CREATE USER 'app'@'10.0.%'`]);
  const changed = S.roleStatements('mysql', 'alter', { name: "o'b", host: 'h', password: 'x', locked: false, newName: 'ob' });
  assert.deepEqual(changed.map((one) => one.shown), [`ALTER USER 'o''b'@'h' IDENTIFIED BY '••••••'`, `ALTER USER 'o''b'@'h' ACCOUNT UNLOCK`, `RENAME USER 'o''b'@'h' TO 'ob'@'h'`]);
  assert.deepEqual(S.roleStatements('mysql', 'alter', { name: 'app', locked: null }), [], 'nothing asked for is nothing sent');
  assert.deepEqual(S.roleStatements('mysql', 'drop', { name: 'app', host: 'h' }).map((one) => one.sql), [`DROP USER 'app'@'h'`]);
  assert.equal(S.literalFor('postgres', 'a\\b'), "'a\\b'");
});

// ── what a person is asked before it happens ───────────────────────────────

test('a query is asked about only when it takes data away, and the question says where', () => {
  const base = { connectionName: 'orders (staging)', database: 'app', engine: 'postgres' };
  assert.equal(H.needsConsent('db.query', { ...base, sql: 'SELECT * FROM t' }), null);
  assert.equal(H.needsConsent('db.query', { ...base, sql: 'UPDATE t SET a = 1 WHERE id = 2; INSERT INTO t VALUES (1)' }), null);
  const question = H.needsConsent('db.query', { ...base, sql: 'DROP TABLE "public"."customer"' });
  assert.match(question, /^Run this on orders \(staging\), database app\?/);
  assert.match(question, /• DROP TABLE/);
  assert.match(question, /DROP TABLE "public"\."customer"/, 'a short statement is shown whole: which table is the question');
  assert.equal(H.consentAction(question), 'Run');
  assert.match(H.needsConsent('db.query', { ...base, sql: 'DELETE FROM t' }), /DELETE with no WHERE/);
});

test('on production anything that changes it is asked about, and reads are not', () => {
  const marked = { connectionName: 'orders', production: true, engine: 'mysql', database: 'shop' };
  assert.equal(H.needsConsent('db.query', { ...marked, sql: 'SELECT 1; SHOW TABLES; EXPLAIN DELETE FROM t' }), null);
  assert.match(H.needsConsent('db.query', { ...marked, sql: 'UPDATE t SET a = 1 WHERE id = 2' }), /It changes things: UPDATE\.\n\nThis is production\./);
  // A name that says production is production, whether or not the box was ticked.
  assert.match(H.needsConsent('db.query', { connectionName: 'orders-prod', engine: 'postgres', sql: 'INSERT INTO t VALUES (1)' }), /This is production/);
  assert.match(H.needsConsent('db.query', { ...marked, sql: 'TRUNCATE t' }), /TRUNCATE[\s\S]*This is production/);
});

test('a question cannot be rewritten by what a server or a script put in a name', () => {
  const question = H.needsConsent('db.query', { connectionName: 'x?\n\nThis is totally safe.\n\n', engine: 'postgres', sql: 'DROP TABLE t' });
  assert.equal(question.split('\n\n')[0], 'Run this on x? This is totally safe.?');
});

test('saving a grid asks when rows go, and on production when anything changes', () => {
  const base = { connectionName: 'orders', database: 'app', name: 'customer' };
  assert.equal(H.needsConsent('db.applyChanges', { ...base, changes: { updates: [{}], inserts: [{}] } }), null);
  assert.match(H.needsConsent('db.applyChanges', { ...base, changes: { deletes: [{}, {}], updates: [{}] } }), /^Delete 2 rows from customer on orders, database app\?[\s\S]*It also saves 1 other change\./);
  assert.match(H.needsConsent('db.applyChanges', { ...base, production: true, changes: { updates: [{}] } }), /^Save 1 change to customer on orders, database app\?\n\nThis is production\./);
});

test('ending a session and forgetting a connection ask; cancelling a query does not', () => {
  assert.equal(H.needsConsent('db.kill', { connectionName: 'orders', pid: '42' }), null);
  assert.match(H.needsConsent('db.kill', { connectionName: 'orders', pid: '42', hard: true }), /^Terminate session 42 on orders\?/);
  assert.match(H.needsConsent('db.deleteConnection', { connectionName: 'orders' }), /^Forget orders\?[\s\S]*not touched/);
});

test('database calls are routed by name, split into reading and changing, and nothing else gets through', () => {
  assert.equal(H.route('db.rows'), 'db');
  assert.equal(H.route('db.query'), 'db');
  assert.equal(H.route('db.ask'), 'app');
  assert.equal(H.route('db.brief'), null, 'the briefing is the app\'s to ask for, not a panel\'s');
  assert.equal(H.permissionFor('db.report'), 'db.read');
  assert.equal(H.permissionFor('db.snapshot'), 'db.read');
  assert.equal(H.permissionFor('db.metrics'), 'db.read');
  assert.equal(H.permissionFor('db.backup'), 'db.write');
  assert.equal(H.permissionFor('db.importPreview'), 'db.write', 'it reads a file off the disk');
  assert.equal(H.permissionFor('db.role'), 'db.write');
  assert.equal(H.permissionFor('db.openScript'), 'db.write', 'it reads a file off the disk');
  assert.equal(H.permissionFor('db.saveScript'), 'db.write');
  assert.equal(H.needsConsent('db.role', { connectionName: 'orders', action: 'drop', preview: true, role: { name: 'ana' } }), null, 'looking at the statement is not running it');
  assert.equal(H.needsConsent('db.role', { connectionName: 'orders', action: 'create', role: { name: 'ana' } }), null);
  assert.match(H.needsConsent('db.role', { connectionName: 'orders', action: 'drop', role: { name: 'ana' } }), /^Drop the role ana on orders\?/);
  assert.match(H.needsConsent('db.role', { connectionName: 'orders', action: 'drop', role: { name: 'app', host: '%' } }), /^Drop the role app@% on orders\?/);
  assert.match(H.needsConsent('db.role', { connectionName: 'orders', production: true, action: 'alter', role: { name: 'ana' } }), /^Change the role ana on orders\?\n\nThis is production\./);
  assert.equal(H.route('db.shell'), 'app');
  assert.equal(H.route('db.shellCommand'), null, 'the command line is the app\'s to ask for');
  assert.equal(H.permitted({ trusted: false, permissions: ['db.read', 'terminal'] }, 'db.shell'), false, 'a shell in a database can do what a query can');
  assert.equal(H.permitted({ trusted: false, permissions: ['db.write', 'terminal'] }, 'db.shell'), true);
  assert.equal(H.needsConsent('db.importRun', { connectionName: 'orders', name: 'customer' }), null);
  assert.match(H.needsConsent('db.importRun', { connectionName: 'orders', production: true, name: 'customer' }), /^Import rows into customer on orders\?\n\nThis is production\./);
  assert.match(H.needsConsent('db.restore', { connectionName: 'orders', database: 'app' }), /^Restore a backup into orders, database app\?/);
  assert.equal(H.needsConsent('db.backup', { connectionName: 'orders' }), null, 'a backup changes nothing, and the dialog already asks where');
  assert.equal(H.route('db.secret'), null);
  assert.equal(H.permissionFor('db.table'), 'db.read');
  assert.equal(H.permissionFor('db.query'), 'db.write');
  assert.equal(H.permissionFor('db.testConnection'), 'db.write', 'it opens a connection to whatever address it is given');
  assert.equal(H.permissionFor('db.ask'), 'terminal');
  const reader = { trusted: false, permissions: ['db.read', 'terminal'] };
  assert.equal(H.permitted(reader, 'db.rows'), true);
  assert.equal(H.permitted(reader, 'db.query'), false);
  assert.equal(H.permitted(reader, 'db.ask'), true);
  assert.equal(H.permitted({ trusted: false, permissions: ['terminal'] }, 'db.ask'), false, 'asking Claude about a table reads the table');
});
