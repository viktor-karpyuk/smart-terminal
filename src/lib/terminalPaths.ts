/**
 * File paths in terminal output, the way a compiler or a test runner prints them.
 *
 * `src/app.ts:12:4`, `./build.gradle`, `/Users/me/x.log:30` — the places output
 * points at, so a click can open them. Deliberately not every word with a dot
 * in it: `example.com`, `e.g.` and `package.json` mentioned in a sentence are
 * not worth an underline, so a bare name counts only with a line number after
 * it, and anything else needs a slash. Whether the file is really there is a
 * separate question, asked before anything is underlined.
 */

export interface FoundPath {
  /** Where the match starts and ends in the line, 0-based, end exclusive. */
  start: number;
  end: number;
  /** The path as printed, without the line and column. */
  path: string;
  line: number | null;
  column: number | null;
}

const SEGMENT = '[\\w.@+-]+';
const PATTERN = new RegExp(
  // Not in the middle of something else, and never the tail of a URL.
  `(?<![\\w/.~:@-])` +
    `((?:~|\\.{1,2})?/?(?:${SEGMENT}/)*${SEGMENT})` +
    `(?::(\\d+)(?::(\\d+))?|\\((\\d+)(?:,\\s*(\\d+))?\\))?`,
  'g',
);

/** Every path-looking thing on one line of output. */
export function findPaths(text: string): FoundPath[] {
  const out: FoundPath[] = [];
  for (const match of text.matchAll(PATTERN)) {
    const raw = match[1];
    const lineText = match[2] ?? match[4];
    const columnText = match[3] ?? match[5];
    const hasSlash = raw.includes('/');
    // A bare word with nothing after it is a word.
    if (!hasSlash && !lineText) continue;
    // A bare word needs an extension to be a file: `foo:12` is a label.
    if (!hasSlash && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(raw)) continue;
    // `/` alone, `..`, or a trailing dot from the end of a sentence.
    const path = raw.replace(/\.+$/, '');
    if (!/[\w@+-]/.test(path) || path === '~') continue;
    const start = match.index ?? 0;
    const trimmed = raw.length - path.length;
    out.push({
      start,
      end: start + match[0].length - (lineText ? 0 : trimmed),
      path,
      line: lineText ? Number(lineText) : null,
      column: columnText ? Number(columnText) : null,
    });
  }
  return out;
}

/** Where a printed path points, given the folder the terminal is in. Null when it cannot be told. */
export function resolvePath(printed: string, cwd: string | null, home: string | null): string | null {
  if (printed.startsWith('~/')) return home ? join(home, printed.slice(2)) : null;
  if (printed.startsWith('/')) return normalise(printed);
  if (!cwd) return null;
  return join(cwd, printed);
}

function join(base: string, rest: string) {
  return normalise(`${base.replace(/\/+$/, '')}/${rest}`);
}

/** Fold `.` and `..` out, so the same file is the same path. */
function normalise(path: string) {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
