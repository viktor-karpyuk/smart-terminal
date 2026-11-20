'use strict';

/**
 * The Databases extension: the part of it that is text and nothing else.
 *
 * Reading SQL well enough to answer four questions — where one statement ends
 * and the next begins, whether a statement only reads, whether it takes
 * something away that nothing brings back, and how a name is written so that
 * it stays a name. And writing SQL for the three things the grid does to a
 * row. No connection is opened here and nothing is required, so all of it can
 * be tested without a server.
 *
 * `scan` and `risks` exist twice: here, and in src/lib/extensionHost.ts, where
 * the question a person is asked is written. A test holds the two together.
 */

const ENGINES = ['postgres', 'mysql', 'sqlite'];

/** A name, quoted the way its engine quotes names. */
function quoteIdent(engine, name) {
  const text = String(name ?? '');
  if (!text) throw new Error('A name is missing');
  if (text.includes('\u0000')) throw new Error('A name cannot contain a NUL');
  if (engine === 'mysql') return `\`${text.replace(/`/g, '``')}\``;
  return `"${text.replace(/"/g, '""')}"`;
}

/** `schema.table`, each half quoted. SQLite has no schema worth writing. */
function qualified(engine, schema, name) {
  if (engine === 'sqlite' || !schema) return quoteIdent(engine, name);
  return `${quoteIdent(engine, schema)}.${quoteIdent(engine, name)}`;
}

/** A value written into SQL text, for a script somebody will read and run. */
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** The n-th parameter, as its engine writes it. */
function placeholder(engine, n) {
  return engine === 'postgres' ? `$${n}` : '?';
}

/**
 * Cut a script into statements.
 *
 * Each comes back twice: `text`, which is what is sent, and `bare`, which is
 * the same statement with every comment gone and every quoted thing replaced
 * by a placeholder — so that `WHERE` inside a string is not mistaken for a
 * `WHERE`, and a semicolon inside a function body does not end the statement.
 *
 * Understood: '…' with '' doubled, "…", `…`, -- line comments (and MySQL's #),
 * block comments, MySQL's backslash escapes, and PostgreSQL's $tag$ … $tag$. Not understood: MySQL's DELIMITER,
 * which is the client's own command and not SQL.
 */
function scan(sql, engine) {
  const source = String(sql ?? '');
  const mysql = engine === 'mysql';
  const out = [];
  let text = '';
  let bare = '';
  let start = 0;
  let i = 0;
  const push = (end) => {
    const trimmed = text.trim();
    const plain = bare.replace(/\s+/g, ' ').trim();
    if (plain) out.push({ text: trimmed, bare: plain, start, end });
    text = '';
    bare = '';
    start = end;
  };
  while (i < source.length) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    // `#` starts a comment in MySQL and is an operator everywhere else.
    if (two === '--' || (ch === '#' && mysql)) {
      let end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      text += source.slice(i, end);
      bare += ' ';
      i = end;
      continue;
    }
    if (two === '/*') {
      let end = source.indexOf('*/', i + 2);
      end = end === -1 ? source.length : end + 2;
      text += source.slice(i, end);
      bare += ' ';
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let end = i + 1;
      while (end < source.length) {
        // A backslash escapes in MySQL; in standard SQL it is a backslash.
        if (mysql && source[end] === '\\' && ch !== '`' && end + 1 < source.length) { end += 2; continue; }
        if (source[end] === ch) {
          if (source[end + 1] === ch) { end += 2; continue; }
          break;
        }
        end += 1;
      }
      end = Math.min(source.length, end + 1);
      text += source.slice(i, end);
      bare += ch === "'" ? "''" : 'q';
      i = end;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(source.slice(i, i + 64));
      if (tag) {
        let end = source.indexOf(tag[0], i + tag[0].length);
        end = end === -1 ? source.length : end + tag[0].length;
        text += source.slice(i, end);
        bare += "''";
        i = end;
        continue;
      }
    }
    if (ch === ';') {
      i += 1;
      // Inside the body of a trigger or a routine a semicolon ends a line of it, not the statement.
      if (inBody(bare)) {
        text += ch;
        bare += ch;
        continue;
      }
      push(i);
      continue;
    }
    text += ch;
    bare += ch;
    i += 1;
  }
  push(source.length);
  return out;
}

/**
 * Whether what has been read so far is a CREATE TRIGGER / PROCEDURE / FUNCTION /
 * EVENT whose BEGIN has not met its END. MySQL and SQLite write those bodies
 * as plain statements with semicolons between them; PostgreSQL usually quotes
 * its bodies in dollars, where there is nothing to count.
 */
