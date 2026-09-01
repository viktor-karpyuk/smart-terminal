'use strict';

/**
 * Keeps a session moving on its own.
 *
 * A Claude session spends much of its life stopped at a prompt with nothing left
 * to say — the plan is clear, the next step is obvious, and it is only waiting to
 * be told to go on. That waiting is what this removes. What it deliberately does
 * not remove is the other kind of stop: the one where a person has to decide
 * something. Those are the stops worth having, and answering them automatically
 * would be answering on the user's behalf.
 *
 * The difference is read from Claude's own transcript rather than from the screen.
 * A finished turn is an assistant message with `stop_reason: end_turn`; a pending
 * decision is a tool request with no result after it. The terminal, by contrast,
 * is a wrapped and redrawn TUI that says nothing reliable about either.
 */

/**
 * Claude Code puts some questions on the screen and nowhere else — trusting a
 * folder, approving a plan, its own setup prompts. None of those reach the
 * transcript, so a session showing one still reads as "the turn ended". Typing
 * into that is not a nudge, it is an answer: the text lands in the dialog and the
 * Return picks whatever option is highlighted.
 *
 * So the screen gets a veto. It is only ever used to refuse — a false positive
 * costs a pause the user can end with one keystroke, while a false negative falls
 * back to the transcript, which is the reliable half. Never the other way round.
 */
function looksLikeADecision(screen) {
  if (!screen) return false;
  // Raw output, so strip the escape sequences the terminal would have eaten.
  const text = screen
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[()][A-Z0-9]/g, '');

  // A narrow pane wraps these mid-word, so match the halves, not the phrase.
  if (/to confirm/i.test(text) && /to cancel/i.test(text)) return true;
  // The selection caret sitting on a numbered option. A bare "1. … 2. …" is not
  // enough: Claude writes numbered lists in ordinary answers all the time, and
  // stopping for those would make this useless.
  if (/❯\s*\d+\.\s*\S/.test(text)) return true;
  // A y/n prompt is a prompt, wherever it appears.
  if (/\(y\/n\)/i.test(text)) return true;

  /*
   * What is left is a question written in prose, and those are not all the same
   * thing. "Should I continue?" is precisely the question autopilot exists to
   * answer — stopping there would make it useless, since Claude ends turns that
   * way constantly. "Do you want Postgres or SQLite?" is a decision, and
   * answering it would be answering for the person.
   *
   * So the prose branch defaults to refusing, and only lets a nudge through for
   * a question that asks nothing but leave to carry on. Two things override
   * that, because a carry-on wording can still carry a decision: alternatives on
   * the table, and anything destructive named in the same breath.
   */
  const question = lastQuestion(text);
  if (!question) return false;
  if (!ASKS_THE_PERSON.test(question)) return false;
  if (OFFERS_A_CHOICE.test(question)) return true;
  if (NAMES_SOMETHING_DESTRUCTIVE.test(question)) return true;
  if (ASKS_TO_CARRY_ON.test(question)) return false;
  return true;
}

/**
 * The last question on screen, as a sentence rather than as the whole tail.
 *
 * Wrapping is flattened rather than split on: a narrow pane breaks a sentence
 * across lines mid-word, so a newline is not the end of anything. Sentences are.
 */
function lastQuestion(text) {
  const mark = text.lastIndexOf('?');
  if (mark === -1) return null;
  const chunk = text.slice(Math.max(0, mark - 240), mark + 1).replace(/\s+/g, ' ');
  const start = Math.max(
    chunk.lastIndexOf('\u00bf'),
    chunk.lastIndexOf('. ') + 1,
    chunk.lastIndexOf('! ') + 1,
    0,
  );
  return chunk.slice(start).trim();
}

/** Wording that makes a sentence a question put to the person, in either language. */
const ASKS_THE_PERSON =
  /\b(do you want|would you like|should i|shall i|do you prefer|what would you)\b|\u00bf/i;

/**
 * Alternatives on offer. That is a decision however politely it is phrased, so
 * it outranks the carry-on wording: "shall I continue with X or start over?" is
 * not a request to carry on.
 */
