'use strict';

/**
 * When a pull request has been quiet long enough to say something about it.
 *
 * This is the reviewer's half of a reminder: only it knows what an unanswered
 * comment is. How the message reaches anybody is a delivery extension's
 * business, and nothing here mentions Teams, a channel or an address — which is
 * the property these tests exist to keep.
 */

const test = require('node:test');
const assert = require('node:assert');
const R = require('../electron/review-reminders');

const rules = (over = {}) => R.readRules(over);
const on = (id, days, mode = 'AUTO') => rules({ [id]: { mode, days } });

const row = (extra = {}) => ({
  repoId: 'r1',
  repoName: 'kubrik-pos-fe',
  provider: 'BITBUCKET',
  pr: { id: 43, title: 'POS-258 | the certificate', author: 'bchavez', state: 'OPEN', sourceBranch: 'f', targetBranch: 'develop', url: 'https://bitbucket.org/x/43' },
  flags: [],
  ageDays: 9,
  ...extra,
});
const thread = (extra = {}) => ({ state: 'NEEDS_ANSWER', waitingDays: 6, title: 'The certificate is written into…', ...extra });

// ---------------------------------------------------------------- the rules themselves

test('a rule nobody configured is off, with a sensible number of days', () => {
  const all = R.readRules();
  assert.deepStrictEqual(all.map((rule) => rule.mode), ['OFF', 'OFF', 'OFF']);
  assert.deepStrictEqual(all.map((rule) => rule.days), [3, 5, 2]);
  // Nonsense is not a number of days.
  assert.strictEqual(R.readRule('UNANSWERED', { days: -4, mode: 'LOUD' }).days, 3);
  assert.strictEqual(R.readRule('UNANSWERED', { days: -4, mode: 'LOUD' }).mode, 'OFF');
});

// ---------------------------------------------------------------- a comment nobody answered

test('a comment quiet for long enough is due, and says how long', () => {
  const due = R.dueFor({ row: row(), threads: [thread()], rules: on('UNANSWERED', 3) });
  assert.ok(due);
  assert.strictEqual(due.to, 'bchavez');
  assert.strictEqual(due.days, 6);
  assert.match(due.title, /kubrik-pos-fe #43 is waiting on you/);
  assert.match(due.body, /A comment has had no answer for 6 days/);
});

test('several quiet comments are one message, counted', () => {
  const due = R.dueFor({ row: row(), threads: [thread(), thread({ waitingDays: 4 })], rules: on('UNANSWERED', 3) });
  assert.match(due.body, /2 comments have had no answer for 6 days/);
  assert.strictEqual(due.days, 6, 'the longest wait, not the shortest');
});

test('nothing is due before the days are up, or when the thread is settled', () => {
  assert.strictEqual(R.dueFor({ row: row(), threads: [thread({ waitingDays: 2 })], rules: on('UNANSWERED', 3) }), null);
  assert.strictEqual(R.dueFor({ row: row(), threads: [thread({ state: 'OK' })], rules: on('UNANSWERED', 3) }), null);
  // Not published is nothing anybody owes an answer to.
  assert.strictEqual(R.dueFor({ row: row(), threads: [thread({ state: 'UNPUBLISHED' })], rules: on('UNANSWERED', 3) }), null);
});

test('a rule that is off is off', () => {
  assert.strictEqual(R.dueFor({ row: row(), threads: [thread()], rules: rules() }), null);
  assert.ok(R.dueFor({ row: row(), threads: [thread()], rules: on('UNANSWERED', 3, 'ASK') }));
});

/*
 * Nobody is reminded about a pull request that is not open. A merged one is
 * finished, and a draft is somebody mid-thought.
 */
test('a closed or draft pull request owes nobody an answer', () => {
  for (const pr of [{ state: 'MERGED' }, { state: 'DECLINED' }, { state: 'OPEN', isDraft: true }]) {
    const one = row({ pr: { ...row().pr, ...pr } });
    assert.strictEqual(R.dueFor({ row: one, threads: [thread()], rules: on('UNANSWERED', 3) }), null, JSON.stringify(pr));
  }
});

test('you are not reminded about your own pull request', () => {
  const mine = row({ pr: { ...row().pr, author: 'viktor' } });
  assert.strictEqual(R.dueFor({ row: mine, threads: [thread()], rules: on('UNANSWERED', 3), me: 'Viktor' }), null);
  assert.ok(R.dueFor({ row: mine, threads: [thread()], rules: on('UNANSWERED', 3), me: 'Viktor', skipMine: false }));
});

// ---------------------------------------------------------------- the other two rules

test('changes asked for and a branch that never moved', () => {
  const stalled = row({ changesRequestedByUs: true, changesRequestedDays: 7 });
  const due = R.dueFor({ row: stalled, threads: [], rules: on('NO_COMMITS', 5) });
  assert.match(due.body, /Changes were asked for 7 days ago/);
  assert.strictEqual(R.dueFor({ row: row({ changesRequestedByUs: true, changesRequestedDays: 2 }), threads: [], rules: on('NO_COMMITS', 5) }), null);
  // Nobody asked for changes: there is nothing to be waiting for.
  assert.strictEqual(R.dueFor({ row: row({ changesRequestedDays: 9 }), threads: [], rules: on('NO_COMMITS', 5) }), null);
});

/*
 * "And nothing moved" is half the sentence. A branch that has had commits since
 * we asked is a branch somebody is working on, and chasing them for it is the
 * fastest way to teach somebody to ignore these.
 */
test('a branch that has moved since is nobody to chase', () => {
  const moving = row({ changesRequestedByUs: true, changesRequestedDays: 9, movedSinceReview: true });
  assert.strictEqual(R.dueFor({ row: moving, threads: [], rules: on('NO_COMMITS', 5) }), null);
});

/*
 * The field this rule reads has to be one something actually fills in. It was
 * not, for a whole release: the rule was on screen, could be switched on, and
 * could never fire.
 */
test('the rule reads a field the board really carries', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'review-service.js'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'review-reminders.js'), 'utf8');
  for (const field of [...source.matchAll(/\brow\.([a-zA-Z]+)/g)].map((m) => m[1])) {
    if (['pr', 'flags', 'repoId', 'repoName', 'provider'].includes(field)) continue;
    assert.ok(
      new RegExp(`\\b${field}:`).test(service),
      `review-reminders reads row.${field}, which nothing in review-service puts there`,
    );
  }
});