function inBody(bare) {
  if (!/^\s*CREATE\b[\s\S]*?\b(TRIGGER|PROCEDURE|FUNCTION|EVENT)\b/i.test(bare)) return false;
  const opens = (bare.match(/\b(BEGIN|CASE)\b/gi) ?? []).length;
  // END IF, END LOOP and their like close something that was never counted as opened.
  const closes = (bare.match(/\bEND\b(?!\s+(IF|LOOP|WHILE|REPEAT)\b)/gi) ?? []).length;
  return opens > closes;
}

/** SET GLOBAL and SET PERSIST in MySQL, in any of the ways they are written. PostgreSQL's ALTER SYSTEM is an ALTER and needs no help. */
const SERVER_WIDE = /^(SET\s+(GLOBAL|PERSIST|PERSIST_ONLY)\b|SET\s+@@(GLOBAL|PERSIST|PERSIST_ONLY)\.|RESET\s+PERSIST\b)/;

const READS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE']);
const WRITES = /\b(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/;

/**
 * What one statement is, from its bare form.
 *
 * `read` is the only answer that lets a statement through a read-only
 * connection, so anything not recognised is `other`, not `read`.
 */
function classify(bare) {
  const upper = String(bare ?? '').toUpperCase().replace(/^[\s(]+/, '');
  const verb = /^[A-Z]+/.exec(upper)?.[0] ?? '';
  if (verb === 'EXPLAIN') {
    // EXPLAIN ANALYZE runs the statement it explains; plain EXPLAIN only plans it.
    const analyzed = /^EXPLAIN\s*(\([^)]*\bANALYZE\b[^)]*\)|ANALYZE\b)/.test(upper);
    if (!analyzed) return { verb, kind: 'read' };
    const rest = upper.replace(/^EXPLAIN\s*((\([^)]*\)|ANALYZE\b|VERBOSE\b)\s*)*/, '');
    const inner = classify(rest);
    return { verb: `EXPLAIN ANALYZE ${inner.verb}`.trim(), kind: inner.kind };
  }
  if (verb === 'WITH') return { verb, kind: WRITES.test(upper) ? 'write' : 'read' };
  if (verb === 'SELECT') {
    // SELECT … INTO makes a table in PostgreSQL; SELECT … FOR UPDATE takes locks.
    return { verb, kind: /\bINTO\s+(?!@|OUTFILE|DUMPFILE)/.test(upper) && !/\bINSERT\b/.test(upper) ? 'write' : 'read' };
  }
  if (READS.has(verb)) return { verb, kind: 'read' };
  if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'COPY', 'LOAD', 'CALL', 'DO'].includes(verb)) return { verb, kind: 'write' };
  if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT', 'GRANT', 'REVOKE', 'REINDEX', 'VACUUM', 'ANALYZE', 'CLUSTER', 'REFRESH', 'OPTIMIZE'].includes(verb)) {
    return { verb, kind: 'ddl' };
  }
  if (['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT'].includes(verb)) return { verb, kind: 'tx' };
  // A setting for this session is the session's own business; one for the whole server changes the server.
  if (SERVER_WIDE.test(upper)) return { verb: verb === 'SET' ? 'SET GLOBAL' : 'RESET PERSIST', kind: 'ddl' };
  if (['SET', 'RESET', 'USE'].includes(verb)) return { verb, kind: 'session' };
  return { verb, kind: 'other' };
}

/**
 * The statements in a script that take something away, each in a few words.
 *
 * A DROP, a TRUNCATE, and a DELETE or UPDATE with no WHERE — the four that are
 * typed by accident and regretted at once. Everything else is what a query
 * tool is for and is not asked about.
 */
