/**
 * Release notes, read rather than rendered.
 *
 * The notes arrive as Markdown over the network and are shown inside the app's
 * own window, next to a button that replaces the application. That is the one
 * place in this app where "it is only our own text" is not a good enough
 * reason to hand a string to `dangerouslySetInnerHTML`: the renderer holds
 * `window.api`, and a release body is written in a web form.
 *
 * So nothing here produces HTML. It produces a list of blocks and spans, React
 * draws them as elements, and a tag or an attribute in the source text has
 * nowhere to become one — it is text, and it is drawn as text.
 *
 * The subset is the one the notes are actually written in: headings, bullets,
 * paragraphs, fenced code, and the four inline marks. Anything else survives as
 * the characters it was written with, which for prose is a better failure than
 * disappearing.
 */

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type NotesBlock =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'list'; ordered: boolean; items: Span[][] }
  | { kind: 'code'; text: string };

/** Only what a link is allowed to be. A release note has no business elsewhere. */
const SAFE_LINK = /^https?:\/\//i;

/**
 * The inline marks, in the order they are looked for.
 *
 * Code first, deliberately: `**` inside backticks is part of an example and not
 * emphasis, and trying it the other way round turns half of every code sample
 * into bold text.
 */
const INLINE = [
  { kind: 'code' as const, pattern: /`([^`]+)`/ },
  { kind: 'link' as const, pattern: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { kind: 'strong' as const, pattern: /\*\*([^*]+)\*\*/ },
  { kind: 'em' as const, pattern: /(?<![*\w])\*([^*\n]+)\*(?!\*)/ },
];

/** One line of prose, split into the marks inside it. */
export function inlineSpans(line: string): Span[] {
  if (!line) return [];

  let earliest: { at: number; length: number; span: Span } | null = null;
  for (const mark of INLINE) {
    const found = mark.pattern.exec(line);
    if (!found) continue;
    if (earliest && found.index >= earliest.at) continue;

    let span: Span;
    if (mark.kind === 'link') {
      // A link nobody can follow safely is still text somebody wrote, so the
      // label stays and only the link goes.
      span = SAFE_LINK.test(found[2])
        ? { kind: 'link', text: found[1], href: found[2] }
        : { kind: 'text', text: found[1] };
    } else {
      span = { kind: mark.kind, text: found[1] };
    }
    earliest = { at: found.index, length: found[0].length, span };
  }

  if (!earliest) return [{ kind: 'text', text: line }];
  const before = line.slice(0, earliest.at);
  const after = line.slice(earliest.at + earliest.length);
  return [
    ...(before ? [{ kind: 'text' as const, text: before }] : []),
    earliest.span,
    ...inlineSpans(after),
  ];
}

/** The notes as blocks to draw. Never as markup. */
export function parseNotes(markdown: string): NotesBlock[] {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: NotesBlock[] = [];

  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: 'paragraph', spans: inlineSpans(paragraph.join(' ').trim()) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // A fence runs to its closing fence, or to the end if it was never closed.
    const fence = /^\s*```/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, spans: inlineSpans(heading[2].trim()) });
      continue;
    }

    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1]);
      const items: Span[][] = [];
      let text = bullet[2];
      i += 1;
      for (; i < lines.length; i += 1) {
        const next = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (next) {
          items.push(inlineSpans(text.trim()));
          text = next[2];
          continue;
        }
        // An indented line belongs to the bullet above it; a blank one or a
        // line at the margin ends the list.
        if (/^\s+\S/.test(lines[i])) {
          text += ` ${lines[i].trim()}`;
          continue;
        }
        break;
      }
      i -= 1;
      items.push(inlineSpans(text.trim()));
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
