'use strict';

/**
 * Delivering what is queued, one at a time.
 *
 * A message is typed into a session's input box and the Return follows a beat
 * later, because Claude's box takes text and needs a separate submit. That gap
 * is the whole reason this has to be careful: anything else written into the
 * same box before the Return lands joins the first message rather than
 * following it.
 */

const test = require('node:test');
const assert = require('node:assert');
const { MessageBridge } = require('../electron/message-bridge');

/** The queue, with only the three things `flush` asks of it. */
function queue(rows) {
  const delivered = new Set();
  return {
    delivered,
    pending: () => rows.filter((row) => !delivered.has(row.id)),
    markDelivered: (ids) => ids.forEach((id) => delivered.add(id)),
  };
}

function bridge(rows, { free = () => true } = {}) {
  const written = [];
  const store = queue(rows);
  const it = new MessageBridge({
    socketPath: '/dev/null',
    reach: () => 'all',
    roster: () => [],
    write: (id, text) => { written.push([id, text]); return true; },
    isFree: free,
    store,
  });
  return { it, written, store };
}

/*
 * Two sessions both messaging a third while it is busy is ordinary — that is
 * what the queue is for. Both used to be typed into its box back to back, so
 * the first Return submitted the two of them mashed into one prompt and the
 * second submitted an empty line. Both were then marked delivered.
 */
test('two messages for one session are not typed into the same box', () => {
  const { it, written, store } = bridge([
    { id: 1, to: 'B', body: 'from A' },
    { id: 2, to: 'B', body: 'from C' },
  ]);
  const landed = it.flush();
  assert.deepEqual(written, [['B', 'from A']], 'only the first is typed');
  assert.deepEqual(landed, ['B']);
  assert.deepEqual([...store.delivered], [1], 'and only the first is called delivered');
});

test('the one held back goes out on the next pass', () => {
  const { it, written } = bridge([
    { id: 1, to: 'B', body: 'from A' },
    { id: 2, to: 'B', body: 'from C' },
  ]);
  it.flush();
  it.flush();
  assert.deepEqual(written, [['B', 'from A'], ['B', 'from C']]);
});

test('messages for different sessions still go together', () => {
  const { it, written } = bridge([
    { id: 1, to: 'B', body: 'one' },
    { id: 2, to: 'C', body: 'two' },
    { id: 3, to: 'D', body: 'three' },
  ]);
  assert.deepEqual(it.flush().sort(), ['B', 'C', 'D']);
  assert.equal(written.length, 3);
});

test('a session that is not free is not written to at all', () => {
  const { it, written, store } = bridge(
    [{ id: 1, to: 'B', body: 'one' }],
    { free: () => false },
  );
  assert.deepEqual(it.flush(), []);
  assert.deepEqual(written, []);
  assert.equal(store.delivered.size, 0, 'nothing queued is called delivered');
});
