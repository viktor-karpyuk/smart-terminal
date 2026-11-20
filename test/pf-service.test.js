'use strict';

/**
 * Port Forward, end to end, with a kubectl that is not one.
 *
 * What is held here is what a person relies on without looking: that a forward
 * comes back on the port it had, that an expired sign-in is said once rather
 * than retried into, that two forwards cannot be given the same local port,
 * that quitting leaves nothing listening, and that bringing in what the K8S
 * Port Forward desktop app saved brings in the same thing only once.
 *
 * Needs `node:sqlite` (Node 22+) and skips itself without it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

const { PfService, signIn, networkTrouble, tunnelArgs, listeningPorts, authTrouble, readDesktopApp, desktopAppFile, parseLsof } = require('../electron/pf-service');
const { cleanForward, isAddress } = require('../electron/pf-store');

/** A kubectl that says what the test tells it to. */
function fakeKubectl() {
  const spawned = [];
  const spawnProcess = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.args = args;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.say = (text) => child.stdout.emit('data', text);
    child.complain = (text) => child.stderr.emit('data', text);
    child.exit = () => child.emit('close', 1);
    spawned.push(child);
    return child;
  };
  return { spawned, spawnProcess };
}

/** Timers a test fires by hand. */
function clock() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const timer = { fn, ms, on: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.on = false; },
    fire: async (pick = (timer) => timer.on) => {
      const timer = timers.find((one) => one.on && pick(one));
      assert.ok(timer, 'a timer was waiting');
      timer.on = false;
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function service(extra = {}) {
  const kubectl = fakeKubectl();
  const time = clock();
  const events = [];
  const made = new PfService({
    db: new sqlite.DatabaseSync(':memory:'),
    emit: (event) => events.push(event),
    desktopFile: path.join(os.tmpdir(), 'st-pf-none', 'data.db'),
    tunnels: { spawnProcess: kubectl.spawnProcess, env: async () => ({}), setTimer: time.setTimer, clearTimer: time.clearTimer },
    ...extra,
  });
  return { made, kubectl, time, events };
}

const MONGO = { name: 'mongo dev', context: 'arn:aws:eks:sa-east-1:1:cluster/dev', namespace: 'databases', kind: 'pod', target: 'mongodb-0', ports: [{ local: 27517, remote: 27017 }] };

test('a forward is one kubectl, with the context named and nothing a panel wrote as a flag', () => {
  assert.deepEqual(tunnelArgs({ ...MONGO, ports: [{ local: 27517, remote: 27017 }, { local: 0, remote: 9216 }] }), [
    '--context', 'arn:aws:eks:sa-east-1:1:cluster/dev', '--namespace', 'databases',
    'port-forward', '--address', '127.0.0.1', 'pod/mongodb-0', '27517:27017', '0:9216',
  ]);
  assert.throws(() => tunnelArgs({ ...MONGO, target: '--kubeconfig=/tmp/x' }), /cannot start with/);
  assert.throws(() => tunnelArgs({ ...MONGO, namespace: '-n' }), /cannot start with/);
  assert.throws(() => tunnelArgs({ ...MONGO, kind: 'node' }), /cannot be forwarded/);
  assert.throws(() => tunnelArgs({ ...MONGO, address: 'evil.example --pod-running-timeout' }), /address/);
  assert.throws(() => tunnelArgs({ ...MONGO, ports: [{ local: 1, remote: 70000 }] }), /port/);
  assert.throws(() => tunnelArgs({ ...MONGO, ports: [{ local: 5000, remote: 1 }, { local: 5000, remote: 2 }] }), /same local port/);
  assert.equal(isAddress('0.0.0.0'), true);
  assert.equal(isAddress('256.1.1.1'), false);
  assert.equal(cleanForward({ ...MONGO, name: '' }).name, 'mongodb-0');
});

test('what kubectl opened is read from what it said, IPv6 and all', () => {
  assert.deepEqual(listeningPorts('Forwarding from 127.0.0.1:27517 -> 27017\nForwarding from [::1]:27517 -> 27017\n'), [27517, 27517]);
  assert.deepEqual(listeningPorts('Handling connection for 27517'), []);
});

test('an expired sign-in is told apart from a connection that dropped', () => {
  assert.equal(authTrouble('error: You must be logged in to the server (Unauthorized)'), true);
  assert.equal(authTrouble('Unable to connect to the server: getting credentials: exec: executable aws failed with exit code 255'), true);
  assert.equal(authTrouble('Error when retrieving token from sso: Token has expired and refresh failed'), true);
  assert.equal(authTrouble('error: lost connection to pod'), false);
  assert.equal(authTrouble('Error from server (NotFound): pods "mongodb-0" not found'), false);
});

test('lsof is read into who listens on what', () => {
  const ports = parseLsof([
    'COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
    'kubectl  4242 viktor    8u  IPv4 0x1      0t0  TCP 127.0.0.1:27517 (LISTEN)',
    'kubectl  4242 viktor    9u  IPv6 0x2      0t0  TCP [::1]:27517 (LISTEN)',
    'postgres  901 viktor    7u  IPv4 0x3      0t0  TCP *:5432 (LISTEN)',
  ].join('\n'));
  assert.deepEqual(ports, [
    { port: 5432, process: 'postgres', pid: 901, address: '*' },
    { port: 27517, process: 'kubectl', pid: 4242, address: '127.0.0.1' },
  ]);
});

test('the desktop app keeps its data where its README says', () => {
  assert.equal(desktopAppFile('/Users/a', 'darwin', {}), '/Users/a/Library/Application Support/PortForwardApp/data.db');
  assert.equal(desktopAppFile('/home/a', 'linux', {}), '/home/a/.local/share/port-forward-app/data.db');
});

test('a forward comes up, is counted, drops, and comes back on the port it had', { skip }, async () => {
  const { made, kubectl, time, events } = service();
  const saved = (await made.call('save', { forward: { ...MONGO, ports: [{ local: 0, remote: 27017 }] } })).forward;
  const started = await made.call('start', { id: saved.id });
  assert.equal(started.run.state, 'starting');
  assert.equal(kubectl.spawned.length, 1);
  assert.equal(kubectl.spawned[0].args.at(-1), '0:27017');

  // In two pieces, as it arrives; and twice, once per address family.
  kubectl.spawned[0].say('Forwarding from 127.0.0.1:53');
  kubectl.spawned[0].say('111 -> 27017\nForwarding from [::1]:53111 -> 27017\n');
  let run = (await made.call('overview')).forwards[0].run;
  assert.equal(run.state, 'up');
  assert.equal(run.ports[0].actual, 53111);
  assert.equal(events.filter((event) => event.type === 'state' && event.state.state === 'up').length, 1, 'said once');

  kubectl.spawned[0].say('Handling connection for 53111\nHandling connection for 53111\n');
  assert.equal((await made.call('log', { id: saved.id })).run.connections, 2);
  assert.ok(!(await made.call('log', { id: saved.id })).lines.some((line) => /Handling/.test(line)), 'counted, not kept');

  kubectl.spawned[0].complain('error: lost connection to pod\n');
  kubectl.spawned[0].exit();
  run = (await made.call('overview')).forwards[0].run;
  assert.equal(run.state, 'reconnecting');
  await time.fire();
  assert.equal(kubectl.spawned.length, 2);
  assert.equal(kubectl.spawned[1].args.at(-1), '53111:27017', 'the same local port, so what pointed at it still does');
  kubectl.spawned[1].say('Forwarding from 127.0.0.1:53111 -> 27017\n');
  run = (await made.call('overview')).forwards[0].run;
  assert.equal(run.state, 'up');
  assert.equal(run.reconnects, 1);

  await made.call('stop', { id: saved.id });
  assert.equal(kubectl.spawned[1].killed, true);
  kubectl.spawned[1].exit();
  assert.equal((await made.call('overview')).forwards[0].run.state, 'stopped', 'stopping is not a drop');
  assert.equal(kubectl.spawned.length, 2);
});

test('an expired sign-in says so once and is not retried into', { skip }, async () => {
  const { made, kubectl, time } = service();
  const saved = (await made.call('save', { forward: MONGO })).forward;
  await made.call('start', { id: saved.id });
  kubectl.spawned[0].complain('Unable to connect to the server: getting credentials: exec: executable aws failed with exit code 255\n');
  kubectl.spawned[0].exit();
  const run = (await made.call('overview')).forwards[0].run;
  assert.equal(run.state, 'auth');
  assert.match(run.error, /aws sso login/);
  assert.equal(time.timers.filter((timer) => timer.on).length, 0);
});

test('a pod that is gone is final; a port that is taken is final; anything else gives up after a run of attempts', { skip }, async () => {
  const { made, kubectl, time } = service();
  const pod = (await made.call('save', { forward: MONGO })).forward;
  await made.call('start', { id: pod.id });
  kubectl.spawned[0].complain('Error from server (NotFound): pods "mongodb-0" not found\n');
  kubectl.spawned[0].exit();
  assert.match((await made.call('log', { id: pod.id })).run.error, /is gone/);

  await made.call('start', { id: pod.id });
  kubectl.spawned[1].complain('Unable to listen on port 27517: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:27517: bind: address already in use]\n');
  kubectl.spawned[1].exit();
  assert.match((await made.call('log', { id: pod.id })).run.error, /already in use/);

  const svc = (await made.call('save', { forward: { ...MONGO, name: 'api', kind: 'service', target: 'api', ports: [{ local: 8080, remote: 80 }] } })).forward;
  await made.call('start', { id: svc.id });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    kubectl.spawned.at(-1).complain('error: unable to forward port because pod is not running. Current status=Pending\n');
    kubectl.spawned.at(-1).exit();
    if (attempt < 5) await time.fire();
  }
  const run = (await made.call('log', { id: svc.id })).run;
  assert.equal(run.state, 'failed');
  assert.match(run.error, /Gave up after 6 attempts/);
});