function risks(sql, engine) {
  const found = [];
  for (const statement of scan(sql, engine)) {
    let upper = statement.bare.toUpperCase();
    const explained = /^EXPLAIN\s*(\([^)]*\bANALYZE\b[^)]*\)|ANALYZE\b)/.test(upper);
    if (/^EXPLAIN\b/.test(upper)) {
      if (!explained) continue;
      upper = upper.replace(/^EXPLAIN\s*((\([^)]*\)|ANALYZE\b|VERBOSE\b)\s*)*/, '');
    }
    const words = upper.split(' ');
    if (words[0] === 'DROP') found.push(words.slice(0, 2).join(' ').slice(0, 40));
    else if (words[0] === 'TRUNCATE') found.push('TRUNCATE');
    else if (/^ALTER\b.*\bDROP\b(?!\s+(NOT\s+NULL|DEFAULT|IDENTITY|EXPRESSION)\b)/.test(upper)) found.push(`${words.slice(0, 2).join(' ')} … DROP`.slice(0, 40));
    else if (/\bDELETE\s+FROM\b/.test(upper) && !/\bWHERE\b/.test(upper)) found.push('DELETE with no WHERE');
    else if ((words[0] === 'UPDATE' || /^WITH\b.*\bUPDATE\b/.test(upper)) && /\bSET\b/.test(upper) && !/\bWHERE\b/.test(upper)) found.push('UPDATE with no WHERE');
  }
  return found;
}

/** Whether every statement of a script only reads. An empty script reads nothing, and is not a read. */
function readsOnly(sql, engine) {
  const statements = scan(sql, engine);
  return statements.length > 0 && statements.every((one) => classify(one.bare).kind === 'read');
}

/** How many rows a page may hold, and what is asked for when nothing is said. */
const PAGE_MAX = 5000;
const PAGE_DEFAULT = 200;

function pageSize(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, PAGE_MAX) : PAGE_DEFAULT;
}

/**
 * One page of a table.
 *
 * The names are quoted here; the filter is the person's own SQL and goes in as
 * it was typed, which is the point of it. It is one expression in a WHERE —
 * anything after a semicolon is refused rather than sent, so a filter cannot
 * carry a second statement on an engine that would run one.
 */
function selectPage({ engine, schema, table, where, orderBy, limit, offset }) {
  let sql = `SELECT * FROM ${qualified(engine, schema, table)}`;
  const filter = String(where ?? '').trim().replace(/;\s*$/, '');
  if (filter) {
    const parts = scan(filter, engine);
    if (parts.length !== 1) throw new Error('A filter is one condition, not several statements');
    sql += ` WHERE ${filter}`;
  }
  const order = (Array.isArray(orderBy) ? orderBy : [])
    .filter((one) => one && one.column)
    .map((one) => `${quoteIdent(engine, one.column)}${one.desc ? ' DESC' : ''}`);
  if (order.length) sql += ` ORDER BY ${order.join(', ')}`;
  const size = pageSize(limit);
  const skip = Math.max(0, Math.floor(Number(offset)) || 0);
  sql += ` LIMIT ${size}`;
  if (skip) sql += ` OFFSET ${skip}`;
  return sql;
}

/** How many rows that filter leaves, for "1–200 of 48,112". */
function countRows({ engine, schema, table, where }) {
  let sql = `SELECT COUNT(*) FROM ${qualified(engine, schema, table)}`;
  const filter = String(where ?? '').trim().replace(/;\s*$/, '');
  if (filter) {
    if (scan(filter, engine).length !== 1) throw new Error('A filter is one condition, not several statements');
    sql += ` WHERE ${filter}`;
  }
  return sql;
}

/**
 * The statements that make a grid's edits real, each with its parameters.
 *
 * A row is found by its key and by nothing else: the columns of the primary
 * key, with the values they had when the row was read. A table with no key
 * cannot be edited here — "the row that looks like this one" may be two rows.
 *
 * Values travel as parameters, text or NULL, and the server reads each as the
 * type of its column. Nothing a cell contains is ever written into the SQL.
 */
function changeStatements({ engine, schema, table, key, changes }) {
  const target = qualified(engine, schema, table);
  const keys = (Array.isArray(key) ? key : []).map(String);
  const out = [];
  const where = (row, params) => {
    if (!keys.length) throw new Error('This table has no primary key, so a row in it cannot be told from another');
    return keys
      .map((column) => {
        if (!row || !Object.hasOwn(row, column) || row[column] === null || row[column] === undefined) {
          throw new Error(`The row's key (${column}) is missing`);
        }
        params.push(String(row[column]));
        return `${quoteIdent(engine, column)} = ${placeholder(engine, params.length)}`;
      })
      .join(' AND ');
  };
  const value = (given) => (given === null || given === undefined ? null : String(given));

  for (const row of changes?.deletes ?? []) {
    const params = [];
    out.push({ kind: 'delete', sql: `DELETE FROM ${target} WHERE ${where(row, params)}`, params });
  }
  for (const change of changes?.updates ?? []) {
    const columns = Object.keys(change?.set ?? {});
    if (!columns.length) continue;
    const params = [];
    const set = columns
      .map((column) => {
        params.push(value(change.set[column]));
        return `${quoteIdent(engine, column)} = ${placeholder(engine, params.length)}`;
      })
      .join(', ');
    out.push({ kind: 'update', sql: `UPDATE ${target} SET ${set} WHERE ${where(change.key, params)}`, params });
  }
  for (const row of changes?.inserts ?? []) {
    // A column left alone is left to its default; an empty row is a row of defaults.
    const columns = Object.keys(row ?? {}).filter((column) => row[column] !== undefined);
    if (!columns.length) {
      out.push({ kind: 'insert', sql: engine === 'mysql' ? `INSERT INTO ${target} () VALUES ()` : `INSERT INTO ${target} DEFAULT VALUES`, params: [] });
      continue;
    }
    const params = columns.map((column) => value(row[column]));
    const marks = columns.map((_, index) => placeholder(engine, index + 1)).join(', ');
    out.push({
      kind: 'insert',
      sql: `INSERT INTO ${target} (${columns.map((column) => quoteIdent(engine, column)).join(', ')}) VALUES (${marks})`,
      params,
    });
  }
  return out;
}

