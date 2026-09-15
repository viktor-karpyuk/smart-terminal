'use strict';

/*
 * The git reads the code view is drawn from, on a real repository in a
 * temporary folder: what happened to each file, and a file as it is at a ref.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ReviewGit } = require('../electron/review-git');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const write = (file, text) => fs.writeFileSync(path.join(dir, file), text);
  return { dir, git, write };
}

test('nameStatus says what happened to each file, and where a renamed one came from', async (t) => {
  const { dir, git, write } = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write('kept.txt', 'one\ntwo\n');
  write('gone.txt', 'bye\n');
  write('old-name.txt', 'a line long enough to be recognised as the same file after a rename\n'.repeat(5));
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  write('kept.txt', 'one\nthree\n');
  write('new.txt', 'hello\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  git('mv', 'old-name.txt', 'new-name.txt');
  git('add', '-A');
  git('commit', '-qm', 'change');

  const status = await new ReviewGit().nameStatus(dir, 'main...feature');
  assert.deepStrictEqual(status['kept.txt'], { status: 'M', from: null });
  assert.deepStrictEqual(status['new.txt'], { status: 'A', from: null });
  assert.deepStrictEqual(status['gone.txt'], { status: 'D', from: null });
  assert.deepStrictEqual(status['new-name.txt'], { status: 'R', from: 'old-name.txt' });
});

test('fileAt reads a file at a ref as lines, and is null where the file is not', async (t) => {
  const { dir, git, write } = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write('a.txt', 'first\n\nthird\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const reader = new ReviewGit();
  assert.deepStrictEqual(await reader.fileAt(dir, 'main', 'a.txt'), ['first', '', 'third']);
  assert.strictEqual(await reader.fileAt(dir, 'main', 'missing.txt'), null);
});
