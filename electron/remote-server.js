'use strict';

/**
 * This computer's sessions, on a phone — with this computer as the server.
 *
 * When the person turns it on, the app listens on every network interface and
 * serves a small page: the sessions open here, and a terminal for the one that
 * was tapped. Nothing goes through anybody else's server: on the same Wi-Fi the
 * phone talks to the computer directly, and away from home it reaches the same
 * address through Tailscale, as long as the computer is on.
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
 * the phone lets go. One phone drives a session at a time: a second one that
 * asks is told the size the first one set, and follows it.
 *
 * Anything that reaches the port is somebody else's bytes: every entry point
 * catches what it throws and answers, because an exception on the way in
 * would take the whole app down with it.
 *
 *   phone → computer, one WebSocket per open session (JSON text frames):
 *     → in {data} | resize {cols, rows} | resize {release: true}
 *     ← opened {cols, rows, title, replay, driven} | out {data} | size {cols, rows, driven} | ended {reason}
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
/** A wrong code waits this long before the next may be tried: guessing is slow, typing is not. */
const WRONG_CODE_DELAY_MS = 1000;
const COOKIE = 'st_device';
const MAX_BODY = 16 * 1024;
const MAX_INPUT = 64 * 1024;
const MAX_VIEWERS = 12;
/** How often a phone's "last seen" is written down: a file write per request would be silly. */
const SEEN_EVERY_MS = 5 * 60 * 1000;
/** "Opened on your phone" is said once per session per phone in this long; a flaky link reconnects often. */
const NOTIFY_EVERY_MS = 5 * 60 * 1000;
/** A full-screen program is asked to draw itself again this long after a phone opens it, unless the phone sizes it first. */
const REDRAW_AFTER_MS = 300;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** The files the page is made of, by the path a browser asks for. Nothing else under the web folder is served. */
const PAGE_FILES = new Set(['index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'icon.png']);

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

/** The request's cookies; a value that will not decode is no cookie at all. */
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    try {
      out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      /* not ours, and not worth a word */
    }
  }
  return out;
}

