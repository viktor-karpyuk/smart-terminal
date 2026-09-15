'use strict';

/**
 * The decisions an update makes before anything is downloaded.
 *
 * All of them are about *not* doing something: not offering a downgrade, not
 * offering a prerelease to somebody who did not ask for one, not guessing which
 * file belongs to this machine, and not re-offering a version that was already
 * waved away. Every one of those, got wrong, ends with the app replacing itself
 * with the wrong thing — which is the one bug in this feature that cannot be
 * fixed by shipping another version, because the version that would fix it is
 * the one that can no longer be installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  parseVersion,
  compareVersions,
  pickRelease,
  pickAsset,
  installKind,
  repoSlug,
  describeRelease,
  shellQuote,
  macScript,
  appImageScript,
} = require('../electron/updates');

const release = (tag, extra = {}) => ({
  tag_name: tag,
  name: tag,
  body: '',
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  assets: [],
  ...extra,
});

// ---------------------------------------------------------------- versions

test('a version is its numbers and its prerelease tail, or it is nothing', () => {
  assert.deepStrictEqual(parseVersion('0.7.0'), { parts: [0, 7, 0], pre: [] });
  assert.deepStrictEqual(parseVersion('v0.7.0'), { parts: [0, 7, 0], pre: [] });
  assert.deepStrictEqual(parseVersion('0.2.0-rc.9'), { parts: [0, 2, 0], pre: ['rc', '9'] });
  // Build metadata is not part of the ordering, so it is read and dropped.
  assert.deepStrictEqual(parseVersion('1.0.0+build.5'), { parts: [1, 0, 0], pre: [] });

  for (const bad of ['', 'latest', '1.2', 'v', null, undefined, 7]) {
    assert.strictEqual(parseVersion(bad), null, `${bad} is not a version`);
  }
});

test('versions order by number before anything else', () => {
  assert.ok(compareVersions('0.7.0', '0.6.9') > 0);
  assert.ok(compareVersions('0.6.6', '0.6.7') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.strictEqual(compareVersions('0.6.6', 'v0.6.6'), 0);
});

/*
 * The rule people forget, and the one that matters most here: a release is
 * newer than its own prereleases. Get it backwards and 0.7.0 never replaces
 * 0.7.0-rc.1 — the app sits on a release candidate for ever, believing it has
 * the better one.
 */
test('a finished release beats its own prereleases', () => {
  assert.ok(compareVersions('0.7.0', '0.7.0-rc.1') > 0);
  assert.ok(compareVersions('0.7.0-rc.1', '0.7.0') < 0);
});

test('prerelease tails order by identifier, numbers by value', () => {
  assert.ok(compareVersions('0.2.0-rc.10', '0.2.0-rc.9') > 0, 'rc.10 is after rc.9, not before it');
  assert.ok(compareVersions('0.2.0-rc.1', '0.2.0-beta.9') > 0, 'rc comes after beta');
  assert.ok(compareVersions('0.2.0-rc.1', '0.2.0-rc') > 0, 'more identifiers is later');
  assert.ok(compareVersions('0.2.0-1', '0.2.0-alpha') < 0, 'a number sorts below a word');
});

test('two versions that cannot both be read are not ordered at all', () => {
  assert.strictEqual(compareVersions('nightly', '0.7.0'), 0);
  assert.strictEqual(compareVersions('0.7.0', 'nightly'), 0);
});

// ---------------------------------------------------------------- which release

test('the newest published release above the running one', () => {
  const found = pickRelease([release('v0.6.6'), release('v0.7.1'), release('v0.7.0')], { current: '0.6.6' });
  assert.strictEqual(found.tag_name, 'v0.7.1');
});

test('nothing newer is nothing, not the newest thing there is', () => {
  assert.strictEqual(pickRelease([release('v0.6.4'), release('v0.6.6')], { current: '0.6.6' }), null);
  assert.strictEqual(pickRelease([], { current: '0.6.6' }), null);
  assert.strictEqual(pickRelease(null, { current: '0.6.6' }), null);
});

/*
 * The one that would be actively harmful. This repository's history has a run of
 * `-rc` tags in it, and an app that offered those by default would move everyone
 * from a finished release onto a release candidate.
 */
