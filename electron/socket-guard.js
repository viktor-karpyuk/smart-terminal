'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Keeping the app's socket to the person it belongs to.
 *
 * The socket carries what a session may ask of the app, Jenkins included. A
 * unix socket is as open as its mode and the directory it is in: the mode a
 * file gets is the umask's decision, not the program's, so a permissive umask
 * makes both world-readable, and a socket in a shared `/tmp` under a name
 * anybody can predict is a socket anybody can get there first.
 *
 * Nothing here applies on Windows, where the channel is not a file.
 */

const windows = process.platform === 'win32';

/**
 * A directory that is ours alone: made if it is not there, 0700 whatever the
 * umask, and refused if it is a link (which could point anywhere), not a
 * directory, or somebody else's. `uid` is a parameter only so the refusal can
 * be tested without a second user.
 */
function ensurePrivateDir(dir, { uid = process.getuid?.() } = {}) {
  if (windows) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  if (uid !== undefined && info.uid !== uid) throw new Error(`${dir} belongs to someone else`);
  // `mkdir` honours the umask and an existing directory keeps whatever it had: say what it should be.
  if ((info.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  return dir;
}

/** The directory the app already owns, made private without refusing it: it holds the database and cannot be replaced. */
function tightenDir(dir) {
  if (windows) return;
  try {
    const info = fs.lstatSync(dir);
    if (info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  } catch {
    /* not there yet, or not ours to change */
  }
}

/** A socket that exists, made readable and writable by its owner alone. */
function lockSocket(socketPath) {
  if (windows) return;
  fs.chmodSync(socketPath, 0o600);
}

module.exports = { ensurePrivateDir, tightenDir, lockSocket, dirname: path.dirname };
