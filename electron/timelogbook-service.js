'use strict';

/**
 * Timelogbook v4, through the MCP servers its agent door exposes.
 *
 * Timelogbook serves one MCP server per app of the suite at
 * `<api>/agent/mcp/v1/<app>`: stateless JSON-RPC over POST, one JSON answer per
 * message, no session and no stream. A person makes an API key in Timelogbook
 * (Profile → API keys, `tlbk_<8>_<40>`), choosing which apps it reaches and
 * whether it may write; the key goes as a Bearer and every tool runs with that
 * person's own permissions. This file is the only thing in the app that holds
 * the key or names the address: the panel asks for verbs, a Claude session asks
 * through the relay in `timelogbook-mcp-stdio.js`, and both arrive here.
 *
 * What the key reaches is found out, not configured: each app is asked for its
 * tools, and an app the key was not made for answers 403 and is left out.
 *
 * A tool Timelogbook does not mark read-only is never run on anybody's word but
 * a person's, in a native dialog — whether the panel or a session asked.
 */

/** The apps of the suite with a server (AppCode in Timelogbook; `home` delegates and has none). */
const APPS = ['me', 'tasks', 'projects', 'crm', 'people', 'billing', 'admin', 'marketing'];

const APP_NAMES = {
  me: 'My work', tasks: 'Tasks', projects: 'Projects', crm: 'CRM', people: 'People', billing: 'Billing', admin: 'Console', marketing: 'Marketing',
};

const KEY_SHAPE = /^tlbk_([0-9A-Za-z]{8})_[0-9A-Za-z]{40}$/;
const TIMEOUT_MS = 20_000;
/** What a session is handed of one answer. A page of tasks is a few kilobytes; more than this is a page too big to read. */
const MAX_SESSION_TEXT = 60_000;
/** What the panel is handed: it shows it as a tree and can take more. */
const MAX_PANEL_TEXT = 400_000;
/** Per session, per minute: enough to work, not enough for a loop to spend the person's rate limit in Timelogbook. */
const SESSION_CALLS_PER_MINUTE = 40;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tlb_setting (k TEXT PRIMARY KEY, v TEXT NOT NULL);`,
];

/**
 * The API's base, from whatever the person pasted: the site, the API, or the
 * whole MCP address Timelogbook shows beside a new key. Always ends in `/api`.
 * Plain http only to this computer: the key is a password.
 */
function apiBase(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('Type the address of your Timelogbook.');
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
  let path = url.pathname.replace(/\/+$/, '');
  const cut = path.indexOf('/agent/');
  if (cut >= 0) path = path.slice(0, cut);
  if (!/\/api$/.test(path)) path += '/api';
  return `${url.origin}${path}`;
}

function keyPrefix(key) {
  const m = KEY_SHAPE.exec(String(key ?? ''));
  return m ? m[1] : null;
}

/** The app a tool belongs to: its name starts with the app's code (`tasks_get_board`). */
function appOf(tool) {
  const head = String(tool ?? '').split('_')[0];
  return APPS.includes(head) ? head : null;
}

function readOnly(tool) {
  return tool?.annotations?.readOnlyHint === true;
}

function cut(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n… (cut: the answer was ${s.length} characters)` : s;
}

