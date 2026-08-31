import type { Session } from '../state/types';

/**
 * What a session is called in tabs and lists. Three panes all reading "claude"
 * are impossible to tell apart, so the folder is the default identity — it is
 * stable, unlike the title the running program keeps rewriting.
 */
export function sessionLabel(session: Session, homedir = ''): string {
  if (session.customTitle) return session.customTitle;
  if (session.kind === 'login') return 'sign in';
  // The home folder's basename is the username, which says nothing useful.
  if (homedir && session.cwd === homedir) return '~';
  return basename(session.cwd) || session.title;
}

export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export function compactPath(p: string, home: string): string {
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Trim a path from the left, so the folder you are actually in stays readable.
 * CSS ellipsis can only cut the tail, and `direction: rtl` reorders the slashes.
 */
export function truncateStart(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
}

/** Bytes as something a person reads, stepping up the units as it grows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 2 && value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}