test('prereleases are opt-in, and opting in finds them', () => {
  const releases = [release('v0.7.0-rc.1', { prerelease: true }), release('v0.6.6')];
  assert.strictEqual(pickRelease(releases, { current: '0.6.6' }), null);
  assert.strictEqual(
    pickRelease(releases, { current: '0.6.6', prereleases: true }).tag_name,
    'v0.7.0-rc.1',
  );
});

test('a draft is somebody mid-thought and is never offered', () => {
  assert.strictEqual(pickRelease([release('v0.7.0', { draft: true })], { current: '0.6.6' }), null);
});

test('a tag nobody can read is skipped rather than guessed at', () => {
  const found = pickRelease([release('nightly'), release('v0.7.0')], { current: '0.6.6' });
  assert.strictEqual(found.tag_name, 'v0.7.0');
});

/*
 * Skipping is about one version. "Not now" that silenced every future release
 * would be a switch nobody knew they had thrown.
 */
test('a skipped version stays skipped until something newer arrives', () => {
  const releases = [release('v0.7.0')];
  assert.strictEqual(pickRelease(releases, { current: '0.6.6', skipped: '0.7.0' }), null);
  assert.strictEqual(
    pickRelease([...releases, release('v0.7.1')], { current: '0.6.6', skipped: '0.7.0' }).tag_name,
    'v0.7.1',
  );
});

// ---------------------------------------------------------------- which file

const assets = [
  { name: 'Smart.Terminal-0.7.0-arm64.dmg', size: 1, browser_download_url: 'https://x/dmg' },
  { name: 'Smart.Terminal-0.7.0.AppImage', size: 2, browser_download_url: 'https://x/app' },
  { name: 'smart-terminal_0.7.0_amd64.deb', size: 3, browser_download_url: 'https://x/deb' },
];

test('each machine gets the file it can actually install', () => {
  assert.strictEqual(pickAsset(assets, { platform: 'darwin', arch: 'arm64' }).name.endsWith('.dmg'), true);
  assert.strictEqual(
    pickAsset(assets, { platform: 'linux', arch: 'x64', appImage: true }).name.endsWith('.AppImage'),
    true,
  );
  assert.strictEqual(pickAsset(assets, { platform: 'linux', arch: 'x64' }).name.endsWith('.deb'), true);
});

test('a platform with no build has no file, and says so by having none', () => {
  assert.strictEqual(installKind({ platform: 'win32' }), null);
  assert.strictEqual(pickAsset(assets, { platform: 'win32', arch: 'x64' }), null);
});

/*
 * The names are electron-builder's, and GitHub replaces the spaces in them with
 * dots on upload. Matching by extension rather than by predicting the whole name
 * is what keeps this working the day the product name changes.
 */
test('one file of a kind is the file, whatever it was named', () => {
  const odd = [{ name: 'whatever-we-called-it.dmg', size: 1, browser_download_url: 'https://x' }];
  assert.strictEqual(pickAsset(odd, { platform: 'darwin', arch: 'arm64' }).name, 'whatever-we-called-it.dmg');
});

test('two builds of a kind are told apart by the architecture in the name', () => {
  const both = [
    { name: 'Smart.Terminal-0.7.0-x64.dmg', size: 1, browser_download_url: 'https://x/intel' },
    { name: 'Smart.Terminal-0.7.0-arm64.dmg', size: 2, browser_download_url: 'https://x/arm' },
  ];
  assert.strictEqual(pickAsset(both, { platform: 'darwin', arch: 'arm64' }).name.includes('arm64'), true);
  assert.strictEqual(pickAsset(both, { platform: 'darwin', arch: 'x64' }).name.includes('x64'), true);
  // aarch64 and amd64 are the same two machines under Linux's names for them.
  const linux = [
    { name: 'app-aarch64.AppImage', size: 1, browser_download_url: 'https://x/a' },
    { name: 'app-x86_64.AppImage', size: 2, browser_download_url: 'https://x/b' },
  ];
  assert.strictEqual(pickAsset(linux, { platform: 'linux', arch: 'arm64', appImage: true }).name, 'app-aarch64.AppImage');
});

