'use strict';

/*
 * The CLI runner against a fake `claude`: a small Node script that prints
 * stream-json the way the real one does, so the whole pipe — argv, stdin,
 * events, the result, failover between accounts — runs without an account.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClaudeRunner, buildArgs, parseEvent, orderAccounts, accountTrouble } = require('../electron/review-claude');

function fakeClaude(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}\n${script}`);
  fs.chmodSync(file, 0o755);
  return file;
}

const PRINT = `
const lines = [];
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const args = process.argv.slice(2);
  const config = process.env.CLAUDE_CONFIG_DIR || 'default';
  require('fs').writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, config }));
  out({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'haiku' });
  if (config.endsWith('broke')) {
    out({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1700000000' });
    process.exit(1);
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the diff\\nmore' }, { type: 'tool_use', name: 'Bash', input: { command: 'git diff --stat' } }] } });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4, resetsAt: 1700000000 } });
  out({ type: 'result', is_error: false, result: 'done', structured_output: { summary: 'ok', findings: [] }, session_id: 'sess-1', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 }, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push' } }] });
});
`;

test('every permission pattern is its own argument, and the schema travels as JSON', () => {
  const args = buildArgs({ model: 'sonnet', allowedTools: ['Read', 'Bash(git diff *)'], disallowedTools: ['Edit'], schema: { type: 'object' } });
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Bash(git diff *)', '--disallowedTools', 'Edit', '--model', 'sonnet', '--json-schema', '{"type":"object"}']);
});

test('stream events are read into what the reviewer needs', () => {
  assert.deepEqual(parseEvent('{"type":"system","subtype":"init","session_id":"s","model":"m"}'), [{ kind: 'started', sessionId: 's', model: 'm' }]);
  assert.equal(parseEvent('garbage'), null);
  assert.equal(parseEvent('{"type":"user"}'), null);
  const tools = parseEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }] } }));
  assert.deepEqual(tools, [{ kind: 'tool', tool: 'Read', detail: '/a' }]);
});

test('one run: argv, prompt on stdin, account, events, result, usage', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-log-')), 'log.json');
  process.env.FAKE_LOG = log;
  const binary = fakeClaude(PRINT);
  const usage = [];
  const events = [];
  const runner = new ClaudeRunner({ accounts: async () => [{ id: 'a', name: 'Main', configDir: '/cfg/main', claudeCommand: binary }], resolvePath: async () => process.env.PATH, onUsage: (u) => usage.push(u) });
  const result = await runner.run({ kind: 'review', cwd: os.tmpdir(), prompt: 'REVIEW THIS', model: 'haiku', allowedTools: ['Bash(git diff *)'], onEvent: (e) => events.push(e.kind) });
  assert.equal(result.ok, true);
  assert.equal(result.toolUses, 1);
  assert.deepEqual(result.structured, { summary: 'ok', findings: [] });
  assert.equal(result.sessionId, 'sess-1');
  assert.deepEqual(result.denials, ['Bash(git push)']);
  assert.equal(result.costUsd, 0.12);
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(seen.input, 'REVIEW THIS');
  assert.equal(seen.config, '/cfg/main');
  assert.ok(seen.args.includes('Bash(git diff *)'));
  assert.deepEqual(events, ['started', 'thinking', 'tool', 'limit']);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].tokensOut, 20);
  assert.equal(usage[0].accountId, 'a');
});

test('an account out of room is rested and the next one takes the run', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-log-')), 'log.json');
  process.env.FAKE_LOG = log;
  const binary = fakeClaude(PRINT);
  const switched = [];
  const runner = new ClaudeRunner({
    accounts: async () => [{ id: 'x', name: 'Broke', configDir: '/cfg/broke', claudeCommand: binary }, { id: 'y', name: 'Spare', configDir: '/cfg/spare', claudeCommand: binary }],
    resolvePath: async () => process.env.PATH,
  });
  const result = await runner.run({ cwd: os.tmpdir(), prompt: 'p', resume: 'old', onEvent: (e) => { if (e.kind === 'account') switched.push(`${e.from}->${e.to}`); } });
  assert.equal(result.ok, true);
  assert.equal(result.accountName, 'Spare');
  assert.deepEqual(switched, ['Broke->Spare']);
  assert.ok(!JSON.parse(fs.readFileSync(log, 'utf8')).args.includes('--resume'), 'a session cannot be resumed from another account');
  assert.ok(runner.resting.get('x') > Date.now());
  // The next run starts on the spare one directly.
  const again = await runner.run({ cwd: os.tmpdir(), prompt: 'p' });
  assert.equal(again.accountName, 'Spare');
});

test('a missing CLI says so, and a cancel is a cancel', async () => {
  const missing = new ClaudeRunner({ accounts: async () => [{ id: 'a', name: 'A', claudeCommand: '/nonexistent/claude' }] });
  const result = await missing.run({ cwd: os.tmpdir(), prompt: 'p' });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /not found|ENOENT|Could not start/);

  const slow = fakeClaude("setTimeout(() => {}, 60000); process.stdin.resume();");
  const runner = new ClaudeRunner({ accounts: async () => [{ id: 'a', name: 'A', claudeCommand: slow }], resolvePath: async () => process.env.PATH });
  const cancelled = await runner.run({ cwd: os.tmpdir(), prompt: 'p', register: (handle) => setTimeout(() => handle.cancel(), 100) });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);
});

test('account trouble is read from the text only when the run failed', () => {
  assert.equal(accountTrouble({ ok: false, text: '', stderr: 'Error: Not logged in · Please run /login', limits: [] }), 'signed-out');
  assert.equal(accountTrouble({ ok: true, text: 'the rate limit reached a high', stderr: '', limits: [] }), null);
  assert.equal(accountTrouble({ ok: true, text: '', stderr: '', limits: [{ status: 'rejected' }] }), 'limit');
});

test('accounts are tried from the chosen one, then its fallback, then everyone else', () => {
  const profiles = [{ id: 'a' }, { id: 'b', fallbackProfileId: 'c' }, { id: 'c', fallbackProfileId: 'b' }, { id: 'd' }];
  assert.deepEqual(orderAccounts(profiles, 'b').map((p) => p.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(orderAccounts(profiles, 'missing').map((p) => p.id), ['a', 'b', 'c', 'd']);
});
