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
  fs.mkdirSync(path.join(checkout, 'node_modules'));
  fs.writeFileSync(path.join(checkout, 'node_modules', 'x.js'), 'q'.repeat(700));

  const forgotten = [];
  const context = { trackedIds: () => ['live'], forget: (id) => forgotten.push(id), setRecording: () => {} };
  const hk = new Housekeeping({ db, store, sizes, userData, context, live: () => [], now: () => NOW, review: null, browser: { size: async () => 777, clear: async () => {} } });
  hk.addRoot(roots);
  return { hk, db, sizes, userData, home, checkout, forgotten };
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

    const cache = first.items.find((one) => one.kind === 'build-cache');
    assert.equal(cache.meta.sized, false, 'not walked yet');
    assert.ok(first.unsized.includes(cache.path));

    const measured = await hk.measure([...first.unsized, old.path]);
    assert.equal(measured[cache.path], 700);
    assert.equal(measured[old.path], undefined, 'a session\'s working folder is never walked');
    const second = await hk.inventory();
    assert.equal(second.items.find((one) => one.kind === 'build-cache').bytes, 700);
    assert.equal(second.items.find((one) => one.kind === 'install-backup').bytes, 4096);
    assert.equal(second.totals.all.reversibleBytes, 700 + 4096 + 2048 + 100 + 200 + 10 + 777);

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

    const kept = hk.forgetTranscripts(['recent']);
    assert.equal(kept.count, 1);
    assert.equal(kept.bytes, 250);
    assert.ok(db.getSession('recent'), 'the record of what ran stays');
    assert.equal(db.sessionSizes(['recent']).recent ?? 0, 0);
  } finally {
    sizes.stop();
  }
});

test('roots must be folders, and checkouts are the root and its direct children that are git checkouts', { skip }, () => {
  const { hk, sizes, home, checkout } = world();
  try {
    assert.throws(() => hk.addRoot(path.join(home, 'missing')), /not a folder/);
    assert.deepEqual(hk.checkouts(), [checkout]);
    hk.removeRoot(path.dirname(checkout));
    assert.deepEqual(hk.checkouts(), []);
  } finally {
    sizes.stop();
  }
});
