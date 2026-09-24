'use strict';

/**
 * What a launch is allowed to throw away.
 *
 * Every test here is a way the app used to lose something that belonged to
 * somebody: a tab carried across restarts erased by the tidy-up meant for
 * history, the conversation a tab held forgotten by a restart, a paused session
 * that could never be picked up again. They are grouped because they share one
 * cause — `openSession` and `prune` both treat "this row exists" as "this row is
 * finished with", and a session that is still being used is neither.
 *
 * Needs `node:sqlite` (Node 22+) and skips itself without it.
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
const { Database } = sqlite ? require('../electron/database') : {};

const DAY = 24 * 60 * 60 * 1000;
const made = [];
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-lifecycle-'));
  made.push(dir);
  return new Database(path.join(dir, 'test.db'));
}

function open(db, id, startedAt, extra = {}) {
  db.openSession({
    id,
    profileId: 'p',
    profileName: 'Default',
    kind: 'claude',
    title: id,
    startCwd: '/tmp',
    startedAt,
    ...extra,
  });
}

/** What `main.js` does on every launch, in that order. */
function launch(db) {
  const crashed = db.closeStaleSessions();
  return { crashed, pruned: db.prune({ keep: crashed }) };
}

// ------------------------------------------------------- carrying a tab across

/*
 * The one that loses work.
 *
 * A tab you keep open is `ended_at IS NULL` at every shutdown, so every launch
 * stamps it closed — and the prune two lines later erases anything closed that
 * is old enough. The tab, its stored conversation, its brief and its handoffs
 * all went in one launch, and the renderer then wrote the pruned layout back.
 */
test('a tab carried across restarts is not erased for being old', { skip }, () => {
  const db = fresh();
  open(db, 'carried', Date.now() - 120 * DAY);
  const { crashed, pruned } = launch(db);
  assert.deepEqual(crashed, ['carried'], 'it was open, so the launch stamps it');
  assert.deepEqual(pruned, [], 'and the tidy-up leaves it alone');
  assert.ok(db.getSession('carried'), 'the session is still there');
});

test('a tab carried across restarts survives a thousand newer sessions', { skip }, () => {
  const db = fresh();
  open(db, 'carried', Date.now() - 30 * DAY);
  for (let i = 0; i < 1100; i += 1) {
    open(db, `n${i}`, Date.now() - 1000 + i);
    db.endSession(`n${i}`, 0);
  }
  const { pruned } = launch(db);
  assert.ok(!pruned.includes('carried'), 'the newest-rows ceiling is not a reason to drop a live tab');
  assert.ok(db.getSession('carried'));
});

/*
 * Old history is still swept — the guard is for tabs being carried, not an
 * excuse to keep everything for ever.
 */
test('history that really is finished with is still swept', { skip }, () => {
  const db = fresh();
  open(db, 'ancient', Date.now() - 200 * DAY);
  db.endSession('ancient', 0);
  db.db.prepare('UPDATE sessions SET ended_at = ?, last_active_at = ? WHERE id = ?')
    .run(Date.now() - 200 * DAY, Date.now() - 200 * DAY, 'ancient');
  const { pruned } = launch(db);
  assert.deepEqual(pruned, ['ancient']);
  assert.equal(db.getSession('ancient'), null);
});

/*
 * "Old" is when it was last worked in, not when it was first opened. A tab open
 * for three months that you talked to this morning is the last thing anybody
 * wants dropped.
 */
test('a long-lived session used this morning counts as recent', { skip }, () => {
  const db = fresh();
  open(db, 'long', Date.now() - 200 * DAY);
  db.noteWork('long', Date.now());
  db.endSession('long', 0);
  assert.deepEqual(db.prune(), [], 'worked in today, so not history yet');
});

// -------------------------------------------------------- what a restart keeps

/*
 * A shell tab somebody started Claude in by hand is bound to its conversation
 * after the fact. A plain restart passes no conversation, and a straight
 * assignment wrote that null over the binding — so the tab could no longer be
 * resumed, recording stopped, and the adoption sweep was free to bind it to
 * whatever transcript in that folder was newest.
 */
test('restarting a session keeps the conversation it was adopted onto', { skip }, () => {
  const db = fresh();
  open(db, 's', Date.now(), { kind: 'shell' });
  db.updateSession('s', { claudeSessionId: 'C1' });
  assert.equal(db.getSession('s').claudeSessionId, 'C1');

  open(db, 's', Date.now(), { kind: 'shell' });
  assert.equal(db.getSession('s').claudeSessionId, 'C1', 'a restart that names none keeps the one it had');
});

test('a restart that names a different conversation is still obeyed', { skip }, () => {
  const db = fresh();
  open(db, 's', Date.now(), { claudeSessionId: 'C1' });
  open(db, 's', Date.now(), { claudeSessionId: 'C2' });
  assert.equal(db.getSession('s').claudeSessionId, 'C2');
});

/*
 * Picking a session back up is what un-pauses it. Nothing ever called the method
 * that cleared the flag, so every session ever paused came back as a dead paused
 * tab on every launch after — for ever.
 */
test('picking a paused session back up un-pauses it', { skip }, () => {
  const db = fresh();
  open(db, 's', Date.now());
  db.pauseSession('s');
  assert.equal(db.getSession('s').paused, true);

  open(db, 's', Date.now());
  const back = db.getSession('s');
  assert.equal(back.paused, false, 'it is running again, so it is not paused');
  assert.equal(back.endedAt, null);
});
