'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Extensions: the parts of the app that ship with it but do not have to be on.
 *
 * The shape is deliberately the smallest one that is honest. An extension is a
 * folder with a manifest in it; the manifest says what the extension adds; the
 * app keeps a record of which ones are installed and at what version. Nothing
 * more is claimed, and in particular nothing here executes anybody's code — the
 * first thing extensions contribute is file previews, which the app already
 * knows how to render, so installing one turns a renderer on rather than
 * loading a program.
 *
 * That is a real limit and worth saying plainly rather than discovering: today
 * an extension can add what the app can already do, to files it does not yet do
 * it to. Running code that came with an extension is a different problem with a
 * different safety story, and it is not solved by pretending this one solves it.
 *
 * Two places are looked in. The ones in the repository ship with the app and can
 * be turned off but not removed; the ones under the user's data directory are
 * theirs, and can come and go. Everything below is pure apart from the reading.
 */

/** Everything a manifest must have before it is worth listing. */
function validate(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'not an object';
  if (!manifest.id || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) return 'needs a lowercase id';
  if (!manifest.name) return 'needs a name';
  if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) return 'needs a version like 1.2.3';
  return null;
}

/** Read one folder, or say why it could not be read. */
function readManifest(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'extension.json'), 'utf8');
  } catch {
    return null; // not an extension folder; not an error
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    return { broken: true, dir, error: `its manifest is not valid JSON — ${String(error?.message ?? error)}` };
  }
  const wrong = validate(manifest);
  if (wrong) return { broken: true, dir, id: manifest.id, error: `its manifest ${wrong}` };

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author ?? null,
    summary: manifest.summary ?? '',
    description: manifest.description ?? '',
    contributes: manifest.contributes ?? {},
    dir,
  };
}

/** Every extension under a directory, in name order. */
function discover(root, { builtIn = false } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(path.join(root, entry.name));
    if (manifest) found.push({ ...manifest, builtIn });
  }
  return found.sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
}

/**
 * Compare two versions, the small way.
 *
 * Numbers separated by dots, and anything after the third is ignored. Not
 * semver: this decides whether a button says "Update", and the answer only has
 * to be right about which of two numbers came later.
 */
function compareVersions(a, b) {
  const parts = (value) => String(value ?? '0').split(/[.\-+]/).slice(0, 3).map((n) => Number(n) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/**
 * What the gallery shows: every extension, and where it stands.
 *
 * Four states, and they are different questions. *Not installed* is an offer.
 * *Installed* is done. *An update* is the same extension at a version the app
 * has newer than the one that was installed. And *gone* is an extension that was
 * installed and whose folder is no longer there — which must be shown rather
 * than silently dropped, because something is contributing nothing and the
 * person is entitled to know why.
 */
function gallery(available, installed) {
  const byId = new Map(installed.map((row) => [row.id, row]));
  const rows = available.map((manifest) => {
    const record = byId.get(manifest.id);
    const status = !record
      ? 'available'
      : compareVersions(manifest.version, record.version) > 0
        ? 'update'
        : 'installed';
    return {
      ...manifest,
      status,
      installedVersion: record?.version ?? null,
      installedAt: record?.installedAt ?? null,
      enabled: record ? record.enabled !== false : false,
    };
  });

  const seen = new Set(available.map((manifest) => manifest.id));
  for (const record of installed) {
    if (seen.has(record.id)) continue;
    rows.push({
      id: record.id,
      name: record.name ?? record.id,
      version: record.version,
      installedVersion: record.version,
      installedAt: record.installedAt ?? null,
      summary: '',
      description: '',
      contributes: {},
      builtIn: false,
      enabled: record.enabled !== false,
      status: 'gone',
    });
  }
  return rows;
}

/**
 * The preview kinds an installed extension turns on.
 *
 * The app knows how to render each kind; what the extension decides is whether
 * that renderer is offered at all, and for which files. A disabled extension
 * contributes nothing, which is the whole of what "not installed" means here.
 */
function previewRules(rows) {
  const rules = [];
  for (const row of rows) {
    if (row.status === 'available' || row.status === 'gone' || !row.enabled) continue;
    for (const preview of row.contributes?.previews ?? []) {
      if (!preview?.kind) continue;
      rules.push({
        kind: preview.kind,
        extensions: (preview.extensions ?? []).map((value) => String(value).toLowerCase()),
        files: (preview.files ?? []).map((value) => String(value).toLowerCase()),
        prefixes: (preview.prefixes ?? []).map((value) => String(value).toLowerCase()),
      });
    }
  }
  return rules;
}

module.exports = { readManifest, discover, gallery, compareVersions, previewRules, validate };
