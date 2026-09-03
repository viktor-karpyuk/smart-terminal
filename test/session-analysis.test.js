'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  analyze,
  measure,
  worstSeverity,
  contextOf,
  windowFor,
  summarise,
  oneLine,
} = require('../electron/session-analysis.js');

let clock = Date.parse('2026-09-01T10:00:00Z');
function at(minutesOn) {
  return new Date(clock + minutesOn * 60000).toISOString();
}

/** One assistant request, with the token accounting Claude Code writes for it. */
function request(minute, { input = 2, write = 0, read = 0, output = 100, tools = [] } = {}) {
  return {
    type: 'assistant',
    timestamp: at(minute),
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: write,
        cache_read_input_tokens: read,
        output_tokens: output,
      },
      content: tools.map((t, i) => ({ type: 'tool_use', id: `t${minute}-${i}`, name: t.name, input: t.input })),
    },
  };
}

function result(minute, id, payload, isError = false) {
  return {
    type: 'user',
    timestamp: at(minute),
    toolUseResult: payload,
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
  };
}

test('context is the three input figures together', () => {
  assert.equal(contextOf({ input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 }), 1005);
  assert.equal(contextOf({}), 0);
});

test('the window is read off the traffic, not a model name', () => {
  assert.equal(windowFor(180000), 200000);
  assert.equal(windowFor(400000), 1000000);
});

test('an empty transcript says nothing rather than crashing', () => {
  const verdict = analyze([]);
  assert.equal(verdict.requests, 0);
  assert.deepEqual(verdict.findings, []);
  assert.equal(worstSeverity(verdict.findings), null);
});

test('rows that are not requests are ignored', () => {
  const verdict = analyze([null, 'nonsense', { type: 'attachment' }, { type: 'user' }]);
  assert.equal(verdict.requests, 0);
});

test('effective input weights cache reads down and writes up', () => {
  const m = measure([request(0, { input: 1000, write: 1000, read: 1000, output: 0 })]);
  // 1000 fresh + 1250 written + 100 read back
  assert.equal(m.effectiveInput, 2350);
});

test('a session sitting near the top of its window is called out', () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) rows.push(request(i, { read: 700000, output: 500 }));
  const verdict = analyze(rows);
  const finding = verdict.findings.find((f) => f.id === 'high-context');
  assert.ok(finding, 'expected a high-context finding');
  assert.equal(finding.severity, 'high');
  assert.equal(verdict.context.turnsAbove, 6);
  assert.equal(verdict.context.window, 1000000);
});

test('a couple of comfortable turns raise nothing', () => {
  const verdict = analyze([request(0, { read: 20000 }), request(1, { read: 22000 })]);
  assert.deepEqual(verdict.findings, []);
});

test('automatic compaction is reported, and repeated ones are worse', () => {
  const compaction = (minute, trigger) => ({
    type: 'system',
    timestamp: at(minute),
    compactMetadata: { trigger, preTokens: 900000, postTokens: 20000, cumulativeDroppedTokens: 880000, durationMs: 60000 },
  });

  const once = analyze([request(0), compaction(1, 'auto')]).findings.find((f) => f.id === 'auto-compaction');
  assert.equal(once.severity, 'medium');

  const twice = analyze([request(0), compaction(1, 'auto'), compaction(2, 'auto')]);
  const finding = twice.findings.find((f) => f.id === 'auto-compaction');
  assert.equal(finding.severity, 'high');
  assert.match(finding.title, /2 times/);
  assert.equal(twice.compactions.length, 2);
});

test('a compaction you asked for is not held against you', () => {
  const verdict = analyze([
    request(0),
    { type: 'system', timestamp: at(1), compactMetadata: { trigger: 'manual', preTokens: 500000, postTokens: 10000, cumulativeDroppedTokens: 490000, durationMs: 40000 } },
  ]);
  assert.equal(verdict.findings.find((f) => f.id === 'auto-compaction'), undefined);
  assert.equal(verdict.compactions[0].trigger, 'manual');
});

