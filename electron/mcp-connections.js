'use strict';

/**
 * MCP servers the person adds by hand: a name, an address, a token, and —
 * for a product that serves one server per module, like Kubrik OS or
 * Timelogbook — the modules to reach under that address.
 *
 * A connection without modules is one MCP server at its address. One with
 * modules is a server per module at `<address>/<module>`
 * (`https://mcp.kubrik.io` with `acc, crm` is `…/acc` and `…/crm`), shown and
 * offered to Claude as one connection.
 *
 * Servers are spoken to as MCP's Streamable HTTP transport says: `initialize`
 * first, the `Mcp-Session-Id` the server hands back on every later message,
 * and an answer that is either JSON or a short event stream. A stateless server
 * that hands back no session id works the same way.
 *
 * This is the only thing in the app that holds a token or names an address:
 * the panel asks for verbs, a Claude session asks through the relay in
 * `mcp-relay-stdio.js`, and both arrive here. Tokens are encrypted by the
 * system's keychain and never handed back out.
 *
 * Tool names are kept as the server gives them. Under modules, a tool whose
 * name does not start with its module (`ask_agent`, which every Kubrik module
 * serves) is offered as `<module>_<name>`, so that every name means one server.
 *
 * A tool the server does not mark read-only is never run on anybody's word
 * but a person's, in a native dialog — whether the panel or a session asked.
 */

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 35_000;
/** Some servers run an agent behind a tool; a turn of one can take minutes. */
const SLOW_TOOL = /(?:^|_)ask_agent$/;
const SLOW_TIMEOUT_MS = 150_000;
/** What a session is handed of one answer. */
const MAX_SESSION_TEXT = 60_000;
/** What the panel is handed: it shows it as a tree and can take more. */
const MAX_PANEL_TEXT = 400_000;
/** Per session and connection, per minute: enough to work, not enough for a loop to spend the person's rate limit. */
const SESSION_CALLS_PER_MINUTE = 40;
const MAX_CONNECTIONS = 30;
const MAX_MODULES = 30;
/** Pages of `tools/list` followed before giving up on a server that never stops. */
const MAX_TOOL_PAGES = 20;

/** Names the app's own MCP servers already have in every session. */
const RESERVED = new Set(['smart-terminal', 'code-review', 'jenkins', 'bitbucket']);

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS mcpc_connection (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     url TEXT NOT NULL,
     modules TEXT NOT NULL DEFAULT '[]',
     token TEXT NOT NULL DEFAULT '',
     claude INTEGER NOT NULL DEFAULT 0,
     position INTEGER NOT NULL DEFAULT 0
   );`,
];

class McpError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A name as typed, as a server name: lowercase letters, digits and dashes. */
function nameOf(input) {
  const name = String(input ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!name) throw new McpError('Give the connection a name.');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new McpError('A name is letters, numbers and dashes, up to 40, like kubrik or timelogbook-dev.');
  if (RESERVED.has(name)) throw new McpError(`"${name}" is already one of the app's own servers. Pick another name.`);
  return name;
}

/** The address as typed: https anywhere, plain http only to this computer — the token is a password. */
function addressOf(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new McpError('Type the address of the MCP server.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new McpError('That is not a web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new McpError('The address has to start with https://');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) throw new McpError('Use https:// — the token would travel in the clear.');
  if (url.username || url.password) throw new McpError('Leave the user and password out of the address; the token is what signs in.');
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** Modules as typed: `acc, crm` or one per line. Each is a path segment. */
function modulesOf(input) {
  const list = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/))
    .map((m) => String(m).trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(list)];
  for (const m of unique) if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(m)) throw new McpError(`"${m.slice(0, 40)}" is not a module name: letters, numbers and dashes.`);
  if (unique.length > MAX_MODULES) throw new McpError(`That is more than ${MAX_MODULES} modules.`);
  return unique;
}

function endpointsOf(connection) {
  return connection.modules.length
    ? connection.modules.map((module) => ({ module, url: `${connection.url}/${module}` }))
    : [{ module: null, url: connection.url }];
}

function readOnly(tool) {
  return tool?.annotations?.readOnlyHint === true;
}