test('with no network it is waited out, not given up on — and tried at once when the computer wakes', { skip }, async () => {
  const { made, kubectl, time } = service();
  const svc = (await made.call('save', { forward: { ...MONGO, kind: 'service', target: 'api' } })).forward;
  await made.call('start', { id: svc.id });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    kubectl.spawned.at(-1).complain('Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout\n');
    kubectl.spawned.at(-1).exit();
    if (attempt < 7) await time.fire();
  }
  const run = (await made.call('log', { id: svc.id })).run;
  assert.equal(run.state, 'reconnecting');
  assert.equal(run.offline, true);
  assert.equal(time.timers.filter((timer) => timer.on).at(-1).ms, 60_000);

  const before = kubectl.spawned.length;
  made.wake();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kubectl.spawned.length, before + 1, 'not in a minute: now');
  assert.equal(time.timers.filter((timer) => timer.on && timer.ms === 60_000).length, 0);
  kubectl.spawned.at(-1).say('Forwarding from 127.0.0.1:27517 -> 27017\n');
  const up = (await made.call('log', { id: svc.id })).run;
  assert.equal(up.state, 'up');
  assert.equal(up.offline, false);
});

test('one that is told not to start again does not', { skip }, async () => {
  const { made, kubectl, time } = service();
  const saved = (await made.call('save', { forward: { ...MONGO, autoRestart: false } })).forward;
  await made.call('start', { id: saved.id });
  kubectl.spawned[0].say('Forwarding from 127.0.0.1:27517 -> 27017\n');
  kubectl.spawned[0].complain('error: lost connection to pod\n');
  kubectl.spawned[0].exit();
  assert.equal((await made.call('log', { id: saved.id })).run.state, 'failed');
  assert.equal(time.timers.filter((timer) => timer.on).length, 0);
});

