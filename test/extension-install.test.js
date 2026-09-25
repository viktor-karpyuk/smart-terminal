'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { extract, ArchiveError, LIMITS } = require('../electron/extension-archive');
const { parseRepo, resolve } = require('../electron/extension-source');
const { readIndex } = require('../electron/extension-registry');
const { installer } = require('../electron/extension-installer');
const { gallery, withCatalog, discover } = require('../electron/extensions');

// ── a tar writer, small enough to build hostile archives with ───────────────
function header(name, { size = 0, type = '0', link = '' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(link, 157);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function pax(records, type) {
  const body = Buffer.from(Object.entries(records).map(([k, v]) => {
    let line = ` ${k}=${v}\n`;
    let len = line.length + 2;
    while (String(len).length + line.length !== len) len = String(len).length + line.length;
    return `${len}${line}`;
  }).join(''));
  return [header('pax', { size: body.length, type }), body, Buffer.alloc((512 - (body.length % 512)) % 512)];
}
function tarGz(files, { comment } = {}) {
  const parts = [];
  if (comment) parts.push(...pax({ comment }, 'g'));
  for (const f of files) {
    const data = Buffer.from(f.data ?? '');
    parts.push(header(f.name, { size: f.type && f.type !== '0' ? 0 : data.length, type: f.type ?? '0', link: f.link }));
    if (!f.type || f.type === '0') parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'st-ext-'));
const SHA = 'a'.repeat(40);
const manifest = (over = {}) => JSON.stringify({ id: 'hello', name: 'Hello', version: '1.0.0', permissions: ['git.read'], ...over });

// ── the archive ─────────────────────────────────────────────────────────────
test('unpacks ordinary files, dropping the folder the forge wraps them in', () => {
  const dest = path.join(tmp(), 'x');
  const { files, comment } = extract(tarGz([
    { name: 'owner-repo-abc/', type: '5' },
    { name: 'owner-repo-abc/extension.json', data: manifest() },
    { name: 'owner-repo-abc/views/panel.html', data: '<p>hi</p>' },
  ], { comment: SHA }), dest);
  assert.equal(files, 2);
  assert.equal(comment, SHA);
  assert.equal(fs.readFileSync(path.join(dest, 'views/panel.html'), 'utf8'), '<p>hi</p>');
  assert.equal(fs.statSync(path.join(dest, 'extension.json')).mode & 0o111, 0, 'nothing is executable');
});

test('keeps only the named folder of a repository that holds several extensions', () => {
  const dest = path.join(tmp(), 'x');
  extract(tarGz([
    { name: 'r/README.md', data: 'root' },
    { name: 'r/extensions/hello/extension.json', data: manifest() },
  ]), dest, { subdir: 'extensions/hello' });
  assert.deepEqual(fs.readdirSync(dest), ['extension.json']);
});

for (const [what, files] of [
  ['a symbolic link', [{ name: 'r/evil', type: '2', link: '/etc/passwd' }]],
  ['a hard link', [{ name: 'r/evil', type: '1', link: 'r/extension.json' }]],
  ['a path that climbs out', [{ name: 'r/../../evil.js', data: 'x' }]],
  ['an absolute path', [{ name: '/tmp/evil.js', data: 'x' }]],
  ['a device', [{ name: 'r/dev', type: '3' }]],
]) {
  test(`refuses an archive with ${what}, and writes nothing outside`, () => {
    const base = tmp();
    assert.throws(() => extract(tarGz([{ name: 'r/extension.json', data: manifest() }, ...files]), path.join(base, 'x')), ArchiveError);
    assert.equal(fs.existsSync(path.join(base, 'evil.js')), false);
  });
}

test('refuses what is too big, packed or unpacked', () => {
  const small = { ...LIMITS, file: 100, total: 150 };
  assert.throws(() => extract(tarGz([{ name: 'r/a', data: 'x'.repeat(200) }]), path.join(tmp(), 'x'), { limits: small }), /larger/);
  assert.throws(
    () => extract(tarGz([{ name: 'r/a', data: 'x'.repeat(90) }, { name: 'r/b', data: 'x'.repeat(90) }]), path.join(tmp(), 'x'), { limits: small }),
    /larger unpacked/,
  );
  assert.throws(() => extract(Buffer.from('not gzip'), path.join(tmp(), 'x')), /not a gzipped/);
});

// ── the source ──────────────────────────────────────────────────────────────
test('reads a repository in the ways people paste one', () => {
  assert.deepEqual(parseRepo('https://github.com/ada/lovelace'), { owner: 'ada', repo: 'lovelace', ref: null });
  assert.deepEqual(parseRepo('ada/lovelace.git@v2.0.0'), { owner: 'ada', repo: 'lovelace', ref: 'v2.0.0' });
  assert.deepEqual(parseRepo('github.com/ada/lovelace/releases/tag/v3'), { owner: 'ada', repo: 'lovelace', ref: 'v3' });
  assert.throws(() => parseRepo('https://gitlab.com/ada/lovelace'), /not a GitHub repository/);
  assert.throws(() => parseRepo('nothing'), /not a GitHub repository/);
});

function github({ release = 'v1.0.0', sha = SHA, archive } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => String(body), headers: new Map() });
    if (url.endsWith('/releases/latest')) return release ? json({ tag_name: release }) : json({}, 404);
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return json({ default_branch: 'main' });
    if (url.includes('/commits/')) return json(sha);
    if (url.startsWith('https://codeload.github.com/')) {
      const bytes = archive;
      return {
        ok: true, status: 200, headers: new Map([['content-length', String(bytes.length)]]),
        body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })), cancel: async () => {} }; } },
      };
    }
    return json({}, 404);
  };
  return { fetch, calls };
}

