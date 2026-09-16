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

test('a published finding does not repeat its title under the title', () => {
  const T = fromPanel(['withoutTitle']);
  assert.equal(T.withoutTitle('**`switchMode` changes the mode**\n\nThe body.', '`switchMode` changes the mode'), 'The body.');
  assert.equal(T.withoutTitle('### A title\nBody', 'A title'), 'Body');
  assert.equal(T.withoutTitle('**Another title**\n\nBody', 'A title'), '**Another title**\n\nBody');
  assert.equal(T.withoutTitle('Just a body', 'A title'), 'Just a body');
});

test('unchanged stretches fold into gaps that open from either end, without losing or repeating a line', () => {
  const D = fromPanel(['diffMetaWorthShowing', 'diffMetaWords', 'parseHunk', 'diffItems']);
  const total = 30;
  const fileLines = Array.from({ length: total }, (_, i) => `line ${i + 1}`);
  const hunk = [{ kind: 'HUNK', text: '@@ -10,3 +10,5 @@' }, { kind: 'CONTEXT', oldNo: 10, newNo: 10, text: 'line 10' }, { kind: 'ADDED', oldNo: null, newNo: 11, text: 'new a' }, { kind: 'ADDED', oldNo: null, newNo: 12, text: 'new b' }, { kind: 'CONTEXT', oldNo: 11, newNo: 13, text: 'line 13' }, { kind: 'CONTEXT', oldNo: 12, newNo: 14, text: 'line 14' }];
  const shape = (items) => items.map((it) => (it.type === 'gap' ? `gap:${it.key}:${it.hidden}` : it.type === 'hunk' ? 'hunk' : `${it.l.oldNo}/${it.l.newNo}`));
  D.state = { code: { fileText: { 'a.js': { lines: fileLines, total } }, reveal: {} } };
  assert.deepEqual(shape(D.diffItems(hunk, 'a.js')), ['gap:g0:9', 'hunk', '10/10', 'null/11', 'null/12', '11/13', '12/14', 'gap:end:16']);

  // Five lines above the change, and every line after it: the old side's numbers follow the lines the hunk added.
  D.state.code.reveal = { 'a.js': { g0: { top: 0, bottom: 5 }, end: { top: 99, bottom: 0 } } };
  const opened = shape(D.diffItems(hunk, 'a.js'));
  assert.deepEqual(opened.slice(0, 7), ['gap:g0:4', '5/5', '6/6', '7/7', '8/8', '9/9', 'hunk']);
  assert.equal(opened[opened.length - 1], '28/30');
  assert.ok(!opened.some((item) => item.startsWith('gap:end')), 'fully opened: no gap left');
  const newNumbers = opened.filter((item) => /\/\d+$/.test(item)).map((item) => Number(item.split('/')[1]));
  assert.equal(new Set(newNumbers).size, newNumbers.length, 'no line twice');

  // Without the file's text, the tail is unknown and still offered.
  D.state = { code: { fileText: {}, reveal: {} } };
  assert.deepEqual(shape(D.diffItems(hunk, 'a.js')).slice(-1), ['gap:end:null']);
});

test('only the first line after a hunk may be guessed into a block comment', () => {
  const sql = V.langOf('q.sql');
  const st = { block: false, fresh: true };
  V.tokenize('SELECT', sql, st);
  const star = V.tokenize('  *', sql, st);
  assert.equal(st.block, false, 'a select list star is not a comment');
  assert.ok(!star.some((t) => t.c === 'tk-c'));
  const java = V.langOf('A.java');
  const first = { block: false, fresh: true };
  V.tokenize('   * continues a javadoc', java, first);
  assert.equal(first.block, true, 'at the top of a hunk it is taken as a comment');
});

test('a title shows its backticked code as code, and nothing else as markup', () => {
  const T = fromPanel(['esc', 'titleHtml']);
  assert.equal(T.titleHtml('`switchMode` changes <b>'), '<code>switchMode</code> changes &lt;b&gt;');
  assert.equal(T.titleHtml('`<img onerror=x>`'), '<code>&lt;img onerror=x&gt;</code>');
});

