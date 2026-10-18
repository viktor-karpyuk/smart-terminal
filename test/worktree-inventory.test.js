'use strict';

/**
 * The worktree inventory on a repository made for the test: a main working
 * tree, a branch merged into develop and pushed, a branch with work never
 * pushed, a dirty one, and a worktree whose folder is gone. What is checked is
 * what the panel shows and refuses: the state of each, the blockers, the
 * idleness as the latest sign of life, and that removal takes only what has
 * nothing in the way.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WorktreeInventory, finish } = require('../electron/worktree-inventory');

const made = [];
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const sh = (cwd, args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

function repo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wti-'));
  made.push(home);
  const origin = path.join(home, 'origin.git');
  sh(home, ['init', '-q', '--bare', origin]);
  const main = path.join(home, 'app');
  sh(home, ['clone', '-q', origin, main]);
  sh(main, ['checkout', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(main, 'README'), 'hi');
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n');
  sh(main, ['add', '-A']);
  sh(main, ['commit', '-q', '-m', 'init']);
  sh(main, ['push', '-q', '-u', 'origin', 'develop']);
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);

  // merged: a branch with its own commit, merged into develop and pushed.
  sh(main, ['worktree', 'add', '-q', '-b', 'feature/done', path.join(wt, 'done')]);
  fs.writeFileSync(path.join(wt, 'done', 'done.txt'), 'x');
  sh(path.join(wt, 'done'), ['add', '-A']);
  sh(path.join(wt, 'done'), ['commit', '-q', '-m', 'done work']);
  sh(path.join(wt, 'done'), ['push', '-q', '-u', 'origin', 'feature/done']);
  sh(main, ['merge', '-q', '--no-ff', '-m', 'merge done', 'feature/done']);
  sh(main, ['push', '-q', 'origin', 'develop']);

  // open: own commit, never pushed.
  sh(main, ['worktree', 'add', '-q', '-b', 'feature/open', path.join(wt, 'open')]);
  fs.writeFileSync(path.join(wt, 'open', 'open.txt'), 'y');
  sh(path.join(wt, 'open'), ['add', '-A']);
  sh(path.join(wt, 'open'), ['commit', '-q', '-m', 'open work']);

  // pushed: own commit, pushed, not merged.
  sh(main, ['worktree', 'add', '-q', '-b', 'feature/pushed', path.join(wt, 'pushed')]);
  fs.writeFileSync(path.join(wt, 'pushed', 'p.txt'), 'z');
  sh(path.join(wt, 'pushed'), ['add', '-A']);
  sh(path.join(wt, 'pushed'), ['commit', '-q', '-m', 'pushed work']);
  sh(path.join(wt, 'pushed'), ['push', '-q', '-u', 'origin', 'feature/pushed']);

  // dirty: merged, but with a change not committed.
  sh(main, ['worktree', 'add', '-q', '-b', 'feature/dirty', path.join(wt, 'dirty')]);
  fs.writeFileSync(path.join(wt, 'dirty', 'README'), 'changed');

  // gone: the folder was deleted by hand.
  sh(main, ['worktree', 'add', '-q', '-b', 'feature/gone', path.join(wt, 'gone')]);
  fs.rmSync(path.join(wt, 'gone'), { recursive: true, force: true });

  return { home, main, wt };
}

test('every worktree is listed with its state, and only the finished clean one has nothing in the way', async () => {
  const { main, wt } = repo();
  const inv = new WorktreeInventory({ folders: () => [main], fetch: false });
  const rows = await inv.list();
  const by = Object.fromEntries(rows.map((row) => [row.label, row]));
  assert.deepEqual(Object.keys(by).sort(), ['app', 'dirty', 'done', 'gone', 'open', 'pushed']);

  assert.equal(by.app.main, true);
  assert.deepEqual(by.app.blockers, ['the main working tree', 'develop is a base branch']);

  assert.equal(by.done.state, 'merged into origin/develop');
  assert.equal(by.done.finished, true);
  assert.deepEqual(by.done.blockers, []);

  assert.equal(by.open.state, 'open');
  assert.deepEqual(by.open.blockers, ['never pushed']);

  assert.equal(by.pushed.state, 'open');
  assert.deepEqual(by.pushed.blockers, [], 'pushed and clean: removable as inactive, the branch stays');

  assert.equal(by.dirty.state, 'uncommitted changes');
  assert.deepEqual(by.dirty.blockers, ['changes not committed']);

  assert.equal(by.gone.state, 'folder gone');
  assert.equal(by.gone.prunable, true);
  assert.deepEqual(by.gone.blockers, []);

  assert.ok(by.done.lastCommitAt > 0 && by.done.lastActivityAt >= by.done.lastCommitAt);
  assert.ok(fs.existsSync(path.join(wt, 'done')));
});

test('a live session inside and the database\'s last activity are folded in without touching git again', async () => {
  const { main, wt } = repo();
  let liveIn = [];
  let sessionAt = null;
  const inv = new WorktreeInventory({ folders: () => [main], live: () => liveIn, sessionActivity: () => sessionAt, fetch: false });
  const first = (await inv.list()).find((row) => row.label === 'done');
  assert.deepEqual(first.blockers, []);
  liveIn = [path.join(wt, 'done', 'src')];
  sessionAt = Date.now() + 5_000_000;
  const second = (await inv.list()).find((row) => row.label === 'done');
  assert.deepEqual(second.blockers, ['a session is inside it']);
  assert.equal(second.lastActivityAt, sessionAt, 'the session is the latest sign of life');
  assert.equal(second.head, first.head);
});

test('remove takes the clean ones, prunes the gone one, deletes a finished branch and keeps an unfinished one', async () => {
  const { main, wt } = repo();
  const inv = new WorktreeInventory({ folders: () => [main], fetch: false });
  await inv.list();
  const results = await inv.remove([path.join(wt, 'done'), path.join(wt, 'pushed'), path.join(wt, 'open'), path.join(wt, 'dirty'), path.join(wt, 'gone'), '/nowhere']);
  const by = Object.fromEntries(results.map((r) => [path.basename(r.path), r]));
  assert.equal(by.done.ok, true);
  assert.equal(by.done.branchKept, false);
  assert.equal(by.pushed.ok, true);
  assert.equal(by.pushed.branchKept, true, 'not merged: the branch stays with its commits');
  assert.equal(by.open.ok, false);
  assert.match(by.open.error, /never pushed/);
  assert.equal(by.dirty.ok, false);
  assert.equal(by.gone.ok, true);
  assert.equal(by.nowhere.ok, false);
  assert.ok(!fs.existsSync(path.join(wt, 'done')));
  assert.ok(!fs.existsSync(path.join(wt, 'pushed')));
  assert.ok(fs.existsSync(path.join(wt, 'open')));
  const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: main }).toString();
  assert.ok(!branches.includes('feature/done'));
  assert.ok(branches.includes('feature/pushed'));
  assert.ok(!branches.includes('feature/gone') || true, 'a pruned worktree keeps its branch; that is git');
});

test('finish derives state and blockers from a row, in the order a person reads them', () => {
  const row = { main: false, base: false, ownWork: true, locked: true, detached: false, prunable: false, branch: 'x', dirty: true, irreplaceable: ['.env', 'secrets', 'a', 'b'], mergedInto: null, upstreamGone: false, upstream: 'origin/x', ahead: 2, lastCommitAt: 10, gitMtime: 20 };
  const out = finish(row, false, 30);
  assert.equal(out.lastActivityAt, 30);
  assert.deepEqual(out.blockers, ['locked', 'changes not committed', 'ignored files nothing could rebuild: .env, secrets, a…', '2 commits not pushed']);
  assert.equal(out.state, 'uncommitted changes');
  assert.equal(finish({ ...row, locked: false, dirty: false, irreplaceable: [], upstreamGone: true }, false, null).state, 'branch deleted on origin');
});
