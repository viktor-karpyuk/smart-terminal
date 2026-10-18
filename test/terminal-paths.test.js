'use strict';

/*
 * Which parts of a line of terminal output are file paths worth a click.
 */

const test = require('node:test');
const assert = require('node:assert');
const { findPaths, resolvePath } = require('../.test-build/lib/terminalPaths');

const shown = (line) => findPaths(line).map((found) => [line.slice(found.start, found.end), found.path, found.line, found.column]);

test('the shapes compilers and test runners print', () => {
  assert.deepEqual(shown('src/app.ts:12:4 - error TS2304'), [['src/app.ts:12:4', 'src/app.ts', 12, 4]]);
  assert.deepEqual(shown('  at Object.<anonymous> (/Users/me/proj/test/a.test.js:30:7)'), [
    ['/Users/me/proj/test/a.test.js:30:7', '/Users/me/proj/test/a.test.js', 30, 7],
  ]);
  assert.deepEqual(shown('Main.java(42): warning'), [['Main.java(42)', 'Main.java', 42, null]]);
  assert.deepEqual(shown('edited ./build.gradle and ../shared/x.yml'), [
    ['./build.gradle', './build.gradle', null, null],
    ['../shared/x.yml', '../shared/x.yml', null, null],
  ]);
});

test('words with a dot in them are not paths', () => {
  assert.deepEqual(shown('see example.com, e.g. package.json for details'), []);
  assert.deepEqual(shown('step:3 done'), [], 'a label with a number is not a file');
  assert.deepEqual(shown('version 1.2.3:4'), [], 'needs an extension that starts with a letter');
});

test('never the tail of a URL — the link addon owns those', () => {
  assert.deepEqual(shown('open https://github.com/org/repo/blob/main/a.ts:3'), []);
});

test('a sentence ending in a path keeps the full stop out of it', () => {
  assert.deepEqual(shown('Wrote src/out/report.md.'), [['src/out/report.md', 'src/out/report.md', null, null]]);
});

test('a printed path is placed against the folder the terminal is in', () => {
  assert.equal(resolvePath('src/a.ts', '/repo', '/home/me'), '/repo/src/a.ts');
  assert.equal(resolvePath('../b/c.ts', '/repo/web/', '/home/me'), '/repo/b/c.ts');
  assert.equal(resolvePath('/etc/hosts', null, null), '/etc/hosts');
  assert.equal(resolvePath('~/notes.md', '/repo', '/home/me'), '/home/me/notes.md');
  assert.equal(resolvePath('~/notes.md', '/repo', null), null);
  assert.equal(resolvePath('a.ts', null, null), null);
});
