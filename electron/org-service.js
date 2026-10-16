'use strict';

/**
 * Signed in to a company's Smart Terminal server, and telling it, every few
 * minutes, what this machine is working on (see org-report.js for exactly
 * what). The panel can read the last report word for word, and pause it.
 *
 * Two ways to sign in, as the company set its server up: an e-mail and a
 * password an administrator made, or the company's identity provider —
 * Microsoft, Google or another — in the browser. For the second the app does
 * what native apps should (RFC 8252): it listens on a loopback port for one
 * request, sends the browser to the server with a PKCE challenge, and trades
 * the one-time code that comes back, with its verifier, for a device token.
 * The token is kept encrypted, never shown, and the server can revoke it.
 */
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildReport } = require('./org-report');

const SSO_TIMEOUT_MS = 5 * 60_000;
// Long enough for the restored tabs to be running; short enough that opening the app is being seen online.
const FIRST_REPORT_MS = 5_000;

class OrgService {
  /**
   * @param file        where the non-secret state lives (JSON)
   * @param secrets     { encrypt(text), decrypt(cipher) }
   * @param fetch       network
   * @param openExternal opens the system browser
   * @param gather      async () => { sessions, repos, accounts } from the rest of the app
   * @param appVersion  this build's version
   * @param relay       the terminal relay (org-relay.js), or null
   */
  constructor({ file, secrets, fetch, openExternal, gather, appVersion, relay = null, changed = () => {}, now = Date.now, log = () => {} }) {
    Object.assign(this, { file, secrets, fetch, openExternal, gather, appVersion, relay, changed, now, log });
    this.timer = null;
    this.state = this.load();
  }

