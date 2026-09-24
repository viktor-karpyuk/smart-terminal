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

// ---------------------------------------------------------------- one word, two meanings

/*
 * `.empty` meant two things a screen apart in this stylesheet: the placeholder
 * shown when a list has nothing in it, and — in a split diff — the side of a row
 * that has no line. An unqualified rule for the first gave every cell of the
 * second a 180px floor, which in a table is a minimum *row* height. A file's
 * diff came out with rows of six and nine hundred pixels, and it only showed on
 * a view somebody has to open to see.
 *
 * So: the styles meant for a page's own blocks say which element they are for.
 */
test('a rule written for a page block cannot reach into a table cell', () => {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];

  // The words the diff also uses as cell classes. A bare rule for any of these
  // lands on `td.empty`, `td.add`, `td.del`, `td.n`, `td.c`, `td.m`.
  const shared = ['empty', 'loading', 'add', 'del'];
  const offenders = [];
  for (const word of shared) {
    // A selector that is only the class, at the start of a rule: `.empty {` or
    // `.empty, .loading {`. Qualified ones — `div.empty`, `table.diff td.empty`
    // — are exactly what this is asking for.
    const bare = new RegExp(`(^|[,{}\\n])\\s*\\.${word}\\s*[,{]`, 'm');
    if (bare.test(style)) offenders.push(`.${word}`);
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `These are styled by class alone, and the diff uses the same words on its cells:\n  ${offenders.join(
      ', ',
    )}\n\nQualify them — div.empty, not .empty — so a page's placeholder cannot set a row's height.`,
  );
});

// ---------------------------------------------------------------- which one is running

/*
 * A run in flight is matched to the thing on screen it belongs to. Fixes do it
 * by `findingId` and that was always right; replies did it by asking whether the
 * run's *title* contained the author's name — and a reply's title is "Reply to
 * Braian Chavez". Two threads with the same person on one pull request are two
 * runs with the same title, so drafting an answer to one showed both as drafting
 * and replaced both buttons with a spinner. From the other side of the screen
 * that is the panel refusing to draft the second until the first has finished.
 *
 * So: a run is identified by the id of the thing it is working on, never by
 * words a human might share with somebody else.
 */
test('a run in flight is matched by id, not by what its title happens to say', () => {
  const runs = /var (?:drafting|fixing|reviewing) = [^;]+;/g;
  const matchers = source.match(runs) ?? [];
  assert.ok(matchers.length >= 3, 'the three kinds of run are still matched somewhere');

  const byTitle = matchers.filter((line) => /title\s*\.\s*indexOf|title\s*===|title\s*\.\s*includes/.test(line));
  assert.deepStrictEqual(
    byTitle,
    [],
    `These decide what is running from a run's title:\n  ${byTitle.join('\n  ')}\n\n` +
      'Two people can share a name and one person can have two threads. Match on the id.',
  );
});

test('the engine says which reply a drafting run is for', () => {
  const engine = fs.readFileSync(path.join(__dirname, '..', 'electron', 'review-engine.js'), 'utf8');
  const start = /this\.activity\.start\(key, \{[\s\S]{0,400}?kind: 'reply'[\s\S]{0,400?}?\}\)/.exec(engine);
  assert.ok(/kind: 'reply'/.test(engine), 'there is still a reply run');
  // The panel can only match on an id the engine actually puts there.
  assert.match(
    engine,
    /kind: 'reply',[\s\S]{0,200}replyId/,
    'a reply run carries the id of the reply it is drafting',
  );
  void start;
});

// ---------------------------------------------------------------- Enter in the Code tab

/*
 * Reading a review is look, nod, next. Enter is the nod: it marks the file in
 * front as viewed and opens the next one nobody has looked at. It never unmarks
 * — leaning on it from the first file to the last must not undo a mark on the
 * way — and on a file already seen it just moves on.
 */
function codeTab({ files, viewed, file }) {
  const V = fromPanel(['viewedAndOn']);
  const log = [];
  V.state = { repoId: 'r', prId: 1, code: { files: files.map((path) => ({ path })), viewed: viewed.slice(), file } };
  V.call = (name, args) => {
    log.push([name, args.file, args.viewed]);
    const now = V.state.code.viewed.filter((p) => p !== args.file).concat(args.viewed ? [args.file] : []);
    return Promise.resolve({ files: now });
  };
  V.openFile = (path) => log.push(['open', path]);
  V.draw = () => log.push(['draw']);
  V.$ = () => ({});
  V.fail = (error) => { throw error; };
  return { V, log };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Enter marks the file in front as viewed and opens the next one not viewed', async () => {
  const { V, log } = codeTab({ files: ['a', 'b', 'c'], viewed: [], file: 'a' });
  V.viewedAndOn('a');
  await tick();
  assert.deepStrictEqual(log, [['setViewed', 'a', true], ['open', 'b']]);
});