test('a pull request nobody reviewed is told to you, not to its author', () => {
  const due = R.dueFor({ row: row({ flags: ['UNREVIEWED'], ageDays: 4 }), threads: [], rules: on('UNREVIEWED', 2) });
  assert.strictEqual(due.to, null, 'there is nobody else to tell');
  assert.match(due.body, /open 4 days by bchavez/);
});

// ---------------------------------------------------------------- the message it becomes

/*
 * The property worth keeping: the reviewer hands over a person as the forge
 * names them and a few lines. Swap the delivery extension for a Slack one and
 * not a word of this changes.
 */
test('the message names a person the forge’s way and mentions no delivery at all', () => {
  const one = row();
  const due = R.dueFor({ row: one, threads: [thread()], rules: on('UNANSWERED', 3) });
  const message = R.asMessage(due, { row: one, provider: one.provider, me: 'viktor@kubriksoftware.com' });

  assert.deepStrictEqual(message.to, { handle: 'bitbucket:bchavez', display: 'bchavez' });
  assert.deepStrictEqual(message.links, [{ text: 'Open the pull request', url: 'https://bitbucket.org/x/43' }]);
  assert.ok(message.facts.some((fact) => fact.label === 'Waiting' && fact.value === '6 days'));
  assert.strictEqual(message.key, due.key);

  const text = JSON.stringify(message).toLowerCase();
  for (const word of ['teams', 'slack', 'webhook', 'graph', 'channel', 'tenant']) {
    assert.ok(!text.includes(word), `the reviewer must not know about ${word}`);
  }
});

/*
 * You are named the way everybody else is, so you are matched once in the
 * delivery extension's own list. It used to build an address out of the setting
 * called "your name on the forge" — a display name — which produced a handle
 * nothing could match, and the one rule meant to tell you reached nobody.
 */
test('a reminder meant for you names you the way the forge does', () => {
  const one = row({ flags: ['UNREVIEWED'], ageDays: 4 });
  const due = R.dueFor({ row: one, threads: [], rules: on('UNREVIEWED', 2) });
  const message = R.asMessage(due, { row: one, provider: 'BITBUCKET', me: 'Viktor Karpyuk' });
  assert.strictEqual(message.to.handle, 'bitbucket:Viktor Karpyuk');
  assert.ok(!message.to.handle.startsWith('email:'), 'a name is not an address');
});

/*
 * The key carries the number of days, so a pull request that goes on being
 * ignored is mentioned again tomorrow rather than once and never — while the
 * same day's reminder is never sent twice.
 */
test('the key is the same within a day and different the next', () => {
  const same = R.dueFor({ row: row(), threads: [thread({ waitingDays: 6 })], rules: on('UNANSWERED', 3) });
  const again = R.dueFor({ row: row(), threads: [thread({ waitingDays: 6 })], rules: on('UNANSWERED', 3) });
  const tomorrow = R.dueFor({ row: row(), threads: [thread({ waitingDays: 7 })], rules: on('UNANSWERED', 3) });
  assert.strictEqual(same.key, again.key);
  assert.notStrictEqual(same.key, tomorrow.key);
});
