'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionMonitor, worthAnnouncing } = require('../electron/session-monitor.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));

/** A transcript of `count` ordinary requests, each carrying its token accounting. */
function transcript(name, count, { read = 1000, output = 100 } = {}) {
  const file = path.join(dir, `${name}.jsonl`);
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.parse('2026-09-01T10:00:00Z') + i * 60000).toISOString(),
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: read,
            output_tokens: output,
            // padding, so growth crosses the threshold the way a real turn does
            note: 'x'.repeat(400),
          },
          content: [],
        },
      }),
    );
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** Stands in for the context store: which sessions exist, and where each one is. */
function fakeContext(map) {
  return {
    trackedIds: () => [...Object.keys(map)],
    transcriptFor: (id) => map[id] ?? null,
  };
}

test('a session with no transcript reads as such, and is not announced', () => {
  const monitor = new SessionMonitor({ context: fakeContext({}) });
  assert.deepEqual(monitor.read('nobody'), { sessionId: 'nobody', ok: false, reason: 'no-transcript' });
  assert.equal(monitor.peek('nobody'), null);
  assert.equal(worthAnnouncing(null, { ok: false }), false);
});

test('reading a session gives a verdict and remembers it', () => {
  const file = transcript('a', 5);
  const monitor = new SessionMonitor({ context: fakeContext({ a: file }) });
  const verdict = monitor.read('a');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.sessionId, 'a');
  assert.equal(verdict.requests, 5);
  assert.equal(monitor.peek('a'), verdict);
});

test('a transcript that has not grown is not parsed again', () => {
  const file = transcript('b', 5);
  const monitor = new SessionMonitor({ context: fakeContext({ b: file }) });
  const first = monitor.read('b');
  assert.equal(monitor.read('b'), first, 'expected the very same object back');
});

test('Refresh re-reads regardless', () => {
  const file = transcript('c', 5);
  const monitor = new SessionMonitor({ context: fakeContext({ c: file }) });
  const first = monitor.read('c');
  const again = monitor.read('c', { force: true });
  assert.notEqual(again, first);
  assert.deepEqual(again.findings, first.findings);
});

test('a session that grows is read again', () => {
  const file = transcript('d', 5);
  const monitor = new SessionMonitor({ context: fakeContext({ d: file }) });
  assert.equal(monitor.read('d').requests, 5);
  fs.appendFileSync(file, fs.readFileSync(transcript('d-more', 40), 'utf8'));
  assert.equal(monitor.read('d').requests, 45);
});

test('a sweep announces a session the first time it sees it', () => {
  const seen = [];
  const monitor = new SessionMonitor({
    context: fakeContext({ e: transcript('e', 4) }),
    emit: (id, verdict) => seen.push([id, verdict.ok]),
  });
  monitor.sweep();
  assert.deepEqual(seen, [['e', true]]);
});

test('a steady session is not announced over and over', () => {
  let announcements = 0;
  const monitor = new SessionMonitor({
    context: fakeContext({ f: transcript('f', 4) }),
    emit: () => { announcements += 1; },
  });
  monitor.sweep();
  monitor.sweep();
  monitor.sweep();
  assert.equal(announcements, 1);
});

test('a sweep parses at most a few transcripts, and moves on next time', () => {
  const map = {};
  for (const name of ['g1', 'g2', 'g3', 'g4', 'g5']) map[name] = transcript(name, 4);
  const seen = new Set();
  const monitor = new SessionMonitor({ context: fakeContext(map), emit: (id) => seen.add(id) });
  monitor.sweep();
  assert.equal(seen.size, 3, 'one sweep should cap its work');
  monitor.sweep();
  assert.equal(seen.size, 5, 'the next sweep should cover the rest');
});

test('a session going bad is announced; the same trouble again is not', () => {
  const file = transcript('h', 4);
  const announced = [];
  const monitor = new SessionMonitor({
    context: fakeContext({ h: file }),
    emit: (_id, verdict) => announced.push(verdict.worst),
  });
  monitor.sweep();
  assert.deepEqual(announced, [null]);

  // Now the same session, but running against the top of its window.
  fs.appendFileSync(file, fs.readFileSync(transcript('h-heavy', 30, { read: 900000 }), 'utf8'));
  monitor.sweep();
  assert.deepEqual(announced, [null, 'high']);

  fs.appendFileSync(file, fs.readFileSync(transcript('h-more', 30, { read: 900000 }), 'utf8'));
  monitor.sweep();
  assert.equal(announced.length, 2, 'the same verdict should not be announced twice');
});

test('worthAnnouncing turns on the verdict, not the numbers', () => {
  const quiet = { ok: true, worst: null, findings: [] };
  const same = { ok: true, worst: null, findings: [] };
  assert.equal(worthAnnouncing(quiet, same), false);
  assert.equal(worthAnnouncing(quiet, { ok: true, worst: 'low', findings: [{ id: 'x', severity: 'low' }] }), true);
  assert.equal(
    worthAnnouncing(
      { ok: true, worst: 'low', findings: [{ id: 'x', severity: 'low' }] },
      { ok: true, worst: 'low', findings: [{ id: 'y', severity: 'low' }] },
    ),
    true,
    'a different finding at the same severity still counts',
  );
});

test('forgetting a session drops what was read for it', () => {
  const monitor = new SessionMonitor({ context: fakeContext({ i: transcript('i', 4) }) });
  monitor.read('i');
  monitor.forget('i');
  assert.equal(monitor.peek('i'), null);
});

test('the timer starts once and stops cleanly', () => {
  const monitor = new SessionMonitor({ context: fakeContext({}), intervalMs: 60000 });
  monitor.start();
  const timer = monitor.timer;
  monitor.start();
  assert.equal(monitor.timer, timer, 'start should be idempotent');
  monitor.stop();
  assert.equal(monitor.timer, null);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a session that starts over on a new conversation is not answered from the old one', () => {
  // A long conversation, then the same session pointed at a fresh, much shorter
  // one — which is exactly what restarting without resuming does.
  const heavy = transcript('r-old', 60, { read: 900000 });
  const map = { r: heavy };
  const monitor = new SessionMonitor({ context: fakeContext(map) });
  const before = monitor.read('r');
  assert.equal(before.requests, 60);

  map.r = transcript('r-new', 2);
  const after = monitor.read('r');
  assert.equal(after.requests, 2, 'the new conversation, not the one it replaced');
});

test('a transcript that shrinks is read again rather than trusted', () => {
  const file = transcript('s', 40);
  const monitor = new SessionMonitor({ context: fakeContext({ s: file }) });
  assert.equal(monitor.read('s').requests, 40);

  // The same path, rewritten shorter: a truncation, or a file replaced in place.
  fs.writeFileSync(file, fs.readFileSync(transcript('s-short', 3), 'utf8'));
  assert.equal(monitor.read('s').requests, 3);
});

test('growth is still enough to skip a re-read', () => {
  const file = transcript('t', 20);
  const monitor = new SessionMonitor({ context: fakeContext({ t: file }) });
  const first = monitor.read('t');
  assert.equal(monitor.read('t'), first, 'a file that has barely grown gives the same object back');
});
