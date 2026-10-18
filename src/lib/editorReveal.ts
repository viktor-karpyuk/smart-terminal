/**
 * A line somebody asked to see, waiting for its file's editor.
 *
 * A path clicked in a terminal opens the file and then wants the line, but the
 * editor for it may not exist yet — the file is still being read. So the line
 * is left here, taken by the editor when it mounts, or straight away by one
 * that is already showing that file.
 */
const wantedLines = new Map<string, { line: number; column: number | null; at: number; shown: boolean }>();

/**
 * How long a shown line is still offered to an editor that mounts for the file.
 * A file opened for the first time is shown by one editor and then rebuilt once
 * its text settles; the rebuilt one has to land on the line too.
 */
export const WANTED_FOR_MS = 2000;

export function revealLine(path: string, line: number, column: number | null = null) {
  wantedLines.set(path, { line, column, at: Date.now(), shown: false });
  window.dispatchEvent(new CustomEvent('editor-reveal', { detail: { path } }));
}

/** The line waiting for this file. `mounting`: a fresh editor, which may take one already shown. */
export function wantedLine(path: string, mounting = false) {
  const wanted = wantedLines.get(path);
  if (!wanted) return null;
  if (Date.now() - wanted.at > WANTED_FOR_MS && wanted.shown) {
    wantedLines.delete(path);
    return null;
  }
  return !wanted.shown || mounting ? wanted : null;
}

export function markLineShown(path: string) {
  const wanted = wantedLines.get(path);
  if (wanted) wanted.shown = true;
}
