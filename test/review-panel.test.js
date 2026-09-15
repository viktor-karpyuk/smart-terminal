'use strict';

/*
 * The Code Reviewer panel's Markdown: what reviews, colleagues and models wrote
 * is drawn in a frame that holds the app's bridge, so nothing in it may become
 * markup. Extracted from the panel as it ships, as the other panel tests do.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'code-review', 'panel.html'), 'utf8');
const source = /<script>([\s\S]*)<\/script>/.exec(html)[1];

function fromPanel(names) {
  const pieces = names.map((name) => {
    const at = source.search(new RegExp(`\\n  (?:var|function) ${name}\\b`));
    assert.ok(at >= 0, `the panel no longer defines ${name}`);
    const rest = source.slice(at + 1);
    const end = rest.slice(1).search(/\n  (?:var|function|\/\*\*|\/\*|\/\/|\$\(|host\.|draw\(\)|[A-Za-z$_][\w$]*\s*(?:=|\())/);
    return end < 0 ? rest : rest.slice(0, end + 1);
  });
  const context = {};
  vm.createContext(context);
  vm.runInContext(pieces.join('\n'), context);
  return context;
}

const P = fromPanel(['esc', 'md', 'ageMark']);

test('the panel script parses', () => {
  assert.doesNotThrow(() => new vm.Script(source));
});

test('nothing written by someone else becomes markup', () => {
  const out = P.md('<img src=x onerror=alert(1)> **bold** `<b>`\n\n```\n<script>alert(1)</script>\n```');
  assert.ok(!/<img|<script|<b>/.test(out), out);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<code>&lt;b&gt;<\/code>/);
  assert.match(out, /<pre><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
});

test('links open only when they are GitHub or Bitbucket, and never as a real link', () => {
  const out = P.md('[pr](https://github.com/me/x/pull/1) [evil](javascript:alert(1)) [other](https://evil.test/x)');
  assert.match(out, /<button class="link" data-act="open-url" data-url="https:\/\/github\.com\/me\/x\/pull\/1">pr<\/button>/);
  assert.ok(!/href=|javascript:alert\(1\)"/.test(out));
  assert.match(out, /\[other\]\(https:\/\/evil\.test\/x\)/);
});

test('lists, quotes and headings', () => {
  const out = P.md('### Code review\n\n1. **one** _(major · bug)_\n2. two\n\n> ⚠️ careful\n- a\n- b');
  assert.match(out, /<h4>Code review<\/h4>/);
  assert.match(out, /<ol><li><strong>one<\/strong> <em>\(major · bug\)<\/em><\/li><li>two<\/li><\/ol>/);
  assert.match(out, /<blockquote>⚠️ careful<\/blockquote>/);
  assert.match(out, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});

test('age marks', () => {
  assert.deepEqual([1, 3, 7, 14, 90].map(P.ageMark), ['', '•', '▲', '▲▲', '▲▲▲']);
});

const V = fromPanel(['esc', 'words', 'KW_CLIKE', 'KW_JS', 'KW_PY', 'KW_SQL', 'KW_SH', 'LANGS', 'EXT_LANG', 'langOf', 'tokenize', 'changedRange', 'paint', 'intraline', 'parseHunk']);
const classes = (tokens) => tokens.filter((t) => t.c).map((t) => `${t.c}:${t.t}`);

test('code is coloured by what it is, per language, and everything stays escaped', () => {
  const java = V.langOf('src/main/java/App.java');
  assert.deepEqual(classes(V.tokenize('@Override public String name() { return "x<y"; } // done', java, { block: false })), ['tk-a:@Override', 'tk-k:public', 'tk-t:String', 'tk-f:name', 'tk-k:return', 'tk-s:"x<y"', 'tk-c:// done']);
  assert.equal(V.paint(V.tokenize('return "<b>";', java, { block: false })), '<span class="tk-k">return</span> <span class="tk-s">&quot;&lt;b&gt;&quot;</span>;');
  const sql = V.langOf('db/migration/V0552__x.sql');
  assert.deepEqual(classes(V.tokenize('ALTER TABLE foo ADD COLUMN bar int; -- why', sql, { block: false })), ['tk-k:ALTER', 'tk-k:TABLE', 'tk-k:ADD', 'tk-k:COLUMN', 'tk-k:int', 'tk-c:-- why']);
  const yaml = V.langOf('application.yml');
  assert.deepEqual(classes(V.tokenize('  datasource: "jdbc" # local', yaml, { block: false })), ['tk-t:datasource', 'tk-s:"jdbc"', 'tk-c:# local']);
  assert.equal(V.langOf('README.unknown'), V.LANGS.plain);
});

test('a block comment carries across lines, and a hunk that starts inside one is guessed from the star', () => {
  const ts = V.langOf('a.ts');
  const st = { block: false };
  assert.deepEqual(classes(V.tokenize('const a = 1; /* start', ts, st)), ['tk-k:const', 'tk-n:1', 'tk-c:/* start']);
  assert.equal(st.block, true);
  assert.deepEqual(classes(V.tokenize('still inside */ let b', ts, st)), ['tk-c:still inside */', 'tk-k:let']);
  assert.deepEqual(classes(V.tokenize(' * a javadoc line', ts, { block: false })), ['tk-c: * a javadoc line']);
});

test('only the stretch that changed inside a line is marked, and a rewritten line is not', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(V.changedRange('return a - b;', 'return a + b;'))), { a: [9, 10], b: [9, 10] });
  assert.equal(V.changedRange('int x = 1;', 'String name = computeSomethingElse();'), null);
  const lines = [{ kind: 'CONTEXT', text: 'x' }, { kind: 'REMOVED', text: 'foo(1)' }, { kind: 'REMOVED', text: 'bar(2)' }, { kind: 'ADDED', text: 'foo(10)' }, { kind: 'ADDED', text: 'totally new' }];
  const ranges = V.intraline(lines);
  assert.deepEqual(JSON.parse(JSON.stringify(ranges)), { 1: [5, 5], 3: [5, 6] });
  assert.equal(V.paint([{ t: 'foo(10)', c: '' }], [4, 6]), 'foo(<span class="chg">10</span>)');
});

test('a hunk header is read with its lengths, defaulting to one', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(V.parseHunk('@@ -10,3 +12,4 @@ public class A {'))), { oldStart: 10, oldLen: 3, newStart: 12, newLen: 4, label: 'public class A {' });
  assert.deepEqual(JSON.parse(JSON.stringify(V.parseHunk('@@ -1 +1 @@'))), { oldStart: 1, oldLen: 1, newStart: 1, newLen: 1, label: '' });
});
