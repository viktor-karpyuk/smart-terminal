'use strict';

/** Deleting a session takes the worktrees it worked in — but never work, nor a tree still in use. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { removeWorktrees, cwdsInTranscript, worktreeOf } = require('../electron/session-worktrees');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });

function repoWithWorktrees(...names) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'st-wt-')));
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'first');
  const trees = names.map((name) => {
    const dir = path.join(main, '.claude', 'worktrees', name);
    git(main, 'worktree', 'add', '-q', '-b', `worktree-${name}`, dir);
    return dir;
  });
  return { main, trees };
}

test('the main checkout is not a worktree of anything', async () => {
  const { main, trees } = repoWithWorktrees('one');
  assert.strictEqual(await worktreeOf(main), null);
  const tree = await worktreeOf(path.join(trees[0]));
  assert.strictEqual(tree.path, trees[0]);
  assert.strictEqual(fs.realpathSync(tree.main), main);
});

test('a clean worktree the session was in is removed, its branch kept', async () => {
  const { main, trees } = repoWithWorktrees('one');
  fs.mkdirSync(path.join(trees[0], 'deep'));
  const result = await removeWorktrees({ dirs: [path.join(trees[0], 'deep'), main] });
  assert.deepStrictEqual(result.removed, [trees[0]]);
  assert.ok(!fs.existsSync(trees[0]));
  assert.match(String(git(main, 'branch', '--list', 'worktree-one')), /worktree-one/);
});

test('a worktree another session still uses is kept', async () => {
  const { trees } = repoWithWorktrees('one');
  const result = await removeWorktrees({ dirs: [trees[0]], stillUsed: [path.join(trees[0], 'src')] });
  assert.deepStrictEqual(result.removed, []);
  assert.strictEqual(result.kept[0].reason, 'another session still uses it');
  assert.ok(fs.existsSync(trees[0]));
});

test('uncommitted work is never thrown away', async () => {
  const { trees } = repoWithWorktrees('one');
  fs.writeFileSync(path.join(trees[0], 'a.txt'), 'changed');
  const result = await removeWorktrees({ dirs: [trees[0]] });
  assert.deepStrictEqual(result.removed, []);
  assert.match(result.kept[0].reason, /not committed/);
  assert.strictEqual(fs.readFileSync(path.join(trees[0], 'a.txt'), 'utf8'), 'changed');
});

test('folders the conversation was in are read from its transcript', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-tr-')), 't.jsonl');
  fs.writeFileSync(file, ['{"cwd":"/a/b","x":1}', '{"type":"x","cwd":"/a/b/.claude/worktrees/w"}', '{"cwd":"relative"}', 'half'].join('\n'));
  assert.deepStrictEqual([...cwdsInTranscript(file)].sort(), ['/a/b', '/a/b/.claude/worktrees/w']);
  assert.strictEqual(cwdsInTranscript(null).size, 0);
});
