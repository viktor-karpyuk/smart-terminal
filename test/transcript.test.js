const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { transcriptPath, locateTranscript } = require('../electron/context-store');

const CONV = '11111111-2222-3333-4444-555555555555';

/** A throwaway account directory plus a real folder for the conversation to belong to. */
function fixture(folderName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-transcript-'));
  const configDir = path.join(root, 'account');
  const cwd = path.join(root, 'work', folderName);
  fs.mkdirSync(cwd, { recursive: true });
  return { root, configDir, cwd };
}

function fileConversation({ configDir, cwd }, body = '{"type":"user"}\n') {
  const file = transcriptPath({ configDir, cwd, claudeSessionId: CONV });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

test('finds a conversation filed under a folder nobody asked about', () => {
  const fx = fixture('k8s');
  const file = fileConversation(fx);
  // The caller only knows a stale folder — the one the session used to be in.
  const found = locateTranscript(fx.configDir, CONV, [path.join(fx.root, 'work', 'elsewhere')]);
  assert.deepStrictEqual(found, { file, cwd: fx.cwd });
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('never reports the stale folder it was handed', () => {
  const fx = fixture('k8s');
  fileConversation(fx);
  const stale = path.join(fx.root, 'work', 'k8s-old');
  fs.mkdirSync(stale);
  assert.notStrictEqual(locateTranscript(fx.configDir, CONV, [stale]).cwd, stale);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('prefers the folder written inside the transcript', () => {
  const fx = fixture('k8s');
  const real = path.join(fx.root, 'work', 'moved');
  fs.mkdirSync(real);
  fileConversation(fx, `${JSON.stringify({ type: 'user', cwd: real })}\n`);
  assert.strictEqual(locateTranscript(fx.configDir, CONV, []).cwd, real);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('rebuilds a folder whose own name contains a dash', () => {
  // `/a/b/k8s-pds` and `/a/b/k8s/pds` encode to the same directory name; only one
  // of them exists, and that is the one to report.
  const fx = fixture('k8s-pds');
  fileConversation(fx);
  assert.strictEqual(locateTranscript(fx.configDir, CONV, []).cwd, fx.cwd);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('reports nothing rather than a guess when the conversation is absent', () => {
  const fx = fixture('k8s');
  fs.mkdirSync(path.join(fx.configDir, 'projects'), { recursive: true });
  assert.strictEqual(locateTranscript(fx.configDir, CONV, [fx.cwd]), null);
  fs.rmSync(fx.root, { recursive: true, force: true });
});