test('two forwards cannot hold the same local port, and one set to stop by itself does', { skip }, async () => {
  const { made, kubectl, time } = service();
  const first = (await made.call('save', { forward: { ...MONGO, ttlMinutes: 120 } })).forward;
  const second = (await made.call('save', { forward: { ...MONGO, name: 'the other', target: 'mongodb-1' } })).forward;
  await made.call('start', { id: first.id });
  const clash = await made.call('start', { id: second.id });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /27517.*already used by mongo dev/);
  assert.equal(kubectl.spawned.length, 1);
  // And on its own row, where it will be looked for after the message has gone.
  assert.match((await made.call('log', { id: second.id })).run.error, /already used by mongo dev/);

  kubectl.spawned[0].say('Forwarding from 127.0.0.1:27517 -> 27017\n');
  await time.fire((timer) => timer.ms === 120 * 60_000);
  const run = (await made.call('log', { id: first.id })).run;
  assert.equal(run.state, 'expired');
  assert.match(run.error, /2 h/);
  assert.equal(kubectl.spawned[0].killed, true);
});

test('groups start and stop together, a profile switches, and quitting leaves nothing running', { skip }, async () => {
  const { made, kubectl } = service();
  const group = (await made.call('saveGroup', { name: 'KS-ERP' })).group;
  assert.equal((await made.call('saveGroup', { name: 'ks-erp' })).group.id, group.id, 'the same name is the same group');
  const a = (await made.call('save', { forward: { ...MONGO, name: 'a', ports: [{ local: 5544, remote: 5432 }], groupId: group.id } })).forward;
  const b = (await made.call('save', { forward: { ...MONGO, name: 'b', ports: [{ local: 5545, remote: 5432 }], groupId: group.id } })).forward;
  const c = (await made.call('save', { forward: { ...MONGO, name: 'c', ports: [{ local: 5546, remote: 5432 }] } })).forward;

  await made.call('startGroup', { id: group.id });
  assert.equal(kubectl.spawned.length, 2);
  assert.equal((await made.call('saveProfile', { name: 'erp', running: true })).profile.forwards.length, 2);

  await made.call('stopGroup', { id: group.id });
  await made.call('start', { id: c.id });
  const switched = await made.call('applyProfile', { id: (await made.call('overview')).profiles[0].id });
  assert.deepEqual([switched.started, switched.stopped], [2, 1]);
  const runs = Object.fromEntries((await made.call('overview')).forwards.map((forward) => [forward.name, forward.run.state]));
  assert.deepEqual(runs, { a: 'starting', b: 'starting', c: 'stopped' });

  // A new name is not a new forward: what runs is left running. Where it leads is, and it is started again as it now reads.
  const before = kubectl.spawned.length;
  assert.equal((await made.call('save', { forward: { ...a, name: 'a2' } })).restarted, false);
  assert.equal(kubectl.spawned.length, before);
  assert.equal((await made.call('save', { forward: { ...a, name: 'a2', target: 'mongodb-9' } })).restarted, true);
  assert.equal(kubectl.spawned.length, before + 1);
  assert.match(kubectl.spawned.at(-1).args.join(' '), /pod\/mongodb-9/);
  await made.call('stop', { id: a.id });
  await made.call('remove', { id: b.id });
  assert.deepEqual((await made.call('overview')).profiles[0].forwards, [a.id]);
  await made.call('removeGroup', { id: group.id });
  assert.equal((await made.call('overview')).forwards.find((one) => one.id === a.id).groupId, null);

  await made.call('start', { id: a.id });
  made.stop();
  assert.ok(kubectl.spawned.every((child) => child.killed), 'every kubectl was told to go');
});

