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

// --- XML -------------------------------------------------------------------

test('xml is recognised by its many extensions, and svg is its own thing', () => {
  assert.equal(P.previewKind('/w/pom.xml'), 'xml');
  assert.equal(P.previewKind('/w/feed.rss'), 'xml');
  assert.equal(P.previewKind('/w/Info.plist'), 'xml');
  assert.equal(P.previewKind('/w/logo.svg'), 'svg', 'a picture, not a tree');
});

test('elements, attributes and text come back as a tree', () => {
  const nodes = P.parseXml('<a x="1" y=\'2\'><b>hello</b><c/></a>');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'a');
  assert.deepEqual(nodes[0].attrs, [['x', '1'], ['y', '2']]);
  assert.deepEqual(nodes[0].children.map((n) => n.name ?? n.kind), ['b', 'c']);
  assert.equal(nodes[0].children[0].children[0].text, 'hello');
  assert.equal(nodes[0].children[1].empty, true);
});

test('comments, CDATA and the declaration are kept apart from content', () => {
  const nodes = P.parseXml('<?xml version="1.0"?><r><!-- note --><![CDATA[<raw>]]>tail</r>');
  assert.equal(nodes[0].kind, 'pi');
  const kinds = nodes[1].children.map((n) => n.kind);
  assert.deepEqual(kinds, ['comment', 'cdata', 'text']);
  assert.equal(nodes[1].children[1].text, '<raw>', 'CDATA is not markup');
});

test('a broken document still opens, which is when a viewer matters most', () => {
  const stray = P.parseXml('<a><b></c></a>');
  assert.equal(stray[0].name, 'a', 'a stray close tag does not unwind the document');
  const unclosed = P.parseXml('<a><b>text');
  assert.equal(unclosed[0].children[0].children[0].text, 'text');
  const truncated = P.parseXml('<a><b attr="x');
  assert.equal(truncated[0].name, 'a');
});

test('the rendered tree folds without a script, and escapes what it shows', () => {
  const doc = P.xmlDocument('<a><b><c>1</c><d>2</d></b></a>', true, 3);
  assert.match(doc, /<details class="x-node" open>/);
  assert.match(doc, /<summary>/);
  const nasty = P.xmlDocument('<a t="&lt;script&gt;">&lt;script&gt;</a>', true);
  assert.equal(/<script>/.test(nasty), false, 'nothing in the file becomes markup');
});

test('only the shallow levels start open', () => {
  const deep = '<a><b><c><d><e>x</e></d></c></b></a>';
  const shallow = P.xmlDocument(deep, false, 1);
  assert.equal((shallow.match(/<details class="x-node" open>/g) || []).length, 1);
  assert.ok((P.xmlDocument(deep, false, 3).match(/<details class="x-node" open>/g) || []).length >= 3);
});

// --- Dockerfiles and shell scripts -----------------------------------------

test('a Dockerfile is recognised by its name, with the variants people write', () => {
  assert.equal(P.previewKind('/w/Dockerfile'), 'dockerfile');
  assert.equal(P.previewKind('/w/Dockerfile.dev'), 'dockerfile');
  assert.equal(P.previewKind('/w/Containerfile'), 'dockerfile');
  assert.equal(P.previewKind('/w/deploy.sh'), 'shell');
  assert.equal(P.previewKind('/w/setup.bash'), 'shell');
  assert.equal(P.previewKind('/w/notes.txt'), null);
});

test('a Dockerfile is divided by its stages, which is what a stage is', () => {
  const sections = P.splitScript(
    ['FROM node:20 AS build', 'RUN npm ci', '', 'FROM nginx', 'COPY --from=build /app /usr/share/nginx'].join('\n'),
    'dockerfile',
  );
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'stage: build');
  assert.equal(sections[0].subtitle, 'node:20 AS build');
  assert.equal(sections[1].title, 'stage');
});

test('a shell script is divided by its functions and its own banner comments', () => {
  const sections = P.splitScript(
    ['#!/bin/zsh', '', '# --- setting up ---', 'set -u', '', 'deploy() {', '  echo hi', '}'].join('\n'),
    'shell',
  );
  assert.deepEqual(sections.map((s) => s.title), [null, 'setting up', 'deploy()']);
});

test('a comment that is prose is not mistaken for a heading', () => {
  const sections = P.splitScript(['# this explains a long and rambling thing about why the next line exists at all', 'ls'].join('\n'), 'shell');
  assert.deepEqual(sections.map((s) => s.title), [null]);
});

