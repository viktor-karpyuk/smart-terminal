'use strict';

/**
 * What a session is running, and whether it is worth offering back.
 *
 * This exists because the function it tests was *called and never defined*.
 * Every tick of the watcher threw a ReferenceError, the watcher's own catch
 * treated it as a tick that reported nothing, and every change after the first
 * one in that batch was lost — permanently, because they had already been
 * recorded as reported. What the app believed each session was running stopped
 * being updated, and that belief is what decides whether a message can be
 * delivered to a session at all.
 *
 * So the rules are written down here, where a missing one is a failing test
 * rather than five quiet days.
 */
const test = require('node:test');
const assert = require('node:assert');
const { worthRemembering } = require('../electron/cwd-watcher');

test('a shell is not a command anybody wants restarted', () => {
  assert.equal(worthRemembering('zsh', '/bin/zsh -i -l'), false);
  assert.equal(worthRemembering('-zsh', '-zsh'), false);
  assert.equal(worthRemembering('bash', '/bin/bash'), false);
  assert.equal(worthRemembering('fish', '/opt/homebrew/bin/fish'), false);
});

test('Claude comes back by its own machinery, so it is not offered twice', () => {
  assert.equal(worthRemembering('claude', 'claude --resume abc --mcp-config /tmp/x.json'), false);
});

test('anything else a session was running is worth offering back', () => {
  assert.equal(worthRemembering('node', 'npm run dev'), true);
  assert.equal(worthRemembering('vitest', 'npx vitest --watch'), true);
  assert.equal(worthRemembering('kubectl', 'kubectl logs -f pod/api'), true);
});

test('nothing running, or nothing to run, is nothing to remember', () => {
  assert.equal(worthRemembering(null, 'npm run dev'), false);
  assert.equal(worthRemembering('node', ''), false);
  assert.equal(worthRemembering('node', null), false);
  assert.equal(worthRemembering('', ''), false);
});

test('what a shell runs on its way in, and anything under a Claude session, is not a command to offer back', () => {
  const conda = '/opt/anaconda3/bin/python /opt/anaconda3/bin/conda shell.zsh hook';
  // The same line, seen while the shell was still starting: startup noise.
  assert.equal(worthRemembering('python', conda, { kind: 'shell', ageMs: 800 }), false);
  // Seen later, in a shell: the person ran it, and it is offered back.
  assert.equal(worthRemembering('python', conda, { kind: 'shell', ageMs: 60000 }), true);
  // Under a Claude session, never — a line typed there is a message.
  assert.equal(worthRemembering('python', conda, { kind: 'claude', ageMs: 60000 }), false);
  assert.equal(worthRemembering('node', 'node server.js', { kind: 'claude', ageMs: 60000 }), false);
  // Without the extra facts the old rule stands.
  assert.equal(worthRemembering('node', 'node server.js'), true);
  assert.equal(worthRemembering('zsh', 'zsh'), false);
});

/**
 * What a shell is running is asked about that shell, not read off a dump of
 * every process on the machine. The trap in asking narrowly: `pgrep` reports
 * "no children" as a failing exit status, and a tick that took that for a
 * failure would throw away the `cd` it had just seen in the same breath.
 */
const { spawn } = require('node:child_process');
const { childrenOf } = require('../electron/cwd-watcher');
const posix = process.platform === 'darwin' || process.platform === 'linux';

test(
  'a shell running something is reported with what it runs, and nothing else',
  { skip: !posix },
  async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const children = await childrenOf(String(process.pid));
      assert.deepEqual(children.get(process.pid), {
        name: 'sleep',
        command: 'sleep 30',
      });
      assert.equal(children.size, 1, 'only our own children are described');
    } finally {
      child.kill();
    }
  },
);

test(
  'a shell running nothing is an empty answer, not a failed tick',
  { skip: !posix },
  async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const children = await childrenOf(String(child.pid));
      assert.equal(children.size, 0);
    } finally {
      child.kill();
    }
  },
);

/**
 * The gap between ticks is measured from the end of one to the start of the
 * next, whatever a tick costs. Measured from start to start — which is what an
 * interval does — a tick slower than the interval is followed by the next one
 * with no pause at all, and on a machine with a few thousand processes every
 * tick was slower than the interval. The watcher then ran continuously, on the
 * same thread that carries keystrokes to the shell.
 */
const { CwdWatcher } = require('../electron/cwd-watcher');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A watcher whose ticks cost what the test says, and never touch the OS. */
function slowWatcher(tickMs) {
  const watcher = new CwdWatcher(
    () => [],
    () => {},
  );
  watcher.supported = true;
  watcher.starts = [];
  watcher.poll = async () => {
    watcher.starts.push(Date.now());
    await sleep(tickMs);
  };
  return watcher;
}

test('a tick slower than the interval is still followed by a full interval of quiet', async () => {
  const watcher = slowWatcher(120);
  watcher.everyMs = 50;
  watcher.start();
  await sleep(600);
  watcher.stop();
  const gaps = watcher.starts.slice(1).map((at, i) => at - watcher.starts[i]);
  assert.ok(
    gaps.length >= 2,
    `expected a few ticks, got ${watcher.starts.length}`,
  );
  for (const gap of gaps)
    assert.ok(
      gap >= 120 + 50 - 5,
      `a tick started only ${gap}ms after the last one began`,
    );
});

test('waking mid-tick changes the rate the tick re-arms at, and nothing else', async () => {
  const watcher = slowWatcher(80);
  watcher.everyMs = 30;
  watcher.start();
  await sleep(45); // inside the first tick
  watcher.everyMs = 10000; // as though it had gone idle
  watcher.wake();
  assert.equal(watcher.timer, null, 'no timer is armed while a tick runs');
  assert.equal(
    watcher.everyMs,
    2500,
    'but the rate it will re-arm at is the fast one',
  );
  watcher.stop();
});

test('stopping mid-tick means no further tick', async () => {
  const watcher = slowWatcher(60);
  watcher.everyMs = 10;
  watcher.start();
  await sleep(30); // inside the first tick
  watcher.stop();
  await sleep(150);
  assert.equal(watcher.starts.length, 1);
  assert.equal(watcher.timer, null);
});
