'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

/**
 * Finding the `claude` CLI when the app was not started from a terminal.
 *
 * Launched from Finder — or by `open`, which is what an installer does — the app
 * inherits launchd's environment, and its PATH is the bare system one. Running
 * the CLI through `zsh -lc` does not rescue that: a *non-interactive* login shell
 * reads `.zshenv`, `.zprofile` and `.zlogin`, and never `.zshrc` — which is where
 * PATH additions overwhelmingly live. The CLI is then simply not found.
 *
 * What that looks like in the app is nothing like "command not found". The
 * account reports itself signed out, and both the usage gauge and the usage panel
 * are gated on being signed in, so they render nothing at all. Started from a
 * terminal the very same build works, because it inherited a PATH that already
 * had the CLI on it.
 *
 * So the PATH is asked for once, from an *interactive* login shell, and merged
 * into what the app already has. Only the PATH is taken: the command itself keeps
 * running in a non-interactive shell, which stays quiet and cannot block on a
 * prompt.
 */

/** An interactive shell can hang; this is a lookup, not a session. */
const TIMEOUT = 8000;
/** The answer changes about as often as a shell profile does. */
const TTL = 10 * 60 * 1000;

const cache = new Map();
/**
 * The lookups already in the air, one per shell.
 *
 * Without this the cache only helps callers that arrive *after* an answer:
 * everyone who asks before the first one comes back spawns an interactive login
 * shell of their own. A workspace restoring thirty sessions, each wanting a
 * PATH, plus a panel wanting one — measured at a hundred and forty `zsh -ilc`
 * at once on a machine whose profile takes a second to run, which is slow
 * enough that they arrive faster than they finish and the thing that asked
 * first is still waiting minutes later.
 */
const asking = new Map();

/** Where these CLIs install themselves, for when asking the shell fails. */
const FALLBACK_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.volta', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

/**
 * The PATH an interactive login shell would have. `printf %s` ends without a
 * newline, so the value is the last line — anything a profile printed on its way
 * past is above it.
 */
function parseShellPath(stdout) {
  const line = String(stdout || '')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();
  if (!line || !line.includes('/')) return null;
  return line;
}

/** Everything on `first`, then whatever `second` adds that is not already there. */
function mergePaths(first, second) {
  const seen = new Set();
  const out = [];
  for (const part of `${first || ''}:${second || ''}`.split(':')) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(':');
}

function existingFallbacks() {
  return FALLBACK_DIRS.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }).join(':');
}

/**
 * Ask an interactive shell what its PATH is, and never wait on it for ever.
 *
 * Two things here are not decoration.
 *
 * `killSignal: 'SIGKILL'`, because an *interactive* shell ignores SIGTERM — that
 * is what interactive means — so `execFile`'s own timeout would send a signal
 * the child is entitled to disregard, and then wait. Measured: shells still
 * running after seventy seconds against an eight-second timeout.
 *
 * And a timer of our own, because the callback is the only thing that settles
 * this promise and a child that never dies never fires it. Everything in the
 * app that runs a CLI waits on this — the account check, the usage gauge,
 * kubectl, helm — so a lookup that hangs is an app that hangs, silently and
 * with no error anywhere. Past the deadline the answer is "the shell did not
 * say", which is what the fallback directories are for.
 */
function askShellForPath(shell, deadline = TIMEOUT) {
  return new Promise((resolve) => {
    let settled = false;
    const answer = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = execFile(
      shell,
      ['-ilc', 'printf %s "$PATH"'],
      { timeout: deadline, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout) => answer(error && !stdout ? null : parseShellPath(stdout)),
    );

    const giveUp = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      answer(null);
    }, deadline + 500);
    giveUp.unref?.();
  });
}

/**
 * A PATH to run the CLI with: what the app already has, plus what an interactive
 * login shell would add, plus the usual install directories if that shell could
 * not be asked.
 *
 * `ask` is a seam for the tests, and only that: the thing worth testing here is
 * that sixty callers cost one shell, and proving it by spawning sixty real ones
 * would be a test that takes a minute and measures the machine.
 */
function resolvedPath(shell = process.env.SHELL || '/bin/zsh', { ask = askShellForPath } = {}) {
  const hit = cache.get(shell);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.value);

  // Everyone who wants it while it is being fetched waits on the same fetch.
  const already = asking.get(shell);
  if (already) return already;

  const wait = ask(shell)
    .then((fromShell) => {
      const value = mergePaths(mergePaths(process.env.PATH, fromShell), existingFallbacks());
      cache.set(shell, { at: Date.now(), value });
      return value;
    })
    .finally(() => asking.delete(shell));

  asking.set(shell, wait);
  return wait;
}

function forgetResolvedPath() {
  cache.clear();
  asking.clear();
}

module.exports = { resolvedPath, forgetResolvedPath, mergePaths, parseShellPath, askShellForPath };
