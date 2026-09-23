'use strict';

/**
 * Finding a file by its name, and saying where a link goes.
 *
 * Both of these come from one afternoon: a folder synced from SharePoint had a
 * pitch deck in it that the tree did not show. The tree was right — there were
 * two folders with nearly the same name, one of them a symlink to the live one
 * and the other a copy that had stopped syncing weeks before. Nothing was
 * broken; nothing said which was which, and there was no way to ask "where is
 * that file" without leaving the app.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findInTree, scoreName, listDir } = require('../electron/files');

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'files-find-'));
  const put = (rel, text = 'x') => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    return full;
  };
  put('KS-ERP/Kubrik.io pitch deck.html');
  put('KS-ERP/guion-pitch-newtopia.html');
  put('KS-ERP/Implementation Details/pricing.md');
  put('src/components/GitPanel.tsx');
  put('src/components/FilesPanel.tsx');
  put('src/state/store.ts');
  put('.env');
  put('node_modules/react/index.js');
  put('.git/config');
  fs.mkdirSync(path.join(root, 'KS-ERP/Clients'), { recursive: true });
  return { root, put };
}

const names = (result) => result.results.map((row) => row.relative);

test('a name is found wherever it lives', async () => {
  const { root } = tree();
  try {
    const found = await findInTree(root, 'pitch deck');
    assert.deepStrictEqual(names(found), [path.join('KS-ERP', 'Kubrik.io pitch deck.html')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/*
 * Every word has to appear, which is the whole value of typing two: one word
 * finds both files here, and that is the right answer to one word.
 */
test('two words narrow it; one word does not pretend to', async () => {
  const { root } = tree();
  try {
    assert.strictEqual((await findInTree(root, 'pitch')).results.length, 2);
    assert.strictEqual((await findInTree(root, 'pitch newtopia')).results.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('folders are found too, not only files', async () => {
  const { root } = tree();
  try {
    const found = await findInTree(root, 'clients');
    assert.strictEqual(found.results.length, 1);
    assert.strictEqual(found.results[0].isDirectory, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/*
 * A word the path supplies still counts — `erp pricing` is how somebody who
 * knows where a thing lives asks for it — but the name is what ranks.
 */
test('the folders above a file are searched, and the name still wins', async () => {
  const { root } = tree();
  try {
    const found = await findInTree(root, 'erp pricing');
    assert.deepStrictEqual(names(found), [path.join('KS-ERP', 'Implementation Details', 'pricing.md')]);

    const both = await findInTree(root, 'panel');
    assert.ok(both.results.length >= 2);
    assert.ok(both.results.every((row) => /Panel/.test(row.name)), 'name matches, not folder matches');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an exact name comes before one that merely contains it', async () => {
  const { root, put } = tree();
  try {
    put('a/store.ts');
    put('b/restore-helper.ts');
    const found = await findInTree(root, 'store.ts');
    assert.match(found.results[0].name, /^store\.ts$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/*
 * The two folders that would make this useless: one is most of the bytes on
 * any machine, the other is not a folder anybody means.
 */
test('node_modules and .git are never walked', async () => {
  const { root } = tree();
  try {
    assert.deepStrictEqual(names(await findInTree(root, 'react')), []);
    assert.deepStrictEqual(names(await findInTree(root, 'config')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hidden files are left out until somebody types a dot', async () => {
  const { root } = tree();
  try {
    assert.deepStrictEqual(names(await findInTree(root, 'env')), []);
    assert.deepStrictEqual(names(await findInTree(root, '.env')), ['.env']);
    assert.deepStrictEqual(names(await findInTree(root, 'env', { hidden: true })), ['.env']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nothing typed is nothing looked at', async () => {
  const { root } = tree();
  try {
    const found = await findInTree(root, '   ');
    assert.deepStrictEqual(found.results, []);
    assert.strictEqual(found.scanned, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/*
 * A search that has to be waited for is a search nobody uses. It stops on its
 * own and says it stopped, rather than running to the end of a synced drive.
 */
test('it stops when it has looked at enough, and says so', async () => {
  const { root, put } = tree();
  try {
    for (let i = 0; i < 60; i += 1) put(`wide/file-${i}.txt`);
    const found = await findInTree(root, 'file', { maxEntries: 20 });
    assert.strictEqual(found.cut, true);
    assert.ok(found.scanned <= 80, `scanned ${found.scanned}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a clock that has run out cuts it short too', async () => {
  const { root, put } = tree();
  try {
    for (let i = 0; i < 40; i += 1) put(`wide/file-${i}.txt`);
    let t = 0;
    const found = await findInTree(root, 'file', { maxMs: 5, now: () => (t += 10) });
    assert.strictEqual(found.cut, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- links

test('a link says where it goes, and a folder it points at still opens as one', async () => {
  const { root } = tree();
  try {
    const live = path.join(root, 'KS-ERP');
    fs.symlinkSync(live, path.join(root, 'Shortcut'));
    const entries = await listDir(root);
    const link = entries.find((entry) => entry.name === 'Shortcut');
    assert.ok(link, 'the link is listed');
    assert.strictEqual(link.isDirectory, true, 'it opens like the folder it points at');
    assert.strictEqual(link.link.to, live);
    assert.strictEqual(link.link.broken, false);

    const plain = entries.find((entry) => entry.name === 'src');
    assert.strictEqual(plain.link, null, 'an ordinary folder is not dressed as a link');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/*
 * It used to be dropped from the listing entirely. A name that is there and
 * points at nothing is exactly what somebody needs to be shown.
 */
test('a broken link is shown as broken rather than hidden', async () => {
  const { root } = tree();
  try {
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'Dangling'));
    const entries = await listDir(root);
    const link = entries.find((entry) => entry.name === 'Dangling');
    assert.ok(link, 'it is still listed');
    assert.strictEqual(link.link.broken, true);
    assert.strictEqual(link.isDirectory, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the search does not walk through links, and still finds them', async () => {
  const { root } = tree();
  try {
    fs.symlinkSync(path.join(root, 'KS-ERP'), path.join(root, 'ERP-Shortcut'));
    const found = await findInTree(root, 'shortcut');
    assert.deepStrictEqual(names(found), ['ERP-Shortcut']);
    assert.strictEqual(found.results[0].link, true);
    // Walking it would find the deck twice, under two names.
    const deck = await findInTree(root, 'pitch deck');
    assert.strictEqual(deck.results.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scoring, on its own', () => {
  assert.strictEqual(scoreName('store.ts', 'src/store.ts', ['nothing']), -1);
  assert.ok(scoreName('store.ts', 'a/store.ts', ['store.ts']) > scoreName('restore.ts', 'b/restore.ts', ['store.ts']));
  assert.ok(scoreName('store.ts', 'a/store.ts', ['store']) > scoreName('mystore.ts', 'b/mystore.ts', ['store']));
  // Matched only by a folder above it: found, but below anything named for it.
  assert.strictEqual(scoreName('pricing.md', 'KS-ERP/pricing.md', ['ks-erp']), 0);
});
