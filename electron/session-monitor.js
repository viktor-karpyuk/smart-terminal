'use strict';

const fs = require('node:fs');
const { analyze, worstSeverity } = require('./session-analysis');
const { rowsSince } = require('./jsonl-tail');
const { brief, worthCarrying } = require('./session-brief');

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

/**
 * How much conversation the monitor may keep parsed, across every session.
 *
 * Keeping the rows is what stops a sweep re-reading and re-parsing a whole
 * transcript to look at the four turns that are new — a second of the main
 * process every twenty, for a session that has run all day. But parsed rows
 * weigh about one and a quarter times the file they came from, and a workbench
 * that follows a dozen conversations cannot hold all of them, so this is a
 * stated ceiling rather than an accident: the sessions looked at least recently
 * are dropped first, and a dropped one costs what it used to cost, once.
 */
const KEEP_BYTES = 128 * 1024 * 1024;

class SessionMonitor {
  /**
   * @param {object} deps
   * @param {{ transcriptFor(sessionId: string): string | null, trackedIds(): string[] }} deps.context
   * @param {{ saveStats(sessionId: string, verdict: object): void } | null} deps.db
   * @param {(sessionId: string, verdict: object) => void} deps.emit called when a verdict changes
   */
  constructor({ context, db = null, emit = () => {}, conversationOf = null, intervalMs = INTERVAL_MS, keepBytes = KEEP_BYTES }) {
    this.context = context;
    this.db = db;
    this.emit = emit;
    /** Which conversation a session is on, so a restarted one starts its own record. */
    this.conversationOf = conversationOf;
    this.intervalMs = intervalMs;
    this.keepBytes = keepBytes;
    /** sessionId -> { file, size, verdict } — the last reading, and what it came from. */
    this.readings = new Map();
    /*
     * sessionId -> { file, offset, rows } — the conversation, kept parsed.
     *
     * `analyze` genuinely wants every row, so unlike the snapshot loop this one
     * cannot read only the tail and be done. What it can do is stop re-reading
     * and re-parsing the rows it has already seen: a ninety-megabyte transcript
     * was costing a second of the main process every twenty, and throwing away
     * a hundred and ninety megabytes of parsed rows each time to build the same
     * ones again. Kept, they cost what they weigh once.
     */
    this.parsed = new Map();
    /** sessionId -> the compaction times already written down. */
    this.filed = new Map();
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
    this.filed.delete(sessionId);
    this.parsed.delete(sessionId);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The whole conversation, having read only the part of it that is new.
   *
   * The rows are kept between sweeps and appended to. A file that shrank is not
   * the file those rows came from — a session restarted without its conversation
   * gets a new, shorter one — so that starts again from nothing.
   */
  #rowsOf(sessionId, file) {
    const held = this.parsed.get(sessionId);
    const known = held?.file === file ? held : { file, offset: 0, rows: [], bytes: 0 };
    const found = rowsSince(file, known.offset);
    if (!found) return known.rows;
    if (found.restarted) known.rows = found.rows;
    else if (found.rows.length) known.rows = known.rows.concat(found.rows);
    known.offset = found.offset;
    known.bytes = found.size;
    known.readAt = Date.now();
    this.parsed.set(sessionId, known);
    // Set before trimming, so a conversation too big to keep is still returned
    // whole this time — it is only the *next* sweep that pays to read it again.
    this.#trim(sessionId);
    return known.rows;
  }

  /**
   * Keep the ceiling. The session just read is never the one dropped: it is the
   * one certainly being worked in, and dropping it would mean reading it again
   * in twenty seconds.
   */
  #trim(keep) {
    let total = 0;
    for (const held of this.parsed.values()) total += held.bytes;
    if (total <= this.keepBytes) return;
    const order = [...this.parsed.entries()]
      .filter(([sessionId]) => sessionId !== keep)
      .sort((a, b) => (a[1].readAt ?? 0) - (b[1].readAt ?? 0));
    for (const [sessionId, held] of order) {
      this.parsed.delete(sessionId);
      total -= held.bytes;
      if (total <= this.keepBytes) return;
    }
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

    // A transcript only ever grows, so a little more of it is the only reason to
    // skip a re-read. Anything else means it is not the same transcript: a
    // session restarted without its conversation gets a new file — smaller, and
    // under a different name — and "it has not grown enough" would answer for the
    // old one forever.
    const previous = this.readings.get(sessionId);
    const sameFile = previous?.file === file;
    const grewLittle = previous && size >= previous.size && size - previous.size < GROWTH_BYTES;
    if (!force && previous && sameFile && grewLittle) return previous.verdict;

    const rows = this.#rowsOf(sessionId, file);
    if (!rows.length) return { sessionId, ok: false, reason: 'empty' };

