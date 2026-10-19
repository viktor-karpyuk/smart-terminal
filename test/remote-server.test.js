'use strict';

/**
 * The phone's server, end to end over real sockets on a port of its own:
 * pairing, the cookie, the list, a terminal over a WebSocket, and the two
 * directions of a size. Every pty here is a fake that records what it is told.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const { RemoteServer, RecentOutput } = require('../electron/remote-server');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remote-'));
}

/** A server on a free port, with a settings file that already says "on". */
function make(overrides = {}) {
  const dir = tmp();
  const file = path.join(dir, 'remote.json');
  const webDir = path.join(dir, 'web');
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, port: 0, devices: [] }));
  const calls = { written: [], resized: [], notified: [], redrawn: [] };
  let now = 1_000_000;
  const server = new RemoteServer({
    file,
    webDir,
    assets: {},
    sessions: () => [{ id: 's1', title: 'jenkins', kind: 'claude', cwd: '/home/v/dev/app' }, { id: 's2', title: 'sh', kind: 'shell', cwd: '/tmp' }],
    attach: (id) => (id === 's1' ? { ptyId: 'p1', cols: 120, rows: 40, kind: 'claude', title: 'jenkins', replay: 'hello\n' } : null),
    write: (ptyId, data) => calls.written.push([ptyId, data]),
    resize: (ptyId, cols, rows) => calls.resized.push([ptyId, cols, rows]),
    redraw: (ptyId) => calls.redrawn.push(ptyId),
    describe: () => 'stopped, waiting on the user',
    notify: (title, body) => calls.notified.push([title, body]),
    hostname: () => 'viktors-mac.local',
    interfaces: () => ({ en0: [{ family: 'IPv4', internal: false, address: '192.168.1.75' }, { family: 'IPv6', internal: false, address: '::1' }] }),
    now: () => now,
    ...overrides,
  });
  // Port 0 in the file means "any free one": the server reads it back from the socket.
  server.state.port = 0;
  return { server, calls, file, tick: (ms) => { now += ms; }, listen: () => new Promise((resolve) => { server.start(); server.server.once('listening', resolve); }) };
}

async function call(server, method, pathname, { body, cookie } = {}) {
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${server.port}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') };
}

async function pair(server, name = 'iPhone') {
  server.newPairingCode();
  const r = await call(server, 'POST', '/api/pair', { body: { code: server.pairing.code, name } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.cookie.split(';')[0];
}

/** A WebSocket client by hand: enough to open a terminal and talk JSON over it. */
function wsClient(server, pathname, cookie, { origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const messages = [];
    const waiting = [];
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const client = {
      send(value) {
        const payload = Buffer.from(JSON.stringify(value));
        const mask = crypto.randomBytes(4);
        const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([payload.length >> 8, payload.length & 0xff])]);
        const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
        socket.write(Buffer.concat([head, mask, masked]));
      },
      next() {
        if (messages.length) return Promise.resolve(messages.shift());
        return new Promise((res) => waiting.push(res));
      },
      close() { socket.destroy(); },
      closed: new Promise((res) => socket.on('close', res)),
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
        resolve(client);
      }
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let at = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); at = 4; } else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); at = 10; }
        if (buffer.length < at + length) return;
        const payload = buffer.subarray(at, at + length);
        buffer = buffer.subarray(at + length);
        if (opcode === 0x1) {
          const m = JSON.parse(payload.toString());
          if (waiting.length) waiting.shift()(m); else messages.push(m);
        }
      }
    });
    socket.on('connect', () => {
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}${origin ? `Origin: ${origin}\r\n` : ''}\r\n`);
    });
    socket.on('error', reject);
  });
}

test('off by default, and nothing is served until it is turned on', () => {
  const dir = tmp();
  const server = new RemoteServer({ file: path.join(dir, 'remote.json'), webDir: dir, sessions: () => [], attach: () => null, write: () => {} });
  assert.equal(server.state.enabled, false);
  assert.equal(server.running, false);
  assert.deepEqual(server.addresses(), []);
  server.start();
  assert.equal(server.running, false, 'start() does nothing while it is off');
});

test('turned on: it listens, names its addresses, and the settings survive', async () => {
  const { server, file, listen } = make();
  await listen();
  assert.ok(server.running);
  assert.deepEqual(server.addresses(), [`http://viktors-mac.local:${server.port}/`, `http://192.168.1.75:${server.port}/`]);
  const page = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>t<\/title>/);
  const o = server.overview();
  assert.equal(o.running, true);
  assert.deepEqual(o.devices, []);
  server.stop();
  assert.equal(server.running, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, true, 'stopping is not turning off');
});

