'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MessageBridge } = require('../electron/message-bridge.js');

const ROSTER = [
  { id: 'a', name: 'alpha', profile: 'work', cwd: '/w/a', conversation: 'conv-a', groupId: 'g1', groupName: 'api', state: 'idle' },
  { id: 'b', name: 'beta', profile: 'work', cwd: '/w/b', conversation: 'conv-b', groupId: 'g1', groupName: 'api', state: 'busy' },
  { id: 'c', name: 'gamma', profile: 'home', cwd: '/w/c', conversation: 'conv-c', groupId: null, groupName: null, state: 'idle' },
];

function bridge({ reach = 'group', health = (id, opts) => (opts?.brief ? `${id}: fine` : `You: reading for ${id}`) } = {}) {
  const queued = [];
  const made = new MessageBridge({
    socketPath: '/tmp/never-bound',
    reach: () => reach,
    roster: () => ROSTER,
    write: () => false,
    isFree: () => false,
    store: { queue: (m) => queued.push(m), pending: () => [], markDelivered: () => {}, markRead: () => {} },
    health,
  });
  made.queued = queued;
  return made;
}

test('a session asking about itself gets the full reading', async () => {
  const answer = await bridge().handle({ op: 'health', from: 'a' });
  assert.equal(answer.ok, true);
  assert.equal(answer.scope, 'me');
  assert.match(answer.me, /reading for a/);
});

test('asking about yourself works even with messaging turned off', async () => {
  const answer = await bridge({ reach: 'off' }).handle({ op: 'health', from: 'a' });
  assert.equal(answer.ok, true, 'your own numbers are not a message to anyone');
});

test('asking about the others obeys reach', async () => {
  const grouped = await bridge().handle({ op: 'health', from: 'a', scope: 'reach' });
  assert.deepEqual(grouped.others.map((o) => o.name), ['beta'], 'group reach stops at the group');

  const everyone = await bridge({ reach: 'all' }).handle({ op: 'health', from: 'a', scope: 'reach' });
  assert.deepEqual(everyone.others.map((o) => o.name), ['beta', 'gamma']);
});

test('asking about the others is refused when messaging is off', async () => {
  const answer = await bridge({ reach: 'off' }).handle({ op: 'health', from: 'a', scope: 'reach' });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /turned off/);
});

test('the others come back in one line each, not in full', async () => {
  const answer = await bridge({ reach: 'all' }).handle({ op: 'health', from: 'a', scope: 'reach' });
  for (const other of answer.others) assert.match(other.verdict, /: fine$/);
});

test('a session nothing is known about is left out rather than shown blank', async () => {
  const answer = await bridge({
    reach: 'all',
    health: (id, opts) => (id === 'c' ? null : opts?.brief ? `${id}: fine` : 'you'),
  }).handle({ op: 'health', from: 'a', scope: 'reach' });
  assert.deepEqual(answer.others.map((o) => o.name), ['beta']);
});

test('without a monitor behind it the channel says so', async () => {
  const answer = await bridge({ health: null }).handle({ op: 'health', from: 'a' });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /not measuring/);
});

test('a session the app does not know is refused', async () => {
  const answer = await bridge().handle({ op: 'health', from: 'nobody' });
  assert.equal(answer.ok, false);
});

test('a note from the monitor is queued as coming from the app, not a session', () => {
  const made = bridge();
  const result = made.note('a', 'Your context is at 98%.', { subject: 'this session' });
  assert.equal(result.ok, true);
  assert.equal(made.queued.length, 1);
  assert.equal(made.queued[0].from, 'smart-terminal', 'the app is the sender; the column is NOT NULL');
  assert.equal(made.queued[0].to, 'a');
  assert.match(made.queued[0].body, /session monitor/);
  assert.match(made.queued[0].body, /Your context is at 98%\./);
});

test('an empty note is refused rather than delivered', () => {
  assert.equal(bridge().note('a', '   ').ok, false);
  assert.equal(bridge().note('', 'something').ok, false);
});

// --- the roster a session reads before it talks to anybody -----------------

test('a session is told who it is, which it has no other way to know', async () => {
  const answer = await bridge().handle({ op: 'roster', from: 'a' });
  assert.equal(answer.you.name, 'alpha');
  assert.equal(answer.you.conversation, 'conv-a');
  assert.equal(answer.you.group, 'api');
});

test('every session it can reach comes with its conversation id', async () => {
  const answer = await bridge({ reach: 'all' }).handle({ op: 'roster', from: 'a' });
  assert.deepEqual(
    answer.sessions.map((s) => [s.name, s.conversation]),
    [['beta', 'conv-b'], ['gamma', 'conv-c']],
  );
});

test('sessions out of reach are named rather than hidden', async () => {
  const answer = await bridge().handle({ op: 'roster', from: 'a' });
  assert.deepEqual(answer.sessions.map((s) => s.name), ['beta']);
  assert.deepEqual(answer.beyond.map((s) => s.name), ['gamma'], 'it exists — say so');
});

test('with everything in reach there is nothing beyond it', async () => {
  const answer = await bridge({ reach: 'all' }).handle({ op: 'roster', from: 'a' });
  assert.deepEqual(answer.beyond, []);
});

test('a session is never listed as beyond its own reach', async () => {
  const answer = await bridge({ reach: 'off' }).handle({ op: 'roster', from: 'a' });
  assert.equal(answer.beyond.some((s) => s.name === 'alpha'), false);
  assert.deepEqual(answer.beyond.map((s) => s.name), ['beta', 'gamma']);
});