test('Enter skips files already viewed, wrapping round to the start', async () => {
  const { V, log } = codeTab({ files: ['a', 'b', 'c'], viewed: ['a', 'c'], file: 'b' });
  V.viewedAndOn('b');
  await tick();
  // b was the last one; nothing is left to open, and the list redraws to say so.
  assert.deepStrictEqual(log, [['setViewed', 'b', true], ['draw']]);
  assert.deepStrictEqual(V.state.code.viewed.slice().sort(), ['a', 'b', 'c']);
});

test('Enter on a file already viewed moves on and does not unmark it', async () => {
  const { V, log } = codeTab({ files: ['a', 'b', 'c'], viewed: ['a', 'b'], file: 'b' });
  V.viewedAndOn('b');
  await tick();
  assert.deepStrictEqual(log, [['open', 'c']], 'no setViewed call at all — the mark stays');
});

test('Enter is wired to the Code tab and leaves a focused button its own Enter', () => {
  assert.match(source, /event\.key === 'Enter' && state\.code\.file[\s\S]{0,200}viewedAndOn\(state\.code\.file\)/);
  assert.match(source, /event\.key === 'Enter'[^\n]*tagName === 'BUTTON'/, 'a focused button keeps Enter for itself');
});

// ---------------------------------------------------------------- does it merge

/*
 * Three answers, three chips. There used to be one chip, for conflicts, and no
 * chip for anything else — which made "nobody has checked" look exactly like
 * "it merges", on the one column people read before pressing Merge.
 */
const M = fromPanel(['esc', 'parseTime', 'when', 'mergeState', 'conflictChip']);

test('conflicts, clean and not-checked are three different chips', () => {
  const row = (pr) => ({ pr: { updatedOn: '2026-09-20T10:00:00.000Z', ...pr } });
  assert.match(M.conflictChip(row({ conflicts: ['a.js', 'b.js'], conflictsAt: '2026-09-21T10:00:00.000Z' })), /badc[^>]*>Conflicts 2</);
  assert.match(M.conflictChip(row({ conflicts: [], conflictsAt: '2026-09-21T10:00:00.000Z' })), /okc[^>]*>✓ merges</);
  assert.match(M.conflictChip(row({ conflicts: null, conflictsAt: null })), />merge \?</);
  assert.doesNotMatch(M.conflictChip(row({ conflicts: null, conflictsAt: null })), /okc|badc/, 'not knowing is not green and not red');
});

test('an answer older than the newest commits is a question, whichever way it went', () => {
  const row = (pr) => ({ pr: { updatedOn: '2026-09-21T12:00:00.000Z', conflictsAt: '2026-09-21T10:00:00.000Z', ...pr } });
  assert.match(M.conflictChip(row({ conflicts: ['a.js'] })), />Conflicts\? 1</);
  assert.match(M.conflictChip(row({ conflicts: [] })), />merges\?</);
  assert.strictEqual(M.mergeState(row({ conflicts: [] })).stale, true);
});

// ---------------------------------------------------------------- a comment argued away

/*
 * A comment the author refuted and the person settled is not the verifier's
 * "won't fix": one is a judgement about the code, the other is somebody taking
 * responsibility for a decision, and the panel must not draw them alike.
 */
const S = fromPanel(['esc', 'RESOLUTION_LABELS', 'settledByYou', 'findingStatus']);

