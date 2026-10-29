'use strict';

/**
 * The parameters Jenkins works out when a form opens (Active Choices): reading what the form holds, asking again when a
 * parameter they read changes, and — most of all — what is done with HTML that a job's script made.
 */

const test = require('node:test');
const assert = require('node:assert');

const { ActiveChoices, parseForm, toBlocks, plainOf, cookiesOf, choiceOf } = require('../electron/jenkins-active-choices');
const { fakeActiveChoices, UUID_BUMP, UUID_VERSIONS } = require('./support/active-choices-jenkins');

const everything = (blocks) => JSON.stringify(blocks);

test('a table a job made is read as a table, and what is bold, code or dim is said so', () => {
  const blocks = toBlocks(`<table style='border-collapse:collapse'><tr style='opacity:.6'><th align='left'>library</th><th>pom declares</th></tr>
    <tr><td><code>common</code></td><td><b>2.5.3</b></td></tr></table><p><b>Nothing to release.</b> <code>common</code> 2.5.3 &amp; more</p><div style='opacity:.6'>as of build #198</div>`);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0].head.map((c) => c.runs[0].t), ['library', 'pom declares']);
  assert.deepEqual(blocks[0].rows[0].map((c) => c.runs[0]), [{ t: 'common', code: true }, { t: '2.5.3', b: true }]);
  assert.deepEqual(blocks[1].runs.map((r) => [r.t, Boolean(r.b), Boolean(r.code)]), [['Nothing to release.', true, false], [' ', false, false], ['common', false, true], [' 2.5.3 & more', false, false]]);
  assert.equal(blocks[2].dim, true);
  assert.equal(plainOf(blocks).includes('as of build #198'), true);
});

test('nothing but text survives: scripts, handlers, links, images, frames, styles and forms are gone', () => {
  const hostile = `<p onclick="steal()">Hello <a href="javascript:steal()" onmouseover="x()">click</a></p>
    <script>window.top.location='https://evil.test'</script><style>body{display:none}</style>
    <img src=x onerror="steal()"><iframe src="https://evil.test"></iframe><svg onload="steal()"><text>svg text</text></svg>
    <object data="x"></object><form action="https://evil.test"><input name="p" value="typed"><button>Go</button></form>
    <textarea>area</textarea><select><option>opt</option></select><!-- <b>comment</b> --><math><mi>m</mi></math>`;
  const blocks = toBlocks(hostile);
  const text = plainOf(blocks);
  assert.match(text, /Hello click/);
  for (const bad of ['steal', 'evil', 'javascript', 'display', 'svg text', 'area', 'opt', 'comment', 'onclick', 'onerror', 'typed']) assert.equal(text.includes(bad), false, bad);
  // And the shape is only ever text blocks and tables of runs: no attribute, no tag name, nothing that is markup.
  assert.equal(/href|src|style|onclick|<|>/.test(everything(blocks)), false, everything(blocks));
  const kinds = new Set();
  const walk = (value) => { if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { kinds.add(k); walk(v); } };
  walk(blocks);
  assert.deepEqual([...kinds].filter((k) => !/^\d+$/.test(k)).sort(), ['b', 'code', 'dim', 'head', 'rows', 'runs', 't', 'type'].filter((k) => kinds.has(k)).sort());
});

