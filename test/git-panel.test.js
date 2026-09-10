'use strict';

/**
 * The arithmetic the git graph draws itself from.
 *
 * The picture is the thing this extension is for, so the parts of it that are
 * decisions rather than drawing are tested: which commit HEAD is on, where the
 * uncommitted row goes now that it is no longer pinned to the top, and how the
 * two numberings — rows on screen, commits in the list — convert between each
 * other. Get that wrong and every merge line in a repository points at the
 * wrong row, which is a mistake that looks like a working graph.
 *
 * The functions are lifted out of the panel as it ships, for the same reason
 * the other panel tests do it: a copy in the test would be a copy that drifts.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fromPanel() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'git-graph', 'panel.html'), 'utf8');
  const source = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const wanted = ['whatItBrought', 'headIndex', 'rowOfCommit', 'commitOfRow', 'patchKind'];

  const starts = wanted.map((name) => {
    const at = source.search(new RegExp(`\\n  (?:var|function) ${name}\\b`));
    assert.ok(at >= 0, `the panel no longer defines ${name}`);
    return { name, at };
  });
  // Each piece ends where the next declaration begins — any next one.
  const boundary = /\n  (?:var|function) [A-Za-z_$]/g;
  const pieces = starts.map((piece) => {
    boundary.lastIndex = piece.at + 1;
    const next = boundary.exec(source);
    return source.slice(piece.at, next ? next.index : source.length).trimEnd();
  });

  const context = vm.createContext({});
  vm.runInContext(`${pieces.join('\n')}\nglobalThis.out = { ${wanted.join(', ')} };`, context);
  return context.out;
}

const panel = fromPanel();

/** A commit as the graph verb hands it over, with only what these read. */
const commit = (sha, refs = []) => ({ sha, refs });
const localHead = (name) => ({ kind: 'local', name, head: true });
const remote = (name) => ({ kind: 'remote', name, head: false });

// ---------------------------------------------------------------- where HEAD is

/*
 * The bug this replaces. `git log --all` lists every branch, so the newest
 * commit on screen belongs to whichever branch happens to have it — and the
 * uncommitted row used to be pinned to the top of *that*, telling you your
 * unsaved work was sitting on a branch you were not on.
 */
test('HEAD is the commit git decorated with it, not the first one in the list', () => {
  const commits = [
    commit('feature-tip', [remote('origin/feature'), { kind: 'local', name: 'feature', head: false }]),
    commit('main-tip', [localHead('main'), remote('origin/main')]),
    commit('older'),
  ];
  assert.strictEqual(panel.headIndex(commits), 1);
});

test('a detached HEAD is still HEAD', () => {
  const commits = [commit('a'), commit('b', [{ kind: 'head', name: 'HEAD', head: true }])];
  assert.strictEqual(panel.headIndex(commits), 1);
});

test('no HEAD anywhere in what was read is said, not guessed at', () => {
  assert.strictEqual(panel.headIndex([commit('a'), commit('b')]), -1);
  assert.strictEqual(panel.headIndex([]), -1);
});

// ---------------------------------------------------------------- rows vs commits

/*
 * With uncommitted work, one row on screen has no commit behind it, and every
 * commit from HEAD down has moved one row lower. Every merge line in the graph
 * finds its parent's row through this, so an off-by-one here is a picture where
 * the lines join the wrong commits.
 */
test('with nothing uncommitted, a row is its commit', () => {
  for (const index of [0, 1, 7]) {
    assert.strictEqual(panel.rowOfCommit(index, -1), index);
    assert.strictEqual(panel.commitOfRow(index, -1), index);
  }
});

test('the uncommitted row pushes HEAD and everything under it down one', () => {
  const wipAt = 2; // HEAD is the third commit
  assert.strictEqual(panel.rowOfCommit(0, wipAt), 0);
  assert.strictEqual(panel.rowOfCommit(1, wipAt), 1);
  assert.strictEqual(panel.rowOfCommit(2, wipAt), 3, 'HEAD sits under the uncommitted row');
  assert.strictEqual(panel.rowOfCommit(3, wipAt), 4);
});

test('the two numberings are each other, backwards', () => {
  const wipAt = 2;
  assert.strictEqual(panel.commitOfRow(2, wipAt), -1, 'the uncommitted row is no commit');
  for (const index of [0, 1, 2, 3, 9]) {
    assert.strictEqual(panel.commitOfRow(panel.rowOfCommit(index, wipAt), wipAt), index);
  }
});

test('uncommitted work on the newest commit is the row at the top', () => {
  assert.strictEqual(panel.rowOfCommit(0, 0), 1);
  assert.strictEqual(panel.commitOfRow(0, 0), -1);
  assert.strictEqual(panel.commitOfRow(1, 0), 0);
});

// ---------------------------------------------------------------- reading a diff

test('a diff is coloured by what each line does to the file', () => {
  assert.strictEqual(panel.patchKind('+const x = 1;'), 'p-add');
  assert.strictEqual(panel.patchKind('-const x = 0;'), 'p-del');
  assert.strictEqual(panel.patchKind(' unchanged'), '');
  assert.strictEqual(panel.patchKind('@@ -1,4 +1,4 @@'), 'p-at');
});

/*
 * The file headers are `+++` and `---`, which start with the same characters as
 * an added and a removed line. Colouring them green and red puts two lines of
 * fake changes at the top of every diff.
 */
test("a diff's own headers are not changes", () => {
  assert.strictEqual(panel.patchKind('+++ b/src/app.ts'), 'p-meta');
  assert.strictEqual(panel.patchKind('--- a/src/app.ts'), 'p-meta');
  assert.strictEqual(panel.patchKind('diff --git a/src/app.ts b/src/app.ts'), 'p-meta');
  assert.strictEqual(panel.patchKind('index 1a2b3c4..5d6e7f8 100644'), 'p-meta');
});

// ---------------------------------------------------------------- what a pull said

test('an update that brought nothing says so plainly', () => {
  assert.strictEqual(
    panel.whatItBrought({ changed: { total: 0, commits: 0 } }),
    'All files are up to date.',
  );
});

test('an update says how much of what, and in how many commits', () => {
  assert.strictEqual(
    panel.whatItBrought({ changed: { total: 4, commits: 3, updated: 2, added: 1, removed: 1, renamed: 0 } }),
    'Updated 4 files in 3 commits — 2 updated, 1 new, 1 deleted.',
  );
});

test('one of a thing is one, not 1 files in 1 commits', () => {
  assert.strictEqual(
    panel.whatItBrought({ changed: { total: 1, commits: 1, updated: 1 } }),
    'Updated 1 file in 1 commit — 1 updated.',
  );
});

/*
 * Every other verb — a checkout, a merge — answers without a `changed`, and
 * gets the label it was given. Inventing "up to date" for those would be the
 * panel saying something about a question nobody asked.
 */
test('a verb that is not an update is left alone', () => {
  assert.strictEqual(panel.whatItBrought({ ok: true }), null);
  assert.strictEqual(panel.whatItBrought(null), null);
});
