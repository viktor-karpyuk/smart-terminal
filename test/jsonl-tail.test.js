'use strict';

/**
 * Reading only what a growing file gained.
 *
 * The whole point of this module is that a caller can trust the offset it gets
 * back, so what is tested is the awkward middle of a live append: a half-written
 * last line, a multi-byte character across a read boundary, a file replaced by a
 * shorter one. Those are the cases that turn "read the tail" into "lose a row".
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { linesSince, rowsSince } = require('../electron/jsonl-tail');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tail-'));
let n = 0;
const write = (body) => {
  const file = path.join(dir, `t${(n += 1)}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
};

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('from nothing, every line', () => {
  const file = write('{"a":1}\n{"a":2}\n');
  const got = linesSince(file, 0);
  assert.deepEqual(got.lines, ['{"a":1}', '{"a":2}']);
  assert.equal(got.offset, 16);
  assert.equal(got.restarted, false);
});

test('from the end, nothing — and the same offset back', () => {
  const file = write('{"a":1}\n');
  const got = linesSince(file, 8);
  assert.deepEqual(got.lines, []);
  assert.equal(got.offset, 8);
});

test('only what was appended', () => {
  const file = write('{"a":1}\n');
  const first = linesSince(file, 0);
  fs.appendFileSync(file, '{"a":2}\n{"a":3}\n');
  const second = linesSince(file, first.offset);
  assert.deepEqual(second.lines, ['{"a":2}', '{"a":3}'], 'the first line is not read twice');
});

/*
 * The case that matters: a transcript is always mid-write, so the last line of
 * any read is as likely as not to be half of one. Advancing past it would lose
 * the row; returning it would hand the caller broken JSON.
 */
test('a half-written last line is held back, and arrives whole next time', () => {
  const file = write('{"a":1}\n{"a":2');
  const first = linesSince(file, 0);
  assert.deepEqual(first.lines, ['{"a":1}']);
  assert.equal(first.offset, 8, 'the offset stops at the last complete line');

  fs.appendFileSync(file, '}\n');
  const second = linesSince(file, first.offset);
  assert.deepEqual(second.lines, ['{"a":2}'], 'the held-back line comes back complete');
});

test('a first line still being written yields nothing and moves nothing', () => {
  const file = write('{"a":1');
  const got = linesSince(file, 0);
  assert.deepEqual(got.lines, []);
  assert.equal(got.offset, 0);
});

/*
 * Offsets are bytes and transcripts are full of text that is not ASCII. Counting
 * characters would drift the offset a little further from the truth with every
 * accented word, and a drifting offset eventually starts a read mid-record.
 */
test('offsets are bytes, not characters', () => {
  const body = '{"t":"árbol — ñandú 🌲"}\n{"t":"next"}\n';
  const file = write(body);
  const first = linesSince(file, 0);
  assert.equal(first.lines.length, 2);
  assert.equal(first.offset, Buffer.byteLength(body, 'utf8'));
});

test('a multi-byte character split across two reads survives', () => {
  const file = write('{"t":"a"}\n');
  const first = linesSince(file, 0);
  // Written in two goes, splitting the emoji's four bytes down the middle.
  const rest = Buffer.from('{"t":"🌲"}\n', 'utf8');
  fs.appendFileSync(file, rest.subarray(0, 9));
  const mid = linesSince(file, first.offset);
  assert.deepEqual(mid.lines, [], 'half a line is not a line');
  assert.equal(mid.offset, first.offset);

  fs.appendFileSync(file, rest.subarray(9));
  const done = linesSince(file, mid.offset);
  assert.deepEqual(JSON.parse(done.lines[0]), { t: '🌲' });
});

/*
 * A session restarted without its conversation gets a new, shorter file under a
 * different name — and a caller holding rows from the old one must be told, or
 * it will append the new conversation to the end of the old one.
 */
test('a file that shrank is read from the start, and says so', () => {
  const file = write('{"a":1}\n{"a":2}\n{"a":3}\n');
  const first = linesSince(file, 0);
  fs.writeFileSync(file, '{"b":1}\n');
  const second = linesSince(file, first.offset);
  assert.equal(second.restarted, true);
  assert.deepEqual(second.lines, ['{"b":1}']);
  assert.equal(second.offset, 8);
});

test('a file that is not there is not an error, it is not yet', () => {
  assert.equal(linesSince(path.join(dir, 'nope.jsonl'), 0), null);
});

test('blank lines are not lines', () => {
  const file = write('{"a":1}\n\n\n{"a":2}\n');
  assert.deepEqual(linesSince(file, 0).lines, ['{"a":1}', '{"a":2}']);
});

test('rowsSince parses, and skips what it cannot', () => {
  const file = write('{"a":1}\nnot json\n{"a":2}\n');
  const got = rowsSince(file, 0);
  assert.deepEqual(got.rows, [{ a: 1 }, { a: 2 }], 'a row from a newer format loses itself, not the rest');
  assert.equal(got.offset, fs.statSync(file).size);
});

/*
 * The property the callers actually rely on: reading a file in any number of
 * steps sees exactly what reading it in one step would, in the same order.
 */
test('reading in pieces sees the same rows as reading in one go', () => {
  const file = path.join(dir, 'grow.jsonl');
  fs.writeFileSync(file, '');
  const written = [];
  for (let i = 0; i < 200; i += 1) written.push({ i, pad: 'ó'.repeat(i % 17) });

  let offset = 0;
  const seen = [];
  let at = 0;
  while (at < written.length) {
    // Uneven bites, and sometimes stopping mid-line.
    const take = written.slice(at, at + ((at % 7) + 1));
    at += take.length;
    let text = `${take.map((row) => JSON.stringify(row)).join('\n')}\n`;
    if (at % 3 === 0 && at < written.length) text = text.slice(0, -1);
    fs.appendFileSync(file, text);
    if (!text.endsWith('\n')) fs.appendFileSync(file, '\n');
    const got = rowsSince(file, offset);
    offset = got.offset;
    seen.push(...got.rows);
  }
  assert.deepEqual(seen, written);
  assert.deepEqual(rowsSince(file, 0).rows, written);
});
