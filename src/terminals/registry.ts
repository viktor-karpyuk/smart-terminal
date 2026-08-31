import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

export interface TerminalHandle {
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  lastCols: number;
  lastRows: number;
}

const handles = new Map<string, TerminalHandle>();

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
    park.style.cssText =
      'position:fixed;left:-100000px;top:0;width:900px;height:600px;overflow:hidden;pointer-events:none;';
    document.body.appendChild(park);
  }
  return park;
}

export interface CreateOptions {
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  scrollback: number;
  theme: ITheme;
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
    fontWeight: '400',
    fontWeightBold: '600',
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorBlink: options.cursorBlink,
    cursorStyle: 'bar',
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

  const host = document.createElement('div');
  host.className = 'terminal-host';
  host.dataset.terminalId = id;
  parkingLot().appendChild(host);
  term.open(host);

  // WebGL keeps 60fps under Claude Code's redraw-heavy output; fall back quietly
  // if the GPU context is unavailable or gets dropped.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* canvas/DOM renderer is fine, just slower */
  }

  term.onData(options.onData);
  term.onBinary((data) => options.onData(data));
  term.onTitleChange(options.onTitle);
  term.onBell(options.onBell);
  term.onResize(({ cols, rows }) => options.onResize(cols, rows));

  const handle: TerminalHandle = { id, term, fit, search, host, lastCols: 0, lastRows: 0 };
  handles.set(id, handle);
  return handle;
}

export function getTerminal(id: string) {
  return handles.get(id);
}

export function writeToTerminal(id: string, data: string) {
  handles.get(id)?.term.write(data);
}

export function attachTerminal(id: string, slot: HTMLElement) {
  const handle = handles.get(id);
  if (!handle) return;
  if (handle.host.parentElement !== slot) slot.appendChild(handle.host);
  fitTerminal(id);
}

export function parkTerminal(id: string) {
  const handle = handles.get(id);
  if (handle && handle.host.parentElement !== parkingLot()) parkingLot().appendChild(handle.host);
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

export function applyAppearance(
  fontSize: number,
  fontFamily: string,
  cursorBlink: boolean,
  theme: ITheme,
) {
  for (const handle of handles.values()) {
    handle.term.options.fontSize = fontSize;
    handle.term.options.fontFamily = fontFamily;
    handle.term.options.cursorBlink = cursorBlink;
    handle.term.options.theme = theme;
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
  handle.host.remove();
  handle.term.dispose();
  handles.delete(id);
}

export function announce(id: string, message: string) {
  handles.get(id)?.term.writeln(message);
}
