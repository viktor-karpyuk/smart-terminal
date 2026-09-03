'use strict';
const { execFile } = require('node:child_process');

const LSOF = '/usr/sbin/lsof';
const INTERVAL = 2500;

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
    this.supported = process.platform === 'darwin' || process.platform === 'linux';
  }

  start() {
    if (this.timer || !this.supported) return;
    this.timer = setInterval(() => this.poll(), INTERVAL);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.known.clear();
  }

  forget(id) {
    this.known.delete(id);
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
        if (changes.length) this.onChange(changes);
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
