'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../.test-build/lib/preview');

test('the kinds worth previewing are recognised, and nothing else is', () => {
  assert.equal(P.previewKind('/w/README.md'), 'markdown');
  assert.equal(P.previewKind('/w/notes.MARKDOWN'), 'markdown');
  assert.equal(P.previewKind('/w/page.html'), 'html');
  assert.equal(P.previewKind('/w/page.HTM'), 'html');
  assert.equal(P.previewKind('/w/main.ts'), null);
  assert.equal(P.previewKind('/w/Makefile'), null);
  assert.equal(P.previewable('/w/README.md'), true);
  assert.equal(P.previewable('/w/main.ts'), false);
});

test('markdown comes back as a whole document, rendered', () => {
  const doc = P.previewDocument('/w/README.md', '# Title\n\nSome **bold** text.\n\n- one\n- two\n', true);
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /<h1[^>]*>Title<\/h1>/);
  assert.match(doc, /<strong>bold<\/strong>/);
  assert.match(doc, /<li>one<\/li>/);
});

test('the harder parts of markdown survive, which is why this is not hand-rolled', () => {
  const doc = P.previewDocument(
    '/w/x.md',
    ['| a | b |', '| - | - |', '| 1 | 2 |', '', '1. first', '   - nested', '2. second', '', '```js', 'const x = 1;', '```'].join('\n'),
    false,
  );
  assert.match(doc, /<table>/);
  assert.match(doc, /<th>a<\/th>/);
  assert.match(doc, /<ol>[\s\S]*<ul>[\s\S]*nested/);
  assert.match(doc, /<pre><code class="language-js">/);
});

test('html is passed through as it was written', () => {
  const source = '<!doctype html><html><body><p>hello</p></body></html>';
  assert.equal(P.previewDocument('/w/page.html', source, false), source);
});

test('the theme is carried in, since the frame cannot see the app around it', () => {
  const dark = P.previewDocument('/w/a.md', '# x', true);
  const light = P.previewDocument('/w/a.md', '# x', false);
  assert.match(dark, /color-scheme: dark/);
  assert.match(light, /color-scheme: light/);
  assert.notEqual(dark, light);
});

test('an empty file previews as an empty document rather than throwing', () => {
  const doc = P.previewDocument('/w/a.md', '', false);
  assert.match(doc, /<body><\/body>/);
});