const OFFERS_A_CHOICE = /\bor\b|\bwhich\b|\bcu[a\u00e1]l\b|\bqu[e\u00e9] prefer|\s+o\s+/i;

/**
 * Asking nothing but leave to go on — the one prose question a nudge answers
 * correctly. Kept deliberately narrow; "go ahead" is not on it, because it is
 * how a request to do something irreversible is usually worded.
 */
const ASKS_TO_CARRY_ON =
  /\b(continue|carry on|keep going|proceed|go on|move on)\b|\b(sigo|siga|sigamos|seguimos|segu[i\u00ed]|contin[u\u00fa]o|contin[u\u00fa]a|contin[u\u00fa]amos|avanzo|avanzamos|procedo)\b/i;

/**
 * The safety net. A question can ask for leave to carry on and still be asking
 * to destroy something — "sigo y borro las viejas?" — and that is a decision.
 */
const NAMES_SOMETHING_DESTRUCTIVE =
  /\b(delete|remove|drop|overwrite|reset|revert|discard|force[- ]push|rm -rf|truncate|wipe)\b|\b(borr[ao]|elimin[ao]|sobrescrib|descart|revert)/i;

/** How long a session must be quiet before it counts as stopped rather than slow. */
const QUIET_MS = 6000;
/** How often to look. Cheap: it only reads the tail of one file per session. */
const TICK_MS = 2500;
/**
 * Nudges in a row that produced no tool use. Claude that answers twice without
 * doing anything has run out of work, whatever it says, so stop asking.
 */
const IDLE_NUDGES_BEFORE_STOPPING = 2;

/**
 * Claude's input box does not submit when the text and the Return arrive in the
 * same write — the same reason typing a line and hitting Enter instantly does
 * nothing. The pause is what makes it a line rather than a burst.
 */
const SUBMIT_DELAY_MS = 700;

/** What Claude is asked to say when there is genuinely nothing left. */
const DONE_MARKER = 'AUTOPILOT-DONE';

const NUDGE =
  'Continue with the plan — carry on with the next step without waiting for me. ' +
  'If you need me to decide something, stop and ask instead of guessing. ' +
  `If everything is finished and there is nothing left to do, reply with exactly ${DONE_MARKER} and stop.`;

class Autopilot {
  /**
   * @param {object} deps
   * @param {(sessionId: string) => object|null} deps.readTurn  transcript state for a session
   * @param {(sessionId: string, text: string) => boolean} deps.send  type into the session
   * @param {(sessionId: string) => boolean} deps.isClaudeUp  is Claude the foreground process
   * @param {(sessionId: string, state: object) => void} deps.emit  tell the windows
   */
  constructor({ readTurn, send, isClaudeUp, emit }) {
    this.readTurn = readTurn;
    this.send = send;
    this.isClaudeUp = isClaudeUp;
    this.emit = emit;
    /** sessionId -> { on, lastOutputAt, nudges, idleNudges, lastSeenTurn, state } */
    this.watched = new Map();
    this.timer = null;
  }

  /** Turn it on or off for one session. Always allowed, at any moment. */
  set(sessionId, on) {
    if (!on) {
      this.watched.delete(sessionId);
      this.emit(sessionId, { on: false, state: 'off' });
      if (!this.watched.size) this.stop();
      return;
    }
    const existing = this.watched.get(sessionId);
    this.watched.set(sessionId, {
      on: true,
      lastOutputAt: existing?.lastOutputAt ?? Date.now(),
      nudges: 0,
      idleNudges: 0,
      lastSeenTurn: null,
      screen: existing?.screen ?? '',
      // Switching it on is what starts a run, so it is also what starts a new one
      // after the last finished.
      finished: false,
      state: 'watching',
    });
    this.emit(sessionId, { on: true, state: 'watching' });
    this.start();
  }

  isOn(sessionId) {
    return Boolean(this.watched.get(sessionId)?.on);
  }

  forget(sessionId) {
    if (this.watched.delete(sessionId) && !this.watched.size) this.stop();
  }

  /** Called for every chunk a session prints, so quiet can be measured. */
  noteOutput(sessionId) {
    const entry = this.watched.get(sessionId);
    if (entry) entry.lastOutputAt = Date.now();
  }

