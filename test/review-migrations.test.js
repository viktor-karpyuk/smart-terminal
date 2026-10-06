'use strict';

/*
 * One migration number taken twice, and a repository that publishes by itself.
 *
 * The rules are pure and tested as such. The rest runs on real git
 * repositories in a temporary folder, with a fake forge and a fake Claude, the
 * same way `review-engine.test.js` does — and like it, needs `node:sqlite`
 * (Node 22+) and skips itself without it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { migrationNumber, findClashes, clashFor, clashSentence, clashMessage, renamedTo, renumberPlan } = require('../electron/review-migrations');

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

// ---------------------------------------------------------------- the number a file claims

test('the number a migration claims, however it is written', () => {
  assert.equal(migrationNumber('V12__add_orders.sql'), '12');
  assert.equal(migrationNumber('db/migration/V012__add_orders.sql'), '12', 'a leading zero is not part of the number');
  assert.equal(migrationNumber('v7__lower_case.sql'), '7');
  assert.equal(migrationNumber('V1_2__point_release.sql'), '1.2', 'a dotted Flyway version is a version');
  assert.equal(migrationNumber('V1.2__point_release.sql'), '1.2');
  assert.equal(migrationNumber('0012_add_orders.sql'), '12');
  assert.equal(migrationNumber('12-add-orders.xml'), '12');
  assert.equal(migrationNumber('012.sql'), '12');
  assert.equal(migrationNumber('R__refresh_views.sql'), null, 'a repeatable migration has no place in the sequence');
  assert.equal(migrationNumber('README.md'), null);
  assert.equal(migrationNumber('changelog-master.xml'), null);
});

// ---------------------------------------------------------------- what counts as a clash

const pr = (prId, added, extra = {}) => ({ prId, title: `PR ${prId}`, author: 'ana', url: `https://example.test/pr/${prId}`, sourceBranch: `feature-${prId}`, targetBranch: 'develop', added, ...extra });

test('two pull requests adding different files with one number clash', () => {
  const clashes = findClashes({ prs: [pr(1, ['db/V12__orders.sql']), pr(2, ['db/V012__invoices.sql']), pr(3, ['db/V13__other.sql'])] });
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].number, '12');
  assert.deepEqual(clashes[0].members.map((member) => member.prId), [1, 2]);
  assert.equal(clashFor(3, clashes), null, 'the one with a number of its own is not in it');
  const one = clashFor(1, clashes);
  assert.equal(one.onTarget, false);
  assert.match(clashSentence(one), /also taken by another pull request \(#2 adds V012__invoices\.sql\)/);
});

test('a pull request stacked on another carries its migration, and that is not a clash', () => {
  const clashes = findClashes({ prs: [pr(1, ['db/V12__orders.sql']), pr(2, ['db/V12__orders.sql', 'db/V13__more.sql'])] });
  assert.deepEqual(clashes, []);
});

test('a number the target already has is a clash, and merging is the duplicate', () => {
  const targets = new Map([['develop', ['db/V11__base.sql', 'db/V12__merged_last_week.sql']]]);
  const clashes = findClashes({ prs: [pr(4, ['db/V12__mine.sql']), pr(5, ['db/V13__fine.sql'])], targets });
  assert.equal(clashes.length, 1);
  const mine = clashFor(4, clashes);
  assert.equal(mine.onTarget, true);
  assert.deepEqual(mine.with, [{ number: '12', prId: null, branch: 'develop', path: 'db/V12__merged_last_week.sql' }]);
  assert.match(clashSentence(mine), /already taken on the target branch/);
  // A pull request into another branch does not meet develop's files.
  assert.deepEqual(findClashes({ prs: [pr(6, ['db/V12__mine.sql'], { targetBranch: 'main' })], targets }), []);
});

test('the room is told once per set of people, and again when somebody joins', () => {
  const repo = { id: 'r1', name: 'orders-api' };
  const two = findClashes({ prs: [pr(1, ['db/V12__a.sql']), pr(2, ['db/V12__b.sql'])] })[0];
  const again = findClashes({ prs: [pr(2, ['db/V12__b.sql']), pr(1, ['db/V12__a.sql'])] })[0];
  const three = findClashes({ prs: [pr(1, ['db/V12__a.sql']), pr(2, ['db/V12__b.sql']), pr(3, ['db/V12__c.sql'])] })[0];
  const message = clashMessage(repo, two);
  assert.equal(message.key, clashMessage(repo, again).key, 'the same clash, whatever order it was read in');
  assert.notEqual(message.key, clashMessage(repo, three).key, 'a third one joining is news');
  assert.match(message.title, /orders-api: two migrations numbered 12/);
  assert.match(message.body, /#1 and #2 each add a migration numbered 12/);
  assert.deepEqual(message.links.map((link) => link.url), ['https://example.test/pr/1', 'https://example.test/pr/2']);
  assert.equal(message.level, 'urgent');
});

// ---------------------------------------------------------------- end to end

/**
 * An origin whose `develop` has V1 and V2, and two branches off it that each
 * add a V3 of their own — which is the whole story in three commits.
 */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-migrations-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  const dir = path.join(seed, 'db', 'migration');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, seed);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'V1__init.sql'), 'create table a (id int);\n');
  fs.writeFileSync(path.join(dir, 'V2__more.sql'), 'create table b (id int);\n');
  fs.writeFileSync(path.join(seed, 'app.js'), 'module.exports = 1;\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'base');
  git(seed, 'push', 'origin', 'HEAD:develop');
  const heads = {};
  for (const [branch, file] of [['orders', 'V3__orders.sql'], ['invoices', 'V003__invoices.sql']]) {
    git(seed, 'checkout', '-q', '-b', branch, 'origin/develop');
    fs.writeFileSync(path.join(dir, file), `-- ${branch}\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', branch);
    git(seed, 'push', '-q', 'origin', branch);
    heads[branch] = git(seed, 'rev-parse', 'HEAD');
  }
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'fetch', '-q', 'origin');
  return { root, origin, seed, clone, heads };
}

function fakeForge(state) {
  let next = 100;
  const post = (comment) => {
    const id = String(next++);
    state.comments.push({ commentId: id, author: 'Reviewer', body: comment.body, inlinePath: comment.inlinePath ?? null, inlineLine: comment.inlineLine ?? null, deleted: false, createdOn: new Date(Date.now() + next).toISOString(), parentId: null });
    state.posted.push({ id, ...comment });
    return { id, url: `https://example.test/c/${id}` };
  };
  const client = {
    listOpen: async () => ({ prs: state.prs.filter((one) => one.state === 'OPEN'), etag: null, notModified: false }),
    search: async () => [],
    get: async (prId) => state.prs.find((one) => one.id === prId) ?? null,
    comments: async () => state.comments.slice(),
    comment: async (prId, body) => post({ prId, body }),
    inline: async (prId, body, filePath, line) => post({ prId, body, inlinePath: filePath, inlineLine: line }),
    merge: async (prId) => { state.calls.push(`merge:${prId}`); return 'sha'; },
  };
  return { of: () => client };
}

function fakeClaude(script) {
  const runs = [];
  return {
    runs,
    run: async (options) => {
      runs.push(options);
      const answer = script.shift();
      if (!answer) throw new Error(`no scripted answer for run ${runs.length}`);
      return { ok: true, text: '', stderr: '', structured: null, toolUses: 3, denials: [], limits: [], sessionId: 's', costUsd: 0.01, tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, accountName: 'Main', ...(await answer(options)) };
    },
  };
}

function setup({ script = [], repo: extra = {} } = {}) {
  const { ReviewService } = require('../electron/review-service');
  const w = world();
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const forgeState = { prs: [], comments: [], posted: [], calls: [] };
  const notes = [];
  const delivered = [];
  const service = new ReviewService({
    db,
    secrets: { encrypt: (text) => `enc:${text}`, decrypt: (cipher) => cipher.replace(/^enc:/, '') },
    fetch: async () => { throw new Error('no network in tests'); },
    profiles: { list: () => [{ id: 'p', name: 'Main' }] },
    resolvePath: async () => process.env.PATH,
    notify: (title, body) => notes.push(`${title} | ${body}`),
    emit: () => {},
    dataDir: w.root,
    DatabaseSync: sqlite.DatabaseSync,
    deliver: async (message) => { delivered.push(message); return { ok: true }; },
  });
  const forge = fakeForge(forgeState);
  const claude = fakeClaude(script);
  for (const holder of [service, service.engine, service.fixer]) {
    holder.forge = forge;
    holder.claude = claude;
  }
  const repo = service.store.saveRepo({ name: 'Orders', provider: 'GITHUB', owner: 'me', slug: 'orders', localPath: w.clone, token: 'secret', ...extra });
  const open = (id, branch) => ({ id, title: `The ${branch} work`, author: 'Ana', sourceBranch: branch, targetBranch: 'develop', headSha: w.heads[branch], state: 'OPEN', url: `https://example.test/pr/${id}`, createdOn: '2026-09-01 10:00', updatedOn: '2026-09-02 10:00', approvedBy: [], changesRequestedBy: [] });
  forgeState.prs.push(open(21, 'orders'), open(22, 'invoices'));
  return { service, w, forgeState, claude, repo, notes, delivered, call: (name, args) => service.call(name, args) };
}

test('a repository that watches its migrations flags the clash, tells its room once, and says it on the board', { skip }, async () => {
  const { service, repo, call, delivered } = setup({ repo: { migrationsPath: './db/migration/', alertChannel: 'payments-dev' } });
  assert.equal(service.store.repo(repo.id).migrationsPath, 'db/migration', 'kept the way git names it');
  await call('refreshPrs', { repoId: repo.id });

  const checked = await call('checkMigrations', { repoId: repo.id });
  assert.equal(checked.ok, true, checked.error);
  assert.deepEqual(checked.clashes.map((clash) => clash.number), ['3']);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].to, { channel: 'payments-dev' }, 'the repository\'s own room');
  assert.match(delivered[0].title, /Orders: two migrations numbered 3/);

  await call('checkMigrations', { repoId: repo.id });
  assert.equal(delivered.length, 1, 'the same two still clashing is not news');
  assert.match(service.store.migrationClashes(repo.id)[0].notifyResult, /sent to payments-dev/);

  const board = await call('prs', { repoId: repo.id });
  const row = board.rows.find((one) => one.pr.id === 21);
  assert.ok(row.flags.includes('MIGRATION_CLASH'));
  assert.match(row.mergeBlocker, /Migration 3 is also taken by another pull request/);
  const view = await call('pr', { repoId: repo.id, prId: 22 });
  assert.equal(view.migrationClash.onTarget, false);
  assert.equal(view.migrationClash.with[0].prId, 21);
});