test('settled by you reads as settled, not as the verifier deciding not to fix', () => {
  const mine = { publishedId: 'c1', resolution: 'WONT_FIX', resolutionBy: 'YOU', resolutionNote: 'Deliberate: callers negate b.', closedAt: 'x' };
  const theirs = { publishedId: 'c1', resolution: 'WONT_FIX', resolutionBy: 'VERIFY', resolutionNote: 'out of scope' };
  assert.strictEqual(S.settledByYou(mine), true);
  assert.strictEqual(S.settledByYou(theirs), false);
  assert.match(S.findingStatus(mine), /✓ settled/);
  assert.match(S.findingStatus(mine), /Deliberate: callers negate b\./, 'the reason is on it, for whoever reads this later');
  assert.doesNotMatch(S.findingStatus(mine), /closed/, 'one decision, said once');
  assert.match(S.findingStatus(theirs), /Won&#39;t fix|Won't fix/);
});

test('settling is offered on a published comment and never on an unpublished one', () => {
  // The card offers it only where there is a thread to have been argued in.
  assert.match(source, /f\.publishedId && !f\.dismissedAt && !findingDone\(f\)\) html \+= settleBox\(f\.id\)/);
  assert.match(source, /settleFinding'[\s\S]{0,120}settled: on/, 'and it can be undone');
});

/*
 * The fixes table is drawn newest first; the branch holds them oldest first.
 * Reason about "what sits under this commit" in the table's order and "hand
 * back to here" hands back the lot — which is what it did, measured against a
 * real workshop: picking the first commit pushed both.
 */
test('the workshop reasons about its commits in the order the branch holds them', () => {
  const at = source.indexOf('function workshopBody');
  assert.ok(at > 0, 'workshopBody is still there');
  const body = source.slice(at, at + 600);
  assert.match(
    body,
    /filter\(pendingFix\)[\s\S]{0,200}sort\([\s\S]{0,200}createdAt/,
    'the pending fixes are sorted by when they were made before anything counts positions in them',
  );
});

/*
 * A field drawn on the repository form and left out of what Save sends is a
 * field that silently does nothing — which is how `checkCommand` first shipped
 * in this panel, saving nothing while looking saved.
 */
test('every field on the repository form is in what Save sends', () => {
  const at = source.indexOf('function formPayload');
  assert.ok(at > 0, 'formPayload is still there');
  const payload = source.slice(at, source.indexOf('\n  }', at));
  const drawn = [...source.matchAll(/data-form="([A-Za-z][\w]*)"/g)].map((m) => m[1]);
  const named = [...source.matchAll(/(?:radio|input|select|check)\('([A-Za-z][\w]*)'/g)].map((m) => m[1]);
  const missing = [...new Set([...drawn, ...named])]
    .filter((field) => !field.startsWith('dash-') && field !== 'import-pick')
    .filter((field) => !new RegExp(`\\b${field}:`).test(payload));
  assert.deepStrictEqual(missing, [], `Drawn on the form and never sent:\n  ${missing.join('\n  ')}`);
});

// ---------------------------------------------------------------- tables stay in their panel

/*
 * `table.list` was written for the board, where every column but the title is
 * a number or a date, so nowrap was imposed on all of them. The Fix workshop
 * reuses that table with a column of prose — a finding's title, the summary of
 * a fix, the words of an error — and a two-hundred-character cell that cannot
 * wrap makes the table wider than the panel holding it. Measured: a 1146px
 * panel around a 1563px table, and the horizontal scroll went to the page.
 */
test('a table cell holding prose is allowed to wrap', () => {
  // The rules live in the <style> block; `source` is only the script.
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.match(style, /table\.list td\.wrap \{[^}]*white-space: normal/, 'there is a way to say "this cell is prose"');
  assert.match(
    style,
    /table\.list td:not\(\.title-cell\):not\(\.wrap\) \{ white-space: nowrap/,
    'and nowrap no longer reaches it',
  );
});

test('every cell that carries a summary or an error says it wraps', () => {
  // For each place prose is put in a row, the cell it lands in is the nearest <td before it.
  const fields = [...source.matchAll(/fix\.summary|fix\.error|e\.message/g)];
  const bare = [];
  let found = 0;
  for (const field of fields) {
    const opens = source.lastIndexOf('<td', field.index);
    const closes = source.lastIndexOf('</td>', field.index);
    // Outside a row — a chip's title, a card — is not this test's business.
    if (opens < 0 || closes > opens) continue;
    found++;
    const tag = source.slice(opens, source.indexOf('>', opens) + 1);
    if (!/class="[^"]*\bwrap\b/.test(tag)) bare.push(`${field[0]} in ${tag}`);
  }
  assert.ok(found >= 2, 'the workshop and the read errors are both still drawn as table cells');
  assert.deepStrictEqual(bare, [], 'a prose cell without the wrap class grows the table past its panel');
});

// ---------------------------------------------------------------- reminders

/*
 * The reviewer's half of a reminder is *when*. Where a message goes once it
 * leaves the pull request is a delivery extension's business, and this panel
 * must not learn an address, a tenant or a channel — swap the delivery
 * extension for a Slack one and none of this screen changes.
 */
/*
 * The reviewer knows there is something that delivers, and nothing about what.
 *
 * `channel` used to be on this list and has come off it, deliberately. A room
 * and a person are the two destinations the delivery contract itself is written
 * in — every extension that carries a message takes one or the other — so
 * naming a room is naming the contract, not the extension behind it. A webhook,
 * a tenant, Graph and the word Teams are still none of the reviewer's business,
 * and that is the half this test is for.
 */
test('the reminder screen names no delivery extension at all', () => {
  const at = source.indexOf('function remindersSection');
  assert.ok(at > 0, 'the section is still there');
  const section = source.slice(at, at + 3600).toLowerCase();
  for (const word of ['teams', 'slack', 'webhook', 'tenant', 'graph.', 'incoming']) {
    assert.ok(!section.includes(word), `the reviewer must not know about ${word}`);
  }
  // What it does say is which of the two destinations can be reached.
  assert.match(source.slice(at, at + 3600), /delivery\.person/);
  assert.match(source.slice(at, at + 3600), /delivery\.channel/);
  assert.match(source.slice(at, at + 3600), /nothing installed that can deliver/);
});

/*
 * A button that cannot do anything is worse than no button: the one that
 * reaches somebody outside the pull request only exists when something is set
 * up to carry it.
 */
/*
 * "When it can" is two things, and this only ever checked one. Pressing the
 * button asks the reviewer what is due on this pull request, and nothing is
 * ever due while every rule is off — the default on a fresh install — so a
 * green button on a twelve-day-old thread answered "nothing on that pull
 * request is waiting long enough".
 */
/*
 * "When it can" is three things, and this checked one of them at a time.
 *
 * Pressing it asks the reviewer what is due, and nothing is ever due while every
 * rule is off — the default on a fresh install. And it sends somebody a *direct
 * message*, so a delivery extension that can only reach a room cannot carry it:
 * `ready` meaning "one of the two ways works" drew a green button that answered
 * "the app registration is not filled in".
 */
test('the button that reaches somebody outside appears only when it can', () => {
  assert.match(source, /if \(delivery\.person && anyRuleOn\) \{[\s\S]{0,400}data-act="remind-out"/);
  assert.match(source, /rule\.mode !== 'OFF'/, 'a rule has to be on');
});

test('every answer the delivery gives is said in words, not swallowed', () => {
  const at = source.indexOf("'remind-out': function");
  const handler = source.slice(at, at + 1200);
  for (const why of ['asks-first', 'no-address', 'already-sent', 'quiet-hours']) {
    assert.ok(handler.includes(why), `${why} is explained rather than ignored`);
  }
  // And the thread is told first, whatever happens outside it.
  assert.match(handler, /Posted in the thread/);
});

// ---------------------------------------------------- choosing several at once

/*
 * Every verb the panel calls has to be in the router's allow-list, which has no
 * default channel — a name that is not there fails silently and the button
 * simply does nothing. That has already shipped once.
 */
test('the verb for reviewing several is one the router lets through', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'extensionHost.ts'), 'utf8');
  assert.match(source, /call\('reviewMany'/, 'the panel asks for it');
  assert.match(host, /'reviewMany'/, 'and the router knows it');
});

test('a tick does not open the row it sits in', () => {
  assert.match(
    source,
    /data-act-change'\) === 'pick-pr'\) event\.stopPropagation\(\)/,
    'choosing several must not take you away from the list you are choosing them in',
  );
});

/*
 * Handed over means acted on. Leaving the ticks would invite a second press
 * that reviews all of them again, and a review is a paid run.
 */
test('the ticks are cleared once they have been sent', () => {
  const at = source.indexOf("'review-chosen': function");
  const handler = source.slice(at, at + 900);
  assert.match(handler, /state\.chosen = \{\}/);
  assert.match(handler, /r\.failed/, 'and what failed is said rather than swallowed');
});

// ------------------------------------------------- the room, and the clock

/*
 * A field drawn on a form and missing from the payload looks saved and saves
 * nothing. That has shipped here before, so every field this section draws is
 * checked against what the save sends.
 */
test('every field the channel settings draw is in what gets saved', () => {
  const at = source.indexOf("'rules-save': function");
  const handler = source.slice(at, at + 1400);
  for (const field of ['announceChannel', 'announceEnabled', 'escalateDays']) {
    assert.ok(handler.includes(field), `${field} is drawn, so it has to be sent`);
  }
});

test('the verbs the new screens call are ones the router lets through', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'extensionHost.ts'), 'utf8');
  for (const verb of ['fixTimes', 'escalateNow']) {
    assert.match(source, new RegExp(`call\\('${verb}'`), `the panel asks for ${verb}`);
    assert.ok(host.includes(`'${verb}'`), `and the router knows ${verb}`);
  }
});

