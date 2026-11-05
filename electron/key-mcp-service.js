'use strict';

/**
 * A product's MCP servers, reached with a person's API key.
 *
 * Timelogbook and Kubrik OS both serve one MCP server per app (or module) of
 * their suite — `https://mcp.<domain>/<app>`, an ingress in front of the
 * gateway's `<api><gatewayPath>/<app>`, which also answers directly — as
 * stateless JSON-RPC over POST: one JSON answer per message, no session and no
 * stream. A person makes an API key in the product, choosing which apps it
 * reaches and whether it may write; the key goes as a Bearer and every tool runs
 * with that person's own permissions.
 *
 * This is the only thing in the app that holds the key or names the address:
 * the panel asks for verbs, a Claude session asks through the relay in
 * `key-mcp-stdio.js`, and both arrive here. What the key reaches is found out,
 * not configured: each app is asked for its tools, and one the key was not made
 * for answers 403 and is left out.
 *
 * Tool names carry their app (`tasks_get_board`, `acc_get_invoice`). One that
 * does not — a tool every app serves under the same name, like Kubrik's
 * `ask_agent` — is offered as `<app>_<name>`, so every name means one server.
 *
 * A tool the product does not mark read-only is never run on anybody's word but
 * a person's, in a native dialog — whether the panel or a session asked.
 */

/** What a session is handed of one answer. A page of records is a few kilobytes; more than this is a page too big to read. */
const MAX_SESSION_TEXT = 60_000;
/** What the panel is handed: it shows it as a tree and can take more. */
const MAX_PANEL_TEXT = 400_000;
/** Per session, per minute: enough to work, not enough for a loop to spend the person's rate limit. */
const SESSION_CALLS_PER_MINUTE = 40;

/** The MCP door's own host (`mcp.…`, `dev-mcp.…`): there an app's server is `/<app>`, nothing more. */
const MCP_HOST = /^(?:[a-z0-9-]+-)?mcp\./i;

/**
 * Where the servers are, from whatever the person pasted: the MCP host (or one
 * app's address on it), the site, the API, or the gateway's MCP address. On the
 * MCP host it is the origin; anywhere else the API, ending in `/api`. Plain
 * http only to this computer: the key is a password.
 */
function apiBase(input, product = 'the server') {
  let text = String(input ?? '').trim();
  if (!text) throw new Error(`Type the address of ${product}.`);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That is not a web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address has to start with https://');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) throw new Error('Use https:// — the API key would travel in the clear.');
  if (url.username || url.password) throw new Error('Leave the user and password out of the address; the API key is what signs in.');
  if (MCP_HOST.test(url.hostname)) return url.origin;
  let path = url.pathname.replace(/\/+$/, '');
  const api = path.search(/\/api(?:\/|$)/);
  path = api >= 0 ? path.slice(0, api + 4) : `${path}/api`;
  return `${url.origin}${path}`;
}

/** One app's MCP server under a base `apiBase` made. */
function mcpUrl(base, app, gatewayPath) {
  return MCP_HOST.test(new URL(base).hostname) ? `${base}/${app}` : `${base}${gatewayPath}/${app}`;
}

/** The site people open, for a base: `mcp.<domain>` → `<site>.<domain>`, `dev-mcp.` → `dev<-site>.`; otherwise the API's own host. */
function siteOf(base, site = 'app', devSite = 'dev') {
  const url = new URL(base);
  const m = /^(?:([a-z0-9-]+)-)?mcp\.(.+)$/i.exec(url.hostname);
  if (m) return `${url.protocol}//${m[1] ? devSite : site}.${m[2]}/`;
  return base.replace(/\/api$/, '/');
}

function readOnly(tool) {
  return tool?.annotations?.readOnlyHint === true;
}