test('coming back after the cache lapses counts as a re-prime', () => {
  const verdict = analyze([
    request(0, { write: 50000 }),
    request(30, { write: 60000 }), // half an hour away: the cache is gone
    request(70, { write: 60000 }),
  ]);
  assert.equal(verdict.reprimes.count, 2);
  assert.equal(verdict.reprimes.tokens, 120000);
  assert.ok(verdict.findings.some((f) => f.id === 'cache-reprime'));
});

test('growth without a gap is not a re-prime', () => {
  const verdict = analyze([request(0, { write: 50000 }), request(1, { write: 60000 })]);
  assert.equal(verdict.reprimes.count, 0);
});

test('a tool that floods the context is named, with its share', () => {
  const rows = [
    request(0, { tools: [{ name: 'Bash', input: { command: 'npm test' } }] }),
    result(0, 't0-0', { stdout: 'x'.repeat(500000), stderr: '' }),
  ];
  const verdict = analyze(rows);
  const finding = verdict.findings.find((f) => f.id === 'tool-flood');
  assert.ok(finding);
  assert.match(finding.title, /^Bash/);
  assert.equal(verdict.tools[0].name, 'Bash');
  assert.equal(verdict.tools[0].calls, 1);
});

test('tool results are attributed by their call id, and failures counted', () => {
  const rows = [
    request(0, { tools: [{ name: 'Read', input: { file_path: '/a' } }, { name: 'Edit', input: { file_path: '/b' } }] }),
    result(0, 't0-0', { content: 'short' }),
    result(0, 't0-1', { content: 'nope' }, true),
  ];
  const tools = Object.fromEntries(analyze(rows).tools.map((t) => [t.name, t]));
  assert.equal(tools.Read.fails, 0);
  assert.equal(tools.Edit.fails, 1);
  assert.equal(tools.Read.bytes, 5);
});

test('the same call over and over is noticed', () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push(request(i, { tools: [{ name: 'Bash', input: { command: 'git status' } }] }));
  const verdict = analyze(rows);
  assert.equal(verdict.repeated[0].times, 5);
  assert.ok(verdict.findings.some((f) => f.id === 'repeated-calls'));
});

test('different calls to the same tool are not repeats', () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push(request(i, { tools: [{ name: 'Bash', input: { command: `echo ${i}` } }] }));
  assert.deepEqual(analyze(rows).repeated, []);
});

test('turn durations give percentiles, and slow turns a finding', () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push(request(i));
    rows.push({ type: 'system', subtype: 'turn_duration', timestamp: at(i), durationMs: (i + 1) * 60000, messageCount: 4 });
  }
  const verdict = analyze(rows);
  assert.equal(verdict.latency.turns, 10);
  assert.equal(verdict.latency.p50, 5 * 60000);
  assert.equal(verdict.latency.p95, 10 * 60000);
  assert.ok(verdict.findings.some((f) => f.id === 'slow-turns'));
});

test('a session reading far more than it writes is flagged', () => {
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(request(i, { read: 400000, output: 10 }));
  assert.ok(analyze(rows).findings.some((f) => f.id === 'thin-returns'));
});

test('errors are collected from either shape', () => {
  const verdict = analyze([
    { type: 'assistant', timestamp: at(0), isApiErrorMessage: true, apiErrorStatus: 529 },
    { type: 'assistant', timestamp: at(1), error: 'server_error' },
    { type: 'assistant', timestamp: at(2), error: 'server_error' },
  ]);
  assert.equal(verdict.errors.length, 3);
  assert.ok(verdict.findings.some((f) => f.id === 'api-errors'));
});

test('findings come back worst first', () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) rows.push(request(i, { read: 900000, output: 5 }));
  rows.push({ type: 'assistant', timestamp: at(7), error: 'server_error' });
  rows.push({ type: 'assistant', timestamp: at(8), error: 'server_error' });
  rows.push({ type: 'assistant', timestamp: at(9), error: 'server_error' });
  const findings = analyze(rows).findings;
  const rank = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < findings.length; i += 1) {
    assert.ok(rank[findings[i - 1].severity] <= rank[findings[i].severity]);
  }
  assert.equal(worstSeverity(findings), 'high');
});