test('what is built from broken or hostile HTML is bounded and still text', () => {
  // Unclosed, stray and nested tags do not throw, and do not leak into what follows.
  assert.doesNotThrow(() => toBlocks('<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table></b></code><p><b>open'));
  assert.equal(plainOf(toBlocks('<table><tr><td>a<table><tr><td>inner</td></tr></table>b</td></tr></table>')).includes('inner'), true, 'a nested table is flattened into its cell');
  assert.equal(toBlocks('<script>unclosed alert(1)').length, 0, 'an unclosed script swallows the rest rather than showing it');
  // Control and bidirectional characters that dress text up are gone.
  assert.equal(plainOf(toBlocks('<p>a‮b​c\u0007d</p>')), 'abcd');
  // Size: a thousand rows, a thousand cells, a long text, a megabyte of nothing.
  const big = toBlocks(`<table>${'<tr>' + '<td>x</td>'.repeat(50) + '</tr>'.repeat(1)}`.repeat(1) + '<tr><td>y</td></tr>'.repeat(1000) + '</table>' + `<p>${'long '.repeat(5000)}</p>` + '<p>p</p>'.repeat(500));
  assert.ok(big.length <= 41);
  const table = big.find((b) => b.type === 'table');
  assert.ok(table.rows.length <= 200 && table.rows.every((r) => r.length <= 12));
  assert.ok(big.filter((b) => b.type === 'text').every((b) => b.runs.length <= 60 && b.runs.every((r) => r.t.length <= 600)));
  assert.doesNotThrow(() => toBlocks(' '.repeat(1_000_000) + '<p>end</p>'));
  assert.doesNotThrow(() => toBlocks('<' + 'a'.repeat(200_000)));
  // Entities: the ones that are text, and numbers that are not characters are dropped.
  assert.equal(plainOf(toBlocks('<p>&lt;b&gt; &#65; &#x42; &#0; &#xD800; &nbsp;&unknown;</p>')), '<b> A B &unknown;');
});

test('a form page says which parameters are reactive, what they read, and what they held when it was built', () => {
  const { page } = fakeActiveChoices();
  const found = parseForm(page());
  assert.deepEqual(found.map((p) => [p.name, p.kind, p.refs, p.uuid]), [
    ['CURRENT_VERSIONS', 'reference', ['LIB', 'BUMP', 'OVERWRITE'], UUID_VERSIONS],
    ['BUMP', 'cascade', ['LIB'], UUID_BUMP],
  ]);
  const bump = found.find((p) => p.name === 'BUMP');
  assert.deepEqual(bump.initial.choices, ['POM (2.5.3)', 'MINOR', 'PATCH', 'MAJOR']);
  assert.equal(bump.initial.selected, 'POM (2.5.3)');
  const versions = found.find((p) => p.name === 'CURRENT_VERSIONS');
  assert.equal(versions.view, 'html');
  assert.equal(versions.initial.blocks[0].type, 'table');
  assert.deepEqual(versions.initial.blocks[0].rows.map((r) => r[0].runs[0].t), ['common', 'mongo-common']);
  assert.deepEqual(parseForm('<html>no plugin here</html>'), []);
  assert.deepEqual(parseForm(null), []);
});

test('a page cannot make the app ask for any address of its own choosing, or for a name it made up', () => {
  const evil = `<span data-referenced-parameters="LIB, ../../x ,b;c" data-name="BUMP" data-param-name="choice-parameter-3" data-proxy-name="proxy" class="cascade-choice-parameter-data-holder"></span>
    <span data-name="../etc" data-param-name="x" data-proxy-name="p" class="cascade-choice-parameter-data-holder"></span>
    <span data-name="OK" data-param-name="x y" data-proxy-name="p" class="cascade-choice-parameter-data-holder"></span>
    <script src="/$stapler/bound/script/$stapler/bound/../../../manage?var=proxy&amp;methods=a"></script>`;
  const found = parseForm(evil);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].refs, ['LIB'], 'a name that is not a parameter name is not asked for');
  assert.equal(found[0].uuid, null, 'a bound object is a UUID or nothing');
});

test('the form is read from the 405 it comes in, with the session it was made in', async () => {
  const { api, model } = fakeActiveChoices();
  const read = await new ActiveChoices(api).read('/job/a');
  assert.equal(read.params.length, 2);
  assert.equal(read.cookie, model.session);
  assert.deepEqual(model.calls[0].opts.allow, [405]);
  // A Jenkins that does not have the plugin: nothing reactive, nothing said.
  const plain = { async rawGet() { return { status: 200, bytes: Buffer.from('<html>a form</html>'), tooBig: false, headers: { get: () => null } }; } };
  assert.equal(await new ActiveChoices(plain).read('/job/a'), null);
  // Cookies: only name=value pairs go back, never attributes.
  assert.deepEqual(cookiesOf({ getSetCookie: () => ['A=1; Path=/; HttpOnly', 'B=2; Secure', 'bad cookie; x', 'C=3'] }), ['A=1', 'B=2', 'C=3']);
  assert.deepEqual(cookiesOf({ get: () => 'A=1; Path=/, B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT' }), ['A=1', 'B=2']);
  assert.deepEqual(cookiesOf({ get: () => null }), []);
  // Electron's fetch joins them into one string, even from getSetCookie (measured): the session is not always the first.
  assert.deepEqual(cookiesOf({ getSetCookie: () => ['other=2; Path=/, JSESSIONID.x=ABC; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly'] }), ['other=2', 'JSESSIONID.x=ABC']);
});

