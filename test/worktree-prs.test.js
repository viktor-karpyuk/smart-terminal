'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorktreePulls, summarize } = require('../electron/worktree-prs');

const pr = (number, state, base = 'develop') => ({ number, title: `pr ${number}`, state, baseRefName: base, url: `u/${number}`, mergedAt: state === 'MERGED' ? '2026-10-18' : null, isDraft: false, updatedAt: null, reviewDecision: null });

function harness(answers, { fails = false } = {}) {
  const kept = new Map();
  const calls = [];
  const events = [];
  let now = 1000;
  const pulls = new WorktreePulls({
    get: (k) => kept.get(k),
    set: (k, v) => kept.set(k, v),
    now: () => now,
    ttl: 100,
    emit: (name, payload) => events.push([name, payload]),
    exec: async (cmd, args, cwd) => {
      calls.push(args);
      if (args[0] === '--version') return { ok: true, stdout: 'gh 2.0', stderr: '' };
      if (fails) return { ok: false, stdout: '', stderr: 'error: not logged in\n' };
      const branch = args[args.indexOf('--head') + 1];
      return { ok: true, stdout: JSON.stringify(answers[branch] ?? []), stderr: '' };
    },
  });
  return { pulls, calls, events, kept, tick: (ms) => (now += ms) };
}

test('summarize: all merged, closable with open ones, not closable with a closed one', () => {
  assert.deepEqual(summarize([pr(1, 'MERGED'), pr(2, 'MERGED')]), { merged: 2, open: 0, closed: 0, allMerged: true, closable: true });
  assert.equal(summarize([pr(1, 'MERGED'), pr(2, 'OPEN')]).closable, true);
  assert.equal(summarize([pr(1, 'MERGED'), pr(2, 'OPEN')]).allMerged, false);
  assert.equal(summarize([pr(1, 'MERGED'), pr(3, 'CLOSED')]).closable, false);
  assert.equal(summarize([]).closable, false);
});

test('refresh asks gh once per branch, remembers, emits, and skips bases and mains', async () => {
  const h = harness({ 'feat/a': [pr(1, 'MERGED', 'develop'), pr(2, 'OPEN', 'main')] });
  const rows = [
    { root: '/r', branch: 'feat/a', head: 'h1' },
    { root: '/r', branch: 'develop', head: 'h2', base: true },
    { root: '/r', branch: 'main', head: 'h3', main: true },
  ];
  const out = await h.pulls.refresh(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].merged, 1);
  assert.equal(out[0].open, 1);
  assert.equal(out[0].closable, true);
  assert.deepEqual(out[0].prs.map((p) => p.base), ['develop', 'main']);
  assert.equal(h.events.length, 1);
  assert.equal(h.calls.filter((a) => a[0] === 'pr').length, 1);
  // Fresh: nothing asked again.
  await h.pulls.refresh(rows);
  assert.equal(h.calls.filter((a) => a[0] === 'pr').length, 1);
  assert.equal(h.pulls.known('/r', 'feat/a').stale, false);
  // Stale after the ttl: asked again; forced: asked regardless.
  h.tick(200);
  assert.equal(h.pulls.known('/r', 'feat/a').stale, true);
  await h.pulls.refresh(rows);
  assert.equal(h.calls.filter((a) => a[0] === 'pr').length, 2);
  await h.pulls.refresh(rows, { force: true });
  assert.equal(h.calls.filter((a) => a[0] === 'pr').length, 3);
});

test('a failing gh keeps the previous answer and records the error', async () => {
  const good = harness({ 'feat/a': [pr(1, 'MERGED')] });
  await good.pulls.refresh([{ root: '/r', branch: 'feat/a', head: 'h' }]);
  const bad = new WorktreePulls({ get: (k) => good.kept.get(k), set: (k, v) => good.kept.set(k, v), now: () => 5000, ttl: 100, exec: async (c, args) => (args[0] === '--version' ? { ok: true, stdout: '', stderr: '' } : { ok: false, stdout: '', stderr: 'gh: not logged in' }) });
  const [answer] = await bad.refresh([{ root: '/r', branch: 'feat/a', head: 'h' }]);
  assert.equal(answer.error, 'gh: not logged in');
  assert.equal(answer.merged, 1);
  assert.equal(answer.allMerged, true);
});

test('without gh and without a forge, the answer records why and knows nothing', async () => {
  const h = harness({});
  h.pulls.exec = async () => ({ ok: false, stdout: '', stderr: 'command not found' });
  const [answer] = await h.pulls.refresh([{ root: '/r', branch: 'x', head: 'h' }]);
  assert.equal(answer.error, 'gh is not installed');
  assert.equal(answer.prs.length, 0);
});

test('a repository gh cannot read is asked through the forge the reviewer knows', async () => {
  const h = harness({});
  h.pulls.exec = async (c, args) => (args[0] === '--version' ? { ok: true, stdout: '', stderr: '' } : { ok: false, stdout: '', stderr: 'none of the git remotes configured for this repository point to a known GitHub host' });
  h.pulls.forgeFor = async (root) =>
    root === '/bb'
      ? {
          forBranch: async (branch) => [
            { id: 7, title: 'first', state: 'MERGED', targetBranch: 'develop', url: 'https://bitbucket.org/x/y/pull-requests/7', updatedOn: '2026-10-01 10:00', approvedBy: ['A'], changesRequestedBy: [] },
            { id: 9, title: 'second', state: 'OPEN', targetBranch: 'main', url: 'u9', updatedOn: '2026-10-02 10:00', approvedBy: [], changesRequestedBy: [] },
          ].filter((pr) => branch === 'feat/bb'),
        }
      : null;
  const [answer] = await h.pulls.refresh([{ root: '/bb', branch: 'feat/bb', head: 'h' }]);
  assert.equal(answer.error, null);
  assert.deepEqual(answer.prs.map((p) => [p.number, p.state, p.base, p.review]), [[7, 'MERGED', 'develop', 'APPROVED'], [9, 'OPEN', 'main', null]]);
  assert.equal(answer.closable, true);
  const [none] = await h.pulls.refresh([{ root: '/other', branch: 'feat/bb', head: 'h' }]);
  assert.match(none.error, /known GitHub host/);
});