test('without a cookie nothing but the page is served', async () => {
  const { server, listen } = make();
  await listen();
  assert.equal((await call(server, 'GET', '/api/sessions')).status, 401);
  assert.equal((await call(server, 'GET', '/api/me')).status, 401);
  await assert.rejects(wsClient(server, '/api/terminal?session=s1'), /401/);
  server.stop();
});

test('pairing: the code once, wrong codes counted, and the cookie it leaves', async () => {
  const { server, calls, listen, tick } = make();
  await listen();
  assert.equal((await call(server, 'POST', '/api/pair', { body: { code: 'ABCDEF' } })).status, 403, 'no code waiting');

  server.newPairingCode();
  const { code } = server.overview().pairing;
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  const wrong = await call(server, 'POST', '/api/pair', { body: { code: 'ZZZZZZ' } });
  assert.equal(wrong.status, 403);
  assert.ok(server.pairing, 'one wrong try does not spend the code');

  // Lower case and a dash are forgiven: the person is typing on a phone.
  const right = await call(server, 'POST', '/api/pair', { body: { code: `${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`, name: 'Viktor iPhone' } });
  assert.equal(right.status, 200);
  assert.equal(right.body.computer, 'viktors-mac');
  assert.match(right.cookie, /^st_device=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict/);
  assert.equal(server.pairing, null, 'used once');
  assert.deepEqual(calls.notified, [['Phone paired', 'Viktor iPhone can now open your sessions.']]);

  const cookie = right.cookie.split(';')[0];
  const me = await call(server, 'GET', '/api/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.device.name, 'Viktor iPhone');
  assert.equal(server.overview().devices.length, 1);
  assert.ok(!JSON.stringify(server.state).includes(cookie.split('=')[1]), 'the token is kept only as a hash');

  // Five wrong tries throw the code away.
  server.newPairingCode();
  for (let i = 0; i < 5; i += 1) await call(server, 'POST', '/api/pair', { body: { code: 'ZZZZZZ' } });
  assert.equal(server.pairing, null);

  // And a code expires.
  server.newPairingCode();
  tick(11 * 60 * 1000);
  assert.equal(server.overview().pairing, null);
  assert.equal((await call(server, 'POST', '/api/pair', { body: { code: 'ABCDEF' } })).status, 403);
  server.stop();
});

test('the list says what each session is doing', async () => {
  const { server, listen } = make();
  await listen();
  const cookie = await pair(server);
  const r = await call(server, 'GET', '/api/sessions', { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sessions, [
    { id: 's1', title: 'jenkins', kind: 'claude', folder: 'app', state: 'stopped, waiting on the user', open: false },
    { id: 's2', title: 'sh', kind: 'shell', folder: 'tmp', state: 'shell', open: false },
  ]);
  server.stop();
});

test('a terminal: replay, typing, output, the phone taking the size and giving it back', async () => {
  const { server, calls, listen } = make();
  await listen();
  const cookie = await pair(server, 'iPhone');
  const ws = await wsClient(server, '/api/terminal?session=s1', cookie);
  assert.deepEqual(await ws.next(), { t: 'opened', cols: 120, rows: 40, title: 'jenkins', replay: 'hello\n' });
  assert.deepEqual(calls.redrawn, ['p1'], 'Claude is asked to draw itself again');
  assert.deepEqual(calls.notified.at(-1), ['Opened on your phone', 'jenkins, from iPhone. Typing there types here.']);
  assert.equal(server.overview().viewers.length, 1);
  assert.equal((await call(server, 'GET', '/api/sessions', { cookie })).body.sessions[0].open, true);

  ws.send({ t: 'in', data: 'ls\r' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.written, [['p1', 'ls\r']]);

  server.output('p1', 'file.txt\r\n');
  assert.deepEqual(await ws.next(), { t: 'out', data: 'file.txt\r\n' });
  server.output('p2', 'not mine');

  // The phone takes the width; the app's own resize is kept, not sent.
  ws.send({ t: 'resize', cols: 48, rows: 30 });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.resized, [['p1', 48, 30]]);
  assert.equal(server.drives('p1'), true, 'the app's own resizes wait while the phone has it');
  assert.equal(server.drives('p2'), false);
  server.resized('p1', 130, 42);
  ws.send({ t: 'resize', release: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.resized.at(-1), ['p1', 130, 42], 'back to the size the app gave it meanwhile');
  assert.deepEqual(await ws.next(), { t: 'size', cols: 130, rows: 42 });

  // Not driving any more: the app's sizes reach the phone.
  server.resized('p1', 100, 30);
  assert.deepEqual(await ws.next(), { t: 'size', cols: 100, rows: 30 });

  server.exited('p1');
  assert.deepEqual(await ws.next(), { t: 'ended', reason: 'The session ended.' });
  await ws.closed;
  assert.equal(server.overview().viewers.length, 0);
  server.stop();
});

test('a session that is not there, a page from elsewhere, and closing from the app', async () => {
  const { server, listen } = make();
  await listen();
  const cookie = await pair(server);
  await assert.rejects(wsClient(server, '/api/terminal?session=s1', cookie, { origin: 'http://evil.example' }), /403/, 'a page from another site cannot use the cookie');
  const gone = await wsClient(server, '/api/terminal?session=nope', cookie);
  assert.deepEqual(await gone.next(), { t: 'ended', reason: 'That session is not open any more.' });

  const ws = await wsClient(server, '/api/terminal?session=s1', cookie);
  await ws.next();
  const { ch } = server.overview().viewers[0];
  server.disconnect(ch);
  assert.deepEqual(await ws.next(), { t: 'ended', reason: 'Closed from Smart Terminal.' });
  await ws.closed;

  const again = await wsClient(server, '/api/terminal?session=s1', cookie);
  await again.next();
  server.revoke(server.overview().devices[0].id);
  assert.deepEqual(await again.next(), { t: 'ended', reason: 'This phone was forgotten in Smart Terminal.' });
  assert.equal((await call(server, 'GET', '/api/sessions', { cookie })).status, 401, 'the cookie opens nothing now');
  server.stop();
});

test('logging out forgets the phone', async () => {
  const { server, listen } = make();
  await listen();
  const cookie = await pair(server);
  const r = await call(server, 'POST', '/api/logout', { cookie });
  assert.equal(r.status, 200);
  assert.match(r.cookie, /Max-Age=0/);
  assert.deepEqual(server.overview().devices, []);
  server.stop();
});

test('setPort refuses nonsense and setEnabled off closes what is open', async () => {
  const { server, listen } = make();
  await listen();
  assert.equal(server.setPort(80).ok, false);
  assert.equal(server.setPort(99999).ok, false);
  const cookie = await pair(server);
  const ws = await wsClient(server, '/api/terminal?session=s1', cookie);
  await ws.next();
  server.setEnabled(false);
  assert.deepEqual(await ws.next(), { t: 'ended', reason: 'Remote access was turned off.' });
  assert.equal(server.running, false);
  assert.equal(server.state.enabled, false);
});

test('recent output keeps the tail, cut at a line', () => {
  const recent = new RecentOutput(10);
  recent.add('p', 'abc\ndefgh\nij');
  assert.equal(recent.get('p'), 'defgh\nij');
  recent.add('p', 'klmnopqrstuvwxyz');
  assert.equal(recent.get('p'), 'qrstuvwxyz');
  recent.forget('p');
  assert.equal(recent.get('p'), '');
});
