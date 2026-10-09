'use strict';

/**
 * The `media:` scheme: a picture, a video, a sound or a PDF from disk, served
 * to the app's own window so it can be shown as itself.
 *
 * Served rather than read into the renderer, because a video is gigabytes and
 * a player reads it a range at a time while you scrub. Only files whose
 * extension is one of the formats listed — never a text file, a key or a
 * database — and only absolute paths, so this is not a way to read anything
 * else off the disk. Extension panels cannot reach it: their own policy allows
 * no network and no schemes at all.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', avif: 'image/avif', apng: 'image/apng',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm',
  pdf: 'application/pdf',
};

const text = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

/** media://file/<absolute path, each part URL-encoded> */
function pathFrom(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'file') return null;
  const decoded = parsed.pathname.split('/').map((part) => decodeURIComponent(part)).join('/');
  if (!path.isAbsolute(decoded) || decoded.includes('\0')) return null;
  return path.normalize(decoded);
}

/** A byte range from a Range header, or null for the whole file. */
function rangeOf(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match) return null;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) return null;
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

async function serveMedia(request) {
  const file = pathFrom(request.url);
  if (!file) return text(400, 'not a media address');
  const type = TYPES[path.extname(file).slice(1).toLowerCase()];
  if (!type) return text(403, 'not a media file');
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return text(404, 'not there');
  }
  if (!stat.isFile()) return text(404, 'not a file');

  const range = rangeOf(request.headers.get('range'), stat.size);
  if (range?.invalid) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-length': String(stat.size ? end - start + 1 : 0),
    'cache-control': 'no-cache',
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  const body = stat.size ? Readable.toWeb(fs.createReadStream(file, { start, end })) : null;
  return new Response(body, { status: range ? 206 : 200, headers });
}

module.exports = { serveMedia, pathFrom, rangeOf, TYPES };
