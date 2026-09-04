'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { group, moduleOf } = require('../.test-build/lib/gitTree');

/** A changed file, shaped the way `git status` reports one. */
function file(path) {
  const parts = path.split('/');
  return { path, name: parts[parts.length - 1], dir: parts.slice(0, -1).join('/'), staged: false };
}

const shape = (nodes) =>
  nodes.map((n) => (n.kind === 'file' ? n.file.name : `${n.label}[${shape(n.children).join(' ')}]`));

test('a module is the top of the repository a file sits under', () => {
  assert.equal(moduleOf(file('src/state/store.ts')), 'src/state', 'src only holds modules');
  assert.equal(moduleOf(file('packages/api/index.ts')), 'packages/api');
  assert.equal(moduleOf(file('electron/main.js')), 'electron');
  assert.equal(moduleOf(file('README.md')), '', 'a file at the root belongs to no module');
});

test('a container on its own is not a module', () => {
  // `packages` with nothing under it is not a module, it is a stray path.
  assert.equal(moduleOf(file('packages/thing.json')), 'packages');
});

test('files: a flat list, alphabetical', () => {
  const nodes = group([file('b/z.ts'), file('a/a.ts')], 'files');
  assert.deepEqual(shape(nodes), ['a.ts', 'z.ts']);
});

test('directory: one folder per directory, as before', () => {
  const nodes = group([file('src/a.ts'), file('src/b.ts'), file('electron/c.js')], 'directory');
  assert.deepEqual(shape(nodes), ['electron[c.js]', 'src[a.ts b.ts]']);
});

test('module: files gather under the part of the repo they belong to', () => {
  const nodes = group(
    [file('packages/api/a.ts'), file('packages/api/deep/b.ts'), file('packages/web/c.ts'), file('README.md')],
    'module',
  );
  assert.deepEqual(shape(nodes), ['packages/api[a.ts b.ts]', 'packages/web[c.ts]', '(repository root)[README.md]']);
});

test('module is not just the directory again, which is what it used to be', () => {
  const files = [file('packages/api/a.ts'), file('packages/api/deep/b.ts')];
  assert.notDeepEqual(shape(group(files, 'module')), shape(group(files, 'directory')));
  assert.equal(group(files, 'module').length, 1, 'one module');
  assert.equal(group(files, 'directory').length, 2, 'two directories');
});

test('both: modules on the outside, directories within', () => {
  const nodes = group([file('packages/api/a.ts'), file('packages/api/deep/b.ts'), file('packages/web/c.ts')], 'both');
  assert.deepEqual(shape(nodes), ['packages/api[.[a.ts] deep[b.ts]]', 'packages/web[c.ts]']);
});

test('both: a module with everything in one folder does not repeat the folder', () => {
  const nodes = group([file('electron/a.js'), file('electron/b.js')], 'both');
  assert.deepEqual(shape(nodes), ['electron[a.js b.js]']);
});

test('a folder counts everything beneath it, not only its own children', () => {
  const nodes = group([file('packages/api/a.ts'), file('packages/api/deep/b.ts')], 'both');
  assert.equal(nodes[0].count, 2);
});

test('every grouping keeps every file', () => {
  const files = [file('a.ts'), file('src/b.ts'), file('packages/x/c.ts'), file('packages/x/deep/d.ts')];
  const counted = (nodes) =>
    nodes.reduce((sum, n) => sum + (n.kind === 'file' ? 1 : counted(n.children)), 0);
  for (const grouping of ['files', 'directory', 'module', 'both']) {
    assert.equal(counted(group(files, grouping)), files.length, `${grouping} lost a file`);
  }
});

test('no two nodes share a key, which is what folding turns on', () => {
  const files = [file('packages/x/a.ts'), file('packages/x/deep/b.ts'), file('packages/y/a.ts')];
  const keys = [];
  const walk = (nodes) => nodes.forEach((n) => { keys.push(n.key); if (n.kind === 'dir') walk(n.children); });
  for (const grouping of ['directory', 'module', 'both']) {
    keys.length = 0;
    walk(group(files, grouping));
    assert.equal(new Set(keys).size, keys.length, `${grouping} produced a duplicate key`);
  }
});
