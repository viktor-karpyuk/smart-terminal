'use strict';

/**
 * What the app does when Claude tells it something.
 *
 * Until now everything the app knew about a session it worked out by reading:
 * the transcript on a timer, the terminal's last lines, the shell's process
 * list. That works, and it is what makes sessions the app did not start
 * legible at all — but it is all inference, and it is all late.
 *
 * Claude Code will simply say. A hook is a program it runs at a named moment,
 * and what that program prints back can change what happens next. This file is
 * the app's side of that: it takes a report, decides what it means, and says
 * what — if anything — should be handed back.
 *
 * Pure on purpose. The socket, the database and the snapshotting are somebody
 * else's job; what is here is the decision, which is the part worth arguing
 * with in a test.
 */

/**
 * The moments worth being told about, and why each one earns its place.
 *
 * Not every hook Claude offers: a hook that fires for every tool call would
 * cost a process per call to tell the app something it can already see. These
 * are the four where the app either learns something it cannot infer, or learns
 * it at a moment that has passed by the time it could have inferred it.
 */
const EVENTS = {
  /**
   * A session started, resumed, was cleared, or came back from a compaction.
   *
   * The one that can *answer*. Whatever this returns is put into the session's
   * context before it says anything — which is what makes a handover something
   * the session simply knows, rather than a paragraph typed into its terminal
   * and answered as though it were a request.
   */
  SessionStart: { answers: true },

  /**
   * A compaction is about to happen.
   *
   * The app already reconstructs compactions from the transcript afterwards, and
   * that reconstruction is exact — the rows before the compaction are still
   * there to be read. What this adds is not the fact but the moment: the app
   * hears at once instead of on its next sweep, is *told* whether it was asked
   * for or automatic rather than inferring it, and is handed the instructions a
   * manual `/compact` was given, which are nowhere in the transcript at all.
   */
  PreCompact: { answers: false },

  /** A turn finished. The moment a session goes from busy to waiting. */
  Stop: { answers: false },

  /** The session is over — told rather than noticed when the shell exits. */
  SessionEnd: { answers: false },
};

/** Where a `SessionStart` came from, as Claude Code reports it. */
const SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Read a report into the handful of things the app acts on.
 *
 * Everything is treated as untrusted and shaped here rather than at the point
 * of use: this arrives over a socket, and a field that is a string in every
 * observed case is still a field somebody could send an object in.
 */
function parseReport(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'a hook report must be an object' };

  const event = text(raw.event);
  if (!EVENTS[event]) return { ok: false, error: `not a hook the app listens for: ${event || '(none)'}` };

  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
  const source = text(payload.source);

  return {
    ok: true,
    event,
    /** The app's own id for the session, from the environment it gave the shell. */
    session: text(raw.session) || null,
    /** Claude's id for the conversation, which is the app's fallback way in. */
    conversation: text(payload.session_id) || null,
    cwd: text(payload.cwd) || text(raw.cwd) || null,
    transcript: text(payload.transcript_path) || null,
    /** `startup`, `resume`, `clear` or `compact` — SessionStart only. */
    source: SOURCES.has(source) ? source : null,
    /** `manual` or `auto` — PreCompact only. */
    trigger: text(payload.trigger) || null,
    /** What a `/compact <instructions>` was told to keep. Nowhere else to read it. */
    instructions: text(payload.custom_instructions) || null,
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
  };
}

/**
 * Whether a fresh context is worth handing a brief.
 *
 * `compact` is the case this exists for: a compaction is the app's own record
 * of what a session was doing surviving something the session itself just lost,
 * and putting it back is the only moment where handing over a summary is
 * strictly better than saying nothing.
 *
 * `startup` is deliberately not on the list. A session starting for the first
 * time has no past to be reminded of, and a brief there would be the app
 * talking to itself.
 */
function wantsBrief(report) {
  return report.event === 'SessionStart' && (report.source === 'compact' || report.source === 'resume' || report.source === 'clear');
}

/**
 * What to say back to Claude.
 *
 * An empty object is a complete and correct answer, and the usual one: most of
 * these events are the app being told something, not being asked. Only
 * `SessionStart` can put words into the session, and only when there is
 * something worth putting there.
 */
function replyFor(report, context) {
  if (!EVENTS[report.event]?.answers) return {};
  const body = String(context ?? '').trim();
  if (!body) return {};
  return {
    hookSpecificOutput: {
      hookEventName: report.event,
      additionalContext: body,
    },
  };
}

/**
 * The line a compaction gets in the app's own record, from what it was told.
 *
 * Separate from the reconstruction the monitor does from the transcript, and
 * deliberately so: this is the half only Claude knows, and merging the two is
 * the caller's business.
 */
function compactionNote(report) {
  if (report.event !== 'PreCompact') return null;
  return {
    at: report.at,
    trigger: report.trigger === 'manual' ? 'manual' : report.trigger === 'auto' ? 'auto' : null,
    instructions: report.instructions,
  };
}

module.exports = { EVENTS, SOURCES, parseReport, replyFor, wantsBrief, compactionNote };
