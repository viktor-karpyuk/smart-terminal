'use strict';

/**
 * A database that can only be reached from another machine: the connection
 * goes through that machine, over SSH.
 *
 * It is the system's own `ssh` that is run, not a library that speaks the
 * protocol, and that is the point. The person's keys, their agent, their
 * `~/.ssh/config` — a jump host, a port, an alias — and their list of known
 * hosts are all used exactly as a terminal would use them, so a tunnel that
 * works in a terminal works here, and this app never holds a key or a
 * passphrase. The price is that nothing can be typed: a host whose key has
 * never been accepted, or a key that needs a passphrase no agent holds, fails
 * with a sentence that says so, rather than with a prompt nobody can see.
 *
 * A tunnel is a port on this machine, bound to the loopback address only, that
 * lasts as long as something is using it.
 */

const net = require('node:net');
const { spawn: realSpawn } = require('node:child_process');

/** How long a tunnel may take to come up. A bastion on the far side of a VPN is slow; a wrong address should not hang a form. */
const READY_MS = 20000;

class TunnelError extends Error {}

/** A host as ssh takes it: a name, an address, or an alias from the person's own config. Nothing that could be read as an option. */
function sshHostOk(host) {
  return /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,254}$/.test(String(host ?? ''));
}

function sshUserOk(user) {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}\$?$/.test(String(user ?? ''));
}

/**
 * The command line of one tunnel.
 *
 * Every value is its own argument and the host comes after `--`, so nothing
 * typed in a form is ever read as a flag. BatchMode is what turns a question
 * into a failure; ExitOnForwardFailure is what turns a port that could not be
 * bound into one too, instead of an ssh that sits there forwarding nothing.
 */
function sshArgs(ssh, target, localPort) {
  if (!sshHostOk(ssh?.host)) throw new TunnelError('The SSH host is a name or an address, with nothing else in it');
  if (ssh.user && !sshUserOk(ssh.user)) throw new TunnelError('The SSH user is a login name, with nothing else in it');
  const port = ssh.port === null || ssh.port === undefined || ssh.port === '' ? null : Number(ssh.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new TunnelError('The SSH port is a number between 1 and 65535');
  if (!sshHostOk(target?.host)) throw new TunnelError('The database host is a name or an address, with nothing else in it');
  const args = [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-L', `127.0.0.1:${Number(localPort)}:${target.host}:${Number(target.port)}`,
  ];
  if (port !== null) args.push('-p', String(port));
  if (ssh.user) args.push('-l', String(ssh.user));
  if (ssh.key) args.push('-i', String(ssh.key), '-o', 'IdentitiesOnly=yes');
  args.push('--', String(ssh.host));
  return args;
}

/** What ssh said, as a sentence a person can act on. */
function explainSsh(text, host, how = host) {
  const said = String(text ?? '').trim();
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(said)) {
    return `SSH does not trust ${host} yet, or its key has changed. Connect to it once from a terminal — ssh ${how} — and answer its question there.`;
  }
  if (/Permission denied/i.test(said)) {
    return `${host} refused the SSH login. This app uses your keys and your agent and cannot ask for a password or a passphrase: check that ssh ${how} works in a terminal without asking for one.`;
  }
  if (/Could not resolve hostname/i.test(said)) return `There is no SSH host called ${host}`;
  if (/Connection refused/i.test(said)) return `${host} is there but is not accepting SSH on that port`;
  if (/timed out|Operation timed out/i.test(said)) return `${host} did not answer over SSH`;
  if (/administratively prohibited|open failed/i.test(said)) return `${host} let you in but would not forward to the database from there`;
  if (/No such file or directory/i.test(said) && /identity|key/i.test(said)) return 'The SSH key file is not there';
  const last = said.split('\n').filter(Boolean).pop() ?? '';
  return last ? `SSH to ${host} failed: ${last.slice(0, 300)}` : `SSH to ${host} failed`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function answers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

class Tunnels {
  constructor({ spawn, command } = {}) {
    this.spawn = spawn ?? realSpawn;
    this.command = command ?? 'ssh';
    /** key → { port, child, ready, holds, used } */
    this.open = new Map();
  }

  /**
   * The local end of a tunnel to `target` through `ssh`, opened if it has to be.
   * Two callers arriving together share one ssh.
   */
  async through(key, ssh, target) {
    let tunnel = this.open.get(key);
    if (!tunnel) {
      tunnel = { port: null, child: null, holds: 0, used: Date.now(), ready: null };
      tunnel.ready = this.#start(key, tunnel, ssh, target);
      this.open.set(key, tunnel);
      tunnel.ready.catch(() => {
        if (this.open.get(key) === tunnel) this.open.delete(key);
      });
    }
    await tunnel.ready;
    tunnel.used = Date.now();
    return { host: '127.0.0.1', port: tunnel.port };
  }

  async #start(key, tunnel, ssh, target) {
    tunnel.port = await freePort();
    const args = sshArgs(ssh, target, tunnel.port);
    let said = '';
    let gone = false;
    let child;
    try {
      child = this.spawn(this.command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      throw new TunnelError(`ssh could not be started: ${error.message}`);
    }
    tunnel.child = child;
    child.stderr?.on('data', (chunk) => { said = (said + String(chunk)).slice(-4000); });
    const ended = new Promise((resolve) => {
      child.once('error', (error) => { gone = true; said = said || error.message; resolve(); });
      child.once('exit', () => { gone = true; resolve(); });
    });
    // However it ends, a tunnel that is gone is forgotten, so the next thing that needs it opens another.
    ended.then(() => {
      if (this.open.get(key) === tunnel) this.open.delete(key);
    });
    const deadline = Date.now() + READY_MS;
    while (!gone && Date.now() < deadline) {
      if (await answers(tunnel.port)) return;
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 150))]);
    }
    if (!gone) {
      child.kill();
      throw new TunnelError(`${ssh.host} did not answer over SSH`);
    }
    if (/ENOENT/.test(said)) throw new TunnelError('There is no ssh on this computer to open the tunnel with');
    // The command as the person would type it, so the advice can be followed as written.
    const how = [ssh.port ? `-p ${ssh.port}` : '', ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host].filter(Boolean).join(' ');
    throw new TunnelError(explainSsh(said, ssh.host, how));
  }

  /** Something that is not a database session is using this tunnel — a dump, a terminal — and it must not be closed for being quiet. */
  hold(key) {
    const tunnel = this.open.get(key);
    // A connection that goes straight to its server has no tunnel, and holding nothing is not an error.
    if (!tunnel) return () => {};
    tunnel.holds += 1;
    return () => {
      if (tunnel.holds > 0) tunnel.holds -= 1;
      tunnel.used = Date.now();
    };
  }

  has(key) {
    return this.open.has(key);
  }

  /** Whether a tunnel nobody holds has been quiet for longer than `ms`. */
  idle(key, ms) {
    const tunnel = this.open.get(key);
    return Boolean(tunnel) && tunnel.holds === 0 && Date.now() - tunnel.used > ms;
  }

  keys() {
    return [...this.open.keys()];
  }

  close(key) {
    const tunnel = this.open.get(key);
    if (!tunnel) return;
    this.open.delete(key);
    try { tunnel.child?.kill(); } catch { /* it had already gone */ }
  }

  closeAll() {
    for (const key of this.keys()) this.close(key);
  }
}

module.exports = { Tunnels, TunnelError, sshArgs, explainSsh, sshHostOk, sshUserOk };
