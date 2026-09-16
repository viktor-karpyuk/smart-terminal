'use strict';

/**
 * What the history is ordered by, and what that date is.
 *
 * "When did I last work on this" is the question the list exists to answer, and
 * every obvious answer to it is wrong. *Started* is wrong because a session that
 * has been open for a week started a week ago. *Open first* is wrong because a
 * tab left open five days ago and never touched since is not more current than
 * the one you were talking to last night. And the row's own `last_active_at` is
 * wrong because it moves whenever anything about a session is written down —
 * restoring thirty-nine tabs at startup writes to thirty-nine rows, and they all
 * come to read as touched this minute.
 *
 * Measured, not assumed: on a real database every open session claimed 14:02
 * that afternoon, while the last thing actually said in them ranged from that
 * morning back to nine days earlier.
 *
 * So there is a column written by work alone, and these are the rules for it.
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

// Required only when it can be: `database.js` reaches for `node:sqlite` as it
// loads, so on Node 20 even naming it throws, and the file would fail as a whole
// rather than skipping the tests inside it.
const { Database } = sqlite ? require('../electron/database') : {};

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 8, 15, 12, 0, 0);

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-history-'));
  const db = new Database(path.join(dir, 'test.db'));
  return { db, dir };
}

/** A session as `openSession` records one, with only what these tests read. */
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

const order = (db) => db.listSessions({}).map((row) => row.id);

// ---------------------------------------------------------------- the order

/*
 * The bug, stated as a test. Both sessions are open; one was last used this
 * morning and the other five days ago. Under the old ordering they were tied on
 * "still running" and fell back to when they started, which put the stale one
 * first for having been opened more recently.
 */
