'use strict';

/**
 * Unpacking an extension somebody else wrote.
 *
 * A tarball from a repository is the one input in this app that arrives from a
 * stranger and gets written to disk, so it is read here by hand rather than by a
 * general-purpose tar: a general tool does everything tar can, and most of what
 * tar can do is exactly what an extension must not. What is let through is
 * ordinary files and folders, inside the extension's own folder, within sizes
 * an extension has any reason to be. Links of either kind, devices, absolute
 * paths and `..` are refused outright rather than cleaned up, because an archive
 * that contains one was not made by accident.
 *
 * Nothing is written executable. An extension is text the app reads; it has no
 * business shipping a program.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const LIMITS = {
  /** What is downloaded, before unpacking. */
  compressed: 10 * 1024 * 1024,
  /** Everything unpacked, together. */
  total: 25 * 1024 * 1024,
  /** Any one file. */
  file: 10 * 1024 * 1024,
  files: 2000,
};

class ArchiveError extends Error {}

const text = (buf, start, length) => {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
};

function octal(buf, start, length) {
  if (buf[start] & 0x80) throw new ArchiveError('the archive uses a size format no extension needs');
  const raw = text(buf, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new ArchiveError('the archive has a header that is not a number');
  return parseInt(raw, 8);
}

function checksumOk(header) {
  const stored = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === stored;
}

/** `key=value` records, each prefixed with its own length. */
function paxRecords(body) {
  const records = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const length = parseInt(body.subarray(at, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return records;
}

/**
 * The entries of a tar, as { name, type, data }, with nothing written anywhere.
 * Also returns the pax global comment, where `git archive` records the commit.
 */
function readTar(tar, limits = LIMITS) {
  const entries = [];
  let comment = null;
  let pax = null;
  let longName = null;
  let total = 0;
  let at = 0;

  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new ArchiveError('the archive is damaged');
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const bodyStart = at + 512;
    const body = tar.subarray(bodyStart, bodyStart + size);
    if (body.length < size) throw new ArchiveError('the archive ends in the middle of a file');
    at = bodyStart + Math.ceil(size / 512) * 512;

    if (type === 'g') {
      comment = paxRecords(body).comment ?? comment;
      continue;
    }
    if (type === 'x') {
      pax = paxRecords(body);
      continue;
    }
    if (type === 'L') {
      longName = text(body, 0, body.length);
      continue;
    }

    const prefix = text(header, 345, 155);
    let name = pax?.path ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    pax = null;
    longName = null;

    if (type === '1' || type === '2') throw new ArchiveError(`the archive contains a link (${name}), which an extension has no use for`);
    if (type !== '0' && type !== '5' && type !== '7') throw new ArchiveError(`the archive contains something that is not a file or a folder (${name})`);

    name = name.replace(/\/+$/, '');
    if (!name) continue;
    if (type !== '5') {
      if (size > limits.file) throw new ArchiveError(`${name} is larger than an extension file may be`);
      total += size;
      if (total > limits.total) throw new ArchiveError('the extension is larger unpacked than an extension may be');
    }
    entries.push({ name, type: type === '5' ? 'dir' : 'file', data: type === '5' ? null : Buffer.from(body) });
    if (entries.length > limits.files) throw new ArchiveError('the archive has more files than an extension may have');
  }
  return { entries, comment };
}

/** A path inside the archive, made safe or refused. Returns null for the top folder itself. */
function safeRelative(name, { strip = 1, subdir = '' } = {}) {
  if (name.includes('\0') || name.includes('\\')) throw new ArchiveError(`the archive has a name no file should have (${name})`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new ArchiveError(`the archive has an absolute path (${name})`);
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) throw new ArchiveError(`the archive reaches outside itself (${name})`);
  let rest = parts.slice(strip);
  if (subdir) {
    const want = subdir.split('/').filter(Boolean);
    if (want.some((part) => part === '..' || part === '.')) throw new ArchiveError('the extension path is not a plain folder');
    if (rest.length < want.length || want.some((part, i) => rest[i] !== part)) return undefined;
    rest = rest.slice(want.length);
  }
  return rest.length ? rest.join('/') : null;
}

/**
 * Unpack a .tar.gz into `dest`, which must not exist yet.
 *
 * `strip` drops the folder a forge wraps everything in; `subdir` keeps only one
 * folder of the repository, for a repository that holds several extensions.
 */
function extract(gzipped, dest, { strip = 1, subdir = '', limits = LIMITS } = {}) {
  if (gzipped.length > limits.compressed) throw new ArchiveError('the download is larger than an extension may be');
  let tar;
  try {
    tar = zlib.gunzipSync(gzipped, { maxOutputLength: limits.total + limits.files * 1024 + 1024 * 1024 });
  } catch (error) {
    if (error instanceof RangeError || /buffer|length/i.test(String(error?.message))) {
      throw new ArchiveError('the extension is larger unpacked than an extension may be');
    }
    throw new ArchiveError('the download is not a gzipped archive');
  }
  const { entries, comment } = readTar(tar, limits);

  fs.mkdirSync(dest, { recursive: false, mode: 0o755 });
  const root = path.resolve(dest);
  let written = 0;
  for (const entry of entries) {
    const relative = safeRelative(entry.name, { strip, subdir });
    if (!relative) continue;
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new ArchiveError(`the archive reaches outside itself (${entry.name})`);
    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    try {
      fs.writeFileSync(target, entry.data, { mode: 0o644, flag: 'wx' });
    } catch (error) {
      if (error?.code === 'EEXIST') throw new ArchiveError(`the archive has ${relative} twice`);
      throw error;
    }
    written += 1;
  }
  if (!written) throw new ArchiveError(subdir ? `the repository has nothing in ${subdir}` : 'the archive is empty');
  return { files: written, comment };
}

module.exports = { extract, readTar, safeRelative, ArchiveError, LIMITS };