test('every finding says what to do about it', () => {
  const rows = [];
  for (let i = 0; i < 8; i += 1) rows.push(request(i, { read: 800000, output: 20 }));
  for (const finding of analyze(rows).findings) {
    assert.ok(finding.id && finding.title && finding.detail && finding.suggestion, `incomplete: ${finding.id}`);
    assert.ok(['high', 'medium', 'low'].includes(finding.severity));
  }
});

test('the context curve keeps one point per request, in order', () => {
  const verdict = analyze([request(0, { read: 100 }), request(1, { read: 200 }), request(2, { read: 300 })]);
  assert.deepEqual(verdict.context.curve.map((p) => p.context), [102, 202, 302]);
  assert.equal(verdict.context.peak, 302);
  assert.equal(verdict.context.last, 302);
  assert.equal(verdict.spanMs, 2 * 60000);
});

test('a session on a steady climb gets a projection', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push(request(i, { read: 10000 + i * 5000 }));
  const { projection } = analyze(rows);
  assert.equal(projection.perRequest, 5000);
  assert.ok(projection.requests > 0);
  // One request a minute, so the estimate should be about that many minutes.
  assert.equal(projection.ms, projection.requests * 60000);
});

test('a flat or shrinking session is not given one', () => {
  const flat = [];
  for (let i = 0; i < 20; i += 1) flat.push(request(i, { read: 30000 }));
  assert.equal(analyze(flat).projection, null);

  const shrinking = [];
  for (let i = 0; i < 20; i += 1) shrinking.push(request(i, { read: 200000 - i * 5000 }));
  assert.equal(analyze(shrinking).projection, null);
});

test('too few requests to see a trend means no projection', () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) rows.push(request(i, { read: 10000 + i * 5000 }));
  assert.equal(analyze(rows).projection, null);
});

test('one long absence does not become the estimate', () => {
  const rows = [];
  let minute = 0;
  for (let i = 0; i < 20; i += 1) {
    minute += i === 15 ? 4000 : 1; // a weekend in the middle of the recent run
    rows.push(request(minute, { read: 10000 + i * 5000 }));
  }
  const { projection } = analyze(rows);
  // The median gap is a minute, so the estimate is minutes — not days.
  assert.ok(projection.ms < projection.requests * 2 * 60000, `estimate ran away: ${projection.ms}`);
});

test('a session filling up soon is warned while there is still time', () => {
  // Comfortable now — under 60% of a 200k window — but climbing fast enough that
  // the ceiling is about twenty requests away.
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push(request(i, { read: 40000 + i * 4000 }));
  const finding = analyze(rows).findings.find((f) => f.id === 'filling-up');
  assert.ok(finding, 'expected the projection finding');
  assert.match(finding.detail, /more requests/);
});

test('a session already at the ceiling is told that instead', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push(request(i, { read: 800000 + i * 4000 }));
  const findings = analyze(rows).findings;
  assert.ok(findings.some((f) => f.id === 'high-context'));
  assert.equal(findings.find((f) => f.id === 'filling-up'), undefined);
});

test('the prose summary carries the figures and the advice', () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push(request(i, { read: 900000, output: 20 }));
  const text = summarise(analyze(rows), { name: 'You' });
  assert.match(text, /^You: /);
  assert.match(text, /% of the/);
  assert.match(text, /What stands out:/);
  assert.match(text, /What helps:/);
});

test('the summary can be asked for the findings without the advice', () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push(request(i, { read: 900000, output: 20 }));
  const text = summarise(analyze(rows), { suggestions: false });
  assert.match(text, /What stands out:/);
  assert.equal(/What helps:/.test(text), false);
});

test('a quiet session says so in one line', () => {
  const verdict = analyze([request(0, { read: 1000 }), request(1, { read: 1200 })]);
  assert.match(oneLine(verdict, 'tidy'), /^tidy: .*nothing to report$/);
});

