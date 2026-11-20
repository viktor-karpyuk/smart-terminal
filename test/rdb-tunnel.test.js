'use strict';

/**
 * A database reached through another machine.
 *
 * What is held here is what cannot be seen from the form: that nothing typed
 * in it is ever read by ssh as an option, that a tunnel is one ssh however many
 * callers arrive together, that it goes when what used it goes, and that what
 * ssh says when it fails comes back as something a person can do something about.
 *
 * No ssh is run: the one here is a stand-in that opens the port it was asked for.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const { Tunnels, sshArgs, explainSsh, sshHostOk, sshUserOk } = require('../electron/rdb-tunnel');
const { RdbStore } = require('../electron/rdb-store');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

/** An ssh that forwards nothing and listens where it was told to, or fails the way the real one does. */
function fakeSsh({ fail } = {}) {
  const runs = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    runs.push({ command, args, child });
    const forward = args[args.indexOf('-L') + 1];
    const port = Number(forward.split(':')[1]);
    let server = null;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      server?.close();
      setImmediate(() => child.emit('exit', null));
    };
    if (fail) {
      setImmediate(() => { child.stderr.emit('data', fail); child.emit('exit', 255); });
    } else {
      server = net.createServer((socket) => socket.destroy());
      server.listen(port, '127.0.0.1');
    }
    return child;
  };
  return { spawn, runs };
}

test('every value is its own argument, and the host cannot be read as an option', () => {
  const args = sshArgs({ host: 'bastion.example.com', port: 2222, user: 'deploy', key: '/home/me/.ssh/id work' }, { host: 'db.internal', port: 5432 }, 40001);
  assert.deepEqual(args.slice(-2), ['--', 'bastion.example.com']);
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:40001:db.internal:5432');
  assert.equal(args[args.indexOf('-p') + 1], '2222');
  assert.equal(args[args.indexOf('-l') + 1], 'deploy');
  assert.equal(args[args.indexOf('-i') + 1], '/home/me/.ssh/id work');
  // It must fail rather than ask, and fail rather than sit there forwarding nothing.
  assert.ok(args.includes('BatchMode=yes') && args.includes('ExitOnForwardFailure=yes'));
  // The person's own host-key policy is theirs: nothing here loosens it.
  assert.equal(args.some((one) => /StrictHostKeyChecking|UserKnownHostsFile/.test(one)), false);

  const bare = sshArgs({ host: 'bastion' }, { host: 'localhost', port: 3306 }, 40002);
  assert.equal(bare.includes('-p') || bare.includes('-l') || bare.includes('-i'), false);

  for (const host of ['-oProxyCommand=touch x', 'a b', 'a;b', 'user@host', '', 'a/b', '$(x)']) {
    assert.equal(sshHostOk(host), false, host);
    assert.throws(() => sshArgs({ host }, { host: 'db', port: 5432 }, 1), /SSH host/);
    assert.throws(() => sshArgs({ host: 'ok' }, { host, port: 5432 }, 1), /database host/);
  }
  for (const user of ['-oX', 'a b', 'a@b', 'root;id']) assert.equal(sshUserOk(user), false, user);
  assert.throws(() => sshArgs({ host: 'ok', user: '-oProxyCommand=x' }, { host: 'db', port: 1 }, 1), /SSH user/);
  assert.throws(() => sshArgs({ host: 'ok', port: 70000 }, { host: 'db', port: 1 }, 1), /SSH port/);
});

test('what ssh says when it fails comes back as something to do', () => {
  assert.match(explainSsh('Host key verification failed.', 'bastion'), /does not trust bastion yet.*ssh bastion/);
  assert.match(explainSsh('me@bastion: Permission denied (publickey).', 'bastion'), /refused the SSH login.*cannot ask for a password/);
  assert.match(explainSsh('ssh: Could not resolve hostname nope: nodename nor servname provided', 'nope'), /no SSH host called nope/);
  assert.match(explainSsh('ssh: connect to host b port 22: Connection refused', 'b'), /not accepting SSH/);
  assert.match(explainSsh('ssh: connect to host b port 22: Operation timed out', 'b'), /did not answer/);
  assert.match(explainSsh('something new\nand strange', 'b'), /SSH to b failed: and strange/);
});

