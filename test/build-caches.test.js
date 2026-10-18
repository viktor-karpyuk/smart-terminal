'use strict';

/**
 * Build caches: found only by name, removed only when git ignores them, and
 * removed as a rename first so a build that starts a moment later does not see
 * a folder half deleted.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const caches = require('../electron/build-caches');

const made = [];
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function repo({ ignore = 'node_modules\n.angular\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-caches-'));
  made.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
  fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), '//');
  fs.mkdirSync(path.join(dir, '.angular', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist', 'shipped.js'), 'kept');
  fs.mkdirSync(path.join(dir, 'src'));
  return dir;
}

test('findIn lists the known cache folders present, in the order they are shown', () => {
  const dir = repo();
  assert.deepEqual(caches.findIn(dir).map((one) => one.name), ['.angular', 'node_modules', 'dist']);
  assert.ok(caches.isCheckout(dir));
  assert.ok(!caches.isCheckout(path.join(dir, 'src')));
});

test('ignoredIn answers for many names in one process and remembers against .gitignore', async () => {
  const dir = repo();
  const first = await caches.ignoredIn(dir, ['node_modules', '.angular', 'dist']);
  assert.deepEqual([...first].sort(), ['.angular', 'node_modules']);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.angular\ndist\n');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, '.gitignore'), future, future);
  const second = await caches.ignoredIn(dir, ['node_modules', '.angular', 'dist']);
  assert.deepEqual([...second].sort(), ['.angular', 'dist', 'node_modules']);
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'st-loose-'));
  made.push(loose);
  assert.deepEqual([...(await caches.ignoredIn(loose, ['dist']))], [], 'a folder that is not a checkout ignores nothing');
});

test('a cache git ignores is renamed aside and deleted after; one git does not ignore is left alone', async () => {
  const dir = repo();
  const removed = [];
  const result = await caches.discard(path.join(dir, 'node_modules'), { now: 42, remove: async (p) => removed.push(p) });
  assert.equal(result.trash, path.join(dir, 'node_modules.trash-42'));
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules')));
  assert.ok(fs.existsSync(result.trash));
  assert.deepEqual(removed, [result.trash]);

  await assert.rejects(caches.discard(path.join(dir, 'dist'), { now: 43 }), /git does not ignore dist/);
  assert.ok(fs.existsSync(path.join(dir, 'dist', 'shipped.js')), 'committed-looking output is untouched');
});

test('only names on the list can be discarded, and a missing folder is already done', async () => {
  const dir = repo();
  await assert.rejects(caches.discard(path.join(dir, 'src')), /not a build cache/);
  const gone = await caches.discard(path.join(dir, '.angular'), { now: 1, remove: async () => {} });
  assert.ok(gone.trash);
  const again = await caches.discard(path.join(dir, '.angular'), { now: 2 });
  assert.equal(again.gone, true);
});

test('a symbolic link in a cache slot is unlinked, never followed', async () => {
  const dir = repo();
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'st-shared-'));
  made.push(shared);
  fs.writeFileSync(path.join(shared, 'keep.js'), 'mine');
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.symlinkSync(shared, path.join(dir, 'node_modules'));
  const result = await caches.discard(path.join(dir, 'node_modules'), { now: 5 });
  assert.equal(result.link, true);
  assert.ok(fs.existsSync(path.join(shared, 'keep.js')), 'the target survives');
});

test('sweep finishes removals a previous run left behind', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.angular.trash-7'));
  fs.mkdirSync(path.join(dir, 'target.trash-8'));
  assert.deepEqual(caches.pendingTrash([dir]).map((p) => path.basename(p)).sort(), ['.angular.trash-7', 'target.trash-8']);
  const swept = await caches.sweep([dir]);
  assert.equal(swept.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, '.angular.trash-7')));
  assert.deepEqual(caches.pendingTrash([dir]), []);
});