function cut(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n… (cut: the answer was ${s.length} characters)` : s;
}

class KeyMcpError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {object} product what differs between products:
 *   `name` ('Timelogbook'), `table` (prefix of its own tables), `apps` and `appNames`,
 *   `keyShape` (a RegExp whose first group is the key's public prefix), `keyMark` ('tlbk_'),
 *   `keyWhere` (where the person makes one), `gatewayPath` ('/agent/mcp/v1'),
 *   `site` / `devSite` (the web app's host label on the product's domain),
 *   `slowTools` ({ name: ms } for tools that take long), `timeoutMs`.
 */
class KeyMcpService {
  constructor(product, { db, secrets, fetch = globalThis.fetch, emit = () => {}, confirm = null, openExternal = null, language = () => 'en', now = () => Date.now(), log = () => {} }) {
    this.product = { timeoutMs: 35_000, slowTools: {}, site: 'app', devSite: 'dev', ...product };
    this.db = db;
    this.secrets = secrets ?? {
      encrypt: (text) => Buffer.from(text).toString('base64'),
      decrypt: (cipher) => Buffer.from(cipher, 'base64').toString(),
    };
    this.fetch = fetch;
    this.emit = emit;
    this.confirm = confirm;
    this.openExternal = openExternal;
    this.language = language;
    this.now = now;
    this.log = log;
    /** What the key reached the last time anybody asked: `{ at, apps: [{ app, tools } | { app, refused }], error }`. */
    this.found = null;
    this.finding = null;
    this.calls = new Map();
    this.rpcId = 0;
    this.#migrate();
  }

  get name() {
    return this.product.name;
  }

  #migrate() {
    const t = this.product.table;
    const migrations = [`CREATE TABLE IF NOT EXISTS ${t}_setting (k TEXT PRIMARY KEY, v TEXT NOT NULL);`];
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${t}_schema (version INTEGER NOT NULL)`);
    let row = this.db.prepare(`SELECT version FROM ${t}_schema`).get();
    if (!row) {
      this.db.prepare(`INSERT INTO ${t}_schema (version) VALUES (0)`).run();
      row = { version: 0 };
    }
    if (row.version > migrations.length) {
      throw new Error(`The ${this.name} tables are at version ${row.version}, newer than this build knows (${migrations.length}). Update Smart Terminal.`);
    }
    for (let version = row.version; version < migrations.length; version++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(migrations[version]);
        this.db.prepare(`UPDATE ${t}_schema SET version = ?`).run(version + 1);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  // --- what is kept -----------------------------------------------------------

  setting(key, fallback = null) {
    const row = this.db.prepare(`SELECT v FROM ${this.product.table}_setting WHERE k = ?`).get(String(key));
    return row ? row.v : fallback;
  }

  setSetting(key, value) {
    const t = this.product.table;
    if (value === null || value === undefined) this.db.prepare(`DELETE FROM ${t}_setting WHERE k = ?`).run(String(key));
    else this.db.prepare(`INSERT INTO ${t}_setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).run(String(key), String(value));
  }

  /** The address and the key, or null. A key the system can no longer decrypt is `keyError`, not a throw. */
  connection() {
    const base = this.setting('base');
    const cipher = this.setting('key');
    if (!base || !cipher) return null;
    try {
      return { base, key: this.secrets.decrypt(cipher), keyError: false };
    } catch {
      return { base, key: '', keyError: true };
    }
  }

  claudeOn() {
    return this.setting('claude') === 'on';
  }

  keyPrefix(key) {
    const m = this.product.keyShape.exec(String(key ?? ''));
    return m ? m[1] : null;
  }

  site(base) {
    return siteOf(base, this.product.site, this.product.devSite);
  }

  // --- the wire ---------------------------------------------------------------

  /** One JSON-RPC message to one app's server. Throws a KeyMcpError that says what to do. */
  async rpc(app, method, params, conn = this.connection(), timeoutMs = this.product.timeoutMs) {
    const { name, appNames, keyWhere } = this.product;
    const appName = appNames[app] ?? app;
    if (!conn) throw new KeyMcpError(`${name} is not connected.`, { code: 'NOT_CONNECTED' });
    if (conn.keyError) throw new KeyMcpError('The API key saved here can no longer be read on this computer. Paste it again.', { code: 'KEY_UNREADABLE' });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetch(mcpUrl(conn.base, app, this.product.gatewayPath), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${conn.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Accept-Language': this.language(),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params: params ?? {} }),
        signal: abort.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (abort.signal.aborted) throw new KeyMcpError(`${name} did not answer in ${Math.round(timeoutMs / 1000)} seconds.`, { code: 'TIMEOUT' });
      throw new KeyMcpError(`Could not reach ${new URL(conn.base).host}: ${error?.cause?.code ?? error?.message ?? error}`, { code: 'UNREACHABLE' });
    } finally {
      clearTimeout(timer);
    }
    const body = await response.text().catch(() => '');
    let json = null;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const said = json && typeof json.message === 'string' ? json.message : (json && typeof json.error === 'string' && json.error !== 'Unauthorized' ? json.error : '');
      const code = json && typeof json.code === 'string' ? json.code : '';
      if (response.status === 401) throw new KeyMcpError(`${name} refused the key${said ? `: ${said}` : ''}. It may be revoked or expired — make a new one in ${keyWhere}.`, { status: 401, code: code || 'UNAUTHENTICATED' });
      if (response.status === 403) throw new KeyMcpError(said || `This key has no access to ${appName}.`, { status: 403, code: code || 'FORBIDDEN' });
      if (response.status === 404) throw new KeyMcpError(said || `There is no ${appName} server at ${conn.base}. Is that the right address?`, { status: 404, code: code || 'NOT_FOUND' });
      if (response.status === 429) {
        const wait = response.headers?.get?.('retry-after');
        throw new KeyMcpError(`${name} says too many calls${wait ? `; try again in ${wait} seconds` : ''}.`, { status: 429, code: 'RATE_LIMITED' });
      }
      throw new KeyMcpError(`${name} answered ${response.status}${said ? `: ${said}` : ''}.`, { status: response.status, code });
    }
    if (!json || typeof json !== 'object') {
      throw new KeyMcpError(`What answered at ${conn.base} is not ${name}'s MCP door. Is that the right address?`, { code: 'NOT_MCP' });
    }
    if (json.error) throw new KeyMcpError(String(json.error.message ?? `${name} could not do that.`), { code: String(json.error.code ?? '') });
    return json.result ?? {};
  }

  /**
   * A tool as offered here: its name carries its app, and `real` is the name its
   * server knows it by.
   */
  offered(app, tool) {
    const named = tool.name.startsWith(`${app}_`);
    return {
      ...tool,
      name: named ? tool.name : `${app}_${tool.name}`,
      real: tool.name,
      app,
      description: named ? tool.description : `${this.product.appNames[app] ?? app}: ${tool.description ?? ''}`,
    };
  }

  /** Every app's tools, asked of each server at once. An app the key does not reach is kept with why. */
  async discover(conn = this.connection()) {
    const apps = await Promise.all(this.product.apps.map(async (app) => {
      try {
        const result = await this.rpc(app, 'tools/list', {}, conn);
        const tools = Array.isArray(result.tools) ? result.tools.filter((t) => t && typeof t.name === 'string').map((t) => this.offered(app, t)) : [];
        return { app, tools };
      } catch (error) {
        return { app, refused: error.code || 'ERROR', status: error.status ?? 0, error: error.message };
      }
    }));
    const reached = apps.filter((a) => a.tools);
    if (!reached.length) {
      // Every app said the same thing about the key or the address: that is the answer, not one per app.
      const first = apps.find((a) => a.status === 401) ?? apps.find((a) => a.status !== 403) ?? apps[0];
      const allForbidden = apps.every((a) => a.status === 403);
      return { at: this.now(), apps, error: allForbidden ? 'This key reaches none of the apps. Give it at least one.' : first.error };
    }
    return { at: this.now(), apps, error: null };
  }

  /** What the key reaches, asked again at most once a minute unless somebody insists. */
  async reach({ fresh = false } = {}) {
    if (!this.connection()) return null;
    if (!fresh && this.found && this.now() - this.found.at < 60_000) return this.found;
    if (!this.finding) {
      this.finding = this.discover()
        .then((found) => { this.found = found; return found; })
        .finally(() => { this.finding = null; });
    }
    return this.finding;
  }

  tools() {
    return (this.found?.apps ?? []).flatMap((a) => a.tools ?? []);
  }

  /**
   * Run one tool, by the name it is offered under. `who` says who asked, for the
   * dialog: a tool that is not read-only waits for a person to say yes, and
   * nobody's word but theirs starts it.
   */
  async run(name, args = {}, who = 'This panel') {
    await this.reach();
    const tool = this.tools().find((t) => t.name === name);
    if (!tool) throw new KeyMcpError(`This key cannot use ${String(name).slice(0, 80)}.`);
    if (!readOnly(tool)) {
      if (!this.confirm) throw new KeyMcpError(`${name} changes something in ${this.name}, and there is nobody here to ask.`);
      const answer = await this.confirm({
        title: this.name,
        message: `${who} wants to run “${tool.title || name}” in ${this.name}.`,
        detail: `${tool.description ?? ''}\n\nWith:\n${cut(JSON.stringify(args ?? {}, null, 2), 1500)}\n\nIt runs as you, with your permissions.`.trim(),
        confirmLabel: 'Run it',
        timeoutMs: 120_000,
      });
      if (answer !== 'yes') throw new KeyMcpError(answer === 'timeout' ? 'Nobody answered, so it was not run.' : 'The person said no, so it was not run.', { code: 'DECLINED' });
    }
    const timeout = this.product.slowTools[tool.real] ?? this.product.timeoutMs;
    const result = await this.rpc(tool.app, 'tools/call', { name: tool.real, arguments: args && typeof args === 'object' ? args : {} }, this.connection(), timeout);
    const text = (Array.isArray(result.content) ? result.content : []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { text, data, isError: Boolean(result.isError) };
  }

  // --- what the panel sees ------------------------------------------------------

  async overview({ fresh = false } = {}) {
    const conn = this.connection();
    const claude = this.claudeOn();
    if (!conn) return { ok: true, connected: false, claude };
    const prefix = this.keyPrefix(conn.key);
    const found = conn.keyError ? null : await this.reach({ fresh });
    return {
      ok: true,
      connected: true,
      base: conn.base,
      keyHint: prefix ? `${this.product.keyMark}${prefix}_…` : null,
      keyError: conn.keyError,
      claude,
      checkedAt: found?.at ?? null,
      error: conn.keyError ? 'The API key saved here can no longer be read on this computer. Paste it again.' : (found?.error ?? null),
      apps: (found?.apps ?? []).map((a) => ({
        app: a.app,
        name: this.product.appNames[a.app] ?? a.app,
        reached: Boolean(a.tools),
        why: a.tools ? null : (/_NOT_IN_KEY$/.test(a.refused) ? 'not in this key' : a.error),
        tools: (a.tools ?? []).map((t) => ({
          name: t.name, title: t.title ?? t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' }, readOnly: readOnly(t),
        })),
      })),
    };
  }

  /** Try an address and a key; keep them only if the key reaches something. A blank key keeps the one saved, at the same address. */
  async connect({ url, key }) {
    const base = apiBase(url, this.name);
    const typed = String(key ?? '').trim();
    const saved = this.connection();
    let use = typed;
    if (!typed) {
      if (!saved || saved.keyError) throw new KeyMcpError(`Paste the API key you made in ${this.product.keyWhere}.`);
      if (saved.base !== base) throw new KeyMcpError('A new address needs the key pasted again.');
      use = saved.key;
    }
    if (!this.product.keyShape.test(use)) throw new KeyMcpError(`That is not a ${this.name} API key. It looks like ${this.product.keyMark} followed by two groups of letters and numbers.`);
    const found = await this.discover({ base, key: use, keyError: false });
    if (found.error) throw new KeyMcpError(found.error);
    this.setSetting('base', base);
    this.setSetting('key', this.secrets.encrypt(use));
    this.found = found;
    this.emit({ type: 'changed' });
    return this.overview();
  }

  disconnect() {
    for (const k of ['base', 'key']) this.setSetting(k, null);
    this.found = null;
    this.emit({ type: 'changed' });
    return { ok: true, connected: false, claude: this.claudeOn() };
  }

  /**
   * A web address the product handed back (a proposal's `confirmUrl`), opened
   * only if it is on the product's own site: never an address a panel or a
   * tool's answer could point anywhere.
   */
  async openLink(url) {
    const conn = this.connection();
    if (!conn || !this.openExternal) throw new KeyMcpError(`${this.name} is not connected.`);
    let target;
    try {
      target = new URL(String(url ?? ''));
    } catch {
      throw new KeyMcpError('That is not a web address.');
    }
    const site = new URL(this.site(conn.base));
    const domain = site.hostname.split('.').slice(-2).join('.');
    const local = ['localhost', '127.0.0.1'].includes(site.hostname);
    const ours = target.protocol === 'https:' ? (target.hostname === domain || target.hostname.endsWith(`.${domain}`)) : (local && target.protocol === 'http:' && target.hostname === site.hostname);
    if (!ours) throw new KeyMcpError(`Only addresses on ${domain} are opened from here.`);
    await this.openExternal(target.toString());
    return { ok: true };
  }

  // --- the one door -------------------------------------------------------------

  /** Verbs a product adds of its own; none here. */
  async extraVerb() {
    return undefined;
  }

  async call(name, args = {}) {
    try {
      switch (name) {
        case 'overview':
          return await this.overview({ fresh: Boolean(args.fresh) });
        case 'connect':
          return await this.connect(args);
        case 'disconnect':
          return this.disconnect();
        case 'run': {
          const r = await this.run(String(args.tool ?? ''), args.args ?? {});
          return { ok: true, isError: r.isError, data: r.data, text: r.data === null ? cut(r.text, MAX_PANEL_TEXT) : undefined };
        }
        case 'claudeAccess':
          return { ok: true, on: this.claudeOn() };
        case 'claudeAccessSave':
          this.setSetting('claude', args.on ? 'on' : 'off');
          this.emit({ type: 'changed' });
          return { ok: true, on: this.claudeOn() };
        case 'openInBrowser': {
          const conn = this.connection();
          if (!conn || !this.openExternal) throw new KeyMcpError(`${this.name} is not connected.`);
          // The site, not the API: the address is the one saved, never one a panel names.
          await this.openExternal(this.site(conn.base));
          return { ok: true };
        }
        case 'openLink':
          return await this.openLink(args.url);
        default: {
          const extra = await this.extraVerb(name, args);
          if (extra !== undefined) return extra;
          return { ok: false, error: `${this.name} has no "${String(name).slice(0, 40)}".` };
        }
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), code: error?.code ?? undefined };
    }
  }

  /**
   * A Claude session's question, from the relay. Nothing is offered unless the
   * person switched it on; what is offered is exactly what the key reaches.
   */
  async handleSession({ tool, args, session }) {
    const id = session?.id ?? '?';
    if (tool === '_available') {
      if (!this.claudeOn() || !this.connection()) {
        return { ok: true, tools: [], enabled: false, message: this.connection() ? `${this.name} is connected, but Claude sessions may not use it. Switch it on in the ${this.name} panel.` : null };
      }
      try {
        await this.reach();
      } catch {
        return { ok: true, tools: [] };
      }
      return { ok: true, tools: this.tools().map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema ?? { type: 'object' }, annotations: t.annotations })) };
    }
    if (!this.claudeOn()) return { ok: false, error: `Claude sessions may not use ${this.name} right now. The person can switch it on in the ${this.name} panel.` };
    const now = this.now();
    const recent = (this.calls.get(id) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= SESSION_CALLS_PER_MINUTE) return { ok: false, error: `Too many ${this.name} calls from this session. Wait ${Math.ceil((60_000 - (now - recent[0])) / 1000)} seconds.` };
    recent.push(now);
    this.calls.set(id, recent);
    try {
      const r = await this.run(String(tool ?? ''), args ?? {}, `The Claude session “${session?.name ?? id}”`);
      this.log(`[${this.product.table}] ${session?.name ?? id} ran ${tool}`);
      return r.isError ? { ok: false, error: cut(r.text, MAX_SESSION_TEXT) } : { ok: true, text: cut(r.text, MAX_SESSION_TEXT) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

module.exports = { KeyMcpService, KeyMcpError, apiBase, mcpUrl, siteOf, readOnly, cut };
