'use strict';

/**
 * Release notes, and the one thing they must never become.
 *
 * They arrive over the network and are shown in the app's own window, beside a
 * button that replaces the application. The renderer holds `window.api`, so a
 * tag that survived into the output would be a tag running with the app's own
 * reach — which is why this produces blocks and spans and never markup, and why
 * the tests below care as much about what *is not* in the output as about what
 * is.
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseNotes, inlineSpans } = require('../.test-build/lib/releaseNotes.js');

const text = (value) => ({ kind: 'text', text: value });

// ---------------------------------------------------------------- nothing executes

/*
 * The whole reason this file exists. Markdown allows raw HTML, GitHub renders
 * it, and a release body is written in a web form — so the only safe answer is
 * that there is no path from this text to an element.
 */
test('markup in the notes stays text and never becomes an element', () => {
  const blocks = parseNotes('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'paragraph');
  // One text span, carrying the characters as written. Nothing here is a tag,
  // because nothing here is anything but a string React will escape.
  assert.deepStrictEqual(blocks[0].spans, [
    text('<script>alert(1)</script> and <img src=x onerror=alert(1)>'),
  ]);
});

test('a link that is not http is kept as its own words, without the link', () => {
  assert.deepStrictEqual(inlineSpans('[click me](javascript:alert)'), [text('click me')]);
  assert.deepStrictEqual(inlineSpans('[a file](file:///etc/passwd)'), [text('a file')]);
  assert.deepStrictEqual(inlineSpans('[go](https://example.com)'), [
    { kind: 'link', text: 'go', href: 'https://example.com' },
  ]);
});

// ---------------------------------------------------------------- the prose

test('paragraphs are the lines between the blank ones, joined', () => {
  const blocks = parseNotes('one line\nand its continuation\n\na second paragraph');
  assert.deepStrictEqual(blocks, [
    { kind: 'paragraph', spans: [text('one line and its continuation')] },
    { kind: 'paragraph', spans: [text('a second paragraph')] },
  ]);
});

test('headings keep their depth', () => {
  const blocks = parseNotes('# One\n## Two\n#### Four');
  assert.deepStrictEqual(
    blocks.map((block) => [block.kind, block.level]),
    [
      ['heading', 1],
      ['heading', 2],
      ['heading', 4],
    ],
  );
});

test('bullets are a list, and an indented line belongs to the bullet above it', () => {
  const blocks = parseNotes('- first\n- second, which\n  runs on\n- third');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'list');
  assert.strictEqual(blocks[0].ordered, false);
  assert.deepStrictEqual(blocks[0].items, [
    [text('first')],
    [text('second, which runs on')],
    [text('third')],
  ]);
});

test('a numbered list is a different list', () => {
  const blocks = parseNotes('1. one\n2. two');
  assert.strictEqual(blocks[0].ordered, true);
  assert.strictEqual(blocks[0].items.length, 2);
});

test('a fenced block is kept exactly as it was written', () => {
  const blocks = parseNotes('before\n\n```sh\nxattr -dr com.apple.quarantine "/Applications/X.app"\n```\n\nafter');
  assert.deepStrictEqual(blocks[1], {
    kind: 'code',
    text: 'xattr -dr com.apple.quarantine "/Applications/X.app"',
  });
  assert.strictEqual(blocks[2].kind, 'paragraph');
});

test('a fence nobody closed runs to the end rather than swallowing the parser', () => {
  const blocks = parseNotes('```\nstill open');
  assert.deepStrictEqual(blocks, [{ kind: 'code', text: 'still open' }]);
});

// ---------------------------------------------------------------- the inline marks

test('the four marks, and the plain text around them', () => {
  assert.deepStrictEqual(inlineSpans('a **bold** word'), [
    text('a '),
    { kind: 'strong', text: 'bold' },
    text(' word'),
  ]);
  assert.deepStrictEqual(inlineSpans('an *emphasis*'), [text('an '), { kind: 'em', text: 'emphasis' }]);
  assert.deepStrictEqual(inlineSpans('run `npm run dist`'), [
    text('run '),
    { kind: 'code', text: 'npm run dist' },
  ]);
});

/*
 * Code first, and this is why: the release notes are full of shell, and `**`
 * inside backticks is a glob rather than emphasis. Reading emphasis first turns
 * half of every example into bold text with the asterisks eaten.
 */
test('what is inside backticks is not read for marks', () => {
  assert.deepStrictEqual(inlineSpans('`find . -name **/*.ts`'), [
    { kind: 'code', text: 'find . -name **/*.ts' },
  ]);
});

test('an asterisk in the middle of a word is not emphasis', () => {
  assert.deepStrictEqual(inlineSpans('2*3 and 4*5'), [text('2*3 and 4*5')]);
});

test('nothing in, nothing out', () => {
  assert.deepStrictEqual(parseNotes(''), []);
  assert.deepStrictEqual(parseNotes('   \n\n  '), []);
  assert.deepStrictEqual(parseNotes(null), []);
  assert.deepStrictEqual(parseNotes(undefined), []);
  assert.deepStrictEqual(inlineSpans(''), []);
});
