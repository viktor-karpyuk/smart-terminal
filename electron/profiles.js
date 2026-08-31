'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JsonStore } = require('./store');

const BADGE_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#41a6b5'];

/** Directories that commonly hold per-account Claude Code configs. */
function candidateAccountRoots() {
  const home = os.homedir();
  return [
    path.join(home, 'Library', 'Application Support', 'AICodeReviewer', 'accounts'),
    path.join(home, '.claude-accounts'),
    path.join(home, '.config', 'claude-accounts'),
  ];
}

/** A directory looks like a Claude config dir if it holds the CLI's own state files. */
function looksLikeClaudeConfigDir(dir) {
  return ['.claude.json', 'settings.json', 'projects'].some((f) => fs.existsSync(path.join(dir, f)));
}

function discoverAccountDirs() {
  const found = [];
  for (const root of candidateAccountRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (looksLikeClaudeConfigDir(dir)) found.push({ name: entry.name, dir });
    }
  }
  return found;
}

function makeProfile(partial, index = 0) {
  return {
    id: partial.id || randomUUID(),
    name: partial.name || 'Untitled',
    color: partial.color || BADGE_COLORS[index % BADGE_COLORS.length],
    configDir: partial.configDir ?? null,
    cwd: partial.cwd || os.homedir(),
    shell: partial.shell || null,
    claudeCommand: partial.claudeCommand || 'claude',
    claudeArgs: Array.isArray(partial.claudeArgs) ? partial.claudeArgs : [],
    env: partial.env && typeof partial.env === 'object' ? partial.env : {},
    fallbackProfileId: partial.fallbackProfileId ?? null,
  };
}

function seedProfiles() {
  const home = os.homedir();
  const seeded = [makeProfile({ name: 'Default', configDir: null, cwd: home }, 0)];
  discoverAccountDirs().forEach((account, i) => {
    seeded.push(
      makeProfile(
        {
          name: account.name.replace(/^./, (c) => c.toUpperCase()),
          configDir: account.dir,
          cwd: home,
        },
        i + 1,
      ),
    );
  });
  return seeded;
}

class ProfileStore {
  constructor() {
    this.store = new JsonStore('profiles.json', { profiles: null });
    if (!Array.isArray(this.store.get().profiles)) {
      this.store.set({ profiles: seedProfiles() });
    }
  }

  list() {
    return this.store.get().profiles;
  }

  get(id) {
    return this.list().find((p) => p.id === id) || this.list()[0];
  }

  /**
   * The account you named, or nothing. Where a request is explicitly *about* one
   * account — run as this one, hand the tab to that one — quietly substituting
   * another is worse than failing: it runs under credentials nobody asked for.
   */
  exactly(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  save(profile) {
    const profiles = this.list().slice();
    const normalized = makeProfile(profile, profiles.length);
    const at = profiles.findIndex((p) => p.id === normalized.id);
    if (at >= 0) profiles[at] = normalized;
    else profiles.push(normalized);
    this.store.set({ profiles });
    return normalized;
  }

  remove(id) {
    const profiles = this.list().filter((p) => p.id !== id);
    // Never leave the app without a profile to launch from.
    this.store.set({ profiles: profiles.length ? profiles : seedProfiles() });
    return this.list();
  }

  reorder(ids) {
    const byId = new Map(this.list().map((p) => [p.id, p]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const p of this.list()) if (!ids.includes(p.id)) ordered.push(p);
    this.store.set({ profiles: ordered });
    return ordered;
  }
}

module.exports = { ProfileStore, discoverAccountDirs, BADGE_COLORS };
