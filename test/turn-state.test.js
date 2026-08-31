const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTurnState } = require('../electron/context-store');

/** Write a transcript out of the entries a real one is made of. */
function transcript(entries) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'st-turn-')),
    'conversation.jsonl',
  );
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const said = (text) => ({
  type: 'assistant',
  uuid: `a-${text.slice(0, 6)}`,
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});
const asked = (name) => ({
  type: 'assistant',
  uuid: `t-${name}`,
  message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name }] },
});
const result = () => ({ type: 'user', uuid: 'r', message: { content: [{ type: 'tool_result' }] } });
const human = (text) => ({ type: 'user', uuid: 'h', message: { content: text } });

test('a finished turn is a session waiting to be told to go on', () => {
  const state = readTurnState(transcript([human('do the thing'), asked('Bash'), result(), said('done')]));
  assert.strictEqual(state.state, 'turn-finished');
  assert.strictEqual(state.didWork, true);
});

test('a tool request with no result is a decision, not an idle prompt', () => {
  // This is the permission prompt sitting on screen. Answering it would be
  // answering for the user, which is the one thing autopilot must never do.
  const state = readTurnState(transcript([human('do the thing'), said('sure'), asked('Bash')]));
  assert.strictEqual(state.state, 'awaiting-decision');
  assert.strictEqual(state.asking, 'Bash');
});

test('a turn that only talked did no work', () => {
  // Twice in a row means the session has run out of things to do, whatever it says.
  const state = readTurnState(transcript([human('what next?'), said('nothing much')]));
  assert.strictEqual(state.state, 'turn-finished');
  assert.strictEqual(state.didWork, false);
});

test("Claude's own bookkeeping entries are not turns", () => {
  const state = readTurnState(
    transcript([
      human('go'),
      asked('Edit'),
      result(),
      said('finished'),
      { type: 'ai-title', message: { content: [{ type: 'text', text: 'a title' }] } },
      { type: 'permission-mode', message: { content: [{ type: 'text', text: 'auto' }] } },
    ]),
  );
  assert.strictEqual(state.state, 'turn-finished');
});

test('a half-written first line does not derail the read', () => {
  const file = transcript([human('go'), asked('Bash'), result(), said('ok')]);
  fs.writeFileSync(file, '{"type":"assis' + fs.readFileSync(file, 'utf8'));
  assert.strictEqual(readTurnState(file).state, 'turn-finished');
});

test('a conversation with no turns yet says nothing', () => {
  assert.strictEqual(readTurnState(transcript([{ type: 'mode' }])), null);
  assert.strictEqual(readTurnState('/nowhere/at/all.jsonl'), null);
});
