'use strict';

/**
 * This computer's sessions, on a phone — with this computer as the server.
 *
 * When the person turns it on, the app listens on every network interface and
 * serves a small page: the sessions open here, and a terminal for the one that
 * was tapped. Nothing goes through anybody else's server: on the same Wi-Fi the
 * phone talks to the computer directly, and away from home it reaches the same
 * address through a VPN such as Tailscale, as long as the computer is on.
 *
 * A phone is let in once it has been paired: the panel shows a short code, the
 * phone types it, and from then on a token in a cookie says who it is. The
 * token is kept here only as a hash, so the file on disk cannot be replayed.
 * A device can be forgotten from the panel at any time, and every session a
 * phone has open is listed there too, and can be closed from there.
 *
 * Typing on the phone types here, exactly as typing in the app does. A phone
 * may ask the session to take its width so the text is readable; while it has
 * it, that size is the session's, and the app's own resizes are kept for when
 * the phone lets go.
 *
 *   phone → computer, one WebSocket per open session (JSON text frames):
 *     → in {data} | resize {cols, rows} | resize {release: true}
 *     ← opened {cols, rows, title, replay} | out {data} | size {cols, rows} | ended {reason}
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { accept, refuse } = require('./ws');

const DEFAULT_PORT = 7373;
/** A pairing code is six characters from an alphabet with no look-alikes. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_TRIES = 5;
const COOKIE = 'st_device';
const MAX_BODY = 16 * 1024;
const MAX_INPUT = 64 * 1024;
const MAX_VIEWERS = 12;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function parse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function deviceName(ua, given) {
  const name = String(given ?? '').trim().slice(0, 60);
  if (name) return name;
  const s = String(ua ?? '');
  if (/iPhone/.test(s)) return 'iPhone';
  if (/iPad/.test(s)) return 'iPad';
  if (/Android/.test(s)) return 'Android phone';
  if (/Mac OS X/.test(s)) return 'Mac';
  if (/Windows/.test(s)) return 'Windows PC';
  return 'A device';
}

/**
 * What a session printed lately, so a phone that opens it sees more than a
 * blank screen. Cut at a line break, so it never starts inside an escape.
 */
class RecentOutput {
  constructor(limit = 128 * 1024) {
    this.limit = limit;
    this.byPty = new Map();
  }
  add(ptyId, data) {
    let text = (this.byPty.get(ptyId) ?? '') + data;
    if (text.length > this.limit) {
      const cut = text.indexOf('\n', text.length - this.limit);
      text = cut === -1 ? text.slice(-this.limit) : text.slice(cut + 1);
    }
    this.byPty.set(ptyId, text);
  }
  get(ptyId) {
    return this.byPty.get(ptyId) ?? '';
  }
  forget(ptyId) {
    this.byPty.delete(ptyId);
  }
  clear() {
    this.byPty.clear();
  }
}

class RemoteServer {
  /**
   * @param file      where the settings and the paired devices are kept
   * @param webDir    the folder with the page: index.html, app.js, app.css
   * @param assets    { 'xterm.js': path, ... } files served under /assets/
   * @param sessions  () => [{ id, title, kind, cwd }] — what is open in the app, with a pty
   * @param attach    (sessionId) => { ptyId, cols, rows, kind, title, replay } | null
   * @param write     (ptyId, data) => void
   * @param resize    (ptyId, cols, rows) => void — sets the session's size, without the app asking
   * @param redraw    (ptyId) => void — asks a full-screen program to draw itself again
   * @param describe  (sessionId) => string — what the session is doing, in a few words
   * @param notify    (title, body) => void
   * @param changed   () => void — something the panel shows has changed
   */
  constructor({
    file, webDir, assets = {}, sessions, attach, write, resize = () => {}, redraw = () => {}, describe = () => '',
    notify = () => {}, changed = () => {}, log = () => {}, now = Date.now, hostname = () => os.hostname(),
    interfaces = () => os.networkInterfaces(),
  }) {
    Object.assign(this, { file, webDir, assets, sessions, attach, write, resize, redraw, describe, notify, changed, log, now, hostname, interfaces });
    this.server = null;
    this.port = null;
    this.error = null;
    this.pairing = null;
    /** ch → { ch, conn, sessionId, ptyId, title, from, deviceId, at } */
    this.channels = new Map();
    /** ptyId → { cols, rows }: the size the app gave it, to go back to. */
    this.appSizes = new Map();
    /** ptyId → ch: the phone whose size the session has now. */
    this.driven = new Map();
    this.state = this.load();
  }

