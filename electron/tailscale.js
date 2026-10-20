'use strict';

/**
 * Tailscale, as far as the phone needs it: whether it is on this computer,
 * whether it is up, and the name and address the phone reaches this computer
 * by from anywhere. Nothing is configured here — Tailscale's own app does that
 * — this only reads what it says, through its command line.
 */

const fs = require('node:fs');
const { execFile } = require('node:child_process');

/** Where the command lives, in the order it is looked for. */
const CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/bin/tailscale',
];

/** A reading is good for this long; the panel asks often and the command is not free. */
const TTL_MS = 10_000;

/** The known places first; the PATH after, and only its absolute entries: a `tailscale` planted in `.` or `./node_modules/.bin` is not Tailscale. */
function findCli({ exists = fs.existsSync, env = process.env } = {}) {
  const known = CANDIDATES.find((one) => exists(one));
  if (known) return known;
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (dir.startsWith('/') && !/^\/(tmp|var\/tmp|private\/tmp)\b/.test(dir) && exists(`${dir}/tailscale`)) return `${dir}/tailscale`;
  }
  return null;
}

/** What `tailscale status --json` says, kept to the fields the phone cares about. */
function readStatus(json) {
  let status;
  try {
    status = JSON.parse(json);
  } catch {
    return { running: false, name: null, ips: [], error: 'Tailscale answered something that is not its status.' };
  }
  const self = status?.Self ?? {};
  const running = status?.BackendState === 'Running';
  const name = String(self.DNSName ?? '').replace(/\.$/, '') || null;
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) : [];
  return { running, state: status?.BackendState ?? null, name, ips, error: null };
}

class Tailscale {
  constructor({ cli = findCli(), exec = execFile, now = Date.now } = {}) {
    this.cli = cli;
    this.exec = exec;
    this.now = now;
    this.last = null;
    this.readAt = 0;
    /** The reading under way, so a burst of askers spawns one process, not one each. */
    this.pending = null;
  }

  get installed() {
    return Boolean(this.cli);
  }

  /** The current reading, fresh enough; never throws. */
  info() {
    if (!this.cli) return Promise.resolve({ installed: false, running: false, name: null, ips: [], error: null });
    if (this.last && this.now() - this.readAt < TTL_MS) return Promise.resolve(this.last);
    if (this.pending) return this.pending;
    const reading = new Promise((resolve) => {
      // Only this computer's own entry: a tailnet of hundreds of peers would not fit a default buffer.
      this.exec(this.cli, ['status', '--json', '--peers=false'], { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        const answer = { installed: true, ...readStatus(String(stdout ?? '')) };
        if (error && !answer.name) answer.error = 'Tailscale is installed but did not answer. Is it running?';
        this.last = answer;
        this.readAt = this.now();
        resolve(answer);
      });
    });
    // Set after the executor ran: an answer that arrives at once would otherwise clear it before it was set.
    this.pending = reading;
    reading.then(() => { if (this.pending === reading) this.pending = null; });
    return reading;
  }

  /** The addresses a phone on the same tailnet reaches this port by: the name first, then the IP. */
  addresses(port) {
    const info = this.last;
    if (!info?.running) return [];
    const out = [];
    if (info.name) out.push(`http://${info.name}:${port}/`);
    for (const ip of info.ips) out.push(`http://${ip}:${port}/`);
    return out;
  }
}

module.exports = { Tailscale, findCli, readStatus, CANDIDATES };
