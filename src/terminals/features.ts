import { useSyncExternalStore } from 'react';

/**
 * What the Terminal extension has switched on.
 *
 * The extension names features; the code for each lives here in the app, because
 * the terminal runs in the app's own renderer and no extension code ever runs
 * there. This is the one place the rest of the terminal code asks "is this on?",
 * so turning the extension off — or one feature of it, in Appearance — is a
 * change of answer here and nothing else.
 */

export type TerminalFeature =
  | 'flow-control'
  | 'copy-on-select'
  | 'path-links'
  | 'paste-guard'
  | 'jump-to-bottom'
  | 'keep-scrollback'
  | 'find-options';

/** What each one is called where a person can turn it off. */
export const FEATURE_LABELS: Record<TerminalFeature, { title: string; detail: string }> = {
  'flow-control': {
    title: 'Keep up with fast output',
    detail: 'Pause a program that writes faster than the screen can draw, rather than freeze behind it.',
  },
  'copy-on-select': { title: 'Copy on select', detail: 'Selecting text in a terminal copies it.' },
  'path-links': {
    title: 'Open file paths',
    detail: 'Click a path in the output — src/app.ts:12 — to open the file at that line.',
  },
  'paste-guard': {
    title: 'Ask before a multi-line paste',
    detail: 'Only where each pasted line would run as it lands — a REPL, cat, some ssh shells. zsh and Claude take a paste as a paste.',
  },
  'jump-to-bottom': {
    title: 'New output while scrolled up',
    detail: 'Say when output arrives below where you are reading, with a way back down.',
  },
  'keep-scrollback': {
    title: 'Keep what was on screen',
    detail: 'A terminal comes back after a restart with the output it had.',
  },
  'find-options': { title: 'Find options', detail: 'Match case, whole words or a regular expression.' },
};

let active = new Set<TerminalFeature>();
const listeners = new Set<() => void>();

/** The extension's features, less the ones turned off in settings. */
export function setTerminalFeatures(offered: string[], turnedOff: string[]) {
  const off = new Set(turnedOff);
  const next = new Set(offered.filter((name) => name in FEATURE_LABELS && !off.has(name)) as TerminalFeature[]);
  const same = next.size === active.size && [...next].every((name) => active.has(name));
  active = next;
  if (!same) for (const listen of listeners) listen();
}

export function featureOn(name: TerminalFeature) {
  return active.has(name);
}

/** Told whenever the answer to `featureOn` may have changed. */
export function onFeaturesChanged(listen: () => void) {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}

/** The same question, for a component that should redraw when the answer changes. */
export function useTerminalFeature(name: TerminalFeature) {
  return useSyncExternalStore(onFeaturesChanged, () => active.has(name));
}
