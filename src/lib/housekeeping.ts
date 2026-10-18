/// <reference path="../global.d.ts" />
/**
 * The housekeeping panel's arithmetic, kept out of the component so it can be
 * tested without a window: which items the one big button takes, how a list is
 * filtered by age and weight, and how a number or an age reads.
 */

const DAY = 86_400_000;

/** Bytes for people: 1.4 GB, 812 MB, 3 KB. The same shape the main process uses. */
export function formatBytes(n: number | null | undefined): string {
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

/** Whole days since a timestamp; null when there is none. */
export function idleDays(at: number | null | undefined, now = Date.now()): number | null {
  if (!Number.isFinite(at as number) || at === null || at === undefined) return null;
  return Math.max(0, Math.floor((now - at) / DAY));
}

/** "today", "3 days", "2 months" — how long something has been left. */
export function describeIdle(at: number | null | undefined, now = Date.now()): string {
  const days = idleDays(at, now);
  if (days === null) return '—';
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 30) return `${days} days`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month' : `${months} months`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year' : `${years} years`;
}

/**
 * What the one button removes: everything that comes back by itself, nothing
 * in the way, and not the newest downloaded update — that one is waiting to be
 * installed, and taking it means downloading it again.
 */
export function freeable(items: HousekeepingItem[]): HousekeepingItem[] {
  return items.filter((one) => one.reversible && one.blockers.length === 0 && !(one.kind === 'installer' && one.state === 'latest'));
}

export interface SessionFilter {
  /** Keep only sessions idle at least this many days; 0 keeps all. */
  olderThanDays: number;
  /** Keep only sessions at least this heavy; 0 keeps all. */
  minBytes: number;
  /** Include the ones still running (shown, never removable). */
  includeOpen: boolean;
}

/** The sessions a filter keeps, the order unchanged. An unknown age never passes an age filter. */
export function filterSessions(items: HousekeepingItem[], filter: SessionFilter, now = Date.now()): HousekeepingItem[] {
  return items.filter((one) => {
    if (one.kind !== 'session') return false;
    if (!filter.includeOpen && one.state === 'open') return false;
    if (filter.minBytes > 0 && one.bytes < filter.minBytes) return false;
    if (filter.olderThanDays > 0) {
      const days = idleDays(one.lastActivityAt, now);
      if (days === null || days < filter.olderThanDays) return false;
    }
    return true;
  });
}

/** The items in one bucket, largest first. */
export function inBucket(items: HousekeepingItem[], bucket: HousekeepingBucket): HousekeepingItem[] {
  return items.filter((one) => one.bucket === bucket);
}

/** Sum of bytes over items — what a selection weighs. */
export function weigh(items: HousekeepingItem[]): number {
  return items.reduce((sum, one) => sum + one.bytes, 0);
}

/** The share of a disk in use, as a whole percentage; null when the disk did not say. */
export function diskUsedPercent(disk: { free: number | null; total: number | null }): number | null {
  if (!disk.total || disk.free === null) return null;
  return Math.round(((disk.total - disk.free) / disk.total) * 100);
}

/**
 * Items with a size that landed, by path, folded into the list without
 * reordering it. A partial size is a walk still going: the number is shown,
 * the row stays marked unmeasured.
 */
export function withSize(items: HousekeepingItem[], path: string, bytes: number, partial = false): HousekeepingItem[] {
  let changed = false;
  const next = items.map((one) => {
    if (one.path !== path) return one;
    changed = true;
    return { ...one, bytes, meta: { ...(one.meta ?? {}), sized: partial ? false : true, partial } };
  });
  return changed ? next : items;
}
