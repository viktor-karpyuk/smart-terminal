'use strict';

/**
 * The terminal relay: a browser reaches a session open in its owner's own
 * Smart Terminal, through this server.
 *
 * Each signed-in app that allows it keeps one WebSocket open to here and says
 * which sessions it has. A browser opens one WebSocket per session it shows;
 * this server passes keystrokes one way and output the other, and keeps none
 * of either. Only the person signed in on that device can open its sessions —
 * not an administrator, not anybody else.
 *
 * Device ↔ server, JSON text frames:
 *   → hello {token}                         ← welcome {} | close 4001
 *   → sessions {list}
 *   ← open {ch, session, from}              → opened {ch, cols, rows, title, replay} | refused {ch, error}
 *   ← in {ch, data}                         → out {ch, data}, size {ch, cols, rows}, ended {ch, reason}
 *   ← resize {ch, cols, rows} | {ch, release}
 *   ← close {ch}
 * Browser ↔ server, for one session:
 *   ← opened / out / size / ended / error   → in {data}, resize {cols, rows} | {release}
 */

const crypto = require('node:crypto');
const { accept, refuse } = require('./ws');

const MAX_CHANNELS_PER_USER = 12;
const MAX_INPUT = 64 * 1024;

function browserName(ua) {
  const s = String(ua ?? '');
  const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'A browser';
  const os = /Mac OS X/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

const parse = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
};

/** A session as the device describes it, kept to what the page shows. */
function cleanSession(s) {
  return {
    id: String(s?.id ?? '').slice(0, 80),
    title: String(s?.title ?? '').slice(0, 120),
    kind: s?.kind === 'claude' ? 'claude' : 'shell',
    folder: String(s?.folder ?? '').slice(0, 200),
    repo: String(s?.repo ?? '').slice(0, 200),
    busy: Boolean(s?.busy),
  };
}