/** One CSV cell: quoted when it has to be, and NULL as nothing at all. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(columns, rows) {
  const lines = [columns.map((column) => csvCell(column.name)).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function toJson(columns, rows) {
  const names = columns.map((column) => column.name);
  return `${JSON.stringify(rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? null]))), null, 2)}\n`;
}

/** The rows as INSERT statements, for carrying a few of them somewhere else. */
function toInserts(engine, schema, table, columns, rows) {
  const target = qualified(engine, schema, table || 'table_name');
  const names = columns.map((column) => quoteIdent(engine, column.name)).join(', ');
  return `${rows.map((row) => `INSERT INTO ${target} (${names}) VALUES (${row.map(literal).join(', ')});`).join('\n')}\n`;
}

/** Text written into a statement for one engine. MySQL reads a backslash as an escape; the others read it as a backslash. */
function literalFor(engine, value) {
  const text = String(value ?? '');
  if (text.includes('\u0000')) throw new Error('A value cannot contain a NUL');
  return engine === 'mysql' ? `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'` : `'${text.replace(/'/g, "''")}'`;
}

/** A MySQL account, which is a user at a host. */
function mysqlAccount(user, host) {
  const name = String(user ?? '').trim();
  if (!name) throw new Error('The user needs a name');
  return `${literalFor('mysql', name)}@${literalFor('mysql', String(host ?? '').trim() || '%')}`;
}

/**
 * The statements that make, change or remove a role.
 *
 * Each comes back twice: `sql`, which is sent, and `shown`, which is the same
 * statement with the password replaced by dots — the only form of it that is
 * ever put on a screen or kept in the history.
 *
 * PostgreSQL states every attribute, so what the form shows is what the role
 * has afterwards, whatever it had before. Memberships are given as the two
 * lists that changed, never as the whole set, so a role is not taken out of a
 * group nobody looked at.
 */
