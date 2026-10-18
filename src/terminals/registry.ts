import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { featureOn } from './features';
import { findPaths, resolvePath } from '../lib/terminalPaths';

export interface TerminalHandle {
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  lastCols: number;
  lastRows: number;
  /** The GPU renderer, while this terminal is one of the ones holding one. */
  webgl: WebglAddon | null;
  /** Characters handed to xterm and not yet drawn, for flow control. */
  backlog: number;
  /** When this terminal last asked for its program's output to be paused, or 0. */
  pausedAt: number;
  serialize: SerializeAddon;
  /** Output since the screen was last kept. */
  dirty: boolean;
  /** Output that arrived while the last run's screen was being read back, in order. */
  held: string[] | null;
}

/**
 * What the terminal needs to know from the rest of the app, handed in rather
 * than imported: this file knows about terminals and nothing about the store.
 */
interface TerminalHooks {
  /** The folder a terminal's shell is in, for paths printed relative to it. */
  cwdOf(id: string): string | null;
  home: string | null;
  /** Open a file the output pointed at. */
  openPath(id: string, path: string, line: number | null, column: number | null): void;
  /** Pause or resume the program writing into this terminal. */
  flow(id: string, paused: boolean): void;
  /**
   * Whether this terminal's screen is worth keeping across a restart. Not a
   * Claude session's: it resumes its conversation and draws it again itself,
   * and the kept copy above it would be the same thing twice.
   */
  keepsScreen(id: string): boolean;
}

/**
 * How much of a terminal is kept for after a restart.
 *
 * The last thousand rows, which is a few screens of a build and all of most
 * shells — enough to see where things were, without writing megabytes for every
 * session every half-minute. Modes and the alternate screen are left out: they
 * describe the program that was running, and it is not running any more.
 */
const KEPT_ROWS = 1000;
const KEEP_EVERY_MS = 30_000;
/** How long new output waits for the old screen before it is shown anyway. */
const RESTORE_WAIT_MS = 1500;

const hooks: TerminalHooks = {
  cwdOf: () => null,
  home: null,
  openPath: () => {},
  flow: () => {},
  keepsScreen: () => true,
};

export function setTerminalHooks(given: Partial<TerminalHooks>) {
  Object.assign(hooks, given);
}

/**
 * How far behind the screen may fall before the program is asked to wait.
 *
 * xterm parses what it is given in slices between frames, so a program that
 * prints a megabyte a second is never refused — it just piles up, and with
 * enough piled up the window stops answering keys. Past the high mark the pty
 * is paused; once xterm has drawn its way back under the low one it resumes.
 */
const BACKLOG_HIGH = 256 * 1024;
const BACKLOG_LOW = 32 * 1024;
/** A pause lapses in the main process after three seconds; asked again before then. */
const PAUSE_RENEW_MS = 2000;

/** Which absolute paths are files, remembered briefly so hovering a line is not a trip each time. */
const fileCache = new Map<string, { file: boolean; at: number }>();
const FILE_CACHE_MS = 10_000;

async function whichFiles(paths: string[]): Promise<Set<string>> {
  const now = Date.now();
  const unknown = paths.filter((one) => {
    const known = fileCache.get(one);
    return !known || now - known.at > FILE_CACHE_MS;
  });
  if (unknown.length) {
    const found = new Set(await window.api.files.which(unknown).catch(() => [] as string[]));
    for (const one of unknown) fileCache.set(one, { file: found.has(one), at: now });
  }
  return new Set(paths.filter((one) => fileCache.get(one)?.file));
}

/**
 * Whether a paste would run something the moment it lands.
 *
 * A program that asked for bracketed paste — zsh, Claude, any editor — gets
 * the text marked as a paste and decides what to do with it. One that did not
 * reads each newline as Return, so every line runs as it arrives.
 */
function pasteRunsLines(term: Terminal, text: string) {
  return /[\r\n]/.test(text) && !term.modes.bracketedPasteMode;
}

/**
 * Paste, unless the paste would run lines in a program that did not ask for
 * pastes — then ask first, through whatever is listening for the question.
 */