class TimelogbookError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class TimelogbookService {
  constructor({ db, secrets, fetch = globalThis.fetch, emit = () => {}, confirm = null, openExternal = null, language = () => 'en', now = () => Date.now(), log = () => {} }) {
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

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS tlb_schema (version INTEGER NOT NULL)');
    let row = this.db.prepare('SELECT version FROM tlb_schema').get();
    if (!row) {
      this.db.prepare('INSERT INTO tlb_schema (version) VALUES (0)').run();
      row = { version: 0 };
    }
    if (row.version > MIGRATIONS.length) {
      throw new Error(`The Timelogbook tables are at version ${row.version}, newer than this build knows (${MIGRATIONS.length}). Update Smart Terminal.`);
    }
    for (let version = row.version; version < MIGRATIONS.length; version++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE tlb_schema SET version = ?').run(version + 1);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  // --- what is kept -----------------------------------------------------------

  setting(key, fallback = null) {
    const row = this.db.prepare('SELECT v FROM tlb_setting WHERE k = ?').get(String(key));
    return row ? row.v : fallback;
  }

  setSetting(key, value) {
    if (value === null || value === undefined) this.db.prepare('DELETE FROM tlb_setting WHERE k = ?').run(String(key));
    else this.db.prepare('INSERT INTO tlb_setting (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(String(key), String(value));
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

  // --- the wire ---------------------------------------------------------------

  /** One JSON-RPC message to one app's server. Throws a TimelogbookError that says what to do. */
  async rpc(app, method, params, conn = this.connection()) {
    if (!conn) throw new TimelogbookError('Timelogbook is not connected.', { code: 'NOT_CONNECTED' });
    if (conn.keyError) throw new TimelogbookError('The API key saved here can no longer be read on this computer. Paste it again.', { code: 'KEY_UNREADABLE' });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await this.fetch(`${conn.base}/agent/mcp/v1/${app}`, {
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
      if (abort.signal.aborted) throw new TimelogbookError(`Timelogbook did not answer in ${TIMEOUT_MS / 1000} seconds.`, { code: 'TIMEOUT' });
      throw new TimelogbookError(`Could not reach ${new URL(conn.base).host}: ${error?.cause?.code ?? error?.message ?? error}`, { code: 'UNREACHABLE' });
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
      const said = json && typeof json.message === 'string' ? json.message : '';
      const code = json && typeof json.code === 'string' ? json.code : '';
      if (response.status === 401) throw new TimelogbookError(`Timelogbook refused the key${said ? `: ${said}` : ''}. It may be revoked or expired — make a new one in Timelogbook, Profile → API keys.`, { status: 401, code: code || 'UNAUTHENTICATED' });
      if (response.status === 403) throw new TimelogbookError(said || `This key has no access to ${APP_NAMES[app] ?? app}.`, { status: 403, code: code || 'FORBIDDEN' });
      if (response.status === 404) throw new TimelogbookError(said || `There is no ${APP_NAMES[app] ?? app} server at ${conn.base}. Is that the right address?`, { status: 404, code: code || 'NOT_FOUND' });
      if (response.status === 429) {
        const wait = response.headers?.get?.('retry-after');
        throw new TimelogbookError(`Timelogbook says too many calls${wait ? `; try again in ${wait} seconds` : ''}.`, { status: 429, code: 'RATE_LIMITED' });
      }
      throw new TimelogbookError(`Timelogbook answered ${response.status}${said ? `: ${said}` : ''}.`, { status: response.status, code });
    }
    if (!json || typeof json !== 'object') {
      throw new TimelogbookError(`What answered at ${conn.base} is not Timelogbook's agent door. Is that the right address?`, { code: 'NOT_MCP' });
    }
    if (json.error) throw new TimelogbookError(String(json.error.message ?? 'Timelogbook could not do that.'), { code: String(json.error.code ?? '') });
    return json.result ?? {};
  }

  /** Every app's tools, asked of each server at once. An app the key does not reach is kept with why. */
  async discover(conn = this.connection()) {
    const apps = await Promise.all(APPS.map(async (app) => {
      try {
        const result = await this.rpc(app, 'tools/list', {}, conn);
        const tools = Array.isArray(result.tools) ? result.tools.filter((t) => t && typeof t.name === 'string') : [];
        return { app, tools };
      } catch (error) {
        return { app, refused: error.code || 'ERROR', status: error.status ?? 0, error: error.message };
      }
    }));
    const reached = apps.filter((a) => a.tools);
    if (!reached.length) {
      // Every app said the same thing about the key or the address: that is the answer, not eight of it.
      const first = apps.find((a) => a.status === 401) ?? apps.find((a) => !['APP_NOT_IN_KEY', 'FORBIDDEN'].includes(a.refused)) ?? apps[0];
      const allForbidden = apps.every((a) => a.status === 403);
      return { at: this.now(), apps, error: allForbidden ? 'This key reaches none of the apps. Give it at least one in Timelogbook.' : first.error };
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
   * Run one tool. `who` says who asked, for the dialog: a tool that is not
   * read-only waits for a person to say yes, and nobody's word but theirs
   * starts it.
   */
  async run(name, args = {}, who = 'This panel') {
    const app = appOf(name);
    if (!app) throw new TimelogbookError(`No such tool: ${String(name).slice(0, 80)}`);
    const found = await this.reach();
    const tool = this.tools().find((t) => t.name === name);
    if (!found || !tool) throw new TimelogbookError(`This key cannot use ${String(name).slice(0, 80)}.`);
    if (!readOnly(tool)) {
      if (!this.confirm) throw new TimelogbookError(`${name} changes something in Timelogbook, and there is nobody here to ask.`);
      const answer = await this.confirm({
        title: 'Timelogbook',
        message: `${who} wants to run “${tool.title || name}” in Timelogbook.`,
        detail: `${tool.description ?? ''}\n\nWith:\n${cut(JSON.stringify(args ?? {}, null, 2), 1500)}\n\nIt runs as you, with your permissions.`.trim(),
        confirmLabel: 'Run it',
        timeoutMs: 120_000,
      });
      if (answer !== 'yes') throw new TimelogbookError(answer === 'timeout' ? 'Nobody answered, so it was not run.' : 'The person said no, so it was not run.', { code: 'DECLINED' });
    }
    const result = await this.rpc(app, 'tools/call', { name, arguments: args && typeof args === 'object' ? args : {} });
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
    const prefix = keyPrefix(conn.key);
    const found = conn.keyError ? null : await this.reach({ fresh });
    return {
      ok: true,
      connected: true,
      base: conn.base,
      keyHint: prefix ? `tlbk_${prefix}_…` : null,
      keyError: conn.keyError,
      claude,
      checkedAt: found?.at ?? null,
      error: conn.keyError ? 'The API key saved here can no longer be read on this computer. Paste it again.' : (found?.error ?? null),
      apps: (found?.apps ?? []).map((a) => ({
        app: a.app,
        name: APP_NAMES[a.app],
        reached: Boolean(a.tools),
        why: a.tools ? null : (a.refused === 'APP_NOT_IN_KEY' ? 'not in this key' : a.error),
        tools: (a.tools ?? []).map((t) => ({
          name: t.name, title: t.title ?? t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' }, readOnly: readOnly(t),
        })),
      })),
    };
  }

  /** Try an address and a key; keep them only if the key reaches something. A blank key keeps the one saved, at the same address. */
  async connect({ url, key }) {
    const base = apiBase(url);
    const typed = String(key ?? '').trim();
    const saved = this.connection();
    let use = typed;
    if (!typed) {
      if (!saved || saved.keyError) throw new TimelogbookError('Paste the API key you made in Timelogbook.');
      if (saved.base !== base) throw new TimelogbookError('A new address needs the key pasted again.');
      use = saved.key;
    }
    if (!KEY_SHAPE.test(use)) throw new TimelogbookError('That is not a Timelogbook API key. It looks like tlbk_ followed by two groups of letters and numbers.');
    const found = await this.discover({ base, key: use, keyError: false });
    if (found.error) throw new TimelogbookError(found.error);
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
   * What a Claude session is handed about one task: what Timelogbook says of
   * it, in its own words, and what to do with it.
   */
  async brief({ key, title }) {
    const taskKey = String(key ?? '').trim();
    if (!taskKey) throw new TimelogbookError('Which task?');
    const lines = [`I am working on the Timelogbook task ${taskKey}${title ? ` — ${String(title).slice(0, 200)}` : ''}.`];
    const has = (name) => this.tools().some((t) => t.name === name);
    await this.reach();
    const facts = [];
    const tryRun = async (name, args) => {
      if (!has(name)) return;
      try {
        const r = await this.run(name, args);
        if (!r.isError && r.text) facts.push(`${name}:\n${cut(r.text, 12_000)}`);
      } catch (error) {
        this.log(`[timelogbook] brief: ${name} failed: ${error.message}`);
      }
    };
    // A personal task (T-42) opens in My work; a project task (KBK-12) in Tasks.
    if (/^T-\d+$/i.test(taskKey)) await tryRun('me_get_task', { key: taskKey });
    else await tryRun('tasks_get_task', { key: taskKey });
    if (!facts.length) await tryRun('me_search_my_tasks', { q: taskKey });
    if (facts.length) lines.push('', 'What Timelogbook says about it:', '', ...facts);
    lines.push('', this.claudeOn()
      ? 'You can read more from Timelogbook with the timelogbook MCP tools (comments, the board, the sprint). Read the task, look at this repository, and tell me how you would approach it before changing anything.'
      : 'Read the task, look at this repository, and tell me how you would approach it before changing anything.');
    return { ok: true, title: taskKey, text: lines.join('\n') };
  }

  // --- the one door -------------------------------------------------------------

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
        case 'brief':
          return await this.brief(args);
        case 'claudeAccess':
          return { ok: true, on: this.claudeOn() };
        case 'claudeAccessSave':
          this.setSetting('claude', args.on ? 'on' : 'off');
          this.emit({ type: 'changed' });
          return { ok: true, on: this.claudeOn() };
        case 'openInBrowser': {
          const conn = this.connection();
          if (!conn || !this.openExternal) throw new TimelogbookError('Timelogbook is not connected.');
          // The site, not the API: the address is the one saved, never one a panel names.
          await this.openExternal(conn.base.replace(/\/api$/, '/'));
          return { ok: true };
        }
        default:
          return { ok: false, error: `Timelogbook has no "${String(name).slice(0, 40)}".` };
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
        return { ok: true, tools: [], enabled: false, message: this.connection() ? 'Timelogbook is connected, but Claude sessions may not use it. Switch it on in the Timelogbook panel.' : null };
      }
      try {
        await this.reach();
      } catch {
        return { ok: true, tools: [] };
      }
      return { ok: true, tools: this.tools().map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema ?? { type: 'object' }, annotations: t.annotations })) };
    }
    if (!this.claudeOn()) return { ok: false, error: 'Claude sessions may not use Timelogbook right now. The person can switch it on in the Timelogbook panel.' };
    const now = this.now();
    const recent = (this.calls.get(id) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= SESSION_CALLS_PER_MINUTE) return { ok: false, error: `Too many Timelogbook calls from this session. Wait ${Math.ceil((60_000 - (now - recent[0])) / 1000)} seconds.` };
    recent.push(now);
    this.calls.set(id, recent);
    try {
      const r = await this.run(String(tool ?? ''), args ?? {}, `The Claude session “${session?.name ?? id}”`);
      this.log(`[timelogbook] ${session?.name ?? id} ran ${tool}`);
      return r.isError ? { ok: false, error: cut(r.text, MAX_SESSION_TEXT) } : { ok: true, text: cut(r.text, MAX_SESSION_TEXT) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

module.exports = { TimelogbookService, TimelogbookError, apiBase, appOf, keyPrefix, APPS };
