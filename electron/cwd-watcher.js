'use strict';
const { execFile } = require('node:child_process');

const LSOF = '/usr/sbin/lsof';

/**
 * How often to ask, when something is actually happening.
 *
 * Every tick spawns two processes — `lsof` over the session pids, and a `ps`
 * that walks every process on the machine. At 2.5s that is forty-eight process
 * spawns a minute, for ever, whether or not anything has moved.
 */
const INTERVAL = 2500;

/**
 * How often to ask when nothing has changed for a while.
 *
 * A session that has not moved in a minute is a session nobody is typing in, and
 * the answer to "where is it" is the same answer as last time. The moment
 * anything does change the poll snaps back to `INTERVAL`, so the case that needs
 * to feel immediate still does — this only stops the app asking a question it
 * already knows the answer to, hundreds of times an hour.
 */
const IDLE_INTERVAL = 10000;

/** Quiet for this long, and the poll slows down. */
const QUIET_BEFORE_IDLE = 60000;

/**
 * Reports each session's *live* working directory and what is running in it.
 *
 * The folder a session starts in is only its starting point — the shell is real, so
 * the user can `cd` anywhere and launch Claude there. Rather than trusting the spawn
 * argument forever, this asks the OS where each shell actually is. One `lsof` call
 * covers every session at once (~60ms), so the poll stays cheap as sessions pile up.
 *
 * The same tick also notes whether the shell has a child — a session whose Claude
 * has exited looks identical to a running one from the outside, and that is the
 * difference between "already open" and "needs starting".
 */
class CwdWatcher {
  /**
   * @param {() => Array<{id: string, pid: number}>} listSessions
   * @param {(changes: Array<{id: string, cwd: string}>) => void} onChange
   */
  constructor(listSessions, onChange) {
    this.listSessions = listSessions;
    this.onChange = onChange;
    this.known = new Map();
    this.timer = null;
    this.running = false;
    this.everyMs = INTERVAL;
    this.lastChange = Date.now();
    this.supported = process.platform === 'darwin' || process.platform === 'linux';
  }

  start() {
    if (this.timer || !this.supported) return;
    // A watcher that starts after a long stop must start responsive, not carry
    // in the quiet it was stopped during.
    this.lastChange = Date.now();
    this.#schedule(INTERVAL);
  }

  /** Re-arm at a given rate, replacing whatever was running. */
  #schedule(everyMs) {
    if (this.timer) clearInterval(this.timer);
    this.everyMs = everyMs;
    this.timer = setInterval(() => this.poll(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.everyMs = INTERVAL;
    this.known.clear();
  }

  forget(id) {
    this.known.delete(id);
  }

  /**
   * Somebody is doing something; ask at full rate again.
   *
   * A keystroke is the one signal that beats any polling interval: `cd` has been
   * typed before the next tick either way, and this is what keeps the backoff
   * from ever being something you can feel.
   */
  wake() {
    this.lastChange = Date.now();
    if (this.timer && this.everyMs !== INTERVAL) this.#schedule(INTERVAL);
  }

  poll() {
    if (this.running) return;
    const sessions = this.listSessions().filter((s) => s.pid);
    if (!sessions.length) return;

    this.running = true;
    const pids = sessions.map((s) => s.pid).join(',');

    Promise.all([
      run(LSOF, ['-a', '-p', pids, '-d', 'cwd', '-Fpn']),
      run('/bin/ps', ['-axo', 'ppid=,args=']),
    ])
      .then(([lsofOut, psOut]) => {
        const byPid = parseLsof(lsofOut);
        const children = parseChildren(psOut);

        const changes = [];
        for (const session of sessions) {
          const cwd = byPid.get(session.pid);
          const child = children.get(session.pid) ?? null;
          const foreground = child?.name ?? null;
          const command = child?.command ?? null;
          const previous = this.known.get(session.id);
          if (previous && previous.cwd === cwd && previous.foreground === foreground && previous.command === command) {
            continue;
          }
          this.known.set(session.id, { cwd: cwd ?? previous?.cwd, foreground, command });
          changes.push({ id: session.id, cwd: cwd ?? previous?.cwd, foreground, command });
        }
        if (changes.length) {
          this.lastChange = Date.now();
          if (this.everyMs !== INTERVAL) this.#schedule(INTERVAL);
          this.onChange(changes);
        } else if (this.everyMs === INTERVAL && Date.now() - this.lastChange > QUIET_BEFORE_IDLE) {
          this.#schedule(IDLE_INTERVAL);
        }
      })
      .catch(() => {
        /* a transient failure just means this tick reports nothing */
      })
      .finally(() => {
        this.running = false;
      });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) reject(error);
      else resolve(stdout || '');
    });
  });
}

/**
 * The command a shell is currently running, if any. Only the last child is kept:
 * a shell running one program at a time is the case that matters.
 *
 * Both halves are reported. `name` is the short one everything already shows —
 * `node`, `claude`, `vim`. `command` is the whole line, which is the only thing
 * that can be run again: "node" is not a thing anyone can restart, and
 * `npm run local` is.
 */
function parseChildren(output) {
  const byParent = new Map();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[2].trim();
    if (!command) continue;
    // The first token is the program; the rest are its arguments.
    const name = command.split(/\s+/)[0].split('/').pop();
    if (name) byParent.set(Number(match[1]), { name, command });
  }
  return byParent;
}

/** `lsof -Fpn` emits `p<pid>`, then `fcwd`, then `n<path>` per process. */
function parseLsof(output) {
  const byPid = new Map();
  let pid = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) byPid.set(pid, line.slice(1));
  }
  return byPid;
}

module.exports = { CwdWatcher };