    const verdict = analyze(rows);
    const answer = { ...verdict, sessionId, ok: true, worst: worstSeverity(verdict.findings), readAt: Date.now() };
    this.readings.set(sessionId, { file, size, verdict: answer });
    try {
      this.db?.saveStats(sessionId, verdict);
      // And a sample kept beside it, if this one is worth keeping. `saveStats`
      // answers "how is it now" and is overwritten; the history is what makes
      // "compared to what" a question anyone can answer.
      this.db?.noteHistory(sessionId, verdict, this.conversationOf?.(sessionId) ?? null);
      // The same parse, read a second way. What a session would need to be told
      // if it had to start over has to be on hand *before* it is needed — the
      // moment somebody wants it is usually the moment the transcript is gone.
      const carry = brief(rows);
      if (worthCarrying(carry)) this.db?.saveBrief(sessionId, carry);
      this.#recordCompactions(sessionId, verdict, rows);
    } catch {
      /* a verdict is still worth showing even if it could not be filed */
    }
    return answer;
  }

  /**
   * File any compaction not filed yet, with the state as it stood just before it.
   *
   * Reconstructed from the rows before the compaction rather than captured live,
   * which is both easier and better: the transcript is the record, so the answer
   * is exact rather than whatever happened to be sampled at the time.
   *
   * The times already filed are held in memory, so the usual case — every sweep
   * seeing the same compactions again — costs a set lookup and nothing else.
   */
  #recordCompactions(sessionId, verdict, rows) {
    if (!this.db || !verdict.compactions.length) return;
    let known = this.filed.get(sessionId);
    if (!known) {
      known = new Set(this.db.compactionTimes?.(sessionId) ?? []);
      this.filed.set(sessionId, known);
    }

    for (const entry of verdict.compactions) {
      const when = entry.at ?? 0;
      if (known.has(when)) continue;
      const before = entry.index > 0 ? brief(rows.slice(0, entry.index)) : null;
      this.db.noteCompaction(sessionId, entry, before, this.conversationOf?.(sessionId) ?? null);
      known.add(when);
    }
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
    /*
     * Let go of what nobody is following any more.
     *
     * Closing a tab releases the conversation but sends nothing this way, so
     * the rows kept for it stayed held — and when the last tab went, the sweep
     * returned before the ceiling was ever checked again, pinning every one of
     * them until the app quit. Done before the early return, for exactly that
     * case.
     */
    const following = new Set(ids);
    for (const sessionId of this.parsed.keys()) if (!following.has(sessionId)) this.forget(sessionId);
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
 * How far the context on screen may be from the context there is.
 *
 * A share of the window rather than a number of tokens, because the question
 * being asked of that figure is always "how close to the ceiling am I" — and
 * twenty thousand tokens is a fifth of the answer in a small window and nothing
 * at all in a large one.
 */
const CONTEXT_DRIFT = 0.05;

/**
 * Has anything a person would notice changed?
 *
 * Token counts move on every turn and nobody is watching them tick, so most of
 * this is about the verdict: a new finding, one that went away, or one that got
 * worse. That was the whole rule, and it was wrong about the two things this
 * panel puts in the largest type on the page.
 *
 * **A compaction.** It is the one event the panel exists to show, and it is
 * invisible in a list of findings that reads the same either side of it. Six
 * compactions in a real ten-day session, and two of them were never announced:
 * one took the context from 552,000 tokens to 68,000 and the panel went on
 * saying 552,000, because the findings before and after were identical. The
 * number is only ever as fresh as the last thing announced, and that was the
 * moment it mattered most.
 *
 * **Ordinary drift.** The same silence lets the figure grow stale in the other
 * direction — a session climbing steadily produces no new finding until it
 * crosses a threshold, and until then what is on screen is whatever it was an
 * hour ago. So there is a bound on how wrong it is allowed to be.
 *
 * Both are far rarer than a turn. Measured against a session of five thousand
 * nine hundred requests: six announcements for the compactions, and eighty-five
 * for the drift — against the three hundred a "whenever the number moves" rule
 * would have produced in a day.
 */
function worthAnnouncing(before, after) {
  if (!after?.ok) return false;
  if (!before?.ok) return true;
  if (before.worst !== after.worst) return true;
  if ((before.compactions?.length ?? 0) !== (after.compactions?.length ?? 0)) return true;

  const window = after.context?.window ?? 0;
  const moved = Math.abs((after.context?.last ?? 0) - (before.context?.last ?? 0));
  if (window > 0 && moved >= window * CONTEXT_DRIFT) return true;

  const ids = (verdict) => verdict.findings.map((f) => `${f.id}:${f.severity}`).join('|');
  return ids(before) !== ids(after);
}

module.exports = { SessionMonitor, worthAnnouncing, INTERVAL_MS, GROWTH_BYTES, PER_SWEEP, KEEP_BYTES, CONTEXT_DRIFT };
