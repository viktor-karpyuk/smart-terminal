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
