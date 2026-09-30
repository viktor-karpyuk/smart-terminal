'use strict';

/*
 * A panel is one script, and in one script a second `function x` silently
 * replaces the first — every caller of the old one now runs the new one. The
 * Kubernetes panel lost its whole table that way: a helper named `readable` for
 * values replaced the `readable` that copies text, and every row threw. Nothing
 * failed to parse, nothing was reported; the table just said "Cannot read
 * properties of undefined".
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'extensions');

test('no panel declares the same function twice', () => {
  const clashes = [];
  for (const id of fs.readdirSync(root)) {
    const file = path.join(root, id, 'panel.html');
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      // Declarations at the panel's own top level: two spaces in, inside its one wrapper.
      const seen = new Map();
      for (const [, name] of script[1].matchAll(/\n {2}function (\w+)\s*\(/g)) seen.set(name, (seen.get(name) ?? 0) + 1);
      for (const [name, count] of seen) if (count > 1) clashes.push(`${id}: ${name} ×${count}`);
    }
  }
  assert.deepEqual(clashes, []);
});
