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
