'use strict';

/**
 * An image pasted into a terminal.
 *
 * A terminal cannot carry a picture — the thing on the other end of the pty
 * reads bytes — so what is pasted is a path, and what makes that work is this:
 * the clipboard says what it holds, the bytes are written down, and the name
 * says when. Tested because "it did nothing" is exactly what the bug looked
 * like before, and a silent failure is the same shape as a silent success.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { savePastedImage, pastedImageName, imageExtension, forgetOldPastes } = require('../electron/files');

/** The smallest real PNG there is: one transparent pixel. */
const ONE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pasted-test-'));
}

test('the clipboard decides the extension, not a guess about the bytes', () => {
  assert.equal(imageExtension('image/png'), '.png');
  assert.equal(imageExtension('image/JPEG'), '.jpg');
  assert.equal(imageExtension('image/webp'), '.webp');
  assert.equal(imageExtension('text/plain'), null);
  assert.equal(imageExtension(''), null);
  assert.equal(imageExtension(undefined), null);
});

test('the name says when, and sorts that way', () => {
  const at = Date.parse('2026-09-09T04:17:42.087Z');
  assert.equal(pastedImageName('image/png', at), 'pasted-2026-09-09T04-17-42-087Z.png');
  const later = pastedImageName('image/png', at + 1000);
  assert.ok(later > pastedImageName('image/png', at), 'a later paste sorts after an earlier one');
});

test('a real image is written where it can be read back', async () => {
  const dir = scratch();
  const saved = await savePastedImage(dir, ONE_PIXEL, 'image/png');
  assert.equal(saved.ok, true);
  assert.equal(saved.bytes, ONE_PIXEL.length);
  const back = await fsp.readFile(saved.file);
  assert.deepEqual(back, ONE_PIXEL, 'byte for byte, or it is not the image that was copied');
  assert.match(path.basename(saved.file), /^pasted-.*\.png$/);
});

test('the folder is made if it is not there', async () => {
  const dir = path.join(scratch(), 'nested', 'pasted');
  const saved = await savePastedImage(dir, ONE_PIXEL, 'image/png');
  assert.equal(saved.ok, true);
  assert.ok(fs.existsSync(saved.file));
});

test('what is not an image is refused, and says so', async () => {
  const dir = scratch();
  const refused = await savePastedImage(dir, Buffer.from('hello'), 'text/plain');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not an image/);
  const empty = await savePastedImage(dir, Buffer.alloc(0), 'image/png');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/);
});

test('old pastes are forgotten, recent ones are not', async () => {
  const dir = scratch();
  const old = await savePastedImage(dir, ONE_PIXEL, 'image/png');
  const fresh = await savePastedImage(dir, ONE_PIXEL, 'image/jpeg');
  // Age the first one by a fortnight.
  const long = Date.now() - 14 * 24 * 60 * 60 * 1000;
  fs.utimesSync(old.file, new Date(long), new Date(long));
  // And something that is not ours, which must survive whatever its date.
  const theirs = path.join(dir, 'notes.txt');
  fs.writeFileSync(theirs, 'mine');
  fs.utimesSync(theirs, new Date(long), new Date(long));

  const gone = await forgetOldPastes(dir, { days: 7 });
  assert.equal(gone, 1);
  assert.equal(fs.existsSync(old.file), false);
  assert.equal(fs.existsSync(fresh.file), true);
  assert.equal(fs.existsSync(theirs), true, 'only what this wrote is this to delete');
});

test('a folder that is not there is not an error', async () => {
  assert.equal(await forgetOldPastes(path.join(os.tmpdir(), 'no-such-pasted-dir-here')), 0);
});
