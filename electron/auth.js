'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app } = require('electron');

const DEFAULT_SHELL = process.env.SHELL || '/bin/zsh';

/**
 * Run a command through a login shell so it resolves the same `claude` the user
 * gets in their terminal, even when the app was launched from Finder with a bare PATH.
 */
function runInLoginShell(command, env, timeout = 25000) {
  return new Promise((resolve) => {
    execFile(
      DEFAULT_SHELL,
      ['-lc', command],
      { env, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

/** Login shells print greetings; pull the one JSON object out of the noise. */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Whether a folder already holds a signed-in account. Merely existing is not
 * enough — the CLI writes a bare `.claude.json` into any folder it is pointed at,
 * including when this app only asks it for auth status.
 */
function hasLogin(dir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    // `userID` alone is bootstrap state the CLI writes into any folder it touches;
    // only `oauthAccount` means someone actually signed in here.
    return Boolean(config.oauthAccount);
  } catch {
    return false;
  }
}

/** Where a brand-new account's credentials should live. */
function accountsRoot() {
  return path.join(app.getPath('userData'), 'accounts');
}

function slugify(name) {
  return (
    String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'account'
  );
}

/**
 * Candidate directories for a new profile, best first. A directory that already
 * holds a config is offered too, but flagged so the UI can warn about reuse.
 */
function suggestConfigDirs(name) {
  const slug = slugify(name);
  const home = os.homedir();
  return [
    {
      dir: path.join(accountsRoot(), slug),
      label: 'Managed by Smart Terminal',
      detail: 'Kept with the app, separate from every other tool.',
      recommended: true,
      hasLogin: hasLogin(path.join(accountsRoot(), slug)),
    },
    {
      dir: path.join(home, '.claude-accounts', slug),
      label: 'Shared account folder',
      detail: 'Also readable by your shell, so `CLAUDE_CONFIG_DIR` works outside the app.',
      recommended: false,
      hasLogin: hasLogin(path.join(home, '.claude-accounts', slug)),
    },
  ];
}

function ensureConfigDir(dir) {
  if (!dir) throw new Error('No directory given');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const cache = new Map();
const CACHE_TTL = 2500;

/**
 * Ask the CLI who a config dir is signed in as. `command` bypasses any user-defined
 * `claude` shell function, which would otherwise pick its own config dir.
 */
async function authStatus(profile, { force = false } = {}) {
  const key = `${profile.claudeCommand || 'claude'}::${profile.configDir || '~/.claude'}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('CLAUDE_')) delete env[name];
  delete env.ANTHROPIC_API_KEY;
  if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;

  const bin = profile.claudeCommand || 'claude';
  const { error, stdout, stderr } = await runInLoginShell(
    `command ${bin} auth status --json`,
    env,
  );

  let value;
  const parsed = extractJson(stdout);
  if (parsed) {
    value = {
      available: true,
      loggedIn: Boolean(parsed.loggedIn),
      email: parsed.email ?? null,
      orgName: parsed.orgName ?? null,
      subscriptionType: parsed.subscriptionType ?? null,
      authMethod: parsed.authMethod ?? null,
    };
  } else {
    value = {
      available: false,
      loggedIn: false,
      error: (stderr || stdout || error?.message || 'claude CLI not found').trim().slice(0, 300),
    };
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}

function invalidateAuthCache() {
  cache.clear();
}

module.exports = {
  accountsRoot,
  hasLogin,
  authStatus,
  ensureConfigDir,
  invalidateAuthCache,
  slugify,
  suggestConfigDirs,
};