/*
 * Zero days means never say it in the room, so it must not be floored at one
 * the way the intervals are — a ceiling of one day would turn "off" into
 * "every day", which is the loudest possible reading of "off".
 */
test('zero days is a real answer for the escalation', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'review-service.js'), 'utf8');
  assert.match(service, /escalate\.days[^\n]*Math\.max\(0,/, 'floored at zero, not at one');
});

/*
 * The dial says how often each repository is looked at, and the line under it
 * works out what that costs. A field drawn and not sent looks saved and saves
 * nothing, which is why this is checked rather than assumed.
 */
test('the watch dial is drawn, sent, and its cost is worked out', () => {
  assert.match(source, /data-edit="watch-seconds"/, 'the dial is drawn');
  const at = source.indexOf("'rules-save': function");
  const handler = source.slice(at, at + 1600);
  assert.ok(handler.includes('watchSeconds') && handler.includes('watchEnabled'), 'and both are sent');
  assert.match(source, /watch\.requestsPerHour/, 'the cost is the number, not a promise');
});

/*
 * A room and a person are reached differently, and the reviewer is told about
 * each separately. `ready` alone meant "one of the two works", which is not a
 * question anything actually asks.
 */
test('the app tells the reviewer about each destination on its own', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const at = main.indexOf('deliveryState:');
  const block = main.slice(at, at + 900);
  assert.match(block, /channel: Boolean\(/);
  assert.match(block, /person: Boolean\(/);
});

/*
 * Said once, from the moment the engine records the run — not from the three
 * places that ask for one. Three copies were three things to keep in step, and
 * each said it before the engine had agreed to anything: a review refused for
 * an expired token announced itself and then never happened.
 */
test('the room is told from one place, when a review really begins', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'review-service.js'), 'utf8');
  const hooks = service.match(/announceReview\(/g) ?? [];
  assert.equal(hooks.length, 2, 'the definition and the one hook that calls it');
  assert.match(service, /event\?\.type === 'activity' && event\.run\?\.kind === 'review'/);

  const auto = fs.readFileSync(path.join(__dirname, '..', 'electron', 'review-auto.js'), 'utf8');
  assert.ok(!auto.includes('announce'), 'the sweep does not carry its own copy');
});