test('the ones marked for it start with the app, and a forward that is up opens only its own port', { skip }, async () => {
  const opened = [];
  const { made, kubectl } = service({ openUrl: async (url) => { opened.push(url); } });
  const auto = (await made.call('save', { forward: { ...MONGO, autoStart: true } })).forward;
  await made.call('save', { forward: { ...MONGO, name: 'manual', target: 'mongodb-1', ports: [{ local: 27617, remote: 27017 }] } });
  made.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kubectl.spawned.length, 1);
  assert.equal((await made.call('open', { id: auto.id })).ok, false, 'not up yet');
  kubectl.spawned[0].say('Forwarding from 127.0.0.1:27517 -> 27017\n');
  await made.call('open', { id: auto.id, port: 22 });
  assert.deepEqual(opened, ['http://localhost:27517/']);
});

test('what the desktop app saved is brought in once, with its groups and profiles', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pf-'));
  const file = path.join(dir, 'data.db');
  const theirs = new sqlite.DatabaseSync(file);
  theirs.exec(`
    CREATE TABLE clusters (id TEXT PRIMARY KEY, source_id TEXT, context_name TEXT NOT NULL);
    CREATE TABLE forward_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE forwards (id TEXT PRIMARY KEY, name TEXT NOT NULL, cluster_id TEXT NOT NULL, namespace TEXT NOT NULL, target_kind TEXT NOT NULL,
      target_name TEXT NOT NULL, remote_port INTEGER NOT NULL, local_port INTEGER NOT NULL, address TEXT NOT NULL, auto_start INTEGER NOT NULL DEFAULT 0,
      auto_restart INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, group_id TEXT, use_subprocess INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE forward_ports (id INTEGER PRIMARY KEY AUTOINCREMENT, forward_id TEXT NOT NULL, remote_port INTEGER NOT NULL, local_port INTEGER NOT NULL DEFAULT 0, ordinal INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE profile_forwards (profile_id TEXT NOT NULL, forward_id TEXT NOT NULL);
    INSERT INTO clusters VALUES ('c1', 's', 'arn:aws:eks:ca-west-1:1:cluster/pds-cluster');
    INSERT INTO forward_groups VALUES ('g1', 'PDS DEV', 1), ('g2', 'EMPTY', 2);
    INSERT INTO forwards VALUES ('f1', 'mongo-dev-mongodb-0', 'c1', 'dev-databases', 'POD', 'mongo-dev-mongodb-0', 27017, 37017, '127.0.0.1', 0, 1, 1, 1, 'g1', 0);
    INSERT INTO forwards VALUES ('f2', 'api', 'c1', 'dev', 'SERVICE', 'api', 80, 8080, '127.0.0.1', 1, 0, 2, 2, NULL, 0);
    INSERT INTO forwards VALUES ('f3', 'lost', 'nowhere', 'dev', 'POD', '-bad', 80, 8081, '127.0.0.1', 0, 1, 3, 3, NULL, 0);
    INSERT INTO forward_ports (forward_id, remote_port, local_port, ordinal) VALUES ('f2', 9090, 9090, 1), ('f2', 80, 8080, 0);
    INSERT INTO profiles VALUES ('p1', 'PDS DEV', 1);
    INSERT INTO profile_forwards VALUES ('p1', 'f1'), ('p1', 'f2');
  `);
  theirs.close();

  const read = readDesktopApp(file);
  assert.deepEqual(read.forwards[1].ports, [{ local: 8080, remote: 80 }, { local: 9090, remote: 9090 }], 'in the order it kept them');
  assert.deepEqual(read.forwards[0].ports, [{ local: 37017, remote: 27017 }], 'an older row keeps its one port on itself');

  const { made } = service({ desktopFile: file });
  assert.equal((await made.call('overview')).desktopApp, true);
  const first = await made.call('importDesktopApp');
  assert.equal(first.added, 2);
  assert.equal(first.profiles, 1);
  assert.equal(first.refused.length, 1, 'one that could never be a kubectl line is left out, and said');
  const view = await made.call('overview');
  assert.deepEqual(view.groups.map((group) => group.name), ['PDS DEV', 'EMPTY']);
  const mongo = view.forwards.find((one) => one.name === 'mongo-dev-mongodb-0');
  assert.equal(mongo.context, 'arn:aws:eks:ca-west-1:1:cluster/pds-cluster', 'a cluster id became the context it stood for');
  assert.equal(mongo.kind, 'pod');
  assert.equal(mongo.groupId, view.groups[0].id);
  assert.equal(view.forwards.find((one) => one.name === 'api').autoRestart, false);
  assert.equal(view.profiles[0].forwards.length, 2);

  const again = await made.call('importDesktopApp');
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 2);
  assert.equal((await made.call('overview')).forwards.length, 2);

  // And out to a file's worth of text, and back into an empty one.
  const text = (await made.call('exportText')).text;
  const exported = path.join(dir, 'out.json');
  fs.writeFileSync(exported, text);
  const other = service({ pickFile: async () => exported }).made;
  const back = await other.call('importFile');
  assert.equal(back.added, 2);
  assert.equal(back.profiles, 1);
  assert.equal((await other.call('overview')).forwards.find((one) => one.name === 'api').groupId, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a forward set to stop itself does, even when the computer slept through the moment', { skip }, async () => {
  let now = Date.parse('2026-11-20T18:00:00Z');
  const kubectl = fakeKubectl();
  const time = clock();
  const made = new PfService({
    db: new sqlite.DatabaseSync(':memory:'),
    desktopFile: path.join(os.tmpdir(), 'st-pf-none', 'data.db'),
    tunnels: { spawnProcess: kubectl.spawnProcess, env: async () => ({}), setTimer: time.setTimer, clearTimer: time.clearTimer, now: () => now },
  });
  const saved = (await made.call('save', { forward: { ...MONGO, ttlMinutes: 120 } })).forward;
  await made.call('start', { id: saved.id });
  kubectl.spawned[0].say('Forwarding from 127.0.0.1:27517 -> 27017\n');
  // An hour of being awake is not two; a night of sleep is, though no timer ran in it.
  now += 60 * 60_000;
  made.wake();
  assert.equal((await made.call('log', { id: saved.id })).run.state, 'up');
  now += 14 * 60 * 60_000;
  made.wake();
  const run = (await made.call('log', { id: saved.id })).run;
  assert.equal(run.state, 'expired');
  assert.equal(kubectl.spawned[0].killed, true);
  assert.equal(time.timers.filter((timer) => timer.on).length, 0);
});