test('once one of them lands, the other is not merged from here until it is renumbered', { skip }, async () => {
  const { repo, call, w, forgeState, delivered } = setup({ repo: { migrationsPath: 'db/migration' } });
  await call('refreshPrs', { repoId: repo.id });
  await call('checkMigrations', { repoId: repo.id });
  assert.equal(delivered.length, 0, 'no room named anywhere: nobody outside the app is told');

  // Two open pull requests sharing a number: neither merge is the duplicate on its own.
  const first = await call('merge', { repoId: repo.id, prId: 21 });
  assert.equal(first.ok, true, first.error);
  // …and on the remote, it landed.
  git(w.seed, 'checkout', '-q', 'develop');
  git(w.seed, 'reset', '-q', '--hard', 'origin/develop');
  git(w.seed, 'merge', '-q', '--no-ff', 'origin/orders', '-m', 'merge orders');
  git(w.seed, 'push', '-q', 'origin', 'develop');
  forgeState.prs.find((one) => one.id === 21).state = 'MERGED';

  const second = await call('merge', { repoId: repo.id, prId: 22 });
  assert.equal(second.ok, false);
  assert.match(second.error, /Migration 3 is already taken on the target branch \(develop already has V3__orders\.sql\)/);
  assert.deepEqual(forgeState.calls, ['merge:21'], 'the forge was never asked');

  // Renumbered and pushed: it goes.
  git(w.seed, 'checkout', '-q', 'invoices');
  git(w.seed, 'mv', 'db/migration/V003__invoices.sql', 'db/migration/V4__invoices.sql');
  git(w.seed, 'commit', '-q', '-m', 'renumber');
  git(w.seed, 'push', '-q', 'origin', 'invoices');
  forgeState.prs.find((one) => one.id === 22).headSha = git(w.seed, 'rev-parse', 'HEAD');
  await call('refreshPrs', { repoId: repo.id });
  const third = await call('merge', { repoId: repo.id, prId: 22 });
  assert.equal(third.ok, true, third.error);
});