test('instructions are picked out, comments set back, and the shebang is neither', () => {
  const doc = P.scriptDocument(['#!/bin/sh', '# a note', 'RUN echo "x"'].join('\n'), 'dockerfile', true);
  assert.match(doc, /s-shebang/);
  assert.match(doc, /s-comment/);
  assert.match(doc, /<span class="s-word">RUN<\/span>/);
  assert.match(doc, /s-str/);
});

test('every line is numbered, blank ones included', () => {
  const doc = P.scriptDocument('a\n\nb', 'shell', false);
  assert.deepEqual((doc.match(/<span class="s-n">\d+<\/span>/g) || []).map((s) => s.replace(/\D/g, '')), ['1', '2', '3']);
});

test('a script escapes what it shows', () => {
  const doc = P.scriptDocument('echo "<script>alert(1)</script>"', 'shell', false);
  assert.equal(/<script>/.test(doc), false);
});

// --- YAML ------------------------------------------------------------------

test('yml and yaml both open as yaml', () => {
  assert.equal(P.previewKind('/w/docker-compose.yml'), 'yaml');
  assert.equal(P.previewKind('/w/values.yaml'), 'yaml');
});

test('the shape comes from the indentation', () => {
  const nodes = P.parseYaml(['services:', '  web:', '    image: nginx', '  db:', '    image: postgres'].join('\n'));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].line.key, 'services');
  assert.deepEqual(nodes[0].children.map((c) => c.line.key), ['web', 'db']);
  assert.equal(nodes[0].children[0].children[0].line.value, 'nginx');
});

test('list items are their own thing, with or without a key', () => {
  const nodes = P.parseYaml(['steps:', '  - uses: actions/checkout@v4', '  - run: npm ci', '  - plain'].join('\n'));
  const items = nodes[0].children;
  assert.deepEqual(items.map((c) => c.line.kind), ['item', 'item', 'item']);
  assert.equal(items[0].line.key, 'uses');
  assert.equal(items[0].line.value, 'actions/checkout@v4');
  assert.equal(items[2].line.value, 'plain');
});

test('a literal block is content, not more yaml', () => {
  const nodes = P.parseYaml(['run: |', '  echo "hello"', '  key: not-a-key', 'after: 1'].join('\n'));
  const block = nodes[0];
  assert.equal(block.line.key, 'run');
  assert.deepEqual(block.children.map((c) => c.line.kind), ['raw', 'raw']);
  assert.equal(nodes[1].line.key, 'after', 'and the block ends when the indentation does');
});

test('a comment after a value is not part of the value', () => {
  const doc = P.yamlDocument('image: nginx:latest # the one we pin', true);
  assert.match(doc, /<span class="y-str">nginx:latest<\/span>/);
  assert.match(doc, /y-comment">#/);
});

test('a hash inside quotes is not a comment', () => {
  // The body only: the stylesheet naturally mentions every class it defines.
  const body = P.yamlDocument('colour: "#ff0000"', true).split('<body>')[1];
  assert.match(body, /y-str">&quot;#ff0000&quot;</);
  assert.equal(/y-comment/.test(body), false);
});

test('values are coloured by what they plainly are', () => {
  const doc = P.yamlDocument(['a: 42', 'b: true', 'c: null', 'd: hello', 'e: &anchor x'].join('\n'), true);
  assert.match(doc, /y-num">42/);
  assert.match(doc, /y-const">true/);
  assert.match(doc, /y-const">null/);
  assert.match(doc, /y-str">hello/);
  assert.match(doc, /y-anchor">&amp;anchor x/);
});

test('document separators are marked, not swallowed', () => {
  const nodes = P.parseYaml(['---', 'a: 1', '---', 'b: 2'].join('\n'));
  assert.deepEqual(nodes.map((n) => n.line.kind), ['doc', 'key', 'doc', 'key']);
});

test('only shallow levels start open, and a leaf is not a folder', () => {
  const yaml = ['a:', '  b:', '    c:', '      d: 1'].join('\n');
  assert.equal((P.yamlDocument(yaml, false, 1).match(/<details class="y-node" open>/g) || []).length, 1);
  const flat = P.yamlDocument('a: 1\nb: 2', false);
  assert.equal(/<details/.test(flat), false, 'nothing to fold');
});

test('every line is numbered and nothing becomes markup', () => {
  const doc = P.yamlDocument('a: "<script>alert(1)</script>"\nb: 2', false);
  assert.equal(/<script>/.test(doc), false);
  assert.deepEqual((doc.match(/<span class="y-n">\d+<\/span>/g) || []).length, 2);
});
