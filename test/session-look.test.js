'use strict';

/*
 * A session's own text size and colour come back after a restart.
 *
 * They were sent with every save and nothing kept them, so every restart —
 * an update included — put every session back to the default size. Needs
 * `node:sqlite` (Node 22+) and skips itself without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';
const { Database } = sqlite ? require('../electron/database') : {};

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-look-')), 'test.db');
  return { file, db: new Database(file) };
}

test('a session keeps its size and colour across closing and reopening the database', { skip }, () => {
  const { file, db } = fresh();
  db.openSession({ id: 's1', profileId: 'p', profileName: 'Default', kind: 'shell', title: 'grande', startCwd: '/tmp', windowId: 'w' });
  db.openSession({ id: 's2', profileId: 'p', profileName: 'Default', kind: 'shell', title: 'plain', startCwd: '/tmp', windowId: 'w' });
  db.updateSession('s1', { fontSize: 16, color: '#f7768e' });
  db.close();

  const again = new Database(file);
  const rows = Object.fromEntries(again.sessionsForRestore(['s1', 's2'], 'w').map((row) => [row.id, row]));
  assert.equal(rows.s1.fontSize, 16);
  assert.equal(rows.s1.color, '#f7768e');
  assert.equal(rows.s2.fontSize, null, 'a session with no size of its own follows the app');
  assert.equal(rows.s2.color, null);
});

test('setting it back to the default is kept too', { skip }, () => {
  const { db } = fresh();
  db.openSession({ id: 's1', profileId: 'p', profileName: 'Default', kind: 'shell', title: 'x', startCwd: '/tmp', windowId: 'w' });
  db.updateSession('s1', { fontSize: 18 });
  db.updateSession('s1', { fontSize: null });
  assert.equal(db.sessionsForRestore(['s1'], 'w')[0].fontSize, null);
});
