'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { worthSampling, median, normsFrom, SAMPLE_EVERY_MS } = require('../electron/history.js');

const now = Date.parse('2026-09-03T12:00:00Z');

test('the first reading is always kept', () => {
  assert.equal(worthSampling(null, { worst: null, conversationId: 'c1' }, now), true);
});

test('an unchanged verdict soon after the last one is not kept', () => {
  const last = { at: now - 60000, worst: 'medium', conversation_id: 'c1' };
  assert.equal(worthSampling(last, { worst: 'medium', conversationId: 'c1' }, now), false);
});

test('a verdict that moved is kept, in either direction', () => {
  const last = { at: now - 60000, worst: 'medium', conversation_id: 'c1' };
  assert.equal(worthSampling(last, { worst: 'high', conversationId: 'c1' }, now), true);
  assert.equal(worthSampling(last, { worst: null, conversationId: 'c1' }, now), true);
});

test('a new conversation starts its own record', () => {
  const last = { at: now - 60000, worst: 'medium', conversation_id: 'c1' };
  assert.equal(worthSampling(last, { worst: 'medium', conversationId: 'c2' }, now), true);
});

test('a quiet session is still sampled, but only now and then', () => {
  const last = { at: now - SAMPLE_EVERY_MS + 1000, worst: null, conversation_id: 'c1' };
  assert.equal(worthSampling(last, { worst: null, conversationId: 'c1' }, now), false);
  assert.equal(
    worthSampling({ ...last, at: now - SAMPLE_EVERY_MS }, { worst: null, conversationId: 'c1' }, now),
    true,
  );
});

test('a missing conversation id on both sides is not a change', () => {
  const last = { at: now - 1000, worst: null, conversation_id: null };
  assert.equal(worthSampling(last, { worst: null, conversationId: null }, now), false);
});

test('the median is the middle, and averages the two in the middle of an even run', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([]), 0);
  assert.equal(median([5, NaN, 1]), 3, 'rubbish is dropped, not counted');
});

test('one enormous session does not drag the norm with it', () => {
  const ordinary = { context_last: 100000, context_window: 1000000, effective_input: 50000, output_tokens: 5000, requests: 20, auto_compactions: 0 };
  const monster = { context_last: 990000, context_window: 1000000, effective_input: 90000000, output_tokens: 4000000, requests: 5000, auto_compactions: 9 };
  const norms = normsFrom([ordinary, ordinary, ordinary, monster]);
  assert.equal(norms.sessions, 4);
  assert.equal(norms.requests, 20, 'the median stays with the ordinary sessions');
  assert.equal(norms.autoCompactions, 0);
  assert.ok(norms.contextShare < 0.3, `expected the typical share, got ${norms.contextShare}`);
});

test('nothing measured yet is no norm rather than a made-up one', () => {
  assert.equal(normsFrom([]), null);
  assert.equal(normsFrom(null), null);
});
