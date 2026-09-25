#!/usr/bin/env node
'use strict';

/**
 * Check a registry index the way the app will read it.
 *
 *   node scripts/validate-registry.js path/to/index.json [--changed-only base.json]
 *
 * For every entry (or only the ones that differ from `base.json`, in a pull
 * request): the entry itself is well formed, the pinned commit downloads, the
 * extension.json in it has the same id, version and permissions the entry
 * claims, and nothing in the archive is something the app would refuse. What it
 * cannot check is whether the code is any good or means well; that is what the
 * pull request review is for, and this prints the link a reviewer should read.
 *
 * Uses the app's own modules, so the registry can never accept something the
 * app would then refuse to install.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readIndex } = require('../electron/extension-registry');
const { download } = require('../electron/extension-source');
const { extract } = require('../electron/extension-archive');
const { readManifest } = require('../electron/extensions');
const { PERMISSIONS } = require('../electron/extension-permissions');

const SHIPPED = new Set(fs.readdirSync(path.join(__dirname, '..', 'extensions')));

async function main() {
  const [file, flag, basePath] = process.argv.slice(2);
  if (!file) {
    console.error('usage: validate-registry.js index.json [--changed-only base.json]');
    process.exit(2);
  }
  const { entries, problems } = readIndex(JSON.parse(fs.readFileSync(file, 'utf8')));
  let failed = problems.length > 0;
  for (const problem of problems) console.log(`✗ ${problem}`);

  let wanted = entries;
  if (flag === '--changed-only' && basePath && fs.existsSync(basePath)) {
    const before = new Map(readIndex(JSON.parse(fs.readFileSync(basePath, 'utf8'))).entries.map((e) => [e.id, JSON.stringify(e)]));
    wanted = entries.filter((entry) => before.get(entry.id) !== JSON.stringify(entry));
  }
  if (!wanted.length) console.log('Nothing new or changed to check.');

  for (const entry of wanted) {
    const label = `${entry.id} ${entry.version}`;
    try {
      if (SHIPPED.has(entry.id)) throw new Error(`"${entry.id}" is the id of an extension that ships with the app`);
      const archive = await download(fetch, { owner: entry.owner, repo: entry.repoName, sha: entry.commit });
      const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-registry-')), entry.id);
      const { comment } = extract(archive, dir, { strip: 1, subdir: entry.path });
      if (comment && /^[0-9a-f]{40}$/.test(comment) && comment !== entry.commit) throw new Error('the archive is not the pinned commit');
      const manifest = readManifest(dir);
      if (!manifest) throw new Error(`no extension.json${entry.path ? ` in ${entry.path}` : ''}`);
      if (manifest.broken) throw new Error(`extension.json ${manifest.error}`);
      if (manifest.id !== entry.id) throw new Error(`the entry says ${entry.id}, the code says ${manifest.id}`);
      if (manifest.version !== entry.version) throw new Error(`the entry says ${entry.version}, the code says ${manifest.version}`);
      const same = manifest.permissions.join(',') === [...entry.permissions].sort().join(',');
      if (!same) throw new Error(`the entry lists [${entry.permissions}], the code asks for [${manifest.permissions}]`);
      console.log(`✓ ${label}`);
      console.log(`    read it: ${entry.repo}/tree/${entry.commit}${entry.path ? `/${entry.path}` : ''}`);
      console.log(`    asks for: ${entry.permissions.length ? entry.permissions.map((p) => `${p} (${PERMISSIONS[p]})`).join('; ') : 'nothing'}`);
    } catch (error) {
      failed = true;
      console.log(`✗ ${label}: ${error.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
