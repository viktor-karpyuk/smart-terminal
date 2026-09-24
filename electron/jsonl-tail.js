'use strict';
const fs = require('node:fs');

/**
 * Reading a growing JSONL file without reading it again.
 *
 * A Claude transcript is append-only and runs to tens of megabytes after a long
 * day. Two loops follow one — the snapshot every eight seconds, the monitor
 * every twenty — and both used to answer "what is new?" by reading the whole
 * file from byte zero and parsing every line of it. The cost of a tick was the
 * cost of the whole history, and the history grows all day, so the longer a
 * session ran the more it cost to keep following it. Over eight hours that is
 * hundreds of gigabytes read to follow a file of ninety megabytes.
 *
 * This is the one piece both of them were missing: the bytes past an offset.
 */

/**
 * Where a complete line last ended.
 *
 * The offset only ever advances past a `\n`, which is what makes reading from it
 * safe: a transcript is always mid-write, so the last line of any read is as
 * likely as not to be half of one, and the next read must begin where a record
 * begins. It also means every read starts on a character boundary — `\n` is one
 * byte in UTF-8 — so a multi-byte character can never be split across two reads.
 * A partial character at the *end* of a read lands in the held-back remainder
 * and is read again, whole, next time.
 */
function lastNewline(text) {
  return text.lastIndexOf('\n');
}

/**
 * The complete lines a file has gained since `offset`.
 *
 * Returns `null` when the file cannot be read at all — which for a live session
 * means "not yet", not "never", so callers keep their offset and try again.
 *
 * `restarted` says the file is not the one the offset belonged to: it shrank, so
 * it was rewritten or replaced, and everything before must be read again. A
 * caller that keeps state derived from earlier lines has to throw that away when
 * it sees this.
 *
 * @param {string} file
 * @param {number} offset byte offset a previous read stopped at
 * @returns {{ lines: string[], offset: number, restarted: boolean, size: number } | null}
 */
function linesSince(file, offset = 0) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }

  let from = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const restarted = from > size;
  if (restarted) from = 0;

  if (from === size) return { lines: [], offset: from, restarted, size };

  let text;
  const handle = (() => {
    try {
      return fs.openSync(file, 'r');
    } catch {
      return null;
    }
  })();
  if (handle === null) return null;
  try {
    const chunk = Buffer.allocUnsafe(size - from);
    const read = fs.readSync(handle, chunk, 0, chunk.length, from);
    text = (read === chunk.length ? chunk : chunk.subarray(0, read)).toString('utf8');
  } catch {
    return null;
  } finally {
    fs.closeSync(handle);
  }

  const end = lastNewline(text);
  // Nothing complete yet: a first line still being written. The offset stays put
  // and the whole thing is read again next time, which is the cheap case anyway.
  if (end < 0) return { lines: [], offset: from, restarted, size };

  const complete = text.slice(0, end);
  return {
    lines: complete.split('\n').filter((line) => line.trim()),
    // Counted in bytes, not characters: the file is addressed in bytes and a
    // transcript is full of text that is not ASCII.
    offset: from + Buffer.byteLength(text.slice(0, end + 1), 'utf8'),
    restarted,
    size,
  };
}

/**
 * The same thing, parsed.
 *
 * A line that does not parse is skipped rather than fatal: a transcript can hold
 * a row from a newer format than this one, and skipping it loses that row rather
 * than every row after it.
 *
 * @returns {{ rows: any[], offset: number, restarted: boolean, size: number } | null}
 */
function rowsSince(file, offset = 0) {
  const found = linesSince(file, offset);
  if (!found) return null;
  const rows = [];
  for (const line of found.lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a row this version does not understand */
    }
  }
  return { rows, offset: found.offset, restarted: found.restarted, size: found.size };
}

module.exports = { linesSince, rowsSince };