export function guardedPaste(id: string, text: string) {
  const handle = handles.get(id);
  if (!handle || !text) return false;
  if (featureOn('paste-guard') && pasteRunsLines(handle.term, text)) {
    window.dispatchEvent(new CustomEvent('terminal-paste-guard', { detail: { id, text } }));
    return true;
  }
  handle.term.paste(text);
  return true;
}

const handles = new Map<string, TerminalHandle>();

/**
 * How many terminals may draw on the GPU at once.
 *
 * Chromium allows sixteen WebGL contexts per renderer process and no more. Ask
 * for a seventeenth and it does not fail: it quietly takes the *oldest* context
 * away, xterm hears a context loss, and that terminal falls back to the DOM
 * renderer — for good, since the addon used to be disposed and never asked for
 * again, and with nothing on screen to say it happened. Measured at twenty-one
 * terminals: sixteen on the GPU, five demoted, fifteen context-loss events. At
 * eighteen sessions that is not a corner case, it is Tuesday.
 *
 * So the contexts are lent rather than handed out: only terminals actually on a
 * pane hold one, twelve at a time, and the least recently shown gives it up
 * first. Twelve rather than sixteen leaves room for whatever else on the page
 * wants a canvas, and no window fits twelve terminals worth reading anyway.
 */
const MAX_WEBGL = 12;

/** Who holds a context, least recently shown first. */
const webglHolders: string[] = [];

function dropWebgl(id: string) {
  const at = webglHolders.indexOf(id);
  if (at >= 0) webglHolders.splice(at, 1);
  const handle = handles.get(id);
  if (!handle?.webgl) return;
  try {
    handle.webgl.dispose();
  } catch {
    /* already gone with its context */
  }
  handle.webgl = null;
}

/**
 * Give this terminal the GPU, taking it from whoever needs it least.
 *
 * Called when a terminal goes on screen rather than when it is created, because
 * a terminal that nobody is looking at has nothing to draw. A context that is
 * lost anyway is let go and can be asked for again later — the old code disposed
 * the addon for good, so one bad moment cost that terminal the GPU for the rest
 * of the session.
 */
function lendWebgl(id: string) {
  const handle = handles.get(id);
  if (!handle) return;

  const at = webglHolders.indexOf(id);
  if (at >= 0) {
    // Already has one; note that it is the most recently wanted.
    webglHolders.splice(at, 1);
    webglHolders.push(id);
    return;
  }

  while (webglHolders.length >= MAX_WEBGL) dropWebgl(webglHolders[0]);

  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => dropWebgl(id));
    handle.term.loadAddon(webgl);
    handle.webgl = webgl;
    webglHolders.push(id);
  } catch {
    /* no GPU context to be had; the DOM renderer draws it just the same */
  }
}

// Terminals draw to a canvas, so nothing about their size or font is visible in the
// DOM. Development builds expose the handles so they can be inspected directly;
// `import.meta.env.DEV` is compiled away, so this reaches no packaged build.
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__terminals = handles;

/**
 * Off-screen home for terminals that are not currently on a pane. Keeping them in
 * the document (rather than fully detached) means xterm can still measure text,
 * so re-attaching a moved pane never loses the viewport or the scrollback.
 */
let park: HTMLDivElement | null = null;
function parkingLot(): HTMLDivElement {
  if (!park) {
    park = document.createElement('div');
    park.id = 'terminal-parking';
    // `visibility: hidden` rather than merely off-screen: an off-screen element
    // is still painted and composited every frame, and eighteen terminals drawing
    // for nobody is most of what the renderer was doing. Hidden keeps the layout,
    // so xterm can still measure its own text and a re-attached pane comes back
    // the size it was.
    park.style.cssText =
      'position:fixed;left:-100000px;top:0;width:900px;height:600px;overflow:hidden;'
      + 'pointer-events:none;visibility:hidden;';
    document.body.appendChild(park);
  }
  return park;
}

