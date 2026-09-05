'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parseReport, replyFor, wantsBrief, compactionNote, EVENTS } = require('../electron/hooks.js');

// --- reading a report ------------------------------------------------------

test('a report is read into the few things the app acts on', () => {
  const report = parseReport({
    op: 'hook',
    event: 'PreCompact',
    session: 'st-1',
    at: 1700,
    payload: {
      session_id: 'conv-9',
      cwd: '/work/thing',
      transcript_path: '/t/conv-9.jsonl',
      trigger: 'manual',
      custom_instructions: 'keep the API decisions',
      hook_event_name: 'PreCompact',
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.event, 'PreCompact');
  assert.equal(report.session, 'st-1');
  assert.equal(report.conversation, 'conv-9');
  assert.equal(report.cwd, '/work/thing');
  assert.equal(report.trigger, 'manual');
  assert.equal(report.instructions, 'keep the API decisions');
  assert.equal(report.at, 1700);
});

test('an event the app does not listen for is refused by name', () => {
  const report = parseReport({ event: 'PostToolUse', payload: {} });
  assert.equal(report.ok, false);
  assert.match(report.error, /PostToolUse/);
});

test('nothing about a report is trusted to be the shape it usually is', () => {
  assert.equal(parseReport(null).ok, false);
  assert.equal(parseReport('SessionStart').ok, false);
  assert.equal(parseReport({ event: 'SessionStart' }).ok, true, 'a payload may simply be missing');

  // A field that is a string every observed time is still a field somebody
  // could send an object in, and none of these may become one.
  const odd = parseReport({
    event: 'SessionStart',
    session: { evil: true },
    payload: { session_id: ['a'], cwd: 3, source: 'made-up' },
  });
  assert.equal(odd.session, null);
  assert.equal(odd.conversation, null);
  assert.equal(odd.cwd, null);
  assert.equal(odd.source, null, 'a source that is not one of the four is no source');
});

// --- what gets answered ----------------------------------------------------

test('only SessionStart can put words into a session', () => {
  for (const [event, rule] of Object.entries(EVENTS)) {
    const report = parseReport({ event, payload: { source: 'resume' } });
    const reply = replyFor(report, 'here is what you were doing');
    if (rule.answers) {
      assert.equal(reply.hookSpecificOutput.hookEventName, event);
      assert.equal(reply.hookSpecificOutput.additionalContext, 'here is what you were doing');
    } else {
      assert.deepEqual(reply, {}, `${event} must not be able to inject context`);
    }
  }
});

test('nothing to say is said as nothing, not as an empty brief', () => {
  const report = parseReport({ event: 'SessionStart', payload: { source: 'compact' } });
  assert.deepEqual(replyFor(report, ''), {});
  assert.deepEqual(replyFor(report, '   '), {});
  assert.deepEqual(replyFor(report, null), {});
});

test('a brief is offered where context was lost, and not at a first start', () => {
  const after = (source) => wantsBrief(parseReport({ event: 'SessionStart', payload: { source } }));
  assert.equal(after('compact'), true, 'a compaction is exactly what a brief is for');
  assert.equal(after('resume'), true);
  assert.equal(after('clear'), true);
  // A session starting for the first time has no past to be reminded of.
  assert.equal(after('startup'), false);
  assert.equal(wantsBrief(parseReport({ event: 'Stop', payload: {} })), false);
});

test('what only Claude knows about a compaction is kept apart', () => {
  const note = compactionNote(parseReport({
    event: 'PreCompact',
    at: 42,
    payload: { trigger: 'auto' },
  }));
  assert.deepEqual(note, { at: 42, trigger: 'auto', instructions: null });
  // A trigger that is neither is not quietly turned into one of them.
  assert.equal(compactionNote(parseReport({ event: 'PreCompact', payload: { trigger: 'x' } })).trigger, null);
  assert.equal(compactionNote(parseReport({ event: 'Stop', payload: {} })), null);
});

// --- the program that runs inside the session ------------------------------

const REPORTER = path.join(__dirname, '..', 'plugin', 'hooks', 'report.js');

/** Run the hook the way Claude runs it, and collect what it prints. */
function runHook(event, payload, env) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [REPORTER, event],
      { env: { ...process.env, ...env }, timeout: 8000 },
      (error, stdout) => resolve({ error, stdout: stdout.trim() }),
    );
    child.stdin.end(JSON.stringify(payload));
  });
}