test('a network that blinked is not a pod that was deleted', { skip }, async () => {
  assert.equal(networkTrouble('Unable to connect to the server: dial tcp: lookup x.eks.amazonaws.com: no such host'), true);
  assert.equal(networkTrouble('Error from server (NotFound): pods "mongodb-0" not found'), false);
  const { made, kubectl, time } = service();
  const pod = (await made.call('save', { forward: MONGO })).forward;
  await made.call('start', { id: pod.id });
  kubectl.spawned[0].complain('Unable to connect to the server: dial tcp: lookup x.eks.amazonaws.com: no such host\n');
  kubectl.spawned[0].exit();
  assert.equal((await made.call('log', { id: pod.id })).run.state, 'reconnecting');
  await time.fire();
  assert.equal(kubectl.spawned.length, 2);
});

test('one that comes up and falls over at once, every time, gives up', { skip }, async () => {
  const { made, kubectl, time } = service();
  const svc = (await made.call('save', { forward: { ...MONGO, kind: 'service', target: 'api' } })).forward;
  await made.call('start', { id: svc.id });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    kubectl.spawned.at(-1).say('Forwarding from 127.0.0.1:27517 -> 27017\n');
    kubectl.spawned.at(-1).complain('error: lost connection to pod\n');
    kubectl.spawned.at(-1).exit();
    if (attempt < 5) await time.fire();
  }
  assert.equal(kubectl.spawned.length, 6);
  assert.match((await made.call('log', { id: svc.id })).run.error, /Gave up after 6 attempts/);
});

