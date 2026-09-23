'use strict';

/**
 * Whether a previewed page may run, and what it may reach if it does.
 *
 * The preview started with `sandbox=""`, which renders and executes nothing.
 * That is the right default — a working tree is full of pages nobody wrote to
 * be opened here — and it is also why a slide deck previewed in the app had
 * arrows that did nothing. Scripts can now be turned on, per file or for good.
 *
 * The line that must never move is `allow-same-origin`. Without it the page has
 * an origin of its own and cannot read this app, its storage or the disk; with
 * it, and with scripts, a previewed file could read everything the app can.
 * This test exists to make that impossible to add by accident.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'FilesPanel.tsx'), 'utf8');

test('the preview frame never gets an origin of its own app', () => {
  const sandboxes = [...source.matchAll(/sandbox=\{?['"{]([^'"}]*)/g)].map((m) => m[1]);
  assert.ok(sandboxes.length > 0, 'the preview still declares a sandbox');
  for (const value of sandboxes) {
    assert.ok(
      !/allow-same-origin/.test(value),
      `allow-same-origin would let a previewed file read the app: ${value}`,
    );
  }
});

test('scripts are off unless somebody says otherwise', () => {
  // The expression that decides it, rather than a constant true.
  assert.match(source, /sandbox=\{scripts \? 'allow-scripts' : ''\}/);
  assert.match(source, /const scripts = always \|\| justThisOne/);
  assert.match(source, /s\.settings\.previewScripts/, 'the setting is what "always" reads');
});

test('the setting starts off, and it is the page that is trusted with nothing else', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'state', 'store.ts'), 'utf8');
  assert.match(store, /previewScripts: false/, 'off until asked for');
});

/*
 * Turning scripts on has to remount the frame: a page already drawn in an inert
 * one keeps that frame, and nothing starts running until it is replaced.
 */
test('the frame is rebuilt when scripts are turned on', () => {
  assert.match(source, /key=\{scripts \? 'live' : 'inert'\}/);
});

test('the one-off is forgotten when the file changes', () => {
  assert.match(source, /useEffect\(\(\) => setJustThisOne\(false\), \[path\]\)/);
});