function cut(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n… (cut: the answer was ${s.length} characters)` : s;
}

/** The JSON-RPC answer with this id in a body that is JSON or an event stream. */
function answerIn(body, contentType, id) {
  const messages = [];
  if (/text\/event-stream/i.test(contentType ?? '')) {
    for (const event of String(body).split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* a keep-alive or something that is not ours */
      }
    }
  } else if (body) {
    try {
      messages.push(JSON.parse(body));
    } catch {
      return null;
    }
  }
  const flat = messages.flatMap((m) => (Array.isArray(m) ? m : [m]));
  return flat.find((m) => m && m.id === id && (m.result !== undefined || m.error !== undefined)) ?? flat.find((m) => m && (m.result !== undefined || m.error !== undefined)) ?? null;
}

class McpConnections {
  constructor({ db, secrets, fetch = globalThis.fetch, emit = () => {}, changed = () => {}, confirm = null, openExternal = null, language = () => 'en', version = '0', now = () => Date.now(), log = () => {}, newId = null }) {
    this.db = db;
    this.secrets = secrets ?? {
      encrypt: (text) => Buffer.from(text).toString('base64'),
      decrypt: (cipher) => Buffer.from(cipher, 'base64').toString(),
    };
    this.fetch = fetch;
    this.emit = emit;
    /** Called after anything that changes which servers a Claude session should be given. */
    this.changed = changed;
    this.confirm = confirm;
    this.openExternal = openExternal;
    this.language = language;
    this.version = version;
    this.now = now;
    this.log = log;
    this.newId = newId ?? (() => `mc-${Math.random().toString(36).slice(2, 10)}`);
    /** Per connection: what its servers offered the last time anybody asked. */
    this.found = new Map();
    this.finding = new Map();
    /** Per endpoint: the session id and protocol version `initialize` gave. */
    this.sessions = new Map();
    this.calls = new Map();
    this.rpcId = 0;
    this.#migrate();
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS mcpc_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM mcpc_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO mcpc_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) {
      throw new Error(`The MCP connection tables are at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    }
    for (let version = row.version; version < MIGRATIONS.length; version++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE mcpc_schema SET version = ?').run(version + 1);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  // --- what is kept -----------------------------------------------------------

  #row(row) {
    let modules = [];
    try {
      modules = JSON.parse(row.modules);
    } catch {
      modules = [];
    }
    return { id: row.id, name: row.name, url: row.url, modules, claude: Boolean(row.claude), position: row.position, cipher: row.token };
  }

  /** Every connection, without its token. */
  all() {
    return this.db.prepare('SELECT * FROM mcpc_connection ORDER BY position, name').all().map((row) => {
      const { cipher, ...rest } = this.#row(row);
      return { ...rest, hasToken: Boolean(cipher) };
    });
  }

  /** One connection with its token. A token the system can no longer decrypt is `tokenError`, not a throw. */
  get(id) {
    const row = this.db.prepare('SELECT * FROM mcpc_connection WHERE id = ?').get(String(id ?? ''));
    if (!row) return null;
    const { cipher, ...rest } = this.#row(row);
    let token = '';
    let tokenError = false;
    if (cipher) {
      try {
        token = this.secrets.decrypt(cipher);
      } catch {
        tokenError = true;
      }
    }
    return { ...rest, token, tokenError };
  }

  /** The connections a Claude session should be given a server for: `[{ id, name }]`. */
  forSessions() {
    return this.all().filter((c) => c.claude).map((c) => ({ id: c.id, name: c.name }));
  }

  #forget(id) {
    this.found.delete(id);
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`${id}|`)) this.sessions.delete(key);
  }

  // --- the wire ---------------------------------------------------------------

  async #post(connection, url, message, { timeoutMs = TIMEOUT_MS, session = null } = {}) {
    if (connection.tokenError) throw new McpError('The token saved for this connection can no longer be read on this computer. Paste it again.', { code: 'TOKEN_UNREADABLE' });
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Accept-Language': this.language(),
    };
    if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
    if (session?.id) headers['Mcp-Session-Id'] = session.id;
    if (session?.protocol) headers['MCP-Protocol-Version'] = session.protocol;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(message), signal: abort.signal, redirect: 'error' });
      const body = await response.text().catch(() => '');
      return { response, body };
    } catch (error) {
      if (abort.signal.aborted) throw new McpError(`${connection.name} did not answer in ${Math.round(timeoutMs / 1000)} seconds.`, { code: 'TIMEOUT' });
      throw new McpError(`Could not reach ${new URL(url).host}: ${error?.cause?.code ?? error?.message ?? error}`, { code: 'UNREACHABLE' });
    } finally {
      clearTimeout(timer);
    }
  }

  #refusal(connection, url, module, response, body) {
    let json = null;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      json = null;
    }
    const said = json && typeof json.message === 'string' ? json.message
      : (json && typeof json.error === 'string' && !/^unauthorized$/i.test(json.error) ? json.error : '');
    const code = json && typeof json.code === 'string' ? json.code : '';
    const what = module ? `${connection.name}/${module}` : connection.name;
    if (response.status === 401) return new McpError(`${what} refused the token${said ? `: ${said}` : ''}. It may be wrong, revoked or expired.`, { status: 401, code: code || 'UNAUTHENTICATED' });
    if (response.status === 403) return new McpError(said || `The token has no access to ${what}.`, { status: 403, code: code || 'FORBIDDEN' });
    if (response.status === 404) return new McpError(said || `There is no MCP server at ${url}.`, { status: 404, code: code || 'NOT_FOUND' });
    if (response.status === 429) {
      const wait = response.headers?.get?.('retry-after');
      return new McpError(`${what} says too many calls${wait ? `; try again in ${wait} seconds` : ''}.`, { status: 429, code: 'RATE_LIMITED' });
    }
    return new McpError(`${what} answered ${response.status}${said ? `: ${said}` : ''}.`, { status: response.status, code });
  }

  /** `initialize` and `notifications/initialized` on one endpoint; what it said is kept for the calls after. */
  async #initialize(connection, endpoint) {
    const id = ++this.rpcId;
    const { response, body } = await this.#post(connection, endpoint.url, {
      jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'smart-terminal', version: this.version } },
    });
    if (!response.ok) throw this.#refusal(connection, endpoint.url, endpoint.module, response, body);
    const answer = answerIn(body, response.headers?.get?.('content-type'), id);
    if (!answer) throw new McpError(`What answered at ${endpoint.url} is not an MCP server.`, { code: 'NOT_MCP' });
    if (answer.error) throw new McpError(String(answer.error.message ?? 'The server would not start a session.'), { code: String(answer.error.code ?? '') });
    const session = {
      id: response.headers?.get?.('mcp-session-id') || null,
      protocol: answer.result?.protocolVersion || PROTOCOL_VERSION,
      instructions: typeof answer.result?.instructions === 'string' ? answer.result.instructions.slice(0, 4000) : null,
    };
    // A notification: nothing comes back that matters, and a server that answers it with an error is still usable.
    await this.#post(connection, endpoint.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session }).catch(() => {});
    this.sessions.set(`${connection.id}|${endpoint.url}`, session);
    return session;
  }

  /** One request to one endpoint, starting a session first if there is none, and once more if the server forgot it. */
  async rpc(connection, endpoint, method, params, { timeoutMs = TIMEOUT_MS } = {}) {
    const key = `${connection.id}|${endpoint.url}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = this.sessions.get(key) ?? await this.#initialize(connection, endpoint);
      const id = ++this.rpcId;
      const { response, body } = await this.#post(connection, endpoint.url, { jsonrpc: '2.0', id, method, params: params ?? {} }, { timeoutMs, session });
      // A session the server no longer knows is a 404 for that session: start another, once.
      if (response.status === 404 && session.id && attempt === 0) {
        this.sessions.delete(key);
        continue;
      }
      if (!response.ok) throw this.#refusal(connection, endpoint.url, endpoint.module, response, body);
      const answer = answerIn(body, response.headers?.get?.('content-type'), id);
      if (!answer) throw new McpError(`What answered at ${endpoint.url} is not an MCP server.`, { code: 'NOT_MCP' });
      if (answer.error) throw new McpError(String(answer.error.message ?? `${connection.name} could not do that.`), { code: String(answer.error.code ?? '') });
      return answer.result ?? {};
    }
    throw new McpError(`${connection.name} keeps forgetting its session.`, { code: 'SESSION_LOST' });
  }

  /** A tool as offered: its name means one server, and `real` is the name that server knows it by. */
  #offered(endpoint, tool) {
    const named = !endpoint.module || tool.name.startsWith(`${endpoint.module}_`);
    return {
      ...tool,
      name: named ? tool.name : `${endpoint.module}_${tool.name}`,
      real: tool.name,
      module: endpoint.module,
      url: endpoint.url,
      description: named ? tool.description : `${endpoint.module}: ${tool.description ?? ''}`,
    };
  }

  /** Every endpoint's tools, asked at once. One the token does not reach is kept with why. */
  async discover(connection) {
    const endpoints = await Promise.all(endpointsOf(connection).map(async (endpoint) => {
      try {
        const tools = [];
        let cursor;
        for (let page = 0; page < MAX_TOOL_PAGES; page++) {
          const result = await this.rpc(connection, endpoint, 'tools/list', cursor ? { cursor } : {});
          for (const t of Array.isArray(result.tools) ? result.tools : []) if (t && typeof t.name === 'string') tools.push(this.#offered(endpoint, t));
          cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
          if (!cursor) break;
        }
        const session = this.sessions.get(`${connection.id}|${endpoint.url}`);
        return { ...endpoint, tools, instructions: session?.instructions ?? null };
      } catch (error) {
        return { ...endpoint, refused: error.code || 'ERROR', status: error.status ?? 0, error: error.message };
      }
    }));
    const reached = endpoints.filter((e) => e.tools);
    if (!reached.length) {
      const first = endpoints.find((e) => e.status === 401) ?? endpoints.find((e) => e.status !== 403) ?? endpoints[0];
      const allForbidden = endpoints.length > 1 && endpoints.every((e) => e.status === 403);
      return { at: this.now(), endpoints, error: allForbidden ? 'The token reaches none of these modules.' : first.error };
    }
    return { at: this.now(), endpoints, error: null };
  }

  /** What a connection reaches, asked again at most once a minute unless somebody insists. */
  async reach(id, { fresh = false } = {}) {
    const connection = this.get(id);
    if (!connection) return null;
    const had = this.found.get(id);
    if (!fresh && had && this.now() - had.at < 60_000) return had;
    if (!this.finding.has(id)) {
      this.finding.set(id, this.discover(connection)
        .then((found) => { this.found.set(id, found); return found; })
        .finally(() => this.finding.delete(id)));
    }
    return this.finding.get(id);
  }

  toolsOf(id) {
    return (this.found.get(id)?.endpoints ?? []).flatMap((e) => e.tools ?? []);
  }

  /**
   * Run one tool, by the name it is offered under. `who` says who asked, for the
   * dialog: a tool that is not read-only waits for a person to say yes.
   */
  async run(id, name, args = {}, who = 'This panel') {
    const connection = this.get(id);
    if (!connection) throw new McpError('That connection is not here any more.');
    await this.reach(id);
    const tool = this.toolsOf(id).find((t) => t.name === name);
    if (!tool) throw new McpError(`${connection.name} has no tool called ${String(name).slice(0, 80)}.`);
    if (!readOnly(tool)) {
      if (!this.confirm) throw new McpError(`${name} may change something in ${connection.name}, and there is nobody here to ask.`);
      const answer = await this.confirm({
        title: connection.name,
        message: `${who} wants to run “${tool.title || name}” on ${connection.name}.`,
        detail: `${tool.description ?? ''}\n\nWith:\n${cut(JSON.stringify(args ?? {}, null, 2), 1500)}\n\nIt runs with this connection's token.`.trim(),
        confirmLabel: 'Run it',
        timeoutMs: 120_000,
      });
      if (answer !== 'yes') throw new McpError(answer === 'timeout' ? 'Nobody answered, so it was not run.' : 'The person said no, so it was not run.', { code: 'DECLINED' });
    }
    const result = await this.rpc(connection, { module: tool.module, url: tool.url }, 'tools/call',
      { name: tool.real, arguments: args && typeof args === 'object' ? args : {} },
      { timeoutMs: SLOW_TOOL.test(tool.real) ? SLOW_TIMEOUT_MS : TIMEOUT_MS });
    const text = (Array.isArray(result.content) ? result.content : []).map((c) => {
      if (c?.type === 'text') return c.text;
      if (c?.type === 'resource' && typeof c.resource?.text === 'string') return c.resource.text;
      return c?.type ? `[${c.type}]` : '';
    }).filter(Boolean).join('\n');
    let data = result.structuredContent ?? null;
    if (data === null) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { text, data, isError: Boolean(result.isError) };
  }

  // --- what the panel sees ------------------------------------------------------

  list() {
    return { ok: true, connections: this.all().map((c) => ({ ...c, checkedAt: this.found.get(c.id)?.at ?? null, error: this.found.get(c.id)?.error ?? null })) };
  }

  async inspect({ id, fresh = false }) {
    const connection = this.get(id);
    if (!connection) throw new McpError('That connection is not here any more.');
    const { token, ...shown } = connection;
    void token;
    const found = connection.tokenError ? null : await this.reach(id, { fresh });
    return {
      ok: true,
      connection: { ...shown, hasToken: Boolean(token) || connection.tokenError },
      checkedAt: found?.at ?? null,
      error: connection.tokenError ? 'The token saved for this connection can no longer be read on this computer. Paste it again.' : (found?.error ?? null),
      endpoints: (found?.endpoints ?? []).map((e) => ({
        module: e.module,
        url: e.url,
        reached: Boolean(e.tools),
        why: e.tools ? null : (/_NOT_IN_KEY$/.test(e.refused) ? 'not in this token' : e.error),
        instructions: e.instructions ?? null,
        tools: (e.tools ?? []).map((t) => ({ name: t.name, title: t.title ?? t.annotations?.title ?? t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' }, readOnly: readOnly(t) })),
      })),
    };
  }

  /**
   * Add a connection, or change one. It is kept only if its address answers as
   * MCP and reaches something with the token. A blank token on an existing
   * connection keeps the one it has — only while the address stays the same, so
   * a saved token is never sent somewhere it was not typed for.
   */
  async save({ id = null, name, url, modules, token, claude }) {
    const existing = id ? this.get(id) : null;
    if (id && !existing) throw new McpError('That connection is not here any more.');
    if (!existing && this.all().length >= MAX_CONNECTIONS) throw new McpError(`That is already ${MAX_CONNECTIONS} connections; remove one first.`);
    const clean = { name: nameOf(name), url: addressOf(url), modules: modulesOf(modules) };
    const clash = this.db.prepare('SELECT id FROM mcpc_connection WHERE name = ?').get(clean.name);
    if (clash && clash.id !== id) throw new McpError(`There is already a connection called ${clean.name}.`);
    let use = String(token ?? '').trim();
    if (!use && existing) {
      if (existing.url !== clean.url && existing.token) throw new McpError('A new address needs the token pasted again.');
      if (existing.tokenError) throw new McpError('The saved token can no longer be read on this computer. Paste it again.');
      use = existing.token;
    }
    const key = existing?.id ?? this.newId();
    const trial = { id: `${key}~trial`, ...clean, token: use, tokenError: false, claude: false };
    const found = await this.discover(trial);
    for (const k of [...this.sessions.keys()]) if (k.startsWith(`${trial.id}|`)) this.sessions.delete(k);
    if (found.error) throw new McpError(found.error);
    const cipher = use ? this.secrets.encrypt(use) : '';
    const on = claude === undefined ? (existing?.claude ?? false) : Boolean(claude);
    if (existing) {
      this.db.prepare('UPDATE mcpc_connection SET name = ?, url = ?, modules = ?, token = ?, claude = ? WHERE id = ?')
        .run(clean.name, clean.url, JSON.stringify(clean.modules), cipher, on ? 1 : 0, key);
    } else {
      const position = this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM mcpc_connection').get().next;
      this.db.prepare('INSERT INTO mcpc_connection (id, name, url, modules, token, claude, position) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(key, clean.name, clean.url, JSON.stringify(clean.modules), cipher, on ? 1 : 0, position);
    }
    this.#forget(key);
    this.found.set(key, found);
    this.emit({ type: 'changed', id: key });
    this.changed();
    return { ok: true, id: key };
  }

  remove({ id }) {
    const connection = this.get(id);
    if (!connection) throw new McpError('That connection is not here any more.');
    this.db.prepare('DELETE FROM mcpc_connection WHERE id = ?').run(connection.id);
    this.#forget(connection.id);
    this.emit({ type: 'changed', id: connection.id });
    this.changed();
    return { ok: true };
  }

  claudeSave({ id, on }) {
    const connection = this.get(id);
    if (!connection) throw new McpError('That connection is not here any more.');
    this.db.prepare('UPDATE mcpc_connection SET claude = ? WHERE id = ?').run(on ? 1 : 0, connection.id);
    this.emit({ type: 'changed', id: connection.id });
    this.changed();
    return { ok: true, on: Boolean(on) };
  }

  /**
   * A web address a server handed back (a proposal's `confirmUrl`), opened only
   * if it is on the same site as the connection's address: never somewhere a
   * panel or a tool's answer could point anywhere.
   */
  async openLink({ id, url }) {
    const connection = this.get(id);
    if (!connection || !this.openExternal) throw new McpError('That connection is not here any more.');
    let target;
    try {
      target = new URL(String(url ?? ''));
    } catch {
      throw new McpError('That is not a web address.');
    }
    const home = new URL(connection.url);
    const domain = home.hostname.split('.').slice(-2).join('.');
    const local = ['localhost', '127.0.0.1'].includes(home.hostname);
    const ours = target.protocol === 'https:'
      ? (target.hostname === domain || target.hostname.endsWith(`.${domain}`))
      : (local && target.protocol === 'http:' && target.hostname === home.hostname);
    if (!ours) throw new McpError(`Only addresses on ${domain} are opened from this connection.`);
    await this.openExternal(target.toString());
    return { ok: true };
  }

  // --- the one door -------------------------------------------------------------

  async call(name, args = {}) {
    try {
      switch (name) {
        case 'list':
          return this.list();
        case 'inspect':
          return await this.inspect(args);
        case 'save':
          return await this.save(args);
        case 'remove':
          return this.remove(args);
        case 'run': {
          const r = await this.run(String(args.id ?? ''), String(args.tool ?? ''), args.args ?? {});
          return { ok: true, isError: r.isError, data: r.data, text: r.data === null ? cut(r.text, MAX_PANEL_TEXT) : undefined };
        }
        case 'claudeSave':
          return this.claudeSave(args);
        case 'openLink':
          return await this.openLink(args);
        default:
          return { ok: false, error: `MCP connections have no "${String(name).slice(0, 40)}".` };
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), code: error?.code ?? undefined };
    }
  }

  /**
   * A Claude session's question, from the relay for one connection. Nothing is
   * offered unless the person switched that connection on for Claude.
   */
  async handleSession({ connection: id, tool, args, session }) {
    const connection = this.get(id);
    const who = session?.id ?? '?';
    if (tool === '_available') {
      if (!connection) return { ok: true, tools: [], enabled: false, message: 'This MCP connection was removed from Smart Terminal.' };
      if (!connection.claude) return { ok: true, tools: [], enabled: false, message: `${connection.name} is in Smart Terminal, but Claude sessions may not use it. Switch it on in the MCP connections panel.` };
      let found = null;
      try {
        found = await this.reach(connection.id);
      } catch {
        return { ok: true, tools: [] };
      }
      const instructions = (found?.endpoints ?? []).map((e) => e.instructions).filter(Boolean);
      return {
        ok: true,
        instructions: instructions.length ? [...new Set(instructions)].join('\n\n').slice(0, 6000) : null,
        tools: this.toolsOf(connection.id).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema ?? { type: 'object' }, annotations: t.annotations })),
      };
    }
    if (!connection) return { ok: false, error: 'This MCP connection was removed from Smart Terminal.' };
    if (!connection.claude) return { ok: false, error: `Claude sessions may not use ${connection.name} right now. The person can switch it on in the MCP connections panel.` };
    const now = this.now();
    const key = `${who}|${connection.id}`;
    const recent = (this.calls.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= SESSION_CALLS_PER_MINUTE) return { ok: false, error: `Too many ${connection.name} calls from this session. Wait ${Math.ceil((60_000 - (now - recent[0])) / 1000)} seconds.` };
    recent.push(now);
    this.calls.set(key, recent);
    try {
      const r = await this.run(connection.id, String(tool ?? ''), args ?? {}, `The Claude session “${session?.name ?? who}”`);
      this.log(`[mcp] ${session?.name ?? who} ran ${connection.name}/${tool}`);
      return r.isError ? { ok: false, error: cut(r.text, MAX_SESSION_TEXT) } : { ok: true, text: cut(r.text, MAX_SESSION_TEXT) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

module.exports = { McpConnections, McpError, nameOf, addressOf, modulesOf, endpointsOf, answerIn, RESERVED };