/** How a terminal is drawn: everything the settings decide about it. */
export interface TerminalLook {
  fontSize: number;
  fontFamily: string;
  fontWeight: '300' | '400' | '500';
  lineHeight: number;
  letterSpacing: number;
  cursorBlink: boolean;
  cursorStyle: 'bar' | 'block' | 'underline';
  /**
   * The least contrast a character may have against its background. Programs
   * pick their own colours — Claude's yellows and pale blues among them — and
   * choose them for dark terminals; on a light one xterm nudges just those.
   */
  minimumContrastRatio: number;
  theme: ITheme;
}

/** Bold is one step heavier than whatever regular is. */
const BOLDER = { '300': '500', '400': '600', '500': '700' } as const;

export interface CreateOptions extends TerminalLook {
  scrollback: number;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onTitle: (title: string) => void;
  onBell: () => void;
}

export function ensureTerminal(id: string, options: CreateOptions): TerminalHandle {
  const existing = handles.get(id);
  if (existing) return existing;

  const term = new Terminal({
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    fontWeight: options.fontWeight,
    fontWeightBold: BOLDER[options.fontWeight] ?? '600',
    lineHeight: options.lineHeight,
    letterSpacing: options.letterSpacing,
    cursorBlink: options.cursorBlink,
    cursorStyle: options.cursorStyle,
    minimumContrastRatio: options.minimumContrastRatio,
    scrollback: options.scrollback,
    allowProposedApi: true,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    theme: options.theme,
    smoothScrollDuration: 60,
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault();
    window.api.system.openExternal(uri);
  }));

  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);

  const host = document.createElement('div');
  host.className = 'terminal-host';
  host.dataset.terminalId = id;
  parkingLot().appendChild(host);
  term.open(host);

  /**
   * The right-click menu, raised as an event rather than drawn here.
   *
   * This file knows about terminals and nothing about React, so it says what
   * happened and where, and lets the app decide what a menu looks like. Every
   * terminal gets one by being a terminal — the session tabs and the terminal
   * inside a folder are the same object here, which is exactly why this belongs
   * at this level and not in either of the two components that show one.
   *
   * The selection is read *now*, before anything else can clear it.
   */
  host.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.dispatchEvent(
      new CustomEvent('terminal-menu', {
        detail: {
          id,
          x: event.clientX,
          y: event.clientY,
          selection: term.hasSelection() ? term.getSelection() : '',
        },
      }),
    );
  });

  /**
   * Pasting a picture into something that only reads bytes.
   *
   * A terminal cannot carry an image: on the other end of the pty is a program
   * reading text, and ⌘V of a screenshot has nothing to type — which is why it
   * did nothing at all. What Claude *can* read is a path, so the image is
   * written into the app's own folder and the path is pasted instead. The same
   * gesture, with one step in between that nobody has to think about.
   *
   * Only when there is no text. A copy out of a browser or a design tool puts
   * both flavours on the clipboard, and a person who copied a sentence and got
   * a filename would rightly call that broken — so text wins whenever there is
   * any, and this only takes over when the clipboard holds a picture and
   * nothing else.
   *
   * In the capture phase, because xterm's own paste handler is on the textarea
   * inside this element and would otherwise have already dropped it.
   */
  host.addEventListener(
    'paste',
    (event) => {
      const clipboard = (event as ClipboardEvent).clipboardData;
      if (!clipboard) return;
      const pasted = clipboard.getData('text/plain');
      if (pasted && featureOn('paste-guard') && pasteRunsLines(term, pasted)) {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent('terminal-paste-guard', { detail: { id, text: pasted } }));
        return;
      }
      if (pasted.trim()) return;
      const picture = [...clipboard.items].find((item) => item.type.startsWith('image/'));
      if (!picture) return;
      const file = picture.getAsFile();
      if (!file) return;

      event.preventDefault();
      event.stopPropagation();
      void file
        .arrayBuffer()
        .then((bytes) => window.api.system.saveImage(new Uint8Array(bytes), file.type))
        .then((saved) => {
          if (saved?.ok && saved.file) {
            // A path with a space in it is a path a shell would split, and the
            // prompt on the other side is not always Claude's.
            term.paste(/\s/.test(saved.file) ? `'${saved.file}'` : saved.file);
            return;
          }
          window.dispatchEvent(
            new CustomEvent('terminal-notice', {
              detail: { id, text: saved?.error ?? 'That image could not be saved.' },
            }),
          );
        });
    },
    true,
  );

  /*
   * The Terminal extension's parts that live on the terminal itself. Each is
   * set up for every terminal and asks `featureOn` when it acts, so switching
   * the extension or one of its parts off takes effect at once, without
   * rebuilding a terminal that has a program running in it.
   */

  // Selecting copies — after the drag settles, not on every cell it crosses.
  let copyTimer = 0;
  term.onSelectionChange(() => {
    if (!featureOn('copy-on-select') || !term.hasSelection()) return;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    }, 150);
  });

  // Paths in the output open the file. Only ones that are really there are
  // underlined: a link that opens nothing is worse than no link.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      if (!featureOn('path-links')) return callback(undefined);
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
      const cwd = hooks.cwdOf(id);
      const found = findPaths(text)
        .map((one) => ({ ...one, absolute: resolvePath(one.path, cwd, hooks.home) }))
        .filter((one): one is typeof one & { absolute: string } => Boolean(one.absolute));
      if (!found.length) return callback(undefined);
      void whichFiles(found.map((one) => one.absolute)).then((files) => {
        const links = found
          .filter((one) => files.has(one.absolute))
          .map((one) => ({
            range: { start: { x: one.start + 1, y }, end: { x: one.end, y } },
            text: text.slice(one.start, one.end),
            activate: () => hooks.openPath(id, one.absolute, one.line, one.column),
          }));
        callback(links.length ? links : undefined);
      });
    },
  });

  // Output arriving below where somebody is reading: say so, and offer the way down.
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'terminal-jump';
  jump.textContent = 'New output below';
  jump.hidden = true;
  jump.addEventListener('mousedown', (event) => event.preventDefault());
  jump.addEventListener('click', () => {
    term.scrollToBottom();
    jump.hidden = true;
    term.focus();
  });
  host.appendChild(jump);
  const atBottom = () => term.buffer.active.viewportY >= term.buffer.active.baseY;
  term.onWriteParsed(() => {
    if (jump.hidden && featureOn('jump-to-bottom') && !atBottom()) jump.hidden = false;
  });
  term.onScroll(() => {
    if (!jump.hidden && atBottom()) jump.hidden = true;
  });

  term.onData(options.onData);
  term.onBinary((data) => options.onData(data));
  term.onTitleChange(options.onTitle);
  term.onBell(options.onBell);
  term.onResize(({ cols, rows }) => options.onResize(cols, rows));

  // No GPU renderer yet: it is lent when the terminal goes on a pane. Terminals
  // are born parked, and eighteen of them asking for a context at startup is
  // exactly how the cap gets blown before anything is even on screen.
  const handle: TerminalHandle = {
    id,
    term,
    fit,
    search,
    host,
    lastCols: 0,
    lastRows: 0,
    webgl: null,
    backlog: 0,
    pausedAt: 0,
    serialize,
    dirty: false,
    held: [],
  };
  handles.set(id, handle);
  restoreScreen(handle);
  return handle;
}