test('changing LIB asks Jenkins again, as the plugin does: the session, the crumb its script carried, and only what is read', async () => {
  const { api, model } = fakeActiveChoices();
  const got = await new ActiveChoices(api).refresh('/job/a', { LIB: 'mongo-common', BUMP: 'MINOR', OVERWRITE: 'YES', DRY_RUN: 'NO', PASSWORD: 'hunter2' });
  assert.deepEqual(got.BUMP.choices, ['POM (2.3.0)', 'MINOR', 'PATCH', 'MAJOR'], 'the list of the other library');
  assert.equal(got.BUMP.selected, 'POM (2.3.0)');
  assert.equal(plainOf(got.CURRENT_VERSIONS.blocks).includes('Will release. mongo-common 2.3.0 & more'), true);
  // What was sent, and to what: the names a parameter reads, joined as the plugin joins them, and nothing else.
  assert.equal(model.sent[UUID_BUMP], 'LIB=mongo-common');
  assert.equal(model.sent[UUID_VERSIONS], 'LIB=mongo-common__LESEP__BUMP=MINOR__LESEP__OVERWRITE=YES', 'a block that reads BUMP gets the BUMP the person has, which is still a choice');
  assert.equal(JSON.stringify(model.calls).includes('hunter2'), false);
  assert.equal(JSON.stringify(model.calls).includes('DRY_RUN'), false);
  const posts = model.calls.filter((c) => c.method === 'POST');
  assert.ok(posts.every((c) => c.opts.headers.Cookie === model.session && c.opts.headers.Crumb === model.crumb && /x-stapler-method-invocation/.test(c.opts.contentType)));
  assert.ok(posts.every((c) => /^\/\$stapler\/bound\/[0-9a-f-]{36}\/(doUpdate|getChoicesForUI|getChoicesAsStringForUI)$/.test(c.path)));
  assert.equal(model.pages, 1, 'one form page for the whole question');
});

test('the value the person has is kept if it is still a choice, and replaced by the one Jenkins marks if it is not', async () => {
  const kept = fakeActiveChoices();
  await new ActiveChoices(kept.api).refresh('/job/a', { LIB: 'mongo-common', BUMP: 'PATCH', OVERWRITE: 'NO' });
  assert.equal(kept.model.sent[UUID_VERSIONS], 'LIB=mongo-common__LESEP__BUMP=PATCH__LESEP__OVERWRITE=NO', 'PATCH is a choice of the other library too');
  const replaced = fakeActiveChoices();
  await new ActiveChoices(replaced.api).refresh('/job/a', { LIB: 'mongo-common', BUMP: 'POM (2.5.3)', OVERWRITE: 'NO' });
  assert.equal(replaced.model.sent[UUID_VERSIONS], 'LIB=mongo-common__LESEP__BUMP=POM (2.3.0)__LESEP__OVERWRITE=NO', 'the other library has no such pom: what the block reads is what Jenkins marks');
});

test('a value that tries to be a separator, or a line, is not one', async () => {
  const { api, model } = fakeActiveChoices();
  await new ActiveChoices(api).refresh('/job/a', { LIB: 'common__LESEP__BUMP=MAJOR\nOVERWRITE=YES', OVERWRITE: 'x'.repeat(5000) });
  assert.equal(model.sent[UUID_BUMP], 'LIB=common BUMP=MAJOR OVERWRITE=YES', 'one name, one pair');
  assert.ok(model.sent[UUID_VERSIONS].length < 1200);
});

