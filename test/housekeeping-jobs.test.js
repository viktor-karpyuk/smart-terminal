'use strict';

/**
 * Removals as jobs: written before they start, one item at a time with its
 * result kept as it lands, paused after the item in hand, cancelled keeping
 * what was done, and resumed from the first item not yet done — including a
 * job the previous run left running.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';
const { HousekeepingStore } = sqlite ? require('../electron/housekeeping-store') : {};
const { JobRunner } = require('../electron/housekeeping-jobs');

const made = [];
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function world({ slow = 5, fail = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-jobs-'));
  made.push(dir);
  const store = new HousekeepingStore(new sqlite.DatabaseSync(path.join(dir, 't.db')));
  const acted = [];
  const events = [];
  const housekeeping = {
    act: async (kind, ids) => {
      acted.push([kind, ids[0]]);
      await new Promise((r) => setTimeout(r, slow));
      if (fail.includes(ids[0])) return { results: [{ id: ids[0], ok: false, error: 'refused' }], freed: 0 };
      return { results: [{ id: ids[0], ok: true, bytes: 10 }], freed: 10 };
    },
  };
  const runner = new JobRunner({ store, housekeeping, emit: (name, payload) => events.push([name, payload]) });
  return { store, runner, acted, events, housekeeping };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test('a job runs its items in order, keeps each result, and ends done with what it freed', { skip }, async () => {
  const { runner, acted, events } = world({ fail: ['b'] });
  const job = runner.start({ kind: 'free', ids: ['a', 'b', 'c'], labels: { a: 'A' }, title: 'three things' });
  assert.equal(job.status, 'queued');
  await settle(120);
  const done = runner.list()[0];
  assert.equal(done.status, 'done');
  assert.deepEqual(acted, [['free', 'a'], ['free', 'b'], ['free', 'c']]);
  assert.equal(done.freed, 20);
  assert.equal(done.failed, 1);
  assert.equal(done.results.b.error, 'refused');
  assert.ok(events.some(([name, payload]) => name === 'job' && payload.status === 'running' && payload.current === 'b'));
  assert.throws(() => runner.start({ kind: 'explode', ids: ['x'] }), /Not a job kind/);
  assert.throws(() => runner.start({ kind: 'free', ids: [] }), /Nothing to do/);
});

test('pause stops after the item in hand and resume carries on from the next; cancel keeps what was done', { skip }, async () => {
  const { runner, acted } = world({ slow: 30 });
  const job = runner.start({ kind: 'remove-worktrees', ids: ['w1', 'w2', 'w3', 'w4'] });
  await settle(10);
  runner.pause(job.id);
  await settle(80);
  let now = runner.list()[0];
  assert.equal(now.status, 'paused');
  assert.equal(Object.keys(now.results).length, 1, 'the item in hand finished, the next did not start');
  runner.resume(job.id);
  await settle(10);
  runner.cancel(job.id);
  await settle(80);
  now = runner.list()[0];
  assert.equal(now.status, 'cancelled');
  assert.equal(Object.keys(now.results).length, 2);
  assert.deepEqual(acted.map((a) => a[1]), ['w1', 'w2'], 'nothing done twice, nothing after the stop');
  assert.equal(now.freed, 20);
});

test('a job the previous run left running is interrupted at start, and resumes from where it was', { skip }, async () => {
  const first = world({ slow: 30 });
  const job = first.runner.start({ kind: 'free', ids: ['x', 'y', 'z'] });
  await settle(45);
  // The app quits here: a new runner on the same database.
  const second = new JobRunner({ store: first.store, housekeeping: first.housekeeping, emit: () => {} });
  const found = second.list()[0];
  assert.equal(found.id, job.id);
  assert.equal(found.status, 'interrupted');
  const doneBefore = Object.keys(found.results).length;
  assert.ok(doneBefore >= 1);
  second.resume(job.id);
  await settle(150);
  const after = second.list()[0];
  assert.equal(after.status, 'done');
  assert.equal(Object.keys(after.results).length, 3);
  assert.equal(first.acted.length, 3 + 0 + (first.acted.length - 3), 'each item acted on once overall');
  assert.equal(new Set(first.acted.map((a) => a[1])).size, 3);
});

test('two jobs run one after the other, never together; a finished one can be dismissed', { skip }, async () => {
  const { runner, acted } = world({ slow: 20 });
  const a = runner.start({ kind: 'free', ids: ['a1', 'a2'] });
  const b = runner.start({ kind: 'forget-transcripts', ids: ['b1'] });
  assert.equal(runner.list().find((j) => j.id === b.id).status, 'queued');
  await settle(120);
  assert.deepEqual(acted.map((x) => x[1]), ['a1', 'a2', 'b1']);
  assert.ok(runner.list().every((j) => j.status === 'done'));
  runner.dismiss(a.id);
  assert.deepEqual(runner.list().map((j) => j.id), [b.id]);
});
