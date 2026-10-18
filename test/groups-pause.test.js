'use strict';

/** A group's answer to "pause when minimized" survives the database: yes, no, or follow the app. */

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

test('pauseOnMinimize round-trips through saveGroups and allGroups', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-groups-'));
  const db = new Database(path.join(dir, 't.db'));
  db.saveGroups('w1', [
    { id: 'a', name: 'A', color: '#111', fontSize: null, arrangement: null, pauseOnMinimize: true },
    { id: 'b', name: 'B', color: '#222', fontSize: null, arrangement: null, pauseOnMinimize: false },
    { id: 'c', name: 'C', color: '#333', fontSize: null, arrangement: null },
  ]);
  const by = Object.fromEntries(db.allGroups().map((g) => [g.id, g.pauseOnMinimize]));
  assert.deepEqual(by, { a: true, b: false, c: null });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
