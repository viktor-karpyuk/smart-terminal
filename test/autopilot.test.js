const assert = require('node:assert');
const test = require('node:test');

const { looksLikeADecision } = require('../electron/autopilot');

/*
 * The strings below are transcribed from real Claude Code screens captured in a
 * narrow pane, wrapping and all — that wrapping is exactly what a naive match on
 * the whole phrase gets wrong.
 */

const TRUST_FOLDER = `
 review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;

const AUTO_MODE_SETUP = `
  Teach auto mode about your environment?
  Claude Code reads this project, your recent Claude sessions, a
nd optionally your shell history
es❯ 1. Yes                                                     a
uto 2. Not now                                                 m
ode 3. Don't show again                                        t
akenter to confirm · Esc to cancel                             b
`;

const IDLE_PROMPT = `
❯ Try "how does <filepath> work?"
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`;

const FINISHED_TURN = `
 Paso 1 hecho: creé paso1.txt con el texto "uno".
 Me detengo acá como pediste — los pasos 2, 3 y 4 quedan sin hacer.
❯ Try "edit <filepath> to..."
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

test('the folder-trust dialog stops it', () => {
  assert.strictEqual(looksLikeADecision(TRUST_FOLDER), true);
});

test('a numbered choice list stops it, even wrapped mid-word', () => {
  assert.strictEqual(looksLikeADecision(AUTO_MODE_SETUP), true);
});

test('an empty prompt is not a question', () => {
  assert.strictEqual(looksLikeADecision(IDLE_PROMPT), false);
});

test('a finished turn is not a question', () => {
  assert.strictEqual(looksLikeADecision(FINISHED_TURN), false);
});

test('escape sequences do not hide a question', () => {
  const dressed = '\u001b[1m\u001b[38;5;214m❯ 1. Yes\u001b[0m\n\u001b[2m 2. No\u001b[0m';
  assert.strictEqual(looksLikeADecision(dressed), true);
});

test('nothing on screen is not a reason to stop', () => {
  assert.strictEqual(looksLikeADecision(''), false);
  assert.strictEqual(looksLikeADecision(undefined), false);
});

test('an ordinary numbered answer is not a menu', () => {
  // Claude writes lists like this constantly. Stopping for them would make
  // autopilot stop for almost every turn, which is the same as not having it.
  const answer = `
 Hice tres cosas:
 1. Creé paso1.txt
 2. Creé paso2.txt
 3. Actualicé el README
❯ Try "edit <filepath> to..."
`;
  assert.strictEqual(looksLikeADecision(answer), false);
});

test('the caret on a numbered option is a menu', () => {
  assert.strictEqual(looksLikeADecision('❯ 1. Yes\n  2. No'), true);
});

/*
 * The rules above are about reading a screen. The ones below are about what the
 * run then does, driven through the injected dependencies rather than a real
 * session. `watched` is reached into directly to move the quiet clock back —
 * the alternative is a test that sleeps for six seconds per case.
 */

const { Autopilot, DONE_MARKER } = require('../electron/autopilot');

function harness({ turns }) {
  const sent = [];
  let index = 0;
  const auto = new Autopilot({
    readTurn: () => (typeof turns === 'function' ? turns(index) : turns[Math.min(index, turns.length - 1)]),
    send: (sessionId, text) => {
      sent.push(text);
      return true;
    },
    isClaudeUp: () => true,
    emit: () => {},
  });
  return {
    auto,
    sent,
    /** Let one round pass with the session quiet for long enough to count as stopped. */
    tick(turnIndex = index) {
      index = turnIndex;
      const entry = auto.watched.get('s1');
      if (entry) entry.lastOutputAt = Date.now() - 60_000;
      auto.tick();
    },
    states() {
      return auto.watched.get('s1')?.state;
    },
  };
}

const finished = (id, extra = {}) => ({ state: 'turn-finished', said: '', didWork: true, id, ...extra });

test('a finished turn is told to carry on', () => {
  const h = harness({ turns: [finished('t1')] });
  h.auto.set('s1', true);
  h.tick();
  h.auto.stop();
  assert.strictEqual(h.sent.length, 1);
  assert.match(h.sent[0], /Continue with the plan/);
});

test('the same finished turn is not driven twice', () => {
  const h = harness({ turns: [finished('t1')] });
  h.auto.set('s1', true);
  h.tick();
  h.tick();
  h.tick();
  h.auto.stop();
  assert.strictEqual(h.sent.length, 1);
});

test('a turn carrying no uuid is still only driven once', () => {
  // Falls back to what was said, so a transcript without uuids cannot make this
  // nudge the same stopped turn every few seconds.
  const h = harness({ turns: [finished(null, { said: 'all set' })] });
  h.auto.set('s1', true);
  h.tick();
  h.tick();
  h.auto.stop();
  assert.strictEqual(h.sent.length, 1);
});

test('a question on screen refuses the nudge the transcript would have allowed', () => {
  const h = harness({ turns: [finished('t1')] });
  h.auto.set('s1', true);
  h.auto.setScreen('s1', '❯ 1. Yes\n  2. No');
  h.tick();
  h.auto.stop();
  assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.states(), 'waiting-for-you');
});

/*
 * The regression worth having. Saying "done" used to change only what the tab
 * showed: the session stayed watched, so the next turn — one the person had
 * started themselves, after reading the result — was answered with "Continue
 * with the plan".
 */
test('a run that has finished does not drive the next turn', () => {
  const h = harness({
    turns: [finished('t1', { said: `all done ${DONE_MARKER}` }), finished('t2', { said: 'sure, here it is' })],
  });
  h.auto.set('s1', true);
  h.tick(0);
  assert.strictEqual(h.states(), 'done');
  // The person replies themselves and Claude answers: a brand new finished turn.
  h.tick(1);
  h.auto.stop();
  assert.deepStrictEqual(h.sent, []);
});

test('switching it off and on starts a new run after one has finished', () => {
  const h = harness({
    turns: [finished('t1', { said: `all done ${DONE_MARKER}` }), finished('t2', { said: 'sure, here it is' })],
  });
  h.auto.set('s1', true);
  h.tick(0);
  h.auto.set('s1', false);
  h.auto.set('s1', true);
  h.tick(1);
  h.auto.stop();
  assert.strictEqual(h.sent.length, 1);
});

test('two nudges that produce no work end the run, and it stays ended', () => {
  const h = harness({
    turns: (i) => finished(`t${i}`, { didWork: i === 0 }),
  });
  h.auto.set('s1', true);
  h.tick(0); // first nudge, on a turn that did work
  h.tick(1); // answered without doing anything
  h.tick(2); // and again — that is the end of it
  assert.strictEqual(h.states(), 'done');
  const after = h.sent.length;
  h.tick(3);
  h.auto.stop();
  assert.strictEqual(h.sent.length, after);
});

test('the Return arrives separately from the text, or Claude never sends it', async () => {
  const h = harness({ turns: [finished('t1')] });
  h.auto.set('s1', true);
  h.tick();
  assert.strictEqual(h.sent.length, 1, 'the Return must not ride along with the text');
  await new Promise((resolve) => setTimeout(resolve, 900));
  h.auto.stop();
  assert.deepStrictEqual(h.sent[1], '\r');
});