  /**
   * What the session is showing, as the terminal itself has it.
   *
   * Reconstructing this from the output stream does not work: a dialog drawn
   * before the session was being watched printed nothing since, so there would be
   * nothing to reconstruct from. The window that renders the session always has
   * the real thing, and sends it whenever the session falls quiet.
   */
  setScreen(sessionId, text) {
    const entry = this.watched.get(sessionId);
    if (entry) entry.screen = text || '';
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = Date.now();
    for (const [sessionId, entry] of this.watched) {
      if (!entry.on) continue;
      /*
       * A finished run stays finished.
       *
       * Reaching `done` used to only change what the tab said: the session was
       * still watched, so the next turn — a turn the person had started
       * themselves, after reading the result — was met with "Continue with the
       * plan", which is the one thing this must never do. Ending the run has to
       * end the driving too. Switching the checkbox off and on starts another.
       */
      if (entry.finished) continue;
      // Still printing, or Claude is not even running: nothing to decide yet.
      if (now - entry.lastOutputAt < QUIET_MS) {
        this.#move(sessionId, entry, 'working');
        continue;
      }
      if (!this.isClaudeUp(sessionId)) {
        this.#move(sessionId, entry, 'watching');
        continue;
      }

      // The screen goes first. A question that lives only there — trusting a
      // folder, approving a plan — leaves no trace in the transcript, so asking the
      // transcript first would call a stopped session "nothing to see" and, worse,
      // would eventually type into the dialog.
      if (looksLikeADecision(entry.screen)) {
        this.#move(sessionId, entry, 'waiting-for-you', { asking: null });
        continue;
      }

      const turn = this.readTurn(sessionId);
      if (!turn) {
        this.#move(sessionId, entry, 'watching');
        continue;
      }

      if (turn.state === 'awaiting-decision') {
        // The one stop worth keeping. Say so loudly and leave it alone.
        this.#move(sessionId, entry, 'waiting-for-you', { asking: turn.asking });
        continue;
      }
      if (turn.state !== 'turn-finished') {
        this.#move(sessionId, entry, 'working');
        continue;
      }
      if (turn.said?.includes(DONE_MARKER)) {
        entry.finished = true;
        this.#move(sessionId, entry, 'done');
        continue;
      }

      // A finished turn we have already answered means the nudge produced another
      // answer and no work. Two of those and there is nothing left to drive.
      // Transcripts carry a uuid per entry, but a turn without one must still be
      // recognisable as one already nudged, or the same finished turn is driven
      // again every few seconds.
      const turnKey = turn.id ?? `said:${turn.said ?? ''}`;
      if (turnKey === entry.lastSeenTurn) continue;
      if (entry.nudges > 0 && !turn.didWork) {
        entry.idleNudges += 1;
        if (entry.idleNudges >= IDLE_NUDGES_BEFORE_STOPPING) {
          entry.finished = true;
          this.#move(sessionId, entry, 'done');
          continue;
        }
      } else {
        entry.idleNudges = 0;
      }

      if (!this.send(sessionId, NUDGE)) continue;
      setTimeout(() => {
        // Still ours to drive? Turning it off in the meantime must win.
        if (this.watched.get(sessionId)?.on) this.send(sessionId, '\r');
      }, SUBMIT_DELAY_MS);
      entry.nudges += 1;
      entry.lastSeenTurn = turnKey;
      // Give it room to start before the quiet clock says it stopped again.
      entry.lastOutputAt = Date.now() + SUBMIT_DELAY_MS;
      if (process.env.SMART_TERMINAL_DEV === '1') {
        console.log(`[autopilot] ${sessionId.slice(0, 8)} told to carry on (nudge ${entry.nudges})`);
      }
      this.#move(sessionId, entry, 'nudged', { nudges: entry.nudges });
    }
  }

  #move(sessionId, entry, state, extra = {}) {
    // A state that has not changed is not news; the UI would re-render for nothing.
    if (entry.state === state && state !== 'nudged') return;
    entry.state = state;
    this.emit(sessionId, { on: true, state, ...extra });
  }
}

module.exports = { Autopilot, DONE_MARKER, NUDGE, QUIET_MS, looksLikeADecision };
