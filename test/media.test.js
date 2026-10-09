'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serveMedia, pathFrom, rangeOf } = require('../electron/media');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-media-'));
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
fs.writeFileSync(path.join(dir, 'clip.mp4'), bytes);
fs.writeFileSync(path.join(dir, 'secret.env'), 'TOKEN=x');
fs.writeFileSync(path.join(dir, 'a b ñ.png'), bytes.subarray(0, 10));
const url = (name) => `media://file${path.join(dir, name).split('/').map(encodeURIComponent).join('/')}?v=1`;
const get = (name, headers = {}) => serveMedia({ url: url(name), headers: new Headers(headers) });

test('a media file is served whole, with its type and that it takes ranges', async () => {
  const res = await get('clip.mp4');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
});

test('a range is served as 206 with exactly those bytes, so a video can be scrubbed', async () => {
  const res = await get('clip.mp4', { range: 'bytes=100-199' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 100-199/1000');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(100, 200));
  assert.equal((await get('clip.mp4', { range: 'bytes=5000-' })).status, 416);
});

test('names with spaces and accents are found', async () => {
  assert.equal((await get('a b ñ.png')).status, 200);
});

test('anything that is not a media file is refused, whatever is asked', async () => {
  assert.equal((await get('secret.env')).status, 403);
  assert.equal((await get('missing.mp4')).status, 404);
  assert.equal((await serveMedia({ url: 'media://other/etc/hosts', headers: new Headers() })).status, 400);
  assert.equal(pathFrom('media://file/a/../../etc/passwd.png'), '/etc/passwd.png', 'normalised, and still only a .png');
});

test('ranges read the way browsers send them', () => {
  assert.deepEqual(rangeOf('bytes=0-', 10), { start: 0, end: 9 });
  assert.deepEqual(rangeOf('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(rangeOf('nonsense', 10), null);
});