/** The request target as a URL, or null when it is not one (an absolute-form target, a bare `*`). */
function urlOf(req) {
  try {
    const url = new URL(req.url, 'http://x');
    return url.host === 'x' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Whether the Host header names this computer: an address, `.local`, a tailnet
 * name, or the computer's own name. A page somewhere else that has pointed a
 * name of its own at this address is refused, which is what stops DNS rebinding
 * from reaching the unauthenticated routes.
 */
function hostIsOurs(host, hostname) {
  const name = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!name) return false;
  if (name === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(name) || /^[0-9a-f:]+$/.test(name)) return true;
  if (name.endsWith('.local') || name.endsWith('.ts.net')) return true;
  const own = String(hostname ?? '').replace(/\.local$/, '').toLowerCase();
  return Boolean(own) && (name === own || name === `${own}.local`);
}

function deviceName(ua, given, standalone = false) {
  const name = String(given ?? '').trim().slice(0, 60);
  if (name) return name;
  const s = String(ua ?? '');
  const base = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android phone' : /Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows PC' : 'A device';
  return standalone ? `${base} (home screen)` : base;
}

/**
 * What a session printed lately, so a phone that opens it sees more than a
 * blank screen. Kept as chunks, so a busy session does not copy the whole
 * buffer on every line; cut at a line break when there is one, else at the
 * last escape, so the replay never starts inside a sequence.
 */
class RecentOutput {
  constructor(limit = 128 * 1024) {
    this.limit = limit;
    /** ptyId → { chunks: string[], size } */
    this.byPty = new Map();
  }
  add(ptyId, data) {
    let entry = this.byPty.get(ptyId);
    if (!entry) {
      entry = { chunks: [], size: 0 };
      this.byPty.set(ptyId, entry);
    }
    entry.chunks.push(data);
    entry.size += data.length;
    while (entry.size > this.limit && entry.chunks.length > 1) entry.size -= entry.chunks.shift().length;
    if (entry.size > this.limit) {
      const only = entry.chunks[0].slice(-this.limit);
      entry.chunks = [only];
      entry.size = only.length;
    }
  }
  get(ptyId) {
    const entry = this.byPty.get(ptyId);
    if (!entry) return '';
    let text = entry.chunks.join('');
    if (text.length > this.limit) text = text.slice(-this.limit);
    const line = text.indexOf('\n');
    if (line !== -1 && line < text.length - 1) return text.slice(line + 1);
    const escape = text.lastIndexOf('\x1b');
    return escape > 0 ? text.slice(escape) : text;
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
   * @param version   this build's version, so a phone can tell it has an old page
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
    file, webDir, assets = {}, version = '', sessions, attach, write, resize = () => {}, redraw = () => {}, describe = () => '',
    notify = () => {}, changed = () => {}, log = () => {}, now = Date.now, hostname = () => os.hostname(),
    interfaces = () => os.networkInterfaces(), tailscale = null,
  }) {
    Object.assign(this, { file, webDir, assets, version, sessions, attach, write, resize, redraw, describe, notify, changed, log, now, hostname, interfaces, tailscale });
    this.server = null;
    this.port = null;
    this.error = null;
    this.pairing = null;
    this.pairingTimer = null;
    /** ch → { ch, conn, sessionId, ptyId, title, from, deviceId, at, redrawTimer } */
    this.channels = new Map();
    /** ptyId → { cols, rows }: the size the app gave it, to go back to. */
    this.appSizes = new Map();
    /** ptyId → ch: the phone whose size the session has now. */
    this.driven = new Map();
    /** ptyId → { cols, rows }: the size the driving phone set, for a second phone to follow. */
    this.phoneSizes = new Map();
    /** `${deviceId}/${sessionId}` → when the app last said a phone opened it. */
    this.notified = new Map();
    this.state = this.load();
  }

  // --- settings -----------------------------------------------------------------
  load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A file that will not parse is kept aside rather than overwritten: the paired phones are in it.
        try { fs.renameSync(this.file, `${this.file}.broken`); } catch { /* then it stays */ }
        this.log(`remote: could not read ${this.file}: ${error.message}`);
      }
      return { enabled: false, port: DEFAULT_PORT, devices: [] };
    }
    return {
      enabled: Boolean(raw.enabled),
      port: Number(raw.port) || DEFAULT_PORT,
      devices: (Array.isArray(raw.devices) ? raw.devices : []).filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string'),
    };
  }

  /** Written whole and renamed into place, so a crash mid-write cannot leave half a file. */
  save(patch) {
    this.state = { ...this.state, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.changed();
  }

  get running() {
    return Boolean(this.server?.listening);
  }

  /** Where a phone can reach this at home: every address of this computer on its own networks, with the port. */
  addresses() {
    if (!this.running) return [];
    const port = this.port;
    const out = [`http://${String(this.hostname()).replace(/\.local$/, '')}.local:${port}/`];
    for (const list of Object.values(this.interfaces() ?? {})) {
      for (const one of list ?? []) {
        if (one.internal || one.family !== 'IPv4') continue;
        // Tailscale's own range: that address is the away one, listed under Tailscale.
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(one.address)) continue;
        out.push(`http://${one.address}:${port}/`);
      }
    }
    return out;
  }

  /** Where a phone reaches this from anywhere, through Tailscale: the computer's name on the tailnet, then its IP there. */
  awayAddresses() {
    if (!this.running || !this.tailscale) return [];
    return this.tailscale.addresses(this.port);
  }

  /** Every address a phone may be told to open, at home or away. */
  allAddresses() {
    return [...this.addresses(), ...this.awayAddresses()];
  }

  /**
   * The overview, with Tailscale asked in the background: the panel gets its
   * answer now, and a `changed` once Tailscale has spoken, if that changes it.
   */
  async overviewFresh() {
    if (this.tailscale) {
      const before = JSON.stringify(this.tailscale.last);
      const fresh = this.tailscale.last && this.now() - this.tailscale.readAt < 10_000;
      if (fresh) await this.tailscale.info();
      else this.tailscale.info().then(() => { if (JSON.stringify(this.tailscale.last) !== before) this.changed(); });
    }
    return this.overview();
  }

  overview() {
    this.#expirePairing();
    return {
      enabled: this.state.enabled,
      running: this.running,
      port: this.state.port,
      error: this.error,
      addresses: this.addresses(),
      away: this.awayAddresses(),
      tailscale: this.tailscale ? { installed: this.tailscale.installed, running: Boolean(this.tailscale.last?.running), name: this.tailscale.last?.name ?? null, error: this.tailscale.last?.error ?? null, checked: Boolean(this.tailscale.last) } : null,
      pairing: this.pairing ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : null,
      devices: this.state.devices.map(({ id, name, pairedAt, lastSeenAt }) => ({ id, name, pairedAt, lastSeenAt: lastSeenAt ?? null })),
      viewers: [...this.channels.values()].map(({ ch, title, from, at, sessionId }) => ({ ch, title, from, at, sessionId })),
    };
  }

  async setEnabled(enabled) {
    this.save({ enabled: Boolean(enabled) });
    if (enabled) await this.start();
    else await this.stop();
    return { ok: true, ...this.overview() };
  }

  async setPort(port) {
    const n = Number(port) | 0;
    if (!Number.isInteger(Number(port)) || n < 1024 || n > 65535) return { ok: false, error: 'The port has to be a number between 1024 and 65535.' };
    if (n === this.state.port) return { ok: true, ...this.overview() };
    this.save({ port: n });
    if (this.state.enabled) {
      await this.stop();
      await this.start();
    }
    return { ok: true, ...this.overview() };
  }

  /** A fresh code the phone types once. Shown in the panel, good for ten minutes or five wrong tries. */
  newPairingCode() {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    this.pairing = { code, expiresAt: this.now() + CODE_TTL_MS, tries: 0, notBefore: 0 };
    clearTimeout(this.pairingTimer);
    // When the code runs out the panel is told, rather than showing a dead code until something else happens.
    this.pairingTimer = setTimeout(() => this.#expirePairing(), CODE_TTL_MS + 50);
    this.pairingTimer.unref?.();
    this.changed();
    return { ok: true, ...this.overview() };
  }

  cancelPairing() {
    this.pairing = null;
    clearTimeout(this.pairingTimer);
    this.changed();
    return { ok: true, ...this.overview() };
  }

  #expirePairing() {
    if (this.pairing && this.pairing.expiresAt <= this.now()) {
      this.pairing = null;
      this.changed();
    }
  }

  /** Forget a phone. What it has open closes now; its cookie no longer opens anything. */
  revoke(deviceId) {
    const id = String(deviceId ?? '');
    const gone = this.state.devices.find((d) => d.id === id);
    this.save({ devices: this.state.devices.filter((d) => d.id !== id) });
    for (const c of [...this.channels.values()]) if (c.deviceId === id) this.#end(c, 'This phone was forgotten in Smart Terminal.');
    this.changed();
    return { ok: true, forgotten: gone?.name ?? null, ...this.overview() };
  }

  /** Close one session on the phone, or all of them; the sessions keep running here. */
  disconnect(ch = null) {
    let closed = 0;
    for (const c of [...this.channels.values()]) {
      if (ch && c.ch !== ch) continue;
      this.#end(c, 'Closed from Smart Terminal.');
      closed += 1;
    }
    this.changed();
    return { ok: true, closed, ...this.overview() };
  }

  /** Whether a phone has this session at its own size; the app's resizes then wait. */
  drives(ptyId) {
    return this.driven.has(ptyId);
  }

  // --- the server ---------------------------------------------------------------
  /** Listen, if turned on. Settles once the port is bound or refused, so a caller can say which. */
  start() {
    if (this.server || !this.state.enabled) return Promise.resolve(this.running);
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.#request(req, res));
      server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
      server.on('error', (error) => {
        this.error = error.code === 'EADDRINUSE' ? `Port ${this.state.port} is in use by something else. Pick another port below.`
          : error.code === 'EACCES' ? `This computer does not allow port ${this.state.port}. Pick another port below.`
            : `Could not listen on port ${this.state.port}: ${error.message ?? error}`;
        this.log(`remote: ${this.error}`);
        if (this.server === server) {
          // Whether it never bound or died later, what was open on it is over.
          this.server = null;
          this.port = null;
          for (const c of [...this.channels.values()]) this.#end(c, 'The connection on this computer failed.');
        }
        this.changed();
        resolve(false);
      });
      this.server = server;
      this.error = null;
      server.listen(this.state.port, '0.0.0.0', () => {
        this.port = server.address().port;
        this.log(`remote: listening on ${this.port}`);
        this.changed();
        resolve(true);
      });
    });
  }

  /** Stop listening and close what is open. Settles once the port is free again, so a restart can bind it. */
  stop(reason = 'Remote access was turned off.') {
    for (const c of [...this.channels.values()]) this.#end(c, reason);
    const server = this.server;
    this.server = null;
    this.port = null;
    this.error = null;
    this.changed();
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  // --- what the app tells it ----------------------------------------------------
  output(ptyId, data) {
    for (const c of this.channels.values()) if (c.ptyId === ptyId) this.#send(c, { t: 'out', data });
  }

  /** The app gave the session a size. While a phone drives it, it is kept for later. */
  resized(ptyId, cols, rows) {
    this.appSizes.set(ptyId, { cols, rows });
    if (this.driven.has(ptyId)) return;
    for (const c of this.channels.values()) if (c.ptyId === ptyId) this.#send(c, { t: 'size', cols, rows, driven: false });
  }

  exited(ptyId) {
    for (const c of [...this.channels.values()]) if (c.ptyId === ptyId) this.#end(c, 'The session ended or restarted. Open it again from the list.');
    this.driven.delete(ptyId);
    this.appSizes.delete(ptyId);
    this.phoneSizes.delete(ptyId);
  }

  // --- HTTP ---------------------------------------------------------------------
  #device(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const hash = sha(token);
    const found = this.state.devices.find((d) => same(d.tokenHash, hash));
    if (!found) return null;
    if (this.now() - (found.lastSeenAt ?? 0) > SEEN_EVERY_MS) {
      found.lastSeenAt = this.now();
      try {
        this.save({ devices: this.state.devices });
      } catch (error) {
        this.log(`remote: could not note the phone: ${error.message}`);
      }
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

  /** The request body as JSON, `null` when it is not JSON or too big; counted in bytes, joined before decoding. */
  #body(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(parse(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', () => resolve(null));
    });
  }

  async #request(req, res) {
    try {
      await this.#route(req, res);
    } catch (error) {
      this.log(`remote: ${req.method} ${req.url}: ${error?.stack ?? error}`);
      if (!res.headersSent) this.#json(res, 500, { ok: false, error: 'Something went wrong on the computer.' });
      else res.end();
    }
  }

  async #route(req, res) {
    const url = urlOf(req);
    if (!url) return this.#json(res, 400, { ok: false, error: 'Not a request this understands.' });
    if (!hostIsOurs(req.headers.host, this.hostname())) return this.#json(res, 421, { ok: false, error: 'That name is not this computer\'s.' });
    const route = `${req.method} ${url.pathname}`;
    // The page and what it needs, to anyone who can reach the port: it shows nothing until paired.
    if (route === 'GET /' || route === 'GET /index.html') return this.#file(res, path.join(this.webDir, 'index.html'));
    if (req.method === 'GET' && PAGE_FILES.has(url.pathname.slice(1))) return this.#file(res, path.join(this.webDir, url.pathname.slice(1)));
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const name = url.pathname.slice('/assets/'.length);
      return Object.hasOwn(this.assets, name) ? this.#file(res, this.assets[name]) : this.#json(res, 404, { ok: false, error: 'Not here.' });
    }

    if (route === 'POST /api/pair') return this.#pair(req, res);

    const device = this.#device(req);
    if (!device) return this.#json(res, 401, { ok: false, error: 'Not paired.' });

    if (route === 'GET /api/me') return this.#json(res, 200, { ok: true, device: { id: device.id, name: device.name }, computer: this.#computer(), version: this.version });
    if (route === 'GET /api/sessions') return this.#json(res, 200, { ok: true, computer: this.#computer(), version: this.version, sessions: this.#list() });
    if (route === 'POST /api/logout') {
      this.revoke(device.id);
      return this.#json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    return this.#json(res, 404, { ok: false, error: 'Not here.' });
  }

  async #pair(req, res) {
    const body = await this.#body(req);
    if (!body) return this.#json(res, 400, { ok: false, error: 'Could not read that.' });
    this.#expirePairing();
    const pairing = this.pairing;
    if (!pairing) return this.#json(res, 403, { ok: false, error: 'No code is waiting. In Smart Terminal, open Remote and press "Pair a phone".' });
    if (this.now() < pairing.notBefore) return this.#json(res, 429, { ok: false, error: 'Wait a second, then try again.' });
    const given = String(body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!same(given, pairing.code)) {
      pairing.tries += 1;
      pairing.notBefore = this.now() + WRONG_CODE_DELAY_MS;
      if (pairing.tries >= CODE_TRIES) {
        this.pairing = null;
        this.changed();
        return this.#json(res, 403, { ok: false, error: 'Too many wrong codes. Ask Smart Terminal for a new one.' });
      }
      return this.#json(res, 403, { ok: false, error: `That is not the code. ${CODE_TRIES - pairing.tries} ${CODE_TRIES - pairing.tries === 1 ? 'try' : 'tries'} left.` });
    }
    this.pairing = null;
    clearTimeout(this.pairingTimer);
    const token = crypto.randomBytes(32).toString('base64url');
    const device = {
      id: crypto.randomBytes(6).toString('hex'),
      name: deviceName(req.headers['user-agent'], body.name, body.standalone === true),
      tokenHash: sha(token),
      pairedAt: this.now(),
      lastSeenAt: this.now(),
    };
    this.save({ devices: [...this.state.devices, device] });
    this.notify('Phone paired', `${device.name} can now open your sessions.`);
    this.log(`remote: paired ${device.name}`);
    return this.#json(res, 200, { ok: true, device: { id: device.id, name: device.name }, computer: this.#computer(), version: this.version }, {
      'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${365 * 24 * 3600}`,
    });
  }

  #computer() {
    return String(this.hostname()).replace(/\.local$/, '');
  }

  #list() {
    const viewers = [...this.channels.values()];
    return this.sessions().map((s) => ({
      id: s.id,
      title: s.title ?? '',
      kind: s.kind === 'claude' ? 'claude' : 'shell',
      folder: String(s.cwd ?? '').split('/').filter(Boolean).pop() ?? '',
      state: s.kind === 'claude' ? this.describe(s.id) : 'shell',
      open: viewers.some((c) => c.sessionId === s.id),
      openOn: viewers.filter((c) => c.sessionId === s.id).map((c) => c.from),
    }));
  }

  // --- the terminal, over a WebSocket --------------------------------------------
  #upgrade(req, socket, head) {
    try {
      this.#open(req, socket, head);
    } catch (error) {
      this.log(`remote: upgrade ${req.url}: ${error?.stack ?? error}`);
      refuse(socket, 500, 'Something went wrong on the computer.');
    }
  }

  #open(req, socket, head) {
    const url = urlOf(req);
    if (!url) return refuse(socket, 400, 'Not a request this understands.');
    if (!hostIsOurs(req.headers.host, this.hostname())) return refuse(socket, 421, 'That name is not this computer\'s.');
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
    const conn = accept(req, socket, head);
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
    const kind = found.kind === 'claude' ? 'claude' : 'shell';
    const c = { ch, conn, sessionId, ptyId: found.ptyId, kind, title, from: device.name, deviceId: device.id, at: this.now(), redrawTimer: null };
    const appSize = { cols: Number(found.cols) || 80, rows: Number(found.rows) || 24 };
    if (!this.driven.has(found.ptyId)) this.appSizes.set(found.ptyId, appSize);
    this.channels.set(ch, c);
    // Another phone already has it at its size: this one starts there, and follows.
    const driven = this.driven.has(found.ptyId);
    const size = driven ? this.phoneSizes.get(found.ptyId) ?? appSize : appSize;
    // A full-screen program draws itself for the size it has; a replay made for another width would only be a mess.
    const replay = kind === 'claude' ? '' : found.replay ?? '';
    this.#send(c, { t: 'opened', cols: size.cols, rows: size.rows, title, kind, replay, driven });
    // A full-screen program draws itself again when asked. Asked a moment later, so a phone that sizes it first is not undone.
    if (kind === 'claude') {
      c.redrawTimer = setTimeout(() => {
        c.redrawTimer = null;
        if (this.channels.get(ch) === c) this.redraw(found.ptyId);
      }, REDRAW_AFTER_MS);
    }
    const key = `${device.id}/${sessionId}`;
    if (this.now() - (this.notified.get(key) ?? 0) > NOTIFY_EVERY_MS) {
      this.notified.set(key, this.now());
      this.notify('Opened on your phone', `${title}, from ${device.name}. Typing there types here.`);
    }
    this.log(`remote: ${title} opened from ${device.name}`);
    this.changed();

    conn.on('message', (text) => {
      try {
        const m = parse(text);
        if (!m) return;
        if (m.t === 'in') {
          const data = String(m.data ?? '');
          if (data.length <= MAX_INPUT) this.write(c.ptyId, data);
        } else if (m.t === 'resize') {
          if (m.release) this.#giveBack(c);
          else this.#take(c, m.cols, m.rows);
        }
      } catch (error) {
        this.log(`remote: from ${device.name}: ${error?.stack ?? error}`);
      }
    });
    conn.on('close', () => {
      if (this.channels.get(ch) !== c) return;
      clearTimeout(c.redrawTimer);
      this.channels.delete(ch);
      this.#giveBack(c);
      this.changed();
    });
  }

  /**
   * A phone's size for the session: readable there. The first phone to ask
   * gets it; a second is told the size the first one set, and follows it.
   */
  #take(c, cols, rows) {
    const size = { cols: Math.max(20, Math.min(400, Number(cols) | 0)), rows: Math.max(5, Math.min(200, Number(rows) | 0)) };
    const driver = this.driven.get(c.ptyId);
    if (driver && driver !== c.ch && this.channels.has(driver)) {
      const current = this.phoneSizes.get(c.ptyId);
      if (current) this.#send(c, { t: 'size', ...current, driven: true });
      return;
    }
    // Sized by the phone now: the redraw that was coming is not needed, the new size brings one.
    clearTimeout(c.redrawTimer);
    c.redrawTimer = null;
    this.driven.set(c.ptyId, c.ch);
    this.phoneSizes.set(c.ptyId, size);
    this.resize(c.ptyId, size.cols, size.rows);
    for (const o of this.channels.values()) if (o.ptyId === c.ptyId && o.ch !== c.ch) this.#send(o, { t: 'size', ...size, driven: true });
  }

  /** Back to the app's size, if this phone was the one that changed it. */
  #giveBack(c) {
    if (this.driven.get(c.ptyId) !== c.ch) return;
    this.driven.delete(c.ptyId);
    this.phoneSizes.delete(c.ptyId);
    const size = this.appSizes.get(c.ptyId);
    if (!size) return;
    this.resize(c.ptyId, size.cols, size.rows);
    for (const o of this.channels.values()) if (o.ptyId === c.ptyId) this.#send(o, { t: 'size', ...size, driven: false });
  }

  #end(c, reason) {
    clearTimeout(c.redrawTimer);
    this.channels.delete(c.ch);
    this.#send(c, { t: 'ended', reason });
    c.conn.close(1000);
    this.#giveBack(c);
  }

  #send(c, m) {
    if (c.conn.open) c.conn.send(JSON.stringify(m));
  }
}

module.exports = { RemoteServer, RecentOutput, DEFAULT_PORT, COOKIE, hostIsOurs, cookies, urlOf };
