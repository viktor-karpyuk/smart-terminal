'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WorktreeCleanup, parseWorktrees } = require('../electron/worktree-cleanup.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with an origin, a develop branch, and helpers to make a task's worktree. */
function world() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-')));
  const origin = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'repo');
  sh(dir, 'init', '-q', '--bare', '-b', 'develop', origin);
  sh(dir, 'clone', '-q', origin, repo);
  sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  sh(repo, 'add', 'a.txt'); sh(repo, 'commit', '-q', '-m', 'first'); sh(repo, 'push', '-q', 'origin', 'develop');
  const tree = (name) => { const wt = path.join(dir, name); sh(repo, 'worktree', 'add', '-q', '-b', name, wt, 'origin/develop'); return wt; };
  const work = (wt, file = path.basename(wt) + '.txt') => { fs.writeFileSync(path.join(wt, file), file); sh(wt, 'add', file); sh(wt, 'commit', '-q', '-m', `work ${file}`); };
  const merge = (name) => { sh(repo, 'merge', '-q', '--no-ff', '-m', `merge ${name}`, name); sh(repo, 'push', '-q', 'origin', 'develop'); };
  const cleanup = (extra = {}) => new WorktreeCleanup({ folders: () => [repo], ...extra });
  return { dir, repo, origin, tree, work, merge, cleanup };
}

test('the porcelain list is read into entries, the first being the main tree', () => {
  const list = parseWorktrees('worktree /r\nHEAD aaa\nbranch refs/heads/develop\n\nworktree /w\nHEAD bbb\nbranch refs/heads/x\nlocked reason\n\nworktree /gone\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n');
  assert.deepEqual(list.map((e) => [e.path, e.branch, e.locked, e.detached, e.prunable]), [['/r', 'develop', false, false, false], ['/w', 'x', true, false, false], ['/gone', null, false, true, true]]);
});

test('a task whose work is merged is offered; a new one, an unmerged one and a dirty one are not', async () => {
  const w = world();
  const done = w.tree('done'); w.work(done); w.merge('done');
  const fresh = w.tree('fresh');
  const open = w.tree('open'); w.work(open);
  const dirty = w.tree('dirty'); w.work(dirty); w.merge('dirty'); fs.writeFileSync(path.join(dirty, 'loose.txt'), 'x');
  const found = await w.cleanup({ fetch: false }).scan();
  assert.deepEqual(found.map((one) => one.label), ['done'], 'only the finished one');
  assert.equal(found[0].branch, 'done');
  assert.match(found[0].why, /merged into origin\/develop/);
  assert.ok([fresh, open, dirty].every((p) => fs.existsSync(p)), 'scan removes nothing');
});

test('a worktree a session is inside is not offered, nor is a locked one, nor one on a base branch', async () => {
  const w = world();
  const busy = w.tree('busy'); w.work(busy); w.merge('busy');
  const locked = w.tree('locked'); w.work(locked); w.merge('locked'); sh(w.repo, 'worktree', 'lock', locked);
  const found = await w.cleanup({ fetch: false, folders: () => [w.repo, path.join(busy, 'src')] }).scan();
  assert.deepEqual(found, []);
});

test('a branch deleted on origin (a squash merge that deleted it) counts as finished', async () => {
  const w = world();
  const wt = w.tree('squashed'); w.work(wt);
  sh(wt, 'push', '-q', '-u', 'origin', 'squashed');
  sh(w.repo, 'push', '-q', 'origin', '--delete', 'squashed');
  const found = await w.cleanup().scan();
  assert.deepEqual(found.map((one) => [one.label, one.why]), [['squashed', 'its branch was deleted on origin']]);
});

test('a worktree whose folder was deleted is pruned', async () => {
  const w = world();
  const wt = w.tree('lost'); fs.rmSync(wt, { recursive: true });
  const c = w.cleanup({ fetch: false });
  const found = await c.scan();
  assert.deepEqual(found.map((one) => one.kind), ['stale']);
  assert.deepEqual(await c.clean([found[0].path]), [{ path: found[0].path, ok: true }]);
  assert.doesNotMatch(sh(w.repo, 'worktree', 'list'), /lost/);
});

test('cleaning takes the folder and the merged branch, and only what the scan offered', async () => {
  const w = world();
  const done = w.tree('done'); w.work(done); w.merge('done');
  const other = w.tree('other'); w.work(other);
  const c = w.cleanup({ fetch: false });
  const refused = await c.clean([other]);
  assert.equal(refused[0].ok, false, 'a path nobody offered is not removed');
  assert.ok(fs.existsSync(other));
  const found = await c.scan();
  const out = await c.clean(found.map((one) => one.path));
  assert.deepEqual(out, [{ path: done, ok: true }]);
  assert.equal(fs.existsSync(done), false);
  assert.equal(sh(w.repo, 'branch', '--list', 'done'), '', 'the merged branch goes with it');
  assert.ok(fs.existsSync(other));
});

test('something that changed after the scan is refused by git, not forced', async () => {
  const w = world();
  const done = w.tree('done'); w.work(done); w.merge('done');
  const c = w.cleanup({ fetch: false });
  const found = await c.scan();
  fs.writeFileSync(path.join(done, 'late.txt'), 'new work');
  const out = await c.clean([found[0].path]);
  assert.equal(out[0].ok, false);
  assert.ok(fs.existsSync(path.join(done, 'late.txt')), 'the new file is still there');
});

test('a finished Code Reviewer workshop is offered and discarded through its own door', async () => {
  const w = world();
  const shop = path.join(w.dir, 'fixes', 'repo-pr7'); fs.mkdirSync(shop, { recursive: true });
  let discarded = 0;
  const c = w.cleanup({ fetch: false, workshops: async () => [{ path: shop, label: 'repo — PR #7', discard: async () => { discarded += 1; fs.rmSync(shop, { recursive: true }); } }] });
  const found = await c.scan();
  assert.deepEqual(found.map((one) => [one.kind, one.label]), [['workshop', 'repo — PR #7']]);
  assert.equal('discard' in found[0], false, 'what is shown carries no function');
  assert.deepEqual(await c.clean([shop]), [{ path: shop, ok: true }]);
  assert.equal(discarded, 1);
});