  // --- what is kept -------------------------------------------------------------
  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }
  save(patch) {
    this.state = { ...this.state, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    this.syncRelay();
    this.changed();
  }
  token() {
    try {
      return this.state.token ? this.secrets.decrypt(this.state.token) : null;
    } catch {
      return null;
    }
  }

  /** For the panel. Never the token. */
  overview() {
    const s = this.state;
    return {
      server: s.server ?? '',
      signedIn: Boolean(s.token && s.user),
      user: s.user ?? null,
      policy: s.policy ?? null,
      paused: Boolean(s.paused),
      privateFolders: s.privateFolders ?? [],
      webTerminal: {
        allowed: Boolean(s.allowWeb),
        companyAllows: s.policy?.webTerminal !== false,
        ...(this.relay?.status() ?? { connected: false, error: null, viewers: [] }),
      },
      lastReport: s.lastReport ?? null,
      lastSentAt: s.lastSentAt ?? null,
      lastError: s.lastError ?? null,
    };
  }

  // --- the server ---------------------------------------------------------------
  serverUrl(value) {
    const text = String(value ?? this.state.server ?? '').trim().replace(/\/+$/, '');
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new Error('That is not a server address. It looks like https://smart-terminal.yourcompany.com');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new Error('The server has to be https, unless it runs on this machine.');
    }
    return url.origin;
  }

  async call(method, route, { body, token, server } = {}) {
    const base = server ?? this.serverUrl();
    const res = await this.fetch(`${base}${route}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `The server answered ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  /** What the sign-in screen offers: the company's name and its identity providers. */
  async providers({ server }) {
    const base = this.serverUrl(server);
    const data = await this.call('GET', '/api/providers', { server: base });
    return { ok: true, server: base, orgName: data.orgName ?? '', providers: data.providers ?? [] };
  }

  signedIn(base, answer) {
    this.save({
      server: base,
      token: this.secrets.encrypt(answer.token),
      user: answer.user,
      policy: answer.policy,
      lastError: null,
      lastSentAt: null,
      lastReport: null,
    });
    this.start();
    void this.sendNow();
    return { ok: true, ...this.overview() };
  }

  async loginWithPassword({ server, email, password }) {
    const base = this.serverUrl(server);
    const answer = await this.call('POST', '/api/app/login', { server: base, body: { email, password, device: this.deviceName() } });
    return this.signedIn(base, answer);
  }

  /** In the browser, through the company's identity provider. Resolves when the person is back. */
  async loginWithProvider({ server, provider }) {
    const base = this.serverUrl(server);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');

    const code = await new Promise((resolve, reject) => {
      const listener = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Smart Terminal</title><body style="font:15px -apple-system,sans-serif;padding:15vh 2em;text-align:center">${ok ? 'Signed in. You can close this tab and go back to Smart Terminal.' : 'This sign-in did not come from Smart Terminal. Start it again from the app.'}</body>`);
        done();
        if (ok) resolve(url.searchParams.get('code'));
        else reject(new Error('The sign-in that came back was not the one this app started.'));
      });
      const timer = setTimeout(() => {
        done();
        reject(new Error('Nobody finished signing in within five minutes.'));
      }, SSO_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        listener.close();
        this.pendingSso = null;
      };
      this.pendingSso = () => {
        done();
        reject(new Error('Cancelled.'));
      };
      // Loopback only, a port the system picks.
      listener.listen(0, '127.0.0.1', () => {
        const redirect = `http://127.0.0.1:${listener.address().port}/callback`;
        const start = new URL(`${base}/auth/${encodeURIComponent(provider)}/start`);
        start.search = new URLSearchParams({ for: 'app', state, challenge, redirect }).toString();
        this.openExternal(start.toString());
      });
      listener.on('error', (error) => {
        done();
        reject(error);
      });
    });

    const answer = await this.call('POST', '/api/app/exchange', { server: base, body: { code, verifier, device: this.deviceName() } });
    return this.signedIn(base, answer);
  }

  /** This person's own numbers, from the company server. Nobody else's. */
  async stats({ days = 7 } = {}) {
    const token = this.token();
    if (!token) throw new Error('Not signed in.');
    return this.call('GET', `/api/app/stats?days=${days === 30 ? 30 : 7}`, { token });
  }

  /** The person's own page on the company server, in the browser. */
  openWeb(page = 'mine') {
    const base = this.serverUrl();
    this.openExternal(page === 'terminal' ? `${base}/terminal` : `${base}/#${page === 'account' ? 'account' : 'mine'}`);
    return { ok: true };
  }

  cancelSignIn() {
    this.pendingSso?.();
    return { ok: true };
  }

  async logout() {
    const token = this.token();
    this.stop();
    if (token) await this.call('POST', '/api/app/logout', { token }).catch(() => {});
    this.save({ token: null, user: null, policy: null, lastReport: null, lastSentAt: null, lastError: null, paused: false });
    return { ok: true, ...this.overview() };
  }

  setPaused(paused) {
    this.save({ paused: Boolean(paused) });
    // Said at once, so the company sees the pause now rather than in a few minutes.
    void this.sendNow();
    return { ok: true, ...this.overview() };
  }

  /** Folders whose sessions are only counted, never described. Kept across sign-outs: they are the person's, not the company's. */
  setPrivateFolders(folders) {
    const list = [...new Set((Array.isArray(folders) ? folders : []).map((f) => String(f ?? '').trim().replace(/\/+$/, '')).filter((f) => f.startsWith('/')))].slice(0, 100);
    this.save({ privateFolders: list });
    void this.sendNow();
    return { ok: true, ...this.overview() };
  }

  /**
   * Whether this person lets their own browser open the sessions on this
   * machine. Off until they turn it on; kept across sign-outs, like the folders.
   */
  setAllowWeb(allow) {
    this.save({ allowWeb: Boolean(allow) });
    return { ok: true, ...this.overview() };
  }

  /** The relay runs exactly while someone is signed in, they allow it, and the company does. */
  syncRelay() {
    if (!this.relay) return;
    const token = this.state.token ? this.token() : null;
    if (token && this.state.allowWeb && this.state.policy?.webTerminal !== false) this.relay.start(this.serverUrl(), token);
    else this.relay.stop();
  }

  deviceName() {
    return `${os.hostname().replace(/\.local$/, '')} (${process.platform === 'darwin' ? 'macOS' : process.platform})`.slice(0, 120);
  }

  // --- reporting ------------------------------------------------------------------
  everyMs() {
    return Math.max(1, Number(this.state.policy?.reportEveryMinutes) || 2) * 60_000;
  }

  start() {
    this.stop();
    this.syncRelay();
    if (!this.token()) return;
    const tick = async () => {
      await this.sendNow();
      this.timer = setTimeout(tick, this.everyMs());
    };
    // The first report goes out as soon as the sessions are back, so whoever looks sees this person online
    // when they open the app, not one interval later.
    this.timer = setTimeout(tick, FIRST_REPORT_MS);
  }

  /**
   * The app is quitting or the machine is going to sleep: tell the server, so this
   * device shows as away now. Never holds a quit up for long, and never fails it.
   */
  async goodbye({ timeoutMs = 1500 } = {}) {
    const token = this.token();
    if (!token) return;
    const route = this.call('POST', '/api/app/bye', { token, body: {} }).catch(() => {});
    await Promise.race([route, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Build the report from what the app knows, and send it. */
  async sendNow() {
    const token = this.token();
    if (!token || this.sending) return;
    this.sending = true;
    try {
      const policy = this.state.policy ?? { ticketPattern: '', sharePaths: false };
      const gathered = this.state.paused ? { sessions: [], repos: new Map(), accounts: [] } : await this.gather();
      const report = buildReport({
        ...gathered,
        policy,
        appVersion: this.appVersion,
        paused: Boolean(this.state.paused),
        privateFolders: this.state.privateFolders ?? [],
        now: this.now(),
        intervalSeconds: Math.round(this.everyMs() / 1000),
      });
      const answer = await this.call('POST', '/api/app/report', { token, body: report });
      this.save({ lastReport: report, lastSentAt: this.now(), lastError: null, policy: answer.policy ?? policy });
    } catch (error) {
      if (error.status === 401) {
        // Signed out by the company, or the account was disabled: stop, and say so.
        this.stop();
        this.save({ token: null, lastError: 'The company server signed this device out. Sign in again to keep sharing.' });
      } else {
        this.save({ lastError: String(error?.message ?? error).slice(0, 300) });
      }
    } finally {
      this.sending = false;
    }
  }
}

module.exports = { OrgService };