test('a port this computer will not open is said to be that, and a missing kubectl is not retried', { skip }, async () => {
  const { made, kubectl, time } = service();
  const web = (await made.call('save', { forward: { ...MONGO, kind: 'service', target: 'web', ports: [{ local: 80, remote: 80 }] } })).forward;
  await made.call('start', { id: web.id });
  kubectl.spawned[0].complain('Unable to listen on port 80: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:80: bind: permission denied]\nerror: unable to listen on any of the requested ports: [{80 80}]\n');
  kubectl.spawned[0].exit();
  const run = (await made.call('log', { id: web.id })).run;
  assert.match(run.error, /below 1024/);
  assert.doesNotMatch(run.error, /already in use/);

  const other = (await made.call('save', { forward: MONGO })).forward;
  await made.call('start', { id: other.id });
  kubectl.spawned[1].emit('error', Object.assign(new Error('spawn kubectl ENOENT'), { code: 'ENOENT' }));
  kubectl.spawned[1].exit();
  const gone = (await made.call('log', { id: other.id })).run;
  assert.equal(gone.state, 'failed');
  assert.match(gone.error, /not installed/);
  assert.equal(time.timers.filter((timer) => timer.on).length, 0);
});

test('a refused connection is a warning that goes away once connections get through; a kubectl that never answers is ended', { skip }, async () => {
  const { made, kubectl, time } = service();
  const saved = (await made.call('save', { forward: MONGO })).forward;
  await made.call('start', { id: saved.id });
  const child = kubectl.spawned[0];
  child.say('Forwarding from 127.0.0.1:27517 -> 27017\n');
  child.say('Handling connection for 27517\n');
  child.complain('E1120 portforward.go:400] an error occurred forwarding 27517 -> 27017: connect: connection refused\n');
  assert.match((await made.call('log', { id: saved.id })).run.warning, /nothing listening/);
  child.say('Handling connection for 27517\nHandling connection for 27517\nHandling connection for 27517\n');
  assert.equal((await made.call('log', { id: saved.id })).run.warning, null);

  const stuck = (await made.call('save', { forward: { ...MONGO, name: 'stuck', ports: [{ local: 27999, remote: 27017 }] } })).forward;
  await made.call('start', { id: stuck.id });
  await time.fire((timer) => timer.ms === 45_000);
  assert.equal(kubectl.spawned[1].killed, true);
  kubectl.spawned[1].exit();
  assert.match((await made.call('log', { id: stuck.id })).run.error, /did not say it was listening/);
});

