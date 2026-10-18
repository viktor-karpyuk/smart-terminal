'use strict';

/**
 * Measuring on a thread and remembering the answer.
 *
 * What is checked is what a person notices: a tree adds up to the bytes in
 * it, a link is not followed into somewhere else, a second look costs no
 * walk while nothing changed, and a change or an old answer brings the walk
 * back.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiskUsage } = require('../electron/disk-usage');
const { measure } = require('../electron/disk-usage-worker');

const made = [];
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-du-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, 'a', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'one.txt'), 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'a', 'deep', 'two.txt'), 'y'.repeat(250));
  fs.writeFileSync(path.join(dir, 'three.bin'), Buffer.alloc(1024));
  return dir;
}

test('a tree adds up to the bytes of the files in it', () => {
  const dir = tree();
  const { bytes, files } = measure(dir);
  assert.equal(bytes, 1374);
  assert.equal(files, 3);
});

test('a long walk reports its running total on the way', () => {
  const dir = tree();
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `f${i}`), 'a');
  const seen = [];
  const { files } = measure(dir, (p) => seen.push(p.files), 5);
  assert.equal(files, 15);
  assert.ok(seen.length >= 2, 'reported more than once');
  assert.ok(seen.every((n, i) => i === 0 || n > seen[i - 1]), 'totals only grow');
});

test('a symbolic link is counted as the link and never followed', () => {
  const dir = tree();
  const other = tree();
  fs.symlinkSync(other, path.join(dir, 'elsewhere'));
  const { bytes, files } = measure(dir);
  assert.equal(files, 4);
  assert.ok(bytes < 1374 + 1374, 'the linked tree was not added');
});

test('measure walks once, answers from memory while fresh, and walks again when the folder changes or the answer ages', async () => {
  const dir = tree();
  let clock = 1_000_000;
  const remembered = [];
  const store = { sizes: () => [], rememberSize: (p, row) => remembered.push([p, row.bytes]), forgetSize: () => {} };
  const sizes = new DiskUsage({ store, ttl: 60_000, now: () => clock });
  try {
    const first = await sizes.measure([dir]);
    assert.equal(first.get(dir).bytes, 1374);
    assert.equal(remembered.length, 1);
    assert.ok(sizes.fresh(dir));

    const again = await sizes.measure([dir]);
    assert.equal(again.get(dir).bytes, 1374);
    assert.equal(remembered.length, 1, 'no second walk while fresh');

    // A new entry directly inside moves the folder's mtime.
    fs.writeFileSync(path.join(dir, 'four.txt'), 'zz');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(dir, future, future);
    assert.ok(!sizes.fresh(dir));
    const third = await sizes.measure([dir]);
    assert.equal(third.get(dir).bytes, 1376);
    assert.equal(remembered.length, 2);

    clock += 61_000;
    assert.ok(!sizes.fresh(dir), 'an old answer is not trusted');
    await sizes.measure([dir]);
    assert.equal(remembered.length, 3);
  } finally {
    sizes.stop();
  }
});

test('a path that does not exist measures as nothing rather than failing the batch', async () => {
  const dir = tree();
  const sizes = new DiskUsage({ ttl: 60_000 });
  try {
    const seen = [];
    const out = await sizes.measure([dir, path.join(dir, 'missing')], { onEach: (p) => seen.push(path.basename(p)) });
    assert.equal(out.get(path.join(dir, 'missing')).bytes, 0);
    assert.equal(out.get(dir).bytes, 1374);
    assert.deepEqual(seen.sort(), ['missing', path.basename(dir)].sort());
  } finally {
    sizes.stop();
  }
});

test('known sizes from the store are trusted on start and forgotten on request', () => {
  const store = { sizes: () => [{ path: '/x', bytes: 7, files: 1, mtime: 0, measuredAt: 0 }], rememberSize: () => {}, forgetSize: () => {} };
  const sizes = new DiskUsage({ store });
  assert.equal(sizes.known('/x').bytes, 7);
  sizes.forget('/x');
  assert.equal(sizes.known('/x'), null);
});
