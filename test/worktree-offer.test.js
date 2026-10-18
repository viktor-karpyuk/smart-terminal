'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createOffer } = require('../electron/worktree-offer.js');

function setup({ found = [], results = null, press = 0, known = true, scanError = null } = {}) {
  const log = { asked: [], told: [], cleaned: [], scans: 0 };
  const cleanup = {
    scan: async () => { log.scans += 1; if (scanError) throw scanError; return found; },
    clean: async (paths) => { log.cleaned.push(paths); return results ?? paths.map((p) => ({ path: p, ok: true })); },
  };
  const offer = createOffer({ cleanup, ask: async (box) => { log.asked.push(box); return press; }, tell: async (box) => { log.told.push(box); }, sessionsKnown: () => known });
  return { ...offer, log };
}
const item = (name) => ({ path: `/w/${name}`, label: name, why: 'merged into origin/develop' });

test('it asks first, names what would go, and cleans only when the first button is pressed', async () => {
  const s = setup({ found: [item('a'), item('b')], press: 0 });
  const r = await s.offer();
  assert.deepEqual(s.log.cleaned, [['/w/a', '/w/b']]);
  assert.equal(s.log.asked.length, 1);
  assert.match(s.log.asked[0].detail, /• a — merged into origin\/develop/);
  assert.deepEqual(s.log.asked[0].buttons, ['Clean up 2', 'Not now']);
  assert.deepEqual(r, { shown: true, cleaned: 2, failed: 0 });
  assert.deepEqual(s.log.told, [], 'a clean success is not announced a second time');
});

test('Not now, or closing the dialog, removes nothing', async () => {
  for (const press of [1, -1]) {
    const s = setup({ found: [item('a')], press });
    await s.offer();
    assert.deepEqual(s.log.cleaned, [], `button ${press}`);
  }
});

test('from the menu it always answers, even when there is nothing or the check fails', async () => {
  const none = setup();
  await none.offer();
  assert.match(none.log.told[0].message, /no finished worktrees/);
  const broken = setup({ scanError: new Error('git is gone') });
  await broken.offer();
  assert.equal(broken.log.told[0].type, 'error');
  assert.match(broken.log.told[0].detail, /git is gone/);
});

test('the background check is silent when there is nothing, and does not ask again about what was declined', async () => {
  const s = setup({ found: [item('a')], press: 1 });
  assert.deepEqual((await setup().offer({ quiet: true })).shown, false);
  await s.offer({ quiet: true });
  assert.equal(s.log.asked.length, 1);
  const again = await s.offer({ quiet: true });
  assert.equal(s.log.asked.length, 1, 'declined once, not asked again in this run');
  assert.equal(again.why, 'nothing');
  await s.offer();
  assert.equal(s.log.asked.length, 2, 'the menu asks again whenever it is chosen');
});

test('the background check waits while a session folder is unknown, and an error stays quiet', async () => {
  const s = setup({ found: [item('a')], known: false });
  assert.equal((await s.offer({ quiet: true })).why, 'sessions-unknown');
  assert.equal(s.log.scans, 0, 'it did not even look');
  const e = setup({ scanError: new Error('x') });
  await e.offer({ quiet: true });
  assert.deepEqual(e.log.told, []);
});

test('what git refused is said, with the reason; a kept branch is said too', async () => {
  const s = setup({ found: [item('a'), item('b'), item('c')], results: [{ path: '/w/a', ok: true }, { path: '/w/b', ok: false, error: 'contains modified files' }, { path: '/w/c', ok: true, branchKept: true }] });
  const r = await s.offer();
  assert.equal(r.failed, 1);
  assert.equal(s.log.told.length, 1);
  assert.match(s.log.told[0].message, /1 could not be cleaned up/);
  assert.match(s.log.told[0].detail, /b: contains modified files/);
  assert.match(s.log.told[0].detail, /c: the folder is gone; its branch was kept/);
});

test('a long list is cut and says how many more', async () => {
  const s = setup({ found: Array.from({ length: 15 }, (_, i) => item('w' + i)), press: 1 });
  await s.offer();
  assert.match(s.log.asked[0].detail, /…and 3 more/);
  assert.equal(s.log.asked[0].detail.includes('w12'), false);
});

test('two offers at once make one dialog', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const log = { asked: 0 };
  const offer = createOffer({ cleanup: { scan: async () => [item('a')], clean: async () => [] }, ask: async () => { log.asked += 1; await gate; return 1; }, tell: async () => {}, sessionsKnown: () => true });
  const first = offer.offer();
  const second = await offer.offer();
  assert.equal(second.why, 'busy');
  release();
  await first;
  assert.equal(log.asked, 1);
});

test('a Code Reviewer workshop is offered only when its PR is closed, nothing is waiting, nothing is running, and it is the app\'s own', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { ReviewService } = require('../electron/review-service.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const dir = (name) => { const d = path.join(root, name); fs.mkdirSync(d); return d; };
  const dirs = { 1: dir('r-pr1'), 2: dir('r-pr2'), 3: dir('r-pr3'), 4: dir('r-pr4'), 5: path.join(os.tmpdir(), 'elsewhere-pr5') };
  fs.mkdirSync(dirs[5], { recursive: true });
  const discarded = [];
  const fake = {
    store: {
      repos: () => [{ id: 'r', name: 'repo' }],
      prs: () => [1, 2, 3, 4, 5, 6].map((id) => ({ id, state: id === 1 ? 'OPEN' : id === 6 ? 'MERGED' : 'MERGED' })),
      pendingReturn: (_r, id) => (id === 3 ? [{ id: 'f' }] : []),
    },
    fixer: {
      root,
      dirFor: (_repo, id) => dirs[id] ?? path.join(root, `r-pr${id}`),
      running: () => [{ repoId: 'r', prId: 4 }],
      discard: async (repoId, id) => { discarded.push([repoId, id]); },
    },
  };
  const found = ReviewService.prototype.finishedWorkshops.call(fake);
  assert.deepEqual(found.map((one) => one.label), ['repo — PR #2'], 'open, waiting, running, imported and missing ones are all left alone');
  return found[0].discard().then(() => assert.deepEqual(discarded, [['r', 2]]));
});