function createRelay({ store, enabled, webUser, sameOrigin, log = () => {} }) {
  /** token id → { id, userId, label, conn, sessions, since } */
  const devices = new Map();
  /** ch → { ch, userId, deviceId, browser, title, at } */
  const channels = new Map();

  const json = (conn, value) => conn?.send(JSON.stringify(value));

  function endChannel(ch, reason, { tellDevice = true, tellBrowser = true } = {}) {
    const c = channels.get(ch);
    if (!c) return;
    channels.delete(ch);
    if (tellDevice) json(devices.get(c.deviceId)?.conn, { t: 'close', ch });
    if (tellBrowser && c.browser.open) {
      json(c.browser, { t: 'ended', reason });
      c.browser.close(1000);
    }
  }

  function device(req, socket) {
    const conn = accept(req, socket);
    if (!conn) return;
    let me = null;
    const timer = setTimeout(() => { if (!me) conn.close(4001, 'Say hello first.'); }, 10_000);
    conn.on('message', (text) => {
      const m = parse(text);
      if (!m) return;
      if (!me) {
        if (m.t !== 'hello') return conn.close(4001, 'Say hello first.');
        const who = store.resolveToken(m.token, 'device');
        if (!who) return conn.close(4001, 'This device is not signed in, or was signed out.');
        if (!enabled()) return conn.close(4003, 'Your company has turned off the terminal in the browser.');
        clearTimeout(timer);
        const old = devices.get(who.token.id);
        if (old) old.conn.close(4000, 'Connected again.');
        me = { id: who.token.id, userId: who.user.id, label: who.token.label || 'A device', conn, sessions: [], since: Date.now() };
        devices.set(me.id, me);
        json(conn, { t: 'welcome' });
        return;
      }
      if (m.t === 'sessions') {
        me.sessions = (Array.isArray(m.list) ? m.list : []).slice(0, 100).map(cleanSession).filter((s) => s.id);
        return;
      }
      const c = channels.get(String(m.ch ?? ''));
      if (!c || c.deviceId !== me.id) return;
      if (m.t === 'opened') {
        json(c.browser, { t: 'opened', cols: Number(m.cols) || 80, rows: Number(m.rows) || 24, title: String(m.title ?? '').slice(0, 120), replay: String(m.replay ?? '') });
      } else if (m.t === 'out') {
        json(c.browser, { t: 'out', data: String(m.data ?? '') });
      } else if (m.t === 'size') {
        json(c.browser, { t: 'size', cols: Number(m.cols) || 80, rows: Number(m.rows) || 24 });
      } else if (m.t === 'refused' || m.t === 'ended') {
        endChannel(c.ch, String(m.error ?? m.reason ?? 'The session closed.').slice(0, 200), { tellDevice: false });
      }
    });
    conn.on('close', () => {
      clearTimeout(timer);
      if (!me || devices.get(me.id)?.conn !== conn) return;
      devices.delete(me.id);
      for (const c of [...channels.values()]) if (c.deviceId === me.id) endChannel(c.ch, 'Smart Terminal on that device went away.', { tellDevice: false });
    });
  }

  function browser(req, socket, url) {
    if (!sameOrigin(req)) return refuse(socket, 403, 'Not from this site.');
    const who = webUser(req);
    if (!who) return refuse(socket, 401, 'Sign in first.');
    if (!enabled()) return refuse(socket, 403, 'Your company has turned off the terminal in the browser.');
    const d = devices.get(String(url.searchParams.get('device') ?? ''));
    // Somebody else's device answers exactly like one that is not connected.
    if (!d || d.userId !== who.user.id) return refuse(socket, 404, 'That device is not connected.');
    const session = d.sessions.find((s) => s.id === url.searchParams.get('session'));
    if (!session) return refuse(socket, 404, 'That session is not open on that device.');
    if ([...channels.values()].filter((c) => c.userId === who.user.id).length >= MAX_CHANNELS_PER_USER) return refuse(socket, 429, 'Too many sessions open in the browser. Close one.');
    const conn = accept(req, socket);
    if (!conn) return;
    const ch = crypto.randomUUID();
    channels.set(ch, { ch, userId: who.user.id, deviceId: d.id, browser: conn, title: session.title, at: Date.now() });
    store.log(who.user.id, 'terminal.opened', d.label, session.title || session.folder || 'a session');
    log(`terminal: ${who.user.email} opened "${session.title}" on ${d.label}`);
    json(d.conn, { t: 'open', ch, session: session.id, from: browserName(req.headers['user-agent']) });
    conn.on('message', (text) => {
      const m = parse(text);
      if (!m || !channels.has(ch)) return;
      const to = devices.get(channels.get(ch).deviceId)?.conn;
      if (m.t === 'in') {
        const data = String(m.data ?? '');
        if (data && data.length <= MAX_INPUT) json(to, { t: 'in', ch, data });
      } else if (m.t === 'resize') {
        // A phone asking for its own width; the app bounds it, and gives it back when it is done.
        json(to, m.release ? { t: 'resize', ch, release: true } : { t: 'resize', ch, cols: Number(m.cols) | 0, rows: Number(m.rows) | 0 });
      }
    });
    conn.on('close', () => endChannel(ch, '', { tellBrowser: false }));
  }

  return {
    /** Wire to `server.on('upgrade')`. */
    upgrade(req, socket) {
      socket.on('error', () => {});
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/api/app/relay') return device(req, socket);
      if (url.pathname === '/api/web/terminal') return browser(req, socket, url);
      return refuse(socket, 404, 'Not found.');
    },
    /** One person's connected devices and their sessions; never anybody else's. */
    devicesOf(userId) {
      return [...devices.values()].filter((d) => d.userId === userId)
        .map((d) => ({ id: d.id, label: d.label, since: d.since, sessions: d.sessions }));
    },
    /** A device signed out or a person disabled: drop what they had open. */
    forgetToken(tokenId) {
      devices.get(tokenId)?.conn.close(4001, 'Signed out.');
    },
    forgetUser(userId) {
      for (const d of devices.values()) if (d.userId === userId) d.conn.close(4001, 'Signed out.');
    },
    turnedOff() {
      for (const d of devices.values()) d.conn.close(4003, 'Your company has turned off the terminal in the browser.');
    },
    stats: () => ({ devices: devices.size, channels: channels.size }),
  };
}

module.exports = { createRelay, browserName };
