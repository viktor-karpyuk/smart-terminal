'use strict';

/**
 * What the housekeeping panel reasons about: things on disk that can be given back.
 *
 * A session's kept conversation, a build cache inside a worktree, a clone the
 * Code Reviewer finished with, a backup of an installation long replaced — to
 * the panel these are one kind of thing. Each has a size, a last sign of life,
 * a reason it may not be touched, and one action that removes it. Keeping them
 * on one shape is what lets the panel add them up, filter them by age, and
 * clear many in one go without a branch per kind.
 *
 * Nothing in here reads the disk. The modules that do hand their findings to
 * `item()` and the panel works with what comes back.
 */

const DAY = 86_400_000;

/**
 * Every kind of item, with whether removing it loses anything.
 *
 * `reversible` means the thing comes back by itself, or was never the only
 * copy: a build cache is rebuilt by the next build, a browser cache by the next
 * page, an installer by the next update. Those can go behind one button. The
 * rest — a session, its conversation, a worktree — is the only copy of
 * something, and every one of them is confirmed on its own.
 */
const KINDS = Object.freeze({
  session: { label: 'Session', bucket: 'sessions', reversible: false },
  'build-cache': { label: 'Build cache', bucket: 'worktrees', reversible: true },
  worktree: { label: 'Worktree', bucket: 'worktrees', reversible: false },
  workshop: { label: 'Review clone', bucket: 'worktrees', reversible: false },
  'db-backup': { label: 'Database backup', bucket: 'app', reversible: true },
  'install-backup': { label: 'Previous installation', bucket: 'app', reversible: true },
  installer: { label: 'Downloaded update', bucket: 'app', reversible: true },
  pasted: { label: 'Pasted image', bucket: 'app', reversible: true },
  'browser-cache': { label: 'Browser cache', bucket: 'app', reversible: true },
  trash: { label: 'Removal in progress', bucket: 'app', reversible: true },
});

/** The buckets the panel groups by, in the order they are shown. */
const BUCKETS = ['sessions', 'worktrees', 'app'];

/**
 * One item, with the fields every kind shares filled in.
 *
 * `blockers` is why it cannot be removed right now, as text a person can act
 * on — "a session is inside it", "changes not committed". An item with a
 * blocker is shown, counted, and refused, which is better than hidden: the
 * number on the panel should be what is there, not what is removable.
 */
function item({ id, kind, label, path = null, bytes = 0, lastActivityAt = null, state = null, blockers = [], detail = null, meta = null }) {
  const known = KINDS[kind];
  if (!known) throw new Error(`Unknown housekeeping item kind: ${kind}`);
  return {
    id,
    kind,
    bucket: known.bucket,
    reversible: known.reversible,
    label,
    path,
    bytes: Math.max(0, Number(bytes) || 0),
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : null,
    state,
    blockers: blockers.filter(Boolean),
    detail,
    meta,
  };
}

/** How many whole days since the item last showed signs of life; null when nobody knows. */
function idleDays(one, now = Date.now()) {
  if (!Number.isFinite(one.lastActivityAt)) return null;
  return Math.max(0, Math.floor((now - one.lastActivityAt) / DAY));
}

/** The items idle for at least `days`. Those with no date are left out: "unknown" is not "old". */
function olderThan(items, days, now = Date.now()) {
  return items.filter((one) => {
    const idle = idleDays(one, now);
    return idle !== null && idle >= days;
  });
}

/** Items nothing stands in the way of. */
function removable(items) {
  return items.filter((one) => one.blockers.length === 0);
}

/** Bytes, items and blocked items per bucket, plus the total — the numbers at the top of the panel. */
function totals(items) {
  const out = { all: { bytes: 0, count: 0, blocked: 0, reversibleBytes: 0 } };
  for (const bucket of BUCKETS) out[bucket] = { bytes: 0, count: 0, blocked: 0, reversibleBytes: 0 };
  for (const one of items) {
    // A cache inside a listed worktree is already inside that worktree's bytes: shown on its own, counted once.
    if (one.meta?.nested) continue;
    for (const key of ['all', one.bucket]) {
      const row = out[key];
      row.bytes += one.bytes;
      row.count += 1;
      if (one.blockers.length) row.blocked += 1;
      else if (one.reversible) row.reversibleBytes += one.bytes;
    }
  }
  return out;
}

/** Largest first, ties broken by the longest idle — the order in which clearing pays. */
function byWeight(items, now = Date.now()) {
  return [...items].sort((a, b) => b.bytes - a.bytes || (idleDays(b, now) ?? -1) - (idleDays(a, now) ?? -1) || a.label.localeCompare(b.label));
}

/** Bytes for people: 1.4 GB, 812 MB, 3 KB. */
function formatBytes(n) {
  const value = Math.max(0, Number(n) || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 ? Math.round(size) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unit]}`;
}

module.exports = { KINDS, BUCKETS, DAY, item, idleDays, olderThan, removable, totals, byWeight, formatBytes };
