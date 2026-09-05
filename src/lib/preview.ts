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
/** Anything angle-bracketed that is read rather than run. */
const XML = new Set([
  'xml', 'xsd', 'xsl', 'xslt', 'rss', 'atom', 'plist', 'pom', 'csproj', 'nuspec', 'wsdl', 'kml', 'gpx',
]);

/** Shells and the things that read like them. */
const SHELL = new Set(['sh', 'bash', 'zsh', 'ksh', 'fish', 'command']);

/**
 * What a file opens as.
 *
 * The names the app draws itself, plus whatever an extension calls its own. The
 * `(string & {})` keeps the known ones offered while leaving the door open: an
 * extension is allowed to invent a kind, and the app is not entitled to a list
 * of every name anyone will ever choose.
 */
export type PreviewKind = 'markdown' | 'html' | 'xml' | 'svg' | 'dockerfile' | 'shell' | 'yaml' | (string & {}) | null;

/**
 * What decides which files a renderer is offered for.
 *
 * Extensions contribute these. The app knows how to draw each kind; what an
 * extension settles is whether that drawing is offered at all, and for what —
 * which is why installing one has an effect without anything being executed.
 */
export type PreviewRule = {
  kind: PreviewKind;
  extensions?: string[];
  files?: string[];
  prefixes?: string[];
};

/**
 * The rules that apply when nothing has said otherwise.
 *
 * A fallback and not a default: the real list comes from the installed
 * extensions. It exists so that a preview asked for before the extensions have
 * been read — the first paint, a test — behaves rather than showing nothing,
 * and so that this file can still be reasoned about on its own.
 */
const BUILT_IN_RULES: PreviewRule[] = [
  { kind: 'markdown', extensions: [...MARKDOWN] },
  { kind: 'html', extensions: [...HTML] },
  { kind: 'svg', extensions: ['svg'] },
  { kind: 'xml', extensions: [...XML] },
  { kind: 'shell', extensions: [...SHELL] },
  { kind: 'yaml', extensions: ['yml', 'yaml'] },
  { kind: 'dockerfile', files: ['dockerfile', 'containerfile'], prefixes: ['dockerfile.'] },
];

export function previewKind(path: string, rules: PreviewRule[] = BUILT_IN_RULES): PreviewKind {
  const file = (path.split('/').pop() ?? path).toLowerCase();
  const extension = file.includes('.') ? file.split('.').pop()! : '';

  // By name before by extension: a Dockerfile has no suffix, and `Dockerfile.dev`
  // would otherwise be matched on `dev`.
  for (const rule of rules) {
    if (rule.files?.includes(file)) return rule.kind;
    if (rule.prefixes?.some((prefix) => file.startsWith(prefix))) return rule.kind;
  }
  for (const rule of rules) {
    if (extension && rule.extensions?.includes(extension)) return rule.kind;
  }
  return null;
}

