'use strict';

/*
 * Changing the tree from the Files panel: renaming, moving, creating,
 * duplicating. The rules that matter are the ones that lose work when they
 * are wrong — nothing is overwritten, a folder cannot go into itself, a name
 * is a name — and the arithmetic of following a path to its new name in
 * everything the store keys by it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const files = require('../electron/files');
const ops = require('../.test-build/lib/fileOps');

const made = [];
function tree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-ops-'));
  made.push(root);
  for (const [rel, text] of Object.entries(spec)) {
    const full = path.join(root, rel);
    if (rel.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    }
  }
  return root;
}
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

test('a name is a name: no slashes, no dots alone, nothing invisible', () => {
  for (const check of [ops.nameProblem, files.nameProblem]) {
    assert.equal(check('notes.md'), null);
    assert.equal(check('.env'), null);
    assert.equal(check('with spaces.txt'), null);
    assert.match(check(''), /needed/);
    assert.match(check('   '), /needed/);
    assert.match(check(' x'), /space/);
    assert.match(check('.'), /not a name/);
    assert.match(check('..'), /not a name/);
    assert.match(check('a/b'), /slash/);
    assert.match(check('a\\b'), /slash/);
    assert.match(check('a\x00b'), /control/);
    assert.match(check('a:b'), /colon/);
    assert.match(check('x'.repeat(256)), /too long/);
  }
});

test('a path follows a rename everywhere it was known by the old one', () => {
  assert.equal(ops.movedPath('/w/a/b.txt', '/w/a', '/w/c'), '/w/c/b.txt');
  assert.equal(ops.movedPath('/w/a', '/w/a', '/w/c'), '/w/c');
  assert.equal(ops.movedPath('/w/ab/x', '/w/a', '/w/c'), '/w/ab/x', 'a sibling whose name starts the same is not under it');
  assert.equal(ops.movedPath('/elsewhere', '/w/a', '/w/c'), '/elsewhere');
  assert.equal(ops.parentOf('/w/a/b.txt'), '/w/a');
  assert.equal(ops.parentOf('/w'), '/');
  assert.equal(ops.baseOf('/w/a/b.txt'), 'b.txt');
  assert.equal(ops.isInside('/w/a/b', '/w/a'), true);
  assert.equal(ops.isInside('/w/a', '/w/a'), true);
  assert.equal(ops.isInside('/w/ab', '/w/a'), false);
  assert.equal(ops.isInside('/x', '/'), true);
  assert.equal(ops.moveProblem('/w/a', '/w/a/deep'), 'A folder cannot be moved into itself.');
  assert.equal(ops.moveProblem('/w/a', '/w/a'), 'A folder cannot be moved into itself.');
  assert.equal(ops.moveProblem('/w/a', '/w'), null, 'where it already is: nothing to do, nothing wrong');
  assert.equal(ops.moveProblem('/w/a', '/w/b'), null);
});

test('rename keeps what was there: nothing is overwritten, and a folder never goes into itself', async () => {
  const root = tree({ 'a.txt': 'A', 'b.txt': 'B', 'dir/': '', 'dir/inner.txt': 'I' });
  const renamed = await files.renamePath(path.join(root, 'a.txt'), path.join(root, 'c.txt'));
  assert.equal(renamed.ok, true);
  assert.equal(renamed.path, path.join(root, 'c.txt'));
  assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'A');
  assert.ok(!fs.existsSync(path.join(root, 'a.txt')));

  await assert.rejects(files.renamePath(path.join(root, 'c.txt'), path.join(root, 'b.txt')), /already something called b.txt/);
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'B', 'the other file is untouched');
  await assert.rejects(files.renamePath(path.join(root, 'dir'), path.join(root, 'dir', 'inside')), /into itself/);
  await assert.rejects(files.renamePath(path.join(root, 'nope'), path.join(root, 'x')), /not there/);
  await assert.rejects(files.renamePath(path.join(root, 'c.txt'), path.join(root, 'gone', 'name')), /folder to put it in is not there/);
  await assert.rejects(files.renamePath('relative', path.join(root, 'x')), /full path/);
  await assert.rejects(files.renamePath(path.join(root, 'c.txt'), path.join(root, ' spaced')), /space/);

  // A folder, with what is in it.
  const moved = await files.renamePath(path.join(root, 'dir'), path.join(root, 'renamed'));
  assert.equal(moved.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'renamed', 'inner.txt'), 'utf8'), 'I');
});

test('move puts a thing in a folder under the name it has, and refuses to replace', async () => {
  const root = tree({ 'a.txt': 'A', 'b.txt': 'B', 'sub/': '', 'sub/a.txt': 'other' });
  await assert.rejects(files.moveInto(path.join(root, 'a.txt'), path.join(root, 'sub')), /already something called a.txt/);
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'a.txt'), 'utf8'), 'other');
  const moved = await files.moveInto(path.join(root, 'b.txt'), path.join(root, 'sub'));
  assert.equal(moved.path, path.join(root, 'sub', 'b.txt'));
  assert.equal(fs.readFileSync(moved.path, 'utf8'), 'B');
});

test('create makes an empty file or a folder, once', async () => {
  const root = tree({});
  const file = await files.createEntry(root, 'notes.md', 'file');
  assert.equal(fs.readFileSync(file.path, 'utf8'), '');
  const folder = await files.createEntry(root, 'docs', 'folder');
  assert.ok(fs.statSync(folder.path).isDirectory());
  await assert.rejects(files.createEntry(root, 'notes.md', 'file'), /already something called notes.md/);
  await assert.rejects(files.createEntry(root, 'a/b', 'file'), /slash/);
  await assert.rejects(files.createEntry(root, '', 'folder'), /needed/);
});

test('duplicate makes a copy beside the original, named the way Finder names one', async () => {
  const root = tree({ 'report.md': 'R', 'archive.tar.gz': 'T', '.env': 'E', 'pics/': '', 'pics/a.png': 'P' });
  assert.equal(await files.copyName(root, 'report.md'), 'report copy.md');
  assert.equal(await files.copyName(root, 'archive.tar.gz'), 'archive.tar copy.gz');
  assert.equal(await files.copyName(root, '.env'), '.env copy');
  const first = await files.duplicatePath(path.join(root, 'report.md'));
  assert.equal(first.path, path.join(root, 'report copy.md'));
  const second = await files.duplicatePath(path.join(root, 'report.md'));
  assert.equal(second.path, path.join(root, 'report copy 2.md'));
  assert.equal(fs.readFileSync(second.path, 'utf8'), 'R');
  const folder = await files.duplicatePath(path.join(root, 'pics'));
  assert.equal(fs.readFileSync(path.join(folder.path, 'a.png'), 'utf8'), 'P');
});
