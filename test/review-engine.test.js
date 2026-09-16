'use strict';

/*
 * The reviewer end to end, on real git repositories in a temporary folder, with
 * a fake forge and a fake Claude runner. It needs `node:sqlite`, which arrived
 * in Node 22; on an older Node these tests say so and skip, and the app itself —
 * Electron's Node — always has it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

/** An origin, a clone of it with a feature branch pushed, and the PR that branch is. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-engine-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, seed);
  fs.writeFileSync(path.join(seed, 'app.js'), 'function add(a, b) {\n  return a + b;\n}\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'base');
  git(seed, 'push', 'origin', 'HEAD:main');
  git(seed, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(seed, 'app.js'), 'function add(a, b) {\n  return a - b;\n}\n');
  git(seed, 'commit', '-am', 'change');
  git(seed, 'push', 'origin', 'feature');
  git(root, 'clone', origin, clone);
  const head = git(seed, 'rev-parse', 'HEAD');
  return { root, origin, seed, clone, head };
}

/** A forge that remembers what was posted and answers what the test tells it to. */
function fakeForge(state) {
  let next = 100;
  const client = {
    listOpen: async () => ({ prs: state.prs.filter((pr) => pr.state === 'OPEN'), etag: null, notModified: false }),
    search: async () => state.prs.filter((pr) => pr.state !== 'OPEN'),
    get: async (prId) => state.prs.find((pr) => pr.id === prId) ?? null,
    comments: async () => state.comments.slice(),
    comment: async (prId, body) => post({ prId, body }),
    reply: async (prId, parentId, body) => post({ prId, body, parentId }),
    inline: async (prId, body, filePath, line) => post({ prId, body, inlinePath: filePath, inlineLine: line }),
    approve: async () => state.calls.push('approve'),
    unapprove: async () => state.calls.push('unapprove'),
    requestChanges: async () => state.calls.push('requestChanges'),
    undoRequestChanges: async () => state.calls.push('undoRequestChanges'),
    decline: async (prId, reason) => state.calls.push(`decline:${reason}`),
    merge: async (prId, options) => { state.calls.push(`merge:${options.strategy}`); return 'sha'; },
    commits: async () => { state.calls.push('commits'); return [{ sha: 'abc1234def', author: 'Ana', date: '2026-09-01', subject: 'from the provider', body: '' }]; },
  };
  function post(comment) {
    const id = String(next++);
    state.comments.push({ commentId: id, author: 'Reviewer', body: comment.body, inlinePath: comment.inlinePath ?? null, inlineLine: comment.inlineLine ?? null, deleted: false, createdOn: new Date(Date.now() + next).toISOString(), parentId: comment.parentId ?? null });
    state.posted.push({ id, ...comment });
    return { id, url: `https://example.test/${id}` };
  }
  return { of: () => client };
}

/** Claude, by script: each run is answered by the next function in the list. */
function fakeClaude(script) {
  const runs = [];
  return {
    runs,
    run: async (options) => {
      runs.push(options);
      const answer = script.shift();
      if (!answer) throw new Error(`no scripted answer for run ${runs.length} (${options.kind})`);
      const result = await answer(options);
      return { ok: true, text: '', stderr: '', structured: null, toolUses: 3, denials: [], limits: [], sessionId: 's', costUsd: 0.01, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, accountName: 'Main', ...result };
    },
  };
}

function setup(script) {
  const { ReviewService } = require('../electron/review-service');
  const w = world();
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const forgeState = { prs: [], comments: [], posted: [], calls: [] };
  const notes = [];
  const events = [];
  const service = new ReviewService({
    db,
    secrets: { encrypt: (text) => `enc:${text}`, decrypt: (cipher) => cipher.replace(/^enc:/, '') },
    fetch: async () => { throw new Error('no network in tests'); },
    profiles: { list: () => [{ id: 'p', name: 'Main' }] },
    resolvePath: async () => process.env.PATH,
    notify: (title, body) => notes.push(`${title} | ${body}`),
    emit: (event) => events.push(event),
    dataDir: w.root,
    DatabaseSync: sqlite.DatabaseSync,
  });
  const forge = fakeForge(forgeState);
  const claude = fakeClaude(script);
  // The engines hold their own references; swap the network and the model underneath them.
  for (const holder of [service, service.engine, service.fixer]) {
    holder.forge = forge;
    holder.claude = claude;
  }
  const repo = service.store.saveRepo({ name: 'Demo App', provider: 'GITHUB', owner: 'me', slug: 'demo', localPath: w.clone, token: 'secret' });
  forgeState.prs.push({ id: 7, title: 'Subtract instead', author: 'Ana', sourceBranch: 'feature', targetBranch: 'main', headSha: w.head, state: 'OPEN', createdOn: '2026-09-01 10:00', updatedOn: '2026-09-02 10:00', approvedBy: [], changesRequestedBy: [] });
  return { service, w, forgeState, claude, repo, notes, events, db };
}

const finding = (extra = {}) => ({ file: 'app.js', line: 2, severity: 'blocker', category: 'BUG', title: 'add subtracts', body: 'It returns a - b.', suggestion: 'return a + b;', ...extra });

