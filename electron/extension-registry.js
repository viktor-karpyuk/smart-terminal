'use strict';

/**
 * The registry: the list of extensions other people have published.
 *
 * One JSON file in a public repository. Publishing is a pull request that adds
 * an entry to it, which is where somebody reads the code before it is listed —
 * and the entry pins what was read: the repository, the exact commit, the
 * version, and the permissions. The app installs that commit and refuses it if
 * what arrives does not say the same thing, so a listing cannot be swapped for
 * other code after it was reviewed.
 *
 * A file rather than a service because there is nothing to run: GitHub serves
 * it, pull requests are the moderation, and history is the audit log.
 */

const fs = require('node:fs');
const { readPermissions } = require('./extension-permissions');
const { parseRepo, SHA } = require('./extension-source');

const DEFAULT_URL = 'https://raw.githubusercontent.com/viktor-karpyuk/smart-terminal-extensions/main/index.json';
const FRESH_MS = 10 * 60 * 1000;

/** One entry, checked. Returns { entry } or { error } — a bad entry is skipped, never fatal. */
function readEntry(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  const id = String(raw.id ?? '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { error: `"${id}" is not an extension id` };
  if (!raw.name) return { error: `${id} has no name` };
  if (!/^\d+\.\d+\.\d+/.test(String(raw.version ?? ''))) return { error: `${id} has no version` };
  if (!SHA.test(String(raw.commit ?? ''))) return { error: `${id} does not pin a commit` };
  let repo;
  try {
    repo = parseRepo(raw.repo);
  } catch {
    return { error: `${id} names a repository this app cannot install from` };
  }
  const subdir = raw.path ? String(raw.path).replace(/^\/+|\/+$/g, '') : '';
  if (subdir.split('/').some((part) => part === '..' || part === '.')) return { error: `${id} has a path that is not a plain folder` };
  const { permissions, error } = readPermissions(raw.permissions ?? []);
  if (error) return { error: `${id} ${error}` };
  return {
    entry: {
      id,
      name: String(raw.name),
      version: String(raw.version),
      summary: String(raw.summary ?? ''),
      description: String(raw.description ?? ''),
      author: raw.author ? String(raw.author) : null,
      repo: `https://github.com/${repo.owner}/${repo.repo}`,
      owner: repo.owner,
      repoName: repo.repo,
      path: subdir,
      commit: String(raw.commit),
      permissions,
    },
  };
}

function readIndex(json) {
  const list = Array.isArray(json) ? json : json?.extensions;
  if (!Array.isArray(list)) return { entries: [], problems: ['the registry is not a list of extensions'] };
  const entries = [];
  const problems = [];
  const seen = new Set();
  for (const raw of list) {
    const { entry, error } = readEntry(raw);
    if (error) problems.push(error);
    else if (seen.has(entry.id)) problems.push(`${entry.id} is listed twice`);
    else {
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  return { entries, problems };
}

/**
 * The registry, fetched at most every ten minutes. A failed fetch keeps what was
 * last read and says it could not refresh, rather than emptying the gallery.
 */
function registry({ fetch, url = process.env.SMART_TERMINAL_REGISTRY || DEFAULT_URL, now = Date.now }) {
  let held = { at: 0, entries: [], problems: [], error: null, url };

  async function load() {
    let json;
    if (/^(\/|file:)/.test(url)) {
      json = JSON.parse(fs.readFileSync(url.replace(/^file:\/\//, ''), 'utf8'));
    } else {
      const response = await fetch(url, { headers: { 'user-agent': 'smart-terminal', 'cache-control': 'no-cache' } });
      if (!response.ok) throw new Error(`the registry answered ${response.status}`);
      json = await response.json();
    }
    return readIndex(json);
  }

  return {
    async list({ refresh = false } = {}) {
      if (!refresh && held.at && now() - held.at < FRESH_MS) return held;
      try {
        const { entries, problems } = await load();
        held = { at: now(), entries, problems, error: null, url };
      } catch (error) {
        held = { ...held, at: now(), error: `Could not read the registry: ${String(error?.message ?? error)}` };
      }
      return held;
    },
    find(id) {
      return held.entries.find((entry) => entry.id === id) ?? null;
    },
  };
}

module.exports = { registry, readIndex, readEntry, DEFAULT_URL };