export function previewable(path: string, rules?: PreviewRule[]): boolean {
  return previewKind(path, rules) !== null;
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
export function previewDocument(path: string, text: string, dark: boolean, openTo = 3, kind = previewKind(path)): string {
  // An SVG and an HTML page are both already documents; anything done to them
  // would be showing something other than the file.
  if (kind === 'html' || kind === 'svg') return text;
  if (kind === 'xml') return xmlDocument(text, dark, openTo);
  if (kind === 'dockerfile' || kind === 'shell') return scriptDocument(text, kind === 'dockerfile' ? 'dockerfile' : 'shell', dark, openTo);
  if (kind === 'yaml') return yamlDocument(text, dark, openTo);

  const body = marked.parse(text, { async: false, gfm: true, breaks: false }) as string;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${styles(dark)}</style></head><body>${body}</body></html>`;
}

/**
 * Reading XML.
 *
 * Written out rather than handed to `DOMParser` for two reasons. A parser
 * refuses a malformed document, and a *viewer* that will not show you a broken
 * file is a viewer that fails exactly when you need it. And the preview is
 * rendered outside the browser as often as inside it — the tests run in node —
 * so it cannot depend on a DOM being there.
 *
 * This is a tokeniser, not a parser: it does not resolve entities, check
 * namespaces or validate anything. It has to be right about where a tag starts
 * and ends and nothing more, which for display is the whole job.
 */

type XmlNode =
  | { kind: 'element'; name: string; attrs: Array<[string, string]>; children: XmlNode[]; empty: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'comment'; text: string }
  | { kind: 'cdata'; text: string }
  | { kind: 'pi'; text: string };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `a="1" b='2' c` — quoted either way, or bare. */
function readAttributes(source: string): Array<[string, string]> {
  const attrs: Array<[string, string]> = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    attrs.push([match[1], match[2] ?? match[3] ?? match[4] ?? '']);
  }
  return attrs;
}

export function parseXml(source: string): XmlNode[] {
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  const put = (node: XmlNode) => {
    const parent = stack[stack.length - 1];
    if (parent && parent.kind === 'element') parent.children.push(node);
    else roots.push(node);
  };

  let at = 0;
  while (at < source.length) {
    const next = source.indexOf('<', at);
    if (next === -1) {
      const text = source.slice(at).trim();
      if (text) put({ kind: 'text', text });
      break;
    }
    const before = source.slice(at, next).trim();
    if (before) put({ kind: 'text', text: before });

    if (source.startsWith('<!--', next)) {
      const end = source.indexOf('-->', next);
      const stop = end === -1 ? source.length : end + 3;
      put({ kind: 'comment', text: source.slice(next + 4, end === -1 ? source.length : end) });
      at = stop;
      continue;
    }
    if (source.startsWith('<![CDATA[', next)) {
      const end = source.indexOf(']]>', next);
      const stop = end === -1 ? source.length : end + 3;
      put({ kind: 'cdata', text: source.slice(next + 9, end === -1 ? source.length : end) });
      at = stop;
      continue;
    }
    if (source.startsWith('<?', next) || source.startsWith('<!', next)) {
      const end = source.indexOf('>', next);
      const stop = end === -1 ? source.length : end + 1;
      put({ kind: 'pi', text: source.slice(next, stop) });
      at = stop;
      continue;
    }

    const end = source.indexOf('>', next);
    if (end === -1) {
      // A tag with no closing bracket: the rest of the file is that tag. Shown
      // as text rather than dropped, because a broken file still has to be read.
      const text = source.slice(next).trim();
      if (text) put({ kind: 'text', text });
      break;
    }
    const inside = source.slice(next + 1, end);
    at = end + 1;

    if (inside.startsWith('/')) {
      const name = inside.slice(1).trim();
      // Close the nearest matching element. A stray close tag is ignored rather
      // than allowed to unwind the whole document.
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        const open = stack[depth];
        if (open.kind === 'element' && open.name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const empty = inside.endsWith('/');
    const body = empty ? inside.slice(0, -1) : inside;
    const space = body.search(/\s/);
    const name = (space === -1 ? body : body.slice(0, space)).trim();
    const attrs = space === -1 ? [] : readAttributes(body.slice(space));
    const node: XmlNode = { kind: 'element', name, attrs, children: [], empty };
    put(node);
    if (!empty) stack.push(node);
  }

  return roots;
}

/** One node as markup. Collapsible through `<details>`, which needs no script. */
function renderNode(node: XmlNode, depth: number, openTo: number): string {
  if (node.kind === 'text') return `<div class="x-text">${escapeHtml(node.text)}</div>`;
  if (node.kind === 'comment') return `<div class="x-comment">&lt;!--${escapeHtml(node.text)}--&gt;</div>`;
  if (node.kind === 'cdata') return `<div class="x-cdata"><em>CDATA</em>${escapeHtml(node.text)}</div>`;
  if (node.kind === 'pi') return `<div class="x-pi">${escapeHtml(node.text)}</div>`;

  const attrs = node.attrs
    .map(([key, value]) => ` <span class="x-attr">${escapeHtml(key)}</span>=<span class="x-value">"${escapeHtml(value)}"</span>`)
    .join('');
  const tag = `<span class="x-name">${escapeHtml(node.name)}</span>${attrs}`;

  if (node.empty || !node.children.length) {
    return `<div class="x-leaf">&lt;${tag}${node.empty ? ' /' : ''}&gt;${node.empty ? '' : `&lt;/<span class="x-name">${escapeHtml(node.name)}</span>&gt;`}</div>`;
  }

  // An element holding nothing but text reads better on one line than as a
  // folder with a single leaf in it.
  const onlyText = node.children.length === 1 && node.children[0].kind === 'text';
  if (onlyText) {
    const text = (node.children[0] as { text: string }).text;
    return `<div class="x-leaf">&lt;${tag}&gt;<span class="x-inline">${escapeHtml(text)}</span>&lt;/<span class="x-name">${escapeHtml(node.name)}</span>&gt;</div>`;
  }

  const inner = node.children.map((child) => renderNode(child, depth + 1, openTo)).join('');
  const count = node.children.filter((child) => child.kind === 'element').length;
  return (
    `<details class="x-node"${depth < openTo ? ' open' : ''}>` +
    `<summary>&lt;${tag}&gt;${count ? `<span class="x-count">${count}</span>` : ''}</summary>` +
    `<div class="x-children">${inner}</div>` +
    `<div class="x-close">&lt;/<span class="x-name">${escapeHtml(node.name)}</span>&gt;</div>` +
    `</details>`
  );
}

/** The stylesheet for the tree. Passed in whole: the frame cannot fetch one. */
function xmlStyles(dark: boolean): string {
  const ink = dark ? '#c0caf5' : '#2a2f3a';
  const paper = dark ? '#1a1b26' : '#ffffff';
  const name = dark ? '#7aa2f7' : '#2f6fdd';
  const attr = dark ? '#bb9af7' : '#8250df';
  const value = dark ? '#9ece6a' : '#3f7f3a';
  const quiet = dark ? '#565f89' : '#8b93a7';
  const rule = dark ? '#2c3049' : '#e3e6ee';
  const inset = dark ? '#20222f' : '#f4f6fa';

  return `
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    body {
      margin: 0;
      padding: 14px 16px 60px;
      background: ${paper};
      color: ${ink};
      font: 12.5px/1.65 "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace;
    }
    .x-name { color: ${name}; }
    .x-attr { color: ${attr}; }
    .x-value { color: ${value}; }
    .x-inline { color: ${ink}; }
    .x-text { color: ${ink}; padding: 1px 0 1px 14px; white-space: pre-wrap; }
    .x-comment { color: ${quiet}; font-style: italic; padding-left: 14px; white-space: pre-wrap; }
    .x-pi { color: ${quiet}; }
    .x-cdata { color: ${ink}; background: ${inset}; border-radius: 4px; padding: 4px 8px; margin: 2px 0 2px 14px; white-space: pre-wrap; }
    .x-cdata em { color: ${quiet}; font-style: normal; margin-right: 8px; }
    .x-leaf { padding: 1px 0; }
    details.x-node { padding: 0; }
    details.x-node > summary { cursor: pointer; list-style: none; padding: 1px 0; border-radius: 3px; }
    details.x-node > summary::-webkit-details-marker { display: none; }
    /* The twisty, drawn rather than borrowed: the default marker cannot be
       positioned and sits at a different offset in every browser. */
    details.x-node > summary::before {
      content: "▸";
      color: ${quiet};
      display: inline-block;
      width: 12px;
      transition: transform 0.1s;
    }
    details.x-node[open] > summary::before { content: "▾"; }
    details.x-node > summary:hover { background: ${inset}; }
    .x-children { margin-left: 12px; padding-left: 8px; border-left: 1px solid ${rule}; }
    .x-close { padding-left: 12px; color: ${quiet}; }
    .x-count {
      margin-left: 8px;
      font-size: 10px;
      color: ${quiet};
      background: ${inset};
      border-radius: 999px;
      padding: 0 6px;
    }
    .x-empty { color: ${quiet}; font-style: italic; }
  `;
}

/** An XML document as a tree that folds, with everything coloured by what it is. */
export function xmlDocument(text: string, dark: boolean, openTo = 3): string {
  const nodes = parseXml(text);
  const body = nodes.length
    ? nodes.map((node) => renderNode(node, 0, openTo)).join('')
    : '<div class="x-empty">Nothing to show — the file is empty.</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${xmlStyles(dark)}</style></head><body>${body}</body></html>`;
}

/**
 * Reading a script.
 *
 * "Preview" means something different here. There is nothing to render — the
 * file *is* the text — so what is on offer is structure: the instruction at the
 * head of each line picked out, comments set back, and the file broken into the
 * sections it already has, each one foldable.
 *
 * Which sections those are is the whole trick, and it is not guesswork: a
 * Dockerfile is divided by its `FROM` lines, because that is what a stage is,
 * and a shell script by its functions and by the banner comments people write
 * to divide one up. Nothing is invented; it is the file's own shape, shown.
 */

/** The instructions a Dockerfile is made of. */
const DOCKER_WORDS = new Set([
  'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT',
  'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL',
]);

/** Words that carry the shape of a shell script rather than its work. */
const SHELL_WORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', 'return', 'exit', 'local', 'export', 'set', 'source', 'trap', 'shift', 'readonly',
]);