test('a direct install pins the latest release to its commit', async () => {
  const { fetch, calls } = github({ archive: tarGz([]) });
  assert.deepEqual(await resolve(fetch, { owner: 'a', repo: 'b', ref: null }), { sha: SHA, ref: 'v1.0.0', how: 'latest release' });
  assert.ok(calls.some((url) => url.endsWith('/commits/v1.0.0')));
  const noRelease = github({ release: null, archive: tarGz([]) });
  assert.match((await resolve(noRelease.fetch, { owner: 'a', repo: 'b', ref: null })).how, /default branch/);
});

// ── the registry ────────────────────────────────────────────────────────────
test('the registry keeps good entries and says what was wrong with the others', () => {
  const { entries, problems } = readIndex({
    extensions: [
      { id: 'hello', name: 'Hello', version: '1.0.0', repo: 'https://github.com/a/b', commit: SHA, permissions: ['git.read'] },
      { id: 'nopin', name: 'x', version: '1.0.0', repo: 'a/b', commit: 'main' },
      { id: 'greedy', name: 'x', version: '1.0.0', repo: 'a/b', commit: SHA, permissions: ['root'] },
      { id: 'escape', name: 'x', version: '1.0.0', repo: 'a/b', commit: SHA, path: '../x' },
      { id: 'hello', name: 'again', version: '1.0.0', repo: 'a/b', commit: SHA },
    ],
  });
  assert.deepEqual(entries.map((e) => e.id), ['hello']);
  assert.equal(problems.length, 4);
});

// ── the installer ───────────────────────────────────────────────────────────
function setup({ files, listed, builtIns = [] }) {
  const root = tmp();
  const { fetch } = github({ archive: tarGz(files, { comment: SHA }) });
  const entries = listed ? [{ owner: 'a', repoName: 'b', repo: 'https://github.com/a/b', commit: SHA, path: '', ...listed }] : [];
  const registry = { list: async () => ({ entries }) };
  return { root, it: installer({ root, fetch, registry, builtInIds: () => new Set(builtIns) }) };
}

test('inspect shows what it wants and installs nothing; commit installs exactly that', async () => {
  const { root, it } = setup({ files: [{ name: 'r/extension.json', data: manifest() }, { name: 'r/.source.json', data: '{"repo":"https://github.com/fake/fake","reviewed":true}' }] });
  const seen = await it.inspect({ repo: 'a/b' });
  assert.equal(seen.id, 'hello');
  assert.equal(seen.reviewed, false);
  assert.deepEqual(seen.permissions.map((p) => p.name), ['git.read']);
  assert.equal(fs.existsSync(path.join(root, 'hello')), false);
  it.commit(seen.token);
  const source = JSON.parse(fs.readFileSync(path.join(root, 'hello/.source.json'), 'utf8'));
  assert.equal(source.repo, 'https://github.com/a/b', 'the provenance is the app\'s, not the archive\'s');
  assert.equal(source.commit, SHA);
  assert.equal(source.reviewed, false);
  assert.deepEqual(discover(root).map((m) => m.id), ['hello'], 'staging folders are never listed');
  assert.throws(() => it.commit(seen.token), /expired/);
});

test('a registry install is refused when the code does not say what was reviewed', async () => {
  const wrongPerms = setup({ files: [{ name: 'r/extension.json', data: manifest({ permissions: ['git.read', 'git.write'] }) }], listed: { id: 'hello', version: '1.0.0', permissions: ['git.read'] } });
  await assert.rejects(wrongPerms.it.inspect({ id: 'hello' }), /different permissions/);
  const wrongVersion = setup({ files: [{ name: 'r/extension.json', data: manifest({ version: '2.0.0' }) }], listed: { id: 'hello', version: '1.0.0', permissions: ['git.read'] } });
  await assert.rejects(wrongVersion.it.inspect({ id: 'hello' }), /reviewed version 1.0.0/);
  const ok = setup({ files: [{ name: 'r/extension.json', data: manifest() }], listed: { id: 'hello', version: '1.0.0', permissions: ['git.read'] } });
  assert.equal((await ok.it.inspect({ id: 'hello' })).reviewed, true);
  assert.deepEqual(fs.readdirSync(path.join(wrongPerms.root, '.staging')), [], 'a refused download leaves nothing behind');
});