test('a review: planned from the diff, read-only, findings stored, body rendered', { skip }, async () => {
  const { service, claude, repo, forgeState, notes } = setup([async () => ({ structured: { summary: 'One real bug.', findings: [finding()] } })]);
  const call = (name, args) => service.call(name, args);
  const listed = await call('refreshPrs', { repoId: repo.id });
  assert.equal(listed.ok, true, listed.error);
  assert.equal(notes.length, 0, 'a repository\'s first sweep announces nothing');
  const outcome = await call('review', { repoId: repo.id, prId: 7 });
  assert.equal(outcome.ok, true, outcome.error);
  const run = claude.runs[0];
  assert.equal(run.kind, 'review');
  assert.equal(run.model, 'haiku', 'one file, two lines: a light review');
  assert.deepEqual(run.disallowedTools, ['Edit', 'Write', 'WebFetch', 'WebSearch', 'Bash(git *--output*)', 'Bash(git grep *)']);
  assert.match(run.prompt, /Rango del diff: origin\/main\.\.\.origin\/feature/);
  const view = (await call('pr', { repoId: repo.id, prId: 7 }));
  assert.equal(view.ok, true, view.error);
  assert.equal(view.findings.length, 1);
  assert.equal(view.review.status, 'DONE');
  assert.match(view.review.body, /### Code review\n\nOne real bug\.\n\nEncontré 1 problema/);
  assert.match(view.mergeBlocker, /1 finding/);
  const board = await call('dashboard');
  assert.deepEqual(board.rows[0].flags, ['TO_PUBLISH']);
  assert.equal(forgeState.posted.length, 0, 'nothing is published by a review');
});

test('a run that used no tool did not read the diff, and is failed rather than saved', { skip }, async () => {
  const { service, repo } = setup([async () => ({ toolUses: 0, text: 'I cannot access the diff.', structured: { summary: 'x', findings: [] } })]);
  await service.call('refreshPrs', { repoId: repo.id });
  const outcome = await service.call('review', { repoId: repo.id, prId: 7 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /without opening the diff/);
  assert.equal(service.store.reviewsFor(repo.id, 7)[0].status, 'FAILED');
  assert.equal((await service.call('rerunCheck', { repoId: repo.id, prId: 7 })).existing, null, 'a failed review does not warn a rerun');
});

test('the second review looks only at what is new, and rules on what it left open', { skip }, async () => {
  const { service, repo, w, forgeState, claude } = setup([
    async () => ({ structured: { summary: 'first', findings: [finding(), finding({ line: 1, title: 'naming', severity: 'minor', category: 'CONVENTION' })] } }),
    async (options) => {
      const ids = [...options.prompt.matchAll(/- id: (\S+)/g)].map((m) => m[1]);
      return { structured: { summary: 'second', findings: [], carried: [{ id: ids[0], verdict: 'FIXED', evidence: 'now a + b' }] } };
    },
  ]);
  await service.call('refreshPrs', { repoId: repo.id });
  await service.call('review', { repoId: repo.id, prId: 7 });
  fs.writeFileSync(path.join(w.seed, 'app.js'), 'function add(a, b) {\n  return a + b;\n}\n');
  git(w.seed, 'commit', '-am', 'fix');
  git(w.seed, 'push', 'origin', 'feature');
  forgeState.prs[0].headSha = git(w.seed, 'rev-parse', 'HEAD');
  service.store.setPrMeta(repo.id, { fetchedAt: null });
  await service.call('refreshPrs', { repoId: repo.id });
  const second = await service.call('review', { repoId: repo.id, prId: 7 });
  assert.equal(second.ok, true, second.error);
  assert.match(claude.runs[1].prompt, new RegExp(`Commits nuevos a revisar: ${w.head}\\.\\.`));
  const reviews = service.store.reviewsFor(repo.id, 7);
  assert.equal(reviews[0].sinceSha, w.head);
  const carried = service.store.findingsForReview(reviews[0].id);
  assert.deepEqual(carried.map((f) => f.title), ['naming'], 'the one it did not rule on is carried forward, open');
  const fixed = service.store.findingsForReview(reviews[1].id);
  assert.deepEqual(fixed.map((f) => [f.title, f.resolution]), [['add subtracts', 'RESOLVED']]);
  assert.match(reviews[0].body, /1 observación\(es\) anterior\(es\) sin resolver/);
});

test('publishing, the thread, a reply detected, drafted and published, and verification', { skip }, async () => {
  const { service, repo, forgeState, claude, notes } = setup([
    async () => ({ structured: { summary: 's', findings: [finding()] } }),
    async () => ({ text: 'You are right, thanks.' }),
    async (options) => {
      const id = /id=(\S+)/.exec(options.prompt)[1];
      assert.match(options.prompt, /↳ RESPUESTA de Ana: fixed it/);
      return { structured: { summary: 'checked', mergeable: true, items: [{ id, resolution: 'WONT_FIX', evidence: 'explained' }] } };
    },
  ]);
  await service.call('refreshPrs', { repoId: repo.id });
  await service.call('review', { repoId: repo.id, prId: 7 });
  const published = await service.call('publishAll', { repoId: repo.id, prId: 7 });
  assert.equal(published.published, 1, JSON.stringify(published));
  assert.match(forgeState.posted[0].body, /^_bug_ · \*\*add subtracts\*\*[\s\S]*Cómo se resolvería/);
  assert.equal(forgeState.posted[0].inlineLine, 2);
  let view = await service.call('pr', { repoId: repo.id, prId: 7 });
  assert.equal(view.review.publishedUrl, 'https://example.test/100', 'the last inline comment makes the review published');
  assert.ok(view.comments.find((c) => c.commentId === '100').ours);

  forgeState.comments.push({ commentId: '900', author: 'Ana', body: 'fixed it', inlinePath: 'app.js', inlineLine: 2, deleted: false, createdOn: new Date(Date.now() + 1e6).toISOString(), parentId: '100' });
  await service.call('loadPr', { repoId: repo.id, prId: 7 });
  assert.ok(notes.some((n) => /They replied/.test(n)));
  view = await service.call('pr', { repoId: repo.id, prId: 7 });
  assert.equal(view.threads[0].state, 'NEEDS_ANSWER');
  const draft = view.replies[0];
  assert.equal((await service.call('draftReply', { replyId: draft.id })).ok, true);
  assert.equal(claude.runs[1].kind, 'reply');
  const answered = await service.call('publishReply', { replyId: draft.id });
  assert.equal(answered.ok, true, answered.error);
  assert.equal(forgeState.posted[1].parentId, '900');
  view = await service.call('pr', { repoId: repo.id, prId: 7 });
  assert.equal(view.threads[0].state, 'UNVERIFIED');
  assert.equal(view.replies.filter((r) => r.status !== 'PUBLISHED').length, 0, 'our own answer is not a reply waiting for an answer');

  const verified = await service.call('verify', { repoId: repo.id, prId: 7 });
  assert.equal(verified.ok, true, verified.error);
  view = await service.call('pr', { repoId: repo.id, prId: 7 });
  assert.equal(view.findings[0].resolution, 'WONT_FIX');
  assert.equal(view.threads[0].state, 'OK');
  assert.equal(view.mergeBlocker, 'No new commits since the review.', 'we asked for something and no commit arrived');
});

test('a fix: written in the workshop, committed by the tool, the finding closed, the thread told, handed back, pushed', { skip }, async () => {
  const { service, repo, w, forgeState, claude, notes } = setup([
    async () => ({ structured: { summary: 's', findings: [finding()] } }),
    async (options) => {
      assert.equal(options.kind, 'fix');
      assert.ok(options.disallowedTools.includes('Bash(git push *)'));
      assert.notEqual(options.cwd, w.clone, 'never in the person\'s clone');
      assert.equal(git(options.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
      fs.writeFileSync(path.join(options.cwd, 'app.js'), 'function add(a, b) {\n  return a + b;\n}\n');
      return { structured: { fixed: true, summary: 'Put the plus back.', files: ['app.js'] } };
    },
  ]);
  await service.call('refreshPrs', { repoId: repo.id });
  await service.call('review', { repoId: repo.id, prId: 7 });
  const [f] = service.store.findingsForReview(service.store.latestDone(repo.id, 7).id);
  const fixed = await service.call('fix', { findingId: f.id });
  assert.equal(fixed.ok, true, fixed.error);
  assert.equal(fixed.fix.state, 'COMMITTED');
  const workshop = fixed.fix.workspace;
  assert.match(git(workshop, 'log', '-1', '--format=%B'), /^fix: add subtracts\n\nPut the plus back\.\n\nHallazgo blocker en app\.js:2/);
  // The clone is exactly as it was: on main, clean, and with no local feature branch yet.
  assert.equal(git(w.clone, 'status', '--porcelain'), '');
  assert.equal(git(w.clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.throws(() => git(w.clone, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature'));
  const after = service.store.finding(f.id);
  assert.ok(after.closedAt);
  assert.equal(after.resolution, 'RESOLVED');
  assert.match(after.resolutionNote, /^Arreglado por la review en el commit [0-9a-f]{7}\. Put the plus back\./);
  assert.match(forgeState.posted[0].body, /^\*\*add subtracts\*\*\n\n✅ \*\*Arreglado\*\*[\s\S]*Todavía no está en la rama/, 'an unpublished finding is announced on its own, anchored');
  assert.ok(notes.some((n) => /Fix ready/.test(n)));
  const view = await service.call('pr', { repoId: repo.id, prId: 7 });
  assert.equal(view.workshop.pendingReturn, 1);
  assert.equal(view.replies.length, 0, 'the fix\'s own notice is not taken for a reply');

  // The clone has main checked out, so the feature branch can be updated from the workshop.
  const given = await service.call('giveBack', { repoId: repo.id, prId: 7 });
  assert.equal(given.ok, true, given.error);
  assert.equal(git(w.clone, 'rev-parse', 'refs/heads/feature'), git(workshop, 'rev-parse', 'HEAD'));
  assert.equal(service.store.pendingReturn(repo.id, 7).length, 0);
  const refused = await service.call('discardWorkshop', { repoId: repo.id, prId: 7 });
  assert.equal(refused.ok, true, 'nothing left to hand back, so it can go');

  const commits = await service.call('commits', { repoId: repo.id, prId: 7 });
  assert.equal(commits.local.length, 1, 'one commit in the clone that origin does not have');
  const pushed = await service.call('push', { repoId: repo.id, prId: 7 });
  assert.equal(pushed.ok, true, pushed.error);
  assert.equal(git(w.origin, 'rev-parse', 'refs/heads/feature'), git(w.clone, 'rev-parse', 'refs/heads/feature'));
});

test('handing back refuses when the clone has the branch checked out, and says so', { skip }, async () => {
  const { service, repo, w } = setup([
    async () => ({ structured: { summary: 's', findings: [finding()] } }),
    async (options) => { fs.writeFileSync(path.join(options.cwd, 'app.js'), 'x\n'); return { structured: { fixed: true, summary: 'x' } }; },
  ]);
  await service.call('refreshPrs', { repoId: repo.id });
  await service.call('review', { repoId: repo.id, prId: 7 });
  git(w.clone, 'checkout', 'feature');
  const [f] = service.store.findingsForReview(service.store.latestDone(repo.id, 7).id);
  await service.call('fix', { findingId: f.id });
  const given = await service.call('giveBack', { repoId: repo.id, prId: 7 });
  assert.equal(given.ok, false);
  assert.match(given.error, /The clone is on "feature"/);
  const discard = await service.call('discardWorkshop', { repoId: repo.id, prId: 7 });
  assert.equal(discard.ok, false);
  assert.match(discard.error, /have not been handed back/);
});

test('someone else\'s comment is adopted, fixed, and answered in their own thread', { skip }, async () => {
  const { service, repo, forgeState } = setup([
    async () => ({ structured: { summary: 's', findings: [] } }),
    async (options) => {
      assert.match(options.prompt, /Lo pidió: Bo/);
      fs.writeFileSync(path.join(options.cwd, 'app.js'), 'renamed\n');
      return { structured: { fixed: true, summary: 'Renamed.' } };
    },
  ]);
  forgeState.comments.push({ commentId: '555', author: 'Bo', body: 'Please rename add\nit is confusing', inlinePath: 'app.js', inlineLine: 1, deleted: false, createdOn: '2026-09-03T00:00:00Z', parentId: null });
  await service.call('refreshPrs', { repoId: repo.id });
  await service.call('review', { repoId: repo.id, prId: 7 });
  let view = await service.call('pr', { repoId: repo.id, prId: 7 });
  assert.deepEqual(view.foreign.map((r) => r.commentId), ['555']);
  const adopted = await service.call('adopt', { repoId: repo.id, prId: 7, commentId: '555' });
  assert.equal(adopted.finding.askedBy, 'Bo');
  assert.equal(adopted.finding.title, 'Please rename add');
  assert.equal((await service.call('adopt', { repoId: repo.id, prId: 7, commentId: '555' })).finding.id, adopted.finding.id, 'adopting twice is the same finding');
  const fixed = await service.call('fix', { findingId: adopted.finding.id });
  assert.equal(fixed.ok, true, fixed.error);
  assert.equal(forgeState.posted[0].parentId, '555', 'the answer hangs from their comment');
  view = await service.call('pr', { repoId: repo.id, prId: 7 });
  assert.equal(view.foreign[0].adoptedFindingId, adopted.finding.id);
  // A rerun replaces what the review found, never what somebody asked for.
  service.store.replaceFindings(service.store.latestDone(repo.id, 7).id, repo.id, 7, []);
  assert.ok(service.store.finding(adopted.finding.id));
});

test('stances, decline and merge go to the forge and are remembered', { skip }, async () => {
  const { service, repo, forgeState } = setup([]);
  await service.call('refreshPrs', { repoId: repo.id });
  service.store.setPref('me.author', 'Reviewer');
  await service.call('approve', { repoId: repo.id, prId: 7 });
  assert.deepEqual(service.store.approvals(repo.id, 7).map((a) => [a.who, a.state, a.byUs]), [['Reviewer', 'APPROVED', true]]);
  await service.call('undoRequestChanges', { repoId: repo.id, prId: 7 });
  assert.equal(service.store.approvals(repo.id, 7).length, 0);
  assert.equal((await service.call('decline', { repoId: repo.id, prId: 7, reason: '  ' })).ok, false, 'a decline needs a reason');
  const merged = await service.call('merge', { repoId: repo.id, prId: 7, strategy: 'SQUASH' });
  assert.equal(merged.ok, true, merged.error);
  assert.deepEqual(forgeState.calls, ['approve', 'undoRequestChanges', 'merge:SQUASH']);
  assert.equal(service.store.pr(repo.id, 7).state, 'MERGED');
  assert.equal(service.store.pref('merge.strategy'), 'SQUASH');
});

test('the verb table: unknown names do not run, tokens never leave, repositories are validated', { skip }, async () => {
  const { service, repo, w } = setup([]);
  assert.match((await service.call('nope')).error, /No such Code Reviewer action/);
  assert.match((await service.call('constructor')).error, /No such/);
  const listed = await service.call('repos');
  assert.equal(listed.repos[0].token, undefined);
  assert.equal(listed.repos[0].hasToken, true);
  assert.equal(JSON.stringify(await service.call('overview')).includes('secret'), false);
  assert.match((await service.call('saveRepo', { repo: { name: 'x', provider: 'GITHUB', owner: 'o', slug: 's', localPath: w.root } })).error, /not a git working copy/);
  const detected = await service.call('detectRemote', { localPath: w.clone });
  assert.equal(detected.ok, true);
  const edited = await service.call('saveRepo', { repo: { id: repo.id, name: 'Renamed', provider: 'BITBUCKET', owner: 'other', slug: 'other', localPath: w.clone, token: '' } });
  assert.equal(edited.ok, true, edited.error);
  const stored = service.store.repo(repo.id);
  assert.deepEqual([stored.name, stored.provider, stored.owner, stored.token], ['Renamed', 'GITHUB', 'me', 'secret'], 'provider, owner and slug are fixed; a blank token keeps the stored one');
  assert.match((await service.call('openUrl', { url: 'file:///etc/passwd' })).error, /Only GitHub and Bitbucket/);
});

test('runs left running by a previous process are failed and queued, once', { skip }, async () => {
  const { service, repo } = setup([]);
  await service.call('refreshPrs', { repoId: repo.id });
  service.store.startReview({ repoId: repo.id, prId: 7, headSha: 'x', depth: 'LIGHT' });
  service.store.orphanedRuns();
  assert.equal(service.store.reviewsFor(repo.id, 7)[0].status, 'FAILED');
  assert.equal(service.store.pendingJobs().length, 1);
  service.store.orphanedRuns();
  assert.equal(service.store.pendingJobs().length, 1);
});

test('importing an AI Code Reviewer database: tokens decrypted with its key, history copied, twice is once', { skip }, async () => {
  const { service, w } = setup([]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-import-'));
  const dbFile = path.join(dir, 'acr.db');
  const keyFile = path.join(dir, 'master.key');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key);
  const { encryptToken, inspect, importAll } = require('../electron/review-import');
  const acr = new sqlite.DatabaseSync(dbFile);
  acr.exec(`
    CREATE TABLE repo (id TEXT, name TEXT, provider TEXT, owner TEXT, slug TEXT, local_path TEXT, token_cipher BLOB, created_at TEXT, project_kind TEXT, default_depth TEXT, default_model TEXT, auto_review INTEGER, skip_drafts INTEGER, skip_titles TEXT, skip_authors TEXT, only_targets TEXT, reply_mode TEXT, local_only INTEGER, hidden INTEGER, fix_mode TEXT);
    CREATE TABLE review (id TEXT, repo_id TEXT, pr_id INTEGER, pr_title TEXT, head_sha TEXT, status TEXT, body TEXT, created_at TEXT, cost_usd REAL, unknown_column TEXT);
    CREATE TABLE finding (id TEXT, review_id TEXT, repo_id TEXT, pr_id INTEGER, file_path TEXT, line_no INTEGER, severity TEXT, title TEXT, body TEXT, created_at TEXT, asked_by TEXT);
    CREATE TABLE closed_pr (repo_id TEXT, pr_id INTEGER, closed_at TEXT, state TEXT);
    CREATE TABLE pref (k TEXT, v TEXT);
  `);
  acr.prepare('INSERT INTO repo VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('R1', 'Legacy', 'BITBUCKET', 'team', 'legacy', w.clone, encryptToken('bb-token', key), '2026-01-01', 'AUTO', 'HEAVY', 'AUTO', 1, 1, 'WIP', '', '', 'AUTO', 0, 0, 'AUTO');
  acr.prepare('INSERT INTO repo VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('R2', 'Folder', 'BITBUCKET', 'x', 'y', w.clone, null, '2026-01-01', 'AUTO', 'AUTO', 'AUTO', 0, 1, '', '', '', 'DRAFT', 1, 0, 'MANUAL');
  acr.prepare('INSERT INTO review VALUES (?,?,?,?,?,?,?,?,?,?)').run('V1', 'R1', 12, 'Old PR', 'abc', 'DONE', 'body', '2026-02-01', 0.5, 'ignored');
  acr.prepare('INSERT INTO review VALUES (?,?,?,?,?,?,?,?,?,?)').run('V2', 'R1', 13, 'Crashed', 'def', 'RUNNING', null, '2026-02-02', 0, null);
  acr.prepare('INSERT INTO finding VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('F1', 'V1', 'R1', 12, 'a.kt', 3, 'major', 'T', 'B', '2026-02-01', null);
  // Old rows with holes: a review with no head or title, its finding, and a finding whose review is gone.
  acr.prepare('INSERT INTO review VALUES (?,?,?,?,?,?,?,?,?,?)').run('V3', 'R1', 14, null, null, 'DONE', null, '2026-02-03', null, null);
  acr.prepare('INSERT INTO finding VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('F2', 'V3', 'R1', 14, 'b.kt', null, 'minor', 'U', 'C', '2026-02-03', null);
  acr.prepare('INSERT INTO finding VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('F3', 'GONE', 'R1', 14, 'c.kt', null, 'minor', 'Orphan', 'D', '2026-02-03', null);
  acr.prepare('INSERT INTO closed_pr VALUES (?,?,?,?)').run('R1', 12, '2026-03-01', 'MERGED');
  acr.prepare('INSERT INTO pref VALUES (?,?)').run('review.language', 'English');
  acr.prepare('INSERT INTO pref VALUES (?,?)').run('auto.enabled', 'true');
  acr.prepare('INSERT INTO pref VALUES (?,?)').run('pane.sidebar', '266');
  acr.close();

  const source = { dbFile, keyFile, fixesDir: path.join(dir, 'fixes') };
  const found = inspect({ DatabaseSync: sqlite.DatabaseSync, source });
  assert.equal(found.repos.length, 2);
  assert.equal(found.counts.findings, 3);
  const report = importAll({ DatabaseSync: sqlite.DatabaseSync, store: service.store, source });
  assert.equal(report.repos, 1);
  assert.match(report.skippedRepos[0], /Folder: a local folder/);
  const legacy = service.store.repo('R1');
  assert.equal(legacy.token, 'bb-token');
  assert.deepEqual([legacy.autoReview, legacy.replyMode, legacy.fixMode, legacy.defaultDepth, legacy.projectKind, legacy.defaultModel], [false, 'DRAFT', 'MANUAL', 'HEAVY', null, ''], 'automatic modes arrive switched off; AUTO means unset');
  assert.equal(service.store.finding('F1').title, 'T');
  assert.equal(service.store.review('V3').status, 'DONE', 'a review with NULLs takes the defaults instead of being dropped');
  assert.equal(service.store.finding('F2').title, 'U');
  assert.equal(service.store.finding('F3'), null, 'an orphan is left behind');
  assert.equal(report.skippedRows, 1);
  assert.equal(service.store.review('V2').status, 'FAILED');
  assert.equal(service.store.pr('R1', 12).state, 'MERGED');
  assert.equal(service.store.pr('R1', 13).title, 'Crashed', 'a PR known only from a review still gets a row');
  assert.equal(service.store.pref('review.language'), 'English');
  assert.equal(service.store.pref('auto.enabled'), 'false');
  assert.equal(service.store.pref('pane.sidebar'), null);
  const again = importAll({ DatabaseSync: sqlite.DatabaseSync, store: service.store, source });
  assert.equal(again.repos, 0);
  assert.equal(again.rows.cr_finding, 0);
});

test('a database newer than this build refuses to open', { skip }, () => {
  const { ReviewStore, MIGRATIONS } = require('../electron/review-store');
  const db = new sqlite.DatabaseSync(':memory:');
  new ReviewStore(db);
  db.prepare('UPDATE cr_schema SET version = ?').run(MIGRATIONS.length + 1);
  assert.throws(() => new ReviewStore(db), /newer than this build knows/);
});


test('a finding someone else already published is recognised, and never posted twice', { skip }, async () => {
  const { service, repo, forgeState } = setup([async () => ({ structured: { summary: 's', findings: [finding()] } })]);
  await service.call('refreshPrs', { repoId: repo.id });
  await service.call('review', { repoId: repo.id, prId: 7 });
  // AI Code Reviewer, running beside this app, published it in the meantime.
  forgeState.comments.push({ commentId: '777', author: 'Viktor', body: '_bug_ · **add subtracts**\n\nIt returns a - b.', inlinePath: 'app.js', inlineLine: 2, deleted: false, createdOn: new Date().toISOString(), parentId: null });
  const posted = forgeState.posted.length;
  const published = await service.call('publishAll', { repoId: repo.id, prId: 7 });
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(forgeState.posted.length, posted, 'nothing was posted again');
  const view = await service.call('pr', { repoId: repo.id, prId: 7 });
  assert.equal(view.findings[0].publishedId, '777');
  assert.ok(view.comments.find((c) => c.commentId === '777').ours, 'and its comment is ours, so a reply to it is a reply to us');
  forgeState.comments.push({ commentId: '778', author: 'Ana', body: 'fixed', inlinePath: 'app.js', inlineLine: 2, deleted: false, createdOn: new Date(Date.now() + 1000).toISOString(), parentId: '777' });
  await service.call('loadPr', { repoId: repo.id, prId: 7 });
  assert.equal((await service.call('pr', { repoId: repo.id, prId: 7 })).threads[0].state, 'NEEDS_ANSWER');
});

test('commits: a branch missing from the clone is fetched, and a deleted one is read from the provider', { skip }, async () => {
  const { service, repo, w, forgeState } = setup([]);
  await service.call('refreshPrs', { repoId: repo.id });
  git(w.clone, 'update-ref', '-d', 'refs/remotes/origin/feature');
  const fetched = await service.call('commits', { repoId: repo.id, prId: 7 });
  assert.equal(fetched.ok, true, fetched.error);
  assert.equal(fetched.commits.length, 1, 'the missing branch was fetched, not shown as empty');
  assert.equal(fetched.note, null);
  const files = await service.call('files', { repoId: repo.id, prId: 7 });
  assert.deepEqual(files.files.map((f) => f.path), ['app.js']);

  // The PR is merged and its branch deleted on the remote.
  git(w.seed, 'push', 'origin', '--delete', 'feature');
  git(w.clone, 'update-ref', '-d', 'refs/remotes/origin/feature');
  service.store.upsertPr(repo.id, { ...service.store.pr(repo.id, 7), state: 'MERGED' });
  const gone = await service.call('commits', { repoId: repo.id, prId: 7 });
  assert.equal(gone.ok, true, gone.error);
  assert.match(gone.note, /The branch feature is not on origin any more: the pull request is merged, and its branch was deleted\. These commits are read from GitHub/);
  assert.deepEqual(gone.commits.map((c) => c.subject), ['from the provider']);
  assert.ok(forgeState.calls.includes('commits'));
  const noFiles = await service.call('files', { repoId: repo.id, prId: 7 });
  assert.match(noFiles.error, /The branch feature is not on origin any more/);
});

test('a review records the commit it read, even when the author pushed after the list was read', { skip }, async () => {
  const { service, w, repo } = setup([async () => ({ structured: { summary: 'Fine.', findings: [] } })]);
  const call = (name, args) => service.call(name, args);
  assert.equal((await call('refreshPrs', { repoId: repo.id })).ok, true);
  // The author pushes again; the PR row still names the commit the list saw.
  fs.writeFileSync(path.join(w.seed, 'app.js'), 'function add(a, b) {\n  return a - b - 0;\n}\n');
  git(w.seed, 'commit', '-am', 'again');
  git(w.seed, 'push', 'origin', 'feature');
  const newer = git(w.seed, 'rev-parse', 'HEAD');
  const outcome = await call('review', { repoId: repo.id, prId: 7 });
  assert.equal(outcome.ok, true, outcome.error);
  const view = await call('pr', { repoId: repo.id, prId: 7 });
  assert.equal(view.review.headSha, newer);
});

test('a final pass that cannot fetch says so, instead of stamping a head it never saw', { skip }, async () => {
  const { service, w, repo, claude } = setup([
    async () => ({ structured: { summary: 'Fine.', findings: [] } }),
    async () => ({ structured: { summary: 'Nothing.', mergeable: true, blockers: [] } }),
  ]);
  const call = (name, args) => service.call(name, args);
  assert.equal((await call('refreshPrs', { repoId: repo.id })).ok, true);
  assert.equal((await call('review', { repoId: repo.id, prId: 7 })).ok, true);
  git(w.clone, 'remote', 'set-url', 'origin', path.join(w.root, 'gone.git'));
  const outcome = await call('finalPass', { repoId: repo.id, prId: 7 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /git fetch failed/);
  assert.equal(claude.runs.length, 1, 'the model was never asked');
  const view = await call('pr', { repoId: repo.id, prId: 7 });
  assert.equal(view.finalPassDone, false);
});

test('cancel stops a run before its process exists, and a stale cancel is not remembered', () => {
  const { Activity } = require('../electron/review-engine');
  const activity = new Activity(() => {});
  assert.equal(activity.cancel('review:r:1'), false, 'nothing running: nothing to remember');
  activity.start('review:r:1', { kind: 'review' });
  assert.equal(activity.cancel('review:r:1'), true);
  let killed = 0;
  activity.patch('review:r:1', { handle: { cancel: () => killed++ } });
  assert.equal(killed, 1, 'the process is stopped as soon as it registers');
  activity.end('review:r:1');
  activity.start('review:r:1', { kind: 'review' });
  activity.patch('review:r:1', { handle: { cancel: () => killed++ } });
  assert.equal(killed, 1, 'the next run of the same PR is not killed by the old cancel');
});

test('publishing the same finding twice at once posts it once', { skip }, async () => {
  const { service, repo, forgeState } = setup([async () => ({ structured: { summary: 'One.', findings: [finding()] } })]);
  const call = (name, args) => service.call(name, args);
  assert.equal((await call('refreshPrs', { repoId: repo.id })).ok, true);
  assert.equal((await call('review', { repoId: repo.id, prId: 7 })).ok, true);
  const [f] = (await call('pr', { repoId: repo.id, prId: 7 })).findings;
  const results = await Promise.all([service.engine.publishFinding(f.id), service.engine.publishFinding(f.id)]);
  assert.equal(forgeState.posted.length, 1);
  assert.equal(results[0].url, results[1].url);
});

test('editing a hidden repository leaves it hidden', { skip }, () => {
  const { service, repo } = setup([]);
  service.store.setHidden(repo.id, true);
  const saved = service.store.saveRepo({ id: repo.id, name: 'Renamed', localPath: repo.localPath });
  assert.equal(saved.hidden, true);
  assert.equal(service.store.saveRepo({ id: repo.id, name: 'Renamed', localPath: repo.localPath, hidden: false }).hidden, false);
});

test('the code view: statuses, the file at the head, and viewed marks that survive commits that did not touch them', { skip }, async () => {
  const { service, repo, w, forgeState } = setup([]);
  const call = (name, args) => service.call(name, args);
  // A second file, added on the branch.
  fs.writeFileSync(path.join(w.seed, 'notes.md'), '# Notes\n\none\n');
  git(w.seed, 'add', '.');
  git(w.seed, 'commit', '-m', 'notes');
  git(w.seed, 'push', 'origin', 'feature');
  forgeState.prs[0].headSha = git(w.seed, 'rev-parse', 'HEAD');
  assert.equal((await call('refreshPrs', { repoId: repo.id })).ok, true);

  const files = await call('files', { repoId: repo.id, prId: 7 });
  assert.equal(files.ok, true, files.error);
  assert.deepEqual(files.files.map((f) => [f.path, f.status]), [['app.js', 'M'], ['notes.md', 'A']]);
  const text = await call('fileText', { repoId: repo.id, prId: 7, file: 'app.js' });
  assert.deepEqual([text.total, text.truncated, text.lines[1]], [3, false, '  return a - b;']);
  assert.match((await call('fileText', { repoId: repo.id, prId: 7, file: 'nope.js' })).error, /not on feature/);

  assert.deepEqual((await call('setViewed', { repoId: repo.id, prId: 7, file: 'app.js' })).files, ['app.js']);
  assert.deepEqual((await call('setViewed', { repoId: repo.id, prId: 7, file: 'notes.md' })).files, ['app.js', 'notes.md']);

  // New commits change notes.md only: app.js is still read, notes.md comes back.
  fs.writeFileSync(path.join(w.seed, 'notes.md'), '# Notes\n\ntwo\n');
  git(w.seed, 'commit', '-am', 'more notes');
  git(w.seed, 'push', 'origin', 'feature');
  git(w.clone, 'fetch', 'origin');
  forgeState.prs[0].headSha = git(w.seed, 'rev-parse', 'HEAD');
  assert.equal((await call('refreshPrs', { repoId: repo.id })).ok, true);
  assert.deepEqual((await call('viewed', { repoId: repo.id, prId: 7 })).files, ['app.js']);
  assert.deepEqual((await call('setViewed', { repoId: repo.id, prId: 7, file: 'app.js', viewed: false })).files, []);
});

test('a reply from the code view goes into that thread and is recorded as ours; a note is kept, then published', { skip }, async () => {
  const { service, repo, forgeState } = setup([]);
  const call = (name, args) => service.call(name, args);
  assert.equal((await call('refreshPrs', { repoId: repo.id })).ok, true);
  forgeState.comments.push({ commentId: '900', author: 'Ana', body: 'Why subtract?', inlinePath: 'app.js', inlineLine: 2, deleted: false, createdOn: '2026-09-03T10:00:00Z', parentId: null });
  assert.equal((await call('pr', { repoId: repo.id, prId: 7 })).ok, true);
  await service.engine.syncComments(service.engine.requireRepo(repo.id), 7);

  assert.match((await call('replyToComment', { repoId: repo.id, prId: 7, commentId: '900', body: '  ' })).error, /empty/);
  assert.match((await call('replyToComment', { repoId: repo.id, prId: 7, commentId: 'missing', body: 'x' })).error, /not in the stored thread/);
  const replied = await call('replyToComment', { repoId: repo.id, prId: 7, commentId: '900', body: 'It should not.' });
  assert.equal(replied.ok, true, replied.error);
  assert.deepEqual(forgeState.posted.map((p) => [p.parentId, p.body]), [['900', 'It should not.']]);
  const view = await call('pr', { repoId: repo.id, prId: 7 });
  assert.ok(view.publications.some((p) => p.body === 'It should not.'));

  const added = await call('addNote', { repoId: repo.id, prId: 7, file: 'app.js', line: 2, body: 'Check the sign.' });
  assert.equal(added.ok, true, added.error);
  const noteId = (await call('pr', { repoId: repo.id, prId: 7 })).notes[0].id;
  assert.equal((await call('publishNote', { noteId })).ok, true);
  assert.deepEqual(forgeState.posted.slice(-1).map((p) => [p.inlinePath, p.inlineLine, p.body]), [['app.js', 2, 'Check the sign.']]);
  assert.ok((await call('pr', { repoId: repo.id, prId: 7 })).notes[0].publishedId);
});

test('a PR imported without branch names says so instead of naming an empty branch', { skip }, async () => {
  const { service, repo } = setup([]);
  assert.equal((await service.call('refreshPrs', { repoId: repo.id })).ok, true);
  service.store.upsertPr(repo.id, { ...service.store.pr(repo.id, 7), sourceBranch: '', targetBranch: '', state: 'MERGED' });
  const files = await service.call('files', { repoId: repo.id, prId: 7 });
  assert.match(files.error, /imported without its branch names/);
});

test('an incremental review whose PR row is behind the branch still reads the new commits', { skip }, async () => {
  const { service, repo, w, claude } = setup([
    async () => ({ structured: { summary: 'first', findings: [] } }),
    async () => ({ structured: { summary: 'second', findings: [], carried: [] } }),
  ]);
  await service.call('refreshPrs', { repoId: repo.id });
  assert.equal((await service.call('review', { repoId: repo.id, prId: 7 })).ok, true);
  // Pushed, but nothing reloaded the PR row: it still names the first commit.
  fs.writeFileSync(path.join(w.seed, 'app.js'), 'function add(a, b) {\n  return a + b;\n}\n');
  git(w.seed, 'commit', '-am', 'fix');
  git(w.seed, 'push', 'origin', 'feature');
  const newer = git(w.seed, 'rev-parse', 'HEAD');
  const second = await service.call('review', { repoId: repo.id, prId: 7 });
  assert.equal(second.ok, true, second.error);
  assert.match(claude.runs[1].prompt, new RegExp(`Commits nuevos a revisar: ${w.head}\\.\\.${newer}`), 'the range ends at what was fetched, not at the stale row');
});

// ---------------------------------------------------------------- reviews side by side

/*
 * Reviewing one pull request must not stop you reviewing another.
 *
 * Nothing in the engine ever said otherwise — the claim it keeps is per pull
 * request, which is right, and two different ones were always free to run. The
 * limit was the panel: it marked itself busy under the bare key `review`, and
 * since that call resolves only when the whole review has finished, one running
 * review greyed out the button everywhere. These cover the two things that had
 * to become true underneath before that key could be per pull request.
 */
test('reviews run several at a time, and the rest wait rather than being refused', async () => {
  const { Semaphore } = require('../electron/review-engine');
  const slots = new Semaphore(4);

  let running = 0;
  let mostAtOnce = 0;
  const finished = [];
  const release = [];

  const runs = Array.from({ length: 7 }, (_, i) =>
    slots.use(async () => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise((resolve) => release.push(resolve));
      running -= 1;
      finished.push(i);
    }),
  );

  // Let the first four take their slots…
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(mostAtOnce, 4, 'four at once, not one');

  // …then let them go, and keep letting go of whoever moves up behind them.
  // Draining once would only release the first four and leave the queue holding
  // three promises nobody ever settles.
  while (finished.length < 7) {
    while (release.length) release.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(runs);

  assert.strictEqual(finished.length, 7, 'and the other three ran, they did not fail');
  assert.ok(mostAtOnce <= 4, 'never more than the slots allow');
});

/*
 * The one thing two reviews of the same repository must not do together. A
 * review reads by sha and never touches the working tree — except the fetch,
 * which writes refs, and two of those at once is how you get "cannot lock ref"
 * on a review that had nothing wrong with the code it was reading.
 */
test('two reviews of one repository never fetch into it at the same time', async () => {
  const { ReviewEngine } = require('../electron/review-engine');
  const engine = Object.create(ReviewEngine.prototype);
  engine.fetching = new Map();

  let inside = 0;
  let overlapped = false;
  const order = [];
  const fetch = (name, ms) =>
    engine.inClone('/clone', async () => {
      inside += 1;
      if (inside > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, ms));
      inside -= 1;
      order.push(name);
    });

  await Promise.all([fetch('a', 20), fetch('b', 1), fetch('c', 1)]);
  assert.strictEqual(overlapped, false, 'one at a time in one clone');
  assert.deepStrictEqual(order, ['a', 'b', 'c'], 'and in the order they asked');

  // A different clone is a different queue: one repository's fetch must not
  // hold up another's. The count is read on the way *in*, since the short one
  // is long finished by the time the slow one wakes up.
  inside = 0;
  let together = 0;
  const enter = async (ms) => {
    inside += 1;
    together = Math.max(together, inside);
    await new Promise((resolve) => setTimeout(resolve, ms));
    inside -= 1;
  };
  await Promise.all([engine.inClone('/one', () => enter(15)), engine.inClone('/two', () => enter(1))]);
  assert.strictEqual(together, 2, 'two clones do run together');
});

/*
 * A fetch that throws must not leave everyone behind it waiting on a promise
 * that will never settle — the queue has to survive the failure, while the
 * caller still sees it.
 */
test('a failed fetch does not wedge the queue behind it', async () => {
  const { ReviewEngine } = require('../electron/review-engine');
  const engine = Object.create(ReviewEngine.prototype);
  engine.fetching = new Map();

  const boom = engine.inClone('/clone', async () => {
    throw new Error('cannot lock ref');
  });
  await assert.rejects(boom, /cannot lock ref/, 'the caller is told');

  const after = await engine.inClone('/clone', async () => 'ran anyway');
  assert.strictEqual(after, 'ran anyway');
});

// ---------------------------------------------------------------- does it land

/*
 * Whether a branch merges is asked of the clone, not of the provider: GitHub
 * answers `mergeable: null` while it works it out in the background, Bitbucket
 * does not answer at all, and the clone has both sides already the moment a
 * review has fetched them.
 *
 * `merge-tree --write-tree` performs the merge in the object database and
 * writes nothing to the working tree, so a clone somebody is using is not
 * disturbed by being asked.
 */
test('a branch is told apart as merging, conflicting, or unanswerable', async () => {
  const { ReviewGit } = require('../electron/review-git');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-conflict-'));
  try {
    git(dir, 'init', '-q', '.');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'one\n');
    fs.writeFileSync(path.join(dir, 'apart.txt'), 'untouched\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');

    // One branch that touches a different file, one that touches the same line.
    git(dir, 'checkout', '-q', '-b', 'clean');
    fs.writeFileSync(path.join(dir, 'apart.txt'), 'changed over here\n');
    git(dir, 'commit', '-qam', 'elsewhere');

    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', '-q', '-b', 'clashing');
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'theirs\n');
    git(dir, 'commit', '-qam', 'theirs');

    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'ours\n');
    git(dir, 'commit', '-qam', 'ours');

    const g = new ReviewGit();
    assert.deepStrictEqual(await g.conflicts(dir, 'main', 'clean'), [], 'a branch that lands says so with nothing');
    assert.deepStrictEqual(await g.conflicts(dir, 'main', 'clashing'), ['shared.txt'], 'and one that does not names the file');

    /*
     * The case that made this need a test. A branch that does not exist exits
     * 1 as well — the same code as "merged with conflicts" — so reading the
     * exit code and parsing what follows reports a missing ref as a clean
     * merge. `null` is "could not tell", and it is the one answer that must
     * never be confused with "clean".
     */
    assert.strictEqual(await g.conflicts(dir, 'main', 'no-such-branch'), null);
    assert.strictEqual(await g.conflicts(dir, 'main', ''), null);
    assert.strictEqual(await g.conflicts(dir, '', 'clean'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