test('a repository that does not name a folder is not watched, and clearing it clears what it said', { skip }, async () => {
  const { service, repo, call } = setup({ repo: { migrationsPath: 'db/migration' } });
  await call('refreshPrs', { repoId: repo.id });
  await call('checkMigrations', { repoId: repo.id });
  assert.equal(service.store.migrationClashes(repo.id).length, 1);
  service.store.saveRepo({ ...service.store.repo(repo.id), migrationsPath: '' });
  await call('checkMigrations', { repoId: repo.id });
  assert.deepEqual(service.store.migrationClashes(repo.id), []);
  assert.throws(() => service.store.saveRepo({ ...service.store.repo(repo.id), migrationsPath: '../elsewhere' }), /inside the repository/);
});

// ---------------------------------------------------------------- publishing by itself

const finding = { file: 'db/migration/V3__orders.sql', line: 1, severity: 'major', category: 'BUG', title: 'no primary key', body: 'The table has none.', suggestion: '' };

test('a repository that publishes by itself puts the findings on the pull request when a review ends', { skip }, async () => {
  const { repo, call, forgeState, notes } = setup({ repo: { publishMode: 'AUTO' }, script: [async () => ({ structured: { summary: 'One thing.', findings: [finding] } })] });
  await call('refreshPrs', { repoId: repo.id });
  const outcome = await call('review', { repoId: repo.id, prId: 21 });
  assert.equal(outcome.ok, true, outcome.error);
  // Published after the review is saved, off the review's own path.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(forgeState.posted.length, 1);
  assert.equal(forgeState.posted[0].inlinePath, 'db/migration/V3__orders.sql');
  assert.ok(notes.some((note) => /^Published · Orders #21/.test(note)), notes.join('\n'));
  const view = await call('pr', { repoId: repo.id, prId: 21 });
  assert.ok(view.findings.every((one) => one.publishedId), 'nothing left as a draft');
});

test('a clean review says so once, and a note is never published for anybody', { skip }, async () => {
  const clean = async () => ({ structured: { summary: 'Nothing to say.', findings: [] } });
  const { service, repo, call, forgeState } = setup({ repo: { publishMode: 'AUTO' }, script: [clean, clean] });
  await call('refreshPrs', { repoId: repo.id });
  const noted = await call('addNote', { repoId: repo.id, prId: 21, file: 'app.js', line: 1, body: 'mine, not yet' });
  assert.equal(noted.ok, true, noted.error);
  assert.equal(service.store.notes(repo.id, 21).length, 1);
  await call('review', { repoId: repo.id, prId: 21 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(forgeState.posted.length, 1, 'the summary, once');
  assert.equal(forgeState.posted[0].inlinePath, null);
  assert.ok(service.store.notes(repo.id, 21).every((note) => !note.publishedId), 'the note is still the person\'s');

  await call('review', { repoId: repo.id, prId: 21, forceFull: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(forgeState.posted.length, 1, 'a second clean review is silence, not another comment');
});

test('a repository set to publish by hand publishes nothing by itself', { skip }, async () => {
  const { repo, call, forgeState } = setup({ script: [async () => ({ structured: { summary: 'One thing.', findings: [finding] } })] });
  await call('refreshPrs', { repoId: repo.id });
  await call('review', { repoId: repo.id, prId: 21 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(forgeState.posted.length, 0);
});


// ---------------------------------------------------------------- resolving a clash

test('a renamed migration keeps its prefix, its padding and the rest of its name', () => {
  assert.equal(renamedTo('db/migration/V003__invoices.sql', 5), 'db/migration/V005__invoices.sql');
  assert.equal(renamedTo('db/migration/V12__orders.sql', 15), 'db/migration/V15__orders.sql');
  assert.equal(renamedTo('db/migration/V9__x.sql', 10), 'db/migration/V10__x.sql', 'more digits when the number needs them');
  assert.equal(renamedTo('changes/0012_add.sql', 14), 'changes/0014_add.sql');
  assert.equal(renamedTo('changes/12-add.xml', 13), 'changes/13-add.xml');
  assert.equal(renamedTo('db/V1_2__point.sql', 3), null, 'a dotted version is not a place in a count');
  assert.equal(renamedTo('db/R__views.sql', 3), null);
});

test('the plan: who keeps a number, and the losing pull request moves from there on, in order', () => {
  const prs = [
    pr(21, ['db/V3__orders.sql'], { opened: '2026-09-01' }),
    pr(22, ['db/V003__invoices.sql', 'db/V004__index.sql'], { opened: '2026-09-02' }),
  ];
  const targets = new Map([['develop', ['db/V1__init.sql', 'db/V2__more.sql']]]);
  const clashes = findClashes({ prs, targets });
  const plan = renumberPlan({ clashes, prs, targets });
  assert.deepEqual(plan.decisions.map((d) => [d.number, d.keeper.prId, d.fixed]), [['3', 21, false]], 'the one opened first');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].prId, 22);
  assert.deepEqual(plan.steps[0].renames.map((one) => [one.from, one.to]), [
    ['db/V003__invoices.sql', 'db/V005__invoices.sql'],
    ['db/V004__index.sql', 'db/V006__index.sql'],
  ], 'its later migration moves too, so the two keep their order');
  assert.deepEqual(plan.steps[0].why, ['#21 keeps 3']);

  // Chosen the other way round, the other one moves.
  const other = renumberPlan({ clashes, prs, targets, keep: { 3: 22 } });
  assert.deepEqual(other.steps.map((step) => [step.prId, step.renames.map((one) => one.to)]), [[21, ['db/V5__orders.sql']]]);

  // Numbers the bus has reserved are not handed out.
  assert.equal(renumberPlan({ clashes, prs, targets, reserved: 9 }).steps[0].renames[0].to, 'db/V010__invoices.sql');
});

test('a number already on the target is kept by the target, whatever is chosen', () => {
  const prs = [pr(31, ['db/V3__late.sql'])];
  const targets = new Map([['develop', ['db/V1__a.sql', 'db/V3__merged.sql']]]);
  const plan = renumberPlan({ clashes: findClashes({ prs, targets }), prs, targets, keep: { 3: 31 } });
  assert.equal(plan.decisions[0].fixed, true);
  assert.equal(plan.decisions[0].keeper.branch, 'develop');
  assert.deepEqual(plan.steps.map((step) => step.renames[0].to), ['db/V4__late.sql']);
});

test('resolving: the losing branch gets one commit, pushed, with its references updated and its thread told', { skip }, async () => {
  const { service, repo, call, w, forgeState } = setup({ repo: { migrationsPath: 'db/migration' } });
  // invoices also adds a later migration and a changelog that names the clashing file.
  git(w.seed, 'checkout', '-q', 'invoices');
  fs.writeFileSync(path.join(w.seed, 'db', 'migration', 'V004__invoices_index.sql'), '-- index\n');
  fs.writeFileSync(path.join(w.seed, 'db', 'changelog.txt'), 'include db/migration/V003__invoices.sql\ninclude db/migration/XV003__invoices.sql.bak\n');
  git(w.seed, 'add', '.');
  git(w.seed, 'commit', '-q', '-m', 'more invoices');
  git(w.seed, 'push', '-q', 'origin', 'invoices');
  forgeState.prs.find((one) => one.id === 22).headSha = git(w.seed, 'rev-parse', 'HEAD');
  await call('refreshPrs', { repoId: repo.id });

  const planned = await call('migrationPlan', { repoId: repo.id });
  assert.equal(planned.ok, true, planned.error);
  assert.deepEqual(planned.plan.steps.map((step) => [step.prId, step.renames.map((one) => path.basename(one.to))]),
    [[22, ['V005__invoices.sql', 'V006__invoices_index.sql']]]);

  const result = await call('renumberMigrations', { repoId: repo.id });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.done.length, 1);
  assert.equal(result.done[0].ok, true, result.done[0].error);

  // On the remote branch, as the author will see it when they pull.
  git(w.seed, 'fetch', '-q', 'origin');
  const files = git(w.seed, 'ls-tree', '-r', '--name-only', 'origin/invoices', '--', 'db').split('\n');
  assert.ok(files.includes('db/migration/V005__invoices.sql') && files.includes('db/migration/V006__invoices_index.sql'));
  assert.ok(!files.includes('db/migration/V003__invoices.sql'));
  assert.equal(git(w.seed, 'show', 'origin/invoices:db/changelog.txt'),
    'include db/migration/V005__invoices.sql\ninclude db/migration/XV003__invoices.sql.bak', 'whole names only');
  assert.equal(git(w.seed, 'rev-list', '--count', `${forgeState.prs.find((one) => one.id === 22).headSha}..origin/invoices`), '1', 'one commit');
  assert.match(git(w.seed, 'log', '-1', '--format=%B', 'origin/invoices'), /#21 keeps 3/);
  // orders was not touched.
  assert.equal(git(w.seed, 'rev-parse', 'origin/orders'), w.heads.orders);

  assert.match(forgeState.posted.find((one) => one.prId === 22).body, /`V003__invoices\.sql` → `V005__invoices\.sql`/);
  assert.deepEqual(service.store.migrationClashes(repo.id), [], 'and the board stops saying it');
  // The numbers it took are reserved, so the bus never hands them out.
  assert.deepEqual(service.store.all('SELECT number FROM cr_migration_slot ORDER BY number').map((row) => row.number), [5, 6]);
});

test('resolving refuses to force: a branch that moved since it was read is left alone', { skip }, async () => {
  const { service, repo, call, w } = setup({ repo: { migrationsPath: 'db/migration' } });
  await call('refreshPrs', { repoId: repo.id });
  // Somebody pushes to invoices between the plan being read and the push.
  const real = service.migrations.git.commitAll.bind(service.migrations.git);
  service.migrations.git.commitAll = async (dir, message) => {
    const sha = await real(dir, message);
    git(w.seed, 'checkout', '-q', 'invoices');
    fs.writeFileSync(path.join(w.seed, 'app.js'), 'module.exports = 2;\n');
    git(w.seed, 'commit', '-q', '-am', 'meanwhile');
    git(w.seed, 'push', '-q', 'origin', 'invoices');
    return sha;
  };
  const result = await call('renumberMigrations', { repoId: repo.id, comment: false });
  assert.equal(result.done[0].ok, false);
  assert.match(result.done[0].error, /moved since it was read; nothing was pushed/);
  git(w.seed, 'fetch', '-q', 'origin');
  assert.match(git(w.seed, 'ls-tree', '-r', '--name-only', 'origin/invoices', '--', 'db'), /V003__invoices\.sql/);
});
