'use strict';

/** The hand-written WebSocket: what it accepts, what it refuses, and the codes it says so with. */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const { accept } = require('../electron/ws');

/** A server that upgrades everything and hands the connection to the test. */
function serve(onConn) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end('no'));
    server.on('upgrade', (req, socket, head) => {
      const conn = accept(req, socket, head);
      if (conn) onConn(conn);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
  });
}

function frame(opcode, payload, { fin = true, mask = true, rsv = 0 } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = [(fin ? 0x80 : 0) | (rsv << 4) | opcode];
  const len = body.length;
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else if (len < 65536) head.push((mask ? 0x80 : 0) | 126, len >> 8, len & 0xff);
  else {
    const big = Buffer.alloc(8); big.writeBigUInt64BE(BigInt(len));
    head.push((mask ? 0x80 : 0) | 127, ...big);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), body]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(body.map((b, i) => b ^ key[i & 3]));
  return Buffer.concat([Buffer.from(head), key, masked]);
}

/** A raw client: the handshake, then whatever bytes the test wants to send, and the frames that come back. */
function client(port, { extra = Buffer.alloc(0), headers = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const frames = [];
    const waiting = [];
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const read = () => {
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let at = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); at = 4; }
        if (buffer.length < at + length) return;
        const payload = buffer.subarray(at, at + length);
        buffer = buffer.subarray(at + length);
        const f = { opcode, payload: Buffer.from(payload) };
        if (waiting.length) waiting.shift()(f); else frames.push(f);
      }
    };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error(head.split('\r\n')[0]));
        upgraded = true;
        resolve(api);
      }
      read();
    });
    const api = {
      write: (bytes) => socket.write(bytes),
      next: () => (frames.length ? Promise.resolve(frames.shift()) : new Promise((r) => waiting.push(r))),
      closed: new Promise((r) => socket.on('close', r)),
      end: () => socket.destroy(),
    };
    socket.on('connect', () => {
      socket.write(Buffer.concat([Buffer.from(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`), extra]));
    });
    socket.on('error', reject);
  });
}

const closeCode = (f) => (f.opcode === 0x8 && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null);

test('a text message, fragments, and a ping answered', async () => {
  const got = [];
  const { port, close } = await serve((conn) => conn.on('message', (m) => { got.push(m); conn.send(`echo ${m}`); }));
  const c = await client(port);
  c.write(frame(0x1, 'hello'));
  assert.deepEqual((await c.next()).payload.toString(), 'echo hello');
  c.write(Buffer.concat([frame(0x1, 'two ', { fin: false }), frame(0x0, 'parts')]));
  assert.deepEqual((await c.next()).payload.toString(), 'echo two parts');
  c.write(frame(0x9, 'hi'));
  const pong = await c.next();
  assert.equal(pong.opcode, 0xa);
  assert.equal(pong.payload.toString(), 'hi');
  assert.deepEqual(got, ['hello', 'two parts']);
  c.end();
  await close();
});

test('bytes that came with the handshake are a message too, once the listener is on', async () => {
  const got = [];
  const { port, close } = await serve((conn) => conn.on('message', (m) => got.push(m)));
  const c = await client(port, { extra: frame(0x1, 'early') });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(got, ['early']);
  c.end();
  await close();
});

test('what is refused, and the code it is refused with', async () => {
  const { port, close } = await serve(() => {});
  const cases = [
    ['reserved bits', frame(0x1, 'x', { rsv: 4 }), 1002],
    ['unmasked', frame(0x1, 'x', { mask: false }), 1002],
    ['not UTF-8', frame(0x1, Buffer.from([0xff, 0xfe])), 1007],
    ['a continuation with nothing to continue', frame(0x0, 'x'), 1002],
    ['a one-byte close', frame(0x8, Buffer.from([1])), 1002],
    ['a fragmented control frame', frame(0x9, 'x', { fin: false }), 1002],
    ['an unknown opcode', frame(0x3, 'x'), 1002],
  ];
  for (const [what, bytes, code] of cases) {
    const c = await client(port);
    c.write(bytes);
    const f = await c.next();
    assert.equal(closeCode(f), code, what);
    await c.closed;
  }
  await close();
});

test('the peer\'s close code is echoed, and a huge frame is 1009', async () => {
  const { port, close } = await serve(() => {});
  let c = await client(port);
  const body = Buffer.alloc(2); body.writeUInt16BE(1001, 0);
  c.write(frame(0x8, body));
  assert.equal(closeCode(await c.next()), 1001);
  await c.closed;
  // A code a peer may not send comes back as 1002, not echoed.
  c = await client(port);
  body.writeUInt16BE(1005, 0);
  c.write(frame(0x8, body));
  assert.equal(closeCode(await c.next()), 1002);
  await c.closed;
  // A big frame followed by a ping in the same write is fine: two legal frames.
  c = await client(port);
  const big = Buffer.alloc(900 * 1024, 0x61);
  c.write(Buffer.concat([frame(0x1, big), frame(0x9, Buffer.from('hi'))]));
  const pong = await c.next();
  assert.equal(pong.opcode, 0xa, 'the ping is answered');
  c.write(frame(0x8, Buffer.alloc(0)));
  await c.closed;
  c = await client(port);
  const head = Buffer.from([0x81, 0x80 | 127]);
  const len = Buffer.alloc(8); len.writeBigUInt64BE(BigInt(2 * 1024 * 1024));
  c.write(Buffer.concat([head, len, crypto.randomBytes(4)]));
  assert.equal(closeCode(await c.next()), 1009);
  await close();
});

test('a handshake that is not one is refused with 400', async () => {
  const { port, close } = await serve(() => {});
  await assert.rejects(client(port, { headers: 'Sec-WebSocket-Version: 12\r\n' }), /400/);
  await close();
});
