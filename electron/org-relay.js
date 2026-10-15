'use strict';

/**
 * This machine's sessions, opened from its owner's browser.
 *
 * When the person allows it, the app keeps one WebSocket open to the company's
 * server and says which sessions it has. When they open one in the browser,
 * the server asks for it here: the app sends what the session printed lately,
 * then everything it prints, and types what comes back into it — exactly as
 * typing in the app does. Nothing is kept on the server.
 *
 * The server only lets the person signed in on this device ask; even so, a
 * session in a never-shared folder is not offered, and every time one is
 * opened the app says so, and can close it.
 *
 * A browser on a phone may ask the session to take its width, so the text is
 * readable there. While it has it open, that size is the session's; when it
 * closes, or gives it back, the session returns to the size the app gave it.
 */

const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60_000;
const OFF_RETRY_MS = 5 * 60_000;

class OrgRelay {
  /**
   * @param sessions  () => [{ id, title, kind, cwd, repo }] — what is open in the app
   * @param attach    (sessionId) => { ptyId, cols, rows, title, kind, replay } | null
   * @param write     (ptyId, data) => void
   * @param isPrivate (cwd) => boolean
   * @param notify    (title, body) => void
   * @param resize    (ptyId, cols, rows) => void — sets the session's size, without the app asking
   */
  constructor({ WebSocketImpl = globalThis.WebSocket, sessions, attach, write, redraw = () => {}, resize = () => {}, isPrivate = () => false, notify = () => {}, changed = () => {}, log = () => {}, now = Date.now }) {
    Object.assign(this, { WebSocketImpl, sessions, attach, write, redraw, resize, isPrivate, notify, changed, log, now });
    this.ws = null;
    this.target = null;
    this.connected = false;
    this.error = null;
    this.retryMs = RETRY_MIN_MS;
    this.retryTimer = null;
    this.listTimer = null;
    this.lastList = '';
    /** ch → { ch, sessionId, ptyId, title, from, at } */
    this.channels = new Map();
    /** ptyId → { cols, rows }: the size the app gave it, to go back to. */
    this.appSizes = new Map();
    /** ptyId → ch: the browser whose size the session has now. */
    this.driven = new Map();
  }

  /** Whether a browser has this session at its own size; the app's resizes then wait. */
  drives(ptyId) {
    return this.driven.has(ptyId);
  }

  /** Connect to this server as this device, or stay connected if already. */
  start(server, token) {
    const url = `${String(server).replace(/^http/, 'ws').replace(/\/+$/, '')}/api/app/relay`;
    if (this.target?.url === url && this.target?.token === token && (this.ws || this.retryTimer)) return;
    this.stop();
    this.target = { url, token };
    this.#connect();
  }

  stop() {
    this.target = null;
    clearTimeout(this.retryTimer);
    clearInterval(this.listTimer);
    this.retryTimer = null;
    this.listTimer = null;
    this.#dropChannels();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000); } catch { /* already closed */ }
    if (this.connected || this.error) {
      this.connected = false;
      this.error = null;
      this.changed();
    }
  }

  status() {
    return {
      connected: this.connected,
      error: this.error,
      viewers: [...this.channels.values()].map(({ ch, title, from, at }) => ({ ch, title, from, at })),
    };
  }

  /** Close one session in the browser, or all of them; the sessions keep running here. */
  disconnect(ch = null) {
    for (const c of [...this.channels.values()]) {
      if (ch && c.ch !== ch) continue;
      this.#send({ t: 'ended', ch: c.ch, reason: 'Closed from Smart Terminal.' });
      this.#remove(c);
    }
    this.changed();
  }

  // --- what the app tells it ----------------------------------------------------
  output(ptyId, data) {
    for (const c of this.channels.values()) if (c.ptyId === ptyId) this.#send({ t: 'out', ch: c.ch, data });
  }

  /** The app gave the session a size. While a browser drives it, it is kept for later. */
  resized(ptyId, cols, rows) {
    this.appSizes.set(ptyId, { cols, rows });
    if (this.driven.has(ptyId)) return;
    for (const c of this.channels.values()) if (c.ptyId === ptyId) this.#send({ t: 'size', ch: c.ch, cols, rows });
  }

  exited(ptyId) {
    let any = false;
    for (const c of [...this.channels.values()]) {
      if (c.ptyId !== ptyId) continue;
      this.#send({ t: 'ended', ch: c.ch, reason: 'The session ended.' });
      this.channels.delete(c.ch);
      any = true;
    }
    this.driven.delete(ptyId);
    this.appSizes.delete(ptyId);
    if (any) this.changed();
    this.#sendList();
  }

