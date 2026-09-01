const assert = require('node:assert');
const test = require('node:test');

const { mergePaths, parseShellPath } = require('../electron/cli-env');

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