// ------------------------------------------------------ speaking as yourself

/*
 * Three destinations because they are three different acts, and each is only
 * offered when it can actually carry anything — the same rule the reminder
 * button needed, for the same reason.
 */
test('your own words can go to the thread, the room, or the author', () => {
  const at = source.indexOf('function sayBox');
  assert.ok(at > 0, 'the box is drawn');
  const box = source.slice(at, at + 2600);
  for (const where of ['thread', 'channel', 'person']) {
    assert.ok(box.includes(`data-where="${where}"`), `${where} is one of the choices`);
  }
  assert.match(box, /delivery\.channel \? '' : ' disabled'/, 'a room that cannot be reached is not offered');
  assert.match(box, /delivery\.person \? '' : ' disabled'/, 'nor a person');
});

test('the verb it calls is one the router lets through', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'extensionHost.ts'), 'utf8');
  assert.match(source, /call\('speak'/);
  assert.ok(host.includes("'speak'"));
});

/*
 * Said where it cannot be taken back from. Nothing is sent with nowhere chosen,
 * and what was typed survives a destination that failed — retyping a paragraph
 * because a channel was down is the worst possible answer to a channel being
 * down.
 */
test('nothing is sent with nowhere chosen, and a failure keeps the text', () => {
  const box = source.slice(source.indexOf('function sayBox'), source.indexOf('function sayBox') + 2600);
  assert.match(box, /text\.trim\(\) && anywhere \? busyAttr/, 'the button is dead until there is somewhere and something');

  const at = source.indexOf('    say: function ()');
  const handler = source.slice(at, at + 1200);
  assert.match(handler, /if \(!failed\.length\) \{[\s\S]{0,120}delete state\.edits\['say-text'\]/, 'cleared only when everything landed');
});