type Line = { n: number; text: string };
type Section = { title: string | null; subtitle: string | null; lines: Line[] };

/** A banner comment: `# --- doing the thing ---`, or `#### Setup ####`. */
function bannerOf(text: string): string | null {
  const match = /^\s*#+\s*[-=*#\s]*([A-Za-z][^-=*#]*?)[-=*#\s]*$/.exec(text);
  if (!match) return null;
  const title = match[1].trim();
  return title.length >= 3 && title.length <= 60 ? title : null;
}

/** `name() {`, `function name {`, `function name() {` */
function functionOf(text: string): string | null {
  const match = /^\s*(?:function\s+)?([A-Za-z_][\w:.-]*)\s*\(\s*\)\s*\{?/.exec(text) ?? /^\s*function\s+([A-Za-z_][\w:.-]*)\s*\{/.exec(text);
  return match ? match[1] : null;
}

export function splitScript(text: string, kind: 'dockerfile' | 'shell'): Section[] {
  const lines = text.split('\n').map((line, index) => ({ n: index + 1, text: line }));
  const sections: Section[] = [];
  let current: Section = { title: null, subtitle: null, lines: [] };
  const push = () => {
    if (current.lines.some((line) => line.text.trim())) sections.push(current);
  };

  for (const line of lines) {
    const trimmed = line.text.trim();

    if (kind === 'dockerfile' && /^FROM\s/i.test(trimmed)) {
      push();
      const as = /\sAS\s+([\w.-]+)\s*$/i.exec(trimmed);
      current = { title: as ? `stage: ${as[1]}` : 'stage', subtitle: trimmed.replace(/^FROM\s+/i, ''), lines: [line] };
      continue;
    }

    if (kind === 'shell') {
      const fn = functionOf(line.text);
      if (fn && !trimmed.startsWith('#')) {
        push();
        current = { title: `${fn}()`, subtitle: null, lines: [line] };
        continue;
      }
      const banner = bannerOf(line.text);
      if (banner) {
        push();
        current = { title: banner, subtitle: null, lines: [line] };
        continue;
      }
    }

    current.lines.push(line);
  }
  push();
  return sections;
}

/** One line, with whatever gives it meaning picked out. */
function renderLine(line: Line, kind: 'dockerfile' | 'shell'): string {
  const raw = line.text;
  const trimmed = raw.trim();
  const number = `<span class="s-n">${line.n}</span>`;

  if (!trimmed) return `<div class="s-line">${number}<span class="s-code"> </span></div>`;

  if (trimmed.startsWith('#')) {
    // A shebang is not a comment; it is what runs the file.
    const shebang = line.n === 1 && trimmed.startsWith('#!');
    return `<div class="s-line">${number}<span class="s-code ${shebang ? 's-shebang' : 's-comment'}">${escapeHtml(raw)}</span></div>`;
  }

  const indent = raw.slice(0, raw.length - raw.trimStart().length);
  const first = trimmed.split(/\s+/)[0];
  const rest = trimmed.slice(first.length);

  const known =
    kind === 'dockerfile' ? DOCKER_WORDS.has(first.toUpperCase()) : SHELL_WORDS.has(first.replace(/[;{}]+$/, ''));

  const head = known ? `<span class="s-word">${escapeHtml(first)}</span>` : escapeHtml(first);
  // Quoted strings, in whichever quotes, and nothing cleverer: a shell is not
  // worth tokenising properly to colour it, and guessing wrong looks worse than
  // not trying.
  const body = escapeHtml(rest).replace(/(&quot;[^&]*?&quot;|'[^']*')/g, '<span class="s-str">$1</span>');
  return `<div class="s-line">${number}<span class="s-code">${escapeHtml(indent)}${head}${body}</span></div>`;
}

function scriptStyles(dark: boolean): string {
  const ink = dark ? '#c0caf5' : '#2a2f3a';
  const paper = dark ? '#1a1b26' : '#ffffff';
  const word = dark ? '#7aa2f7' : '#2f6fdd';
  const str = dark ? '#9ece6a' : '#3f7f3a';
  const quiet = dark ? '#565f89' : '#8b93a7';
  const rule = dark ? '#2c3049' : '#e3e6ee';
  const inset = dark ? '#20222f' : '#f4f6fa';
  const mark = dark ? '#bb9af7' : '#8250df';

  return `
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    body {
      margin: 0;
      padding: 10px 0 60px;
      background: ${paper};
      color: ${ink};
      font: 12.5px/1.7 "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace;
    }
    details.s-section { border-bottom: 1px solid ${rule}; }
    details.s-section:last-child { border-bottom: none; }
    details.s-section > summary {
      cursor: pointer;
      list-style: none;
      padding: 5px 16px;
      background: ${inset};
      font-size: 11px;
      color: ${mark};
      position: sticky;
      top: 0;
    }
    details.s-section > summary::-webkit-details-marker { display: none; }
    details.s-section > summary::before { content: "▸ "; color: ${quiet}; }
    details.s-section[open] > summary::before { content: "▾ "; }
    details.s-section > summary em { font-style: normal; color: ${quiet}; margin-left: 8px; }
    .s-body { padding: 4px 0; }
    .s-line { display: flex; white-space: pre; }
    .s-line:hover { background: ${inset}; }
    .s-n {
      flex: none;
      width: 44px;
      padding-right: 12px;
      text-align: right;
      color: ${quiet};
      user-select: none;
      opacity: 0.7;
    }
    .s-code { flex: 1; padding-right: 16px; overflow-wrap: anywhere; white-space: pre-wrap; }
    .s-word { color: ${word}; font-weight: 600; }
    .s-str { color: ${str}; }
    .s-comment { color: ${quiet}; font-style: italic; }
    .s-shebang { color: ${mark}; }
  `;
}

/** A Dockerfile or a shell script, in the sections it already has. */
export function scriptDocument(text: string, kind: 'dockerfile' | 'shell', dark: boolean, openTo = 3): string {
  const sections = splitScript(text, kind);
  const body = sections
    .map((section, index) => {
      const lines = section.lines.map((line) => renderLine(line, kind)).join('');
      if (!section.title) return `<div class="s-body">${lines}</div>`;
      // Everything open unless the file is long enough that folding is the point.
      const open = sections.length <= 3 || index < openTo;
      return (
        `<details class="s-section"${open ? ' open' : ''}>` +
        `<summary>${escapeHtml(section.title)}${section.subtitle ? `<em>${escapeHtml(section.subtitle)}</em>` : ''}</summary>` +
        `<div class="s-body">${lines}</div>` +
        `</details>`
      );
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${scriptStyles(dark)}</style></head><body>${body}</body></html>`;
}

/**
 * Reading YAML.
 *
 * Line by line and by indentation, not by parsing. A real YAML parser is a
 * famous tar pit, and none of its difficulty buys anything here: what makes a
 * compose file or a workflow hard to read is its depth, and depth is written
 * down in the indentation. So this claims only what it can see — where a block
 * begins and ends — and never that it understood the document.
 *
 * The one place that has to be understood is the block scalar. After `key: |`
 * everything more indented is content, not structure, and colouring a shell
 * script inside a workflow as though its lines were YAML keys is the mistake
 * this exists to avoid.
 */

type YamlLine = {
  n: number;
  indent: number;
  text: string;
  kind: 'blank' | 'comment' | 'doc' | 'key' | 'item' | 'raw';
  key?: string;
  value?: string;
  /** This key opens a literal block; what follows it is content. */
  opensBlock?: boolean;
};

type YamlNode = { line: YamlLine; children: YamlNode[] };

const BLOCK_OPENER = /:\s*[|>][-+]?\d*\s*(#.*)?$/;

function classify(text: string, n: number): YamlLine {
  const indent = text.length - text.trimStart().length;
  const trimmed = text.trim();

  if (!trimmed) return { n, indent, text, kind: 'blank' };
  if (trimmed.startsWith('#')) return { n, indent, text, kind: 'comment' };
  if (trimmed === '---' || trimmed === '...' || trimmed.startsWith('--- ')) return { n, indent, text, kind: 'doc' };

  if (trimmed.startsWith('- ') || trimmed === '-') {
    const inner = trimmed.slice(1).trim();
    const pair = /^([^:#]+):(?:\s+(.*))?$/.exec(inner);
    return pair
      ? { n, indent, text, kind: 'item', key: pair[1].trim(), value: (pair[2] ?? '').trim(), opensBlock: BLOCK_OPENER.test(inner) }
      : { n, indent, text, kind: 'item', value: inner };
  }

  const pair = /^([^:#]+):(?:\s+(.*))?$/.exec(trimmed);
  if (pair) {
    return {
      n,
      indent,
      text,
      kind: 'key',
      key: pair[1].trim(),
      value: (pair[2] ?? '').trim(),
      opensBlock: BLOCK_OPENER.test(trimmed),
    };
  }
  return { n, indent, text, kind: 'raw' };
}

export function parseYaml(source: string): YamlNode[] {
  const lines = source.split('\n');
  const roots: YamlNode[] = [];
  /** Open nodes by depth, so a line finds its parent by indentation alone. */
  const stack: YamlNode[] = [];
  let blockUntil = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const line = classify(text, i + 1);

    // Inside a literal block: content, whatever it looks like.
    if (blockUntil >= 0) {
      if (line.kind !== 'blank' && line.indent <= blockUntil) blockUntil = -1;
      else {
        const holder = stack[stack.length - 1];
        const raw: YamlNode = { line: { ...line, kind: 'raw' }, children: [] };
        if (holder) holder.children.push(raw);
        else roots.push(raw);
        continue;
      }
    }

    const node: YamlNode = { line, children: [] };
    // A blank line belongs to whatever it sits inside; it is spacing, not shape.
    while (stack.length && line.kind !== 'blank' && line.indent <= stack[stack.length - 1].line.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);

    if (line.kind !== 'blank') stack.push(node);
    if (line.opensBlock) blockUntil = line.indent;
  }

  return roots;
}

/** One value, coloured by what it plainly is rather than by what it means. */
function yamlValue(value: string): string {
  if (!value) return '';
  if (value.startsWith('#')) return `<span class="y-comment">${escapeHtml(value)}</span>`;

  const [head, rest] = splitTrailingComment(value);
  const body = head.trim();
  const comment = rest === undefined ? '' : ` <span class="y-comment">#${escapeHtml(rest)}</span>`;

  let className = 'y-str';
  if (/^(true|false|yes|no|on|off|null|~)$/i.test(body)) className = 'y-const';
  else if (/^-?\d[\d_]*(\.\d+)?([eE][-+]?\d+)?$/.test(body)) className = 'y-num';
  else if (/^[&*]/.test(body)) className = 'y-anchor';
  else if (/^[|>]/.test(body)) className = 'y-block';

  return `<span class="${className}">${escapeHtml(body)}</span>${comment}`;
}

/** `nginx:latest # the one we pin` — but not a `#` inside quotes. */
function splitTrailingComment(value: string): string[] {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return [value.slice(0, i), value.slice(i + 1)];
  }
  return [value];
}

function renderYamlLine(line: YamlLine): string {
  const number = `<span class="y-n">${line.n}</span>`;
  const pad = `<span class="y-pad">${' '.repeat(line.indent)}</span>`;

  if (line.kind === 'blank') return `<div class="y-line">${number}<span class="y-code"> </span></div>`;
  if (line.kind === 'comment') return `<div class="y-line">${number}<span class="y-code y-comment">${escapeHtml(line.text)}</span></div>`;
  if (line.kind === 'doc') return `<div class="y-line">${number}<span class="y-code y-doc">${escapeHtml(line.text)}</span></div>`;
  if (line.kind === 'raw') return `<div class="y-line">${number}<span class="y-code y-raw">${escapeHtml(line.text)}</span></div>`;

  const dash = line.kind === 'item' ? '<span class="y-dash">- </span>' : '';
  const key = line.key ? `<span class="y-key">${escapeHtml(line.key)}</span><span class="y-colon">:</span> ` : '';
  const value = yamlValue(line.value ?? '');
  return `<div class="y-line">${number}<span class="y-code">${pad}${dash}${key}${value}</span></div>`;
}

function renderYamlNode(node: YamlNode, depth: number, openTo: number): string {
  const real = node.children.filter((child) => child.line.kind !== 'blank');
  if (!real.length) return renderYamlLine(node.line);

  const inner = node.children.map((child) => renderYamlNode(child, depth + 1, openTo)).join('');
  const count = real.length;
  return (
    `<details class="y-node"${depth < openTo ? ' open' : ''}>` +
    `<summary>${renderYamlLine(node.line)}<span class="y-count">${count}</span></summary>` +
    `<div class="y-children">${inner}</div>` +
    `</details>`
  );
}

function yamlStyles(dark: boolean): string {
  const ink = dark ? '#c0caf5' : '#2a2f3a';
  const paper = dark ? '#1a1b26' : '#ffffff';
  const key = dark ? '#7aa2f7' : '#2f6fdd';
  const str = dark ? '#9ece6a' : '#3f7f3a';
  const num = dark ? '#ff9e64' : '#b5540a';
  const cons = dark ? '#bb9af7' : '#8250df';
  const quiet = dark ? '#565f89' : '#8b93a7';
  const rule = dark ? '#2c3049' : '#e3e6ee';
  const inset = dark ? '#20222f' : '#f4f6fa';

  return `
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    body {
      margin: 0;
      padding: 10px 0 60px;
      background: ${paper};
      color: ${ink};
      font: 12.5px/1.7 "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace;
    }
    .y-line { display: flex; }
    .y-line:hover { background: ${inset}; }
    .y-n {
      flex: none;
      width: 44px;
      padding-right: 12px;
      text-align: right;
      color: ${quiet};
      user-select: none;
      opacity: 0.7;
    }
    .y-code { flex: 1; padding-right: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .y-pad { white-space: pre; }
    .y-key { color: ${key}; }
    .y-colon { color: ${quiet}; }
    .y-dash { color: ${quiet}; }
    .y-str { color: ${str}; }
    .y-num { color: ${num}; }
    .y-const { color: ${cons}; }
    .y-anchor { color: ${cons}; }
    .y-block { color: ${quiet}; }
    .y-comment { color: ${quiet}; font-style: italic; }
    .y-doc { color: ${cons}; }
    .y-raw { color: ${ink}; opacity: 0.85; }
    details.y-node > summary { cursor: pointer; list-style: none; display: flex; align-items: baseline; }
    details.y-node > summary::-webkit-details-marker { display: none; }
    details.y-node > summary > .y-line { flex: 1; }
    /* The twisty sits in the gutter, so the indentation stays honest. */
    details.y-node > summary::before {
      content: "▸";
      position: absolute;
      margin-left: -12px;
      color: ${quiet};
    }
    details.y-node[open] > summary::before { content: "▾"; }
    details.y-node > summary:hover { background: ${inset}; }
    .y-children { border-left: 1px solid ${rule}; margin-left: 51px; }
    .y-children .y-n { width: 0; padding-right: 0; overflow: hidden; }
    .y-count {
      flex: none;
      margin-right: 14px;
      font-size: 10px;
      color: ${quiet};
      background: ${inset};
      border-radius: 999px;
      padding: 0 6px;
      align-self: center;
    }
  `;
}

/** A YAML file with its shape shown and its blocks left alone. */
export function yamlDocument(text: string, dark: boolean, openTo = 3): string {
  const nodes = parseYaml(text);
  const body = nodes.map((node) => renderYamlNode(node, 0, openTo)).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${yamlStyles(dark)}</style></head><body>${body}</body></html>`;
}