test('a session worked on today comes before one opened later and never touched', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 'stale', now - 5 * DAY);
    open(db, 'busy', now - 6 * DAY);
    db.noteWork('stale', now - 5 * DAY);
    db.noteWork('busy', now - 2 * 60 * 60 * 1000);

    assert.deepStrictEqual(order(db), ['busy', 'stale']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('being open is no longer a place in the order', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 'open-but-idle', now - 5 * DAY);
    db.noteWork('open-but-idle', now - 5 * DAY);

    open(db, 'closed-yesterday', now - 3 * DAY);
    db.noteWork('closed-yesterday', now - DAY);
    db.endSession('closed-yesterday', 0);

    // The finished one was worked on a day ago; the open one, five days ago.
    assert.strictEqual(order(db)[0], 'closed-yesterday');
    assert.strictEqual(db.listSessions({})[0].open, false, 'and it is still reported as finished');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sessions come back in order, whatever order they happened in', { skip }, () => {
  const { db, dir } = fresh();
  try {
    const days = [9, 1, 4, 0, 7];
    days.forEach((ago, i) => {
      open(db, `s${i}`, now - 30 * DAY);
      db.noteWork(`s${i}`, now - ago * DAY);
    });
    assert.deepStrictEqual(order(db), ['s3', 's1', 's2', 's4', 's0']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- what counts as work

/*
 * The rule that keeps a late reading from rewriting history. A conversation is
 * ingested minutes after the fact and, when one is adopted, days after it — so a
 * session used an hour ago must not be dragged back to last week by something
 * old arriving late.
 */
test('work only ever moves forward', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 's', now - 10 * DAY);
    db.noteWork('s', now - DAY);
    db.noteWork('s', now - 8 * DAY);
    assert.strictEqual(db.getSession('s').lastWorkedAt, now - DAY);

    db.noteWork('s', now);
    assert.strictEqual(db.getSession('s').lastWorkedAt, now);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nonsense is not a time and does not become one', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 's', now - DAY);
    db.noteWork('s', now - DAY);
    for (const bad of [null, NaN, 'yesterday', Infinity]) db.noteWork('s', bad);
    assert.strictEqual(db.getSession('s').lastWorkedAt, now - DAY);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * Asking without a time means now, which is what the keystroke path does — it
 * has nothing more specific to say than "somebody is typing in this, currently".
 */
test('no time at all means this moment', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 's', now - DAY);
    const before = Date.now();
    db.noteWork('s');
    const at = db.getSession('s').lastWorkedAt;
    assert.ok(at >= before && at <= Date.now());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * A turn carries the time it happened, and that is the time that counts. Using
 * the moment it was read would put every adopted conversation at "now" and lose
 * the very thing the list is sorted by.
 */
test('a conversation is dated by when it was said, not by when it was read', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 's', now - 10 * DAY);
    db.ingestTranscript('s', [
      { at: now - 4 * DAY, role: 'user', text: 'morning' },
      { at: now - 3 * DAY, role: 'assistant', text: 'afternoon' },
    ]);
    assert.strictEqual(db.getSession('s').lastWorkedAt, now - 3 * DAY, 'the last message, not this moment');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a conversation with no times on it leaves the date alone', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 's', now - DAY);
    db.noteWork('s', now - DAY);
    db.ingestTranscript('s', [{ at: null, role: 'user', text: 'no time on this' }]);
    assert.strictEqual(db.getSession('s').lastWorkedAt, now - DAY);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- what the row says

test('the row carries the date, so the panel does not have to work it out', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 's', now - DAY);
    db.noteWork('s', now - 3600_000);
    const row = db.listSessions({})[0];
    assert.strictEqual(row.lastWorkedAt, now - 3600_000);
    assert.strictEqual(row.startedAt, now - DAY, 'and still says when it was opened');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * Nothing stored and never finished: there is no honest answer but "opened
 * then", and the list still has to put it somewhere rather than dropping it.
 */
test('a session with nothing recorded falls back to when it was opened', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 'nothing', now - 2 * DAY);
    open(db, 'worked', now - 9 * DAY);
    db.noteWork('worked', now - DAY);
    assert.deepStrictEqual(order(db), ['worked', 'nothing']);
    assert.strictEqual(db.listSessions({})[1].lastWorkedAt, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- a name beats a mention

/*
 * The search looks inside conversations as well, which is most of what makes it
 * worth having — and is also why typing a session's name returned a hundred rows
 * with the one you meant somewhere in the middle. Measured on a real history:
 * "ausencias" gave 118 results with the session actually named that at position
 * 2, and "user-permissions" gave 65 with it at position 4. From the other side
 * of the screen that is a search that does not search by name.
 */

/** A session with a conversation that mentions the word without being named it. */
function mentions(db, id, text, at) {
  open(db, id, at, { title: id });
  db.ingestTranscript(id, [{ at, role: 'user', text }]);
  db.updateSession(id, { storeTranscript: true });
}

test('the session named for what you typed comes first', { skip }, () => {
  const { db, dir } = fresh();
  try {
    // Three that only mention it, and are more recent than the one that is it.
    mentions(db, 'talks-about-it-1', 'we should look at ausencias again', now - 60_000);
    mentions(db, 'talks-about-it-2', 'the ausencias report is wrong', now - 30_000);
    open(db, 'ausencias', now - 9 * DAY, { title: 'ausencias' });
    db.noteWork('ausencias', now - 9 * DAY);

    const found = db.listSessions({ query: 'ausencias' }).map((row) => row.title);
    assert.strictEqual(found[0], 'ausencias', 'the name, even though it is nine days older');
    assert.ok(found.length > 1, 'and the mentions are still there, below it');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a name that starts with it beats a name that merely contains it', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 'a', now, { title: 'my-TLB-thing' });
    db.noteWork('a', now);
    open(db, 'b', now - DAY, { title: 'TLB-projects' });
    db.noteWork('b', now - DAY);
    open(db, 'c', now - 2 * DAY, { title: 'TLB' });
    db.noteWork('c', now - 2 * DAY);

    assert.deepStrictEqual(
      db.listSessions({ query: 'TLB' }).map((row) => row.title),
      ['TLB', 'TLB-projects', 'my-TLB-thing'],
      'exactly it, then starting with it, then containing it — and the newest of them last',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('where it was and whose account it was on still match, below the names', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 'by-folder', now, { title: 'nothing like it', startCwd: '/work/billing' });
    db.noteWork('by-folder', now);
    open(db, 'by-name', now - DAY, { title: 'billing' });
    db.noteWork('by-name', now - DAY);

    assert.deepStrictEqual(
      db.listSessions({ query: 'billing' }).map((row) => row.title),
      ['billing', 'nothing like it'],
      'the name first, then the folder — though the folder one was worked on more recently',
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with nothing typed the order is untouched: whatever was worked on last', { skip }, () => {
  const { db, dir } = fresh();
  try {
    open(db, 'older', now - 30 * DAY, { title: 'older' });
    db.noteWork('older', now - 5 * DAY);
    open(db, 'newer', now - 30 * DAY, { title: 'newer' });
    db.noteWork('newer', now - DAY);
    assert.deepStrictEqual(db.listSessions({}).map((row) => row.title), ['newer', 'older']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