test('a tunnel is one ssh for everyone who arrives together, and is gone when it is closed', async () => {
  const ssh = fakeSsh();
  const tunnels = new Tunnels({ spawn: ssh.spawn });
  const [a, b] = await Promise.all([
    tunnels.through('c1', { host: 'bastion' }, { host: 'db', port: 5432 }),
    tunnels.through('c1', { host: 'bastion' }, { host: 'db', port: 5432 }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.host, '127.0.0.1');
  assert.equal(ssh.runs.length, 1);
  assert.equal((await tunnels.through('c1', { host: 'bastion' }, { host: 'db', port: 5432 })).port, a.port);
  assert.equal(ssh.runs.length, 1);

  // Something that is not a session holds it open however quiet it is.
  const release = tunnels.hold('c1');
  assert.equal(tunnels.idle('c1', -1), false);
  release();
  assert.equal(tunnels.idle('c1', -1), true);
  // Holding a tunnel that is not there is not an error: most connections have none.
  tunnels.hold('nothing')();

  tunnels.close('c1');
  assert.equal(ssh.runs[0].child.killed, true);
  assert.deepEqual(tunnels.keys(), []);
});

test('an ssh that dies is forgotten, so the next caller opens another', async () => {
  const ssh = fakeSsh();
  const tunnels = new Tunnels({ spawn: ssh.spawn });
  await tunnels.through('c1', { host: 'bastion' }, { host: 'db', port: 5432 });
  ssh.runs[0].child.kill();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(tunnels.keys(), []);
  await tunnels.through('c1', { host: 'bastion' }, { host: 'db', port: 5432 });
  assert.equal(ssh.runs.length, 2);
  tunnels.closeAll();
});

test('a tunnel that cannot be opened says why, and leaves nothing behind', async () => {
  const tunnels = new Tunnels({ spawn: fakeSsh({ fail: 'me@bastion: Permission denied (publickey).\n' }).spawn });
  await assert.rejects(tunnels.through('c1', { host: 'bastion' }, { host: 'db', port: 5432 }), /refused the SSH login/);
  assert.deepEqual(tunnels.keys(), []);
  const none = new Tunnels({ spawn: () => { const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; setImmediate(() => child.emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }))); return child; } });
  await assert.rejects(none.through('c1', { host: 'bastion' }, { host: 'db', port: 5432 }), /no ssh on this computer/);
});

test('a connection keeps where it goes through, checked, and a file has no such thing', () => {
  const clean = RdbStore.clean({ engine: 'postgres', host: 'db.internal', user: 'app', sshHost: ' bastion ', sshPort: '2222', sshUser: 'deploy', sshKey: '~/.ssh/id_work' });
  assert.deepEqual([clean.sshHost, clean.sshPort, clean.sshUser, clean.sshKey], ['bastion', 2222, 'deploy', '~/.ssh/id_work']);
  // Without a host there is no tunnel, whatever else was left in the form.
  const direct = RdbStore.clean({ engine: 'mysql', host: 'db', sshHost: '', sshPort: 22, sshUser: 'x', sshKey: 'k' });
  assert.deepEqual([direct.sshHost, direct.sshPort, direct.sshUser, direct.sshKey], ['', null, '', '']);
  assert.throws(() => RdbStore.clean({ engine: 'postgres', host: 'db', sshHost: '-oProxyCommand=x' }), /SSH host/);
  assert.throws(() => RdbStore.clean({ engine: 'postgres', host: 'db', sshHost: 'b', sshUser: 'a b' }), /SSH user/);
  assert.throws(() => RdbStore.clean({ engine: 'postgres', host: 'db', sshHost: 'b', sshPort: 0 }), /SSH port/);
  assert.equal(RdbStore.clean({ engine: 'sqlite', file: '/tmp/x.db', sshHost: 'bastion' }).sshHost, '');
});

