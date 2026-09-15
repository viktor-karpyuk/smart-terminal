/**
 * The rules of moving things about in a folder, kept where both sides can
 * read them: the tree, which asks before it tries, and the store, which has to
 * follow a file to its new name in every place it was known by the old one.
 *
 * Everything in the files panel is keyed by absolute path — the buffers, the
 * open tabs, the expanded folders, the listings. A rename is therefore not
 * one change but a rewrite of every key that started with the old path, and
 * this is the arithmetic of that rewrite.
 */

/** What a name may not be. Null when it is fine. */
export function nameProblem(name: string): string | null {
  const text = String(name ?? '');
  if (!text.trim()) return 'A name is needed.';
  if (text !== text.trim()) return 'A name cannot start or end with a space.';
  if (text === '.' || text === '..') return 'That is not a name.';
  if (/[/\\]/.test(text)) return 'A name cannot contain a slash.';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) return 'A name cannot contain control characters.';
  if (/[:]/.test(text)) return 'A name cannot contain a colon.';
  if (new TextEncoder().encode(text).length > 255) return 'That name is too long.';
  return null;
}

/** The folder a path is in. */
export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return '/';
  return trimmed.slice(0, cut);
}

/** The last part of a path. */
export function baseOf(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? '';
}

/** Whether `child` is `parent` or somewhere under it. */
export function isInside(child: string, parent: string): boolean {
  const base = parent.replace(/\/+$/, '') || '/';
  if (child === base) return true;
  return child.startsWith(base === '/' ? '/' : `${base}/`);
}

/**
 * Where a path is after `from` became `to`: the same path when it was not
 * under `from`, `to` when it was `from`, and `to` plus the rest when it was
 * under it. This is what every keyed thing in the store is run through.
 */
export function movedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}

/** Whether moving `from` into `dir` is a move at all, and a legal one. Null when it is. */
export function moveProblem(from: string, dir: string): string | null {
  if (parentOf(from) === dir) return null;
  if (isInside(dir, from)) return 'A folder cannot be moved into itself.';
  return null;
}
