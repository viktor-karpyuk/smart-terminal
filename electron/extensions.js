'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Extensions: the parts of the app that ship with it but do not have to be on.
 *
 * An extension is a folder with a manifest in it. The manifest says what the
 * extension adds; the app keeps a record of which ones are installed and at what
 * version. An extension may also bring its own code — a file that turns the text
 * of a document into HTML — and that is what makes it an extension rather than a
 * switch: the app has no idea how to read a delimited file, and the extension
 * that reads one is what teaches it.
 *
 * This file never runs that code. It reads it and hands it over as text, and the
 * renderer runs it in a worker built from a blob: no DOM, no modules, no
 * filesystem, and no way back into the app. What it returns is put in a frame
 * that runs no scripts. So the worst an extension can do to a document is
 * describe it badly.
 *
 * The one thing that is not shut off is the network — a worker can still fetch.
 * Saying so is better than implying a wall that is not there.
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
        // The file inside the extension that does the rendering, if it brings
        // its own. Without one the kind has to be something the app already
        // knows how to draw.
        render: preview.render ? String(preview.render) : null,
        from: row.id,
        dir: row.dir ?? null,
      });
    }
  }
  return rules;
}

/**
 * The panels an installed extension contributes.
 *
 * A preview turns the text of a file into HTML and stops there. A panel is a
 * different animal: it is a view somebody works in, so it has to react to a
 * click, ask the app a question and get an answer back. That is why a panel
 * brings a whole document rather than a render function — it is shown in a
 * sandboxed frame that runs its scripts in an origin of its own, and talks to
 * the app through messages rather than by reaching into it.
 *
 * `needs: "repository"` is the panel saying what it cannot work without, so the
 * app can say why it is empty instead of drawing an empty thing.
 */
function panelViews(rows) {
  const panels = [];
  for (const row of rows) {
    if (row.status === 'available' || row.status === 'gone' || !row.enabled) continue;
    for (const panel of row.contributes?.panels ?? []) {
      if (!panel?.id || !panel.render) continue;
      panels.push({
        id: String(panel.id),
        title: String(panel.title ?? panel.id),
        summary: String(panel.summary ?? ''),
        needs: panel.needs ? String(panel.needs) : null,
        render: String(panel.render),
        from: row.id,
        dir: row.dir ?? null,
      });
    }
  }
  return panels;
}

/**
 * Read a file an extension brought, refusing anything outside its own folder.
 *
 * Shared by previews and panels because it is the same question both times, and
 * a containment check written twice is a containment check that will one day
 * only be right once.
 */
function readInside(dir, relative) {
  const target = path.resolve(dir, relative);
  if (!target.startsWith(path.resolve(dir) + path.sep)) {
    return { source: null, error: 'it points outside the extension folder' };
  }
  try {
    return { source: fs.readFileSync(target, 'utf8'), error: null };
  } catch (error) {
    return { source: null, error: `it could not be read — ${String(error?.message ?? error)}` };
  }
}

/** The panels, with the document each one is. */
function withPanelSources(panels) {
  return panels.map((panel) => {
    if (!panel.dir) return { ...panel, source: null, error: 'the extension has no folder' };
    const { source, error } = readInside(panel.dir, panel.render);
    return error ? { ...panel, source: null, error } : { ...panel, source };
  });
}

/**
 * Load the code an extension renders with.
 *
 * Read here and handed over as text rather than imported: it is going to be run
 * in a worker built from a blob, which is the only way to give it no DOM, no
 * modules and no way back into the app. A file that cannot be read is reported
 * on the rule rather than dropped — an extension that says it renders something
 * and then does not is worth a sentence on screen.
 */
function withSources(rules) {
  return rules.map((rule) => {
    if (!rule.render || !rule.dir) return { ...rule, source: null };
    // Nothing outside the extension's own folder, whatever the manifest says.
    const { source, error } = readInside(rule.dir, rule.render);
    return error ? { ...rule, source: null, error: `its renderer: ${error}` } : { ...rule, source };
  });
}

module.exports = {
  readManifest,
  discover,
  gallery,
  compareVersions,
  previewRules,
  withSources,
  panelViews,
  withPanelSources,
  validate,
};
