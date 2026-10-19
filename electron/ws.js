'use strict';

/**
 * Just enough of WebSocket (RFC 6455) for the phone's terminal, with no
 * dependencies: the handshake, text and binary frames, fragments, ping and
 * close. Clients must mask what they send; a message is at most 1 MB.
 *
 * A slow reader is cut off rather than buffered without end: a phone on weak
 * Wi-Fi watching a build log would otherwise make the main process hold the
 * whole log in the socket's queue. And a peer that misbehaves is closed with
 * the code the standard gives for it, so a strict client knows why.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;
/** How much may wait in the socket for a reader that is not keeping up. */
const MAX_BACKLOG = 4 * 1024 * 1024;
/** After a close frame is sent, this long for it to go out before the socket is dropped. */
const CLOSE_GRACE_MS = 300;

const utf8 = new TextDecoder('utf-8', { fatal: true });

class Conn extends EventEmitter {
  /**
   * @param socket the TCP socket, after the 101
   * @param head   bytes that arrived with the handshake, if any: read once the caller has wired its listeners
   */
  constructor(socket, head = null) {
    super();
    this.socket = socket;
    this.open = true;
    this.closed = false;
    /** Chunks not yet parsed, joined only when a whole frame may be in them: a frame that trickles in is not copied per byte. */
    this.chunks = [];
    this.pending = 0;
    this.parts = [];
    this.partsSize = 0;
    this.partsBinary = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#read(chunk));
    socket.on('close', () => this.#gone());
    // An http server's sockets allow half-open: a peer that just went away would otherwise linger until the next ping.
    socket.on('end', () => this.terminate());
    socket.on('error', () => this.#gone());
    // Proxies drop a connection that says nothing for a minute; this keeps it talking.
    this.alive = true;
    this.pinger = setInterval(() => {
      if (!this.alive) return this.terminate();
      this.alive = false;
      this.#frame(0x9, Buffer.alloc(0));
    }, 25_000);
    this.pinger.unref?.();
    if (head?.length) process.nextTick(() => this.#read(head));
  }

  send(text) {
    if (!this.open) return;
    if (this.socket.writableLength > MAX_BACKLOG) {
      // Far behind: nothing more can be delivered, so the socket is dropped rather than a close frame queued behind the backlog.
      this.terminate();
      return;
    }
    this.#frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  /** Say goodbye and go: the close frame is written, and the socket dropped once it is out or soon after. */
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const why = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const body = Buffer.alloc(2 + why.length);
    body.writeUInt16BE(code, 0);
    why.copy(body, 2);
    this.#frame(0x8, body);
    this.open = false;
    clearInterval(this.pinger);
    this.chunks = [];
    this.pending = 0;
    const drop = () => this.terminate();
    const timer = setTimeout(drop, CLOSE_GRACE_MS);
    timer.unref?.();
    if (this.socket.writableLength === 0) drop();
    else this.socket.once('drain', drop);
  }

  terminate() {
    this.socket.destroy();
    this.#gone();
  }

  #gone() {
    clearInterval(this.pinger);
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
  }

  #frame(opcode, payload) {
    let head;
    if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
    else if (payload.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 126;
      head.writeUInt16BE(payload.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    if (!this.socket.destroyed) this.socket.write(Buffer.concat([head, payload]));
  }

  #read(chunk) {
    // Once a close has been sent, nothing that still arrives is anybody's business.
    if (!this.open) return;
    this.alive = true;
    this.chunks.push(chunk);
    this.pending += chunk.length;
    // More than a frame can ever be, still not a frame: not a client worth reading.
    if (this.pending > MAX_MESSAGE + 14) return this.close(1009, 'Too large.');
    for (;;) {
      if (!this.open) return;
      if (this.pending < 2) return;
      const b = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [b];
      const fin = (b[0] & 0x80) !== 0;
      if (b[0] & 0x70) return this.close(1002, 'Reserved bits set.');
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let length = b[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'Too large.');
        length = Number(big);
        at = 10;
      }
      if (!masked) return this.close(1002, 'Frames from a client must be masked.');
      if (length > MAX_MESSAGE) return this.close(1009, 'Too large.');
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) return this.close(1002, 'A control frame has to be short and whole.');
      if (b.length < at + 4 + length) return;
      const mask = b.subarray(at, at + 4);
      const payload = Buffer.from(b.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      const rest = b.subarray(at + 4 + length);
      this.chunks = rest.length ? [rest] : [];
      this.pending = rest.length;

      if (opcode === 0x8) {
        // Answered with the code the peer gave, as the standard asks; a one-byte body is not a code.
        if (length === 1) return this.close(1002, 'A close frame carries two bytes or none.');
        const code = length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.close(code >= 1000 && code !== 1005 && code !== 1006 ? code : 1000);
        return;
      }
      if (opcode === 0x9) { this.#frame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) return this.close(1002, 'Unknown frame.');
      if (opcode === 0x0 && !this.parts.length) return this.close(1002, 'A continuation with nothing to continue.');
      if (opcode !== 0x0 && this.parts.length) return this.close(1002, 'A new message inside an unfinished one.');
      if (opcode !== 0x0) this.partsBinary = opcode === 0x2;
      this.parts.push(payload);
      this.partsSize += payload.length;
      if (this.partsSize > MAX_MESSAGE) return this.close(1009, 'Too large.');
      if (!fin) continue;
      const whole = Buffer.concat(this.parts);
      this.parts = [];
      this.partsSize = 0;
      if (this.partsBinary) {
        this.emit('binary', whole);
        continue;
      }
      let text;
      try {
        text = utf8.decode(whole);
      } catch {
        return this.close(1007, 'Not UTF-8.');
      }
      this.emit('message', text);
    }
  }
}

/** Answer an HTTP upgrade, or refuse it with a status. Returns the connection, or null. */
function accept(req, socket, head = null) {
  const key = req.headers['sec-websocket-key'];
  const connection = String(req.headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim());
  if (req.method !== 'GET' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !connection.includes('upgrade') || !key || req.headers['sec-websocket-version'] !== '13') {
    refuse(socket, 400, 'Expected a WebSocket.');
    return null;
  }
  const answer = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`);
  return new Conn(socket, head);
}

/**
 * Say no to an upgrade. The http server has let go of the socket by now, so an
 * error from a peer that already left would have nobody listening — and an
 * error nobody listens to takes the whole process down.
 */
function refuse(socket, status, message) {
  socket.on('error', () => socket.destroy());
  const body = JSON.stringify({ ok: false, error: message });
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 413: 'Payload Too Large', 421: 'Misdirected Request', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable' }[status] ?? 'Bad Request';
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

module.exports = { accept, refuse, Conn, MAX_BACKLOG, MAX_MESSAGE };