test('when Jenkins cannot say, each parameter says so and the others still answer', async () => {
  const one = fakeActiveChoices();
  one.model.failMethod = 'getChoicesForUI';
  const got = await new ActiveChoices(one.api).refresh('/job/a', { LIB: 'common' });
  assert.match(got.BUMP.error, /500/);
  const down = fakeActiveChoices({ down: true });
  await assert.rejects(new ActiveChoices(down.api).refresh('/job/a', { LIB: 'common' }), /Could not reach Jenkins/);
  // A session that is not the one the bound object lives in is refused, and says so.
  const stale = fakeActiveChoices();
  const real = stale.api.rawGet;
  stale.api.rawGet = async (path, opts) => { const r = await real(path, opts); r.headers = { get: () => null, getSetCookie: () => [] }; return r; };
  const refused = await new ActiveChoices(stale.api).refresh('/job/a', { LIB: 'common' });
  assert.ok(refused.BUMP.error && refused.CURRENT_VERSIONS.error);
});

test('an answer that is not what the plugin sends is an error for that parameter, not a crash or HTML on screen', async () => {
  const { api } = fakeActiveChoices({ tableHtml: () => '<img src=x onerror=steal()><script>steal()</script><b>fine</b>' });
  const got = await new ActiveChoices(api).refresh('/job/a', { LIB: 'common' });
  assert.deepEqual(got.CURRENT_VERSIONS.blocks, [{ type: 'text', runs: [{ t: 'fine', b: true }] }]);
  const bad = fakeActiveChoices();
  const post = bad.api.rawPost;
  bad.api.rawPost = async (path, body, opts) => (path.endsWith('getChoicesForUI') ? { status: 200, bytes: Buffer.from('<html>not json</html>'), tooBig: false, headers: { get: () => null } } : post(path, body, opts));
  const answers = await new ActiveChoices(bad.api).refresh('/job/a', { LIB: 'common' });
  assert.match(answers.BUMP.error, /not with what the plugin sends/);
  assert.equal(choiceOf('a:selected:disabled').value, 'a');
  assert.deepEqual(choiceOf('b'), { value: 'b', selected: false });
});

test('a plain Active Choices list (ChoiceParameter) is read from the form, with the labels and the first option chosen', () => {
  // As a real Jenkins writes it: no data holder, the select already filled, a description that has a ">" in it.
  const html = '<div name="parameter" description="newest first -> latest" id="choice-parameter-6679895081450235" class="active-choice"><input name="name" type="hidden" value="VERSION"><div class="jenkins-select ac-ignore"><select name="value" class="jenkins-select__input"><option value="latest">latest</option><option value="2.2.0.335 (latest)">2.2.0.335 (latest)</option><option value="2.2.0.334">2.2.0.334</option></select></div></div><div class="validation-error-area"></div>'
    + '<div name="parameter"><input name="name" type="hidden" value="VERSION_OVERRIDE"><input name="value" type="text"></div>';
  const found = parseForm(html);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'VERSION');
  assert.equal(found[0].kind, 'choice');
  assert.deepEqual(found[0].refs, []);
  assert.deepEqual(found[0].initial.choices, ['latest', '2.2.0.335 (latest)', '2.2.0.334']);
  assert.equal(found[0].initial.selected, null);
});

test('a list that allows several (multi-select or checkboxes) is marked, and starts with all the ticked ones', () => {
  const select = '<div id="choice-parameter-1" class="active-choice"><input name="name" type="hidden" value="MODULES"><select name="value" multiple="multiple"><option value="api" selected>api</option><option value="web">web</option><option value="db" selected>db</option></select></div><div class="validation-error-area"></div>';
  const [one] = parseForm(select);
  assert.equal(one.multiple, true);
  assert.equal(one.initial.multiple, true);
  assert.equal(one.initial.selected, 'api,db');
  const boxes = '<div id="choice-parameter-2" class="active-choice"><input name="name" type="hidden" value="ENVS"><div><input type="checkbox" value="qa" checked><input type="checkbox" value="prod"></div></div><div class="validation-error-area"></div>';
  const [two] = parseForm(boxes);
  assert.equal(two.multiple, true);
  assert.equal(two.initial.selected, 'qa');
  // A single select stays single.
  const single = select.replace(' multiple="multiple"', '');
  assert.equal(parseForm(single)[0].multiple, false);
  assert.equal(parseForm(single)[0].initial.selected, 'api');
});
