'use strict';

/**
 * Following a conversation without reading it again.
 *
 * The snapshot loop used to read and parse the whole transcript every eight
 * seconds to find the few rows at the end of it, so the cost of a tick was the
 * cost of the whole history — and the history grows all day. It reads the tail
 * now, which only works if the sequence numbers still come out the same as a
 * full read would have produced. That is what is checked here, because a
 * sequence that drifts writes a conversation that reads back in the wrong order,
 * silently, days later.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ContextStore, transcriptPath } = require('../electron/context-store');

const CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** The database's side of the bargain, with the same rules as the real one. */
function fakeDb() {
  const rows = new Map(); // sessionId -> Map<seq, row>
  return {
    rows,
    calls: [],
    getSession: () => ({ claudeSessionId: CONV }),
    ingestTranscript(sessionId, lines, { from = 0 } = {}) {
      const held = rows.get(sessionId) ?? new Map();
      rows.set(sessionId, held);
      const next = held.size ? Math.max(...held.keys()) + 1 : 0;
      this.calls.push({ from, offered: lines.length });
      if (from > next) return -1;
      const start = next - from;
      if (start >= lines.length) return 0;
      for (let i = start; i < lines.length; i += 1) held.set(from + i, lines[i]);
      return lines.length - start;
    },
    textOf(sessionId) {
      const held = rows.get(sessionId) ?? new Map();
      return [...held.keys()].sort((a, b) => a - b).map((seq) => held.get(seq).text);
    },
  };
}

/** One user turn, as Claude Code writes it. */
const turn = (text) => `${JSON.stringify({ type: 'user', timestamp: '2026-09-23T10:00:00Z', message: { content: text } })}\n`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ingest-'));
  const configDir = path.join(root, 'account');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const coords = { configDir, cwd, claudeSessionId: CONV, record: true, withCommands: true };
  const file = transcriptPath(coords);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return { root, coords, file };
}

const made = [];
test.after(() => made.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function setup() {
  const { root, coords, file } = fixture();
  made.push(root);
  const db = fakeDb();
  const store = new ContextStore(db);
  store.track('s1', coords);
  return { store, db, file, coords };
}

test('a conversation read in pieces stores what reading it whole would', () => {
  const { store, db, file } = setup();
  const said = [];
  for (let i = 0; i < 40; i += 1) {
    said.push(`turn ${i}`);
    fs.appendFileSync(file, turn(`turn ${i}`));
    // A tick between every few turns, which is what the loop does.
    if (i % 3 === 0) store.ingestInto(db, 's1');
  }
  store.ingestInto(db, 's1');
  assert.deepEqual(db.textOf('s1'), said);
});

/*
 * The whole point. A tick that reads nothing new must cost nothing, and a tick
 * after one new turn must be handed one row — not the four hundred before it.
 */
test('a tick is only offered what arrived since the last one', () => {
  const { store, db, file } = setup();
  for (let i = 0; i < 400; i += 1) fs.appendFileSync(file, turn(`turn ${i}`));
  store.ingestInto(db, 's1');
  assert.equal(db.calls.at(-1).offered, 400, 'the first read is the whole file, once');

  db.calls.length = 0;
  store.ingestInto(db, 's1');
  assert.deepEqual(db.calls, [], 'nothing changed, so the database is not even asked');

  fs.appendFileSync(file, turn('one more'));
  store.ingestInto(db, 's1');
  assert.equal(db.calls.at(-1).offered, 1, 'one turn appeared, so one row is offered');
  assert.equal(db.calls.at(-1).from, 400, 'and it knows which row it is without having re-read the rest');
  assert.equal(db.textOf('s1').at(-1), 'one more');
});

test('a turn still being written waits for the next tick', () => {
  const { store, db, file } = setup();
  fs.appendFileSync(file, turn('finished'));
  fs.appendFileSync(file, '{"type":"user","message":{"content":"half a t');
  store.ingestInto(db, 's1');
  assert.deepEqual(db.textOf('s1'), ['finished']);

  fs.appendFileSync(file, 'urn"}}\n');
  store.ingestInto(db, 's1');
  assert.deepEqual(db.textOf('s1'), ['finished', 'half a turn'], 'and arrives whole, in its own place');
});

/*
 * A session restarted without its conversation gets a new, shorter file. Reading
 * on from the old offset would take the middle of the new conversation and file
 * it after the end of the old one.
 */
test('a transcript replaced by a shorter one is read from the start', () => {
  const { store, db, file } = setup();
  for (let i = 0; i < 10; i += 1) fs.appendFileSync(file, turn(`old ${i}`));
  store.ingestInto(db, 's1');

  fs.writeFileSync(file, turn('new one'));
  store.ingestInto(db, 's1');
  assert.equal(db.calls.at(-1).from, 0, 'nothing counted before means anything now');
});

/*
 * Dropping command output changes which rows exist, and therefore what every
 * later row's number means. Continuing the old count would interleave two
 * different numberings of the same conversation.
 */
test('changing what is kept starts the numbering again', () => {
  const { store, db, file } = setup();
  for (let i = 0; i < 5; i += 1) fs.appendFileSync(file, turn(`turn ${i}`));
  store.ingestInto(db, 's1');

  store.setCommandOutput(false);
  fs.appendFileSync(file, turn('after the change'));
  store.ingestInto(db, 's1');
  assert.equal(db.calls.at(-1).from, 0, 'the whole conversation is offered again under the new terms');
  assert.equal(db.textOf('s1').at(-1), 'after the change');
});

/*
 * The offset says row 400 comes next; the database holds none. Writing from 400
 * would leave four hundred empty places that nothing later ever fills.
 */
test('a database that lost the rows makes the reader start again', () => {
  const { store, db, file } = setup();
  for (let i = 0; i < 20; i += 1) fs.appendFileSync(file, turn(`turn ${i}`));
  store.ingestInto(db, 's1');
  db.rows.clear();

  fs.appendFileSync(file, turn('after the loss'));
  store.ingestInto(db, 's1');
  store.ingestInto(db, 's1');
  assert.equal(db.textOf('s1').length, 21, 'everything is offered again rather than written into a hole');
  assert.equal(db.textOf('s1')[0], 'turn 0');
});

test('a transcript that is not there yet is not an error', () => {
  const { store, db, file } = setup();
  fs.rmSync(file);
  assert.equal(store.ingestInto(db, 's1'), 0);
});
