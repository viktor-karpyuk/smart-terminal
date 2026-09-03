import { marked } from 'marked';

/**
 * Showing a file as it is meant to be read, rather than as it is written.
 *
 * Two kinds, and one rule that covers both: whatever is being previewed goes
 * into a sandboxed frame with scripts turned off. A working tree is full of
 * files nobody wrote to be opened here — a scraped page, a fixture, a
 * half-finished template — and a preview that runs them is a preview that can
 * be made to do things. Rendering is worth having; executing is not.
 *
 * That has a visible cost and it is better stated than discovered: a page's own
 * scripts do not run, and images or stylesheets it loads from beside itself do
 * not appear. The frame has no origin, so it cannot reach the disk. Anything
 * fetched over https still loads.
 */

/** Extensions worth offering a preview for. */
const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mkd']);
const HTML = new Set(['html', 'htm', 'xhtml']);

export type PreviewKind = 'markdown' | 'html' | null;

export function previewKind(path: string): PreviewKind {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (MARKDOWN.has(extension)) return 'markdown';
  if (HTML.has(extension)) return 'html';
  return null;
}

export function previewable(path: string): boolean {
  return previewKind(path) !== null;
}

/**
 * The stylesheet the rendered markdown is read through.
 *
 * Written out rather than borrowed from the app's own: the frame has no origin
 * and cannot reach a stylesheet, and the colours have to be passed in anyway
 * because a frame cannot see the theme it is sitting in.
 */
function styles(dark: boolean): string {
  const ink = dark ? '#c0caf5' : '#2a2f3a';
  const dim = dark ? '#7f8ab0' : '#5d6577';
  const paper = dark ? '#1a1b26' : '#ffffff';
  const rule = dark ? '#2c3049' : '#e3e6ee';
  const inset = dark ? '#20222f' : '#f4f6fa';
  const link = dark ? '#7aa2f7' : '#2f6fdd';

  return `
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    body {
      margin: 0;
      padding: 22px 26px 60px;
      background: ${paper};
      color: ${ink};
      font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      overflow-wrap: break-word;
    }
    h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 0.6em; font-weight: 600; }
    h1 { font-size: 1.7em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
    h1, h2 { border-bottom: 1px solid ${rule}; padding-bottom: 0.3em; }
    p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
    a { color: ${link}; }
    code {
      font-family: "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace;
      font-size: 0.88em;
      background: ${inset};
      padding: 0.15em 0.4em;
      border-radius: 4px;
    }
    pre { background: ${inset}; padding: 12px 14px; border-radius: 7px; overflow-x: auto; }
    pre code { background: none; padding: 0; font-size: 0.86em; }
    blockquote { border-left: 3px solid ${rule}; margin-left: 0; padding-left: 14px; color: ${dim}; }
    table { border-collapse: collapse; width: 100%; font-size: 0.94em; }
    th, td { border: 1px solid ${rule}; padding: 6px 10px; text-align: left; }
    th { background: ${inset}; }
    hr { border: none; border-top: 1px solid ${rule}; margin: 2em 0; }
    img { max-width: 100%; }
    /* A picture that cannot load says so, rather than leaving a gap. */
    img::after {
      content: "image not loaded — the preview cannot read from disk";
      display: block;
      color: ${dim};
      font-size: 11px;
      font-style: italic;
    }
    ul, ol { padding-left: 1.5em; }
    li { margin: 0.25em 0; }
    li > ul, li > ol { margin: 0.25em 0; }
    input[type="checkbox"] { margin-right: 6px; }
  `;
}

/**
 * The document to put in the frame.
 *
 * Markdown is rendered and wrapped in the stylesheet above. HTML is passed
 * through untouched — it is already a document, and a preview that rewrote it
 * would be showing something other than the file. Its own `<style>` applies;
 * anything it loads from beside itself does not.
 */
export function previewDocument(path: string, text: string, dark: boolean): string {
  if (previewKind(path) === 'html') return text;

  const body = marked.parse(text, { async: false, gfm: true, breaks: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${styles(dark)}</style></head><body>${body}</body></html>`;
}