test('the title line is dropped as the reviewer posts it, with its category in front', () => {
  const T = fromPanel(['withoutTitle']);
  assert.equal(T.withoutTitle('_diseño_ · **El bridge paga una query**\n\nEl cuerpo.', 'El bridge paga una query'), 'El cuerpo.');
});

// ---------------------------------------------------------------- one at a time, per what?

/*
 * `act(key, …)` refuses a second run under the same key and draws its button as
 * busy meanwhile. That is right. What was wrong is that the keys were bare
 * words — `verify`, `merge`, `publish-all` — and since those calls resolve only
 * when the work has *finished*, verifying one pull request greyed out Verify on
 * every pull request. A panel that can happily do two at once looked like one
 * that cannot do two at all.
 *
 * It was fixed for `review` and left in fourteen other places, which is what a
 * fix applied to a case rather than to a class looks like. This is the guard
 * for the class: an action that acts on one pull request is busy for that pull
 * request, and nothing else.
 */

/** What the panel does to one pull request, all of which take `prArgs()`. */
const PER_PR = [
  'verify', 'final-pass', 'stance', 'decline', 'merge', 'publish-all', 'publish-review',
  'fix-all', 'give-back', 'pr-load', 'recheck-conflicts', 'push', 'draft-all', 'discard',
];
/** And what it does to one repository: two of those must not block each other. */
const PER_REPO = ['prs-refresh', 'prs-history'];

test('an action on one pull request does not mark every pull request busy', () => {
  const offenders = [];
  for (const name of PER_PR) {
    // `act('verify', …)` and `busyAttr('verify')` — the bare key, either side.
    if (source.includes(`act('${name}', `)) offenders.push(`act('${name}', …) is keyed on nothing`);
    if (source.includes(`busyAttr('${name}')`)) offenders.push(`busyAttr('${name}') is keyed on nothing`);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `These act on the open pull request but mark the whole panel busy:\n  ${offenders.join('\n  ')}\n\n` +
      'Key them with prKey(name), so the button greys out on that pull request and no other.',
  );
});

test('an action on one repository does not mark every repository busy', () => {
  const offenders = PER_REPO.filter(
    (name) => source.includes(`act('${name}', `) || source.includes(`busyAttr('${name}')`),
  );
  assert.deepStrictEqual(offenders, [], 'Key these with repoKey(name).');
});

test('the keys are built from what is being acted on, and differ between two of them', () => {
  /*
   * `prKey` reads the panel's `state`, which is a closure variable — so the two
   * functions are lifted into a context of their own with a `state` this test
   * can move, rather than pretending the panel's is reachable.
   */
  const context = vm.createContext({ state: {} });
  const grab = (name) => {
    const at = source.search(new RegExp(`\\n  function ${name}\\b`));
    assert.ok(at >= 0, `the panel no longer defines ${name}`);
    const end = source.indexOf('\n', at + 1);
    return source.slice(at, end);
  };
  vm.runInContext(`${grab('prKey')}\n${grab('repoKey')}`, context);
  const keyFor = (state, expr) => {
    context.state = state;
    return vm.runInContext(expr, context);
  };

  const here = { repoId: 'kubrik-erp-be', prId: 191 };
  const nextDoor = { repoId: 'kubrik-erp-be', prId: 192 };
  const elsewhere = { repoId: 'pds-be', prId: 191 };

  assert.notStrictEqual(
    keyFor(here, "prKey('verify')"),
    keyFor(nextDoor, "prKey('verify')"),
    'two pull requests in one repository are two keys',
  );
  assert.notStrictEqual(
    keyFor(here, "prKey('verify')"),
    keyFor(elsewhere, "prKey('verify')"),
    'the same number in another repository is another key',
  );
  assert.notStrictEqual(
    keyFor(here, "prKey('verify')"),
    keyFor(here, "prKey('merge')"),
    'and two actions on one pull request still differ',
  );
  assert.notStrictEqual(
    keyFor(here, "repoKey('prs-refresh')"),
    keyFor(here, "prKey('prs-refresh')"),
    'a repository key is not a pull request key',
  );
  assert.strictEqual(
    keyFor(here, "prKey('verify')"),
    keyFor({ repoId: 'kubrik-erp-be', prId: 191 }, "prKey('verify')"),
    'and the same pull request is the same key, or the button would never come back',
  );
});
