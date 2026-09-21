'use strict';

/**
 * When the question "does it merge" is asked again.
 *
 * The answer used to be written down once, by a review, and shown for ever:
 * a pull request reviewed on Monday still said Monday's answer after
 * Thursday's commits, and one nobody had reviewed said nothing. The rule now
 * is the one a person applies — ask if you never have, ask if things changed,
 * and ask anyway after a while, because the target branch moves on its own.
 */

const test = require('node:test');
const assert = require('node:assert');
const { conflictsWantChecking } = require('../electron/review-engine');

const at = Date.parse('2026-09-21T12:00:00.000Z');
const MIN = 60 * 1000;

test('never asked: ask', () => {
  assert.strictEqual(conflictsWantChecking({ conflictsAt: null }, at), true);
  assert.strictEqual(conflictsWantChecking({ conflictsAt: 'yesterday-ish' }, at), true);
  assert.strictEqual(conflictsWantChecking(null, at), false, 'no PR is nothing to ask about');
});

test('asked before the newest commits: ask again', () => {
  const pr = { conflictsAt: new Date(at - 2 * MIN).toISOString(), updatedOn: new Date(at - MIN).toISOString() };
  assert.strictEqual(conflictsWantChecking(pr, at), true);
});

test('asked a moment ago and nothing changed: the answer stands', () => {
  const pr = { conflictsAt: new Date(at - 2 * MIN).toISOString(), updatedOn: new Date(at - 60 * MIN).toISOString() };
  assert.strictEqual(conflictsWantChecking(pr, at), false);
});

test('asked long enough ago that the target may have moved: ask again', () => {
  const pr = { conflictsAt: new Date(at - 11 * MIN).toISOString(), updatedOn: new Date(at - 60 * MIN).toISOString() };
  assert.strictEqual(conflictsWantChecking(pr, at), true);
});