test('the hook says nothing, successfully, when the app is not there', async () => {
  // The ordinary case for any session somebody started themselves.
  const bare = await runHook('SessionStart', { source: 'startup' }, { SMART_TERMINAL_BRIDGE: '' });
  assert.equal(bare.error, null);
  assert.equal(bare.stdout, '{}');

  // And when the app is gone but its socket path is still in the environment.
  const missing = await runHook(
    'SessionStart',
    { source: 'resume' },
    { SMART_TERMINAL_BRIDGE: path.join(os.tmpdir(), 'not-a-socket-' + Date.now()) },
  );
  assert.equal(missing.error, null, 'a missing app must never fail a session');
  assert.equal(missing.stdout, '{}');
});

test('the hook carries the report over and passes the answer back', async () => {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-')), 's.sock');
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.indexOf('\n') === -1) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      seen.push(request);
      socket.end(JSON.stringify({
        ok: true,
        reply: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'you were fixing the watcher' } },
      }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const answer = await runHook(
      'SessionStart',
      { source: 'compact', session_id: 'conv-1', cwd: '/w', transcript_path: '/t.jsonl' },
      { SMART_TERMINAL_BRIDGE: socketPath, SMART_TERMINAL_SESSION_ID: 'st-7' },
    );

    assert.equal(answer.error, null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].op, 'hook');
    assert.equal(seen[0].event, 'SessionStart');
    assert.equal(seen[0].session, 'st-7', 'the app’s own id rides in the environment');
    assert.equal(seen[0].payload.source, 'compact');

    // Claude gets the reply and nothing else — not the app's `ok`, not a detail.
    assert.deepEqual(JSON.parse(answer.stdout), {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'you were fixing the watcher' },
    });
  } finally {
    server.close();
  }
});

test('an app that answers with rubbish still leaves the session working', async () => {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-')), 's.sock');
  const server = net.createServer((socket) => socket.end('not json at all\n'));
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const answer = await runHook('Stop', {}, { SMART_TERMINAL_BRIDGE: socketPath });
    assert.equal(answer.error, null);
    assert.equal(answer.stdout, '{}');
  } finally {
    server.close();
  }
});

test('an app that never answers does not hold the session open', async () => {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-')), 's.sock');
  // Accepts the connection and then says nothing at all, for ever.
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const started = Date.now();
    const answer = await runHook('Stop', {}, { SMART_TERMINAL_BRIDGE: socketPath });
    assert.equal(answer.stdout, '{}');
    assert.ok(Date.now() - started < 6000, 'the hook waited too long on a silent app');
  } finally {
    server.close();
  }
});

// --- the plugin as Claude Code will read it --------------------------------

test('the plugin declares itself and every hook it names can be run', () => {
  const root = path.join(__dirname, '..', 'plugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'smart-terminal');
  assert.ok(manifest.version, 'a plugin without a version cannot be updated');

  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  const named = Object.keys(hooks.hooks);
  assert.deepEqual(named.sort(), Object.keys(EVENTS).sort(), 'the plugin and the app disagree about which events matter');

  for (const event of named) {
    for (const group of hooks.hooks[event]) {
      for (const entry of group.hooks) {
        assert.equal(entry.type, 'command');
        assert.match(entry.command, /\$\{?CLAUDE_PLUGIN_ROOT\}?/, `${event} hardcodes a path`);
        assert.ok(entry.timeout > 0 && entry.timeout <= 10, `${event} has no sensible timeout`);
        // The event is passed as the argument, so the reporter never has to
        // guess which moment it is in.
        assert.ok(entry.command.endsWith(` ${event}`), `${event} does not tell the reporter what it is`);
      }
    }
  }
});
