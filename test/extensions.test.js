'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readManifest,
  discover,
  gallery,
  compareVersions,
  previewRules,
  panelViews,
  withPanelSources,
  validate,
} = require('../electron/extensions.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-test-'));

function make(name, manifest) {
  const at = path.join(dir, name);
  fs.mkdirSync(at, { recursive: true });
  if (manifest !== null) fs.writeFileSync(path.join(at, 'extension.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return at;
}

// --- what counts as an extension ------------------------------------------

test('a manifest needs an id, a name and a version', () => {
  assert.match(validate({ name: 'x', version: '1.0.0' }), /id/);
  assert.match(validate({ id: 'x', version: '1.0.0' }), /name/);
  assert.match(validate({ id: 'x', name: 'X' }), /version/);
  assert.match(validate({ id: 'X', name: 'X', version: '1.0.0' }), /lowercase/);
  assert.equal(validate({ id: 'x', name: 'X', version: '1.0.0' }), null);
});

test('a folder with no manifest is not an extension, and not an error', () => {
  assert.equal(readManifest(make('plain', null)), null);
});

test('a manifest that will not parse says so instead of vanishing', () => {
  const read = readManifest(make('broken', '{ not json'));
  assert.equal(read.broken, true);
  assert.match(read.error, /not valid JSON/);
});

test('the real manifests in the repository are all valid', () => {
  const found = discover(path.join(__dirname, '..', 'extensions'), { builtIn: true });
  assert.ok(found.length >= 5, `expected the built-ins, found ${found.length}`);
  for (const manifest of found) {
    assert.equal(manifest.broken, undefined, `${manifest.id ?? manifest.dir} is broken`);
    assert.ok(manifest.summary, `${manifest.id} has no summary`);
    const contributes =
      (manifest.contributes.previews?.length ?? 0) + (manifest.contributes.panels?.length ?? 0);
    assert.ok(contributes > 0, `${manifest.id} contributes nothing`);
  }
});

test('a panel says what it is and what file draws it', () => {
  const found = discover(path.join(__dirname, '..', 'extensions'), { builtIn: true });
  for (const manifest of found) {
    for (const panel of manifest.contributes.panels ?? []) {
      assert.ok(panel.id, `${manifest.id} has a panel with no id`);
      assert.ok(panel.title, `${manifest.id}/${panel.id} has no title`);
      assert.ok(panel.render, `${manifest.id}/${panel.id} names no document to draw it`);
      // A panel that needs something must say something the app understands,
      // or it will be offered where it cannot possibly work.
      if (panel.needs) assert.equal(panel.needs, 'repository', `${manifest.id}/${panel.id} needs something unknown`);
    }
  }
});

test('a panel is read as a whole document, and never from outside its folder', () => {
  const rows = discover(path.join(__dirname, '..', 'extensions'), { builtIn: true }).map((manifest) => ({
    ...manifest,
    status: 'installed',
    enabled: true,
  }));
  const panels = withPanelSources(panelViews(rows));
  const graph = panels.find((panel) => panel.id === 'git-graph');
  assert.ok(graph, 'the git graph panel was not found');
  assert.equal(graph.error, undefined, graph.error);
  assert.ok(graph.source.includes('host.ready()'), 'the panel does not talk to the app');

  // The containment check is the one thing here that is a security property
  // rather than a convenience, so it is tested rather than trusted.
  const escaping = withPanelSources([
    { id: 'x', title: 'x', needs: null, render: '../../../etc/passwd', from: 'x', dir: __dirname },
  ]);
  assert.equal(escaping[0].source, null);
  assert.match(escaping[0].error, /outside the extension folder/);
});

// --- versions --------------------------------------------------------------

test('versions compare by number, not by string', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '10 is after 9');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
  assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), 0, 'what comes after the third number is not our business');
});

// --- the gallery -----------------------------------------------------------

const AVAILABLE = [
  { id: 'yaml', name: 'YAML', version: '1.2.0', contributes: { previews: [{ kind: 'yaml', extensions: ['yml'] }] } },
  { id: 'xml', name: 'XML', version: '1.0.0', contributes: { previews: [{ kind: 'xml', extensions: ['xml'] }] } },
];

test('an extension nobody has decided about is an offer', () => {
  const rows = gallery(AVAILABLE, []);
  assert.deepEqual(rows.map((r) => r.status), ['available', 'available']);
  assert.equal(rows[0].enabled, false, 'an offer contributes nothing');
});

test('a newer version on disk than the one installed is an update', () => {
  const rows = gallery(AVAILABLE, [{ id: 'yaml', version: '1.0.0', enabled: true }]);
  const yaml = rows.find((r) => r.id === 'yaml');
  assert.equal(yaml.status, 'update');
  assert.equal(yaml.installedVersion, '1.0.0');
  assert.equal(yaml.version, '1.2.0');
});

test('the same version is simply installed', () => {
  const rows = gallery(AVAILABLE, [{ id: 'xml', version: '1.0.0', enabled: true }]);
  assert.equal(rows.find((r) => r.id === 'xml').status, 'installed');
});

test('an installed extension whose folder is gone is shown, not dropped', () => {
  const rows = gallery(AVAILABLE, [{ id: 'ghost', name: 'Ghost', version: '3.0.0', enabled: true }]);
  const ghost = rows.find((r) => r.id === 'ghost');
  assert.equal(ghost.status, 'gone');
  assert.equal(ghost.name, 'Ghost', 'what was known about it is what there is');
});

// --- what installing actually does ----------------------------------------

test('only installed and enabled extensions contribute rules', () => {
  const rows = gallery(AVAILABLE, [
    { id: 'yaml', version: '1.2.0', enabled: true },
    { id: 'xml', version: '1.0.0', enabled: false },
  ]);
  assert.deepEqual(previewRules(rows).map((r) => r.kind), ['yaml'], 'off means off');
});

test('an extension with an update still contributes, at what it was', () => {
  const rows = gallery(AVAILABLE, [{ id: 'yaml', version: '1.0.0', enabled: true }]);
  assert.deepEqual(previewRules(rows).map((r) => r.kind), ['yaml']);
});

test('nothing installed contributes nothing, and that is not a crash', () => {
  assert.deepEqual(previewRules(gallery(AVAILABLE, [])), []);
  assert.deepEqual(previewRules([]), []);
});

test('rules come back lowercased, since a file name is matched against them', () => {
  const rows = gallery(
    [{ id: 'a', name: 'A', version: '1.0.0', contributes: { previews: [{ kind: 'x', extensions: ['YML'], files: ['Dockerfile'] }] } }],
    [{ id: 'a', version: '1.0.0', enabled: true }],
  );
  assert.deepEqual(previewRules(rows)[0].extensions, ['yml']);
  assert.deepEqual(previewRules(rows)[0].files, ['dockerfile']);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