function roleStatements(engine, action, role) {
  const given = role && typeof role === 'object' ? role : {};
  const name = String(given.name ?? '').trim();
  if (!name) throw new Error('The role needs a name');
  const password = typeof given.password === 'string' ? given.password : '';
  const out = [];
  // A function, not a string: in a replacement string `$&` and `$'` mean something, and a password may contain them.
  const add = (text, secret) => out.push({ sql: secret ? text.replace('\u0001', () => secret) : text, shown: text.replace('\u0001', "'••••••'") });

  if (engine === 'mysql') {
    const account = mysqlAccount(name, given.host);
    if (action === 'drop') { add(`DROP USER ${account}`); return out; }
    if (action === 'create') {
      add(`CREATE USER ${account}${password ? ' IDENTIFIED BY \u0001' : ''}${given.locked === true ? ' ACCOUNT LOCK' : ''}`, password ? literalFor('mysql', password) : null);
      return out;
    }
    if (action !== 'alter') throw new Error('That is not something done to a role');
    if (password) add(`ALTER USER ${account} IDENTIFIED BY \u0001`, literalFor('mysql', password));
    if (given.locked === true || given.locked === false) add(`ALTER USER ${account} ACCOUNT ${given.locked ? 'LOCK' : 'UNLOCK'}`);
    const fresh = String(given.newName ?? '').trim();
    if (fresh && fresh !== name) add(`RENAME USER ${account} TO ${mysqlAccount(fresh, given.host)}`);
    return out;
  }
  if (engine !== 'postgres') throw new Error('This engine has no roles');

  const target = quoteIdent('postgres', name);
  if (action === 'drop') { add(`DROP ROLE ${target}`); return out; }
  if (action !== 'create' && action !== 'alter') throw new Error('That is not something done to a role');
  const options = [
    given.login ? 'LOGIN' : 'NOLOGIN',
    given.superuser ? 'SUPERUSER' : 'NOSUPERUSER',
    given.createdb ? 'CREATEDB' : 'NOCREATEDB',
    given.createrole ? 'CREATEROLE' : 'NOCREATEROLE',
    given.replication ? 'REPLICATION' : 'NOREPLICATION',
  ];
  const limit = given.connectionLimit === '' || given.connectionLimit === null || given.connectionLimit === undefined ? -1 : Number(given.connectionLimit);
  if (!Number.isInteger(limit) || limit < -1) throw new Error('The connection limit is a whole number, or empty for none');
  options.push(`CONNECTION LIMIT ${limit}`);
  if (password) options.push('PASSWORD \u0001');
  const until = String(given.validUntil ?? '').trim();
  // Stated either way: an empty date on a role that had one means it no longer expires.
  options.push(`VALID UNTIL ${literalFor('postgres', until || 'infinity')}`);
  add(`${action === 'create' ? 'CREATE' : 'ALTER'} ROLE ${target} WITH ${options.join(' ')}`, password ? literalFor('postgres', password) : null);
  for (const group of Array.isArray(given.grant) ? given.grant : []) add(`GRANT ${quoteIdent('postgres', group)} TO ${target}`);
  for (const group of Array.isArray(given.revoke) ? given.revoke : []) add(`REVOKE ${quoteIdent('postgres', group)} FROM ${target}`);
  const fresh = String(given.newName ?? '').trim();
  // Last, so everything before it finds the role by the name it still has.
  if (action === 'alter' && fresh && fresh !== name) add(`ALTER ROLE ${target} RENAME TO ${quoteIdent('postgres', fresh)}`);
  return out;
}

/**
 * Which character separates the fields of a delimited file, from its first
 * lines: the one of comma, semicolon, tab and pipe that appears outside quotes
 * the same number of times on every line, and more than any other.
 */
function sniffDelimiter(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim()).slice(0, 10);
  let best = ',';
  let score = 0;
  for (const candidate of [',', ';', '\t', '|']) {
    const counts = lines.map((line) => {
      let n = 0;
      let quoted = false;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        else if (ch === candidate && !quoted) n += 1;
      }
      return n;
    });
    if (!counts.length || counts[0] === 0) continue;
    const steady = counts.every((n) => n === counts[0]);
    const points = counts[0] * (steady ? 10 : 1);
    if (points > score) {
      score = points;
      best = candidate;
    }
  }
  return best;
}

/**
 * A delimited file read a piece at a time.
 *
 * Fields in double quotes may hold the delimiter, a line break and a doubled
 * quote; lines end in LF or CRLF. `feed` returns the rows that are complete so
 * far and keeps the rest for the next piece, so a file of any size is read
 * without being held. A quoted field is remembered as quoted: `""` is an empty
 * string somebody wrote, and nothing at all between two commas may be a NULL.
 */
function csvReader(delimiter = ',') {
  let field = '';
  let row = [];
  let quoted = false;
  let wasQuoted = false;
  let pendingQuote = false;
  let pendingReturn = false;
  let started = false;
  const done = [];
  const endField = () => {
    row.push(wasQuoted ? { text: field } : field);
    field = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    // A line with nothing on it is not a row of one empty field.
    if (!(row.length === 1 && row[0] === '')) done.push(row);
    row = [];
  };
  const take = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (!started) {
        started = true;
        if (ch === '﻿') continue;
      }
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') { field += '"'; continue; }
        quoted = false;
      }
      if (pendingReturn) {
        pendingReturn = false;
        if (ch === '\n') continue;
      }
      if (quoted) {
        if (ch === '"') pendingQuote = true;
        else field += ch;
      } else if (ch === '"' && field === '' && !wasQuoted) {
        quoted = true;
        wasQuoted = true;
      } else if (ch === delimiter) endField();
      else if (ch === '\n') endRow();
      else if (ch === '\r') { endRow(); pendingReturn = true; }
      else field += ch;
    }
  };
  return {
    feed(text) {
      take(String(text));
      return done.splice(0);
    },
    end() {
      if (pendingQuote) { pendingQuote = false; quoted = false; }
      if (field !== '' || row.length || wasQuoted) endRow();
      return done.splice(0);
    },
  };
}

