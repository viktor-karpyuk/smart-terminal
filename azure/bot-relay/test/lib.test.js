'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessages, decode } = require('../scripts/lib');

test('reads the fields out of the Queue service XML, unescaped', () => {
  const xml = '<?xml version="1.0"?><QueueMessagesList><QueueMessage><MessageId>m1</MessageId>' +
    '<PopReceipt>AgAAAA&amp;x==</PopReceipt><MessageText>eyJhIjoxfQ==</MessageText></QueueMessage>' +
    '<QueueMessage><MessageId>m2</MessageId><PopReceipt>p2</PopReceipt><MessageText>{&quot;a&quot;:2}</MessageText></QueueMessage></QueueMessagesList>';
  const [one, two] = parseMessages(xml);
  assert.deepEqual(one, { id: 'm1', popReceipt: 'AgAAAA&x==', text: 'eyJhIjoxfQ==' });
  assert.equal(two.id, 'm2');
  assert.deepEqual(decode(one.text), { a: 1 });
  assert.deepEqual(decode(two.text), { a: 2 });
});

test('an empty queue is no messages', () => {
  assert.deepEqual(parseMessages('<QueueMessagesList />'), []);
});
