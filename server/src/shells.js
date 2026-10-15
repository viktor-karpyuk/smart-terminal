'use strict';

/**
 * Shells that run on this server, for when the computer is closed.
 *
 * What runs is the operator's choice, never a default: ORG_SHELL_COMMAND, with
 * {user} replaced by the person's id. Every shell started here runs as the
 * server's own system user, so a bare `bash -l` would let anybody read the
 * server's database; a container per person (see the README) is what keeps
 * one person's shell away from another's, and from the server.
 *
 * A shell outlives the browser tab that started it, like a tmux session: it
 * keeps what it printed lately, so opening it again shows where it was, and it
 * ends after hours without anybody looking at it.
 */

const crypto = require('node:crypto');

const REPLAY_LIMIT = 256 * 1024;
const MAX_INPUT = 64 * 1024;

/** `docker run --rm -it -v "home {user}:/home/dev" img` → argv, quotes respected. */
function splitCommand(text) {
  const argv = [];
  let word = '';
  let quote = null;
  let any = false;
  for (const ch of String(text ?? '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (word || any) argv.push(word);
      word = '';
      any = false;
    } else {
      word += ch;
    }
  }
  if (word || any) argv.push(word);
  return argv;
}

function keepRecent(text, limit = REPLAY_LIMIT) {
  if (text.length <= limit) return text;
  const cut = text.indexOf('\n', text.length - limit);
  return cut === -1 ? text.slice(-limit) : text.slice(cut + 1);
}

function createShells({ command, spawnPty, store, now = Date.now, idleMs = 8 * 3600_000, maxPerUser = 4, log = () => {} }) {
  const argv = splitCommand(command);
  /** id → { id, userId, name, pty, replay, viewers, startedAt, lastSeenAt, cols, rows } */
  const shells = new Map();
  const json = (conn, value) => conn?.send(JSON.stringify(value));

  function describe(s) {
    return { id: s.id, name: s.name, startedAt: s.startedAt, viewers: s.viewers.size, cols: s.cols, rows: s.rows };
  }

  function end(s, reason) {
    if (!shells.has(s.id)) return;
    shells.delete(s.id);
    for (const v of s.viewers) {
      json(v, { t: 'ended', reason });
      v.close(1000);
    }
    s.viewers.clear();
    try { s.pty.kill(); } catch { /* already gone */ }
    store.log(s.userId, 'shell.ended', s.name, reason);
  }

  const sweeper = setInterval(() => {
    for (const s of [...shells.values()]) {
      if (!s.viewers.size && now() - s.lastSeenAt > idleMs) end(s, 'Nobody had it open for hours.');
    }
  }, 60_000);
  sweeper.unref?.();

  return {
    /** Whether this server can start shells at all. */
    available: () => Boolean(argv.length && spawnPty),
    why: () => (!argv.length ? 'No shell command is set on the server (ORG_SHELL_COMMAND).' : !spawnPty ? 'node-pty is not installed on the server.' : ''),

    list(userId) {
      return [...shells.values()].filter((s) => s.userId === userId).map(describe);
    },

    create(user, { cols = 100, rows = 30, name = '' } = {}) {
      if ([...shells.values()].filter((s) => s.userId === user.id).length >= maxPerUser) {
        const error = new Error(`You already have ${maxPerUser} shells on the server. Close one first.`);
        error.status = 429;
        throw error;
      }
      const id = crypto.randomUUID();
      const words = argv.map((w) => w.replaceAll('{user}', user.id));
      // A clean environment: nothing of the server's own (its database path, its secrets) reaches the shell.
      const env = {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.ORG_SHELL_HOME || process.env.HOME || '/tmp',
        SMART_TERMINAL_USER: user.email,
      };
      const size = { cols: Math.max(20, Math.min(400, cols | 0)), rows: Math.max(5, Math.min(200, rows | 0)) };
      const pty = spawnPty(words[0], words.slice(1), { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: env.HOME, env });
      const s = {
        id,
        userId: user.id,
        name: String(name || '').trim().slice(0, 60) || `Shell ${[...shells.values()].filter((x) => x.userId === user.id).length + 1}`,
        pty,
        replay: '',
        viewers: new Set(),
        startedAt: now(),
        lastSeenAt: now(),
        ...size,
      };
      shells.set(id, s);
      pty.onData((data) => {
        s.replay = keepRecent(s.replay + data);
        for (const v of s.viewers) json(v, { t: 'out', data });
      });
      pty.onExit(({ exitCode }) => end(s, exitCode ? `The shell ended (exit ${exitCode}).` : 'The shell ended.'));
      store.log(user.id, 'shell.started', s.name, words[0]);
      log(`shell: ${user.email} started ${s.name}`);
      return describe(s);
    },

    /** A browser showing it. Only its owner's. */
    attach(id, userId, conn) {
      const s = shells.get(id);
      if (!s || s.userId !== userId) return false;
      s.viewers.add(conn);
      s.lastSeenAt = now();
      json(conn, { t: 'opened', cols: s.cols, rows: s.rows, title: s.name, replay: s.replay });
      conn.on('message', (text) => {
        let m;
        try { m = JSON.parse(text); } catch { return; }
        if (!shells.has(id)) return;
        if (m?.t === 'in') {
          const data = String(m.data ?? '');
          if (data && data.length <= MAX_INPUT) s.pty.write(data);
        } else if (m?.t === 'resize') {
          const cols = Math.max(20, Math.min(400, Number(m.cols) | 0));
          const rows = Math.max(5, Math.min(200, Number(m.rows) | 0));
          if (cols === s.cols && rows === s.rows) return;
          s.cols = cols;
          s.rows = rows;
          try { s.pty.resize(cols, rows); } catch { /* exited meanwhile */ }
          for (const v of s.viewers) if (v !== conn) json(v, { t: 'size', cols, rows });
        }
      });
      conn.on('close', () => {
        s.viewers.delete(conn);
        s.lastSeenAt = now();
      });
      return true;
    },

    kill(id, userId) {
      const s = shells.get(id);
      if (!s || s.userId !== userId) return false;
      end(s, 'Closed.');
      return true;
    },

    /** Everyone's shells that are no longer allowed: an account disabled, or the setting narrowed. */
    endWhere(predicate, reason) {
      for (const s of [...shells.values()]) if (predicate(s.userId)) end(s, reason);
    },

    closeAll() {
      clearInterval(sweeper);
      for (const s of [...shells.values()]) end(s, 'The server stopped.');
    },
  };
}

module.exports = { createShells, splitCommand, keepRecent };
