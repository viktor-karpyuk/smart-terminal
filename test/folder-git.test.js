'use strict';

/**
 * What a folder's tab says about its repository.
 *
 * A badge is read at a glance and never questioned, so the one thing it must
 * never be is wrong: a tab that says "nothing to do" over uncommitted work, or
 * that nags at a repository which has nothing outstanding, is worse than a tab
 * with nothing on it at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const { folderGit } = require('../.test-build/lib/folderGit.js');

const file = (path) => ({ path });

test('a folder with nothing outstanding says nothing', () => {
  assert.deepStrictEqual(folderGit({ files: [], ahead: 0, branch: 'main', upstream: 'origin/main' }), {
    state: 'clean',
  });
});

test('a folder that is not in a repository says nothing', () => {
  assert.deepStrictEqual(folderGit(null), { state: 'clean' });
  assert.deepStrictEqual(folderGit(undefined), { state: 'clean' });
  // Nothing read yet is not the same as nothing to say, but it looks the same
  // on a tab — and guessing would be worse than the half-second of silence.
  assert.deepStrictEqual(folderGit({}), { state: 'clean' });
});

test('changes in the working tree ask for a commit, and say how many and where', () => {
  const out = folderGit({
    files: [file('a.ts'), file('b.ts'), file('c.ts')],
    branch: 'feature/tabs',
    upstream: 'origin/feature/tabs',
    ahead: 2,
  });
  assert.strictEqual(out.state, 'uncommitted');
  assert.strictEqual(out.count, 3);
  assert.strictEqual(out.title, '3 changed files on feature/tabs, not committed');
});

/*
 * The precedence is the point. A repository with uncommitted work very often has
 * unpushed commits as well, and a tab that says both says neither — the nearer
 * of the two is the one to act on.
 */
test('uncommitted work comes first, even when there is also something unpushed', () => {
  assert.strictEqual(folderGit({ files: [file('a.ts')], ahead: 7, branch: 'main' }).state, 'uncommitted');
});

test('everything committed and not pushed is a different thing, said differently', () => {
  const out = folderGit({ files: [], ahead: 2, branch: 'main', upstream: 'origin/main' });
  assert.strictEqual(out.state, 'unpushed');
  assert.strictEqual(out.count, 2);
  assert.strictEqual(out.title, '2 commits on main not pushed to origin/main');
});

test('one of a thing is one, not 1 files', () => {
  assert.strictEqual(folderGit({ files: [file('a.ts')], branch: 'main' }).title, '1 changed file on main, not committed');
  assert.strictEqual(
    folderGit({ files: [], ahead: 1, branch: 'main', upstream: 'origin/main' }).title,
    '1 commit on main not pushed to origin/main',
  );
});

/*
 * Git has nothing to compare an untracked branch against — "unpushed" would mean
 * every commit back to some ancestor nobody named — and a repository with no
 * remote at all would then wear the badge for ever, which is the fastest way to
 * teach somebody that it means nothing.
 */
test('a branch with no upstream is not counted as unpushed', () => {
  assert.deepStrictEqual(folderGit({ files: [], ahead: 0, branch: 'scratch', upstream: null }), {
    state: 'clean',
  });
});

test('a detached HEAD still says what is uncommitted, without naming a branch', () => {
  const out = folderGit({ files: [file('a.ts')], branch: null, detached: true, ahead: 0 });
  assert.strictEqual(out.state, 'uncommitted');
  assert.strictEqual(out.title, '1 changed file here, not committed');
});

test('behind is not this badge’s business', () => {
  // Commits on the remote that are not here are somebody else's work arriving,
  // not work of yours waiting. Update says that, and it says it in the Git tab.
  assert.deepStrictEqual(folderGit({ files: [], ahead: 0, behind: 9, branch: 'main', upstream: 'origin/main' }), {
    state: 'clean',
  });
});
