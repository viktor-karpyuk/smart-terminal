'use strict';

/** Searching inside a folder's files, and replacing what was found. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { searchInTree, replaceInFiles, globMatcher, buildPattern } = require('../electron/file-search');

function tree(files, { git = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  if (git) execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('finds every match, grouped by file, with lines and ranges', async () => {
  const root = tree({ 'a.txt': 'hello world\nsay Hello\n', 'sub/b.txt': 'nothing\nhello again hello\n' });
  const found = await searchInTree(root, { query: 'hello' });
  assert.ok(found.ok);
  assert.deepStrictEqual(found.files.map((f) => f.relative), ['a.txt', 'sub/b.txt']);
  assert.strictEqual(found.matches, 4);
  const b = found.files[1].matches[0];
  assert.strictEqual(b.line, 2);
  assert.deepStrictEqual(b.ranges, [[0, 5], [12, 17]]);
});

test('match case, whole word and regex mean what they say', async () => {
  const root = tree({ 'a.txt': 'Hello hello helloworld\n' });
  assert.strictEqual((await searchInTree(root, { query: 'hello', caseSensitive: true })).matches, 2);
  assert.strictEqual((await searchInTree(root, { query: 'hello', wholeWord: true })).matches, 2);
  assert.strictEqual((await searchInTree(root, { query: 'h.llo\\b', regex: true })).matches, 2);
  const bad = await searchInTree(root, { query: '(', regex: true });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /regular expression/);
});

test('a checkout is searched the way git sees it: ignored files are left out', async () => {
  const root = tree({ '.gitignore': 'build/\n', 'src/a.js': 'needle\n', 'build/out.js': 'needle\n' }, { git: true });
  const found = await searchInTree(root, { query: 'needle' });
  assert.deepStrictEqual(found.files.map((f) => f.relative), ['src/a.js']);
});

test('include and exclude take editor-style globs', async () => {
  const root = tree({ 'src/a.ts': 'x\n', 'src/a.test.ts': 'x\n', 'docs/a.md': 'x\n' });
  const only = await searchInTree(root, { query: 'x', include: '*.ts', exclude: '*.test.ts' });
  assert.deepStrictEqual(only.files.map((f) => f.relative), ['src/a.ts']);
  const m = globMatcher('src/**, docs');
  assert.ok(m('src/deep/x.js'));
  assert.ok(m('docs/a.md'));
  assert.ok(!m('other/a.md'));
});

test('binary files are passed over', async () => {
  const root = tree({ 'a.bin': 'needle\u0000\u0001', 'b.txt': 'needle' });
  const found = await searchInTree(root, { query: 'needle' });
  assert.deepStrictEqual(found.files.map((f) => f.relative), ['b.txt']);
});

test('replace writes every match, literally unless in regex mode', async () => {
  const root = tree({ 'a.txt': 'cost $5 cost\n', 'b.txt': 'v1.2 v3.4\n' });
  const plain = await replaceInFiles(root, { query: 'cost', replacement: '$&x' }, [path.join(root, 'a.txt')]);
  assert.strictEqual(plain.replaced, 2);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '$&x $5 $&x\n');
  const regex = await replaceInFiles(root, { query: 'v(\\d)\\.(\\d)', regex: true, replacement: '$2.$1' }, [path.join(root, 'b.txt')]);
  assert.strictEqual(regex.replaced, 2);
  assert.strictEqual(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), '2.1 4.3\n');
});

test('replace refuses files outside the folder', async () => {
  const root = tree({ 'a.txt': 'x' });
  const other = tree({ 'b.txt': 'x' });
  const result = await replaceInFiles(root, { query: 'x', replacement: 'y' }, [path.join(other, 'b.txt')]);
  assert.strictEqual(result.changed.length, 0);
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(other, 'b.txt'), 'utf8'), 'x');
});

test('an empty query is no search at all', () => {
  assert.strictEqual(buildPattern({ query: '' }).pattern, null);
});
