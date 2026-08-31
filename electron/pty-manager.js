'use strict';
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');

const DEFAULT_SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

/** Interactive login shell so the user's PATH, nvm, aliases and prompt all load normally. */
function shellArgs(shell) {
  if (process.platform === 'win32') return [];
  const name = shell.split('/').pop();
  if (name === 'fish') return ['-l', '-i'];
  return ['-i', '-l'];
}

/**
 * Environment for a session. The profile's CLAUDE_CONFIG_DIR is what makes one
 * terminal "user X" and another "user Y" — each config dir holds its own credentials.
 */
function buildEnv(profile) {
  const env = { ...process.env };
  // Drop anything Claude-related inherited from the process that launched the app,
  // so a profile always starts from a known state.
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_')) delete env[key];
  }
  delete env.ANTHROPIC_API_KEY;
  // These describe whatever terminal launched the app, not this one; a stale
  // TERM_PROGRAM makes TUIs negotiate the wrong keyboard protocol.
  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;
  delete env.TERM_SESSION_ID;

  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.LANG = env.LANG || 'en_US.UTF-8';
  // Marker so shell rc files (and the user) can tell they are inside this app.
  env.SMART_TERMINAL = '1';
  env.SMART_TERMINAL_PROFILE = profile.name;

  if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
  for (const [k, v] of Object.entries(profile.env || {})) {
    if (v === null || v === undefined) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

function quoteArg(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

/**
 * The command typed into the fresh shell for a Claude session.
 * `command` bypasses user-defined `claude` shell functions, which on this machine
 * rewrite CLAUDE_CONFIG_DIR based on the current directory and would defeat the profile.
 */
function claudeLaunchLine(profile, extraArgs = [], { useProfileArgs = true } = {}) {
  const bin = profile.claudeCommand || 'claude';
  const args = [...(useProfileArgs ? profile.claudeArgs || [] : []), ...extraArgs]
    .map(quoteArg)
    .join(' ');
  const prefix = bin.includes('/') ? '' : 'command ';
  return `${prefix}${bin}${args ? ` ${args}` : ''}`;
}

/** What gets typed into the shell for each kind of session. */
function bootstrapFor(kind, profile, extraArgs) {
  if (kind === 'login') return claudeLaunchLine(profile, ['auth', 'login'], { useProfileArgs: false });
  if (kind === 'claude') return claudeLaunchLine(profile, extraArgs);
  return null;
}

class PtyManager {
  /** @param {(channel: string, payload: any) => void} emit */
  constructor(emit) {
    this.emit = emit;
    this.sessions = new Map();
  }

  create({ profile, cwd, kind = 'claude', cols = 80, rows = 24, extraArgs = [], command = null }) {
    const id = randomUUID();
    const shell = profile.shell || DEFAULT_SHELL;
    // Landing somewhere other than where you asked is worth saying out loud: a
    // silent fall back to the account's home folder looks exactly like the app
    // moving your session for no reason.
    const wanted = cwd || '';
    const workdir = fs.existsSync(wanted) ? wanted : profile.cwd || os.homedir();
    const relocated = wanted && workdir !== wanted ? wanted : null;

    const proc = pty.spawn(shell, shellArgs(shell), {
      name: 'xterm-256color',
      cwd: workdir,
      env: buildEnv(profile),
      cols,
      rows,
      encoding: 'utf8',
      handleFlowControl: true,
    });

    const session = {
      id,
      proc,
      profileId: profile.id,
      cwd: workdir,
      kind,
      pending: '',
      flushTimer: null,
      bootstrapped: false,
      bootstrapLine: command ?? bootstrapFor(kind, profile, extraArgs),
      notice: relocated
        ? `\r\n\x1b[38;5;214m${relocated} is not there any more — opened in ${workdir} instead.\x1b[0m\r\n`
        : null,
    };
    this.sessions.set(id, session);
    if (process.env.SMART_TERMINAL_DEV === '1') {
      console.log(`[pty ${id.slice(0, 8)}] ${shell} in ${workdir}\n          $ ${session.bootstrapLine ?? '(no launch line)'}`);
    }

    proc.onData((chunk) => {
      // The first byte of output means the shell has drawn its prompt and is
      // ready to accept the launch line.
      if (!session.bootstrapped) {
        session.bootstrapped = true;
        if (session.notice) this.emit('pty:data', { id, data: session.notice });
        if (session.bootstrapLine) {
          setTimeout(() => {
            if (this.sessions.has(id)) proc.write(`${session.bootstrapLine}\r`);
          }, 120);
        }
      }
      this.#queue(session, chunk);
    });

    proc.onExit(({ exitCode, signal }) => {
      this.#flush(session);
      this.sessions.delete(id);
      this.emit('pty:exit', { id, exitCode, signal });
    });

    return { id, pid: proc.pid, cwd: workdir, shell, kind, profileId: profile.id };
  }

  /** Coalesce PTY output into ~8ms frames so a chatty process cannot flood IPC. */
  #queue(session, chunk) {
    session.pending += chunk;
    if (session.flushTimer) return;
    session.flushTimer = setTimeout(() => this.#flush(session), 8);
  }

  #flush(session) {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (!session.pending) return;
    const data = session.pending;
    session.pending = '';
    this.emit('pty:data', { id: session.id, data });
  }

  /** Live sessions and the pid of their shell, for the cwd watcher. */
  list() {
    return [...this.sessions.values()].map((session) => ({ id: session.id, pid: session.proc.pid }));
  }

  write(id, data) {
    this.sessions.get(id)?.proc.write(data);
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.proc.resize(Math.max(2, cols | 0), Math.max(1, rows | 0));
    } catch {
      /* the process may have exited between the resize and this call */
    }
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.proc.kill();
    } catch {
      /* already gone */
    }
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager, claudeLaunchLine, buildEnv, DEFAULT_SHELL };
