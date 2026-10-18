'use strict';

/*
 * The Terminal extension, from the main process's side: what a manifest may
 * switch on, the screens kept across a restart, and a pty paused for a terminal
 * that has fallen behind.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover, gallery, terminalContributions } = require('../electron/extensions.js');
const { ScrollbackStore, MAX_BYTES, KEEP_MS } = require('../electron/scrollback-store.js');

const row = (contributes, extra = {}) => ({ id: 'x', status: 'installed', enabled: true, contributes, ...extra });

test('the shipped Terminal extension is a valid manifest that switches everything on', () => {
  const found = discover(path.join(__dirname, '..', 'extensions'), { builtIn: true }).find((one) => one.id === 'terminal');
  assert.ok(found, 'extensions/terminal is discovered');
  const rows = gallery([found], [{ id: 'terminal', version: found.version }]);
  const got = terminalContributions(rows);
  assert.deepEqual(got.problems, []);
  assert.equal(got.features.length, 7);
  assert.deepEqual(got.palettes.map((one) => one.id), ['terminal:tokyo-night', 'terminal:one-dark', 'terminal:kanagawa']);
});

test('nothing is contributed by an extension that is off, not installed, or gone', () => {
  const terminal = { features: ['copy-on-select'] };
  for (const extra of [{ enabled: false }, { status: 'available' }, { status: 'gone' }]) {
    assert.deepEqual(terminalContributions([row({ terminal }, extra)]).features, []);
  }
});

test('a feature the app does not have is reported, not invented', () => {
  const got = terminalContributions([row({ terminal: { features: ['copy-on-select', 'telepathy'] } })]);
  assert.deepEqual(got.features, ['copy-on-select']);
  assert.match(got.problems[0].error, /telepathy/);
});

test('a palette is colours only, and cannot take the name of one of the app\'s own', () => {
  const got = terminalContributions([
    row({
      terminal: {
        palettes: [
          { id: 'midnight', name: 'Mine', theme: { background: '#000000', foreground: '#ffffff', fontFamily: 'Comic Sans' } },
          { id: 'bad', theme: { background: 'url(x)', foreground: '#ffffff' } },
          { id: 'thin', theme: { background: '#000000' } },
        ],
      },
    }),
  ]);
  assert.equal(got.palettes.length, 1);
  assert.equal(got.palettes[0].id, 'x:midnight', 'prefixed with the extension, so it never replaces the app\'s');
  assert.deepEqual(Object.keys(got.palettes[0].theme), ['background', 'foreground']);
  assert.equal(got.problems.length, 2);
});

test('a kept screen is saved, read back, forgotten and cleared', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollback-'));
  const store = new ScrollbackStore(path.join(dir, 'kept'));
  assert.equal(store.read('abc'), null);
  assert.equal(store.save('abc', '\x1b[1mhello\x1b[0m'), true);
  assert.equal(store.read('abc'), '\x1b[1mhello\x1b[0m');
  store.forget('abc');
  assert.equal(store.read('abc'), null);
  store.save('def', 'x');
  store.clear();
  assert.equal(store.read('def'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an id that could name a path, or a screen past the cap, is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollback-'));
  const store = new ScrollbackStore(dir);
  assert.equal(store.save('../escape', 'x'), false);
  assert.equal(store.read('../../etc/passwd'), null);
  assert.equal(store.save('big', 'x'.repeat(MAX_BYTES + 1)), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('screens nobody has asked for in a month are pruned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollback-'));
  const clock = { t: Date.now() };
  const store = new ScrollbackStore(dir, { now: () => clock.t });
  store.save('old', 'x');
  store.save('new', 'y');
  const old = new Date(clock.t - KEEP_MS - 1000);
  fs.utimesSync(path.join(dir, 'old.vt'), old, old);
  assert.equal(store.prune(), 1);
  assert.equal(store.read('old'), null);
  assert.equal(store.read('new'), 'y');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pty paused for a terminal that fell behind resumes on its own if nobody says so', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { PtyManager } = require('../electron/pty-manager.js');
  const ptys = new PtyManager(() => {});
  const calls = [];
  ptys.sessions.set('p1', { id: 'p1', proc: { pause: () => calls.push('pause'), resume: () => calls.push('resume') } });

  ptys.flow('p1', true);
  ptys.flow('p1', true);
  assert.deepEqual(calls, ['pause'], 'asking twice pauses once');
  t.mock.timers.tick(2999);
  assert.deepEqual(calls, ['pause']);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ['pause', 'resume'], 'a window that reloaded mid-pause cannot leave it blocked');

  ptys.flow('p1', true);
  ptys.flow('p1', false);
  t.mock.timers.tick(5000);
  assert.deepEqual(calls, ['pause', 'resume', 'pause', 'resume'], 'resumed by hand, the lapse does nothing more');
  ptys.flow('gone', true);
});

// --- installed on the upgrade that brings it, once -------------------------

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}
const { Database } = sqlite ? require('../electron/database') : {};
const skipDb = sqlite ? false : 'node:sqlite needs Node 22 or newer';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-arrivals-'));
  return { db: new Database(path.join(dir, 'test.db')), dir };
}

const markdown = { id: 'markdown', name: 'Markdown', version: '1.0.0' };
const yaml = { id: 'yaml', name: 'YAML', version: '1.0.0' };
const terminal = { id: 'terminal', name: 'Terminal', version: '1.0.0', installOnUpgrade: true };
const ids = (db) => db.installedExtensions().map((row) => row.id).sort();

test('an existing install gets the Terminal extension on the upgrade, and an ordinary newcomer is only offered', { skip: skipDb }, () => {
  const { db, dir } = freshDb();
  try {
    db.seedExtensions([markdown]);
    assert.deepEqual(ids(db), ['markdown'], 'the first run installs what shipped');

    db.seedExtensions([markdown, yaml, terminal]);
    assert.deepEqual(ids(db), ['markdown', 'terminal'], 'yaml is an offer; terminal asked to be installed');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removed or switched off after it arrived, it stays that way', { skip: skipDb }, () => {
  const { db, dir } = freshDb();
  try {
    db.seedExtensions([markdown]);
    db.seedExtensions([markdown, terminal]);
    db.removeExtension('terminal');
    db.seedExtensions([markdown, terminal]);
    assert.deepEqual(ids(db), ['markdown'], 'not put back after being removed');

    db.installExtension(terminal);
    db.enableExtension('terminal', false);
    db.seedExtensions([markdown, terminal]);
    assert.equal(db.installedExtensions().find((row) => row.id === 'terminal').enabled, false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped Terminal manifest asks to be installed on upgrade', () => {
  const found = discover(path.join(__dirname, '..', 'extensions'), { builtIn: true });
  assert.equal(found.find((one) => one.id === 'terminal').installOnUpgrade, true);
  assert.equal(found.find((one) => one.id === 'markdown').installOnUpgrade, false);
});
