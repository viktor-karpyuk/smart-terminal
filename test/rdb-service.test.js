'use strict';

/**
 * The Databases extension, end to end, against a real database: a SQLite file
 * made for the test, which is the one engine that needs no server.
 *
 * What is held here is what a person relies on without looking: that a
 * password never comes back out, that a read-only connection sends nothing but
 * reads, that saving a grid is all of it or none of it, that a row somebody
 * else changed is noticed rather than overwritten, and that an answer stops at
 * the number of rows that was asked for.
 *
 * Needs `node:sqlite` (Node 22+) and skips itself without it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

const { RdbService } = sqlite ? require('../electron/rdb-service') : {};
const { RdbStore } = require('../electron/rdb-store');
const drivers = require('../electron/rdb-drivers');

const secrets = {
  encrypt: (text) => `enc:${Buffer.from(text).toString('base64')}`,
  decrypt: (cipher) => Buffer.from(cipher.slice(4), 'base64').toString(),
};

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-rdb-'));
  const file = path.join(dir, 'shop.sqlite');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE customer (id integer PRIMARY KEY AUTOINCREMENT, name text NOT NULL, email text UNIQUE, balance numeric DEFAULT 0, photo blob);
    CREATE TABLE order_line (customer_id integer NOT NULL REFERENCES customer(id), line integer NOT NULL, sku text, PRIMARY KEY (customer_id, line));
    CREATE INDEX order_line_sku ON order_line (sku);
    CREATE TABLE log (at text, what text);
    CREATE VIEW rich AS SELECT * FROM customer WHERE balance > 100;
    INSERT INTO customer (name, email, balance) VALUES ('Ana', 'ana@x.io', 1234.5), ('Beto', 'beto@x.io', 0.1), ('Cata', NULL, 3);
    INSERT INTO order_line VALUES (1, 1, 'A-1'), (1, 2, 'B-7');
  `);
  db.close();
  return { dir, file };
}

async function make(extra = {}) {
  const { dir, file } = scratch();
  const written = [];
  const service = new RdbService({
    db: new sqlite.DatabaseSync(':memory:'),
    secrets,
    saveFile: async ({ suggestedName, build }) => { written.push({ name: suggestedName, text: await build() }); return { name: suggestedName }; },
    ...extra,
  });
  const saved = await service.call('saveConnection', { connection: { engine: 'sqlite', file, name: 'shop' } });
  assert.equal(saved.ok, true, saved.error);
  const id = saved.connection.id;
  return { service, id, file, dir, written, call: (name, args = {}) => service.call(name, { id, database: 'main', ...args }) };
}

test('a connection is checked before it is kept, and says what is wrong with it', () => {
  assert.throws(() => RdbStore.clean({ engine: 'oracle' }), /PostgreSQL, MySQL or SQLite/);
  assert.throws(() => RdbStore.clean({ engine: 'sqlite' }), /file/);
  assert.throws(() => RdbStore.clean({ engine: 'postgres', host: 'db.example.com/x' }), /host/);
  assert.throws(() => RdbStore.clean({ engine: 'postgres', host: 'h', port: 70000 }), /port/);
  const clean = RdbStore.clean({ engine: 'mysql', host: ' db ', user: 'root', database: 'shop' });
  assert.equal(clean.port, 3306);
  assert.equal(clean.name, 'shop@db');
  assert.equal(clean.ssl, 'off');
});

test('a password goes in encrypted and never comes back out to a panel', { skip }, async () => {
  const db = new sqlite.DatabaseSync(':memory:');
  const service = new RdbService({ db, secrets, open: async () => { throw new Error('not opened in this test'); } });
  const saved = await service.call('saveConnection', { connection: { engine: 'postgres', host: 'db', user: 'ana', password: 'hunter2-secret', database: 'app' } });
  assert.equal(saved.connection.hasPassword, true);
  assert.equal(JSON.stringify(saved).includes('hunter2'), false);
  assert.equal(JSON.stringify(await service.call('overview')).includes('hunter2'), false);
  const row = db.prepare('SELECT password FROM rdb_connection').get();
  assert.equal(row.password.includes('hunter2'), false, 'not in the clear on disk either');
  assert.equal(service.store.secret(saved.connection.id).password, 'hunter2-secret');

  // Saving again without typing one leaves it as it was; saying so clears it.
  await service.call('saveConnection', { connection: { id: saved.connection.id, engine: 'postgres', host: 'db2', user: 'ana', password: '' } });
  assert.equal(service.store.secret(saved.connection.id).password, 'hunter2-secret');
  assert.equal(service.store.secret(saved.connection.id).host, 'db2');
  await service.call('saveConnection', { connection: { id: saved.connection.id, engine: 'postgres', host: 'db2', clearPassword: true } });
  assert.equal(service.store.connection(saved.connection.id).hasPassword, false);
});

test('an error that repeats the password does not carry it to the panel', { skip }, async () => {
  const service = new RdbService({
    db: new sqlite.DatabaseSync(':memory:'),
    secrets,
    open: async (config) => { throw new Error(`could not log in with ${config.password}`); },
  });
  const saved = await service.call('saveConnection', { connection: { engine: 'postgres', host: 'db', password: 'hunter2-secret' } });
  const answer = await service.call('databases', { id: saved.connection.id });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.includes('hunter2'), false);
  assert.match(answer.error, /••••••/);
});

test('the tree is read from the database itself', { skip }, async () => {
  const { call, service } = await make();
  const objects = await call('objects');
  assert.deepEqual(objects.relations.map((one) => `${one.kind}:${one.name}`), ['table:customer', 'table:log', 'table:order_line', 'view:rich']);

  const { table } = await call('table', { name: 'order_line' });
  assert.deepEqual(table.key, ['customer_id', 'line']);
  assert.deepEqual(table.columns.map((column) => column.name), ['customer_id', 'line', 'sku']);
  assert.equal(table.columns[0].nullable, false);
  assert.equal(table.foreignKeys[0].refTable, 'customer');
  assert.ok(table.indexes.some((index) => index.name === 'order_line_sku' && index.columns === 'sku'));
  assert.match(table.ddl, /CREATE TABLE order_line/);
  assert.match(table.ddl, /CREATE INDEX order_line_sku/);

  assert.deepEqual((await call('table', { name: 'rich' })).table.key, [], 'a view has no key to edit by');
  assert.equal((await call('table', { name: 'nope' })).ok, false);
  assert.equal((await service.call('overview')).connections[0].open, true);
  await service.stop();
  assert.equal((await service.call('overview')).connections[0].open, false);
});

test('a page of rows is text, filtered and ordered, and the filter cannot carry a second statement', { skip }, async () => {
  const { call, service } = await make();
  const page = await call('rows', { name: 'customer', where: "name <> 'Beto'", orderBy: [{ column: 'id', desc: true }], limit: 1 });
  assert.equal(page.ok, true, page.error);
  assert.deepEqual(page.columns.map((column) => column.name), ['id', 'name', 'email', 'balance', 'photo']);
  assert.deepEqual(page.rows, [['3', 'Cata', null, '3', null]]);
  assert.equal((await call('count', { name: 'customer', where: "name <> 'Beto'" })).count, 2);
  const refused = await call('rows', { name: 'customer', where: 'id = 1; DELETE FROM customer' });
  assert.equal(refused.ok, false);
  assert.equal((await call('count', { name: 'customer' })).count, 3);
  await service.stop();
});

test('a script runs statement by statement, stops at the first that fails, and says which line', { skip }, async () => {
  const { call, service } = await make();
  const answer = await call('query', { tab: 'a', sql: "SELECT name FROM customer ORDER BY id;\nINSERT INTO log VALUES ('now', 'a;b');\n\nSELECT *\nFROM nowhere;\nSELECT 1" });
  assert.equal(answer.ok, true);
  assert.equal(answer.ran, 3);
  assert.equal(answer.of, 4);
  assert.deepEqual(answer.results[0].rows, [['Ana'], ['Beto'], ['Cata']]);
  assert.equal(answer.results[1].rowCount, 1);
  assert.match(answer.results[2].error.error, /nowhere/);
  assert.equal(answer.results[2].error.line, 4);
  // What ran before the failure stays run, as it does in any SQL client.
  assert.equal((await call('count', { name: 'log' })).count, 1);
  // Each result says where its statement sits in what was sent.
  const sql = 'SELECT 1;  SELECT 2 AS two';
  const two = (await call('query', { tab: 'a', sql })).results[1];
  assert.equal(sql.slice(two.at[0], two.at[1]).trim(), 'SELECT 2 AS two');
  assert.equal((await call('query', { tab: 'a', sql: '  -- only a comment' })).ok, false);
  await service.stop();
});

test('an answer stops at the number of rows asked for, and says there were more', { skip }, async () => {
  const { call, service } = await make();
  await call('query', { tab: 'a', sql: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) INSERT INTO log SELECT i, i FROM n' });
  const capped = (await call('query', { tab: 'a', sql: 'SELECT * FROM log', maxRows: 20 })).results[0];
  assert.equal(capped.rows.length, 20);
  assert.equal(capped.truncated, true);
  assert.equal(capped.rowCount, null, 'how many there are in all is not known, and is not guessed');
  const whole = (await call('query', { tab: 'a', sql: 'SELECT * FROM log' })).results[0];
  assert.equal(whole.rows.length, 500);
  assert.equal(whole.truncated, false);
  await service.stop();
});

test('each query tab has a connection of its own, so a transaction belongs to its tab', { skip }, async () => {
  const { call, service } = await make();
  const begun = await call('query', { tab: 'one', sql: "BEGIN; INSERT INTO log VALUES ('t', 'uncommitted')" });
  assert.equal(begun.txn, 'open');
  assert.equal((await call('query', { tab: 'two', sql: 'SELECT count(*) FROM log' })).results[0].rows[0][0], '0', 'another tab does not see it');
  // Closing the tab closes its connection, and the work that was not committed goes with it.
  await call('closeTab', { tab: 'one' });
  assert.equal((await call('count', { name: 'log' })).count, 0);
  await service.stop();
});

test('saving a grid is all of it or none of it', { skip }, async () => {
  const { call, service } = await make();
  const done = await call('applyChanges', {
    name: 'customer',
    changes: { updates: [{ key: { id: '2' }, set: { name: "O'Brien", email: null } }], inserts: [{ name: 'Dora', balance: '7.5' }], deletes: [{ id: '3' }] },
  });
  assert.equal(done.ok, true, done.error);
  assert.equal(done.applied, 3);
  assert.deepEqual((await call('rows', { name: 'customer' })).rows.map((row) => row.slice(0, 4)), [
    ['1', 'Ana', 'ana@x.io', '1234.5'], ['2', "O'Brien", null, '0.1'], ['4', 'Dora', null, '7.5'],
  ]);

  // The second change fails (name is NOT NULL), so the first is not kept either.
  const failed = await call('applyChanges', { name: 'customer', changes: { updates: [{ key: { id: '1' }, set: { name: 'Changed' } }, { key: { id: '2' }, set: { name: null } }] } });
  assert.equal(failed.ok, false);
  assert.equal((await call('rows', { name: 'customer', where: 'id = 1' })).rows[0][1], 'Ana');
  await service.stop();
});

test('a row somebody else changed is noticed, not overwritten', { skip }, async () => {
  const { call, service } = await make();
  const stale = await call('applyChanges', { name: 'customer', changes: { updates: [{ key: { id: '999' }, set: { name: 'x' } }], inserts: [{ name: 'never' }] } });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /changed or removed by somebody else/);
  assert.equal((await call('count', { name: 'customer' })).count, 3, 'the insert that came with it was not kept');
  await service.stop();
});

test('a grid cannot write to a column that is not there, a table with no key, or a view', { skip }, async () => {
  const { call, service } = await make();
  assert.match((await call('applyChanges', { name: 'customer', changes: { inserts: [{ 'name") VALUES (1); --': 'x' }] } })).error, /no column/);
  assert.match((await call('applyChanges', { name: 'log', changes: { deletes: [{ at: 'x' }] } })).error, /no primary key/);
  assert.match((await call('applyChanges', { name: 'rich', changes: { deletes: [{ id: '1' }] } })).error, /no primary key/);
  await service.stop();
});

test('a read-only connection sends nothing but reads, and the file is opened that way too', { skip }, async () => {
  const { service, file } = await make();
  const saved = await service.call('saveConnection', { connection: { engine: 'sqlite', file, name: 'ro', readOnly: true } });
  const call = (name, args = {}) => service.call(name, { id: saved.connection.id, database: 'main', ...args });
  assert.match((await call('query', { tab: 'a', sql: 'DELETE FROM customer' })).error, /read-only, so DELETE was not sent/);
  assert.match((await call('query', { tab: 'a', sql: 'SELECT 1; PRAGMA writable_schema = 1' })).error, /read-only/);
  assert.match((await call('applyChanges', { name: 'customer', changes: { deletes: [{ id: '1' }] } })).error, /read-only/);
  assert.deepEqual((await call('query', { tab: 'a', sql: 'SELECT count(*) FROM customer' })).results[0].rows, [['3']]);
  // And underneath the refusal, the engine's own: a driver asked directly still cannot write.
  const session = await drivers.open({ engine: 'sqlite', file, readOnly: true });
  await assert.rejects(session.run('DELETE FROM customer'), /readonly|read-only/i);
  await session.close();
  await service.stop();
});

test('an export is the whole answer, and only of one statement that reads', { skip }, async () => {
  const { call, service, written } = await make();
  const done = await call('export', { sql: 'SELECT id, name FROM customer ORDER BY id', format: 'csv', name: 'my customers!' });
  assert.equal(done.ok, true, done.error);
  assert.equal(done.rows, 3);
  assert.equal(written[0].name, 'my_customers_.csv');
  assert.equal(written[0].text, 'id,name\r\n1,Ana\r\n2,Beto\r\n3,Cata\r\n');
  await call('export', { sql: 'SELECT id, name FROM customer WHERE id = 1', format: 'sql', table: 'customer' });
  assert.equal(written[1].text, `INSERT INTO "customer" ("id", "name") VALUES ('1', 'Ana');\n`);
  assert.equal((await call('export', { sql: 'DELETE FROM customer', format: 'csv' })).ok, false);
  assert.equal((await call('export', { sql: 'SELECT 1; SELECT 2', format: 'csv' })).ok, false);
  assert.equal((await call('count', { name: 'customer' })).count, 3);
  await service.stop();
});

test('what was run is remembered per connection, and a query can be kept by name', { skip }, async () => {
  const { call, service, id } = await make();
  await call('query', { tab: 'a', sql: 'SELECT 1' });
  await call('query', { tab: 'a', sql: 'SELEC 2' });
  const { history } = await call('history');
  assert.deepEqual(history.map((one) => [one.sql, one.ok]), [['SELEC 2', false], ['SELECT 1', true]]);
  assert.equal((await call('history', { q: 'SELECT' })).history.length, 1);

  const kept = await service.call('saveQuery', { connection: id, name: 'ones', sql: 'SELECT 1' });
  assert.equal(kept.saved[0].name, 'ones');
  assert.equal((await service.call('saveQuery', { name: '', sql: 'SELECT 1' })).ok, false);
  await service.call('deleteConnection', { id });
  assert.equal((await service.call('overview')).connections.length, 0);
  assert.equal((await service.call('overview')).saved.length, 1, 'a saved query outlives the connection it was written on');
});

test('Claude is handed the table, or the statement that failed — gathered here, not written by a panel', { skip }, async () => {
  const { call, service } = await make();
  const about = await call('brief', { name: 'order_line' });
  assert.match(about.text, /the table order_line on the SQLite connection "shop"/);
  assert.match(about.text, /CREATE TABLE order_line/);
  assert.match(about.text, /Do not run anything against the database yourself/);
  assert.equal((await call('brief', { failed: true })).ok, false, 'nothing has failed yet');
  await call('query', { tab: 'a', sql: 'SELECT * FROM nowhere' });
  const failed = await call('brief', { failed: true });
  assert.match(failed.text, /SELECT \* FROM nowhere/);
  assert.match(failed.text, /The server said: no such table: nowhere/);
  await service.stop();
});

test('bytes are shown as what they are, and a name that is not a verb goes nowhere', { skip }, async () => {
  const { call, service } = await make();
  await call('query', { tab: 'a', sql: "UPDATE customer SET photo = x'00ff10' WHERE id = 1; UPDATE customer SET photo = CAST('plain text' AS blob) WHERE id = 2" });
  const page = await call('rows', { name: 'customer', orderBy: [{ column: 'id' }] });
  assert.equal(page.rows[0][4], '\\x00ff10');
  assert.equal(page.rows[1][4], 'plain text');
  assert.ok(page.clipped.includes('0:4'), 'a cell of bytes is not edited as text');
  assert.equal((await service.call('constructor')).ok, false);
  assert.equal((await service.call('toString')).ok, false);
  await service.stop();
});

test('a page that is only read says so when the engine has nothing to answer, and finds things by name', { skip }, async () => {
  const { call, service } = await make();
  const found = await call('report', { kind: 'search', q: 'order' });
  assert.equal(found.supported, true);
  assert.deepEqual(found.sections[0].rows.map((row) => `${row[0]}:${row[2]}`), ['table:order_line', 'index:order_line_sku']);
  assert.equal(found.sections[0].open, true);
  // A wildcard in what was typed is a character, not a wildcard.
  assert.equal((await call('report', { kind: 'search', q: '%' })).sections[0].rows.length, 0);
  assert.equal((await call('report', { kind: 'tableStats', name: 'customer' })).supported, false);
  assert.equal((await call('report', { kind: 'constructor' })).supported, false);
  assert.equal((await call('metrics')).supported, false);
  await service.stop();
});

test('a file is imported by the columns that were matched, all of it or none of it', { skip }, async () => {
  let file = null;
  const { call, service, dir } = await make({ pickCsv: async () => file });
  assert.equal((await call('importPreview', { name: 'customer' })).cancelled, true);

  file = path.join(dir, 'people.csv');
  fs.writeFileSync(file, '﻿Full Name;Mail;ignored;Balance\r\n"Dora; the fourth";dora@x.io;zzz;7,5\r\nElena;;zzz;\r\n"Fede ""el"" sexto";"";zzz;12\r\n');
  const preview = await call('importPreview', { name: 'customer' });
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.delimiter, 'semicolon');
  assert.deepEqual(preview.sample[0], ['Full Name', 'Mail', 'ignored', 'Balance']);
  assert.deepEqual(preview.sample[1], ['Dora; the fourth', 'dora@x.io', 'zzz', '7,5']);
  assert.deepEqual(preview.columns.map((column) => [column.name, column.nullable, column.filled]), [
    ['id', true, false], ['name', false, false], ['email', true, false], ['balance', true, true], ['photo', true, false],
  ]);
  assert.equal(JSON.stringify(preview).includes(dir), false, 'the panel is told the file\'s name, never where it is');

  const mapping = [{ from: 0, to: 'name' }, { from: 1, to: 'email' }, { from: 3, to: 'balance' }];
  const done = await call('importRun', { token: preview.token, mapping, header: true, emptyAsNull: true });
  assert.equal(done.ok, true, done.error);
  assert.equal(done.rows, 3);
  assert.deepEqual((await call('rows', { name: 'customer', where: 'id > 3', orderBy: [{ column: 'id' }] })).rows.map((row) => row.slice(1, 4)), [
    ['Dora; the fourth', 'dora@x.io', '7,5'],
    // Nothing between two separators is NULL; a pair of quotes with nothing in them is an empty text.
    ['Elena', null, null],
    ['Fede "el" sexto', '', '12'],
  ]);
  assert.equal((await call('importRun', { token: preview.token, mapping })).ok, false, 'a file is imported once per preview');
  assert.equal((await call('importRun', { token: 'made-up', mapping })).ok, false);

  // The same file again breaks the unique email on its first row: nothing of it stays.
  const again = await call('importPreview', { name: 'customer' });
  const failed = await call('importRun', { token: again.token, mapping, header: true });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /UNIQUE[\s\S]*rows 2–4 of the file\. Nothing was imported\./);
  assert.equal((await call('count', { name: 'customer' })).count, 6);

  assert.match((await call('importRun', { token: (await call('importPreview', { name: 'customer' })).token, mapping: [{ from: 0, to: 'nope' }] })).error, /no column "nope"/);
  assert.match((await call('importRun', { token: (await call('importPreview', { name: 'customer' })).token, mapping: [{ from: 0, to: 'name' }, { from: 1, to: 'name' }] })).error, /same column/);
  assert.match((await call('importPreview', { name: 'rich' })).error, /is a view/);
  await service.stop();
});

test('a big file goes in as batches and comes out as the same number of rows', { skip }, async () => {
  let file = null;
  const { call, service, dir } = await make({ pickCsv: async () => file });
  file = path.join(dir, 'log.csv');
  const lines = [];
  for (let i = 0; i < 12_345; i += 1) lines.push(`${i},"line ${i}, with a comma"`);
  fs.writeFileSync(file, lines.join('\n'));
  const preview = await call('importPreview', { name: 'log' });
  const done = await call('importRun', { token: preview.token, mapping: [{ from: 0, to: 'at' }, { from: 1, to: 'what' }], header: false });
  assert.equal(done.rows, 12_345);
  assert.equal((await call('count', { name: 'log' })).count, 12_345);
  assert.deepEqual((await call('rows', { name: 'log', where: "at = '12344'" })).rows, [['12344', 'line 12344, with a comma']]);
  await service.stop();
});

test('a terminal is given the password in a file only the person can read, and never on its command line', { skip }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'st-rdb-shell-'));
  const service = new RdbService({ db: new sqlite.DatabaseSync(':memory:'), secrets, scratch, findTool: (name) => (name === 'mysql' ? null : `/opt/pg tools/${name}`) });
  const pg = (await service.call('saveConnection', { connection: { engine: 'postgres', host: 'db.example.com', port: 6543, user: 'ana', password: 'p:w\\d hunter2', database: 'app', ssl: 'on', readOnly: true } })).connection;
  const shell = await service.call('shellCommand', { id: pg.id, database: 'orders' });
  assert.equal(shell.ok, true, shell.error);
  assert.equal(shell.command.includes('hunter2'), false);
  assert.match(shell.command, /^PGPASSFILE=\S+ PGSSLMODE=require PGOPTIONS='-c default_transaction_read_only=on' '\/opt\/pg tools\/psql' -h db\.example\.com -p 6543 -U ana -d orders$/);
  const passfile = /^PGPASSFILE=(\S+)/.exec(shell.command)[1];
  assert.equal(path.dirname(passfile), scratch);
  assert.equal(fs.statSync(passfile).mode & 0o777, 0o600);
  // pgpass escapes a colon and a backslash, or the password would be read as two fields.
  assert.equal(fs.readFileSync(passfile, 'utf8'), 'db.example.com:6543:*:ana:p\\:w\\\\d hunter2\n');
  await service.stop();
  assert.equal(fs.existsSync(passfile), false, 'and it does not outlive the app');

  const odd = (await service.call('saveConnection', { connection: { engine: 'postgres', host: 'db', user: "o'brien", database: 'app' } })).connection;
  assert.match((await service.call('shellCommand', { id: odd.id })).error, /cannot pass to a shell safely/);
  const my = (await service.call('saveConnection', { connection: { engine: 'mysql', host: 'db', password: 'x' } })).connection;
  assert.match((await service.call('shellCommand', { id: my.id })).error, /mysql is not installed/);
  assert.deepEqual(fs.readdirSync(scratch), [], 'a command that could not be written leaves no password behind');
});

test('a role\'s password reaches the server and nothing else: not the preview, the history or an error', { skip }, async () => {
  const sent = [];
  let refuse = false;
  const fake = {
    engine: 'postgres', closed: false, txn: 'idle',
    all: async (text) => { sent.push(text); return []; },
    run: async (text) => {
      sent.push(text);
      if (refuse) throw Object.assign(new Error('could not use password hunter2-secret'), { detail: 'role exists' });
      return { columns: [], rows: [], rowCount: 0, clipped: [], notices: [] };
    },
    cancel: async () => false, close: async () => {},
  };
  const service = new RdbService({ db: new sqlite.DatabaseSync(':memory:'), secrets, open: async () => fake });
  const id = (await service.call('saveConnection', { connection: { engine: 'postgres', host: 'db' } })).connection.id;
  const role = { name: 'ana', login: true, password: 'hunter2-secret', grant: ['readers'] };

  const preview = await service.call('role', { id, action: 'create', preview: true, role });
  assert.match(preview.sql, /^CREATE ROLE "ana" WITH LOGIN[^\n]*PASSWORD '••••••'[^\n]*;\nGRANT "readers" TO "ana";$/);
  assert.equal(JSON.stringify(preview).includes('hunter2'), false);
  assert.deepEqual(sent, [], 'a preview sends nothing');

  const made = await service.call('role', { id, action: 'create', role });
  assert.equal(made.ok, true, made.error);
  // Two statements, so one transaction: a role is not left half made.
  assert.deepEqual(sent.map((text) => text.split(' ').slice(0, 2).join(' ')), ['BEGIN', 'CREATE ROLE', 'GRANT "readers"', 'COMMIT']);
  assert.ok(sent[1].includes("PASSWORD 'hunter2-secret'"));
  assert.equal(JSON.stringify(await service.call('history', { id })).includes('hunter2'), false);

  sent.length = 0;
  refuse = true;
  const failed = await service.call('role', { id, action: 'create', role });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.includes('hunter2'), false);
  assert.match(failed.error, /could not use password ••••••/);
  assert.equal(sent[sent.length - 1], 'ROLLBACK');
  assert.equal(JSON.stringify(await service.call('history', { id })).includes('hunter2'), false);

  const ro = (await service.call('saveConnection', { connection: { engine: 'postgres', host: 'db', readOnly: true } })).connection.id;
  assert.match((await service.call('role', { id: ro, action: 'drop', role: { name: 'ana' } })).error, /read-only/);
  assert.equal((await service.call('role', { id: ro, action: 'drop', preview: true, role: { name: 'ana' } })).sql, 'DROP ROLE "ana";');
});

test('a script is opened from, and saved to, a file the person chose — by name, never by path', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-rdb-script-'));
  let picked = null;
  const saved = [];
  const service = new RdbService({
    db: new sqlite.DatabaseSync(':memory:'),
    secrets,
    pickScript: async () => picked,
    saveFile: async ({ suggestedName, extension, title, build }) => { saved.push({ suggestedName, extension, title, text: await build() }); return { name: suggestedName }; },
  });
  assert.equal((await service.call('openScript')).cancelled, true);
  picked = path.join(dir, 'report.sql');
  fs.writeFileSync(picked, '﻿SELECT 1;\n-- ñandú\n');
  const opened = await service.call('openScript');
  assert.deepEqual(opened, { ok: true, name: 'report.sql', text: 'SELECT 1;\n-- ñandú\n' });
  fs.writeFileSync(picked, Buffer.from([0x53, 0x00, 0x51, 0x00]));
  assert.match((await service.call('openScript')).error, /is not text/);
  fs.writeFileSync(picked, Buffer.alloc(6 * 1024 * 1024, 0x2d));
  assert.match((await service.call('openScript')).error, /6 MB[\s\S]*restore it/);

  assert.equal((await service.call('saveScript', { text: 'SELECT 2', name: 'my query/../x' })).name, 'my query_.._x.sql');
  assert.deepEqual(saved[0], { suggestedName: 'my query_.._x.sql', extension: 'sql', title: 'Save script', text: 'SELECT 2\n' });
  assert.equal((await service.call('saveScript', { text: 'x\n', name: 'report.SQL' })).name, 'report.SQL');
  assert.equal(saved[1].text, 'x\n');
});

test('triggers and indexes of a SQLite file are pages too', { skip }, async () => {
  const { call, service } = await make();
  await call('query', { tab: 'a', sql: "CREATE TRIGGER log_customer AFTER INSERT ON customer BEGIN INSERT INTO log VALUES ('now', NEW.name); END" });
  const triggers = await call('report', { kind: 'triggers' });
  assert.deepEqual(triggers.sections[0].rows.map((row) => row.slice(0, 2)), [['customer', 'log_customer']]);
  assert.equal(triggers.sections[0].open, true);
  const indexes = await call('report', { kind: 'indexes' });
  assert.ok(indexes.sections[0].rows.some((row) => row[0] === 'order_line' && row[1] === 'order_line_sku'));
  assert.equal(indexes.sections[0].rows.some((row) => /^sqlite_/.test(row[1])), false, 'the ones SQLite makes for itself are not listed');
  await service.stop();
});

test('a file\'s whole definition is read in one go, to compare it with another\'s', { skip }, async () => {
  const { call, service } = await make();
  await call('query', { tab: 'a', sql: "CREATE TRIGGER log_customer AFTER INSERT ON customer BEGIN INSERT INTO log VALUES ('now', NEW.name); END" });
  const got = await call('snapshot');
  assert.equal(got.ok, true, got.error);
  assert.equal(got.engine, 'sqlite');
  assert.deepEqual(got.snapshot.tables.map((table) => table.name), ['customer', 'log', 'order_line']);
  assert.match(got.snapshot.tables[0].ddl, /^CREATE TABLE customer/);
  assert.deepEqual(got.snapshot.tables[2].indexes.map((index) => index.name), ['order_line_sku']);
  assert.deepEqual(got.snapshot.views.map((view) => view.name), ['rich']);
  // What a diagram is drawn from: each table's key, and where its foreign keys lead.
  const line = got.snapshot.tables[2];
  assert.deepEqual(line.key, ['customer_id', 'line']);
  assert.deepEqual(line.columns.map((column) => column.name), ['customer_id', 'line', 'sku']);
  assert.deepEqual(line.constraints.map((one) => [one.type, one.columns, one.refTable, one.refColumns]), [['FOREIGN KEY', ['customer_id'], 'customer', ['id']]]);
  assert.deepEqual(got.snapshot.routines.map((one) => `${one.kind}:${one.name}`), ['trigger:log_customer']);
  await service.stop();
});

test('a backup goes where the person said, and cancelling the dialog does nothing', { skip }, async () => {
  let target = null;
  const { call, service, dir } = await make({ pickSavePath: async () => target });
  const cancelled = await call('backup');
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);
  target = path.join(dir, 'copy.sqlite');
  const done = await call('backup');
  assert.equal(done.ok, true, done.error);
  assert.equal(done.file, 'copy.sqlite');
  const copy = new sqlite.DatabaseSync(target);
  assert.equal(copy.prepare('SELECT count(*) AS n FROM customer').get().n, 3);
  copy.close();
  assert.match((await call('restore')).error, /put the file back/);
  await service.stop();
});

test('a dump tool is given the password in its environment, never on its command line', { skip }, async () => {
  const ran = [];
  const service = new RdbService({
    db: new sqlite.DatabaseSync(':memory:'),
    secrets,
    pickSavePath: async ({ suggestedName }) => path.join(os.tmpdir(), suggestedName),
    pickBackup: async () => __filename,
    findTool: (name) => (name === 'mysqldump' ? null : `/tools/${name}`),
    runTool: async (file, args, options) => { ran.push({ file, args, env: options.env }); return ''; },
  });
  const pg = (await service.call('saveConnection', { connection: { engine: 'postgres', host: 'db', user: 'ana', password: 'hunter2-secret', database: 'app', ssl: 'verify' } })).connection;
  const done = await service.call('backup', { id: pg.id, database: 'orders', schema: 'public', name: 'we"ird', format: 'custom', schemaOnly: true });
  assert.equal(done.ok, true, done.error);
  assert.equal(ran[0].file, '/tools/pg_dump');
  assert.equal(ran[0].args.join(' ').includes('hunter2'), false);
  assert.equal(ran[0].env.PGPASSWORD, 'hunter2-secret');
  assert.equal(ran[0].env.PGSSLMODE, 'verify-full');
  assert.ok(ran[0].args.includes('--schema-only') && ran[0].args.includes('--no-password'));
  assert.deepEqual(ran[0].args.slice(ran[0].args.indexOf('-d'), ran[0].args.indexOf('-d') + 4), ['-d', 'orders', '-F', 'c']);
  assert.equal(ran[0].args[ran[0].args.indexOf('-t') + 1], '"public"."we""ird"');

  // This test file is not a pg_dump archive, so it is SQL, and SQL goes through psql — stopping at the first error.
  const back = await service.call('restore', { id: pg.id, database: 'orders' });
  assert.equal(back.ok, true, back.error);
  assert.equal(ran[1].file, '/tools/psql');
  assert.ok(ran[1].args.includes('ON_ERROR_STOP=1'));

  const my = (await service.call('saveConnection', { connection: { engine: 'mysql', host: 'db', user: 'root', password: 'pw' } })).connection;
  assert.match((await service.call('backup', { id: my.id, database: 'shop' })).error, /mysqldump is not installed/);
  const ro = (await service.call('saveConnection', { connection: { engine: 'postgres', host: 'db', readOnly: true } })).connection;
  assert.match((await service.call('restore', { id: ro.id })).error, /read-only/);
});

test('a file that is not there is not made into an empty database', { skip }, async () => {
  const { service, dir } = await make();
  const missing = path.join(dir, 'typo.sqlite');
  const answer = await service.call('testConnection', { connection: { engine: 'sqlite', file: missing } });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /no file/);
  assert.equal(fs.existsSync(missing), false);
  await service.stop();
});

test('a page about something that is not installed says so, and asks nothing more of the server', { skip }, async () => {
  const asked = [];
  const session = {
    engine: 'postgres', txn: 'idle', closed: false,
    all: async (text, params) => { asked.push([text, params]); return /to_regclass/.test(text) ? [{ there: params[0] === 'cron.job' ? 't' : 'f' }] : []; },
    run: async (text) => { asked.push([text]); return { columns: [{ name: 'job' }], rows: [['expire sessions']], truncated: false }; },
    close: async () => {},
  };
  const far = new RdbService({ db: new sqlite.DatabaseSync(':memory:'), secrets, open: async () => session });
  const saved = await far.call('saveConnection', { connection: { engine: 'postgres', host: 'db', user: 'u', name: 'far' } });
  const page = await far.call('report', { id: saved.connection.id, database: 'shop', kind: 'jobs' });
  const agent = page.sections.filter((section) => section.title.startsWith('pgAgent'));
  const cron = page.sections.filter((section) => section.title.startsWith('pg_cron'));
  assert.ok(agent.length >= 3 && cron.length >= 1);
  for (const section of agent) {
    assert.match(section.absent, /pgAgent is not installed/);
    assert.equal(section.error, undefined);
    assert.deepEqual(section.rows, []);
  }
  for (const section of cron) assert.deepEqual(section.rows, [['expire sessions']]);
  // What is not there was never queried: the only thing said about pgagent is the question whether it exists.
  assert.equal(asked.some(([text]) => /FROM pgagent\./.test(text)), false);
  await far.stop();
});
