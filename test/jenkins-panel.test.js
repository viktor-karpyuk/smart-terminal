'use strict';

/**
 * The Jenkins panel: the parts of it that are logic rather than drawing.
 *
 * A panel is one script in a sandboxed frame, so there is nothing to import.
 * Each piece is extracted from the panel as it ships and run in an empty
 * context — a copy in a test would be a copy that drifts — and what is checked
 * is what a person would notice when it is wrong: a time that says "just now"
 * for a minute, a progress bar that fills past the end, a stage that did not run
 * drawn as one that did, a colour code that turns a true-colour escape into red,
 * a progress bar that rewrites itself into two hundred lines.
 *
 * The same file holds the panel to the promises that cannot be seen in a
 * screenshot: that nothing a server says is ever read as markup, and that every
 * call the panel makes is one the app routes and permits.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'extensions', 'jenkins', 'panel.html');
const html = fs.readFileSync(file, 'utf8');
const source = /<script>([\s\S]*)<\/script>/.exec(html)[1];

/** The named top-level declarations, each taken whole, evaluated together. */
function fromPanel(names, globals = {}) {
  const boundary = /\n {2}(?![ }\])])\S/g;
  const pieces = names.map((name) => {
    const at = source.search(new RegExp(`\\n {2}(?:var|function) ${name}\\b`));
    assert.ok(at >= 0, `the panel no longer defines ${name}`);
    boundary.lastIndex = at + 1;
    const next = boundary.exec(source);
    return source.slice(at, next ? next.index : source.length).trimEnd();
  });
  const context = vm.createContext({ ...globals });
  vm.runInContext(`${pieces.join('\n')}\n;this.__out = { ${names.join(', ')} };`, context);
  return context.__out;
}

const P = fromPanel([
  'pad', 'ago', 'dur', 'progressOf', 'ENTITIES', 'plainText', 'explainError', 'word', 'isOutage',
  'applySgr', 'ansiSegments', 'cleanLogText', 'foldReturns', 'logLines',
  'isExecuted', 'stageClass', 'isSlow', 'stageShare', 'currentStageName', 'lineIsStage', 'pausedStage', 'urlHint',
  'PAGE_TYPES', 'SMART_KINDS', 'cleanPage', 'listKey', 'SMART_NOTES', 'STATUS_ORDER', 'sortRows', 'matchRow',
  'ARCHIVE_MODES', 'ARCHIVE_LIMITS', 'formatBytes', 'clampNumber', 'archiveUsage', 'copyNote', 'hasCopy',
  'IMPORT_EXAMPLE', 'describeImport', 'exportWhat', 'describeExport',
  'groupParams', 'RANGES', 'rangeOf', 'packLanes', 'runsAt', 'niceTicks', 'compact', 'WEEKDAYS', 'MONTHS', 'fmtMoment', 'fmtTick', 'deltaOf', 'ratePct', 'downsample', 'stepCursor', 'heatLevel', 'isStuck', 'fractionOf', 'PALETTE_ACTIONS', 'paletteActions', 'typeAheadFrom', 'MIN_WINDOW_MS', 'fitWindow', 'fitBuckets', 'binFinished', 'binLoad', 'historyCovers', 'assign', 'PATIENT', 'declined', 'promoteItems', 'promoteMissing', 'promoteSend', 'rememberableParams', 'inputDefaults', 'inputAnswers', 'isCertError', 'certDay', 'buildPercent', 'NOTIFY_SWITCHES', 'commitLine', 'BOARD_OLD', 'boardLags', 'boardNeverBuilt', 'boardNoise', 'boardRank', 'boardKind', 'boardPrepare', 'DISGUISES', 'plainShown', 'SCOPE_TRIGGERS', 'SCOPE_RESULTS', 'scopeArgs', 'scopeChips', 'scopeMatchesPath', 'csvCell', 'csvOf', 'heatTone', 'trendWords', 'driftWords', 'LAUNCH_WORDS', 'LAUNCH_GLYPHS', 'launchWord', 'launchGlyph', 'launchOver', 'launchTone', 'quickChoices', 'whenWords', 'parseLocalTime', 'toLocalTime', 'paramProblems', 'callPreviewText', 'reactiveReads', 'paramDefault', 'differsFromDefault', 'formLooksProd', 'batchProgress', 'paramChips', 'promoteWorthAsking', 'packLanesPx', 'densityColumns', 'zoomWindow', 'panWindow', 'jobsByActivity', 'spanWords', 'CLAUDE_DENIED', 'CLAUDE_OUTCOME', 'claudeResult', 'queueJobPath',
]);

test('a time is "just now" for under a minute, and then says how long, in the unit that fits', () => {
  const now = 1_700_000_000_000;
  const at = (seconds) => P.ago(now - seconds * 1000, now);
  assert.equal(at(0), 'just now');
  assert.equal(at(44), 'just now');
  assert.equal(at(45), '1 min ago');
  assert.equal(at(119), '1 min ago');
  assert.equal(at(5 * 60), '5 min ago');
  assert.equal(at(59 * 60), '59 min ago');
  assert.equal(at(3600), '1 h ago');
  assert.equal(at(47 * 3600), '47 h ago');
  assert.equal(at(48 * 3600), '2 d ago');
  assert.equal(at(-30), 'just now', 'a clock a little ahead of the server is not "in the future"');
  assert.equal(P.ago(0, now), '', 'no time, no words');
});

test('a duration is short when it is short, and something that ran is never a dash', () => {
  assert.equal(P.dur(0), '—');
  assert.equal(P.dur(undefined), '—');
  assert.equal(P.dur(120), '<1s', 'ran for 120 ms: it ran');
  assert.equal(P.dur(499), '<1s');
  assert.equal(P.dur(1000), '1s');
  assert.equal(P.dur(59_000), '59s');
  assert.equal(P.dur(61_000), '1:01');
  assert.equal(P.dur(600_000), '10:00');
  assert.equal(P.dur(3_725_000), '1:02:05', 'an hour is not "62:05"');
});

test('progress is what has passed of what is expected, never empty and never complete while running', () => {
  assert.equal(P.progressOf(30_000, 60_000), 50);
  assert.equal(P.progressOf(0, 60_000), 2);
  assert.equal(P.progressOf(59_999_999, 60_000), 95, 'a build that is slower than usual is not at 100 per cent');
  assert.equal(P.progressOf(1000, 0), null, 'no estimate is no bar, not a bar at zero');
  assert.equal(P.progressOf(1000, undefined), null);
  assert.equal(P.progressOf(-5, 60_000), null);
});

test('a description is text: tags are dropped, entities read, and what is left is never markup', () => {
  assert.equal(P.plainText('<b>bold</b> and <i>italic</i>'), 'bold and italic');
  assert.equal(P.plainText('one<br>two<br/>three'), 'one\ntwo\nthree');
  assert.equal(P.plainText('<p>para one</p><p>para two</p>'), 'para one\npara two');
  assert.equal(P.plainText('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39; &#x41;&#66;'), 'a & b < c > d "e" \'f\' AB');
  // Written as an entity, a tag is a word that looks like a tag — and stays a word.
  assert.equal(P.plainText('&lt;img src=x onerror=alert(1)&gt;'), '<img src=x onerror=alert(1)>');
  assert.equal(P.plainText('<img src=x onerror=alert(1)>'), '');
  assert.equal(P.plainText('<script>alert(1)</script>after'), 'after');
  assert.equal(P.plainText('<style>body{display:none}</style>shown'), 'shown');
  assert.equal(P.plainText('<a href="javascript:alert(3)">link</a>'), 'link');
  assert.equal(P.plainText('&nosuchthing; and &#99999999;'), '&nosuchthing; and &#99999999;', 'what is not an entity is left alone');
  assert.equal(P.plainText(null), '');
  assert.equal(P.plainText(undefined), '');
  assert.equal(P.plainText('  a\n\n\n\n b  '), 'a\n\n b');
});

