'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { brief, render, worthCarrying } = require('../electron/session-brief.js');

/** An assistant turn that calls a tool, shaped the way Claude Code writes it. */
function calls(id, name, input, extra = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-09-03T10:00:00Z',
    message: { usage: { output_tokens: 10 }, content: [{ type: 'tool_use', id, name, input }] },
    ...extra,
  };
}

/** The user row carrying what a tool answered. */
function answers(id, result) {
  return {
    type: 'user',
    timestamp: '2026-09-03T10:00:01Z',
    toolUseResult: result,
    message: { content: [{ type: 'tool_result', tool_use_id: id }] },
  };
}

function madeTask(n, subject) {
  return [calls(`c${n}`, 'TaskCreate', { subject }), answers(`c${n}`, { task: { id: String(n), subject } })];
}

test('an empty transcript carries nothing', () => {
  const entry = brief([]);
  assert.equal(entry.title, null);
  assert.equal(entry.open.length, 0);
  assert.equal(worthCarrying(entry), false);
  assert.equal(render(entry), null);
});

test('rubbish rows do not break it', () => {
  const entry = brief([null, 'nope', 42, { type: 'attachment' }]);
  assert.equal(worthCarrying(entry), false);
});

test('the title, the folder and the branch come off the rows', () => {
  const entry = brief([
    { type: 'assistant', timestamp: '2026-09-03T10:00:00Z', cwd: '/w/api', gitBranch: 'fix/login', message: { usage: {} } },
    { type: 'ai-title', aiTitle: 'Fix the login redirect' },
  ]);
  assert.equal(entry.title, 'Fix the login redirect');
  assert.equal(entry.cwd, '/w/api');
  assert.equal(entry.branch, 'fix/login');
  assert.equal(entry.turns, 1);
});

test('a detached checkout is not reported as a branch', () => {
  const entry = brief([{ type: 'assistant', cwd: '/w', gitBranch: 'HEAD', message: { usage: {} } }]);
  assert.equal(entry.branch, null);
});

test('the last thing asked wins over the ones before it', () => {
  const entry = brief([
    { type: 'last-prompt', lastPrompt: 'first thing' },
    { type: 'last-prompt', lastPrompt: 'what I actually said last' },
  ]);
  assert.equal(entry.lastPrompt, 'what I actually said last');
});

test('a very long prompt is cut rather than carried whole', () => {
  const entry = brief([{ type: 'last-prompt', lastPrompt: 'x'.repeat(2000) }]);
  assert.ok(entry.lastPrompt.length < 700);
  assert.ok(entry.lastPrompt.endsWith('…'));
});

test('tasks are matched to their subjects through the create result', () => {
  const entry = brief([...madeTask(1, 'Wire the parser'), ...madeTask(2, 'Write the tests')]);
  assert.deepEqual(entry.open.map((t) => t.subject), ['Wire the parser', 'Write the tests']);
  assert.equal(entry.done.length, 0);
});

test('a completed task moves out of the open list', () => {
  const entry = brief([
    ...madeTask(1, 'Wire the parser'),
    ...madeTask(2, 'Write the tests'),
    calls('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
  ]);
  assert.deepEqual(entry.open.map((t) => t.subject), ['Write the tests']);
  assert.deepEqual(entry.done.map((t) => t.subject), ['Wire the parser']);
});

test('nothing open, no name and nothing asked is nothing to hand over', () => {
  const rows = [];
  for (let i = 1; i <= 3; i += 1) {
    rows.push(...madeTask(i, `task ${i}`));
    rows.push(calls(`u${i}`, 'TaskUpdate', { taskId: String(i), status: 'completed' }));
  }
  const entry = brief(rows);
  assert.equal(entry.done.length, 3);
  assert.equal(worthCarrying(entry), false, 'finished work alone is not something to continue');
});

test('a cancelled task is not open and not finished', () => {
  const entry = brief([...madeTask(1, 'Try the other way'), calls('u1', 'TaskUpdate', { taskId: '1', status: 'cancelled' })]);
  assert.equal(entry.open.length, 0);
  assert.equal(entry.done.length, 0);
});

test('an update before its create still lands on the right task', () => {
  const entry = brief([
    calls('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ...madeTask(1, 'Out of order'),
  ]);
  assert.deepEqual(entry.done.map((t) => t.subject), ['Out of order']);
});

test('the rendered brief reads as an instruction, and says to go and check', () => {
  const entry = brief([
    { type: 'ai-title', aiTitle: 'Fix the login redirect' },
    { type: 'last-prompt', lastPrompt: 'the redirect loops on safari' },
    { type: 'assistant', cwd: '/w/api', gitBranch: 'fix/login', message: { usage: {} } },
    ...madeTask(1, 'Reproduce it'),
  ]);
  const text = render(entry, { command: 'npm run local' });
  assert.match(text, /Fix the login redirect/);
  assert.match(text, /Working in: \/w\/api \(branch fix\/login\)/);
  assert.match(text, /It had been running: npm run local/);
  assert.match(text, /"the redirect loops on safari"/);
  assert.match(text, /Still open:\n- Reproduce it/);
  assert.match(text, /read the files before changing them/);
});

test('a long finished list keeps the recent ones, not the first', () => {
  const rows = [{ type: 'ai-title', aiTitle: 'A long haul' }];
  for (let i = 1; i <= 30; i += 1) {
    rows.push(...madeTask(i, `task ${i}`));
    rows.push(calls(`u${i}`, 'TaskUpdate', { taskId: String(i), status: 'completed' }));
  }
  const text = render(brief(rows));
  assert.match(text, /Finished recently \(of 30\):/);
  assert.match(text, /- task 30/, 'the latest should be there');
  assert.equal(/- task 1\n/.test(text), false, 'the first should not be');
});

test('too many open tasks are counted rather than all listed', () => {
  const rows = [];
  for (let i = 1; i <= 20; i += 1) rows.push(...madeTask(i, `open ${i}`));
  const text = render(brief(rows));
  assert.match(text, /…and 8 more/);
});

test('a session with only a name is still worth carrying', () => {
  const entry = brief([{ type: 'ai-title', aiTitle: 'Something' }]);
  assert.equal(worthCarrying(entry), true);
  assert.match(render(entry), /What it was doing: Something/);
});
