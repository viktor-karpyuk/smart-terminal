/**
 * What the sidebar's Jenkins list works out for itself, apart from drawing it.
 *
 * Kept out of the component so it can be tested: the dot a job gets, how long
 * ago a build was, which folders a failing job counts against, and where the
 * panel is, read from what it last remembered.
 */

/** The dot a job gets: what its last build was, and blue while one is going. */
export function jenkinsDot(row: { status: string; running: boolean }): 'ok' | 'warn' | 'bad' | 'run' | 'none' {
  if (row.running) return 'run';
  if (row.status === 'success') return 'ok';
  if (row.status === 'failed') return 'bad';
  if (row.status === 'unstable') return 'warn';
  return 'none';
}

/** "4m", "3h", "2d": how long ago, in as few characters as say it. */
export function agoShort(at: number | null, now = Date.now()): string {
  if (!at) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Every folder above a job: `a/b/c` is under `a` and `a/b`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join('/'));
}

/** Where the panel is, from what it last remembered — so the line for it can be lit. */
export function jenkinsHere(resume: unknown): { type: string | null; path: string | null; number: number | null; kind: string | null; name: string | null; server: string | null } {
  const saved = resume && typeof resume === 'object' ? (resume as { page?: Record<string, unknown>; server?: unknown }) : null;
  const page = saved?.page && typeof saved.page === 'object' ? saved.page : null;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    type: text(page?.type),
    path: text(page?.path),
    number: typeof page?.number === 'number' ? page.number : null,
    kind: text(page?.kind),
    name: text(page?.name),
    // Which Jenkins the panel is on, so the list beside it can be on the same one.
    server: text(saved?.server),
  };
}

/** What a notice is about, read from its words: red for a failure, green for good news, plain otherwise. */
export function ciTone(notice: { title: string }): 'bad' | 'ok' | 'plain' {
  const text = notice.title.toLowerCase();
  if (/\b(failed|is unstable|was aborted|not answering|stuck|offline|waiting for your approval)\b/.test(text)) return 'bad';
  if (/\b(passed|green again|is back|answering again)\b/.test(text)) return 'ok';
  return 'plain';
}