test('what went wrong is said in words, and what has no better words is left as it came', () => {
  assert.match(P.explainError('Could not reach Jenkins: net::ERR_CONNECTION_REFUSED'), /Nothing answered at that address/);
  assert.match(P.explainError('Could not reach Jenkins: net::ERR_NAME_NOT_RESOLVED'), /host name was not found/);
  assert.match(P.explainError('Could not reach Jenkins: ENOTFOUND'), /host name was not found/);
  assert.match(P.explainError('Could not reach Jenkins: net::ERR_CERT_AUTHORITY_INVALID'), /certificate/);
  assert.match(P.explainError('Could not reach Jenkins: net::ERR_SSL_PROTOCOL_ERROR'), /http:\/\//);
  assert.match(P.explainError('Jenkins did not answer within 20 seconds'), /too long/);
  assert.match(P.explainError('Jenkins has nothing there'), /\/jenkins/);
  assert.equal(P.explainError('Jenkins did not accept that user and token'), 'Jenkins did not accept that user and token');
  assert.equal(P.explainError(''), '');
  assert.equal(P.explainError(undefined), '');
});

test('a failure that is the server being away is told from one that is the server saying no', () => {
  for (const down of ['Could not reach Jenkins: net::ERR_CONNECTION_REFUSED', 'Jenkins did not answer within 20 seconds', 'ECONNRESET', 'ENOTFOUND host']) assert.equal(P.isOutage(down), true, down);
  for (const no of ['Jenkins did not accept that user and token', 'Jenkins has nothing there', 'job name is missing']) assert.equal(P.isOutage(no), false, no);
});

test('colour codes: the eight Jenkins uses, bold, brights as their twins — and a true-colour escape is not a red one', () => {
  const run = (text, st = { fg: null, bold: false }) => P.ansiSegments(text, st).map((one) => [one.text, one.fg, one.bold]);
  assert.deepEqual(run('plain'), [['plain', null, false]]);
  assert.deepEqual(run('\u001b[31mred\u001b[0m plain'), [['red', 31, false], [' plain', null, false]]);
  assert.deepEqual(run('\u001b[1;32mgo\u001b[0m'), [['go', 32, true]]);
  assert.deepEqual(run('\u001b[91mbright\u001b[39m after'), [['bright', 31, false], [' after', null, false]], 'a bright red is the red');
  assert.deepEqual(run('\u001b[90mgrey\u001b[m'), [['grey', 90, false]], 'ESC[m is a reset');
  // 38;2;31;32;33 is ONE colour made of five numbers. Read number by number it is a bold... no: red, then green, then yellow.
  assert.deepEqual(run('\u001b[38;2;31;32;33mtrue\u001b[0m'), [['true', null, false]]);
  assert.deepEqual(run('\u001b[38;5;196m256\u001b[0m'), [['256', null, false]]);
  assert.deepEqual(run('\u001b[48;2;1;2;3mbackground\u001b[0m'), [['background', null, false]]);
  assert.deepEqual(run('\u001b[1;38;5;31mbold then 256\u001b[0m'), [['bold then 256', null, true]], 'a colour that is not drawn does not stop the bold that came with it');
  // The colour is carried from one line to the next, as a terminal does.
  const st = { fg: null, bold: false };
  P.ansiSegments('\u001b[33mstart of a coloured line', st);
  assert.deepEqual(P.ansiSegments('and its next line', st).map((one) => [one.text, one.fg]), [['and its next line', 33]]);
});

test('what a terminal would do with the cursor is dropped; the colours stay', () => {
  assert.equal(P.cleanLogText('\u001b[2K\u001b[1Gloading\u001b[0m'), 'loading\u001b[0m');
  assert.equal(P.cleanLogText('\u001b]0;window title\u0007text'), 'text');
  assert.equal(P.cleanLogText('\u001b[31mred\u001b[0m'), '\u001b[31mred\u001b[0m');
  assert.equal(P.cleanLogText('\u001b[?25lhidden cursor\u001b[?25h'), 'hidden cursor');
});

test('a console arrives in pieces: lines are whole, a progress bar is one line, a split CR LF is not two', () => {
  assert.deepEqual(P.logLines('', 'one\ntwo\nthr'), { lines: ['one', 'two'], carry: 'thr' });
  assert.deepEqual(P.logLines('thr', 'ee\nfour\n'), { lines: ['three', 'four'], carry: '' });
  assert.deepEqual(P.logLines('', ''), { lines: [], carry: '' });
  // A progress bar rewrites itself with a bare CR: the line is what it ends up saying.
  assert.deepEqual(P.logLines('', 'progress 10%\rprogress 50%\rprogress 100%\ndone\n').lines, ['progress 100%', 'done']);
  assert.deepEqual(P.logLines('', 'a\r\nb\r\n').lines, ['a', 'b']);
  // Cut between the CR and the LF, the CR is held for the LF that follows, and the two are one line end.
  const first = P.logLines('', 'line one\r');
  assert.deepEqual(first, { lines: [], carry: 'line one\r' });
  assert.deepEqual(P.logLines(first.carry, '\nline two\n').lines, ['line one', 'line two']);
  assert.equal(P.foldReturns('plain'), 'plain');
  assert.equal(P.foldReturns('abc\r'), 'abc', 'a CR at the end of a line has nothing after it to overwrite with');
  assert.equal(P.foldReturns('\r\rlast'), 'last');
});

test('which stages ran: skipped ones and ones that never started are not executed', () => {
  assert.equal(P.isExecuted({ status: 'success' }), true);
  assert.equal(P.isExecuted({ status: 'failed', executed: true }), true);
  assert.equal(P.isExecuted({ status: 'success', executed: false }), false);
  assert.equal(P.isExecuted({ status: 'skipped' }), false);
  assert.equal(P.isExecuted({ status: 'none' }), false);
  assert.equal(P.isExecuted(null), false);
  assert.equal(P.stageClass({ status: 'failed' }), 'failed');
  assert.equal(P.stageClass({ status: 'running' }), 'running');
  assert.equal(P.stageClass({ status: 'success', executed: false }), 'skipped');
  assert.equal(P.stageClass(null), 'none');
});

test('a stage is slow when it is half again its usual and by more than noise', () => {
  assert.equal(P.isSlow(3100, 2000), true);
  assert.equal(P.isSlow(3000, 2000), false, 'exactly 1.5 times is not more than that');
  assert.equal(P.isSlow(2900, 2000), false, 'under 1.5 times');
  assert.equal(P.isSlow(900, 100), false, 'nine times a stage that takes nothing is still under a second more: noise');
  assert.equal(P.isSlow(1500, 100), true, 'but a second and a half over is not');
  assert.equal(P.isSlow(2500, 1000), true);
  assert.equal(P.isSlow(5000, 0), false, 'no usual, nothing to be slower than');
  assert.equal(P.isSlow(5000, undefined), false);
});

test('a stage\'s share of the build is of the stages that ran', () => {
  const stages = [
    { name: 'Build', status: 'success', duration: 1000 },
    { name: 'Test', status: 'success', duration: 3000 },
    { name: 'Lint', status: 'success', executed: false, duration: 0 },
    { name: 'Deploy', status: 'failed', duration: 1000 },
  ];
  assert.equal(P.stageShare(stages, stages[0]), 20);
  assert.equal(P.stageShare(stages, stages[1]), 60);
  assert.equal(P.stageShare(stages, stages[2]), 0, 'a stage that did not run has no share');
  assert.equal(P.stageShare([], stages[0]), 0);
  assert.equal(P.stageShare([{ name: 'x', status: 'success', duration: 0 }], { name: 'x', status: 'success', duration: 0 }), 0, 'no time at all is no share, not a division by zero');
  assert.equal(P.stageShare([{ name: 'x', status: 'success', duration: 1 }, { name: 'y', status: 'success', duration: 10000 }], { name: 'x', status: 'success', duration: 1 }), 2, 'never an invisible sliver');
});

test('where a running build is: the stage that runs, or the one that waits, and none between stages', () => {
  assert.equal(P.currentStageName([{ name: 'Build', status: 'success' }, { name: 'Test', status: 'running' }, { name: 'Deploy', status: 'skipped' }]), 'Test');
  assert.equal(P.currentStageName([{ name: 'Build', status: 'success' }, { name: 'Approve', status: 'paused' }]), 'Approve');
  assert.equal(P.currentStageName([{ name: 'Build', status: 'success' }]), null);
  assert.equal(P.currentStageName([]), null);
  assert.equal(P.currentStageName(undefined), null);
  assert.deepEqual(P.pausedStage({ stages: [{ name: 'a', status: 'success' }, { name: 'b', status: 'paused' }] }), { name: 'b', status: 'paused' });
  assert.equal(P.pausedStage({ stages: [{ name: 'a', status: 'success' }] }), null);
  assert.equal(P.pausedStage({}), null);
});

test('the line that starts a stage in the console is found by the stage\'s name, whatever is in it', () => {
  assert.equal(P.lineIsStage('[Pipeline] { (Build)', 'Build'), true);
  assert.equal(P.lineIsStage('[Pipeline] { (Build)', 'Test'), false);
  assert.equal(P.lineIsStage('[Pipeline] { (Build and test)', 'Build'), false, 'a stage whose name merely begins the same');
  assert.equal(P.lineIsStage('[Pipeline] { (Deploy (eu) [1+1])', 'Deploy (eu) [1+1]'), true, 'brackets and plus signs are characters, not a pattern');
  assert.equal(P.lineIsStage('[Pipeline] { (<img src=x>)', '<img src=x>'), true);
  assert.equal(P.lineIsStage('echo "[Pipeline] { (Build)" fake', 'Build'), true, 'only the marker is matched; it is a place to scroll to, not a promise');
});

test('an address that is a page inside Jenkins is said to be one', () => {
  assert.match(P.urlHint('https://ci.example.com/job/backend/'), /inside Jenkins/);
  assert.match(P.urlHint('https://ci.example.com/view/All/'), /inside Jenkins/);
  assert.match(P.urlHint('https://ci.example.com/login?from=%2F'), /inside Jenkins/);
  assert.equal(P.urlHint('https://ci.example.com'), '');
  assert.equal(P.urlHint('https://ci.example.com/jenkins'), '');
  assert.equal(P.urlHint('https://jobs.example.com'), '', 'a host that merely contains the word');
  assert.equal(P.urlHint(''), '');
});

test('words for a status are the ones a person says', () => {
  assert.equal(P.word('success'), 'passed');
  assert.equal(P.word('none'), 'not built');
  assert.equal(P.word('somethingnew'), 'somethingnew');
  assert.equal(P.word(undefined), '');
});

test('a place from outside is kept only if it is one this panel knows, with only the fields it has', () => {
  const good = (page) => P.cleanPage(page);
  assert.deepEqual(good({ type: 'home' }), { type: 'dashboard' }, 'there is no Home: it is the dashboard');
  assert.deepEqual(good({ type: 'dashboard' }), { type: 'dashboard' });
  assert.deepEqual(good({ type: 'queue', junk: 1 }), { type: 'queue' }, 'what a page does not have is dropped');
  assert.deepEqual(good({ type: 'setup' }), { type: 'setup' });
  assert.deepEqual(good({ type: 'job', path: 'team/app' }), { type: 'job', path: 'team/app' });
  assert.deepEqual(good({ type: 'folder', path: 'team' }), { type: 'folder', path: 'team' });
  assert.deepEqual(good({ type: 'folder', path: '' }), { type: 'folder', path: '' }, 'the top of a server is a folder with no name');
  assert.deepEqual(good({ type: 'build', path: 'team/app', number: 12, extra: 'x' }), { type: 'build', path: 'team/app', number: 12 });
  assert.deepEqual(good({ type: 'build', path: 'a', number: '7' }), { type: 'build', path: 'a', number: 7 }, 'a number that came as text is still a number');
  assert.deepEqual(good({ type: 'view', kind: 'smart', name: 'failing', path: 'ignored' }), { type: 'view', kind: 'smart', name: 'failing' });
  assert.deepEqual(good({ type: 'view', kind: 'jenkins', path: 'QA/Smoke' }), { type: 'view', kind: 'jenkins', path: 'QA/Smoke' });
  assert.deepEqual(good({ type: 'view', kind: 'jenkins', path: 'QA/Smoke', name: 'Smoke' }), { type: 'view', kind: 'jenkins', path: 'QA/Smoke', name: 'Smoke' });
  for (const bad of [null, undefined, 'job', 42, [], {}, { type: 'hax' }, { type: 'job' }, { type: 'job', path: '' }, { type: 'job', path: 7 },
    { type: 'folder' }, { type: 'folder', path: null }, { type: 'build', path: 'a' }, { type: 'build', path: 'a', number: 0 }, { type: 'build', path: 'a', number: 1.5 }, { type: 'build', path: 'a', number: 'x' },
    { type: 'view' }, { type: 'view', kind: 'smart', name: 'nonsense' }, { type: 'view', kind: 'smart' }, { type: 'view', kind: 'jenkins' }, { type: 'view', kind: 'other', path: 'x' },
    { type: 'job', path: 'x'.repeat(3000) }]) {
    assert.equal(P.cleanPage(bad), null, JSON.stringify(bad));
  }
  // The kinds named in the app's sidebar are the ones the panel can show.
  assert.deepEqual([...P.SMART_KINDS], ['failing', 'running', 'unstable', 'stale', 'disabled']);
  for (const kind of P.SMART_KINDS) assert.ok(P.SMART_NOTES[kind], `no explanation for the ${kind} view`);
  assert.deepEqual([...P.PAGE_TYPES], ['launches', 'queue', 'setup', 'job', 'build', 'folder', 'view', 'dashboard']);
});

test('a list is told apart by what it is about, so two lists never share a filter or a place', () => {
  assert.equal(P.listKey({ type: 'folder', path: 'team' }), 'f:team');
  assert.equal(P.listKey({ type: 'view', kind: 'smart', name: 'failing' }), 's:failing');
  assert.equal(P.listKey({ type: 'view', kind: 'jenkins', path: 'QA/Smoke' }), 'v:QA/Smoke');
  assert.notEqual(P.listKey({ type: 'folder', path: 'failing' }), P.listKey({ type: 'view', kind: 'smart', name: 'failing' }));
});

test('rows are sorted by name, status or last build — folders above jobs, and trouble above fine', () => {
  const rows = [
    { kind: 'job', name: 'svc-10', path: 'svc-10', status: 'success', last: { timestamp: 300 } },
    { kind: 'job', name: 'svc-2', path: 'svc-2', status: 'failed', last: { timestamp: 100 } },
    { kind: 'folder', name: 'zeta', path: 'zeta', status: 'none' },
    { kind: 'job', name: 'Alpha', path: 'Alpha', status: 'unstable', last: { timestamp: 200 } },
    { kind: 'job', name: 'busy', path: 'busy', status: 'success', running: true, last: { timestamp: 400 } },
    { kind: 'job', name: 'never', path: 'never', status: 'none', last: null },
  ];
  const names = (how) => P.sortRows(rows, how).map((row) => row.name);
  assert.deepEqual(names('name'), ['zeta', 'Alpha', 'busy', 'never', 'svc-2', 'svc-10'], 'numbers in names are numbers: svc-2 before svc-10');
  assert.deepEqual(names('status'), ['zeta', 'svc-2', 'Alpha', 'busy', 'never', 'svc-10'], 'failed, unstable, running, not built, then fine');
  assert.deepEqual(names('last'), ['zeta', 'busy', 'svc-10', 'Alpha', 'svc-2', 'never'], 'newest build first, never-built last');
  assert.deepEqual(P.sortRows(rows, 'name').length, rows.length);
  assert.equal(rows[0].name, 'svc-10', 'the rows it was given are not reordered in place');
  assert.deepEqual(P.sortRows([], 'name'), []);
});

test('a filter is every word of it, anywhere in the path, in any case', () => {
  const row = { name: 'svc-07', path: 'Team-02/Platform/svc-07' };
  assert.equal(P.matchRow(row, ''), true);
  assert.equal(P.matchRow(row, '   '), true);
  assert.equal(P.matchRow(row, 'svc'), true);
  assert.equal(P.matchRow(row, 'PLATFORM svc'), true);
  assert.equal(P.matchRow(row, 'svc platform'), true, 'in any order');
  assert.equal(P.matchRow(row, 'svc-08'), false);
  assert.equal(P.matchRow(row, 'platform zzz'), false, 'every word has to be there');
  assert.equal(P.matchRow({ name: 'a.b' }, 'a.b'), true, 'dots are dots, not a pattern');
  assert.equal(P.matchRow({ name: 'axb' }, 'a.b'), false);
  assert.equal(P.matchRow({ name: '(x' }, '(x'), true, 'a bracket is not a broken pattern');
});

test('the manifest is a panel that listens for the app, is not a button of its own, and keeps its icon', () => {
  const panel = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'extension.json'), 'utf8')).contributes.panels[0];
  assert.equal(panel.launcher, false, 'the sidebar section opens it; a second button with the same icon would only confuse');
  assert.equal(panel.icon, 'jenkins');
  assert.equal(panel.needs, null);
  assert.equal(panel.render, 'panel.html');
});