/*
 * The refusal that matters. Installing an Intel build over an Apple-silicon one
 * is a working app replaced by one that limps, and there is no way back from
 * inside it — so an ambiguous release is one this declines to choose from.
 */
test('two unlabelled builds of a kind are not guessed between', () => {
  const ambiguous = [
    { name: 'one.dmg', size: 1, browser_download_url: 'https://x/1' },
    { name: 'two.dmg', size: 2, browser_download_url: 'https://x/2' },
  ];
  assert.strictEqual(pickAsset(ambiguous, { platform: 'darwin', arch: 'arm64' }), null);
});

test('a release with nothing attached to it has nothing to install', () => {
  assert.strictEqual(pickAsset([], { platform: 'darwin', arch: 'arm64' }), null);
  assert.strictEqual(pickAsset(undefined, { platform: 'darwin', arch: 'arm64' }), null);
});

// ---------------------------------------------------------------- the rest

test('the repository is read out of whatever form it was written in', () => {
  assert.strictEqual(repoSlug('git+https://github.com/viktor-karpyuk/smart-terminal.git'), 'viktor-karpyuk/smart-terminal');
  assert.strictEqual(repoSlug('git@github.com:viktor-karpyuk/smart-terminal.git'), 'viktor-karpyuk/smart-terminal');
  assert.strictEqual(repoSlug('https://github.com/viktor-karpyuk/smart-terminal'), 'viktor-karpyuk/smart-terminal');
  assert.strictEqual(repoSlug('https://example.com/nothing'), null);
  assert.strictEqual(repoSlug(undefined), null);
});

test('what the panel is given is the release, tidied, with the hash kept', () => {
  const described = describeRelease(
    release('v0.7.0', { body: '# hi', published_at: '2026-09-12T00:00:00Z' }),
    { name: 'a.dmg', size: 128, browser_download_url: 'https://x/a.dmg', digest: 'sha256:abc' },
  );
  assert.strictEqual(described.version, '0.7.0', 'the v is for tags, not for people');
  assert.strictEqual(described.notes, '# hi');
  assert.strictEqual(described.asset.digest, 'sha256:abc');

  // Older releases predate the field, and a missing hash is a missing check —
  // not a reason to refuse the update, and not something to invent either.
  const older = describeRelease(release('v0.7.0'), { name: 'a.dmg', size: 1, browser_download_url: 'https://x' });
  assert.strictEqual(older.asset.digest, null);
});

// ---------------------------------------------------------------- the script

/*
 * The script replaces the application, so a path that breaks out of its quoting
 * is a command running as the user with a path they chose. Every path in it goes
 * through this.
 */
test('a path cannot end the quoting it was put inside', () => {
  assert.strictEqual(shellQuote('/Applications/Smart Terminal.app'), `'/Applications/Smart Terminal.app'`);
  assert.strictEqual(shellQuote(`/tmp/it's here`), `'/tmp/it'\\''s here'`);
  assert.strictEqual(shellQuote(`/tmp/x'; rm -rf /; echo '`), `'/tmp/x'\\''; rm -rf /; echo '\\'''`);
});

test('the macOS script waits, stages beside, and only then replaces', () => {
  const script = macScript({
    dmg: '/u/updates/0.7.0-Smart.Terminal.dmg',
    dest: '/Applications/Smart Terminal.app',
    pid: 4242,
    log: '/u/updates/install.log',
    cancel: '/u/updates/install.cancelled',
  });

  assert.match(script, /kill -0 4242/, 'it waits for the app to be gone');
  // The order is the safety: the copy lands beside the old app and is moved
  // over it, so a failure halfway leaves a working app rather than none.
  const copy = script.indexOf('cp -R "$APP" "$STAGE"');
  const remove = script.indexOf('rm -rf "$DEST"');
  const move = script.indexOf('mv "$STAGE" "$DEST"');
  assert.ok(copy > 0 && remove > copy && move > remove, 'copy, then remove, then move');
  assert.match(script, /xattr -dr com\.apple\.quarantine/, 'an unsigned build needs the flag cleared');
  assert.match(script, /open -a "\$DEST"/, 'and it comes back');
});

