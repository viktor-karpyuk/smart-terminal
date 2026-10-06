'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cutName, nameTip, NAME_MAX_DEFAULT } = require('../.test-build/lib/labels');

test('a name at or under the limit is shown whole', () => {
  assert.equal(cutName('smart-terminal', 24), 'smart-terminal');
  assert.equal(cutName('x'.repeat(24), 24), 'x'.repeat(24));
});

test('a longer name is cut to exactly the limit, ending in an ellipsis', () => {
  const cut = cutName('timelogbook-app-5776bb545b-nk622', 16);
  assert.equal(Array.from(cut).length, 16);
  assert.equal(cut, 'timelogbook-app…');
  assert.equal(Array.from(cutName('a'.repeat(100))).length, NAME_MAX_DEFAULT);
});

test('characters, not bytes: accents and emoji are never split', () => {
  assert.equal(cutName('diseño-íconos-🚀🚀🚀', 10), 'diseño-íc…');
  assert.equal(cutName('🚀'.repeat(12), 5), '🚀🚀🚀🚀…');
});

test('a space before the cut is not left hanging before the ellipsis', () => {
  assert.equal(cutName('Kubrik Software Corp - Timelog', 8), 'Kubrik…');
});

test('the tooltip says the whole name first, then anything else, once', () => {
  assert.equal(nameTip('kubrik-k8s', '/a/b', null, 'kubrik-k8s', ''), 'kubrik-k8s\n/a/b');
});