/**
 * Put back what this terminal showed before the app restarted, if anything was kept.
 *
 * Asked once, as the terminal is made. Whatever the new shell prints in the
 * meantime is held and written after, so the old screen is above the new
 * prompt rather than torn through it. A file is only there if the Terminal
 * extension was keeping screens; turning that off clears them.
 */
function restoreScreen(handle: TerminalHandle) {
  let settled = false;
  const release = (text: string | null) => {
    if (settled) return;
    settled = true;
    const held = handle.held ?? [];
    handle.held = null;
    if (text) {
      handle.term.write(text);
      handle.term.write('\r\n\x1b[0m\x1b[2m── before the restart ──\x1b[0m\r\n');
    }
    for (const data of held) writeToTerminal(handle.id, data);
  };
  window.setTimeout(() => release(null), RESTORE_WAIT_MS);
  void window.api.pty
    .readScrollback(handle.id)
    .then((text) => release(text || null))
    .catch(() => release(null));
}

/** Keep the screens that changed. On a timer, and once more as the window goes. */
function keepScreens() {
  if (!featureOn('keep-scrollback')) return;
  for (const handle of handles.values()) {
    if (!handle.dirty || !hooks.keepsScreen(handle.id)) continue;
    handle.dirty = false;
    try {
      const text = handle.serialize.serialize({ scrollback: KEPT_ROWS, excludeModes: true, excludeAltBuffer: true });
      if (text.trim()) window.api.pty.saveScrollback(handle.id, text);
    } catch {
      /* a terminal mid-dispose has nothing worth keeping */
    }
  }
}