/** A field as it was read, as the value to store: quoted text is kept, and an unquoted nothing is NULL when asked. */
function csvValue(field, emptyAsNull) {
  if (field && typeof field === 'object') return field.text;
  if (field === undefined) return null;
  return field === '' && emptyAsNull ? null : field;
}

/** Postgres takes at most 65535 parameters in one statement; this stays well inside it for every engine. */
const INSERT_PARAMS_MAX = 20_000;

/** How many rows of that many columns go in one INSERT. */
function batchSize(columns) {
  return Math.max(1, Math.min(500, Math.floor(INSERT_PARAMS_MAX / Math.max(1, columns))));
}

/** Many rows in one INSERT, every value a parameter. */
function insertBatch({ engine, schema, table, columns, rows }) {
  if (!columns.length) throw new Error('No column was chosen to import into');
  const names = columns.map((column) => quoteIdent(engine, column)).join(', ');
  const params = [];
  const tuples = rows.map((row) => `(${columns.map((_, index) => {
    params.push(row[index] ?? null);
    return placeholder(engine, params.length);
  }).join(', ')})`);
  return { sql: `INSERT INTO ${qualified(engine, schema, table)} (${names}) VALUES ${tuples.join(', ')}`, params };
}

/**
 * A connection out of a URL somebody pasted.
 *
 * `postgres://user:pass@host:5432/db?sslmode=require`, the same for mysql and
 * mariadb, JDBC's `jdbc:` in front of either, and `sqlite:///path/to/file`.
 * Returns null for anything else, so the form can say it did not understand.
 */
function parseUrl(text) {
  const raw = String(text ?? '').trim().replace(/^jdbc:/i, '');
  const lite = /^sqlite:(?:\/\/)?(.+)$/i.exec(raw);
  if (lite) return { engine: 'sqlite', file: lite[1] };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const engine = scheme === 'postgres' || scheme === 'postgresql' ? 'postgres' : scheme === 'mysql' || scheme === 'mariadb' ? 'mysql' : null;
  if (!engine) return null;
  const decode = (value) => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const mode = (url.searchParams.get('sslmode') ?? url.searchParams.get('ssl-mode') ?? url.searchParams.get('ssl') ?? '').toLowerCase();
  const ssl = /verify/.test(mode) ? 'verify' : /^(require|required|prefer|preferred|true|1)$/.test(mode) ? 'on' : 'off';
  return {
    engine,
    host: url.hostname,
    port: url.port ? Number(url.port) : engine === 'postgres' ? 5432 : 3306,
    user: decode(url.username || url.searchParams.get('user') || ''),
    password: decode(url.password || url.searchParams.get('password') || ''),
    database: decode(url.pathname.replace(/^\//, '')),
    ssl,
  };
}

/**
 * The tables a statement names, as far as its words show: what follows FROM,
 * JOIN, UPDATE and INTO. Good enough to fetch their definitions for somebody
 * reading the statement; never used to decide what a statement may do.
 */
function tablesIn(text) {
  const found = [];
  const seen = new Set();
  const flat = String(text ?? '').replace(/'(?:[^']|'')*'/g, "''");
  const pattern = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?((?:[`"]?[A-Za-z_][\w$]*[`"]?\s*\.\s*)?[`"]?[A-Za-z_][\w$]*[`"]?)/gi;
  let match;
  while ((match = pattern.exec(flat))) {
    const parts = match[1].split('.').map((part) => part.trim().replace(/^[`"]|[`"]$/g, ''));
    const name = parts.pop();
    const schema = parts.pop() ?? null;
    if (/^(SELECT|LATERAL|UNNEST|GENERATE_SERIES|VALUES|SET)$/i.test(name)) continue;
    const key = `${schema ?? ''}.${name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ schema, name });
  }
  return found;
}

module.exports = {
  tablesIn,
  ENGINES,
  PAGE_MAX,
  PAGE_DEFAULT,
  quoteIdent,
  qualified,
  literal,
  placeholder,
  scan,
  classify,
  risks,
  readsOnly,
  pageSize,
  selectPage,
  countRows,
  changeStatements,
  csvCell,
  toCsv,
  toJson,
  toInserts,
  parseUrl,
  sniffDelimiter,
  literalFor,
  mysqlAccount,
  roleStatements,
  csvReader,
  csvValue,
  batchSize,
  insertBatch,
};