  // --- the connection -----------------------------------------------------------
  #connect() {
    this.retryTimer = null;
    if (!this.target) return;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.target.url);
    } catch (error) {
      this.#failed(String(error?.message ?? error));
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: this.target?.token }));
    ws.onmessage = (event) => {
      let m;
      try { m = JSON.parse(String(event.data)); } catch { return; }
      this.#receive(m);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.listTimer);
      this.listTimer = null;
      this.#dropChannels();
      this.connected = false;
      if (event.code === 4001) {
        // Signed out or revoked: trying again cannot work until someone signs in.
        this.error = 'The server did not accept this device. Sign in again.';
        this.target = null;
        this.changed();
        return;
      }
      if (event.code === 4003) {
        this.error = 'Your company has turned off the terminal in the browser.';
        this.changed();
        this.retryTimer = setTimeout(() => this.#connect(), OFF_RETRY_MS);
        return;
      }
      this.#failed('Not connected to the server. Trying again.');
    };
    ws.onerror = () => { /* onclose follows, and says what to do */ };
  }

  #failed(message) {
    this.error = message;
    this.connected = false;
    this.changed();
    if (!this.target) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.#connect(), this.retryMs);
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
  }

  #receive(m) {
    if (m.t === 'welcome') {
      this.connected = true;
      this.error = null;
      this.retryMs = RETRY_MIN_MS;
      this.lastList = '';
      this.#sendList();
      clearInterval(this.listTimer);
      this.listTimer = setInterval(() => this.#sendList(), 3000);
      this.changed();
      return;
    }
    if (m.t === 'open') return this.#open(m);
    const c = this.channels.get(String(m.ch ?? ''));
    if (m.t === 'in' && c) {
      this.write(c.ptyId, String(m.data ?? ''));
    } else if (m.t === 'resize' && c) {
      if (m.release) this.#giveBack(c);
      else this.#take(c, m.cols, m.rows);
    } else if (m.t === 'close' && c) {
      this.#remove(c);
      this.changed();
    }
  }

  #open({ ch, session, from }) {
    const offered = this.#offered().find((s) => s.id === session);
    const found = offered ? this.attach(session) : null;
    if (!found) {
      this.#send({ t: 'refused', ch, error: 'That session is not open, or is in a folder that is never shared.' });
      return;
    }
    const title = found.title || offered.title || 'A session';
    if (!this.driven.has(found.ptyId)) this.appSizes.set(found.ptyId, { cols: found.cols, rows: found.rows });
    this.channels.set(ch, { ch, sessionId: session, ptyId: found.ptyId, title, from: String(from ?? 'A browser'), at: this.now() });
    this.#send({ t: 'opened', ch, cols: found.cols, rows: found.rows, title, replay: found.replay ?? '' });
    // A full-screen program draws itself again when asked; the replay alone can leave it half drawn.
    if (found.kind === 'claude') this.redraw(found.ptyId);
    this.notify('Opened in your browser', `${title}, from ${from}. Typing there types here.`);
    this.log(`relay: ${title} opened from ${from}`);
    this.changed();
  }

  #offered() {
    return this.sessions().filter((s) => !this.isPrivate(s.cwd));
  }

  #sendList() {
    if (!this.connected) return;
    const list = this.#offered().map((s) => ({
      id: s.id,
      title: s.title ?? '',
      kind: s.kind,
      folder: String(s.cwd ?? '').split('/').filter(Boolean).pop() ?? '',
      repo: s.repo ?? '',
    }));
    const text = JSON.stringify(list);
    if (text === this.lastList) return;
    this.lastList = text;
    this.#send({ t: 'sessions', list });
  }

  /** A browser's size for the session: readable on a phone. */
  #take(c, cols, rows) {
    const size = { cols: Math.max(20, Math.min(400, Number(cols) | 0)), rows: Math.max(5, Math.min(200, Number(rows) | 0)) };
    this.driven.set(c.ptyId, c.ch);
    this.resize(c.ptyId, size.cols, size.rows);
    for (const o of this.channels.values()) if (o.ptyId === c.ptyId && o.ch !== c.ch) this.#send({ t: 'size', ch: o.ch, ...size });
  }

  /** Back to the app's size, if this browser was the one that changed it. */
  #giveBack(c) {
    if (this.driven.get(c.ptyId) !== c.ch) return;
    this.driven.delete(c.ptyId);
    const size = this.appSizes.get(c.ptyId);
    if (!size) return;
    this.resize(c.ptyId, size.cols, size.rows);
    for (const o of this.channels.values()) if (o.ptyId === c.ptyId) this.#send({ t: 'size', ch: o.ch, ...size });
  }

  #remove(c) {
    this.channels.delete(c.ch);
    this.#giveBack(c);
  }

  #dropChannels() {
    if (!this.channels.size) return;
    for (const c of [...this.channels.values()]) this.#remove(c);
    this.changed();
  }

  #send(m) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }
}

/**
 * What a session printed lately, so a browser that opens it sees more than a
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

module.exports = { OrgRelay, RecentOutput };
