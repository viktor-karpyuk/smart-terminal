'use strict';

/**
 * Just enough of WebSocket (RFC 6455) for the terminal relay, with no
 * dependencies: the handshake, text and binary frames, fragments, ping and
 * close. Clients must mask what they send; a message is at most 1 MB.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    this.partsSize = 0;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#read(chunk));
    socket.on('close', () => this.#gone());
    socket.on('error', () => this.#gone());
    // Proxies drop a connection that says nothing for a minute; this keeps it talking.
    this.alive = true;
    this.pinger = setInterval(() => {
      if (!this.alive) return this.terminate();
      this.alive = false;
      this.#frame(0x9, Buffer.alloc(0));
    }, 25_000);
    this.pinger.unref?.();
  }

  send(text) {
    if (this.open) this.#frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const why = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const body = Buffer.alloc(2 + why.length);
    body.writeUInt16BE(code, 0);
    why.copy(body, 2);
    this.#frame(0x8, body);
    this.open = false;
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
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
    this.alive = true;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
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
      if (b.length < at + 4 + length) return;
      const mask = b.subarray(at, at + 4);
      const payload = Buffer.from(b.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(at + 4 + length);

      if (opcode === 0x8) {
        if (this.open) this.close(1000);
        return this.socket.end();
      }
      if (opcode === 0x9) { this.#frame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) return this.close(1002, 'Unknown frame.');
      this.parts.push(payload);
      this.partsSize += payload.length;
      if (this.partsSize > MAX_MESSAGE) return this.close(1009, 'Too large.');
      if (!fin) continue;
      const whole = Buffer.concat(this.parts);
      this.parts = [];
      this.partsSize = 0;
      this.emit('message', whole.toString('utf8'));
    }
  }
}

/** Answer an HTTP upgrade, or refuse it with a status. Returns the connection, or null. */
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    refuse(socket, 400, 'Expected a WebSocket.');
    return null;
  }
  const answer = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`);
  return new Conn(socket);
}

function refuse(socket, status, message) {
  const body = JSON.stringify({ ok: false, error: message });
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request'}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

module.exports = { accept, refuse, Conn };
