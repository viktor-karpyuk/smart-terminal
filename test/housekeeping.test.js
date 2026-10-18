'use strict';

/**
 * Housekeeping end to end, on a data folder and a checkout made for the test:
 * the inventory lists what is there with the right blockers, "free" removes
 * only the reversible and says what it gave back, and deleting sessions takes
 * the database rows and the saved copies together while a running session is
 * left alone.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';
const { Database } = sqlite ? require('../electron/database') : {};
const { HousekeepingStore } = sqlite ? require('../electron/housekeeping-store') : {};
const { Housekeeping } = require('../electron/housekeeping');
const { DiskUsage } = require('../electron/disk-usage');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 17, 12);
const made = [];
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hk-'));
  made.push(home);
  const userData = path.join(home, 'Smart Terminal');
  fs.mkdirSync(path.join(userData, 'context-snapshots'), { recursive: true });
  fs.mkdirSync(path.join(userData, 'updates'));
  fs.mkdirSync(path.join(userData, 'pasted'));
  const db = new Database(path.join(userData, 'smart-terminal.db'));
  const store = new HousekeepingStore(db.db);
  const sizes = new DiskUsage({ store, now: () => NOW });

  // Two ended sessions and one running, each with a saved copy.
  for (const [id, endedAt, bytes] of [['old', NOW - 45 * DAY, 300], ['recent', NOW - 2 * DAY, 200], ['live', null, 100]]) {
    db.openSession({ id, profileId: 'p', profileName: 'Default', kind: 'claude', title: id, startCwd: home, startedAt: NOW - 50 * DAY });
    db.db.prepare('UPDATE sessions SET transcript_bytes = ?, last_active_at = ?, ended_at = ? WHERE id = ?').run(bytes, endedAt ?? NOW, endedAt, id);
    fs.mkdirSync(path.join(userData, 'context-snapshots', id));
    fs.writeFileSync(path.join(userData, 'context-snapshots', id, 'copy.jsonl'), 'z'.repeat(50));
  }

  // Things beside the database.
  fs.writeFileSync(path.join(userData, 'smart-terminal.db.backup-1'), Buffer.alloc(2048));
  fs.mkdirSync(path.join(home, 'Smart Terminal.backup-20260901-000000'));
  fs.writeFileSync(path.join(home, 'Smart Terminal.backup-20260901-000000', 'big'), Buffer.alloc(4096));
  // Neighbours that are not backups: the development copy's data folder, and an unrelated folder sharing the prefix.
  fs.mkdirSync(path.join(home, 'Smart Terminal Dev'));
  fs.writeFileSync(path.join(home, 'Smart Terminal Dev', 'smart-terminal.db'), Buffer.alloc(64));
  fs.mkdirSync(path.join(home, 'Smart Terminal Notes'));
  fs.writeFileSync(path.join(userData, 'updates', 'old.dmg'), Buffer.alloc(100));
  fs.utimesSync(path.join(userData, 'updates', 'old.dmg'), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
  fs.writeFileSync(path.join(userData, 'updates', 'new.dmg'), Buffer.alloc(200));
  const stale = path.join(userData, 'pasted', 'pasted-old.png');
  fs.writeFileSync(stale, Buffer.alloc(10));
  fs.utimesSync(stale, new Date(NOW - 30 * DAY), new Date(NOW - 30 * DAY));

  // A checkout with a cache, under a root the person named.
  const roots = path.join(home, 'worktrees');
  const checkout = path.join(roots, 'app');
  fs.mkdirSync(checkout, { recursive: true });
  execFileSync('git', ['init', '-q', checkout]);
  fs.writeFileSync(path.join(checkout, '.gitignore'), 'node_modules\n');
  fs.mkdirSync(path.join(checkout, 'dist'));
  fs.writeFileSync(path.join(checkout, 'dist', 'kept.js'), 'shipped');
  fs.mkdirSync(path.join(checkout, 'node_modules'));
  fs.writeFileSync(path.join(checkout, 'node_modules', 'x.js'), 'q'.repeat(700));

  const forgotten = [];
  const context = { trackedIds: () => ['live'], forget: (id) => forgotten.push(id), setRecording: () => {} };
  const hk = new Housekeeping({ db, store, sizes, userData, context, live: () => [], now: () => NOW, review: null, fetch: false, browser: { size: async () => 777, clear: async () => {} } });
  hk.addRoot(roots);
  return { hk, db, sizes, userData, home, checkout: fs.realpathSync(checkout), forgotten };
}

test('the inventory lists sessions, caches and the folders beside the database, with blockers where they belong', { skip }, async () => {
  const { hk, sizes } = world();
  try {
    const first = await hk.inventory();
    const kinds = new Set(first.items.map((one) => one.kind));
    assert.deepEqual([...kinds].sort(), ['browser-cache', 'build-cache', 'db-backup', 'install-backup', 'installer', 'pasted', 'session']);

    const live = first.items.find((one) => one.id === 'session:live');
    assert.deepEqual(live.blockers, ['still running']);
    const old = first.items.find((one) => one.id === 'session:old');
    assert.equal(old.bytes, 350, 'transcript plus the saved copy');
    assert.equal(old.blockers.length, 0);

    const cache = first.items.find((one) => one.kind === 'build-cache' && one.meta.name === 'node_modules');
    assert.equal(cache.meta.sized, false, 'not walked yet');
    const dist = first.items.find((one) => one.kind === 'build-cache' && one.meta.name === 'dist');
    assert.deepEqual(dist.blockers, ['not ignored by git, so it may be committed work']);
    assert.ok(first.unsized.includes(cache.path));

    const measured = await hk.measure([...first.unsized, old.path]);
    assert.equal(measured[cache.path], 700);
    assert.equal(measured[old.path], undefined, 'a session\'s working folder is never walked');
    const second = await hk.inventory();
    assert.equal(second.items.find((one) => one.meta?.name === 'node_modules').bytes, 700);
    assert.equal(second.items.find((one) => one.kind === 'install-backup').bytes, 4096);
    assert.equal(second.totals.all.reversibleBytes, 700 + 4096 + 2048 + 100 + 200 + 10 + 777);

    const backups = second.items.filter((one) => one.kind === 'install-backup').map((one) => one.label);
    assert.deepEqual(backups, ['Smart Terminal.backup-20260901-000000'], 'the live folder, the Dev copy and look-alikes are not backups');
    assert.ok(!second.items.some((one) => one.path === hk.userData), 'the data folder is never an item');
    const installers = second.items.filter((one) => one.kind === 'installer');
    assert.equal(installers.find((one) => one.label === 'new.dmg').state, 'latest');
    assert.equal(installers.find((one) => one.label === 'old.dmg').state, 'superseded');
    assert.ok(second.disk.free === null || second.disk.free > 0);
  } finally {
    sizes.stop();
  }
});

test('free removes only the reversible, renames a cache aside, and writes the log', { skip }, async () => {
  const { hk, sizes, checkout, userData, home } = world();
  try {
    const before = await hk.inventory();
    await hk.measure(before.unsized);
    const ids = (await hk.inventory()).items.filter((one) => ['build-cache', 'db-backup', 'install-backup', 'installer'].includes(one.kind) && one.state !== 'latest').map((one) => one.id);
    const { results, freed } = await hk.free([...ids, 'session:old']);
    const gone = (await hk.free(['cache:/nowhere/at/all'])).results[0];
    assert.deepEqual([gone.ok, gone.note], [true, 'already gone'], 'an id for something that is not there is done, not failed');
    const refused = results.find((one) => one.id === 'session:old');
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not something this button removes/);
    assert.equal(freed, 700 + 2048 + 4096 + 100);
    assert.ok(!fs.existsSync(path.join(checkout, 'node_modules')));
    assert.ok(!fs.existsSync(path.join(userData, 'smart-terminal.db.backup-1')));
    assert.ok(!fs.existsSync(path.join(home, 'Smart Terminal.backup-20260901-000000')));
    assert.ok(fs.existsSync(path.join(userData, 'updates', 'new.dmg')), 'the newest installer stays');
    const log = hk.log();
    assert.equal(log.filter((row) => row.action === 'free' && row.ok).length, 4);
    const after = await hk.inventory();
    assert.equal(after.log.length, log.length, 'the inventory carries the recent log');
    assert.ok(after.log[0].at >= after.log[after.log.length - 1].at, 'newest first');
  } finally {
    sizes.stop();
  }
});

test('free refuses a path that is not where its kind lives, even with a well-formed id', { skip }, async () => {
  const { hk, sizes, home } = world();
  try {
    await hk.inventory();
    const stray = path.join(home, 'elsewhere');
    fs.mkdirSync(stray);
    fs.writeFileSync(path.join(stray, 'x'), '1');
    // Forge items into the last inventory as a window gone wrong might.
    hk.last.items.push({ id: 'dbbackup:stray', kind: 'db-backup', reversible: true, label: 'stray', path: path.join(stray, 'smart-terminal.db.backup-9'), bytes: 1, blockers: [] });
    hk.last.items.push({ id: 'cache:stray', kind: 'build-cache', reversible: true, label: 'stray', path: path.join(stray, 'node_modules'), bytes: 1, blockers: [] });
    hk.last.items.push({ id: 'installbackup:self', kind: 'install-backup', reversible: true, label: 'self', path: hk.userData, bytes: 1, blockers: [] });
    const { results } = await hk.free(['dbbackup:stray', 'cache:stray', 'installbackup:self']);
    assert.deepEqual(results.map((one) => one.ok), [false, false, false]);

    // A session walked into the checkout after the inventory was made: the cache is refused now, not by the stale list.
    const cache = hk.last.items.find((one) => one.kind === 'build-cache' && one.meta?.name === 'node_modules');
    hk.live = () => [path.join(cache.meta.checkout, 'src')];
    const late = (await hk.free([cache.id])).results[0];
    assert.equal(late.ok, false);
    assert.match(late.error, /a session is working/);
    assert.ok(fs.existsSync(cache.path));
    hk.live = () => [];
    assert.ok(fs.existsSync(hk.userData), 'the data folder itself is never a candidate');
    assert.ok(fs.existsSync(path.join(stray, 'x')));
  } finally {
    sizes.stop();
  }
});

test('deleting sessions takes rows and saved copies together and skips the one still running', { skip }, async () => {
  const { hk, db, sizes, userData, forgotten } = world();
  try {
    const out = hk.deleteSessions(['old', 'live', 'nope']);
    assert.deepEqual(out.deleted, ['old']);
    assert.deepEqual(out.skipped.sort(), ['live', 'nope']);
    assert.equal(out.bytes, 50);
    assert.equal(db.getSession('old'), null);
    assert.ok(db.getSession('live'));
    assert.ok(!fs.existsSync(path.join(userData, 'context-snapshots', 'old')));
    assert.ok(fs.existsSync(path.join(userData, 'context-snapshots', 'live')));
    assert.deepEqual(forgotten, ['old']);

    assert.deepEqual(hk.deleteSessions(['live']).deleted, [], 'a session still being recorded is skipped');

    const kept = hk.forgetTranscripts(['recent']);
    assert.equal(kept.count, 1);
    assert.equal(kept.bytes, 250);
    assert.ok(db.getSession('recent'), 'the record of what ran stays');
    assert.equal(db.sessionSizes(['recent']).recent ?? 0, 0);
  } finally {
    sizes.stop();
  }
});

test('sweep finishes old removals, forgets sizes of folders that are gone, and trims the log', { skip }, async () => {
  const { hk, sizes, checkout } = world();
  try {
    fs.mkdirSync(path.join(checkout, 'target.trash-1'));
    sizes.cache.set(path.join(checkout, 'vanished'), { bytes: 1, files: 1, mtime: 0, measuredAt: NOW });
    hk.store.log({ action: 'free', kind: 'build-cache', label: 'ancient', bytes: 1, at: NOW - 800 * DAY });
    hk.store.log({ action: 'free', kind: 'build-cache', label: 'recent', bytes: 1, at: NOW - DAY });
    const out = await hk.sweep();
    assert.equal(out.swept.length, 1);
    assert.equal(out.forgotten, 1);
    assert.ok(out.trimmed >= 1);
    assert.ok(!fs.existsSync(path.join(checkout, 'target.trash-1')));
    assert.equal(sizes.known(path.join(checkout, 'vanished')), null);
    assert.ok(hk.log().every((row) => row.label !== 'ancient'));
  } finally {
    sizes.stop();
  }
});

test('worktrees of a checkout under a root are items, their caches are nested, and removing one goes through git', { skip }, async () => {
  const { hk, db, sizes, checkout } = world();
  try {
    const sh = (cwd, args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
    fs.writeFileSync(path.join(checkout, 'README'), 'hi');
    sh(checkout, ['add', '-A']);
    sh(checkout, ['commit', '-q', '-m', 'init']);
    const wt = path.join(path.dirname(checkout), 'app-task');
    sh(checkout, ['worktree', 'add', '-q', '-b', 'task', wt]);
    fs.mkdirSync(path.join(wt, 'node_modules'));
    fs.writeFileSync(path.join(wt, 'node_modules', 'y.js'), 'q'.repeat(50));

    db.openSession({ id: 'inwt', profileId: 'p', profileName: 'Default', kind: 'claude', title: 'task work', startCwd: wt, startedAt: NOW - DAY, claudeSessionId: 'c-1' });
    db.db.prepare('UPDATE sessions SET ended_at = ?, last_active_at = ? WHERE id = ?').run(NOW - 3600_000, NOW - 3600_000, 'inwt');
    const inv = await hk.inventory();
    const tree = inv.items.find((one) => one.kind === 'worktree');
    assert.ok(tree, 'the worktree is listed');
    assert.equal(tree.meta.session?.id, 'inwt', 'the session that worked in it is named');
    assert.equal(tree.meta.session?.resumable, true);
    assert.equal(tree.meta.session?.live, false);
    assert.equal(tree.label, 'app/app-task');
    assert.deepEqual(tree.blockers, [], 'no commit of its own, clean: nothing to lose');
    const nested = inv.items.find((one) => one.kind === 'build-cache' && one.meta.checkout === fs.realpathSync(wt));
    assert.equal(nested?.meta.nested, true, 'a cache inside a listed worktree is counted once');
    assert.ok(inv.unsized.includes(tree.path));
    await hk.measure([tree.path]);
    const sized = (await hk.inventory()).items.find((one) => one.kind === 'worktree');
    assert.ok(sized.bytes >= 50);

    // A second worktree with a commit of its own and a change not committed: what the brief must name.
    const wb = path.join(path.dirname(checkout), 'app-brief');
    sh(checkout, ['worktree', 'add', '-q', '-b', 'brief', wb]);
    fs.writeFileSync(path.join(wb, 'work.txt'), 'w');
    sh(wb, ['add', '-A']);
    sh(wb, ['commit', '-q', '-m', 'task: first step']);
    fs.writeFileSync(path.join(wb, 'draft.txt'), 'd');
    const brief = await hk.worktreeBrief(wb);
    assert.match(brief, /# Worktree app-brief \(app\)/);
    assert.match(brief, /Nearest base: main, 1 commit ahead/);
    assert.match(brief, /Branch: brief/);
    assert.match(brief, /task: first step/);
    assert.match(brief, /\?\? draft\.txt/);
    assert.match(brief, /## Ask/);
    assert.match(brief, /open a pull request/);

    const out = await hk.removeWorktrees([tree.id]);
    assert.equal(out.results[0].ok, true, JSON.stringify(out.results[0]));
    assert.ok(!fs.existsSync(wt));
    assert.ok(hk.log().some((row) => row.action === 'remove-worktree' && row.ok));
  } finally {
    sizes.stop();
  }
});

test('the last inventory is kept and answers at once as a snapshot; quick actions run through the same checks', { skip }, async () => {
  const { hk, sizes } = world();
  try {
    assert.equal(hk.snapshot(), null, 'nothing kept yet');
    const inv = await hk.inventory();
    const snap = hk.snapshot();
    assert.equal(snap.items.length, inv.items.length);
    assert.equal(snap.stale, false);
    hk.last = null;
    const kept = hk.snapshot();
    assert.equal(kept.stale, true, 'from the store once the run forgot it');
    assert.equal(kept.items.length, inv.items.length);
    assert.ok(Array.isArray(kept.roots) && kept.roots.length === 1, 'roots are the list the panel maps over');
    assert.ok(Array.isArray(kept.log));
    assert.equal(typeof kept.checkouts, 'number');
    // An older snapshot that kept a count instead of the list is still answered in the panel's shape.
    hk.store.setSetting('last-inventory', { items: inv.items, totals: inv.totals, roots: 1, checkouts: '1', readAt: NOW });
    assert.ok(Array.isArray(hk.snapshot().roots));

    const events = [];
    hk.emit = (name, payload) => events.push([name, payload]);
    const backup = inv.items.find((one) => one.kind === 'db-backup');
    const out = await hk.act('free', [backup.id]);
    assert.equal(out.freed, 2048);
    const progress = events.filter(([name]) => name === 'progress').map(([, p]) => p);
    assert.ok(progress.some((p) => p.op === 'free' && !p.done && p.label === backup.label));
    assert.ok(progress.some((p) => p.op === 'free' && p.done && p.freed === 2048));
    await assert.rejects(hk.act('explode', []), /Not an action/);
    const folded = await hk.act('db-checkpoint', []);
    assert.equal(folded.results[0].ok, true);
  } finally {
    sizes.stop();
  }
});

test('roots must be folders, and checkouts are the root and its direct children that are git checkouts', { skip }, () => {
  const { hk, sizes, home, checkout } = world();
  try {
    assert.throws(() => hk.addRoot(path.join(home, 'missing')), /not a folder/);
    assert.throws(() => hk.addRoot('/'), /whole disk/);
    assert.throws(() => hk.addRoot(os.homedir()), /home folder/);
    assert.throws(() => hk.addRoot('~'), /home folder/);
    assert.deepEqual(hk.checkouts(), [checkout]);
    hk.removeRoot(path.dirname(checkout));
    assert.deepEqual(hk.checkouts(), []);
  } finally {
    sizes.stop();
  }
});