test('an extension cannot take the id of one that ships with the app', async () => {
  const { it } = setup({ files: [{ name: 'r/extension.json', data: manifest({ id: 'code-review' }) }], builtIns: ['code-review'] });
  await assert.rejects(it.inspect({ repo: 'a/b' }), /ships with this app/);
  assert.throws(() => it.uninstall('code-review'), /turned off, not removed/);
});

test('an update names the permissions it adds, and replaces the old copy whole', async () => {
  const { root, it } = setup({ files: [{ name: 'r/extension.json', data: manifest({ version: '2.0.0', permissions: ['git.read', 'git.write'] }) }, { name: 'r/new.txt', data: 'new' }] });
  fs.mkdirSync(path.join(root, 'hello'));
  fs.writeFileSync(path.join(root, 'hello/extension.json'), manifest());
  fs.writeFileSync(path.join(root, 'hello/old.txt'), 'old');
  const seen = await it.inspect({ repo: 'a/b' });
  assert.deepEqual(seen.permissions.filter((p) => p.added).map((p) => p.name), ['git.write']);
  assert.equal(seen.replacing.version, '1.0.0');
  it.commit(seen.token);
  assert.deepEqual(fs.readdirSync(path.join(root, 'hello')).sort(), ['.source.json', 'extension.json', 'new.txt']);
  assert.equal(fs.readdirSync(root).filter((n) => n.startsWith('.trash')).length, 0);
});

test('a repository with no manifest, or a bad one, says so', async () => {
  await assert.rejects(setup({ files: [{ name: 'r/README.md', data: 'x' }] }).it.inspect({ repo: 'a/b' }), /no extension.json/);
  await assert.rejects(setup({ files: [{ name: 'r/extension.json', data: manifest({ permissions: ['everything'] }) }] }).it.inspect({ repo: 'a/b' }), /permissions this app does not have/);
});

// ── the gallery ─────────────────────────────────────────────────────────────
test('the registry adds offers and updates, and never replaces what ships with the app', () => {
  const rows = gallery(
    [
      { id: 'code-review', name: 'CR', version: '1.0.0', builtIn: true, permissions: [] },
      { id: 'hello', name: 'Hello', version: '1.0.0', builtIn: false, permissions: ['git.read'] },
    ],
    [{ id: 'code-review', version: '1.0.0' }, { id: 'hello', version: '1.0.0' }],
  );
  const listed = (id, version) => ({ id, name: id, version, repo: 'https://github.com/a/b', commit: SHA, permissions: [] });
  const out = withCatalog(rows, [listed('code-review', '9.0.0'), listed('hello', '1.1.0'), listed('new-one', '0.1.0')]);
  const byId = Object.fromEntries(out.map((row) => [row.id, row]));
  assert.equal(byId['code-review'].status, 'installed');
  assert.equal(byId.hello.status, 'update');
  assert.equal(byId['new-one'].status, 'available');
  assert.equal(byId['new-one'].remote, true);
});

test('a downloaded panel hears only the pushes it has permission for, and its renderer has no network', () => {
  const { panelViews, previewRules, withSources, NO_NETWORK } = require('../electron/extensions');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'r.js'), 'function render(){return ""}');
  const row = (builtIn, permissions) => ({
    id: builtIn ? 'mine' : 'theirs', status: 'installed', enabled: true, builtIn, permissions, dir,
    contributes: { panels: [{ id: 'p', render: 'p.html', listens: ['review', 'spring'] }], previews: [{ kind: 'k' + builtIn, extensions: ['x'], render: 'r.js' }] },
  });
  const panels = panelViews([row(true, []), row(false, ['review'])]);
  assert.deepEqual(panels.find((p) => p.from === 'mine').listens, ['review', 'spring']);
  assert.deepEqual(panels.find((p) => p.from === 'theirs').listens, ['review']);
  assert.equal(panels.find((p) => p.from === 'theirs').trusted, false);
  const sources = withSources(previewRules([row(true, []), row(false, [])]));
  assert.equal(sources.find((r) => r.from === 'mine').source.startsWith(NO_NETWORK), false);
  assert.equal(sources.find((r) => r.from === 'theirs').source.startsWith(NO_NETWORK), true);
});