test('the panel answers the app\'s sidebar: where the menu is, and where to go', () => {
  assert.ok(/host\.on\('chrome'/.test(source), 'it never hears where the menu is');
  assert.ok(/host\.on\('navigate'/.test(source), 'it never hears where to go');
  assert.ok(/'navInSidebar' in payload/.test(source), 'it does not read where the menu is from its first context');
  // What it tells the app it is on is only ever a page of the kinds above.
  assert.ok(/page: cleanPage\(state\.page\) \|\| \{ type: 'dashboard' \}/.test(source));
});

test('what is kept on this computer is said in sizes a person reads', () => {
  assert.equal(P.formatBytes(0), '0 B');
  assert.equal(P.formatBytes(undefined), '0 B');
  assert.equal(P.formatBytes(-5), '0 B');
  assert.equal(P.formatBytes(512), '512 B');
  assert.equal(P.formatBytes(1536), '1.5 KB');
  assert.equal(P.formatBytes(20 * 1024), '20 KB');
  assert.equal(P.formatBytes(3.4 * 1024 * 1024), '3.4 MB');
  assert.equal(P.formatBytes(250 * 1024 * 1024), '250 MB');
  assert.equal(P.formatBytes(2.5 * 1024 * 1024 * 1024), '2.5 GB');
  assert.equal(P.archiveUsage({ builds: 12, bytes: 3.4 * 1024 * 1024, pinned: 2 }), '12 builds · 3.4 MB · 2 pinned');
  assert.equal(P.archiveUsage({ builds: 1, bytes: 2048 }), '1 build · 2.0 KB', 'one is not "1 builds", and nothing pinned is not mentioned');
  assert.equal(P.archiveUsage({ builds: 0, bytes: 0 }), '0 builds · 0 B');
  assert.equal(P.archiveUsage(null), '');
});

test('a number typed into a limit is brought inside its range, and a word is not a number', () => {
  const keep = P.ARCHIVE_LIMITS.keepPerJob;
  assert.equal(P.clampNumber('20', keep, 7), 20);
  assert.equal(P.clampNumber(' 30 ', keep, 7), 30);
  assert.equal(P.clampNumber('0', keep, 7), keep[0]);
  assert.equal(P.clampNumber('-4', keep, 7), keep[0]);
  assert.equal(P.clampNumber('99999', keep, 7), keep[1]);
  assert.equal(P.clampNumber('12.9', keep, 7), 12, 'a number of builds is whole');
  assert.equal(P.clampNumber('', keep, 7), 7, 'an empty field keeps what was there');
  assert.equal(P.clampNumber('abc', keep, 7), 7);
  assert.equal(P.clampNumber('Infinity', keep, 7), 7);
  assert.ok(P.ARCHIVE_LIMITS.maxMB[0] >= 1 && P.ARCHIVE_LIMITS.maxMB[1] > P.ARCHIVE_LIMITS.maxMB[0]);
});

test('the three ways of keeping builds are the three the app has, and each says what it means', () => {
  assert.deepEqual(P.ARCHIVE_MODES.map((one) => one.mode), ['watched', 'all', 'off']);
  for (const one of P.ARCHIVE_MODES) assert.ok(one.label && one.note.length > 20, one.mode);
  assert.match(P.ARCHIVE_MODES[0].label, /open, follow or star/i);
});

test('where a build came from: loudly when Jenkins could not answer, quietly when it merely is kept', () => {
  assert.equal(P.copyNote(null), null);
  assert.equal(P.copyNote({ source: 'jenkins' }), null, 'a build from Jenkins that is not saved says nothing');
  assert.deepEqual(P.copyNote({ source: 'jenkins', saved: true }), { kind: 'saved', level: 'badge', text: 'Saved on this computer' });
  assert.deepEqual(P.copyNote({ source: 'local' }), { kind: 'local', level: 'badge', text: 'From your saved copy' });
  assert.deepEqual(P.copyNote({ source: 'local', gone: true }), { kind: 'gone', level: 'banner', text: 'Jenkins no longer has this build — showing your saved copy.' });
  assert.deepEqual(P.copyNote({ source: 'local', offline: true }), { kind: 'offline', level: 'banner', text: 'Jenkins is not answering — showing your saved copy.' });
  // Both at once: Jenkins is away, which is the thing to know now.
  assert.equal(P.copyNote({ source: 'local', offline: true, gone: true, saved: true }).kind, 'offline');
  assert.equal(P.copyNote({ source: 'local', gone: true, saved: true }).kind, 'gone', 'pinned or not, Jenkins no longer has it');
});

test('there is something to remove when a copy exists, pinned or made on its own', () => {
  assert.equal(P.hasCopy(null), false);
  assert.equal(P.hasCopy({ source: 'jenkins' }), false);
  assert.equal(P.hasCopy({ source: 'jenkins', saved: true }), true);
  assert.equal(P.hasCopy({ source: 'local' }), true);
  assert.equal(P.hasCopy({ source: 'jenkins', archivedAt: 1_700_000_000_000 }), true, 'kept on its own, from a build Jenkins still has');
});

test('what an import says is one sentence a person can read, and where to go next', () => {
  assert.equal(P.describeImport(null), null);
  assert.equal(P.describeImport(undefined), null);
  assert.equal(P.describeImport({ canceled: true }), null, 'a dialog closed without choosing is not worth a word');
  assert.equal(P.describeImport({ canceled: true, imported: [{ id: 'x', name: 'x' }] }), null);

  const mixed = P.describeImport({
    imported: [{ id: 'jk-1', name: 'kubrik-ci', url: 'https://ci.example.com', user: 'ana', created: true }, { id: 'jk-2', name: 'timelogbook', url: 'https://t.example.com', user: 'ana', created: false }],
    skipped: [{ index: 2, reason: 'it has no address' }],
  });
  assert.equal(mixed.text, 'Imported 2 servers: kubrik-ci (new), timelogbook (updated). 1 skipped: it has no address.');
  assert.equal(mixed.kind, 'warn', 'something was left out: not a plain success');
  assert.equal(mixed.first, 'jk-1', 'it goes to the first one that was imported');

  const clean = P.describeImport({ imported: [{ id: 'jk-9', name: 'only', created: true }], skipped: [] });
  assert.equal(clean.text, 'Imported 1 server: only (new).');
  assert.equal(clean.kind, 'good');
  assert.equal(P.describeImport({ imported: [{ id: 'a', name: 'a' }] }).text, 'Imported 1 server: a (new).', 'no "created" at all is a new one');

  const nothing = P.describeImport({ imported: [], skipped: [{ index: 0, name: 'broken', reason: 'the address is not an http or https one' }, { index: 1, reason: 'it has no name' }] });
  assert.equal(nothing.text, 'Nothing was imported. 2 skipped: broken — the address is not an http or https one; entry 2 — it has no name.');
  assert.equal(nothing.kind, 'warn');
  assert.equal(nothing.first, null, 'with nothing imported there is nowhere to go');
  assert.equal(P.describeImport({}).text, 'Nothing was imported.');
  assert.equal(P.describeImport({ skipped: [{ index: 0, reason: '' }] }).text, 'Nothing was imported. 1 skipped: it was not usable.');
});

test('a token that comes back anyway is never written on the page', () => {
  const said = P.describeImport({ imported: [{ id: 'x', name: 'n', token: 'SECRET-TOKEN', created: true }], skipped: [{ index: 0, token: 'SECRET-TOKEN', reason: 'r' }] });
  assert.equal(JSON.stringify(said).includes('SECRET-TOKEN'), false);
});

test('the example is the format the import reads, and its token is a placeholder', () => {
  const example = JSON.parse(P.IMPORT_EXAMPLE);
  assert.equal(Array.isArray(example.servers), true);
  assert.deepEqual(Object.keys(example.servers[0]).sort(), ['name', 'token', 'url', 'user']);
  assert.match(example.servers[0].token, /^<.*>$/, 'something to replace, never something that looks like a real token');
  assert.match(example.servers[0].url, /^https:\/\//);
});

test('pasted JSON holds a token, so it is cleared from the page the moment it is sent', () => {
  const body = /function importServers\(text\) \{[\s\S]*?\n {2}\}/.exec(source)[0];
  assert.ok(/state\.setup\.pasted = ''/.test(body) && /els\.pasteBox\.value = ''/.test(body), 'the text and the box are both emptied');
  assert.ok(body.indexOf("els.pasteBox.value = ''") < body.indexOf("call('importServers'"), 'before the call, not after it comes back');
  assert.equal(/localStorage|sessionStorage|remember\([^)]*pasted/.test(source), false, 'it is not kept anywhere');
  // And what is asked of the app is only the file dialog, or the text — never a path the panel chose.
  assert.equal(/importServers', \{ path/.test(source), false);
});

test('what is exported is named for the question the app asks first', () => {
  assert.equal(P.exportWhat([{ name: 'kubrik-ci' }]), '1 server (kubrik-ci)');
  assert.equal(P.exportWhat([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), '3 servers');
  assert.equal(P.exportWhat([{ name: 'a' }, { name: 'b' }]), '2 servers');
  assert.equal(P.exportWhat([]), '0 servers');
  assert.equal(P.exportWhat(undefined), '0 servers');
});

test('what an export says: where it went, that the tokens are in it, and what was left out', () => {
  assert.equal(P.describeExport(null), null);
  assert.equal(P.describeExport({ canceled: true }), null, 'a Save dialog closed without choosing is not worth a word');
  const clean = P.describeExport({ saved: true, name: 'jenkins-servers.json', count: 3, skipped: [] });
  assert.equal(clean.text, 'Saved 3 servers to jenkins-servers.json. The file holds your API tokens in plain text — keep it safe and delete it when you\'re done.');
  assert.equal(clean.kind, 'good');
  assert.equal(P.describeExport({ saved: true, name: 'one.json', count: 1 }).text.startsWith('Saved 1 server to one.json.'), true, 'one is not "1 servers"');
  const partial = P.describeExport({ saved: true, name: 'f.json', count: 2, skipped: [{ name: 'old', reason: 'it has no token saved' }, { reason: 'it could not be read' }] });
  assert.match(partial.text, /Saved 2 servers to f\.json\./);
  assert.match(partial.text, /2 skipped: old — it has no token saved; it could not be read\.$/);
  assert.equal(partial.kind, 'warn');
  assert.equal(P.describeExport({ saved: true, count: 1 }).text.startsWith('Saved 1 server. The file'), true, 'no name is no "to"');
  assert.equal(P.describeExport({ saved: false }).text, 'Nothing was saved.');
  assert.equal(P.describeExport({}).text, 'Nothing was saved.');
  // Whatever else comes back with it is never written on the page.
  assert.equal(JSON.stringify(P.describeExport({ saved: true, name: 'f.json', count: 1, token: 'SECRET-TOKEN', text: 'SECRET-TOKEN' })).includes('SECRET-TOKEN'), false);
});

test('an export is only ever a call to the app: no download, no blob, no file text in the page', () => {
  for (const bad of ['Blob(', 'createObjectURL', 'download', 'FileReader', 'showSaveFilePicker', 'data:application']) {
    assert.equal(source.includes(bad), false, `the panel uses ${bad}`);
  }
  assert.ok(/call\('exportServers'/.test(source));
  // The question the app asks names what goes; the panel only says what that is.
  assert.ok(/what: exportWhat\(chosen\)/.test(source) || /args = \{ what: exportWhat\(chosen\) \}/.test(source));
});

test('the dashboard is a place the app can send the panel to', () => {
  assert.deepEqual(P.cleanPage({ type: 'dashboard' }), { type: 'dashboard' });
  assert.deepEqual(P.cleanPage({ type: 'dashboard', path: 'x', range: '7d' }), { type: 'dashboard' }, 'a place with nothing to say about itself stays that way');
  assert.ok(P.PAGE_TYPES.includes('dashboard'));
});

test('the periods are the four the app answers for, and an unknown one is a day', () => {
  assert.deepEqual(P.RANGES.map((r) => r.key), ['1h', '24h', '7d', '30d']);
  assert.deepEqual(P.RANGES.map((r) => r.ms), [3600000, 86400000, 7 * 86400000, 30 * 86400000]);
  assert.equal(P.rangeOf('7d').ms, 7 * 86400000);
  assert.equal(P.rangeOf('nonsense').key, '24h');
  assert.equal(P.rangeOf(undefined).key, '24h');
});

test('runs are packed into as few lanes as will hold them, and a run still going holds its lane', () => {
  const now = 1000;
  const run = (name, start, end) => ({ name, start, end });
  const lanes = (runs, max) => { const r = P.packLanes(runs, now, max); return { n: r.lanes, hidden: r.hidden, by: Object.fromEntries(r.items.map((i) => [i.run.name, i.lane])) }; };
  // Back to back: one lane. Overlapping: two. A gap lets the first lane be used again.
  assert.deepEqual(lanes([run('a', 0, 100), run('b', 100, 200), run('c', 200, 300)]), { n: 1, hidden: 0, by: { a: 0, b: 0, c: 0 } });
  assert.deepEqual(lanes([run('a', 0, 100), run('b', 50, 150)]), { n: 2, hidden: 0, by: { a: 0, b: 1 } });
  assert.deepEqual(lanes([run('a', 0, 100), run('b', 50, 150), run('c', 120, 200)]), { n: 2, hidden: 0, by: { a: 0, b: 1, c: 0 } }, 'c fits where a was');
  // Not given in order, and a run with no end goes on until now.
  assert.deepEqual(lanes([run('b', 50, 150), run('a', 0, 100)]).by, { a: 0, b: 1 });
  assert.deepEqual(lanes([run('a', 0, null), run('b', 500, 600)]), { n: 2, hidden: 0, by: { a: 0, b: 1 } }, 'a is still running, so b cannot share its lane');
  // Five at once with room for three: three are drawn and two are counted.
  const crowd = [0, 1, 2, 3, 4].map((i) => run('r' + i, i, 500));
  assert.deepEqual(lanes(crowd, 3), { n: 3, hidden: 2, by: { r0: 0, r1: 1, r2: 2 } });
  assert.deepEqual(lanes([]), { n: 0, hidden: 0, by: {} });
  assert.deepEqual(P.packLanes(undefined, now, 4).items, []);
  // A run that ends where it starts still takes a place.
  assert.equal(lanes([run('z', 10, 10), run('y', 10, 10)]).n, 2);
});

test('what was running at an instant: started by then and not ended, inclusive at both ends', () => {
  const runs = [{ n: 'a', start: 0, end: 100 }, { n: 'b', start: 50, end: 150 }, { n: 'c', start: 120, end: null }];
  const at = (t) => P.runsAt(runs, t, 500).map((r) => r.n);
  assert.deepEqual(at(60), ['a', 'b']);
  assert.deepEqual(at(100), ['a', 'b']);
  assert.deepEqual(at(110), ['b']);
  assert.deepEqual(at(130), ['b', 'c']);
  assert.deepEqual(at(400), ['c'], 'a build with no end is still going');
  assert.deepEqual(at(-5), []);
  assert.deepEqual(P.runsAt(undefined, 1, 2), []);
});

test('an axis tops out on a clean number and counts up to it', () => {
  assert.deepEqual(P.niceTicks(7, 4), { max: 8, ticks: [0, 2, 4, 6, 8] });
  assert.deepEqual(P.niceTicks(10, 4), { max: 10, ticks: [0, 5, 10] });
  assert.deepEqual(P.niceTicks(96, 4), { max: 100, ticks: [0, 50, 100] });
  assert.deepEqual(P.niceTicks(1, 4), { max: 1, ticks: [0, 0.5, 1] });
  assert.deepEqual(P.niceTicks(1, 4, true), { max: 1, ticks: [0, 1] }, 'a count of builds has no halves');
  assert.deepEqual(P.niceTicks(3, 4, true), { max: 3, ticks: [0, 1, 2, 3] });
  assert.deepEqual(P.niceTicks(2, 6, true).ticks.every(Number.isInteger), true);
  assert.deepEqual(P.niceTicks(0, 4), { max: 1, ticks: [0, 1] }, 'nothing to show still has an axis');
  assert.deepEqual(P.niceTicks(-3, 4), { max: 1, ticks: [0, 1] });
  const wide = P.niceTicks(2340, 4);
  assert.equal(wide.max >= 2340, true);
  assert.equal(wide.ticks[0], 0);
  assert.equal(P.niceTicks(0.35, 4).max >= 0.35, true);
});

test('big numbers are short on an axis and on a tile', () => {
  assert.equal(P.compact(0), '0');
  assert.equal(P.compact(7), '7');
  assert.equal(P.compact(1284), '1284');
  assert.equal(P.compact(9999), '9999');
  assert.equal(P.compact(12900), '12.9K');
  assert.equal(P.compact(120000), '120K');
  assert.equal(P.compact(4200000), '4.2M');
  assert.equal(P.compact(12000000), '12M');
  assert.equal(P.compact(10000), '10K', 'a round number has no ".0"');
  assert.equal(P.compact(undefined), '0');
});

test('an instant is said the way a person says it, with the date once it is further than a week day away', () => {
  const d = new Date(2026, 9, 14, 14, 32);
  const day = P.WEEKDAYS[d.getDay()];
  assert.equal(P.fmtMoment(d.getTime(), 86400000), `${day} 14:32`);
  assert.equal(P.fmtMoment(d.getTime(), 7 * 86400000), `${day} 14 Oct 14:32`);
  assert.equal(P.fmtMoment(new Date(2026, 0, 5, 9, 5).getTime(), 30 * 86400000).endsWith('5 Jan 09:05'), true, 'two digits for the clock, none for the day');
  assert.equal(P.fmtTick(d.getTime(), 3600000), '14:32', 'a day or less is read by the clock');
  assert.equal(P.fmtTick(d.getTime(), 7 * 86400000), `${day} 14`, 'a week by the day');
  assert.equal(P.WEEKDAYS.length, 7);
  assert.equal(P.MONTHS.length, 12);
});

test('how a number moved says which way, by how much, and whether that is good — which depends on the number', () => {
  // More failures is bad; a higher success rate is good; a shorter build is good.
  assert.deepEqual(P.deltaOf(14, 5, false, 'n'), { arrow: '▲', text: '+9', tone: 'bad' });
  assert.deepEqual(P.deltaOf(3, 5, false, 'n'), { arrow: '▼', text: '−2', tone: 'good' });
  assert.deepEqual(P.deltaOf(0.92, 0.85, true, 'pp'), { arrow: '▲', text: '+7 pp', tone: 'good' });
  assert.deepEqual(P.deltaOf(0.8, 0.9, true, 'pp'), { arrow: '▼', text: '−10 pp', tone: 'bad' });
  assert.deepEqual(P.deltaOf(120000, 90000, false, 'ms'), { arrow: '▲', text: '+30s', tone: 'bad' });
  assert.deepEqual(P.deltaOf(5, 5, false, 'n'), { arrow: '→', text: 'same as before', tone: 'flat' });
  assert.equal(P.deltaOf(5, null, false, 'n'), null, 'nothing before it is nothing to compare with');
  assert.equal(P.deltaOf(null, 5, false, 'n'), null);
  assert.equal(P.deltaOf(undefined, undefined, false, 'n'), null);
  assert.equal(P.deltaOf(NaN, 5, false, 'n'), null);
  assert.equal(P.deltaOf(2400, 1000, false, 'n').text, '+1400', 'one thousand four hundred is not "1.4K" on a delta that is small');
  assert.equal(P.deltaOf(0, 0, false, 'n').tone, 'flat', 'nothing failed before and nothing failed now');
});

test('a rate is a percentage that does not claim a perfect run it did not have', () => {
  assert.equal(P.ratePct(null), '—');
  assert.equal(P.ratePct(undefined), '—');
  assert.equal(P.ratePct(NaN), '—');
  assert.equal(P.ratePct(0.8547), '85%');
  assert.equal(P.ratePct(0.05), '5.0%');
  assert.equal(P.ratePct(0.0042), '0.4%');
  assert.equal(P.ratePct(0), '0.0%');
  assert.equal(P.ratePct(1), '100%');
  assert.equal(P.ratePct(0.9996), '100%');
  assert.equal(P.ratePct(0.9994), '99.9%', 'ninety-nine point nine is not a hundred');
  assert.equal(P.ratePct(0.995), '99.5%');
  assert.equal(P.ratePct(0.99), '99.0%');
  assert.equal(P.ratePct(0.985), '99%', 'under ninety-nine it is a whole number again');
});

test('a sparkline keeps the peak of what it stands for', () => {
  assert.deepEqual(P.downsample([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(P.downsample([], 5), []);
  assert.deepEqual(P.downsample([0, 0, 9, 0, 0, 0], 3), [0, 9, 0], 'the spike is still a spike');
  const many = Array.from({ length: 100 }, (_, i) => (i === 37 ? 50 : 1));
  const small = P.downsample(many, 10);
  assert.equal(small.length, 10);
  assert.equal(Math.max(...small), 50);
  assert.equal(P.downsample(undefined, 4).length, 0);
});

test('the cursor steps by what the data is cut into, in the direction asked, and never off the chart', () => {
  const from = 1000000; const to = 2000000; const bucket = 60000;
  assert.equal(P.stepCursor(1500000, from, to, bucket, 1, false), 1560000);
  assert.equal(P.stepCursor(1500000, from, to, bucket, -1, false), 1440000);
  assert.equal(P.stepCursor(1500000, from, to, bucket, 1, true), 1600000, 'with Shift, a tenth of what is shown');
  assert.equal(P.stepCursor(from + 10, from, to, bucket, -1, false), from, 'not before the start');
  assert.equal(P.stepCursor(to - 10, from, to, bucket, 1, true), to, 'not after the end');
  assert.equal(P.stepCursor(1500000, from, to, 0, 1, false), 1501000, 'a bucket of nothing still moves');
  assert.equal(P.stepCursor(1200000, from, to, 150000, 1, true), 1350000, 'a big step is at least one bucket');
  assert.equal(P.stepCursor(1500000, from, to, 900000, 1, true), to, 'and stops at the end');
});

test('a cell is as dark as it is busy, and nothing is its own level', () => {
  assert.equal(P.heatLevel(0, 10), 0);
  assert.equal(P.heatLevel(undefined, 10), 0);
  assert.equal(P.heatLevel(5, 0), 0);
  assert.equal(P.heatLevel(1, 100), 1, 'a little is not nothing');
  assert.equal(P.heatLevel(25, 100), 1);
  assert.equal(P.heatLevel(26, 100), 2);
  assert.equal(P.heatLevel(50, 100), 2);
  assert.equal(P.heatLevel(75, 100), 3);
  assert.equal(P.heatLevel(100, 100), 4);
  assert.equal(P.heatLevel(500, 100), 4, 'never past the darkest');
});

test('a build is stuck when it has taken more than twice what it usually does', () => {
  assert.equal(P.isStuck(250000, 100000), true);
  assert.equal(P.isStuck(200000, 100000), false, 'exactly twice is not more than twice');
  assert.equal(P.isStuck(50000, 100000), false);
  assert.equal(P.isStuck(9e9, 0), false, 'with no idea what is usual, nothing is stuck');
  assert.equal(P.isStuck(9e9, undefined), false);
  assert.equal(P.fractionOf(50, 0, 100), 0.5);
  assert.equal(P.fractionOf(-5, 0, 100), 0);
  assert.equal(P.fractionOf(500, 0, 100), 1);
  assert.equal(P.fractionOf(5, 10, 10), 0, 'an empty span is a position of nothing, not a division by zero');
});

test('a chart is drawn with SVG built by hand: text from a server is only ever text', () => {
  assert.ok(/function sv\(tag, attrs\)/.test(source));
  assert.ok(/createElementNS\(SVGNS, tag\)/.test(source));
  const tip = /function showTip\(x, y, title, rows\) \{[\s\S]*?\n {2}\}/.exec(source)[0];
  assert.equal(/innerHTML|insertAdjacent/.test(tip), false);
  assert.ok(/h\('div', \{ class: 'tt', text: title \}\)/.test(tip), 'the title is set as text');
  assert.ok(/h\('b', \{ class: 'tv', text: r\.value \}\)/.test(tip), 'and so is every value');
  assert.ok(/prefers-reduced-motion/.test(html), 'what moves can be told to stand still');
  // Every chart has a table to read instead.
  assert.ok(/function chartCard\(/.test(source) && /bucketTable\(/.test(source) && /function timelineTable\(/.test(source));
});

// --- promises that cannot be seen in a screenshot ------------------------------

test('nothing a server says is ever read as markup', () => {
  // The names of jobs and stages, descriptions, commit messages, log lines: all of it belongs to other people.
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'srcdoc', 'DOMParser', 'eval(', 'new Function', 'setAttribute(\'on']) {
    assert.equal(source.includes(bad), false, `the panel uses ${bad}`);
  }
  assert.equal(/\bsetTimeout\(\s*['"`]/.test(source), false, 'a timer given a string is eval');
  assert.equal(/\.href\s*=|\.src\s*=|location\s*=|window\.open/.test(source), false, 'a server\'s text must not become an address');
});

test('the panel has no form: its frame is sandboxed without allow-forms, so a submit never fires', () => {
  // Code, not the comments that explain why there is none.
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/<form\b/.test(code), false);
  assert.equal(/h\('form'|createElement\('form'\)/.test(code), false);
  assert.equal(/onsubmit|type: 'submit'/.test(code), false);
});

test('every call the panel makes is one the app routes, and one a Jenkins panel is permitted', () => {
  const host = require('../.test-build/lib/extensionHost.js');
  const used = new Set();
  for (const [, name] of source.matchAll(/\b(?:api|call)\('(\w+)'/g)) used.add(name);
  for (const [, name] of source.matchAll(/host\.call\('jenkins\.(\w+)'/g)) used.add(name);
  assert.ok(used.size >= 15, `found only ${[...used].join(', ')}`);
  const shipped = { trusted: false, permissions: ['jenkins.read', 'jenkins.write', 'terminal'] };
  for (const name of used) {
    assert.notEqual(host.route(`jenkins.${name}`), null, `the app does not route jenkins.${name}`);
    assert.equal(host.permitted(shipped, `jenkins.${name}`), true, `jenkins.${name} needs a permission nobody asked for`);
  }
  // The verbs that change anything are the ones that ask first, or are plainly the person's own click.
  assert.ok(used.has('stages') && used.has('run') && used.has('stop') && used.has('followLog'), 'the verbs the panel is built on');
  // Until the app routes the archive verbs, the panel that calls them is ahead of it: say so by name, not by a vague failure.
  for (const name of ['archive', 'archiveSettings', 'save', 'forget']) assert.ok(used.has(name), `the panel does not use ${name}`);
});

test('the panel listens to the events the app pushes, by the names it pushes them under', () => {
  for (const type of ['log', 'health', 'changed', 'followed', 'stage']) {
    assert.ok(source.includes(`'${type}'`), `the panel never mentions the ${type} event`);
  }
  assert.ok(/host\.on\('jenkins'/.test(source));
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'extension.json'), 'utf8'));
  assert.deepEqual(manifest.contributes.panels[0].listens, ['jenkins']);
});

test('the Jenkins mark is one path, drawn without reading markup, and hidden from a screen reader', () => {
  const mark = /var JENKINS_MARK = '([^']+)';/.exec(source);
  assert.ok(mark && mark[1].length > 500, 'the logo path is missing');
  assert.ok(/createElementNS\(ns, 'svg'\)/.test(source) && /aria-hidden', 'true'/.test(source));
  assert.equal(/^M[-\d., a-zA-Z]+$/.test(mark[1]), true, 'a path and nothing else');
});

test('quick open: every typed word has to start a word of the place, and a name that starts with it comes first', () => {
  const ids = (q) => P.paletteActions(q).map((a) => a.id);
  assert.equal(ids('').length, P.PALETTE_ACTIONS.length, 'nothing typed offers every place');
  assert.deepEqual(ids('dash'), ['dashboard']);
  assert.deepEqual(ids('stat'), ['dashboard'], 'statistics is a word of the dashboard, stale is not stat');
  assert.ok(ids('queue agents').includes('queue'));
  assert.deepEqual(ids('zzz'), []);
  assert.equal(ids('fail')[0], 'failing', 'the name that starts with it first');
  assert.ok(ids('  RUN ').includes('running'), 'case and padding do not matter');
});

test('tree type-ahead: letters jump to a name, one letter repeated walks the names that start with it', () => {
  const names = ['history', 'team-01', 'team-02', 'tools', 'zeta'];
  assert.equal(P.typeAheadFrom(names, 0, 't'), 1, 'from the next one on');
  assert.equal(P.typeAheadFrom(names, 1, 't'), 2);
  assert.equal(P.typeAheadFrom(names, 3, 't'), 1, 'wraps round');
  assert.equal(P.typeAheadFrom(names, 0, 'to'), 3, 'a longer word is searched from where it is');
  assert.equal(P.typeAheadFrom(names, 0, 'tt'), 1, 'the same letter twice is a walk, not a word');
  assert.equal(P.typeAheadFrom(names, 0, 'q'), -1);
  assert.equal(P.typeAheadFrom([], 0, 'a'), -1);
  assert.equal(P.typeAheadFrom(names, 4, 'Z'), 4, 'case does not matter');
});

test('what Claude did is told in words and a mark, never by colour alone', () => {
  assert.deepEqual({ ...P.claudeResult({ ok: false, denied: 'turned-off' }) }, { mark: '✕', tone: 'bad', text: 'denied: turned off' });
  assert.equal(P.claudeResult({ ok: false, denied: 'something-new' }).text, 'denied: something-new', 'a reason this panel does not know is shown as it came');
  assert.equal(P.claudeResult({ ok: true, tool: 'request_run', outcome: 'declined' }).text, 'you declined');
  assert.equal(P.claudeResult({ ok: true, tool: 'request_run', outcome: 'approved' }).mark, '✓');
  assert.equal(P.claudeResult({ ok: true, tool: 'log' }).text, 'answered');
  assert.equal(P.claudeResult({ ok: false, tool: 'log' }).mark, '✕');
});

test('a Pipeline waiting for a node is queued as "part of <job> #n"; the job is what is asked about', () => {
  assert.equal(P.queueJobPath({ path: 'part of team/deploy #12' }), 'team/deploy');
  assert.equal(P.queueJobPath({ path: 'team/deploy' }), 'team/deploy');
  assert.equal(P.queueJobPath({}), '');
});

const HOUR = 3600000;

test('time travel fits the data: a week asked for, an hour of builds in it, an hour shown', () => {
  const to = 7 * 24 * HOUR;
  const from = 0;
  const runs = [{ start: to - 58 * 60000, end: to - 50 * 60000 }, { start: to - 10 * 60000, end: null }];
  const fit = P.fitWindow(runs, from, to);
  assert.equal(fit.fitted, true);
  assert.equal(fit.to, to);
  assert.ok(to - fit.from >= 58 * 60000 && to - fit.from < 66 * 60000, 'a little before the first build, not a week');
  const spread = P.fitWindow([{ start: from + 1000 }, { start: to - 1000 }], from, to);
  assert.equal(spread.fitted, false, 'builds all over the period: the period');
  assert.deepEqual({ ...P.fitWindow([], from, to) }, { from, to, fitted: false }, 'nothing ran: no window to invent');
  const short = P.fitWindow([{ start: to - 1000 }], from, to);
  assert.ok(to - short.from >= 300000, 'never a sliver: at least five minutes');
});

test('a chart of buckets starts at the first one with anything in it', () => {
  const bucket = 3 * HOUR;
  const buckets = [];
  for (let i = 0; i < 56; i += 1) buckets.push({ t: i * bucket, started: 0, success: 0, failed: 0, runningMax: 0, queuedMax: i === 10 ? 2 : 0 });
  buckets[55].success = 4;
  const counts = P.fitBuckets(buckets, 0, 56 * bucket, bucket, 8, true);
  assert.equal(counts.fitted, true);
  assert.equal(counts.from, 48 * bucket, 'by what finished: at least eight buckets, so not just the last');
  const all = P.fitBuckets(buckets, 0, 56 * bucket, bucket, 8, false);
  assert.equal(all.from, 9 * bucket, 'by load too, the queued one at 10 counts');
  assert.equal(P.fitBuckets([{ t: 0 }, { t: bucket }], 0, 2 * bucket, bucket).fitted, false, 'empty is the whole');
});

test('runs are packed into as few lanes as pixels allow, and each is at least as wide as it can be seen', () => {
  const toX = (t) => t / 1000;
  const runs = [{ start: 0, end: 10000 }, { start: 11000, end: 20000 }, { start: 5000, end: 12000 }, { start: 30000, end: 30001 }];
  const p = P.packLanesPx(runs, toX, 100000, 3, 0);
  assert.equal(p.lanes, 2);
  const tiny = p.items.find((i) => i.run.start === 30000);
  assert.equal(tiny.x2 - tiny.x1, 3, 'a run that lasted a millisecond is three pixels');
  const touching = P.packLanesPx([{ start: 0, end: 1000 }, { start: 1002, end: 2000 }], toX, 5000, 3, 0);
  assert.equal(touching.lanes, 2, 'two that would be drawn on top of each other do not share a lane');
  const capped = P.packLanesPx(Array.from({ length: 10 }, () => ({ start: 0, end: 50000 })), toX, 100000, 3, 4);
  assert.equal(capped.lanes, 4);
  assert.equal(capped.hidden, 6, 'what does not fit is counted, not lost');
  const running = P.packLanesPx([{ start: 0, end: null }], toX, 8000, 3, 0);
  assert.equal(running.items[0].x2, 8, 'a build still going reaches the present');
});

test('density counts the builds going in each slice, by how they ended', () => {
  const runs = [
    { start: 0, end: 25, status: 'success' }, { start: 20, end: 60, status: 'failed' }, { start: 90, end: null, status: 'running' }, { start: 500, end: 600, status: 'success' }
  ];
  const d = P.densityColumns(runs, 0, 100, 10, 100);
  assert.equal(d.cols.length, 10);
  assert.equal(d.cols[0].by.success, 1);
  assert.equal(d.cols[2].total, 2, 'both going at 20–30');
  assert.equal(d.cols[9].by.running, 1);
  assert.equal(d.peak, 2);
  assert.equal(d.cols.reduce((n, c) => n + c.by.success, 0), 3, 'the one that ended at 25 spans three slices; the one outside is not counted');
});

test('zooming and moving a window keep it inside the whole and never smaller than half a minute', () => {
  const whole = { from: 0, to: 100 * HOUR };
  const win = { from: 40 * HOUR, to: 60 * HOUR };
  const z = P.zoomWindow(win, whole, 0.5, 50 * HOUR);
  assert.equal(z.to - z.from, 10 * HOUR);
  assert.equal(z.from, 45 * HOUR, 'around the moment asked for');
  const tiny = P.zoomWindow({ from: 0, to: 60000 }, whole, 0.001, 30000);
  assert.equal(tiny.to - tiny.from, P.MIN_WINDOW_MS);
  const out = P.zoomWindow(win, whole, 100, 50 * HOUR);
  assert.deepEqual({ ...out }, { from: 0, to: 100 * HOUR }, 'out is at most the whole');
  assert.deepEqual({ ...P.panWindow(win, whole, -90 * HOUR) }, { from: 0, to: 20 * HOUR });
  assert.deepEqual({ ...P.panWindow(win, whole, 90 * HOUR) }, { from: 80 * HOUR, to: 100 * HOUR });
});

test('the jobs of a one-row-per-job timeline are the busiest first, and a window is told in words', () => {
  const runs = ['b', 'a', 'a', 'c', 'a', 'b'].map((path) => ({ path }));
  assert.deepEqual(P.jobsByActivity(runs).map((j) => j.path + j.runs), ['a3', 'b2', 'c1']);
  assert.equal(P.spanWords(45000), '45 s');
  assert.equal(P.spanWords(58 * 60000), '58 min');
  assert.equal(P.spanWords(3 * HOUR), '3 h');
  assert.equal(P.spanWords(7 * 24 * HOUR), '7 days');
});

test('there is no Home: a saved or sent place that says home lands on the dashboard', () => {
  assert.deepEqual({ ...P.cleanPage({ type: 'home' }) }, { type: 'dashboard' });
  assert.deepEqual({ ...P.cleanPage({ type: 'dashboard' }) }, { type: 'dashboard' });
  assert.equal(P.PAGE_TYPES.includes('home'), false);
  assert.equal(P.PALETTE_ACTIONS.some((a) => a.id === 'home'), false, 'nothing to offer as a place of its own');
  assert.ok(P.paletteActions('home').some((a) => a.id === 'dashboard'), 'but people who type home are shown where it went');
});

test('charts of time are counted from the history at any resolution, and the queue only where it was sampled', () => {
  const runs = [{ start: 0, end: 15, status: 'success' }, { start: 5, end: 25, status: 'failed' }, { start: 30, end: null, status: 'running' }];
  const bins = P.binFinished(runs, 0, 40, 4);
  assert.deepEqual(bins.map((b) => b.success), [0, 1, 0, 0]);
  assert.deepEqual(bins.map((b) => b.failed), [0, 0, 1, 0]);
  assert.deepEqual(bins.map((b) => b.started), [2, 0, 0, 1]);
  const buckets = [{ t: 0, queuedMax: 3, busyMax: 2, executorsTotal: 8 }, { t: 20, queuedMax: null, busyMax: null, executorsTotal: null }];
  const load = P.binLoad(runs, 0, 40, 4, 40, buckets, 20);
  assert.deepEqual(load.map((b) => b.running), [2, 2, 1, 1]);
  assert.deepEqual(load.map((b) => b.queued), [3, 3, null, null], 'no sample, no queue: a gap, not a zero');
  assert.equal(P.historyCovers([{ start: 100 }, { start: 200 }], true, 150), true, 'newer than the oldest kept: whole');
  assert.equal(P.historyCovers([{ start: 100 }], true, 50), false, 'older than the oldest kept: not whole');
  assert.equal(P.historyCovers([{ start: 100 }], false, 0), true);
});

test('a launch is told in words and a mark, and is over when nothing more will happen to it', () => {
  for (const state of ['waiting', 'queued', 'running', 'success', 'failed', 'unstable', 'aborted', 'error', 'lost', 'skipped']) {
    assert.ok(P.launchWord(state).length > 2 && P.launchGlyph(state) !== '·', state);
  }
  assert.equal(P.launchWord('something-new'), 'something-new', 'a state this panel does not know is shown as it came');
  assert.deepEqual(['waiting', 'queued', 'running'].map(P.launchOver), [false, false, false]);
  assert.deepEqual(['success', 'failed', 'error', 'lost', 'skipped'].map(P.launchOver), [true, true, true, true, true]);
  assert.equal(P.launchTone('success'), 'ok');
  assert.equal(P.launchTone('error'), 'bad');
  assert.equal(P.launchTone('aborted'), 'warn');
});

test('a time to run at: easy choices that are in the future, said the way a person says them', () => {
  const noon = new Date(2026, 9, 16, 12, 0).getTime();
  const q = P.quickChoices(noon);
  assert.deepEqual(q.map((x) => x.label), ['In 30 minutes', 'Tonight 22:00', 'Tomorrow 08:00']);
  assert.equal(new Date(q[1].at).getHours(), 22);
  assert.equal(new Date(q[2].at).getDate(), 17);
  const late = new Date(2026, 9, 16, 21, 50).getTime();
  assert.equal(P.quickChoices(late).some((x) => /Tonight/.test(x.label)), false, 'tonight is not offered ten minutes before it');
  assert.equal(P.whenWords(noon + 12 * 60000, noon), 'in 12 min');
  assert.equal(P.whenWords(noon + 3 * 3600000, noon), 'today 15:00');
  assert.equal(P.whenWords(new Date(2026, 9, 17, 8, 0).getTime(), noon), 'tomorrow 08:00');
  assert.equal(P.whenWords(noon - 5 * 60000, noon), '5 min ago');
  assert.equal(P.parseLocalTime(P.toLocalTime(noon)), noon, 'the box and the time agree');
  assert.equal(P.parseLocalTime('nonsense'), null);
});

test('the run form: what is wrong with the values, what will be sent, and whether it points at production', () => {
  const params = [
    { name: 'VERSION', type: 'string', required: true },
    { name: 'ENV', type: 'choice', choices: ['staging', 'production'] },
    { name: 'DRY', type: 'boolean', required: false },
    { name: 'API_KEY', type: 'password', secret: true, required: true }
  ];
  const bad = P.paramProblems(params, { VERSION: '', ENV: 'moon', DRY: false, API_KEY: '' });
  assert.deepEqual(Object.keys(bad).sort(), ['API_KEY', 'ENV'], 'a text parameter with no default may be sent empty: Jenkins takes an empty string');
  assert.match(bad.API_KEY, /secret/i);
  assert.deepEqual({ ...P.paramProblems(params, { VERSION: '1', ENV: 'staging', DRY: true, API_KEY: 'x' }) }, {});
  const text = P.callPreviewText({ callPreview: { method: 'POST', url: 'https://ci/job/x/buildWithParameters' } }, params, { VERSION: '1 2', ENV: 'staging', DRY: true, API_KEY: 'hunter2' });
  assert.equal(text, 'POST https://ci/job/x/buildWithParameters\nVERSION=1%202&ENV=staging&DRY=true&API_KEY=••••');
  assert.equal(text.includes('hunter2'), false, 'a secret is never in the preview');
  assert.equal(P.formLooksProd({ looksProd: false }, params, { ENV: 'staging' }), false);
  assert.equal(P.formLooksProd({ looksProd: false }, params, { ENV: 'Production' }), true, 'a value can say it too');
  assert.equal(P.formLooksProd({ looksProd: true }, params, {}), true);
});

test('a batch says how far it has got, and a past launch shows its parameters without secrets', () => {
  const items = [{ state: 'success' }, { state: 'failed' }, { state: 'running' }, { state: 'waiting' }];
  const p = P.batchProgress(items);
  assert.equal(p.total, 4);
  assert.equal(p.over, 2);
  assert.equal(p.fraction, 0.5);
  assert.equal(p.done, false);
  assert.match(p.text, /1 passed · 1 failed · 1 running · 1 waiting its turn/);
  assert.equal(P.batchProgress([{ state: 'success' }, { state: 'skipped' }]).done, true);
  assert.equal(P.batchProgress([]).done, false, 'an empty batch is not "done"');
  const chips = P.paramChips({ VERSION: '1.4.0', ENV: 'prod', API_KEY: 'x', DRY: 'false', NOTE: 'a'.repeat(60), TOKEN_X: 'y' }, 3);
  assert.deepEqual(chips.items, ['VERSION=1.4.0', 'ENV=prod', 'DRY=false']);
  assert.equal(chips.more, 1);
  assert.equal(chips.items.some((c) => /API_KEY|TOKEN/.test(c)), false);
});

test('only jobs named for an environment are asked about promotion', () => {
  for (const name of ['KUBRIK/TIMELOG/AGENT MS DEV', 'svc-qa', 'app/STAGING/api', 'x_uat_y', 'a.dev']) assert.equal(P.promoteWorthAsking(name), true, name);
  for (const name of ['team-01/svc-07', 'device-driver', 'prod-only', 'KUBRIK/TIMELOG/AGENT MS PROD']) assert.equal(P.promoteWorthAsking(name), false, name);
});

test('a scope sends only what was set, and says what it is in chips a person can read', () => {
  assert.deepEqual({ ...P.scopeArgs({ pattern: '  ms prod ', folder: '', mine: true, result: 'failed', junk: 'x' }) }, { pattern: 'ms prod', result: 'failed', mine: true });
  assert.deepEqual({ ...P.scopeArgs(null) }, {});
  assert.deepEqual(P.scopeChips({ pattern: 'ms', trigger: 'scm', mine: true }).map((c) => c.text), ['name has “ms”', 'started by source change', 'my builds']);
  assert.equal(P.scopeArgs({ pattern: 'x'.repeat(500) }).pattern.length, 200);
});

test('the part of a scope that a name can answer: folder, words, wildcards', () => {
  assert.equal(P.scopeMatchesPath({ folder: 'KUBRIK/TIMELOG' }, 'KUBRIK/TIMELOG/AGENT MS DEV'), true);
  assert.equal(P.scopeMatchesPath({ folder: 'KUBRIK/TIMELOG' }, 'KUBRIK/BILLING/INVOICES'), false);
  assert.equal(P.scopeMatchesPath({ folder: 'KUBRIK' }, 'KUBRIKX/a'), false, 'a folder is not a prefix of letters');
  assert.equal(P.scopeMatchesPath({ pattern: 'ms prod' }, 'KUBRIK/TIMELOG/AGENT MS PROD'), true, 'case does not matter');
  assert.equal(P.scopeMatchesPath({ pattern: '*-PROD' }, 'team/api-prod'), true);
  assert.equal(P.scopeMatchesPath({ pattern: '*-PROD' }, 'team/api-dev'), false);
  assert.equal(P.scopeMatchesPath({ pattern: 'a.b' }, 'axb'), false, 'a dot is a dot, not any letter');
  assert.equal(P.scopeMatchesPath({}, 'anything'), true);
  assert.equal(P.scopeMatchesPath({ mine: true, trigger: 'scm' }, 'x'), true, 'what a name cannot answer is not the name\'s to refuse');
});

test('what leaves the page as a spreadsheet cannot be read as a formula', () => {
  assert.equal(P.csvCell('plain'), 'plain');
  assert.equal(P.csvCell('a,b'), '"a,b"');
  assert.equal(P.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(P.csvCell('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
  assert.equal(P.csvCell('+1'), "'+1");
  assert.equal(P.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(P.csvCell(null), '');
  assert.equal(P.csvOf([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], [{ a: 1, b: 'x,y' }]), 'A,B\n1,"x,y"\n');
});

test('the heat map, the trend and the drift are said in words', () => {
  assert.deepEqual([[0, 0, 0, 0], [3, 0, 0, 1], [0, 0, 1, 2], [1, 0, 1, 3], [2, 1, 0, 4]].map(P.heatTone), ['none', 'success', 'aborted', 'unstable', 'failed']);
  assert.equal(P.heatTone(undefined), 'none');
  assert.equal(P.trendWords({ direction: 'down', delta: -0.124 }), '↘ 12 pts worse');
  assert.equal(P.trendWords({ direction: 'up', delta: 0.2 }), '↗ 20 pts better');
  assert.equal(P.trendWords({ direction: 'flat', delta: 0.01 }), '→ steady');
  assert.equal(P.trendWords(null), '');
  const labels = { DEV: 'DEV', PROD: 'PROD' };
  assert.equal(P.driftWords({ from: 'DEV', to: 'PROD', behind: 3, versionsDiffer: true }, labels), 'PROD is 3 builds behind DEV');
  assert.equal(P.driftWords({ from: 'DEV', to: 'PROD', behind: 1 }, labels), 'PROD is 1 build behind DEV');
  assert.equal(P.driftWords({ from: 'DEV', to: 'PROD', behind: 0, versionsDiffer: true }, labels), 'PROD runs a different version than DEV');
  assert.equal(P.driftWords({ from: 'DEV', to: 'PROD', behind: 0, versionsDiffer: false }, labels), '');
});

test('text from a server is shown without what can make one name read as another', () => {
  assert.equal(P.plainShown('\u202Eevil\u202C name'), 'evil name', 'an override that would draw it backwards');
  assert.equal(P.plainShown('pay\u200Bment'), 'payment', 'a zero-width character that makes two names look the same');
  assert.equal(P.plainShown('\u2066isolated\u2069'), 'isolated');
  assert.equal(P.plainShown('é ñ 日本語 عربى'), 'é ñ 日本語 عربى', 'honest right-to-left text is left alone');
  assert.equal(P.plainShown(42), '42');
});

const cell = (status, n = 1) => ({ path: 'x', last: status ? { number: n, status, running: status === 'running' } : null });
const brow = (service, folder, health, cells, drift = []) => ({ key: folder + '|' + service, service, folder, health, cells, drift });

test('the board puts what needs a look first and sets the noise aside, saying why', () => {
  const rows = [
    brow('quiet old', 'KUBRIK (old - do not use)/A', 'green', { DEV: cell('success'), PROD: cell('success') }),
    brow('never', 'KUBRIK/B', 'none', { DEV: cell(null), PROD: cell(null) }),
    brow('healthy', 'KUBRIK/C', 'green', { DEV: cell('success'), PROD: cell('success') }),
    brow('lagging', 'KUBRIK/C', 'green', { DEV: cell('success'), PROD: cell('success') }, [{ behind: 3, versionsDiffer: true }]),
    brow('broken', 'KUBRIK/C', 'red', { DEV: cell('failed'), PROD: cell('success') }),
    brow('busy', 'KUBRIK/D', 'running', { DEV: cell('running'), PROD: cell('success') })
  ];
  const p = P.boardPrepare(rows, {});
  assert.deepEqual(p.list.map((r) => r.service), ['broken', 'busy', 'lagging', 'healthy']);
  assert.equal(p.inactive, 2);
  assert.deepEqual({ ...p.why }, { 'never built': 1, 'in an old folder': 1 });
  assert.deepEqual({ ...p.counts }, { red: 1, running: 1, amber: 0, lagging: 1, green: 1 });
  assert.equal(P.boardPrepare(rows, { showInactive: true }).list.length, 6);
  assert.deepEqual(P.boardPrepare(rows, { filter: 'lagging' }).list.map((r) => r.service), ['lagging']);
  const grouped = P.boardPrepare(rows, { group: true }).list.map((r) => r.folder);
  assert.deepEqual(grouped, [...grouped].sort(), 'grouped by folder, in order');
  for (const folder of ['KUBRIK (old - do not use)', 'DEPRECATED/x', 'x/archive', 'Legacy stuff', 'unused']) assert.equal(P.BOARD_OLD.test(folder), true, folder);
  for (const folder of ['KUBRIK/TIMELOG', 'golden/boldness', 'holder']) assert.equal(P.BOARD_OLD.test(folder), false, folder);
});

test('a pipeline question starts from its defaults, never from a secret, and answers go as text', () => {
  const params = [
    { name: 'ENV', type: 'choice', choices: ['qa', 'prod'], default: 'prod' },
    { name: 'FIRST', type: 'choice', choices: ['a', 'b'], default: 'zzz' },
    { name: 'DRY', type: 'boolean', default: 'true' },
    { name: 'PW', type: 'password', secret: true, default: 'hunter2' },
    { name: 'NOTE', type: 'string', default: null }
  ];
  const d = P.inputDefaults(params);
  assert.equal(d.ENV, 'prod');
  assert.equal(d.FIRST, 'a', 'a default that is not a choice falls back to the first');
  assert.equal(d.DRY, true);
  assert.equal(d.PW, '', 'a secret is never prefilled, whatever Jenkins says its default is');
  assert.equal(d.NOTE, '');
  assert.deepEqual({ ...P.inputAnswers(params, { ...d, DRY: false, PW: 'x' }) }, { ENV: 'prod', FIRST: 'a', DRY: 'false', PW: 'x', NOTE: '' });
});

test('a certificate problem is told apart from a server that is down', () => {
  assert.equal(P.isCertError({ code: 'certificate', message: 'x' }), true);
  assert.equal(P.isCertError(new Error('net::ERR_CERT_AUTHORITY_INVALID')), true);
  assert.equal(P.isCertError('self-signed certificate in certificate chain'), true);
  assert.equal(P.isCertError(new Error('Jenkins took too long to answer')), false);
  assert.equal(P.isCertError(null), false);
});

test('how far a running build is: Jenkins\' own figure when it gave one, never 0 or 100 while running', () => {
  assert.equal(P.buildPercent({ progress: 0.42, timestamp: 0, estimated: 1000 }, 500), 42);
  assert.equal(P.buildPercent({ progress: 0.995, timestamp: 0, estimated: 0 }, 500), 99);
  assert.equal(P.buildPercent({ progress: 0, timestamp: 0, estimated: 0 }, 500), 1);
  assert.equal(P.buildPercent({ timestamp: 0, estimated: 1000 }, 500), 50, 'else what its estimate says');
  assert.equal(P.buildPercent({ timestamp: 0, estimated: 0 }, 500), null, 'no estimate, no figure');
  assert.deepEqual(P.NOTIFY_SWITCHES.map((x) => x[0]), ['mine', 'favorites', 'system']);
  assert.equal(P.commitLine({ id: 'a91c3e2b77', message: 'Round refunds\nlong body' }), 'a91c3e2b Round refunds');
});

test('every verb the app asks the person about first is patient: it is not given up on after a minute', () => {
  for (const verb of ['run', 'rebuild', 'stop', 'runMany', 'promote', 'scheduleRun', 'inputSubmit', 'inputAbort', 'jobEnabled', 'nodeToggle', 'trustCertificate', 'forget', 'deleteServer', 'importServers', 'exportServers', 'claudeAccessSave', 'replay', 'restartFromStage']) {
    assert.ok(P.PATIENT.includes(verb), `${verb} waits for a person`);
  }
  for (const verb of ['dashboard', 'timeline', 'launchpad', 'tree']) assert.equal(P.PATIENT.includes(verb), false, `${verb} is a read`);
});

test('a "no" to the app\'s question is a choice, not a failure', () => {
  assert.equal(P.declined(new Error('the person said no')), true);
  assert.equal(P.declined('the person said no'), true);
  assert.equal(P.declined(new Error('Jenkins took too long to answer')), false);
  assert.equal(P.declined(null), false);
});

test('a promotion plan in either shape the app sends is drawn the same, and what is missing is told', () => {
  const old = P.promoteItems({ params: { VERSION: '1.4', ENV: 'prod' }, needsInput: ['API_KEY'], unmatched: ['X'] });
  assert.deepEqual(old.copied.map((c) => c.name), ['VERSION', 'ENV']);
  assert.deepEqual(old.needs.map((n) => [n.name, n.kind, n.blocking]), [['API_KEY', 'secret', true]]);
  assert.deepEqual([...old.unmatched], ['X']);
  const next = P.promoteItems({ copied: [{ name: 'VERSION', value: '1.4', how: 'copied' }, { name: 'NS', value: 'blue', how: 'environment' }], needsInput: [{ name: 'NS', kind: 'environment', blocking: false, sourceValue: 'dev', targetDefault: 'prod' }, { name: 'KEY', kind: 'secret', blocking: true }], blocked: [{ name: 'VERSION2', sourceValue: '9', reason: 'x', candidates: ['IMAGE_VERSION'] }], unmatched: [{ name: 'Y' }] });
  assert.deepEqual(next.copied.map((c) => c.name), ['VERSION'], 'a name that has to be typed is not also copied');
  assert.deepEqual([...next.unmatched], ['Y']);
  const ch = { overrides: {}, map: {}, skip: {}, flags: {} };
  assert.deepEqual([...P.promoteMissing(next, ch)], ['KEY', 'VERSION2'], 'a blocking need and a blocked parameter; the optional one is not asked');
  ch.overrides.KEY = 's'; ch.map.VERSION2 = 'IMAGE_VERSION';
  assert.deepEqual([...P.promoteMissing(next, ch)], []);
  assert.deepEqual(JSON.parse(JSON.stringify(P.promoteSend(next, { ...ch, flags: { allowBusy: true } }))), { overrides: { KEY: 's' }, map: { VERSION2: 'IMAGE_VERSION' }, allowBusy: true });
  const left = { overrides: { KEY: 's' }, map: {}, skip: { VERSION2: true }, flags: {} };
  assert.deepEqual(JSON.parse(JSON.stringify(P.promoteSend(next, left))), { overrides: { KEY: 's' }, skip: ['VERSION2'] });
});

test('what is remembered of a form holds nothing whose name says it is a secret, and not every job ever', () => {
  const all = {};
  for (let i = 0; i < 300; i += 1) all['s|job' + i] = { VERSION: '1', GITHUB_TOKEN: 'x', ENV: 'qa', Password: 'p' };
  const kept = P.rememberableParams(all);
  assert.equal(Object.keys(kept).length, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(kept['s|job299'])), { VERSION: '1', ENV: 'qa' });
  assert.deepEqual({ ...P.rememberableParams(null) }, {});
});

test('the archive limits are the ones the app enforces', () => {
  assert.deepEqual([...P.ARCHIVE_LIMITS.keepPerJob], [10, 1000]);
  assert.deepEqual([...P.ARCHIVE_LIMITS.maxMB], [50, 5000]);
});

test('a clock that is ahead does not make a negative duration', () => {
  assert.equal(P.dur(-90000), '—');
  assert.equal(P.dur(null), '—');
  assert.equal(P.dur(90000), '1:30');
});

test('a run form groups what belongs together: the long tail of RUN_* switches becomes one picker, and says when it matters', () => {
  const flag = (name, extra) => ({ name, type: 'boolean', description: 'Run ' + name + ' PROD. Read only when MODE is SELECTED.', ...extra });
  const params = [
    { name: 'MODE', type: 'choice', choices: ['ONLY_CHANGED', 'SELECTED'] },
    flag('RUN_A'), flag('RUN_B'), flag('RUN_C'),
    { name: 'FAIL_FAST', type: 'boolean', description: 'Abort the rest.' },
    { name: 'EXCLUDE', type: 'string', required: true }
  ];
  const g = P.groupParams(params);
  assert.deepEqual(g.fields.map((p) => p.name), ['MODE', 'EXCLUDE'], 'text and choices stay as fields, in order');
  assert.deepEqual(g.flags.params.map((p) => p.name), ['RUN_A', 'RUN_B', 'RUN_C']);
  assert.equal(g.flags.prefix, 'RUN_');
  assert.deepEqual(g.flags.when, { name: 'MODE', value: 'SELECTED' }, 'the description says when they are read');
  assert.deepEqual(g.options.map((p) => p.name), ['FAIL_FAST'], 'a lone switch is an option, not a group');
  const few = P.groupParams([flag('RUN_A'), flag('RUN_B')]);
  assert.equal(few.flags, null, 'two switches are not a long tail');
  assert.deepEqual(few.options.map((p) => p.name), ['RUN_A', 'RUN_B']);
  const mixed = P.groupParams([flag('RUN_A'), flag('RUN_B', { description: 'Read only when MODE is ALL.' }), flag('RUN_C')]);
  assert.equal(mixed.flags.when, null, 'no single condition, none claimed');
  assert.deepEqual(P.groupParams([]), { fields: [], flags: null, options: [] });
});

test('a parameter Jenkins works out is shown, not asked for, and never sent; and the ones it reads are known', () => {
  const params = [
    { name: 'CURRENT_VERSIONS', type: 'display', required: false, default: '', view: [], reactive: true, refs: ['LIB', 'BUMP'] },
    { name: 'LIB', type: 'choice', choices: ['common', 'mongo-common'], default: 'common' },
    { name: 'BUMP', type: 'choice', choices: ['POM (2.5.3)', 'MINOR'], default: 'POM (2.5.3)', reactive: true, refs: ['LIB'] },
  ];
  const values = { CURRENT_VERSIONS: '', LIB: 'common', BUMP: 'POM (2.5.3)' };
  assert.deepEqual({ ...P.paramProblems(params, values) }, {});
  assert.deepEqual(Object.keys(P.reactiveReads({ params })).sort(), ['BUMP', 'LIB']);
  assert.deepEqual(Object.keys(P.reactiveReads({ params: [params[1]] })), [], 'nothing reactive, nothing to watch');
  assert.equal(P.differsFromDefault(params[0], 'anything'), false, 'a display is never "changed"');
  assert.equal(P.differsFromDefault(params[2], 'MINOR'), true);
  const text = P.callPreviewText({}, params, values);
  assert.equal(text.includes('CURRENT_VERSIONS'), false, 'a block that only shows is not part of the request');
  assert.match(text, /LIB=common&BUMP=POM%20\(2\.5\.3\)/);
  // A choice that Jenkins's new list no longer has is still caught, so Run waits for the form to be right.
  assert.deepEqual({ ...P.paramProblems(params, { ...values, BUMP: 'GONE' }) }, { BUMP: 'Not one of the choices Jenkins offers.' });
});
