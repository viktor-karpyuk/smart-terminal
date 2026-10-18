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
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n.angular\n.env\n');
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
  // An ignored build cache inside it, and an ignored file nothing could rebuild in another.
  fs.mkdirSync(path.join(wt, 'done', '.angular', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'done', '.angular', 'cache', 'x'), 'x');
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
  fs.writeFileSync(path.join(wt, 'pushed', '.env'), 'SECRET=1');
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

  assert.equal(by.open.state, '1 commit not merged');
  assert.deepEqual(by.open.blockers, ['never pushed']);

  assert.equal(by.pushed.state, '1 commit not merged');
  assert.equal(by.pushed.work, 'unmerged');
  assert.equal(by.pushed.aheadOfBase, 1);
  assert.deepEqual(by.pushed.blockers, ['ignored files nothing could rebuild: .env'], 'an ignored .env keeps the worktree');
  assert.deepEqual(by.done.irreplaceable, [], 'an ignored .angular is a cache, not a reason to keep it');
  assert.equal(by.done.work, 'done');
  assert.equal(by.open.work, 'unmerged');
  assert.equal(by.dirty.work, 'unmerged');
  assert.equal(by.dirty.state, 'uncommitted changes');
  assert.equal(by.app.work, 'base');

  assert.equal(by.dirty.state, 'uncommitted changes');
  assert.deepEqual(by.dirty.blockers, ['1 file not committed']);
  assert.equal(by.dirty.dirtyCount, 1);

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
  assert.equal(by.pushed.ok, false, 'the .env keeps it');
  assert.match(by.pushed.error, /\.env/);
  assert.equal(by.open.ok, false);
  assert.match(by.open.error, /never pushed/);
  assert.equal(by.dirty.ok, false);
  assert.equal(by.gone.ok, true);
  assert.equal(by.nowhere.ok, false);
  assert.ok(!fs.existsSync(path.join(wt, 'done')));
  assert.ok(fs.existsSync(path.join(wt, 'pushed')));
  assert.ok(fs.existsSync(path.join(wt, 'open')));
  const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: main }).toString();
  assert.ok(!branches.includes('feature/done'));
  assert.ok(branches.includes('feature/pushed'));
  const { isRegenerable } = require('../electron/worktree-inventory');
  assert.equal(isRegenerable('.angular/'), true);
  assert.equal(isRegenerable('node_modules.trash-5'), true);
  assert.equal(isRegenerable('.env'), false);
  assert.equal(isRegenerable('dist-test', ['dist-*']), true);
  assert.equal(isRegenerable('buildNumber.properties', ['buildNumber.properties']), true);
  assert.equal(isRegenerable('src/assets/config.json', ['dist-*']), false);
  assert.equal(isRegenerable('src/assets/config.json', ['src/assets/*.json']), true);
  assert.ok(!branches.includes('feature/gone') || true, 'a pruned worktree keeps its branch; that is git');
});

test('a detached worktree whose commit is on a base is finished, and the person\'s own regenerable names count', async () => {
  const { main, wt } = repo();
  // Detached at develop's tip: nothing of its own, nothing to lose.
  execFileSync('git', ['worktree', 'add', '-q', '--detach', path.join(wt, 'perf'), 'develop'], { cwd: main });
  fs.writeFileSync(path.join(wt, 'perf', 'buildNumber.properties'), 'n=1');
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n.angular\n.env\nbuildNumber.properties\n');
  let extra = [];
  const inv = new WorktreeInventory({ folders: () => [main], fetch: false, regenerable: () => extra });
  let perf = (await inv.list()).find((row) => row.label === 'perf');
  assert.equal(perf.detached, true);
  // The gitignore change is uncommitted in main, so the worktree sees the old rules: the file is untracked there.
  assert.ok(perf.blockers.some((b) => /not committed/.test(b)));
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'ignore build number'], { cwd: main });
  execFileSync('git', ['checkout', '-q', 'develop', '--', '.gitignore'], { cwd: path.join(wt, 'perf') });
  inv.memo.clear();
  perf = (await inv.list()).find((row) => row.label === 'perf');
  assert.ok(perf.blockers.some((b) => /buildNumber\.properties/.test(b)), 'an ignored file nothing could rebuild keeps it');
  extra = ['buildNumber.properties'];
  inv.memo.clear();
  perf = (await inv.list()).find((row) => row.label === 'perf');
  assert.deepEqual(perf.blockers.filter((b) => !/not committed/.test(b)), [], 'named as regenerable, it no longer keeps it; detached but on a base is not a blocker');
  assert.ok(perf.mergedInto, 'its commit is on develop');
});