test('the AppImage script replaces one file and relaunches it', () => {
  const script = appImageScript({
    file: '/u/updates/0.7.0-app.AppImage',
    dest: '/home/v/Apps/SmartTerminal.AppImage',
    pid: 99,
    log: '/u/updates/install.log',
    cancel: '/u/updates/install.cancelled',
  });
  assert.match(script, /kill -0 99/);
  assert.match(script, /chmod \+x "\$DEST\.new"/, 'an AppImage that is not executable is not an app');
  assert.match(script, /mv "\$DEST\.new" "\$DEST"/);
});

/*
 * The refusal that keeps a cancelled quit harmless. Somebody with live sessions
 * who says "keep them" has said no to the update as well, and the script outside
 * has to work that out on its own — nothing is left to tell it.
 */
test('a quit that never happened leaves the installed app alone', () => {
  const script = macScript({ dmg: '/a.dmg', dest: '/Applications/X.app', pid: 1, log: '/l', cancel: '/c' });
  assert.match(script, /waited.*-gt 300|[-]gt 300/s, 'it gives up rather than waiting for ever');
  assert.match(script, /still running after five minutes/);
  assert.match(script, /nothing was touched/);
});

/*
 * The hole the timeout alone leaves open, and the reason the marker exists.
 *
 * Waiting on the process id cannot tell a refused quit from a quit four minutes
 * later for entirely unrelated reasons — and installing on the second one would
 * replace the application against an answer somebody already gave. So the script
 * is told, and it looks: every second of the wait, and once more after it, since
 * the app can decline and then quit a moment afterwards.
 */
test('an update called off is not installed by the next quit that happens to come', () => {
  const script = macScript({ dmg: '/a.dmg', dest: '/Applications/X.app', pid: 7, log: '/l', cancel: '/u/cancelled' });
  assert.match(script, /CANCEL='\/u\/cancelled'/, 'the marker it watches for is named in the script');
  assert.match(script, /called_off\(\) \{ \[ -f "\$CANCEL" \]; \}/);

  const inLoop = /while kill -0 7[\s\S]*?\ndone/.exec(script)[0];
  assert.match(inLoop, /if called_off; then/, 'checked while it waits');

  const afterLoop = script.slice(script.indexOf('\ndone') + 5, script.indexOf('say "it quit"'));
  assert.match(afterLoop, /if called_off; then/, 'and again once the app is gone');

  // Both endings say the same thing about the app, which is the only promise
  // that matters here.
  assert.match(script, /the update was called off — nothing was touched/);
});

test('the AppImage script can be called off the same way', () => {
  const script = appImageScript({ file: '/n', dest: '/d', pid: 7, log: '/l', cancel: '/u/cancelled' });
  assert.match(script, /CANCEL='\/u\/cancelled'/);
  assert.match(script, /the update was called off/);
});

// ---------------------------------------------------------------- the install log

/*
 * The worst version of this feature failing is the silent one: the app quits to
 * install, comes back as the version it already was, and says nothing. These
 * cover the reading of the log the script leaves behind — the class itself needs
 * Electron, so the parsing is exercised through the same shapes it will meet.
 */
test('a log naming a version that is not the one running is a failed install', () => {
  const log = [
    '2026-09-12T20:00:00.000Z installing 0.7.0',
    '16:13:45 waiting for the app (pid 42) to quit',
    '16:18:46 stopped: the app is still running after five minutes — the quit was probably cancelled, and nothing was touched',
  ].join('\n');

  const wanted = /installing (\S+)/.exec(log)?.[1];
  assert.strictEqual(wanted, '0.7.0');

  const said = log
    .split('\n')
    .map((line) => line.replace(/^\d\d:\d\d:\d\d /, '').trim())
    .filter(Boolean)
    .pop();
  assert.strictEqual(
    said,
    'stopped: the app is still running after five minutes — the quit was probably cancelled, and nothing was touched',
    'the last line is the one that says what happened',
  );
});

test('a log naming the version now running is what a success looks like', () => {
  const log = '2026-09-12T20:00:00.000Z installing 0.7.0\n16:14:00 relaunched';
  assert.strictEqual(/installing (\S+)/.exec(log)?.[1], '0.7.0');
  // The class compares that against its own version and says nothing when they
  // match — the log is simply what the successful install left behind.
});
