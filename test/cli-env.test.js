const assert = require('node:assert');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const {
  mergePaths,
  parseShellPath,
  resolvedPath,
  forgetResolvedPath,
  askShellForPath,
} = require('../electron/cli-env');

/*
 * Why this file exists: launched from Finder the app inherits launchd's bare
 * PATH, and `zsh -lc` does not fix it — a non-interactive login shell never reads
 * .zshrc, which is where PATH additions live. The CLI is then not found, the
 * account reads as signed out, and the usage gauge and panel — both gated on
 * being signed in — render nothing at all.
 */

test('the PATH is the last line, so a chatty profile cannot bury it', () => {
  // `printf %s` ends without a newline; anything a profile printed is above it.
  const stdout = 'Welcome back!\nnvm: loaded\n/opt/homebrew/bin:/usr/bin:/bin';
  assert.strictEqual(parseShellPath(stdout), '/opt/homebrew/bin:/usr/bin:/bin');
});

test('a shell that said nothing useful is refused rather than believed', () => {
  assert.strictEqual(parseShellPath(''), null);
  assert.strictEqual(parseShellPath('\n\n'), null);
  assert.strictEqual(parseShellPath('some greeting with no path in it'), null);
  assert.strictEqual(parseShellPath(undefined), null);
});

test('what the app already has comes first, and additions follow', () => {
  assert.strictEqual(
    mergePaths('/usr/bin:/bin', '/Users/x/.local/bin:/usr/bin'),
    '/usr/bin:/bin:/Users/x/.local/bin',
  );
});

test('a directory is never listed twice, whichever side it came from', () => {
  const merged = mergePaths('/a:/b:/a', '/b:/c:/c');
  assert.strictEqual(merged, '/a:/b:/c');
});

test('an empty side changes nothing', () => {
  assert.strictEqual(mergePaths('/a:/b', ''), '/a:/b');
  assert.strictEqual(mergePaths('', '/a:/b'), '/a:/b');
  assert.strictEqual(mergePaths(null, null), '');
});

test('empty segments are dropped rather than turned into the current directory', () => {
  // A trailing colon in PATH means "here", which is not something to inherit.
  assert.strictEqual(mergePaths('/a::/b:', ''), '/a:/b');
});

test('sixty callers at once cost one login shell, not sixty', async () => {
  /*
   * The cache only ever helped callers arriving *after* an answer. Everyone who
   * asked while one was in the air spawned an interactive login shell of their
   * own — measured at a hundred and forty at once on a real machine, with a
   * workspace restoring its sessions and a panel wanting a PATH. They arrived
   * faster than they finished, and the one that asked first was still waiting
   * minutes later.
   */
  forgetResolvedPath();
  let asked = 0;
  const ask = () => {
    asked += 1;
    return new Promise((resolve) => setTimeout(() => resolve('/usr/bin:/bin'), 30));
  };

  const answers = await Promise.all(Array.from({ length: 60 }, () => resolvedPath('/bin/zsh', { ask })));
  assert.equal(asked, 1, `asked the shell ${asked} times for one answer`);
  assert.equal(new Set(answers).size, 1, 'everyone got the same PATH');
  assert.match(answers[0], /\/usr\/bin/);

  // Afterwards the cache answers without asking at all.
  await resolvedPath('/bin/zsh', { ask });
  assert.equal(asked, 1);

  // A different shell is a different question.
  await resolvedPath('/bin/bash', { ask });
  assert.equal(asked, 2);
  forgetResolvedPath();
});

test('a shell that never answers does not hang the app, and is not left running', async () => {
  /*
   * An *interactive* shell ignores SIGTERM — that is what interactive means —
   * so `execFile`'s own timeout sends a signal the child may disregard and then
   * waits for a callback that never comes. Measured on a real machine: shells
   * still running seventy seconds after an eight-second timeout, and with them
   * every part of the app that needs a PATH — the account check, the usage
   * gauge, kubectl, helm — waiting for ever, silently.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-test-'));
  const fake = path.join(dir, 'hangs');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 60\n');
  fs.chmodSync(fake, 0o755);

  try {
    const started = Date.now();
    const answer = await askShellForPath(fake, 200);
    const took = Date.now() - started;

    assert.equal(answer, null, 'a shell that said nothing is reported as having said nothing');
    assert.ok(took < 3000, `waited ${took}ms on a shell that never answers`);

    // And nothing is left running: SIGKILL, because SIGTERM is optional to it.
    const left = Number(execSync(`pgrep -f ${fake} | wc -l`).toString().trim());
    assert.equal(left, 0, `${left} left behind`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
