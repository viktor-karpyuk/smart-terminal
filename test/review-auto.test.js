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

/**
 * A store that answers only what the ticker asks of it.
 *
 * The light watch is off unless a test is about it: it runs on a clock of its
 * own, and a test holding one clock by hand wants one thing on it.
 */
function store(prefs = {}, repos = []) {
  return {
    pref: (key, fallback) => (key in prefs ? prefs[key] : ('auto.watch' === key ? 'false' : fallback)),
    pendingJobs: () => [],
    repos: () => repos,
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

// ------------------------------------------------------------- the light watch

/*
 * "Notice a new pull request straight away" and "ask every repository every five
 * seconds" are not the same thing, and only the first is wanted. Fourteen
 * repositories every five seconds is ten thousand requests an hour against a
 * limit of a thousand — throttled inside a minute, after which the reviewer sees
 * nothing at all. One repository per tick costs one request per tick however
 * many there are, and the whole set still comes round in a minute or so.
 */
const someRepos = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `repo-${i}`, autoReview: true }));

function watcher(repos, { onRefresh = async () => ({}) } = {}) {
  const time = clock();
  const asked = [];
  const auto = new AutoReviewer({
    store: store({ 'auto.enabled': 'false', 'auto.watch': 'true' }, repos),
    engine: {
      activity: { list: () => [] },
      refreshPrs: async (repoId, options) => { asked.push(repoId); return onRefresh(repoId, options); },
    },
    fixer: null,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  return { auto, time, asked };
}

test('the watch looks at one repository per tick, in turn', async () => {
  const { auto, asked } = watcher(someRepos(3));
  await auto.watchOnce();
  await auto.watchOnce();
  await auto.watchOnce();
  await auto.watchOnce();
  assert.deepEqual(asked, ['r0', 'r1', 'r2', 'r0'], 'round and round, one at a time');
});

test('one request a tick, whatever the size of the fleet', async () => {
  const { auto, asked } = watcher(someRepos(14));
  await auto.watchOnce();
  assert.equal(asked.length, 1, 'fourteen repositories cost one request, not fourteen');
});

test('what the watch costs is a number the screen can show', () => {
  const { auto } = watcher(someRepos(14));
  const budget = auto.watchBudget();
  assert.equal(budget.repos, 14);
  assert.equal(budget.everySeconds, 120, 'the setting says how often each one is looked at');
  assert.equal(budget.eachSeenSeconds, 120);
  assert.equal(budget.requestsPerHour, 420, 'fourteen every two minutes, of Bitbucket\'s thousand');
});

/*
 * The setting says how often each repository is looked at; the tick is that
 * divided by however many there are. So the round keeps its meaning while the
 * asking is spread through it rather than arriving all at once every two
 * minutes — kinder to the other end, and to the review work sharing the process.
 */
test('the round is spread out rather than arriving in a burst', () => {
  assert.equal(watcher(someRepos(14)).auto.watchTickMs(), 8571, 'fourteen repositories, one about every eight and a half seconds');
  assert.equal(watcher(someRepos(1)).auto.watchTickMs(), 120000, 'one repository is simply asked every two minutes');
  assert.equal(watcher(someRepos(2)).auto.watchTickMs(), 60000);
});

/*
 * A fleet big enough to divide the round into nothing must not become a busy
 * loop. Past that point the round takes longer than it says, which is the right
 * way to run out of room.
 */
test('a very large fleet slows the round rather than the gap', () => {
  const { auto } = watcher(someRepos(400));
  assert.equal(auto.watchTickMs(), 1000, 'never faster than one a second');
});

test('a repository that cannot be listed does not stop the round', async () => {
  const { auto, asked } = watcher(someRepos(3), {
    onRefresh: async (repoId) => { if (repoId === 'r1') throw new Error('502'); return {}; },
  });
  await auto.watchOnce();
  await auto.watchOnce();
  await auto.watchOnce();
  assert.deepEqual(asked, ['r0', 'r1', 'r2'], 'the one that failed is simply next time round');
});

test('the watch stands aside while a review cycle is running', async () => {
  const { auto, asked } = watcher(someRepos(3));
  auto.busy = true;
  await auto.watchOnce();
  assert.deepEqual(asked, [], 'the heavy cycle is already listing; two of them would be waste');
});

test('turned off, it asks nothing', async () => {
  const time = clock();
  const auto = new AutoReviewer({
    store: store({ 'auto.enabled': 'false', 'auto.watch': 'false' }, someRepos(3)),
    engine: { activity: { list: () => [] }, refreshPrs: async () => { throw new Error('should not be asked'); } },
    fixer: null,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  assert.equal(await auto.watchOnce(), null);
});

/*
 * Looking and reviewing are different jobs: one costs a request, the other costs
 * money. Somebody who reviews by hand has *more* use for knowing a pull request
 * arrived, not less — they are the one who has to go and press it. Tied to
 * `autoReview` this watched nothing at all on a fleet reviewed by hand, which is
 * the ordinary case and was the case on the machine it was written for.
 */
test('a repository reviewed by hand is watched just the same', async () => {
  const { auto, asked } = watcher([
    { id: 'r0', name: 'auto', autoReview: true },
    { id: 'r1', name: 'by hand', autoReview: false },
  ]);
  await auto.watchOnce();
  await auto.watchOnce();
  assert.deepEqual(asked, ['r0', 'r1'], 'both, because both can gain a pull request');
});

test('a hidden repository is not watched', async () => {
  const { auto } = watcher([]);
  assert.equal(await auto.watchOnce(), null, 'nothing to look at is nothing asked');
});

/*
 * `schedule` takes the review clock down before putting it back, which it does
 * after every cycle. The watch runs on its own clock for exactly that reason,
 * and taking it down with the other one would have stopped it six times an hour
 * and left it re-armed only by luck.
 */
test('a review cycle does not take the watch down with it', () => {
  const stopped = [];
  const time = clock();
  const auto = new AutoReviewer({
    store: store({ 'auto.enabled': 'false', 'auto.watch': 'true' }, someRepos(2)),
    engine: { activity: { list: () => [] }, refreshPrs: async () => ({}) },
    fixer: null,
    setTimer: time.setTimer,
    clearTimer: (id) => stopped.push(id),
  });
  auto.armWatch();
  const armed = auto.watchTimer;
  assert.ok(armed, 'the watch is armed');

  auto.schedule(1000, () => {});
  assert.strictEqual(auto.watchTimer, armed, 'and is still the same timer after a cycle is scheduled');
  assert.ok(!stopped.includes(armed), 'nothing cleared it');

  auto.stopAll();
  assert.equal(auto.watchTimer, null, 'stopping everything does stop it');
});