test('a session, a test and a terminal all go to the tunnel\'s end, and the certificate is still the server\'s', { skip }, async () => {
  const { RdbService } = require('../electron/rdb-service');
  const ssh = fakeSsh();
  const tunnels = new Tunnels({ spawn: ssh.spawn });
  const opened = [];
  const session = { engine: 'postgres', txn: 'idle', closed: false, all: async () => [{ version: 'PostgreSQL 18', user: 'app' }], run: async () => ({ columns: [], rows: [] }), close: async () => { session.closed = true; } };
  const secrets = { encrypt: (text) => `enc:${text}`, decrypt: (text) => text.slice(4) };
  const service = new RdbService({ db: new sqlite.DatabaseSync(':memory:'), secrets, tunnels, open: async (config) => { opened.push(config); session.closed = false; return session; } });
  const connection = { engine: 'postgres', name: 'far', host: 'db.internal', port: 5433, user: 'app', password: 'pw', database: 'shop', ssl: 'verify', sshHost: 'bastion', sshUser: 'deploy' };

  const tried = await service.call('testConnection', { connection });
  assert.equal(tried.ok, true, tried.error);
  assert.equal(opened[0].host, '127.0.0.1');
  assert.equal(opened[0].tlsHost, 'db.internal');
  assert.equal(ssh.runs[0].args[ssh.runs[0].args.indexOf('-L') + 1], `127.0.0.1:${opened[0].port}:db.internal:5433`);
  // The test's tunnel goes with the test.
  assert.deepEqual(tunnels.keys(), []);

  const saved = await service.call('saveConnection', { connection });
  assert.deepEqual([saved.connection.sshHost, saved.connection.sshUser, saved.connection.sshPort], ['bastion', 'deploy', null]);
  const id = saved.connection.id;
  await service.call('info', { id, database: 'shop' });
  assert.deepEqual(tunnels.keys(), [id]);
  assert.equal(opened.at(-1).host, '127.0.0.1');
  await service.call('disconnect', { id });
  assert.deepEqual(tunnels.keys(), []);

  // Changing the connection to go straight there opens no ssh.
  const before = ssh.runs.length;
  const straight = await service.call('saveConnection', { connection: { ...connection, id, sshHost: '' } });
  assert.equal(straight.connection.sshHost, '');
  await service.call('info', { id, database: 'shop' });
  assert.equal(ssh.runs.length, before);
  assert.equal(opened.at(-1).host, 'db.internal');
  assert.equal(opened.at(-1).tlsHost, undefined);
  await service.stop();
});

test('a database from before tunnels existed gains the columns and keeps its connections', { skip }, () => {
  const db = new sqlite.DatabaseSync(':memory:');
  const secrets = { encrypt: (text) => `enc:${text}`, decrypt: (text) => text.slice(4) };
  const first = new RdbStore(db, secrets);
  const kept = first.save({ engine: 'postgres', name: 'old', host: 'db', user: 'u', password: 'p' });
  // As it was one version ago: without the columns, and saying so.
  for (const column of ['ssh_host', 'ssh_port', 'ssh_user', 'ssh_key', 'watch']) db.exec(`ALTER TABLE rdb_connection DROP COLUMN ${column}`);
  db.exec("UPDATE rdb_meta SET v = '1' WHERE k = 'version'");
  const again = new RdbStore(db, secrets);
  const found = again.connection(kept.id);
  assert.deepEqual([found.name, found.sshHost, found.sshPort, found.hasPassword], ['old', '', null, true]);
  assert.equal(again.secret(kept.id).password, 'p');
});