test('a file cannot open a port to the network or start by itself; saying so afterwards is asked about', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pf-'));
  const file = path.join(dir, 'in.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, forwards: [{ ...MONGO, address: '0.0.0.0', autoStart: true }] }));
  const { made } = service({ pickFile: async () => file });
  const result = await made.call('importFile');
  assert.equal(result.added, 1);
  assert.equal(result.notes.length, 2);
  const saved = (await made.call('overview')).forwards[0];
  assert.equal(saved.address, '127.0.0.1');
  assert.equal(saved.autoStart, false);
  fs.rmSync(dir, { recursive: true, force: true });

  const H = require('../.test-build/lib/extensionHost.js');
  assert.match(H.needsConsent('pf.save', { forward: { name: 'x', address: '0.0.0.0' } }), /every network interface/);
  assert.match(H.needsConsent('pf.save', { forward: { name: 'x', address: ' 0.0.0.0' } }), /every network interface/);
  assert.match(H.needsConsent('pf.save', { forward: { name: 'x', address: '192.168.1.5' } }), /192\.168\.1\.5/);
  assert.match(H.needsConsent('pf.saveMany', { forwards: [{ name: 'a' }, { name: 'b', address: '0.0.0.0' }] }), /Save b listening/);
  assert.equal(H.needsConsent('pf.save', { forward: { name: 'x', address: '127.0.0.1' } }), null);
  assert.equal(H.needsConsent('pf.save', { forward: { name: 'x' } }), null);
  assert.equal(H.route('pf.signIn'), 'app');
  assert.equal(H.permitted({ permissions: ['terminal'] }, 'pf.signIn'), false, 'a terminal alone does not sign anybody in');
  assert.equal(H.allowed('pf.signInCommand'), false, 'the line is the app’s to ask for, not a panel’s');
});

