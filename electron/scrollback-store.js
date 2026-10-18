'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * What each terminal was showing, kept so it can be shown again after a restart.
 *
 * A session comes back after a restart — same tab, same id, a fresh shell — but
 * until now with an empty screen: everything the last run printed was only ever
 * in the renderer's memory. The renderer writes each terminal's screen and the
 * end of its scrollback here, as the escape sequences that redraw it, and asks
 * for it once when the terminal is made again.
 *
 * One file per session, named by its id, in a folder of its own. Bounded twice:
 * a file larger than the cap is refused, and files nobody has asked for in a
 * month are removed at startup.
 */

/** Well past a thousand rows of colourful output; anything bigger is not a screen. */
const MAX_BYTES = 2 * 1024 * 1024;
/** Longer than any session is left closed and still expected to come back. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

class ScrollbackStore {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
  }

  #file(id) {
    // An id is the app's own uuid; anything else could name a path.
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) return null;
    return path.join(this.dir, `${id}.vt`);
  }

  save(id, text) {
    const file = this.#file(id);
    if (!file || typeof text !== 'string') return false;
    if (Buffer.byteLength(text) > MAX_BYTES) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Written beside and renamed over, so a crash mid-write never leaves half a screen.
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, text);
      fs.renameSync(temporary, file);
      return true;
    } catch {
      return false;
    }
  }

  /** The saved screen for a session, or null. */
  read(id) {
    const file = this.#file(id);
    if (!file) return null;
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  forget(id) {
    const file = this.#file(id);
    if (file) fs.rmSync(file, { force: true });
  }

  /** Everything, for when keeping screens is switched off. */
  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Screens of sessions that have not been seen in a month. */
  prune() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const stale = name.endsWith('.tmp') || this.now() - fs.statSync(file).mtimeMs > KEEP_MS;
        if (stale) {
          fs.rmSync(file, { force: true });
          removed += 1;
        }
      } catch {
        /* gone already */
      }
    }
    return removed;
  }
}

module.exports = { ScrollbackStore, MAX_BYTES, KEEP_MS };