window.setInterval(() => keepScreens(), KEEP_EVERY_MS);
window.addEventListener('beforeunload', () => keepScreens());

/** Stop keeping screens, and forget the ones kept. */
export function forgetScreens() {
  window.api.pty.clearScrollback();
}

export function getTerminal(id: string) {
  return handles.get(id);
}

export function writeToTerminal(id: string, data: string) {
  const handle = handles.get(id);
  if (!handle) return;
  handle.dirty = true;
  // The last run's screen goes first; anything new waits behind it.
  if (handle.held) {
    handle.held.push(data);
    return;
  }
  if (!featureOn('flow-control')) {
    handle.term.write(data);
    if (handle.pausedAt) {
      handle.pausedAt = 0;
      hooks.flow(id, false);
    }
    return;
  }

  const size = data.length;
  handle.backlog += size;
  handle.term.write(data, () => {
    handle.backlog -= size;
    if (handle.pausedAt && handle.backlog < BACKLOG_LOW) {
      handle.pausedAt = 0;
      hooks.flow(id, false);
    }
  });
  const now = Date.now();
  if (handle.backlog > BACKLOG_HIGH && (!handle.pausedAt || now - handle.pausedAt > PAUSE_RENEW_MS)) {
    handle.pausedAt = now;
    hooks.flow(id, true);
  }
}

export function attachTerminal(id: string, slot: HTMLElement) {
  const handle = handles.get(id);
  if (!handle) return;
  if (handle.host.parentElement !== slot) slot.appendChild(handle.host);
  lendWebgl(id);
  fitTerminal(id);
}

export function parkTerminal(id: string) {
  const handle = handles.get(id);
  if (!handle) return;
  // The GPU goes back before the terminal does: a parked terminal is behind a
  // `visibility: hidden`, so it has nothing to draw and no reason to hold a
  // context somebody on screen wants.
  dropWebgl(id);
  if (handle.host.parentElement !== parkingLot()) parkingLot().appendChild(handle.host);
}

export function fitTerminal(id: string) {
  const handle = handles.get(id);
  if (!handle) return;
  const rect = handle.host.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  try {
    const dims = handle.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    if (dims.cols === handle.lastCols && dims.rows === handle.lastRows) return;
    handle.lastCols = dims.cols;
    handle.lastRows = dims.rows;
    handle.fit.fit();
  } catch {
    /* the pane can be mid-layout; the next resize tick will retry */
  }
}

/**
 * The last few lines on screen, as text. Terminals draw to a canvas, so what a
 * session is showing cannot be read from the document — it has to be asked of
 * xterm's own buffer.
 */
export function readTail(id: string, lines = 40): string {
  const term = handles.get(id)?.term;
  if (!term) return '';
  const buffer = term.buffer.active;
  const end = buffer.baseY + term.rows;
  const out: string[] = [];
  for (let y = Math.max(0, end - lines); y < end; y += 1) {
    out.push(buffer.getLine(y)?.translateToString(true) ?? '');
  }
  return out.join('\n');
}

export function focusTerminal(id: string) {
  handles.get(id)?.term.focus();
}

/**
 * Copy whatever is selected. A terminal's selection lives in xterm, not in the
 * document, so it has to be asked for; anything else on screen is a normal
 * selection and the browser can take it.
 */
