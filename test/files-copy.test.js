'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyInto, filenamesPlist, readFilenamesPlist } = require('../electron/files');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-copy-'));
  fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'src/lib/b.txt'), 'b');
  fs.writeFileSync(path.join(root, 'notes.md'), 'notes');
  fs.mkdirSync(path.join(root, 'dest'));
  return root;
}

test('a folder is copied with everything in it, and files beside it', async () => {
  const root = tree();
  const out = await copyInto([path.join(root, 'src'), path.join(root, 'notes.md')], path.join(root, 'dest'));
  assert.equal(out.ok, true);
  assert.deepEqual(out.copied, [path.join(root, 'dest/src'), path.join(root, 'dest/notes.md')]);
  assert.equal(fs.readFileSync(path.join(root, 'dest/src/lib/b.txt'), 'utf8'), 'b');
  assert.equal(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8'), 'a', 'the original is untouched');
});

test('a name that is taken gets a copy name; nothing is ever overwritten', async () => {
  const root = tree();
  fs.writeFileSync(path.join(root, 'dest/notes.md'), 'mine');
  await copyInto([path.join(root, 'notes.md')], path.join(root, 'dest'));
  await copyInto([path.join(root, 'notes.md')], path.join(root, 'dest'));
  assert.equal(fs.readFileSync(path.join(root, 'dest/notes.md'), 'utf8'), 'mine');
  assert.ok(fs.existsSync(path.join(root, 'dest/notes copy.md')));
  assert.ok(fs.existsSync(path.join(root, 'dest/notes copy 2.md')));
  // Pasting into the folder it came from is a duplicate, not a no-op.
  const same = await copyInto([path.join(root, 'src')], root);
  assert.deepEqual(same.copied, [path.join(root, 'src copy')]);
});

test('a folder cannot be pasted inside itself', async () => {
  const root = tree();
  const out = await copyInto([path.join(root, 'src')], path.join(root, 'src/lib'));
  assert.equal(out.ok, false);
  assert.match(out.error, /inside itself/);
  assert.equal(fs.existsSync(path.join(root, 'src/lib/src')), false);
});

test('one that fails does not stop the others, and says which', async () => {
  const root = tree();
  const out = await copyInto([path.join(root, 'gone.txt'), path.join(root, 'notes.md')], path.join(root, 'dest'));
  assert.equal(out.ok, true);
  assert.equal(out.copied.length, 1);
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].error, /not there/);
});

test('a link is copied as a link, not as what it points at', async () => {
  const root = tree();
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'st-big-'));
  fs.writeFileSync(path.join(big, 'huge.bin'), 'x');
  fs.symlinkSync(big, path.join(root, 'src/elsewhere'));
  await copyInto([path.join(root, 'src')], path.join(root, 'dest'));
  assert.equal(fs.lstatSync(path.join(root, 'dest/src/elsewhere')).isSymbolicLink(), true);
});

test('only a real folder takes a paste, and relative paths are refused', async () => {
  const root = tree();
  await assert.rejects(copyInto([path.join(root, 'notes.md')], path.join(root, 'notes.md')), /not a folder/);
  const out = await copyInto(['notes.md'], path.join(root, 'dest'));
  assert.equal(out.ok, false);
});

test("Finder's list of files is written and read back, names and all", () => {
  const names = ['/tmp/a & b', '/tmp/<odd>', '/tmp/ñandú.txt'];
  assert.deepEqual(readFilenamesPlist(filenamesPlist(names)), names);
  assert.deepEqual(readFilenamesPlist('<plist><array><string>relative</string></array></plist>'), []);
});
