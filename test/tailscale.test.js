'use strict';

/** Tailscale as the phone sees it: found or not, up or not, and the addresses it gives. */

const test = require('node:test');
const assert = require('node:assert');

const { Tailscale, findCli, readStatus } = require('../electron/tailscale');

const STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'viktors-macbook-pro.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] },
});

test('the command is looked for where the Mac app keeps it, then on the PATH', () => {
  assert.equal(findCli({ exists: () => false, env: { PATH: '/usr/bin:/bin' } }), null);
  assert.equal(findCli({ exists: (p) => p === '/opt/homebrew/bin/tailscale', env: { PATH: '/opt/homebrew/bin:/usr/bin' } }), '/opt/homebrew/bin/tailscale');
  assert.equal(findCli({ exists: (p) => p === '/Applications/Tailscale.app/Contents/MacOS/Tailscale', env: { PATH: '/usr/bin' } }), '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(findCli({ exists: (p) => p === '/Applications/Tailscale.app/Contents/MacOS/Tailscale' || p === '/x/tailscale', env: { PATH: '/x' } }), '/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'the known place wins over the PATH');
  assert.equal(findCli({ exists: (p) => p === './tailscale' || p === 'node_modules/.bin/tailscale', env: { PATH: '.:node_modules/.bin' } }), null, 'a relative PATH entry is not trusted');
});

test('the status is read down to the name and the IPv4 address', () => {
  assert.deepEqual(readStatus(STATUS), { running: true, state: 'Running', name: 'viktors-macbook-pro.tail1234.ts.net', ips: ['100.101.102.103'], error: null });
  assert.equal(readStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} })).running, false);
  assert.match(readStatus('not json').error, /not its status/);
});

test('not installed: nothing to say, and no addresses', async () => {
  const ts = new Tailscale({ cli: null });
  assert.equal(ts.installed, false);
  assert.deepEqual(await ts.info(), { installed: false, running: false, name: null, ips: [], error: null });
  assert.deepEqual(ts.addresses(7373), []);
});

test('installed and up: the name first, then the IP, with the port; read again only after a while', async () => {
  let calls = 0;
  let now = 1000;
  const ts = new Tailscale({ cli: '/x/tailscale', now: () => now, exec: (_cli, args, _opts, cb) => { calls += 1; assert.deepEqual(args, ['status', '--json', '--peers=false']); cb(null, STATUS); } });
  const info = await ts.info();
  assert.equal(info.running, true);
  assert.deepEqual(ts.addresses(7373), ['http://viktors-macbook-pro.tail1234.ts.net:7373/', 'http://100.101.102.103:7373/']);
  await ts.info();
  assert.equal(calls, 1, 'a fresh reading is reused');
  now += 20_000;
  await ts.info();
  assert.equal(calls, 2);
});

test('installed but not answering says so, rather than looking like it is off', async () => {
  const ts = new Tailscale({ cli: '/x/tailscale', exec: (_cli, _args, _opts, cb) => cb(new Error('exit 1'), '') });
  const info = await ts.info();
  assert.equal(info.installed, true);
  assert.equal(info.running, false);
  assert.match(info.error, /did not answer/);
  assert.deepEqual(ts.addresses(7373), []);
});

test('many askers at once spawn one reading', async () => {
  let calls = 0;
  const ts = new Tailscale({ cli: '/x/tailscale', exec: (_c, _a, _o, cb) => { calls += 1; setTimeout(() => cb(null, STATUS), 20); } });
  await Promise.all([ts.info(), ts.info(), ts.info()]);
  assert.equal(calls, 1);
});