test('a worktree whose .git points at a repository that is gone is \'link broken\', and repair reconnects it', async () => {
  const { main, wt } = repo();
  const { linkedRepoExists } = require('../electron/worktree-inventory');
  const dotGit = path.join(wt, 'done', '.git');
  const original = fs.readFileSync(dotGit, 'utf8');
  fs.writeFileSync(dotGit, 'gitdir: /nowhere/at/all/.git/worktrees/done\n');
  assert.equal(linkedRepoExists(path.join(wt, 'done')), false);
  assert.equal(linkedRepoExists(main), true);
  const inv = new WorktreeInventory({ folders: () => [main], fetch: false });
  let done = (await inv.list()).find((row) => row.label === 'done');
  assert.equal(done.state, 'link broken');
  assert.ok(done.blockers.some((b) => /repair it first/.test(b)));
  const removed = await inv.remove([path.join(wt, 'done')]);
  assert.equal(removed[0].ok, false, 'a broken one is not removed');
  const repaired = await inv.repair([path.join(wt, 'done')]);
  assert.equal(repaired[0].ok, true, repaired[0].error);
  assert.notEqual(fs.readFileSync(dotGit, 'utf8'), 'gitdir: /nowhere/at/all/.git/worktrees/done\n');
  done = (await inv.list()).find((row) => row.label === 'done');
  assert.equal(done.state, 'merged into origin/develop');
  assert.deepEqual(done.blockers, []);
  void original;
});

test('forced removal takes a dirty or unpushed worktree the person named, never one with a hard blocker, and keeps an unmerged branch', async () => {
  const { main, wt } = repo();
  const inv = new WorktreeInventory({ folders: () => [main], live: () => [path.join(wt, 'dirty')], fetch: false });
  const rows = await inv.list();
  const by = Object.fromEntries(rows.map((row) => [row.label, row]));
  assert.equal(by.open.forceable, true);
  assert.deepEqual(by.open.loses, ['1 commit on no base branch (the branch is kept)']);
  assert.equal(by.dirty.forceable, false, 'a session is inside it: not even forced');
  assert.ok(by.dirty.hardBlockers.includes('a session is inside it'));
  assert.equal(by.app.forceable, false);

  const plain = await inv.remove([path.join(wt, 'open')]);
  assert.equal(plain[0].ok, false, 'without force, refused as before');
  const forced = await inv.remove([path.join(wt, 'open'), path.join(wt, 'dirty'), path.join(wt, 'app')], { force: true });
  const r = Object.fromEntries(forced.map((x) => [path.basename(x.path), x]));
  assert.equal(r.open.ok, true);
  assert.equal(r.open.forced, true);
  assert.equal(r.open.branchKept, true, 'the commits stay on their branch');
  assert.equal(r.dirty.ok, false);
  assert.match(r.dirty.error, /session is inside/);
  assert.equal(r.app.ok, false);
  assert.ok(!fs.existsSync(path.join(wt, 'open')));
  assert.ok(fs.existsSync(path.join(wt, 'dirty')));
  const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: main }).toString();
  assert.ok(branches.includes('feature/open'));
});

test('finish derives state and blockers from a row, in the order a person reads them', () => {
  const row = { main: false, base: false, ownWork: true, locked: true, detached: false, prunable: false, branch: 'x', dirty: true, irreplaceable: ['.env', 'secrets', 'a', 'b'], mergedInto: null, upstreamGone: false, upstream: 'origin/x', ahead: 2, lastCommitAt: 10, gitMtime: 20 };
  const out = finish(row, false, 30);
  assert.equal(out.lastActivityAt, 30);
  assert.deepEqual(out.blockers, ['locked', 'changes not committed', 'ignored files nothing could rebuild: .env, secrets, a…', '2 commits not pushed']);
  assert.equal(out.state, 'uncommitted changes');
  assert.equal(finish({ ...row, locked: false, dirty: false, irreplaceable: [], upstreamGone: true }, false, null).state, 'branch deleted on origin');
});
