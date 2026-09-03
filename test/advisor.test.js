'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Advisor, buildPrompt } = require('../electron/advisor.js');

/** A verdict shaped the way the monitor hands them out. */
function verdict({ requests = 30, last = 700000, window = 1000000, findings = [] } = {}) {
  return {
    ok: true,
    requests,
    spanMs: 3600000,
    totals: { input: 10, output: 5000, cacheWrite: 1000, cacheRead: 900000 },
    effectiveInput: 91010,
    context: { window, peak: last, last, mean: last, turnsAbove: 0, share: 0, curve: [] },
    latency: { turns: 10, p50: 60000, p95: 120000, totalMs: 600000 },
    compactions: [],
    reprimes: { count: 0, tokens: 0 },
    tools: [],
    repeated: [],
    errors: [],
    findings,
    projection: null,
  };
}

function advisorFor(overrides = {}) {
  return new Advisor({
    profileFor: () => ({ id: 'p1', name: 'work', configDir: null, shell: '/bin/zsh' }),
    verdictFor: (id) => (id === 'missing' ? null : verdict()),
    nameFor: (id) => `session-${id}`,
    ...overrides,
  });
}

test('the prompt carries the measurements and nothing else', () => {
  const prompt = buildPrompt({ self: 'You: 70% of the window.', others: [] });
  assert.match(prompt, /You: 70% of the window\./);
  assert.match(prompt, /at most 120 words/);
  assert.match(prompt, /What should this session do next/);
  assert.equal(/OTHER SESSIONS/.test(prompt), false);
});

test('the other sessions appear as one line each when there are any', () => {
  const prompt = buildPrompt({ self: 'me', others: ['a: fine', 'b: full'] });
  assert.match(prompt, /OTHER SESSIONS RUNNING ALONGSIDE IT:/);
  assert.match(prompt, /- a: fine/);
  assert.match(prompt, /- b: full/);
});

test('a question of your own replaces the default one', () => {
  const prompt = buildPrompt({ self: 'me', question: 'Should I compact or start again?' });
  assert.match(prompt, /THE QUESTION: Should I compact or start again\?/);
  assert.equal(/What should this session do next/.test(prompt), false);
});

test('the prompt refuses to invent advice for a healthy session', () => {
  const prompt = buildPrompt({ self: 'me' });
  assert.match(prompt, /do not manufacture advice/);
});

test('a session with nothing measured is not asked about', async () => {
  const answer = await advisorFor().ask('missing');
  assert.equal(answer.ok, false);
  assert.match(answer.error, /nothing measured/);
});

test('no account means no request', async () => {
  const answer = await advisorFor({ profileFor: () => null }).ask('a');
  assert.equal(answer.ok, false);
  assert.match(answer.error, /No account/);
});

test('a second ask inside the cooldown returns the answer already held', async () => {
  const advisor = advisorFor();
  advisor.lastAsked.set('a', Date.now());
  const held = { ok: true, sessionId: 'a', text: 'Compact at the next checkpoint.', at: Date.now() };
  advisor.answers.set('a', held);
  assert.equal(await advisor.ask('a'), held);
});

test('inside the cooldown with nothing held, it says when to come back', async () => {
  const advisor = advisorFor();
  advisor.lastAsked.set('a', Date.now());
  const answer = await advisor.ask('a');
  assert.equal(answer.ok, false);
  assert.match(answer.error, /next reading is in \d+/);
});

test('peek never asks for anything', () => {
  const advisor = advisorFor();
  assert.equal(advisor.peek('a'), null);
  const held = { ok: true, text: 'fine' };
  advisor.answers.set('a', held);
  assert.equal(advisor.peek('a'), held);
});

test('the cooldown is per session, not shared', async () => {
  const advisor = advisorFor();
  advisor.lastAsked.set('a', Date.now());
  const answer = await advisor.ask('a');
  assert.equal(answer.ok, false);
  // 'b' has never been asked, so it is not held back by 'a'.
  assert.equal(advisor.lastAsked.has('b'), false);
});
