'use strict';

/**
 * Everything this extension decides before a message leaves the machine.
 *
 * All of it protects the person on the other end. An extension decides what is
 * worth saying and when; these decide whether it may — and each one of them is
 * a rule somebody will want to argue with, which is why they are here and not
 * buried in a send function.
 */

const test = require('node:test');
const assert = require('node:assert');
const R = require('../electron/teams-rules');

const app = (extra = {}) => ({ id: 'code-review', name: 'Code Reviewer', stance: 'ALLOW', dailyCap: 20, ...extra });
const person = (extra = {}) => ({ id: 'p1', handle: 'bitbucket:bchavez', display: 'Braian', address: 'b@k.com', ...extra });
const message = (extra = {}) => R.readMessage({ to: { handle: 'bitbucket:bchavez' }, title: 'PR #43 is waiting on you', ...extra });

// A Wednesday at 10:00, well inside anybody's working hours.
const WEDNESDAY_10 = new Date('2026-09-23T10:00:00').getTime();

// ---------------------------------------------------------------- what is a message

test('a message is what the contract says and nothing else', () => {
  const read = R.readMessage({
    to: { email: ' b@k.com ', handle: '', channel: '' },
    title: '  PR #43  ',
    body: 'Two comments.',
    facts: [{ label: 'Branch', value: 'feature/x' }, { label: '', value: 'dropped' }, 'nonsense'],
    links: [{ text: 'Open', url: 'https://bitbucket.org/x' }, { text: 'Bad', url: 'javascript:alert(1)' }, { url: 'http://insecure' }],
    key: 'code-review:pr:43',
    level: 'shouty',
  });
  assert.strictEqual(read.to.email, 'b@k.com');
  assert.strictEqual(read.to.handle, null);
  assert.strictEqual(read.title, 'PR #43');
  assert.deepStrictEqual(read.facts, [{ label: 'Branch', value: 'feature/x' }]);
  // A card's button opens a link and nothing else, so anything that is not the
  // web is not a link a person can be sent.
  assert.deepStrictEqual(read.links, [{ text: 'Open', url: 'https://bitbucket.org/x' }]);
  assert.strictEqual(read.level, 'normal', 'a level nobody defined is not urgent');
});

test('a message with no title, or nobody to send it to, is not a message', () => {
  assert.match(R.problemWith(R.readMessage({ to: { email: 'a@b.c' } })) ?? '', /title/);
  assert.match(R.problemWith(R.readMessage({ title: 'Hello' })) ?? '', /nobody/);
  assert.strictEqual(R.problemWith(message()), null);
});

// ---------------------------------------------------------------- the clock

test('hours are hours, and the weekend is not one', () => {
  const hours = { from: 9, to: 18, weekdaysOnly: true };
  assert.strictEqual(R.withinHours(new Date('2026-09-23T09:00:00'), hours), true);
  assert.strictEqual(R.withinHours(new Date('2026-09-23T17:59:00'), hours), true);
  assert.strictEqual(R.withinHours(new Date('2026-09-23T18:00:00'), hours), false, 'the end is the end');
  assert.strictEqual(R.withinHours(new Date('2026-09-23T08:59:00'), hours), false);
  assert.strictEqual(R.withinHours(new Date('2026-09-25T10:00:00'), hours), true, 'Friday');
  assert.strictEqual(R.withinHours(new Date('2026-09-26T10:00:00'), hours), false, 'Saturday');
  assert.strictEqual(R.withinHours(new Date('2026-09-27T10:00:00'), hours), false, 'Sunday');
  assert.strictEqual(R.withinHours(new Date('2026-09-27T10:00:00'), { ...hours, weekdaysOnly: false }), true);
});

/*
 * Somebody who works nights sets 20 to 04, and a window that wraps midnight is
 * two windows — read as one range it is empty, and nothing would ever send.
 */
test('a window that wraps midnight is still a window', () => {
  const nights = { from: 20, to: 4, weekdaysOnly: false };
  assert.strictEqual(R.withinHours(new Date('2026-09-23T22:00:00'), nights), true);
  assert.strictEqual(R.withinHours(new Date('2026-09-23T02:00:00'), nights), true);
  assert.strictEqual(R.withinHours(new Date('2026-09-23T12:00:00'), nights), false);
});

// ---------------------------------------------------------------- the decision

const decide = (extra = {}) => R.decide({ message: message(), app: app(), person: person(), now: WEDNESDAY_10, ...extra });

test('with everything in order it sends', () => {
  assert.strictEqual(decide().verdict, 'SEND');
});

test('an extension nobody has allowed is asked about, not refused in silence', () => {
  assert.deepStrictEqual(
    { v: decide({ app: app({ stance: 'ASK' }) }).verdict, w: decide({ app: app({ stance: 'ASK' }) }).why },
    { v: 'ASK', w: 'asks-first' },
  );
  assert.strictEqual(decide({ app: app({ stance: 'DENY' }) }).why, 'not-allowed');
  assert.strictEqual(decide({ app: null }).why, 'not-allowed');
});