  // --- settings -----------------------------------------------------------------
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { enabled: Boolean(raw.enabled), port: Number(raw.port) || DEFAULT_PORT, devices: Array.isArray(raw.devices) ? raw.devices : [] };
    } catch {
      return { enabled: false, port: DEFAULT_PORT, devices: [] };
    }
  }

  save(patch) {
    this.state = { ...this.state, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    this.changed();
  }

  get running() {
    return Boolean(this.server?.listening);
  }

  /** Where a phone can reach this: every address of this computer, with the port. */
  addresses() {
    if (!this.running) return [];
    const port = this.port;
    const out = [`http://${String(this.hostname()).replace(/\.local$/, '')}.local:${port}/`];
    for (const list of Object.values(this.interfaces() ?? {})) {
      for (const one of list ?? []) {
        if (one.internal || one.family !== 'IPv4') continue;
        out.push(`http://${one.address}:${port}/`);
      }
    }
    return out;
  }

  overview() {
    const now = this.now();
    if (this.pairing && this.pairing.expiresAt <= now) this.pairing = null;
    return {
      enabled: this.state.enabled,
      running: this.running,
      port: this.state.port,
      error: this.error,
      addresses: this.addresses(),
      pairing: this.pairing ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : null,
      devices: this.state.devices.map(({ id, name, pairedAt, lastSeenAt }) => ({ id, name, pairedAt, lastSeenAt: lastSeenAt ?? null })),
      viewers: [...this.channels.values()].map(({ ch, title, from, at }) => ({ ch, title, from, at })),
    };
  }

  setEnabled(enabled) {
    this.save({ enabled: Boolean(enabled) });
    if (enabled) this.start();
    else this.stop();
    return { ok: true, ...this.overview() };
  }

  setPort(port) {
    const n = Number(port) | 0;
    if (n < 1024 || n > 65535) return { ok: false, error: 'The port has to be between 1024 and 65535.' };
    this.save({ port: n });
    if (this.state.enabled) {
      this.stop();
      this.start();
    }
    return { ok: true, ...this.overview() };
  }

  /** A fresh code the phone types once. Shown in the panel, good for ten minutes or five wrong tries. */
  newPairingCode() {
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    this.pairing = { code, expiresAt: this.now() + CODE_TTL_MS, tries: 0 };
    this.changed();
    return { ok: true, ...this.overview() };
  }

  cancelPairing() {
    this.pairing = null;
    this.changed();
    return { ok: true, ...this.overview() };
  }

  /** Forget a phone. What it has open closes now; its cookie no longer opens anything. */
  revoke(deviceId) {
    const id = String(deviceId ?? '');
    this.save({ devices: this.state.devices.filter((d) => d.id !== id) });
    for (const c of [...this.channels.values()]) if (c.deviceId === id) this.#end(c, 'This phone was forgotten in Smart Terminal.');
    this.changed();
    return { ok: true, ...this.overview() };
  }

  /** Close one session on the phone, or all of them; the sessions keep running here. */
  disconnect(ch = null) {
    for (const c of [...this.channels.values()]) {
      if (ch && c.ch !== ch) continue;
      this.#end(c, 'Closed from Smart Terminal.');
    }
    this.changed();
    return { ok: true, ...this.overview() };
  }

  // --- the server ---------------------------------------------------------------
  start() {
    if (this.server || !this.state.enabled) return;
    const server = http.createServer((req, res) => this.#request(req, res));
    server.on('upgrade', (req, socket) => this.#upgrade(req, socket));
    server.on('error', (error) => {
      this.error = error.code === 'EADDRINUSE' ? `Port ${this.state.port} is in use by something else. Pick another.` : String(error.message ?? error);
      this.log(`remote: ${this.error}`);
      this.server = null;
      this.changed();
    });
    this.server = server;
    this.error = null;
    server.listen(this.state.port, '0.0.0.0', () => {
      this.port = server.address().port;
      this.log(`remote: listening on ${this.port}`);
      this.changed();
    });
  }

  stop() {
    for (const c of [...this.channels.values()]) this.#end(c, 'Remote access was turned off.');
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) {
      server.close();
      server.closeAllConnections?.();
    }
    this.changed();
  }

  // --- what the app tells it ----------------------------------------------------
  output(ptyId, data) {
    for (const c of this.channels.values()) if (c.ptyId === ptyId) this.#send(c, { t: 'out', data });
  }

  /** The app gave the session a size. While a phone drives it, it is kept for later. */
  resized(ptyId, cols, rows) {
    this.appSizes.set(ptyId, { cols, rows });
    if (this.driven.has(ptyId)) return;
    for (const c of this.channels.values()) if (c.ptyId === ptyId) this.#send(c, { t: 'size', cols, rows });
  }

  exited(ptyId) {
    for (const c of [...this.channels.values()]) if (c.ptyId === ptyId) this.#end(c, 'The session ended.');
    this.driven.delete(ptyId);
    this.appSizes.delete(ptyId);
  }

  // --- HTTP ---------------------------------------------------------------------
  #device(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const hash = sha(token);
    const found = this.state.devices.find((d) => same(d.tokenHash, hash));
    if (!found) return null;
    if (this.now() - (found.lastSeenAt ?? 0) > 60_000) {
      found.lastSeenAt = this.now();
      this.save({ devices: this.state.devices });
    }
    return found;
  }

  #json(res, status, value, headers = {}) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(body);
  }

  #file(res, file) {
    fs.readFile(file, (error, data) => {
      if (error) return this.#json(res, 404, { ok: false, error: 'Not here.' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  #body(req) {
    return new Promise((resolve) => {
      let text = '';
      req.on('data', (chunk) => {
        text += chunk;
        if (text.length > MAX_BODY) {
          resolve(null);
          req.destroy();
        }
      });
      req.on('end', () => resolve(parse(text) ?? {}));
      req.on('error', () => resolve(null));
    });
  }

  async #request(req, res) {
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;
    // The page and what it needs, to anyone who can reach the port: it shows nothing until paired.
    if (route === 'GET /' || route === 'GET /index.html') return this.#file(res, path.join(this.webDir, 'index.html'));
    if (route === 'GET /app.js' || route === 'GET /app.css' || route === 'GET /manifest.webmanifest' || route === 'GET /icon.png') {
      return this.#file(res, path.join(this.webDir, url.pathname.slice(1)));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const file = this.assets[url.pathname.slice('/assets/'.length)];
      return file ? this.#file(res, file) : this.#json(res, 404, { ok: false, error: 'Not here.' });
    }

    if (route === 'POST /api/pair') {
      const body = await this.#body(req);
      if (!body) return this.#json(res, 400, { ok: false, error: 'Could not read that.' });
      const pairing = this.pairing;
      if (!pairing || pairing.expiresAt <= this.now()) {
        this.pairing = null;
        return this.#json(res, 403, { ok: false, error: 'No code is waiting. In Smart Terminal, open Remote and press "Pair a phone".' });
      }
      const given = String(body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!same(given, pairing.code)) {
        pairing.tries += 1;
        if (pairing.tries >= CODE_TRIES) {
          this.pairing = null;
          this.changed();
          return this.#json(res, 403, { ok: false, error: 'Too many wrong codes. Ask Smart Terminal for a new one.' });
        }
        return this.#json(res, 403, { ok: false, error: 'That is not the code.' });
      }
      this.pairing = null;
      const token = crypto.randomBytes(32).toString('base64url');
      const device = { id: crypto.randomBytes(6).toString('hex'), name: deviceName(req.headers['user-agent'], body.name), tokenHash: sha(token), pairedAt: this.now(), lastSeenAt: this.now() };
      this.save({ devices: [...this.state.devices, device] });
      this.notify('Phone paired', `${device.name} can now open your sessions.`);
      this.log(`remote: paired ${device.name}`);
      return this.#json(res, 200, { ok: true, device: { id: device.id, name: device.name }, computer: this.#computer() }, {
        'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${365 * 24 * 3600}`,
      });
    }

    const device = this.#device(req);
    if (!device) return this.#json(res, 401, { ok: false, error: 'Not paired.' });

    if (route === 'GET /api/me') return this.#json(res, 200, { ok: true, device: { id: device.id, name: device.name }, computer: this.#computer() });
    if (route === 'GET /api/sessions') return this.#json(res, 200, { ok: true, computer: this.#computer(), sessions: this.#list() });
    if (route === 'POST /api/logout') {
      this.revoke(device.id);
      return this.#json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    return this.#json(res, 404, { ok: false, error: 'Not here.' });
  }

  #computer() {
    return String(this.hostname()).replace(/\.local$/, '');
  }

  #list() {
    return this.sessions().map((s) => ({
      id: s.id,
      title: s.title ?? '',
      kind: s.kind === 'claude' ? 'claude' : 'shell',
      folder: String(s.cwd ?? '').split('/').filter(Boolean).pop() ?? '',
      state: s.kind === 'claude' ? this.describe(s.id) : 'shell',
      open: [...this.channels.values()].some((c) => c.sessionId === s.id),
    }));
  }

  // --- the terminal, over a WebSocket --------------------------------------------
  #upgrade(req, socket) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/terminal') return refuse(socket, 404, 'Not here.');
    // A page from somewhere else cannot open a session with the cookie the browser would attach.
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host !== req.headers.host) return refuse(socket, 403, 'That page is not this computer\'s.');
    }
    const device = this.#device(req);
    if (!device) return refuse(socket, 401, 'Not paired.');
    if (this.channels.size >= MAX_VIEWERS) return refuse(socket, 403, 'Too many sessions open on phones already.');
    const conn = accept(req, socket);
    if (!conn) return;
    const sessionId = String(url.searchParams.get('session') ?? '');
    const offered = this.sessions().find((s) => s.id === sessionId);
    const found = offered ? this.attach(sessionId) : null;
    if (!found) {
      conn.send(JSON.stringify({ t: 'ended', reason: 'That session is not open any more.' }));
      conn.close(1000);
      return;
    }
    const ch = crypto.randomBytes(8).toString('hex');
    const title = found.title || offered.title || 'A session';
    const c = { ch, conn, sessionId, ptyId: found.ptyId, title, from: device.name, deviceId: device.id, at: this.now() };
    if (!this.driven.has(found.ptyId)) this.appSizes.set(found.ptyId, { cols: found.cols, rows: found.rows });
    this.channels.set(ch, c);
    this.#send(c, { t: 'opened', cols: found.cols, rows: found.rows, title, replay: found.replay ?? '' });
    // A full-screen program draws itself again when asked; the replay alone can leave it half drawn.
    if (found.kind === 'claude') this.redraw(found.ptyId);
    this.notify('Opened on your phone', `${title}, from ${device.name}. Typing there types here.`);
    this.log(`remote: ${title} opened from ${device.name}`);
    this.changed();

    conn.on('message', (text) => {
      const m = parse(text);
      if (!m) return;
      if (m.t === 'in') {
        const data = String(m.data ?? '');
        if (data.length <= MAX_INPUT) this.write(c.ptyId, data);
      } else if (m.t === 'resize') {
        if (m.release) this.#giveBack(c);
        else this.#take(c, m.cols, m.rows);
      }
    });
    conn.on('close', () => {
      if (this.channels.get(ch) !== c) return;
      this.channels.delete(ch);
      this.#giveBack(c);
      this.changed();
    });
  }

  /** A phone's size for the session: readable there. */
  #take(c, cols, rows) {
    const size = { cols: Math.max(20, Math.min(400, Number(cols) | 0)), rows: Math.max(5, Math.min(200, Number(rows) | 0)) };
    this.driven.set(c.ptyId, c.ch);
    this.resize(c.ptyId, size.cols, size.rows);
    for (const o of this.channels.values()) if (o.ptyId === c.ptyId && o.ch !== c.ch) this.#send(o, { t: 'size', ...size });
  }

  /** Back to the app's size, if this phone was the one that changed it. */
  #giveBack(c) {
    if (this.driven.get(c.ptyId) !== c.ch) return;
    this.driven.delete(c.ptyId);
    const size = this.appSizes.get(c.ptyId);
    if (!size) return;
    this.resize(c.ptyId, size.cols, size.rows);
    for (const o of this.channels.values()) if (o.ptyId === c.ptyId) this.#send(o, { t: 'size', ...size });
  }

  #end(c, reason) {
    this.channels.delete(c.ch);
    this.#send(c, { t: 'ended', reason });
    c.conn.close(1000);
    this.#giveBack(c);
  }

  #send(c, m) {
    if (c.conn.open) c.conn.send(JSON.stringify(m));
  }
}

module.exports = { RemoteServer, RecentOutput, DEFAULT_PORT, COOKIE };
