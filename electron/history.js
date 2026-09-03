'use strict';

/**
 * The rules for keeping a record of how sessions have been doing.
 *
 * Two small decisions that are easy to get wrong quietly. *When to keep a
 * sample* — get this wrong in one direction and a week of monitoring is a
 * quarter of a million rows that all say the same thing; wrong in the other and
 * the history has holes exactly where something was happening. And *what normal
 * looks like* across sessions, which is the only thing that makes a number about
 * one session mean anything.
 *
 * Pure, so both can be argued with in a test rather than in production.
 */

/** Keep at most one sample this often, unless something actually changed. */
const SAMPLE_EVERY_MS = 30 * 60 * 1000;

/**
 * Whether this reading is worth keeping alongside the last one.
 *
 * Three reasons, and only three. There is nothing before it. The conversation
 * changed, so this is a different run of the same session and its first reading.
 * The verdict moved, which is the thing a history is read to find. Otherwise it
 * waits, so a quiet afternoon costs a handful of rows rather than a thousand.
 */
function worthSampling(last, now, at) {
  if (!last) return true;
  if ((last.conversation_id ?? null) !== (now.conversationId ?? null)) return true;
  if ((last.worst ?? null) !== (now.worst ?? null)) return true;
  return at - last.at >= SAMPLE_EVERY_MS;
}

/**
 * The middle value, not the average.
 *
 * One session that ran for a week against a million-token window would drag
 * every average up with it and make all the others look healthy by comparison —
 * which is the exact opposite of what a comparison is for.
 */
function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** What a typical session looks like, from every one that has been measured. */
function normsFrom(rows) {
  if (!rows?.length) return null;
  return {
    sessions: rows.length,
    contextShare: median(rows.map((row) => (row.context_window ? row.context_last / row.context_window : 0))),
    effectiveInput: median(rows.map((row) => row.effective_input)),
    output: median(rows.map((row) => row.output_tokens)),
    requests: median(rows.map((row) => row.requests)),
    autoCompactions: median(rows.map((row) => row.auto_compactions)),
  };
}

module.exports = { worthSampling, median, normsFrom, SAMPLE_EVERY_MS };
