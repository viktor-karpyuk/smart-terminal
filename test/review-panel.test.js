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