/**
 * The terminal the keyboard is actually in.
 *
 * Not the same question as "which tab is active", and that difference is what
 * broke copying in a folder's terminal: the active tab there is the folder
 * panel, so Cmd+C went looking for a terminal under the panel's id, found
 * nothing, and quietly did nothing. A terminal knows when it has focus, so ask
 * it rather than working it out from the layout.
 */
export function focusedTerminalId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof Element)) return null;
  const host = active.closest('.terminal-host[data-terminal-id]');
  return host?.getAttribute('data-terminal-id') ?? null;
}

/**
 * Everything the terminal is holding, as text.
 *
 * The whole scrollback, not the last few lines: "copy the output" means the
 * output, and a person who wanted the last twenty lines can select them. Blank
 * lines at the end are dropped because a terminal is always padded out to its
 * own height and nobody wants forty empty lines pasted.
 */
export function readAll(id: string): string {
  const term = handles.get(id)?.term;
  if (!term) return '';
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.baseY + term.rows; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true).trimEnd() ?? '');
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

/**
 * Put text into a terminal as though it had been typed.
 *
 * `paste` rather than writing to the pty directly: it is the terminal that
 * knows whether the program on the other end asked for bracketed paste, and a
 * shell that gets a multi-line paste without those markers runs every line of
 * it. It also means this works the same for a session and for the terminal in a
 * folder, which have quite different things wired to their output.
 */
export function pasteInto(id: string | null, text: string) {
  if (!id || !text) return false;
  const handle = handles.get(id);
  if (!handle) return false;
  handle.term.paste(text);
  return true;
}

export function copySelection(id: string | null): boolean {
  const term = id ? handles.get(id)?.term : null;
  if (term?.hasSelection()) {
    navigator.clipboard.writeText(term.getSelection());
    return true;
  }
  if (!document.getSelection()?.isCollapsed) {
    document.execCommand('copy');
    return true;
  }
  return false;
}

/**
 * Clear the screen without touching what is running.
 *
 * `clear` rather than `reset`: reset throws away the scrollback and the modes
 * the program on the other end set up, which for a full-screen program like
 * Claude's own interface means it is left drawing into a terminal that no
 * longer agrees with it.
 */
export function clearTerminal(id: string | null) {
  if (!id) return;
  handles.get(id)?.term.clear();
}

export function selectAllIn(id: string | null) {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    // xterm's own helper textarea is never worth selecting.
    if (!active.classList.contains('xterm-helper-textarea')) {
      active.select();
      return;
    }
  }
  if (id) handles.get(id)?.term.selectAll();
}

export function applyAppearance(look: TerminalLook) {
  for (const handle of handles.values()) {
    const options = handle.term.options;
    options.fontSize = look.fontSize;
    options.fontFamily = look.fontFamily;
    options.fontWeight = look.fontWeight;
    options.fontWeightBold = BOLDER[look.fontWeight] ?? '600';
    options.lineHeight = look.lineHeight;
    options.letterSpacing = look.letterSpacing;
    options.cursorBlink = look.cursorBlink;
    options.cursorStyle = look.cursorStyle;
    options.minimumContrastRatio = look.minimumContrastRatio;
    options.theme = look.theme;
    handle.lastCols = 0;
    handle.lastRows = 0;
    fitTerminal(handle.id);
  }
}

/** One terminal's size, for a group that overrides the global setting. */
export function setTerminalFontSize(id: string, fontSize: number) {
  const handle = handles.get(id);
  if (!handle || handle.term.options.fontSize === fontSize) return;
  handle.term.options.fontSize = fontSize;
  handle.lastCols = 0;
  handle.lastRows = 0;
  fitTerminal(id);
}

export function disposeTerminal(id: string) {
  const handle = handles.get(id);
  if (!handle) return;
  dropWebgl(id);
  if (handle.pausedAt) hooks.flow(id, false);
  // Closed for good, so there is nothing to bring back.
  window.api.pty.forgetScrollback(id);
  handle.host.remove();
  handle.term.dispose();
  handles.delete(id);
}

export function announce(id: string, message: string) {
  handles.get(id)?.term.writeln(message);
}
