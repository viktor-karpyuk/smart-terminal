'use strict';

/**
 * The clock behind the two things this app does on its own.
 *
 * Both of them shipped once as a switch on a screen with nothing behind it —
 * the reminder sweep was written, was reachable, and was never called by
 * anything. So what is tested here is not what the sweep does but *that it is
 * run*, which is the part nobody notices is missing.
 */

const test = require('node:test');
const assert = require('node:assert');
const { AutoReviewer } = require('../electron/review-auto');

/** A store that answers only what the ticker asks of it. */
function store(prefs = {}) {
  return {
    pref: (key, fallback) => (key in prefs ? prefs[key] : fallback),
    pendingJobs: () => [],
  };
}

/** A clock the test holds: nothing waits, and every timer is fired by hand. */
function clock() {
  const pending = [];
  return {
    setTimer: (fn, ms) => { pending.push({ fn, ms }); return pending.length; },
    clearTimer: () => {},
    /** Run whatever is scheduled, once, the way a tick would arrive. */
    async fire() {
      const next = pending.shift();
      if (!next) return false;
      await next.fn();
      return true;
    },
    get waiting() { return pending.length; },
    get delays() { return pending.map((one) => one.ms); },
  };
}

const engine = { refreshPrs: async () => {}, activity: { list: () => [] } };

test('the reminder sweep is run by the ticker, not left to be called by nobody', async () => {
  const time = clock();
  let swept = 0;
  const auto = new AutoReviewer({
    store: store({ 'auto.enabled': 'false' }),
    engine,
    fixer: {},
    remind: async () => { swept += 1; },
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });

  auto.start();
  await time.fire();            // the first, delayed tick
  assert.strictEqual(swept, 1, 'swept once the ticker started');
  await time.fire();            // and the one it scheduled after itself
  assert.strictEqual(swept, 2, 'and again on the next tick');
});

/*
 * "Review new commits on their own" and "chase a comment nobody answered" are
 * two different promises. Somebody who wants the second does not have to want
 * the first, and turning automatic reviews off must not quietly turn reminders
 * off with them.
 */
test('reminders are swept with automatic reviews off', async () => {
  const time = clock();
  let swept = 0;
  let reviewed = 0;
  const auto = new AutoReviewer({
    store: store({ 'auto.enabled': 'false' }),
    engine,
    fixer: {},
    remind: async () => { swept += 1; },
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  auto.runOnce = async () => { reviewed += 1; };

  auto.start();
  await time.fire();
  assert.strictEqual(reviewed, 0, 'nothing was reviewed');
  assert.strictEqual(swept, 1, 'and the reminders still ran');
});

/*
 * A sweep that throws must not take the clock with it: one failure would
 * otherwise stop everything this app does on its own, for as long as it is open.
 */
test('a sweep that throws does not stop the next tick', async () => {
  const time = clock();
  let tries = 0;
  const auto = new AutoReviewer({
    store: store({ 'auto.enabled': 'false' }),
    engine,
    fixer: {},
    remind: async () => { tries += 1; throw new Error('the network is not there'); },
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });

  auto.start();
  await time.fire();
  assert.strictEqual(tries, 1);
  assert.ok(time.waiting > 0, 'something is still scheduled');
  await time.fire();
  assert.strictEqual(tries, 2, 'and it tried again');
  assert.match(auto.status.lastMessage ?? '', /reminders: the network is not there/);
});

test('with nothing to remind about, the ticker behaves as it always did', async () => {
  const time = clock();
  const auto = new AutoReviewer({
    store: store({ 'auto.enabled': 'false' }),
    engine,
    fixer: {},
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  auto.start();
  await time.fire();
  assert.ok(time.waiting > 0);
});