test('a request with no input at all is not counted as an empty context', () => {
  const verdict = analyze([
    request(0, { read: 400000 }),
    request(1, { read: 420000 }),
    // A turn written without its accounting: real in an errored request.
    { type: 'assistant', timestamp: at(2), message: { usage: { output_tokens: 5 }, content: [] } },
  ]);
  assert.equal(verdict.requests, 2);
  assert.equal(verdict.context.last, 420002, 'the last real reading, not the empty one');
});

test('a session that has come down from the ceiling is not still called high', () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push(request(i, { read: 900000 }));
  // A compaction, then life at a tenth of the window.
  rows.push({
    type: 'system',
    timestamp: at(11),
    compactMetadata: { trigger: 'auto', preTokens: 900000, postTokens: 60000, cumulativeDroppedTokens: 840000, durationMs: 90000 },
  });
  for (let i = 12; i < 18; i += 1) rows.push(request(i, { read: 60000 }));

  const verdict = analyze(rows);
  const finding = verdict.findings.find((f) => f.id === 'high-context');
  assert.ok(finding);
  assert.equal(finding.severity, 'low', 'it is history now, not a problem now');
  assert.match(finding.title, /Spent much of its life/);
  assert.match(finding.detail, /Down to 6% now/);
});

test('a session still at the ceiling is called high, in the present tense', () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push(request(i, { read: 900000 }));
  const finding = analyze(rows).findings.find((f) => f.id === 'high-context');
  assert.match(finding.title, /Running near the top/);
  assert.match(finding.detail, /at 90% of the 1.0M window now/i);
});

test('quality is a score with its reasons attached', () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push(request(i, { read: 950000 }));
  rows.push({
    type: 'system',
    timestamp: at(11),
    compactMetadata: { trigger: 'auto', preTokens: 950000, postTokens: 20000, cumulativeDroppedTokens: 930000, durationMs: 60000 },
  });
  const { quality } = analyze(rows);
  assert.ok(quality.score < 70, `expected a low score, got ${quality.score}`);
  assert.ok(quality.reasons.length >= 2);
  assert.ok(quality.reasons.every((r) => r.cost > 0 && r.label), 'every point off is accounted for');
  // Sorted worst first, so the first line is the thing to fix.
  assert.ok(quality.reasons[0].cost >= quality.reasons[quality.reasons.length - 1].cost);
});

test('a tidy session scores well and has nothing to explain', () => {
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(request(i, { read: 30000, output: 900 }));
  const { quality } = analyze(rows);
  assert.equal(quality.score, 100);
  assert.equal(quality.grade, 'healthy');
  assert.deepEqual(quality.reasons, []);
});

test('a session with nothing in it has no score to give', () => {
  assert.equal(analyze([]).quality, null);
});

test('each compaction reports what it dropped, not the running total', () => {
  const compaction = (minute, pre, post, soFar) => ({
    type: 'system',
    timestamp: at(minute),
    compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post, cumulativeDroppedTokens: soFar, durationMs: 1000 },
  });

  const verdict = analyze([
    request(0),
    compaction(1, 900000, 20000, 880000),
    request(2),
    compaction(3, 800000, 30000, 1650000),
  ]);

  assert.deepEqual(verdict.compactions.map((c) => c.droppedTokens), [880000, 770000]);
  assert.deepEqual(verdict.compactions.map((c) => c.droppedSoFar), [880000, 1650000]);

  // And the finding adds the two drops together — 1.65M, which is not the same
  // as adding the two cumulative figures, which would come to 2.5M.
  const finding = verdict.findings.find((f) => f.id === 'auto-compaction');
  assert.match(finding.detail, /1\.[67]M tokens dropped/);
  assert.equal(/2\.5M/.test(finding.detail), false);
});

test('a compaction that grew the context does not report a negative drop', () => {
  const verdict = analyze([
    request(0),
    {
      type: 'system',
      timestamp: at(1),
      compactMetadata: { trigger: 'manual', preTokens: 3337, postTokens: 8309, cumulativeDroppedTokens: 687393, durationMs: 500 },
    },
  ]);
  assert.equal(verdict.compactions[0].droppedTokens, 0);
});
