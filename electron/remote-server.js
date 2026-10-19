'use strict';

/**
 * This computer's sessions, on a phone — with this computer as the server.
 *
 * When the person turns it on, the app listens on the network and serves a
 * small page: the sessions open here, and a terminal for the one that was
 * tapped. Nothing goes through anybody else's server: on the same Wi-Fi the
 * phone talks to the computer directly, and away from home it reaches the same
 * address through Tailscale, as long as the computer is on. It can be told to
 * listen through Tailscale only, for a computer that joins networks it does
 * not trust.
 *
 * A phone is let in once it has been paired: the panel shows a short code, the
 * phone types it, and from then on a token in a cookie says who it is. The
 * token is kept here only as a hash, so the file on disk cannot be replayed.
 * A device can be forgotten from the panel at any time, is forgotten on its
 * own after a month unseen, and every session a phone has open is listed
 * there too, and can be closed from there.
 *
 * Typing on the phone types here, exactly as typing in the app does. A phone
 * may ask the session to take its width so the text is readable; while it has
 * it, that size is the session's, and the app's own resizes are kept for when
 * the phone lets go. One phone drives a session at a time: a second one that
 * asks is told the size the first one set, and follows it. A driving phone
 * that drops for a moment keeps the size for a few seconds, so a blip on the
 * phone's Wi-Fi does not make the session redraw twice.
 *
 * Anything that reaches the port is somebody else's bytes: every entry point
 * catches what it throws and answers, because an exception on the way in
 * would take the whole app down with it.
 *
 *   phone → computer, one WebSocket per open session (JSON text frames):
 *     → in {data} | resize {cols, rows} | resize {release: true} | ping
 *     ← opened {cols, rows, title, kind, replay, driven} | out {data} | size {cols, rows, driven} | ended {reason} | pong
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { accept, refuse } = require('./ws');
const { QR } = require('./qr');

const DEFAULT_PORT = 7373;
/** A pairing code is six characters from an alphabet with no look-alikes. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong codes an address may try before it is refused until the next code. */
const CODE_TRIES = 5;
/** A wrong code waits this long before the same address may try again: guessing is slow, typing is not. */
const WRONG_CODE_DELAY_MS = 1000;
/** A code just used may be used once more, from the same phone, for this long: a page added to the home screen has a cookie jar of its own. */
const CODE_REUSE_MS = 3 * 60 * 1000;
const COOKIE = 'st_device';
const COOKIE_MAX_AGE = 365 * 24 * 3600;
/** A phone not seen for this long needs a new code: a phone that was lost or sold does not keep a door open for a year. */
const DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const MAX_INPUT = 64 * 1024;
/** Typing allowed per channel per second; a phone cannot flood a session faster than a person could type. */
const INPUT_PER_SECOND = 256 * 1024;
const MAX_VIEWERS = 12;
/** Sessions one phone may have open; its oldest closes to make room. */
const MAX_VIEWERS_PER_DEVICE = 6;
/** Sockets the server holds at once; more are dropped without a word. */
const MAX_SOCKETS = 64;
/** How often a phone's "last seen" is written down: a file write per request would be silly. */
const SEEN_EVERY_MS = 5 * 60 * 1000;
/** "Opened on your phone" is said once per session per phone in this long; a flaky link reconnects often. */
const NOTIFY_EVERY_MS = 5 * 60 * 1000;
/** A full-screen program is asked to draw itself again this long after a phone opens it, unless the phone sizes it first. */
const REDRAW_AFTER_MS = 300;
/** A driving phone that dropped keeps the size this long, in case it is back in a moment. */
const DRIVE_GRACE_MS = 10 * 1000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Said on every answer: the page may not be framed by another site, and nothing but its own files run in it. */
const SAFETY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** The files the page is made of, by the path a browser asks for. Nothing else under the web folder is served. */
const PAGE_FILES = new Set(['index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'icon.png', 'icon-180.png']);

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
 * Whether the Host header names this computer: an address, its own name
 * (bare or `.local`), or its name on the tailnet. A page somewhere else that
 * has pointed a name of its own at this address is refused, which is what
 * stops DNS rebinding from reaching the unauthenticated routes.
 */
function hostIsOurs(host, hostname, tailnetName = null) {
  let name = String(host ?? '').toLowerCase();
  if (name.startsWith('[')) name = name.slice(1, name.indexOf(']') === -1 ? undefined : name.indexOf(']'));
  else name = name.replace(/:\d+$/, '');
  if (!name) return false;
  if (name === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(name)) return true;
  if (name.includes(':') && /^[0-9a-f:.]+$/.test(name)) return true;
  const own = String(hostname ?? '').replace(/\.local$/, '').toLowerCase();
  if (own && (name === own || name === `${own}.local`)) return true;
  return Boolean(tailnetName) && name === String(tailnetName).toLowerCase();
}

/** Whether a browser request came from this page itself, or from no page: another site's page is not allowed to ask. */
function fromOurPage(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** A phone's name as it will be listed: without the characters that could make one name look like another. */
function cleanName(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function deviceName(ua, given, standalone = false) {
  const name = cleanName(given);
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
   * @param driven    (ptyId, from | null) => void — a phone took the session's size, or gave it back
   */
  constructor({
    file, webDir, assets = {}, version = '', sessions, attach, write, resize = () => {}, redraw = () => {}, describe = () => '',
    notify = () => {}, changed = () => {}, driven = () => {}, log = () => {}, now = Date.now, hostname = () => os.hostname(),
    interfaces = () => os.networkInterfaces(), tailscale = null, driveGraceMs = DRIVE_GRACE_MS,
  }) {
    Object.assign(this, { file, webDir, assets, version, sessions, attach, write, resize, redraw, describe, notify, changed, drivenChanged: driven, log, now, hostname, interfaces, tailscale, driveGraceMs });
    this.server = null;
    /** The start under way, so two callers at once wait for one bind. */
    this.starting = null;
    this.port = null;
    this.error = null;
    this.pairing = null;
    this.pairingTimer = null;
    /** ch → { ch, conn, sessionId, ptyId, title, from, deviceId, at, redrawTimer, budget, budgetAt } */
    this.channels = new Map();
    /** ptyId → { cols, rows }: the size the app gave it, to go back to. */
    this.appSizes = new Map();
    /** ptyId → { ch, deviceId, from, timer }: the phone whose size the session has now; `timer` while it is only remembered. */
    this.driven = new Map();
    /** ptyId → { cols, rows }: the size the driving phone set, for a second phone to follow. */
    this.phoneSizes = new Map();
    /** `${deviceId}/${sessionId}` → when the app last said a phone opened it. */
    this.notified = new Map();
    /** A write of "last seen" waiting its turn, so a burst of requests makes one. */
    this.seenTimer = null;
    this.sockets = 0;
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
      return { enabled: false, port: DEFAULT_PORT, bind: 'all', devices: [] };
    }
    const port = Number(raw.port);
    return {
      enabled: Boolean(raw.enabled),
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT,
      bind: raw.bind === 'tailscale' ? 'tailscale' : 'all',
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
    // A file made by an older build keeps the mode it had; this one is for the owner alone.
    try { fs.chmodSync(this.file, 0o600); } catch { /* fine */ }
    this.changed();
  }

  get running() {
    return Boolean(this.server?.listening);
  }

  /** Where a phone can reach this at home: every address of this computer on its own networks, with the port. */
  addresses() {
    if (!this.running || this.state.bind === 'tailscale') return [];
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

  /** The little the app's own chrome shows: on or not, failed or not, and who has what open. Costs nothing. */
  status() {
    return {
      enabled: this.state.enabled,
      running: this.running,
      error: this.error,
      viewers: this.#viewers(),
    };
  }

  #viewers() {
    return [...this.channels.values()].map(({ ch, title, from, at, sessionId, ptyId, deviceId }) => ({
      ch, title, from, at, sessionId, deviceId, driven: this.driven.get(ptyId)?.ch === ch,
    }));
  }

  overview() {
    this.#expirePairing();
    const viewers = this.#viewers();
    return {
      enabled: this.state.enabled,
      running: this.running,
      port: this.state.port,
      bind: this.state.bind,
      error: this.error,
      addresses: this.addresses(),
      away: this.awayAddresses(),
      tailscale: this.tailscale ? { installed: this.tailscale.installed, running: Boolean(this.tailscale.last?.running), name: this.tailscale.last?.name ?? null, error: this.tailscale.last?.error ?? null, checked: Boolean(this.tailscale.last) } : null,
      pairing: this.pairing && !this.pairing.spentAt ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt, links: this.#pairingLinks(this.pairing.code) } : null,
      devices: this.state.devices.map(({ id, name, pairedAt, lastSeenAt }) => ({ id, name, pairedAt, lastSeenAt: lastSeenAt ?? null, open: viewers.filter((v) => v.deviceId === id).length })),
      viewers,
    };
  }

  /** Each address with the code in it, and a QR code of it for the phone's camera: one scan, paired. */
  #pairingLinks(code) {
    return this.allAddresses().map((address) => {
      const url = `${address}?code=${code}`;
      return { address, url, qr: QR.svg(url, `Pairing link for ${address}`) };
    });
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
    await this.#restart();
    return { ok: true, ...this.overview() };
  }

  /** Where to listen: every network this computer is on, or Tailscale alone. */
  async setBind(bind) {
    const mode = bind === 'tailscale' ? 'tailscale' : bind === 'all' ? 'all' : null;
    if (!mode) return { ok: false, error: 'Listen on every network, or through Tailscale only.' };
    if (mode === this.state.bind) return { ok: true, ...this.overview() };
    this.save({ bind: mode });
    await this.#restart();
    return { ok: true, ...this.overview() };
  }

  async #restart() {
    if (!this.state.enabled) return;
    await this.stop('Remote access was restarted on this computer. Open the session again.');
    await this.start();
  }

  /** A fresh code the phone types once. Shown in the panel, good for ten minutes or five wrong tries. */
  newPairingCode() {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    this.pairing = { code, expiresAt: this.now() + CODE_TTL_MS, tries: new Map(), spentAt: 0, spentBy: null, spentUa: null };
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
    if (!gone) return { ok: false, error: 'That phone is not paired any more.', ...this.overview() };
    this.save({ devices: this.state.devices.filter((d) => d.id !== id) });
    for (const c of [...this.channels.values()]) if (c.deviceId === id) this.#end(c, 'This phone was forgotten in Smart Terminal.');
    this.changed();
    return { ok: true, forgotten: gone.name, ...this.overview() };
  }

  /** Close one session on the phone, or all of them; the sessions keep running here. */
  disconnect(ch = null) {
    if (ch && !this.channels.has(ch)) return { ok: false, error: 'That session is not open on the phone any more.', ...this.overview() };
    let closed = 0;
    for (const c of [...this.channels.values()]) {
      if (ch && c.ch !== ch) continue;
      this.#end(c, 'Closed from Smart Terminal.');
      closed += 1;
    }
    this.changed();
    return { ok: true, closed, ...this.overview() };
  }

  /** Give a session its own size back without closing it on the phone; the phone's text then follows the app's width. */
  release(ch) {
    const c = this.channels.get(String(ch ?? ''));
    if (!c) return { ok: false, error: 'That session is not open on the phone any more.', ...this.overview() };
    if (this.driven.get(c.ptyId)?.ch !== c.ch) return { ok: true, ...this.overview() };
    this.#giveBack(c, true);
    this.changed();
    return { ok: true, ...this.overview() };
  }

  /** Whether a phone has this session at its own size; the app's resizes then wait. */
  drives(ptyId) {
    return this.driven.has(ptyId);
  }

  /** Who sized the session, while a phone has it. */
  driver(ptyId) {
    return this.driven.get(ptyId)?.from ?? null;
  }

  // --- the server ---------------------------------------------------------------
  /** Listen, if turned on. Settles once the port is bound or refused, so a caller can say which. */
  start() {
    if (this.starting) return this.starting;
    if (this.server || !this.state.enabled) return Promise.resolve(this.running);
    const host = this.#listenHost();
    if (!host) {
      this.error = 'Tailscale is not connected, and Remote is set to listen through Tailscale only. Open Tailscale and sign in, or listen on every network.';
      this.log(`remote: ${this.error}`);
      this.changed();
      return Promise.resolve(false);
    }
    this.starting = new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        this.starting = null;
        resolve(value);
      };
      const server = http.createServer((req, res) => this.#request(req, res));
      server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
      // A peer that opens sockets and says nothing does not get to hold the app's main process.
      server.requestTimeout = 10_000;
      server.headersTimeout = 5_000;
      server.keepAliveTimeout = 5_000;
      server.maxRequestsPerSocket = 100;
      server.on('connection', (socket) => {
        if (this.sockets >= MAX_SOCKETS) { socket.destroy(); return; }
        this.sockets += 1;
        socket.once('close', () => { this.sockets -= 1; });
      });
      server.on('error', (error) => {
        this.error = error.code === 'EADDRINUSE' ? `Port ${this.state.port} is in use by something else. Pick another port below.`
          : error.code === 'EACCES' ? `This computer does not allow port ${this.state.port}. Pick another port below.`
            : error.code === 'EADDRNOTAVAIL' ? `This computer has no address ${host} right now. Is Tailscale connected?`
              : `Could not listen on port ${this.state.port}: ${error.message ?? error}`;
        this.log(`remote: ${this.error}`);
        if (this.server === server) {
          // Whether it never bound or died later, what was open on it is over.
          this.server = null;
          this.port = null;
          for (const c of [...this.channels.values()]) this.#end(c, 'The connection on this computer failed.');
          this.notify('Remote could not start', this.error);
        }
        this.changed();
        settle(false);
      });
      // Stopped before it was bound: the start is over too, or a caller would wait for ever.
      server.once('close', () => settle(false));
      this.server = server;
      this.error = null;
      try {
        server.listen(this.state.port, host, () => {
          this.port = server.address().port;
          this.log(`remote: listening on ${host}:${this.port}`);
          this.changed();
          settle(true);
        });
      } catch (error) {
        this.server = null;
        this.error = `Could not listen on port ${this.state.port}: ${error.message ?? error}`;
        this.log(`remote: ${this.error}`);
        this.changed();
        settle(false);
      }
    });
    return this.starting;
  }

  /** The address to bind: everything, or Tailscale's address of this computer alone; null when that is not there. */
  #listenHost() {
    if (this.state.bind !== 'tailscale') return '0.0.0.0';
    const ip = this.tailscale?.last?.running ? this.tailscale.last.ips?.[0] : null;
    return ip ?? null;
  }

  /** Stop listening and close what is open. Settles once the port is free again, so a restart can bind it. */
  stop(reason = 'Remote access was turned off.') {
    for (const c of [...this.channels.values()]) this.#end(c, reason);
    for (const d of this.driven.values()) clearTimeout(d.timer);
    this.driven.clear();
    this.phoneSizes.clear();
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
    const d = this.driven.get(ptyId);
    if (d) clearTimeout(d.timer);
    this.driven.delete(ptyId);
    this.appSizes.delete(ptyId);
    this.phoneSizes.delete(ptyId);
  }

  // --- HTTP ---------------------------------------------------------------------
  /** The paired phone behind the request, or null; one unseen for a month is no longer paired. */
  #device(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const hash = sha(token);
    const found = this.state.devices.find((d) => same(d.tokenHash, hash));
    if (!found) return null;
    if (this.now() - (found.lastSeenAt ?? found.pairedAt ?? 0) > DEVICE_IDLE_MS) {
      this.log(`remote: ${found.name} was not seen for a month and is forgotten`);
      this.save({ devices: this.state.devices.filter((d) => d !== found) });
      return null;
    }
    if (this.now() - (found.lastSeenAt ?? 0) > SEEN_EVERY_MS) {
      found.lastSeenAt = this.now();
      this.#noteSeen();
    }
    return found;
  }

  /** "Last seen" reaches the disk a moment later, once, however many requests came in that moment. */
  #noteSeen() {
    if (this.seenTimer) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      try {
        this.save({ devices: this.state.devices });
      } catch (error) {
        this.log(`remote: could not note the phone: ${error.message}`);
      }
    }, 1000);
    this.seenTimer.unref?.();
  }

  #json(res, status, value, headers = {}) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SAFETY_HEADERS, ...headers });
    res.end(body);
  }

  #file(res, file) {
    fs.readFile(file, (error, data) => {
      try {
        if (error) return this.#json(res, 404, { ok: false, error: 'Not here.' });
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SAFETY_HEADERS });
        res.end(data);
      } catch (e) {
        this.log(`remote: serving ${file}: ${e?.message ?? e}`);
        res.destroy();
      }
    });
  }

  /**
   * The request body as JSON: `null` when it is not JSON, `TOO_BIG` when it is
   * more than a form could be; counted in bytes, joined before decoding.
   */
  #body(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          finish(TOO_BIG);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => finish(parse(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', () => finish(null));
      req.on('close', () => finish(null));
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
    if (!hostIsOurs(req.headers.host, this.hostname(), this.tailscale?.last?.name)) return this.#json(res, 421, { ok: false, error: 'That name is not this computer\'s.' });
    const route = `${req.method} ${url.pathname}`;
    // The page and what it needs, to anyone who can reach the port: it shows nothing until paired.
    if (route === 'GET /' || route === 'GET /index.html') return this.#file(res, path.join(this.webDir, 'index.html'));
    if (req.method === 'GET' && PAGE_FILES.has(url.pathname.slice(1))) return this.#file(res, path.join(this.webDir, url.pathname.slice(1)));
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const name = url.pathname.slice('/assets/'.length);
      return Object.hasOwn(this.assets, name) ? this.#file(res, this.assets[name]) : this.#json(res, 404, { ok: false, error: 'Not here.' });
    }
    // The rest is the page talking to its own computer: another page in the same browser may not.
    if (url.pathname.startsWith('/api/') && !fromOurPage(req)) return this.#json(res, 403, { ok: false, error: 'That page is not this computer\'s.' });
    if (req.method === 'POST' && !/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) return this.#json(res, 415, { ok: false, error: 'Expected JSON.' });

    if (route === 'POST /api/pair') return this.#pair(req, res);

    const device = this.#device(req);
    if (!device) return this.#json(res, 401, { ok: false, error: 'Not paired.' });

    if (route === 'GET /api/me') {
      // The cookie is set again on every visit, so a phone in use is never asked for a code because a year went by.
      const token = cookies(req)[COOKIE];
      return this.#json(res, 200, { ok: true, device: { id: device.id, name: device.name }, computer: this.#computer(), version: this.version }, { 'set-cookie': this.#cookie(token) });
    }
    if (route === 'GET /api/sessions') return this.#json(res, 200, { ok: true, sessions: this.#list() });
    if (route === 'POST /api/logout') {
      this.revoke(device.id);
      return this.#json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    return this.#json(res, 404, { ok: false, error: 'Not here.' });
  }

  #cookie(token) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
  }

  async #pair(req, res) {
    const body = await this.#body(req);
    if (body === TOO_BIG) {
      this.#json(res, 413, { ok: false, error: 'That is too much to be a code.' });
      req.destroy();
      return;
    }
    if (!body) return this.#json(res, 400, { ok: false, error: 'Could not read that.' });
    this.#expirePairing();
    const pairing = this.pairing;
    const from = String(req.socket?.remoteAddress ?? '?');
    const ua = String(req.headers['user-agent'] ?? '');
    if (!pairing) return this.#json(res, 403, { ok: false, error: 'No code is waiting. In Smart Terminal, open Remote and press "Pair a phone".' });
    const given = String(body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Used once already: the same phone may use it again from its home-screen copy, which has a cookie jar of its own.
    if (pairing.spentAt) {
      const again = same(given, pairing.code) && this.now() - pairing.spentAt < CODE_REUSE_MS && ua === pairing.spentUa;
      if (!again) return this.#json(res, 403, { ok: false, error: 'No code is waiting. In Smart Terminal, open Remote and press "Pair a phone".' });
      return this.#admit(req, res, body, pairing.spentBy);
    }
    // Wrong codes are counted per address: a stranger guessing does not spend the code the person is typing.
    const tries = pairing.tries.get(from) ?? { count: 0, notBefore: 0 };
    if (tries.count >= CODE_TRIES) return this.#json(res, 403, { ok: false, error: 'Too many wrong codes from this device. Ask Smart Terminal for a new one.' });
    if (this.now() < tries.notBefore) return this.#json(res, 429, { ok: false, error: 'Wait a second, then try again.' });
    if (!same(given, pairing.code)) {
      tries.count += 1;
      tries.notBefore = this.now() + WRONG_CODE_DELAY_MS;
      pairing.tries.set(from, tries);
      this.log(`remote: a wrong pairing code from ${from} (${tries.count} of ${CODE_TRIES})`);
      if (tries.count >= CODE_TRIES) {
        this.changed();
        return this.#json(res, 403, { ok: false, error: 'Too many wrong codes from this device. Ask Smart Terminal for a new one.' });
      }
      return this.#json(res, 403, { ok: false, error: `That is not the code. ${CODE_TRIES - tries.count} ${CODE_TRIES - tries.count === 1 ? 'try' : 'tries'} left.` });
    }
    pairing.spentAt = this.now();
    pairing.spentUa = ua;
    clearTimeout(this.pairingTimer);
    this.pairingTimer = setTimeout(() => { if (this.pairing === pairing) this.pairing = null; }, CODE_REUSE_MS);
    this.pairingTimer.unref?.();
    return this.#admit(req, res, body, null);
  }

  /** The phone is in: a token of its own, and a place in the list — or its old place, when it was paired here before. */
  #admit(req, res, body, reuseId) {
    const token = crypto.randomBytes(32).toString('base64url');
    // Paired again from the same browser (another address of this computer, say): the same phone, not a new row.
    const known = reuseId ? this.state.devices.find((d) => d.id === reuseId) : this.#device(req);
    const name = deviceName(req.headers['user-agent'], body.name, body.standalone === true);
    let device;
    if (known) {
      device = { ...known, tokenHash: sha(token), lastSeenAt: this.now(), name: cleanName(body.name) || known.name };
      this.save({ devices: this.state.devices.map((d) => (d.id === known.id ? device : d)) });
    } else {
      device = { id: crypto.randomBytes(6).toString('hex'), name, tokenHash: sha(token), pairedAt: this.now(), lastSeenAt: this.now() };
      this.save({ devices: [...this.state.devices, device] });
    }
    if (this.pairing && !this.pairing.spentBy) this.pairing.spentBy = device.id;
    this.notify('Phone paired', `${device.name} can now open your sessions. Forget it in Remote if that was not you.`);
    this.log(`remote: paired ${device.name} from ${req.socket?.remoteAddress ?? '?'}`);
    this.changed();
    return this.#json(res, 200, { ok: true, device: { id: device.id, name: device.name }, computer: this.#computer(), version: this.version }, { 'set-cookie': this.#cookie(token) });
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
    // The http server let go of this socket: an error with nobody listening would take the app down.
    socket.on('error', () => socket.destroy());
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
    if (!hostIsOurs(req.headers.host, this.hostname(), this.tailscale?.last?.name)) return refuse(socket, 421, 'That name is not this computer\'s.');
    if (url.pathname !== '/api/terminal') return refuse(socket, 404, 'Not here.');
    // A page from somewhere else cannot open a session with the cookie the browser would attach.
    if (!fromOurPage(req)) return refuse(socket, 403, 'That page is not this computer\'s.');
    const device = this.#device(req);
    if (!device) return refuse(socket, 401, 'Not paired.');
    if (this.channels.size >= MAX_VIEWERS) return refuse(socket, 403, 'Too many sessions open on phones already.');
    // One phone with too many open: its oldest makes room, rather than the other phone being locked out.
    const mine = [...this.channels.values()].filter((c) => c.deviceId === device.id).sort((a, b) => a.at - b.at);
    while (mine.length >= MAX_VIEWERS_PER_DEVICE) this.#end(mine.shift(), 'Closed to make room: this phone had too many open.');
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
    const c = { ch, conn, sessionId, ptyId: found.ptyId, kind, title, from: device.name, deviceId: device.id, at: this.now(), redrawTimer: null, budget: INPUT_PER_SECOND, budgetAt: this.now() };
    const appSize = { cols: Number(found.cols) || 80, rows: Number(found.rows) || 24 };
    // The app's size is what it was before any phone touched it; a redraw in flight must not be mistaken for it.
    if (!this.driven.has(found.ptyId) && !this.appSizes.has(found.ptyId)) this.appSizes.set(found.ptyId, appSize);
    this.channels.set(ch, c);
    // The phone that drove this and dropped a moment ago is back: it carries on where it was, no redraw.
    const d = this.driven.get(found.ptyId);
    let driven = false;
    let size = this.appSizes.get(found.ptyId) ?? appSize;
    if (d) {
      if (d.timer && d.deviceId === device.id) {
        clearTimeout(d.timer);
        this.driven.set(found.ptyId, { ch, deviceId: device.id, from: device.name, timer: null });
        size = this.phoneSizes.get(found.ptyId) ?? size;
      } else {
        // Another phone already has it at its size: this one starts there, and follows.
        driven = true;
        size = this.phoneSizes.get(found.ptyId) ?? size;
      }
    }
    // A full-screen program draws itself for the size it has; a replay made for another width would only be a mess.
    const replay = kind === 'claude' ? '' : found.replay ?? '';
    this.#send(c, { t: 'opened', cols: size.cols, rows: size.rows, title, kind, replay, driven, resumed: this.driven.get(found.ptyId)?.ch === ch });
    // A full-screen program draws itself again when asked. Asked a moment later, so a phone that sizes it first is not undone.
    if (kind === 'claude') {
      c.redrawTimer = setTimeout(() => {
        c.redrawTimer = null;
        if (this.channels.get(ch) === c) this.redraw(found.ptyId);
      }, REDRAW_AFTER_MS);
    }
    const key = `${device.id}/${sessionId}`;
    for (const [k, at] of this.notified) if (this.now() - at > NOTIFY_EVERY_MS) this.notified.delete(k);
    if (this.now() - (this.notified.get(key) ?? 0) > NOTIFY_EVERY_MS) {
      this.notified.set(key, this.now());
      this.notify('Open on your phone', `${title} is open on ${device.name}. What is typed there is typed here; the session may take the phone's width.`);
    }
    this.log(`remote: ${title} opened from ${device.name}`);
    this.changed();

    conn.on('message', (text) => {
      try {
        const m = parse(text);
        if (!m) return;
        if (m.t === 'in') {
          if (typeof m.data !== 'string' || m.data.length > MAX_INPUT) return;
          // So much typing per second that no person is doing it: the channel is closed, not the session flooded.
          const now = this.now();
          c.budget = Math.min(INPUT_PER_SECOND, c.budget + ((now - c.budgetAt) / 1000) * INPUT_PER_SECOND);
          c.budgetAt = now;
          c.budget -= Buffer.byteLength(m.data);
          if (c.budget < 0) {
            this.log(`remote: ${device.name} typed faster than a person could; closed`);
            this.#end(c, 'Too much input at once.');
            return;
          }
          this.write(c.ptyId, m.data);
        } else if (m.t === 'resize') {
          if (m.release) this.#giveBack(c);
          else this.#take(c, m.cols, m.rows);
        } else if (m.t === 'ping') {
          this.#send(c, { t: 'pong' });
        }
      } catch (error) {
        this.log(`remote: from ${device.name}: ${error?.stack ?? error}`);
      }
    });
    conn.on('close', () => {
      if (this.channels.get(ch) !== c) return;
      clearTimeout(c.redrawTimer);
      this.channels.delete(ch);
      this.#dropped(c);
      this.changed();
    });
  }

  /**
   * A phone's size for the session: readable there. The first phone to ask
   * gets it; a second is told the size the first one set, and follows it.
   */
  #take(c, cols, rows) {
    const size = { cols: Math.max(20, Math.min(400, Number(cols) | 0)), rows: Math.max(5, Math.min(200, Number(rows) | 0)) };
    const d = this.driven.get(c.ptyId);
    if (d && d.ch !== c.ch && !d.timer && this.channels.has(d.ch)) {
      const current = this.phoneSizes.get(c.ptyId);
      if (current) this.#send(c, { t: 'size', ...current, driven: true });
      return;
    }
    // Sized by the phone now: the redraw that was coming is not needed, the new size brings one.
    clearTimeout(c.redrawTimer);
    c.redrawTimer = null;
    if (d?.timer) clearTimeout(d.timer);
    const first = !d || d.ch !== c.ch;
    this.driven.set(c.ptyId, { ch: c.ch, deviceId: c.deviceId, from: c.from, timer: null });
    const before = this.phoneSizes.get(c.ptyId);
    this.phoneSizes.set(c.ptyId, size);
    if (!before || before.cols !== size.cols || before.rows !== size.rows) this.resize(c.ptyId, size.cols, size.rows);
    for (const o of this.channels.values()) if (o.ptyId === c.ptyId && o.ch !== c.ch) this.#send(o, { t: 'size', ...size, driven: true });
    if (first) this.drivenChanged(c.ptyId, c.from);
  }

  /** The driving phone's connection went: its size is kept a moment, in case it is back; then given back. */
  #dropped(c) {
    const d = this.driven.get(c.ptyId);
    if (!d || d.ch !== c.ch) return;
    d.timer = setTimeout(() => {
      if (this.driven.get(c.ptyId) === d) this.#giveBack(c, true);
    }, this.driveGraceMs);
    d.timer.unref?.();
  }

  /** Back to the app's size, if this phone was the one that changed it. */
  #giveBack(c, force = false) {
    const d = this.driven.get(c.ptyId);
    if (!d || (d.ch !== c.ch && !force)) return;
    clearTimeout(d.timer);
    this.driven.delete(c.ptyId);
    this.phoneSizes.delete(c.ptyId);
    const size = this.appSizes.get(c.ptyId);
    this.drivenChanged(c.ptyId, null);
    if (!size) return;
    this.resize(c.ptyId, size.cols, size.rows);
    for (const o of this.channels.values()) if (o.ptyId === c.ptyId) this.#send(o, { t: 'size', ...size, driven: false });
  }

  #end(c, reason) {
    clearTimeout(c.redrawTimer);
    this.channels.delete(c.ch);
    this.#send(c, { t: 'ended', reason });
    c.conn.close(1000);
    const d = this.driven.get(c.ptyId);
    if (d && d.ch === c.ch) this.#giveBack(c);
  }

  #send(c, m) {
    if (c.conn.open) c.conn.send(JSON.stringify(m));
  }
}

const TOO_BIG = Symbol('too big');

module.exports = { RemoteServer, RecentOutput, DEFAULT_PORT, COOKIE, hostIsOurs, cookies, urlOf, cleanName, fromOurPage };
