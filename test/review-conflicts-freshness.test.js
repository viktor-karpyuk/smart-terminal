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

/*
 * The freshness rule is only worth having if the thing it guards asks it.
 *
 * `checkRepoConflicts` swept every open pull request every time the list was
 * refreshed and never consulted this at all — and the expensive half of that
 * sweep is a real `git fetch` of every branch they name, against the remote.
 * It went unnoticed while the list was refreshed every ten minutes. The moment
 * the list started being refreshed every two, it became a fetch of fourteen
 * clones every two minutes for answers that had not changed.
 */
test('the repository-wide sweep asks the freshness rule, not just the single check', () => {
  const engine = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'electron', 'review-engine.js'),
    'utf8',
  );
  const at = engine.indexOf('checkRepoConflicts(repoId) {');
  assert.ok(at > 0, 'the sweep is still there');
  const sweep = engine.slice(at, at + 1800);
  assert.match(sweep, /conflictsWantChecking\(pr\)/, 'it filters by what actually wants checking');
  assert.match(sweep, /if \(!wanting\.length\) return;/, 'and does not fetch at all when nothing does');
  assert.ok(!/for \(const pr of ours\)/.test(sweep), 'nothing walks the whole list any more');
});