test('the sign-in line is fixed words and at most a checked profile name', () => {
  const config = (exec) => ({ 'current-context': 'c', contexts: [{ name: 'c', context: { user: 'u' } }], users: [{ name: 'u', user: { exec } }] });
  assert.deepEqual(signIn(config({ command: 'aws', args: ['eks', 'get-token', '--profile', 'pds-dev'] }), 'c'), { title: 'aws sso login', command: 'aws sso login --profile pds-dev' });
  assert.equal(signIn(config({ command: 'aws', args: ['eks', 'get-token'], env: [{ name: 'AWS_PROFILE', value: 'kubrik' }] }), '').command, 'aws sso login --profile kubrik');
  assert.equal(signIn(config({ command: 'aws', args: ['--profile', 'x; rm -rf ~'] }), 'c').command, 'aws sso login');
  assert.equal(signIn(config({ command: 'gke-gcloud-auth-plugin' }), 'c').command, 'gcloud auth login');
  assert.equal(signIn(config({ command: 'kubelogin' }), 'c').command, 'az login');
  assert.equal(signIn(config(undefined), 'c'), null);
  assert.equal(signIn({}, 'nope'), null);
});

test('after a sign-in everything that was waiting is started, several are added at once, and an ending is said out loud', { skip }, async () => {
  const said = [];
  const soon = [];
  const moment = () => { while (soon.length) soon.shift()(); };
  const { made, kubectl } = service({ later: (fn) => soon.push(fn), notify: (title, body) => said.push([title, body]), kubeconfig: async () => ({ contexts: [{ name: MONGO.context, context: { user: 'u' } }], users: [{ name: 'u', user: { exec: { command: 'aws' } } }] }) });
  const added = await made.call('saveMany', { forwards: [{ ...MONGO, name: 'one' }, { ...MONGO, name: 'two', target: 'mongodb-1', ports: [{ local: 27618, remote: 27017 }] }] });
  assert.equal(added.forwards.length, 2);
  assert.equal((await made.call('saveMany', { forwards: [{ ...MONGO, name: 'ok' }, { ...MONGO, target: '-bad' }] })).ok, false);
  assert.equal((await made.call('overview')).forwards.length, 2, 'all of them or none');

  const [one] = added.forwards;
  await made.call('start', { id: one.id });
  kubectl.spawned[0].say('Forwarding from 127.0.0.1:27517 -> 27017\n');
  kubectl.spawned[0].complain('error: You must be logged in to the server (Unauthorized)\n');
  kubectl.spawned[0].exit();
  assert.equal(said.length, 0, 'not yet: whatever else ends in the same moment is said with it');
  moment();
  assert.equal(said.length, 1);
  assert.match(said[0][0], /one needs a sign-in/);
  assert.equal((await made.call('signInCommand', { id: one.id })).command, 'aws sso login');

  // The other one on the same cluster runs into the same wall.
  const [, two] = added.forwards;
  await made.call('start', { id: two.id });
  kubectl.spawned[1].complain('error: You must be logged in to the server (Unauthorized)\n');
  kubectl.spawned[1].exit();
  assert.equal((await made.call('log', { id: two.id })).run.state, 'auth');

  // Signed in, and one of them tried again: when it comes up, the other is started without being asked.
  await made.call('start', { id: one.id });
  assert.equal(kubectl.spawned.length, 3);
  kubectl.spawned[2].say('Forwarding from 127.0.0.1:27517 -> 27017\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kubectl.spawned.length, 4, 'the one that was waiting on the same cluster');
  assert.match(kubectl.spawned[3].args.join(' '), /pod\/mongodb-1/);
  kubectl.spawned[3].say('Forwarding from 127.0.0.1:27618 -> 27017\n');

  // Two going down in the same moment are one piece of news; stopping by hand is none.
  for (const child of [kubectl.spawned[2], kubectl.spawned[3]]) {
    child.complain('error: You must be logged in to the server (Unauthorized)\n');
    child.exit();
  }
  moment();
  assert.equal(said.length, 2);
  assert.match(said[1][0], /2 forwards need a sign-in/);
  assert.match(said[1][1], /one, two/);

  await made.call('retryWaiting');
  assert.equal(kubectl.spawned.length, 6);
  kubectl.spawned[4].say('Forwarding from 127.0.0.1:27517 -> 27017\n');
  await made.call('stop', { id: one.id });
  moment();
  assert.equal(said.length, 2);
});

test('a name that is not a verb is not one', { skip }, async () => {
  const { made } = service();
  assert.equal((await made.call('constructor')).ok, false);
  assert.equal((await made.call('start', { id: 'nope' })).ok, false);
});
