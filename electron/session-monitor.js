'use strict';

const fs = require('node:fs');
const { analyzeFile, worstSeverity } = require('./session-analysis');

/**
 * Watches how every running session is behaving, continuously.
 *
 * A reading you have to ask for arrives too late to be worth much: by the time
 * anyone wonders whether a session has gone bad, it has been bad for an hour and
 * compacted itself twice. So this keeps looking — on a timer, at every session
 * the app is following — and says so the moment a verdict changes.
 *
 * The whole thing rests on a cheap check. A transcript that has not grown cannot
 * have changed its answer, and a `stat` is free next to a parse, so a sweep over
 * twenty idle sessions costs almost nothing and only a session actually working
 * is ever read. Work is capped per sweep on top of that, because the main process
 * also draws the interface and a session on a slow morning is not worth a frame.
 */

/** Long enough that a sweep is never the busiest thing happening. */
const INTERVAL_MS = 20000;

/** Below this much new transcript, the numbers will not have moved enough to matter. */
const GROWTH_BYTES = 8000;

/** How many transcripts one sweep will parse, however many are due. */
const PER_SWEEP = 3;

class SessionMonitor {
  /**
   * @param {object} deps
   * @param {{ transcriptFor(sessionId: string): string | null, trackedIds(): string[] }} deps.context
   * @param {{ saveStats(sessionId: string, verdict: object): void } | null} deps.db
   * @param {(sessionId: string, verdict: object) => void} deps.emit called when a verdict changes
   */
  constructor({ context, db = null, emit = () => {}, intervalMs = INTERVAL_MS }) {
    this.context = context;
    this.db = db;
    this.emit = emit;
    this.intervalMs = intervalMs;
    /** sessionId -> { size, verdict } — the last reading, and what it was read from. */
    this.readings = new Map();
    this.timer = null;
    /** Where the last sweep stopped, so a busy fleet is covered evenly. */
    this.cursor = 0;
  }

  /**
   * The sessions to look at: whichever ones have a conversation being followed.
   *
   * Deliberately borrowed rather than kept. A list of its own would have to be
   * added to and removed from at every place a session starts, ends, moves
   * account or is adopted after being typed by hand — five chances to be wrong
   * about the same fact something else already knows.
   */
  sessions() {
    try {
      return this.context.trackedIds();
    } catch {
      return [];
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Drop what was read for a session that has gone. */
  forget(sessionId) {
    this.readings.delete(sessionId);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The last verdict, without reading anything. What a badge asks for. */
  peek(sessionId) {
    return this.readings.get(sessionId)?.verdict ?? null;
  }

  /**
   * Read one session now.
   *
   * `force` re-parses even when the file has not grown — the panel's Refresh, and
   * the first look a session gets, which has no previous size to compare against.
   */
  read(sessionId, { force = false } = {}) {
    const file = this.context.transcriptFor(sessionId);
    if (!file) return { sessionId, ok: false, reason: 'no-transcript' };

    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { sessionId, ok: false, reason: 'no-transcript' };
    }

    const previous = this.readings.get(sessionId);
    if (!force && previous && size - previous.size < GROWTH_BYTES) return previous.verdict;

    const verdict = analyzeFile(file);
    if (!verdict) return { sessionId, ok: false, reason: 'empty' };

    // The path names the account's config directory and the working tree. The
    // renderer has no use for either, and they are not its business.
    delete verdict.file;
    const answer = { ...verdict, sessionId, ok: true, worst: worstSeverity(verdict.findings) };
    this.readings.set(sessionId, { size, verdict: answer });
    try {
      this.db?.saveStats(sessionId, verdict);
    } catch {
      /* a verdict is still worth showing even if it could not be filed */
    }
    return answer;
  }

  /**
   * One pass over the sessions due for a look.
   *
   * Only a verdict that actually changed is announced. A session working steadily
   * within its means produces the same finding list sweep after sweep, and an
   * interface that redraws on every one of them is worse than one that waits.
   */
  sweep() {
    const ids = this.sessions();
    if (!ids.length) return [];

    const changed = [];
    let done = 0;
    for (let step = 0; step < ids.length && done < PER_SWEEP; step += 1) {
      const sessionId = ids[(this.cursor + step) % ids.length];
      const before = this.readings.get(sessionId);
      let after;
      try {
        after = this.read(sessionId);
      } catch {
        continue; // a transcript mid-write; the next sweep picks it up
      }
      if (!before || after !== before.verdict) {
        done += 1;
        if (worthAnnouncing(before?.verdict ?? null, after)) {
          changed.push(after);
          this.emit(sessionId, after);
        }
      }
    }
    this.cursor = (this.cursor + PER_SWEEP) % Math.max(ids.length, 1);
    return changed;
  }
}

/**
 * Has anything a person would notice changed?
 *
 * Token counts move on every turn and nobody is watching them tick. What matters
 * is the verdict: a new finding, one that went away, or one that got worse.
 */
function worthAnnouncing(before, after) {
  if (!after?.ok) return false;
  if (!before?.ok) return true;
  if (before.worst !== after.worst) return true;
  const ids = (verdict) => verdict.findings.map((f) => `${f.id}:${f.severity}`).join('|');
  return ids(before) !== ids(after);
}

module.exports = { SessionMonitor, worthAnnouncing, INTERVAL_MS, GROWTH_BYTES, PER_SWEEP };
