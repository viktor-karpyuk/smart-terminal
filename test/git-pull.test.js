'use strict';

/**
 * What an update brought, counted.
 *
 * The fixtures are `git diff --name-status -z` output: every field ends in a
 * NUL, and a rename's two names are two fields rather than one line with tabs
 * in it. Read without `-z` git C-quotes anything that is not plain ASCII, so a
 * pulled `café.txt` arrived as the literal `"caf\303\251.txt"` and clicking it
 * opened nothing.
 *
 * `git pull` answers in sentences — "Fast-forward", "Already up to date" — and
 * the question a person actually has is a number: did anything come in, how
 * much, and what kind. So the counting is done from `git diff --name-status`
 * between where HEAD was and where it is, and it is tested here because a
 * miscount is the kind of wrong nobody notices until they trust it.
 */
const test = require('node:test');
const assert = require('node:assert');
const { summarizePull } = require('../electron/git');

test('nothing came in', () => {
  const summary = summarizePull('', '0');
  assert.equal(summary.total, 0);
  assert.equal(summary.commits, 0);
  assert.deepEqual(summary.files, []);
});

test('each kind of change is counted as its own kind', () => {
  const summary = summarizePull(
    ['M', 'src/app.ts', 'M', 'src/store.ts', 'A', 'src/new.ts', 'D', 'src/gone.ts'].join('\0') + '\0',
    '3',
  );
  assert.equal(summary.updated, 2);
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.total, 4);
  assert.equal(summary.commits, 3);
});

test('a file that moved is one file that moved, not one gone and one new', () => {
  const summary = summarizePull('R100\0src/old/name.ts\0src/new/name.ts\0', '1');
  assert.equal(summary.renamed, 1);
  assert.equal(summary.added, 0);
  assert.equal(summary.removed, 0);
  assert.equal(summary.total, 1);
  // The name worth showing is where it is now, not where it was.
  assert.deepEqual(summary.files, [{ status: 'R', path: 'src/new/name.ts' }]);
});

test('a copy is counted like a move, and takes its new name', () => {
  const summary = summarizePull('C75\0src/a.ts\0src/b.ts\0', '1');
  assert.equal(summary.renamed, 1);
  assert.deepEqual(summary.files, [{ status: 'C', path: 'src/b.ts' }]);
});

test('a status this does not know about is still a change', () => {
  // T is a type change — a file that became a symlink. Rare, and still one file.
  const summary = summarizePull('T\0bin/tool\0', '1');
  assert.equal(summary.updated, 1);
  assert.equal(summary.total, 1);
});

test('blank lines and half-written ones are not files', () => {
  const summary = summarizePull('M\0src/app.ts\0\0A\0', '1');
  assert.equal(summary.total, 1);
});

test('the file list is capped, and the count is not', () => {
  const many = Array.from({ length: 260 }, (_, i) => `M\0src/file-${i}.ts`).join('\0') + '\0';
  const summary = summarizePull(many, '9');
  assert.equal(summary.total, 260, 'every file is counted');
  assert.equal(summary.files.length, 200, 'not every file is carried');
});

/**
 * And the sentence built from those counts.
 *
 * Tested rather than read, because "Updated 1 files" is exactly the kind of
 * thing everybody notices and nobody fixes.
 */
const { whatItDid } = require('../.test-build/lib/gitUpdate.js');

const pull = (changed) => whatItDid('pull', 'Updating', { ok: true, changed });

test('an update that brought nothing says so', () => {
  assert.equal(pull(summarizePull('', '0')).text, 'All files are up to date.');
});

test('an update that brought something counts it', () => {
  const changed = summarizePull(['M', 'src/a.ts', 'M', 'src/b.ts', 'A', 'src/c.ts', 'D', 'src/d.ts'].join('\0') + '\0', '3');
  assert.equal(pull(changed).text, 'Updated 4 files in 3 commits — 2 updated, 1 new, 1 deleted.');
});

test('one of anything is singular', () => {
  assert.equal(pull(summarizePull('M\0src/a.ts\0', '1')).text, 'Updated 1 file in 1 commit — 1 updated.');
});

test('the names come with it, so they can be opened', () => {
  const notice = pull(summarizePull('A\0src/new.ts\0', '1'));
  assert.deepEqual(notice.files, [{ status: 'A', path: 'src/new.ts' }]);
});

test('anything that is not a pull is still reported the way it always was', () => {
  assert.equal(whatItDid('push', 'Pushing', { ok: true }).text, 'Pushing — done.');
  assert.equal(whatItDid('fetch', 'Fetching', { ok: true }).text, 'Fetching — done.');
});

/*
 * The reason `-z` is worth the awkward parser: without it git C-quotes any path
 * that is not plain ASCII, and the row it produced was a name no file has.
 */
test('a name that is not ASCII arrives as its real name', () => {
  const summary = summarizePull('A\0docs/café.txt\0M\0src/ñandú.ts\0', '2');
  assert.deepEqual(summary.files.map((file) => file.path), ['docs/café.txt', 'src/ñandú.ts']);
});

test('a tab in a filename is a tab, not a separator', () => {
  const summary = summarizePull('A\0docs/a\tb.txt\0', '1');
  assert.equal(summary.total, 1);
  assert.equal(summary.files[0].path, 'docs/a\tb.txt');
});
