'use strict';

/*
 * A store selector that returns a new array or object every time it is read
 * never settles: zustand compares by reference, sees a change on every render,
 * and React stops with "Maximum update depth exceeded", unmounting the whole
 * window. That is how right-clicking a folder left the app blank (0.8.21–0.8.23).
 * A fallback has to be a constant defined outside the component.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

test('no store selector falls back to a fresh array or object', () => {
  const found = [];
  for (const file of files(path.join(__dirname, '..', 'src'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/useStore\(\s*\(\s*\w+\s*\)\s*=>[^;]*(\?\?|\|\|)\s*(\[\]|\{\})\s*\)/.test(line)) {
        found.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(found, [], `selectors returning a new [] or {} on every read:\n${found.join('\n')}`);
});
