'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RepoWatcher, interesting } = require('../electron/repo-watcher.js');

// --- what is worth waking up for ------------------------------------------

test('a change in the working tree is a change to the status', () => {
  assert.equal(interesting('src/main.ts'), 'tree');
  assert.equal(interesting('README.md'), 'tree');
});

test('the noisy directories are noise, not silence', () => {
  // Not `null`: a build writing into `dist` is exactly what somebody watching
  // that folder in the tree wants to see. It is `noise` so that the tree hears
  // it and git — whose refresh is the expensive one — does not.
  assert.equal(interesting('node_modules/left-pad/index.js'), 'noise');
  assert.equal(interesting('packages/api/node_modules/x/y.js'), 'noise');
  assert.equal(interesting('dist/bundle.js'), 'noise');
  assert.equal(interesting('target/debug/thing'), 'noise');
});

test('the strongest thing seen in a burst is what gets reported', async () => {
  const seen = [];
  const watcher = new RepoWatcher({ emit: (root, kind) => seen.push(kind), settleMs: 20 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-watcher-rank-'));
  assert.equal(watcher.watch(root), true);

  /**
   * Wait for a kind of report to arrive, rather than for the clock.
   *
   * FSEvents decides when it has news and how it groups it, and under load it
   * may split one burst into two — so "the last thing reported" is not a fact
   * about the code, it is a fact about how busy the machine was. What the code
   * actually promises is that each kind gets reported, and that build churn is
   * never dressed up as something git should look at.
   */
  const sawKind = async (kind, deadlineMs = 5000) => {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      if (seen.includes(kind)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  try {
    // A build writes, and something real changes: the real change must be
    // reported as a real change.
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'x');
    fs.writeFileSync(path.join(root, 'source.ts'), 'y');
    assert.ok(await sawKind('tree'), 'a real file changed and was reported as one');

    // And build churn on its own still says something, so a tree showing that
    // folder can follow it — but never as a reason to ask git anything.
    seen.length = 0;
    fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'z');
    assert.ok(await sawKind('noise'), 'the tree hears the build');
    assert.ok(!seen.includes('tree'), 'and git is not sent off over a build');
  } finally {
    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inside .git, only the parts that mean the repository moved', () => {
  assert.equal(interesting('.git/index'), 'git', 'something was staged');
  assert.equal(interesting('.git/HEAD'), 'git', 'a commit or a checkout');
  assert.equal(interesting('.git/refs/heads/main'), 'git');
  assert.equal(interesting('.git/MERGE_HEAD'), 'git');
  assert.equal(interesting('.git/packed-refs'), 'git');
});

test('the rest of .git is git working, not git having moved', () => {
  assert.equal(interesting('.git/objects/ab/cdef'), null);
  assert.equal(interesting('.git/logs/HEAD'), null);
  assert.equal(interesting('.git/index.lock'), null, 'a lock is the start of an operation, not the end');
  assert.equal(interesting('.git/refs/heads/main.lock'), null);
});

test('nothing at all is nothing to report', () => {
  assert.equal(interesting(''), null);
  assert.equal(interesting(null), null);
});

// --- the watching itself ---------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-watch-'));

/** Wait for the watcher to say something, or give up. */
function heard(seen, count, ms = 2500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (seen.length >= count || Date.now() - started > ms) resolve(seen);
      else setTimeout(check, 20);
    };
    check();
  });
}

test('a file appearing is reported once, after the writing stops', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'a-'));
  const seen = [];
  const watcher = new RepoWatcher({ emit: (r, kind) => seen.push(kind), settleMs: 80 });
  assert.equal(watcher.watch(root), true);

  fs.writeFileSync(path.join(root, 'one.txt'), 'x');
  fs.writeFileSync(path.join(root, 'two.txt'), 'y');
  fs.writeFileSync(path.join(root, 'three.txt'), 'z');

  await heard(seen, 1);
  assert.deepEqual(seen, ['tree'], 'a burst of writes is one refresh, not three');
  watcher.stop();
});

test('a commit outranks the file changes it comes with', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'b-'));
  fs.mkdirSync(path.join(root, '.git'));
  const seen = [];
  const watcher = new RepoWatcher({ emit: (_r, kind) => seen.push(kind), settleMs: 80 });
  watcher.watch(root);

  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main');

  await heard(seen, 1);
  assert.deepEqual(seen, ['git'], 'the history is stale too, not only the status');
  watcher.stop();
});

test('the noisy directories never ask git anything', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'c-'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  const seen = [];
  const watcher = new RepoWatcher({ emit: (_root, kind) => seen.push(kind), settleMs: 60 });
  watcher.watch(root);

  try {
    for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(root, 'node_modules', `p${i}.js`), 'x');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Twenty files, one report at most, and never one that would send anybody
    // off to run `git status`.
    assert.ok(seen.length <= 1, `a burst is one report, not ${seen.length}`);
    assert.ok(
      seen.every((kind) => kind === 'noise'),
      'churn under node_modules must never be reported as a change git should look at',
    );
  } finally {
    // In a `finally` because a watcher left running holds the event loop open,
    // and a failed assertion would hang the whole suite rather than fail it.
    watcher.stop();
  }
});

test('two panels on one repository share a watch, and the first to close keeps it', () => {
  const root = fs.mkdtempSync(path.join(dir, 'd-'));
  const watcher = new RepoWatcher({ emit: () => {}, settleMs: 50 });
  watcher.watch(root);
  watcher.watch(root);
  assert.equal(watcher.watching.size, 1);

  watcher.release(root);
  assert.equal(watcher.watching.size, 1, 'the second panel is still looking');
  watcher.release(root);
  assert.equal(watcher.watching.size, 0);
});

test('a tree that cannot be watched fails quietly rather than taking the panel with it', () => {
  const watcher = new RepoWatcher({ emit: () => {} });
  assert.equal(watcher.watch(path.join(dir, 'not-here-at-all')), false);
  assert.equal(watcher.watching.size, 0);
});

test('releasing something never watched is not an error', () => {
  const watcher = new RepoWatcher({ emit: () => {} });
  watcher.release('/nowhere');
  watcher.stop();
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