/*
 * The one that must never be a silent success: an extension told its message
 * went, when nobody could be found to send it to, would quietly stop reminding
 * anybody while reporting that it had.
 */
test('a person nobody could match is said out loud', () => {
  assert.strictEqual(decide({ person: person({ address: null }) }).why, 'no-address');
  assert.strictEqual(decide({ person: null }).why, 'no-address');
});

test('the same thing is never said twice', () => {
  const said = { sentAt: new Date(WEDNESDAY_10 - 3600_000).toISOString() };
  const out = decide({ alreadySent: said });
  assert.strictEqual(out.verdict, 'HOLD');
  assert.strictEqual(out.why, 'already-sent');
  assert.match(out.detail, /1 h ago|60 min ago/);
});

test('an extension that has spent its day waits for tomorrow', () => {
  assert.strictEqual(decide({ sentByAppToday: 20 }).why, 'app-cap');
  assert.strictEqual(decide({ sentByAppToday: 19 }).verdict, 'SEND');
  // A ceiling of zero is no ceiling, not a ban.
  assert.strictEqual(decide({ app: app({ dailyCap: 0 }), sentByAppToday: 500 }).verdict, 'SEND');
});

test('one person hears from us once a day, whoever is asking', () => {
  assert.strictEqual(decide({ sentToPersonToday: 1 }).why, 'person-cap');
  assert.strictEqual(decide({ sentToPersonToday: 1, perPersonPerDay: 2 }).verdict, 'SEND');
});

test('out of hours it waits rather than disappearing', () => {
  const night = new Date('2026-09-23T23:40:00').getTime();
  const out = decide({ now: night });
  assert.strictEqual(out.verdict, 'HOLD');
  assert.strictEqual(out.why, 'quiet-hours');
  // Urgent is what the word is for, and the sender is accountable for saying it.
  assert.strictEqual(decide({ now: night, message: message({ level: 'urgent' }) }).verdict, 'SEND');
});

/*
 * A channel is a place, not a person: there is no address to match and nobody's
 * day to protect, so the rules that exist for a person do not apply to it.
 */
test('a channel is a place, not a person', () => {
  const toChannel = R.readMessage({ to: { channel: 'builds' }, title: 'orders-api is down' });
  assert.strictEqual(R.decide({ message: toChannel, app: app(), person: null, now: WEDNESDAY_10 }).verdict, 'SEND');
  assert.strictEqual(
    R.decide({ message: toChannel, app: app(), person: null, now: WEDNESDAY_10, sentToPersonToday: 99 }).verdict,
    'SEND',
  );
});

// ---------------------------------------------------------------- who somebody is

test('a handle carries the world it came from', () => {
  assert.deepStrictEqual(R.readHandle('bitbucket:bchavez'), { kind: 'bitbucket', name: 'bchavez', handle: 'bitbucket:bchavez' });
  assert.deepStrictEqual(R.readHandle('rota:payments'), { kind: 'rota', name: 'payments', handle: 'rota:payments' });
  // Written before any of this existed, and still meaning something.
  assert.deepStrictEqual(R.readHandle('a@b.c'), { kind: 'email', name: 'a@b.c', handle: 'email:a@b.c' });
  assert.deepStrictEqual(R.readHandle('bchavez'), { kind: 'handle', name: 'bchavez', handle: 'handle:bchavez' });
  assert.strictEqual(R.readHandle('  '), null);
});

test('an address is only taken when the handle really is one', () => {
  assert.strictEqual(R.addressFrom('email:b@k.com'), 'b@k.com');
  assert.strictEqual(R.addressFrom('bitbucket:b@k.com'), 'b@k.com', 'a forge handle that is an address');
  assert.strictEqual(R.addressFrom('bitbucket:bchavez'), null);
  assert.strictEqual(R.addressFrom('bitbucket:b@k.com', { matchByEmail: false }), null, 'turned off, nothing is guessed');
});

/*
 * `9 and 9` read literally is "after nine and before nine", which is never — a
 * setting that looks like all day and quietly holds every message for ever.
 */
test('both ends the same is the whole day, not never', () => {
  const hours = { from: 9, to: 9, weekdaysOnly: false };
  for (const hour of [0, 8, 9, 13, 23]) {
    const at = new Date(2026, 8, 23, hour, 30);
    assert.ok(R.withinHours(at, hours), `${hour}:30 should be within an all-day window`);
  }
});

test('equal ends still respect weekdays', () => {
  const hours = { from: 9, to: 9, weekdaysOnly: true };
  assert.ok(!R.withinHours(new Date(2026, 8, 27, 13, 0), hours), 'Sunday is not a working day');
  assert.ok(R.withinHours(new Date(2026, 8, 23, 13, 0), hours), 'Wednesday is');
});
