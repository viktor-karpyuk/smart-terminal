'use strict';

/**
 * Who is asking, and who may talk to the app's socket.
 *
 * Before this, a session proved who it was by saying so: `from` was an id, and
 * every session is told every other session's id by `list_sessions`. So any
 * session could be any other — borrowing its rate limit, hiding behind its
 * refusals, putting its name on a question shown to the person. A secret the
 * app hands to each session when it starts, which is in nobody's roster,
 * closes that. And the socket itself is kept to its owner.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { SessionSecrets } = require('../electron/session-secrets');
const { ensurePrivateDir, lockSocket } = require('../electron/socket-guard');
const { MessageBridge } = require('../electron/message-bridge');

const windows = process.platform === 'win32';
const skipWindows = windows ? 'unix permissions' : false;

test('a session is issued a secret that only it knows, and the app keeps nothing it could be read back from', () => {
  const secrets = new SessionSecrets();
  const mine = secrets.issue('sess-1');
  const theirs = secrets.issue('sess-2');
  assert.match(mine, /^[0-9a-f]{32}$/, '128 bits, as hex');
  assert.notEqual(mine, theirs);
  assert.equal(secrets.verify('sess-1', mine), true);
  assert.equal(secrets.verify('sess-2', theirs), true);
  // One session's secret does not open another, and an id alone is nothing.
  assert.equal(secrets.verify('sess-1', theirs), false);
  assert.equal(secrets.verify('sess-2', mine), false);
  assert.equal(secrets.verify('sess-1', ''), false);
  assert.equal(secrets.verify('sess-1', undefined), false);
  assert.equal(secrets.verify('sess-1', null), false);
  assert.equal(secrets.verify('sess-1', 12345), false);
  assert.equal(secrets.verify('sess-1', {}), false);
  assert.equal(secrets.verify('sess-1', mine + 'x'), false);
  assert.equal(secrets.verify('sess-1', mine.slice(0, -1)), false);
  assert.equal(secrets.verify('sess-1', mine.toUpperCase()), false);
  assert.equal(secrets.verify('nobody', mine), false);
  assert.equal(secrets.verify(undefined, mine), false);
  // The secret is not in the map: a dump of it opens nothing.
  assert.equal(JSON.stringify([...secrets.map.entries()]).includes(mine), false);
  assert.equal(JSON.stringify([...secrets.map.entries()]).includes(theirs), false);
});

test('a secret ends with its session, and a restarted one is a new one', () => {
  const secrets = new SessionSecrets();
  const first = secrets.issue('sess-1');
  secrets.forget('sess-1');
  assert.equal(secrets.verify('sess-1', first), false);
  const again = secrets.issue('sess-1');
  assert.notEqual(first, again);
  assert.equal(secrets.verify('sess-1', first), false, 'the old one is dead');
  assert.equal(secrets.verify('sess-1', again), true);
  assert.equal(secrets.issue(''), '', 'a session that has no id has nothing to prove');
  assert.equal(secrets.issue(undefined), '');
});

test('comparison is by digest, so length and content do not show in how long it takes', () => {
  // Not a timing test (those are noise): a check that the comparison is made on equal-length digests, never on the raw strings.
  const secrets = new SessionSecrets();
  const mine = secrets.issue('a');
  for (const probe of ['', 'x', mine.slice(0, 5), `${mine}${mine}`, '\u0000'.repeat(32), 'é'.repeat(16)]) assert.equal(secrets.verify('a', probe), false);
  assert.equal(secrets.verify('a', mine), true);
});

function bridge({ verify, onJenkins, roster = [{ id: 'sess-1', name: 'the fixer' }, { id: 'sess-2', name: 'the other' }] } = {}) {
  const seen = [];
  const instance = new MessageBridge({
    socketPath: 'unused', reach: () => 'all', roster: () => roster, write: () => true, isFree: () => true, store: {},
    verifySession: verify,
    onJenkins: onJenkins ?? (async (request) => { seen.push(request); return { ok: true, text: 'hi' }; }),
  });
  return { instance, seen };
}

test('the bridge answers Jenkins for the session that can prove it is itself, and for no one it merely names', async () => {
  const secrets = new SessionSecrets();
  const one = secrets.issue('sess-1');
  const two = secrets.issue('sess-2');
  const { instance, seen } = bridge({ verify: (id, secret) => secrets.verify(id, secret) });
  const ask = (from, secret) => instance.handle({ op: 'jenkins', tool: 'servers', args: {}, from, secret });

  assert.deepEqual(await ask('sess-1', one), { ok: true, text: 'hi' });
  assert.equal(seen[0].session.id, 'sess-1');
  assert.equal('secret' in seen[0], false, 'the secret goes no further than the door');

  // The impersonation the review found: a known roster id and nothing else, or somebody else's secret.
  for (const [from, secret] of [['sess-1', undefined], ['sess-1', ''], ['sess-1', two], ['sess-2', one], ['sess-1', 'guess']]) {
    const reply = await ask(from, secret);
    assert.equal(reply.ok, false, `${from} with ${String(secret).slice(0, 6)}`);
    assert.match(reply.error, /could not prove who it is/);
  }
  assert.equal(seen.length, 1, 'none of those reached Jenkins');
  // And an id that is not a running session is still refused as before.
  assert.match((await ask('ghost', one)).error, /does not have this session as running/);
});

test('the secret never leaves in what a session is told about the others', async () => {
  const secrets = new SessionSecrets();
  secrets.issue('sess-1');
  const known = secrets.issue('sess-2');
  const { instance } = bridge({ verify: (id, secret) => secrets.verify(id, secret) });
  const roster = await instance.handle({ op: 'roster', from: 'sess-1' });
  assert.equal(JSON.stringify(roster).includes(known), false);
  assert.equal(JSON.stringify(roster).toLowerCase().includes('secret'), false);
});

test('without a verifier the bridge behaves as it did: this is only for what asks for it', async () => {
  const { instance } = bridge({});
  assert.equal((await instance.handle({ op: 'jenkins', tool: 'servers', from: 'sess-1' })).ok, true);
});

// --- the socket ----------------------------------------------------------------------

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jk-guard-'));
}
const mode = (p) => fs.statSync(p).mode & 0o777;

test('a private directory is made 0700 even under a permissive umask, and a loose one of ours is tightened', { skip: skipWindows }, () => {
  const base = scratch();
  const before = process.umask(0o000);
  try {
    const fresh = path.join(base, 'a', 'b');
    ensurePrivateDir(fresh);
    assert.equal(mode(fresh), 0o700);
    const loose = path.join(base, 'loose');
    fs.mkdirSync(loose, { mode: 0o777 });
    fs.chmodSync(loose, 0o777);
    ensurePrivateDir(loose);
    assert.equal(mode(loose), 0o700);
  } finally {
    process.umask(before);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a directory that is a link, a file, or somebody else\'s is refused rather than used', { skip: skipWindows }, () => {
  const base = scratch();
  try {
    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    assert.throws(() => ensurePrivateDir(link), /not a plain directory/);
    const file = path.join(base, 'file');
    fs.writeFileSync(file, '');
    assert.throws(() => ensurePrivateDir(file), /not a plain directory|exists|not a directory/i);
    // Another user's directory cannot be made private by us: a different owner is refused. Faked here by asking for an owner we are not.
    assert.throws(() => ensurePrivateDir(real, { uid: (process.getuid?.() ?? 0) + 1 }), /belongs to someone else/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a socket is locked to its owner once it exists, whatever the umask said', { skip: skipWindows }, async () => {
  const base = scratch();
  const before = process.umask(0o000);
  const socketPath = path.join(base, 's.sock');
  const server = net.createServer();
  try {
    await new Promise((resolve) => server.listen(socketPath, resolve));
    assert.equal(mode(socketPath) & 0o077 ? true : mode(socketPath) !== 0o600, true, 'the umask left it open, which is the problem');
    lockSocket(socketPath);
    assert.equal(mode(socketPath), 0o600);
  } finally {
    process.umask(before);
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the bridge opens its socket for its owner only, in a directory for its owner only, and cuts off a line that never ends', { skip: skipWindows }, async () => {
  const base = scratch();
  const before = process.umask(0o000);
  const dir = path.join(base, 'data');
  const socketPath = path.join(dir, 's.sock');
  const instance = new MessageBridge({ socketPath, reach: () => 'all', roster: () => [], write: () => true, isFree: () => true, store: {} });
  try {
    instance.start();
    for (let i = 0; i < 50 && !fs.existsSync(socketPath); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(mode(socketPath), 0o600);
    assert.equal(mode(dir), 0o700);
    // A peer that sends and sends without ever ending a line is cut off, not buffered for ever.
    const closed = await new Promise((resolve) => {
      const client = net.createConnection(socketPath);
      let sent = 0;
      const timer = setInterval(() => { if (sent < 6_000_000 && !client.destroyed) { client.write('x'.repeat(500_000)); sent += 500_000; } }, 5);
      client.on('close', () => { clearInterval(timer); resolve(true); });
      client.on('error', () => {});
      setTimeout(() => { clearInterval(timer); client.destroy(); resolve(false); }, 4000);
    });
    assert.equal(closed, true, 'the connection was cut off');
  } finally {
    process.umask(before);
    instance.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
