'use strict';

/*
 * The Code Reviewer's rules, each one held still. Most of them are here
 * because the app they were ported from got them wrong once, and the test
 * names say how.
 */

const test = require('node:test');
const assert = require('node:assert');
const R = require('../electron/review-rules');
const P = require('../electron/review-prompts');

const file = (path, added = 1, deleted = 0) => ({ path, added, deleted });

test('risk words are words, not substrings', () => {
  assert.equal(R.isRisky('src/auth/Session.kt'), true);
  assert.equal(R.isRisky('db/migrations/V12__x.sql'), true);
  assert.equal(R.isRisky('src/PaymentService.java'), true, 'camelCase is split');
  // The ones `contains` used to send to the expensive model.
  assert.equal(R.isRisky('src/Author.kt'), false);
  assert.equal(R.isRisky('ui/SyntaxHighlighter.ts'), false);
  assert.equal(R.isRisky('text/Acronym.kt'), false);
  assert.equal(R.isRisky('yarn.lock'), false);
  assert.equal(R.isRisky('package-lock.json'), false);
});

test('depth: risk beats size, size decides the rest', () => {
  assert.equal(R.plan([file('db/migration/V1.sql', 2)], null, null).depth, 'HEAVY');
  assert.equal(R.plan([file('a.ts', 10), file('b.ts', 10)], null, null).depth, 'LIGHT');
  assert.equal(R.plan(Array.from({ length: 15 }, (_, i) => file(`f${i}.ts`)), null, null).depth, 'HEAVY');
  assert.equal(R.plan([file('a.ts', 700)], null, null).depth, 'HEAVY');
  assert.equal(R.plan([file('a.ts', 50), file('b.ts', 50), file('c.ts', 10), file('d.ts', 1)], null, null).depth, 'INTERMEDIATE');
  assert.equal(R.plan([], null, null).depth, 'INTERMEDIATE');
});

test('kind: by the weight of what was touched', () => {
  assert.equal(R.plan([file('src/App.tsx', 100)], null, null).kind, 'FRONTEND_WEB');
  assert.equal(R.plan([file('src/Api.kt', 100)], null, null).kind, 'BACKEND');
  assert.equal(R.plan([file('src/Api.kt', 50), file('web/App.tsx', 50)], null, null).kind, 'FULLSTACK');
  assert.equal(R.plan([file('ios/App.swift', 50), file('src/Api.kt', 10)], null, null).kind, 'MOBILE');
  // build.gradle is every JVM project, not a hint of mobile.
  assert.equal(R.plan([file('build.gradle', 5), file('src/Main.kt', 20)], null, null).kind, 'BACKEND');
  assert.equal(R.plan([file('README.md', 5)], null, null).kind, 'GENERIC');
});

test('a profile set by hand is kept, and automatic says why', () => {
  const hand = R.plan([file('a.ts')], 'HEAVY', 'BACKEND');
  assert.deepEqual([hand.depth, hand.kind, hand.reason], ['HEAVY', 'BACKEND', 'profile set by hand']);
  assert.match(R.plan([file('src/auth/x.ts')], null, null).reason, /^auto: depth deep \(touches 1 sensitive file/);
});

test('every depth denies writing and the network, and allows more git as it deepens', () => {
  assert.deepEqual(R.REVIEW_DENIED, ['Edit', 'Write', 'WebFetch', 'WebSearch', 'Bash(git *--output*)', 'Bash(git grep *)']);
  // Neither of these is read-only: grep -O runs a command, --output writes a file.
  for (const depth of Object.values(R.DEPTHS)) assert.ok(!depth.tools.includes('Bash(git grep *)'));
  assert.ok(!R.DEPTHS.LIGHT.tools.includes('Bash(git log *)'));
  assert.ok(R.DEPTHS.HEAVY.tools.includes('Bash(git blame *)'));
  for (const depth of Object.values(R.DEPTHS)) assert.ok(!depth.tools.some((tool) => /Edit|Write|push/.test(tool)));
  assert.ok(R.FIX_DENIED.includes('Bash(git push *)') && R.FIX_DENIED.includes('Bash(git commit *)'));
});

test('numstat resolves renames to the path that exists now', () => {
  assert.equal(R.resolveRenamed('src/{old => new}/File.kt'), 'src/new/File.kt');
  assert.equal(R.resolveRenamed('src/{ => sub}/File.kt'), 'src/sub/File.kt');
  assert.equal(R.resolveRenamed('old.kt => new.kt'), 'new.kt');
  assert.deepEqual(R.parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n'), [file('a.ts', 3, 1), { path: 'img.png', added: 0, deleted: 0 }]);
});

test('scope: full the first time, forced, on the same commit, and after rewritten history', async () => {
  const yes = async () => true;
  const no = async () => false;
  const previous = { id: 'r1', headSha: 'aaa' };
  assert.equal((await R.decideScope({ previous: null, headSha: 'bbb', isAncestor: yes })).reason, 'FIRST_REVIEW');
  assert.equal((await R.decideScope({ previous, headSha: 'bbb', forceFull: true, isAncestor: yes })).reason, 'FORCED');
  assert.equal((await R.decideScope({ previous, headSha: 'aaa', isAncestor: yes })).reason, 'SAME_COMMIT');
  assert.equal((await R.decideScope({ previous, headSha: 'bbb', isAncestor: no })).reason, 'REWRITTEN_HISTORY');
  // A git error is a doubt, and a doubt reviews everything.
  const broken = async () => { throw new Error('bad object'); };
  assert.equal((await R.decideScope({ previous, headSha: 'bbb', isAncestor: broken })).scope, 'FULL');
  assert.deepEqual(await R.decideScope({ previous, headSha: 'bbb', isAncestor: yes }), { scope: 'INCREMENTAL', reason: 'NEW_COMMITS', sinceSha: 'aaa', previousReviewId: 'r1' });
});

test('findings are read defensively', () => {
  const raw = '```json\n' + JSON.stringify({
    summary: 'S',
    findings: [
      { file: 'a.ts', line: 3, severity: 'major', category: 'BUG', title: 'T', body: 'B', suggestion: '' },
      { file: '', severity: 'major', title: 'no file' },
      { file: 'b.ts', line: null, severity: 'weird', category: 'NOPE', title: 'T2', body: 'B2' },
    ],
  }) + '\n```';
  const parsed = R.parseFindings(raw);
  assert.equal(parsed.summary, 'S');
  assert.equal(parsed.findings.length, 2, 'a finding with no file cannot be anchored and is dropped');
  assert.deepEqual(parsed.findings[0], { filePath: 'a.ts', lineNo: 3, severity: 'major', category: 'BUG', title: 'T', body: 'B', suggestion: null });
  assert.equal(parsed.findings[1].severity, 'minor');
  assert.equal(parsed.findings[1].category, null, 'an unknown category is not invented');
  assert.deepEqual(R.parseFindings('not json'), { summary: '', findings: [] });
  assert.equal(R.parseFindings({ summary: 'obj', findings: [] }).summary, 'obj', 'structured output arrives as an object');
});

test('carried rulings: only ids that were sent, unknown verdicts stay open, the forgotten are carried', () => {
  const ids = new Set(['f1', 'f2', 'f3']);
  const rulings = R.parseCarried({ carried: [
    { id: 'f1', verdict: 'FIXED', evidence: 'e' },
    { id: 'zz', verdict: 'FIXED', evidence: 'invented' },
    { id: 'f2', verdict: 'MAYBE', evidence: 'x', line: '12' },
    { id: 'f1', verdict: 'OBSOLETE', evidence: 'dup' },
  ] }, ids);
  assert.deepEqual(rulings.map((r) => [r.id, r.verdict, r.line]), [['f1', 'FIXED', null], ['f2', 'STILL_OPEN', 12]]);
  const plan = R.carryPlan([{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }], rulings);
  assert.deepEqual(plan.map((step) => [step.finding.id, step.verdict]), [['f1', 'FIXED'], ['f2', 'STILL_OPEN'], ['f3', 'STILL_OPEN']]);
});

test('verification ignores ids it did not send and reads unknown verdicts as unresolved', () => {
  const parsed = R.parseResolution({ summary: 's', mergeable: true, items: [{ id: 'a', resolution: 'resolved', evidence: 'x' }, { id: 'b', resolution: '??' }, { id: 'nope', resolution: 'RESOLVED' }] }, new Set(['a', 'b']));
  assert.deepEqual(parsed.items.map((i) => [i.id, i.resolution]), [['a', 'RESOLVED'], ['b', 'UNRESOLVED']]);
  assert.equal(parsed.mergeable, true);
});

test('what a finding is waiting for', () => {
  const published = { publishedId: 'c1' };
  assert.equal(R.settled({}), false);
  assert.equal(R.settled(published), true);
  assert.equal(R.settled({ dismissedAt: 'x' }), true);
  assert.equal(R.needsVerdict(published), true);
  assert.equal(R.needsVerdict({ ...published, resolution: 'PARTIAL' }), true);
  assert.equal(R.needsVerdict({ ...published, resolution: 'WONT_FIX' }), false);
  assert.equal(R.needsVerdict({ ...published, closedAt: 'x' }), false);
  assert.equal(R.closed({ ...published, resolution: 'RESOLVED' }), true);
  assert.equal(R.closed({ resolution: 'RESOLVED' }), false, 'resolved but never published is not closed');
});

test('the merge gate, in order', () => {
  const base = { prHeadSha: 'new', reviewHeadSha: 'old', hasReview: true, pendingFindings: 0, pendingNotes: 0, pendingReplies: 0, published: 0, notResolved: 0, notVerified: 0 };
  assert.match(R.mergeBlocker({ ...base, prHeadSha: null }), /not loaded/);
  assert.match(R.mergeBlocker({ ...base, hasReview: false }), /not been reviewed/);
  assert.match(R.mergeBlocker({ ...base, pendingFindings: 2 }), /2 finding/);
  assert.match(R.mergeBlocker({ ...base, pendingNotes: 1 }), /note/);
  assert.match(R.mergeBlocker({ ...base, pendingReplies: 1 }), /repl/);
  assert.match(R.mergeBlocker({ ...base, published: 1, reviewHeadSha: 'new' }), /No new commits/);
  // A review that published nothing asked for nothing: no commit is owed.
  assert.equal(R.mergeBlocker({ ...base, published: 0, reviewHeadSha: 'new' }), null);
  assert.match(R.mergeBlocker({ ...base, published: 1, notResolved: 1 }), /not resolved/);
  assert.match(R.mergeBlocker({ ...base, published: 1, notVerified: 1 }), /not verified/);
  assert.equal(R.mergeBlocker({ ...base, published: 1 }), null);
});

test('readiness counts closed items as done, and never shows 99.6% as 100', () => {
  const pr = { headSha: 'h2', state: 'OPEN' };
  const review = { headSha: 'h1' };
  const allFixed = R.readiness({ pr, review: { headSha: 'h2' }, threads: [], findings: [{ publishedId: 'c', filePath: 'a.ts', closedAt: 'x' }], finalPassDone: false, finalPassBlockers: 0 });
  assert.ok(allFixed.percent > 0, 'fixing everything must not read 0%');
  const done = R.readiness({ pr, review, threads: [], findings: [{ publishedId: 'c', filePath: 'a.ts', resolution: 'RESOLVED' }], finalPassDone: true, finalPassBlockers: 0 });
  assert.equal(done.percent, 100);
  const blocked = R.readiness({ pr, review, threads: [], findings: [], finalPassDone: true, finalPassBlockers: 2 });
  assert.equal(blocked.percent, 0);
  assert.equal(R.readiness({ pr: null, review, threads: [], findings: [] }).percent, 0);
  assert.equal(R.readiness({ pr: { state: 'MERGED' }, review, threads: [], findings: [] }).percent, 100);
});

test('board flags: nothing claims work on a closed PR, and the ball is yours when they replied', () => {
  const open = { state: 'OPEN', headSha: 'h2' };
  assert.deepEqual(R.prFlags(open, {}), ['UNREVIEWED']);
  assert.deepEqual(R.prFlags(open, { reviewing: true }), ['REVIEWING']);
  assert.deepEqual(R.prFlags(open, { reviewedSha: 'h1' }), ['STALE']);
  assert.deepEqual(R.prFlags(open, { reviewedSha: 'h2', toPublish: true, publishedCount: 1, findingCount: 3 }), ['PARTIAL']);
  assert.deepEqual(R.prFlags(open, { reviewedSha: 'h2', unresolved: 1 }), ['AWAITING_THEM']);
  assert.deepEqual(R.prFlags(open, { reviewedSha: 'h2', unresolved: 1, replied: true }), ['REPLIED', 'TO_VERIFY']);
  assert.deepEqual(R.prFlags(open, { reviewedSha: 'h1', unresolved: 1 }), ['STALE', 'AWAITING_THEM', 'TO_VERIFY']);
  assert.deepEqual(R.prFlags({ state: 'MERGED', headSha: 'h' }, { toPublish: true, replied: true }), ['MERGED']);
  assert.equal(R.rowRank(['MERGED']), 3);
  assert.equal(R.rowRank(['TO_PUBLISH', 'REVIEWING']), 0);
  // It used to be 1, a band of its own — which is how pressing Review took the
  // pull request out of the list you pressed it in. See the test below.
  assert.equal(R.rowRank(['REVIEWING']), 0);
});

test('conversation: states and their order', () => {
  const findings = [
    { id: 'a', publishedId: 'c1', filePath: 'a.ts', title: 'A', body: 'a' },
    { id: 'b', publishedId: 'c2', filePath: 'b.ts', title: 'B', body: 'b' },
    { id: 'c', filePath: 'c.ts', title: 'C', body: 'c' },
    { id: 'd', publishedId: 'c4', filePath: 'd.ts', title: 'D', body: 'd', resolution: 'UNRESOLVED' },
    { id: 'e', publishedId: 'c5', filePath: 'e.ts', title: 'E', body: 'e', dismissedAt: 'x' },
  ];
  const comments = [
    { commentId: 'c1', author: 'me', body: 'A', ours: true, createdOn: '2026-01-01' },
    { commentId: 'r1', author: 'them', body: 'no', ours: false, createdOn: '2026-01-02', parentId: 'c1' },
    { commentId: 'c2', author: 'me', body: 'B', ours: true, createdOn: '2026-01-01' },
    { commentId: 'r2', author: 'them', body: 'done', ours: false, createdOn: '2026-01-02', parentId: 'c2' },
  ];
  const replies = [{ id: 'd2', theirCommentId: 'r2', body: 'drafted', status: 'DRAFTED' }];
  const threads = R.buildConversation({ findings, comments, replies, today: new Date('2026-01-10') });
  assert.deepEqual(threads.map((t) => [t.findingId, t.state]), [['a', 'NEEDS_ANSWER'], ['b', 'DRAFT_READY'], ['d', 'NOT_FIXED'], ['c', 'UNPUBLISHED'], ['e', 'OK']]);
  assert.equal(threads.find((t) => t.findingId === 'd').waitingDays, null, 'no comment of ours stored: nothing to wait from');
  assert.equal(threads.find((t) => t.findingId === 'a').entries.length, 1);
});

test('a reply is detected under any of our comments, and never under our own replies to ourselves', () => {
  const thread = [
    { commentId: '1', author: 'me', body: 'finding', ours: true },
    { commentId: '2', author: 'dev', body: 'fixed', ours: false, parentId: '1' },
    { commentId: '3', author: 'me', body: 'thanks', ours: true, parentId: '2' },
    { commentId: '4', author: 'dev', body: 'np', ours: false, parentId: '3' },
    { commentId: '5', author: 'dev', body: 'unrelated', ours: false },
    { commentId: '6', author: 'x', body: 'to someone else', ours: false, parentId: '5' },
  ];
  assert.deepEqual(R.repliesToUs(thread, new Set()).map((r) => r.theirCommentId), ['2', '4']);
  assert.deepEqual(R.repliesToUs([], new Set(['1'])), []);
});

test('requests from others: not ours, not our published findings, not by our own name', () => {
  const comments = [
    { commentId: 'x1', author: 'Ana', body: 'please rename', ours: false, createdOn: '2026-01-02' },
    { commentId: 'x2', author: 'Me Myself', body: 'self', ours: false, createdOn: '2026-01-02' },
    { commentId: 'p1', author: 'bot', body: 'finding', ours: false, createdOn: '2026-01-01' },
    { commentId: 'x3', author: 'Ana', body: 'deleted', ours: false, deleted: true },
  ];
  const requests = R.foreignRequests({ findings: [{ id: 'f', publishedId: 'p1' }, { id: 'g', publishedId: 'x1', askedBy: 'Ana' }], comments, ourName: 'me myself' });
  assert.deepEqual(requests.map((r) => [r.commentId, r.adoptedFindingId]), [['x1', 'g']]);
});

test('verification is worth a run only when something changed, and always when someone answered', () => {
  const pr = { state: 'OPEN', headSha: 'h2' };
  const findings = [{ publishedId: 'c' }];
  const done = { status: 'DONE', headSha: 'h1' };
  assert.equal(R.verificationNeed({ pr, review: null, findings }).needed, false);
  assert.equal(R.verificationNeed({ pr, review: done, findings: [] }).needed, false);
  assert.equal(R.verificationNeed({ pr, review: done, findings }).needed, true);
  assert.equal(R.verificationNeed({ pr: { ...pr, headSha: 'h1' }, review: done, findings }).why, 'no new commits');
  assert.equal(R.verificationNeed({ pr, review: { ...done, resolutionHead: 'h2' }, findings }).why, 'already verified on this commit');
  assert.equal(R.verificationNeed({ pr: { ...pr, headSha: 'h1' }, review: done, findings, repliesPending: 1 }).becauseOfReplies, true);
  assert.equal(R.verificationNeed({ pr: { ...pr, state: 'MERGED' }, review: done, findings }).needed, false);
});

test('diff numbering: new side for anchors, nothing numbered before a hunk', () => {
  const lines = R.parseDiff('diff --git a/x b/x\nBinary files differ\n@@ -10,3 +10,4 @@ fn\n ctx\n-old\n+new\n+more\n\\ No newline at end of file\n');
  assert.deepEqual(lines.slice(0, 2).map((l) => [l.kind, l.newNo]), [['META', null], ['META', null]]);
  assert.deepEqual(lines.slice(3).map((l) => [l.kind, l.oldNo, l.newNo]), [['CONTEXT', 10, 10], ['REMOVED', 11, null], ['ADDED', null, 11], ['ADDED', null, 12]]);
});

test('skip rules for the automatic sweep', () => {
  const repo = { skipDrafts: true, skipTitles: 'DO NOT MERGE, wip', skipAuthors: 'Bot', onlyTargets: 'main,develop' };
  const pr = { title: 'Feature', author: 'ana', targetBranch: 'main', isDraft: false };
  assert.equal(R.skipReason(repo, pr), null);
  assert.equal(R.skipReason(repo, { ...pr, isDraft: true }), 'draft');
  assert.match(R.skipReason(repo, { ...pr, title: '[WIP] thing' }), /wip/);
  assert.match(R.skipReason(repo, { ...pr, author: 'bot' }), /skipped/);
  assert.match(R.skipReason(repo, { ...pr, targetBranch: 'release' }), /release/);
});

test('what is published: the fix notice always says the commit is not on the branch', () => {
  const finding = { title: 'Null check', severity: 'major', filePath: 'a.ts', lineNo: 4, category: 'BUG', body: 'b', suggestion: 'do x' };
  assert.match(R.fixReply(finding, 'Added the check', 'abcdef1234', 'español'), /Arreglado[\s\S]*abcdef1[\s\S]*Todavía no está en la rama/);
  assert.match(R.fixReply(finding, '', 'abcdef1234', 'English'), /Fixed\*\*\n\nNull check[\s\S]*Not on the branch yet/);
  assert.match(R.fixReplyStandalone(finding, 's', 'abcdef1234', 'es'), /^\*\*Null check\*\*/);
  assert.match(R.fixCommitMessage(finding, 'sum'), /^fix: Null check\n\nsum\n\nHallazgo major en a\.ts:4\n/);
  assert.equal(R.findingComment(finding, 'español'), '_bug_ · **Null check**\n\nb\n\n**Cómo se resolvería**\n\ndo x');
  assert.match(R.renderMarkdown('', [finding], 'español'), /Encontré 1 problema:\n\n1\. \*\*Null check\*\* _\(major · bug\)_\n\n`a\.ts:4`/);
  assert.match(R.renderMarkdown('', [], 'English'), /No findings/);
});

test('fetch advice for the HTTPS remote Bitbucket stopped accepting', () => {
  assert.match(R.fetchAdvice('remote: CHANGE-3222 App passwords', { localPath: '/r', owner: 'o', slug: 's' }), /git@bitbucket\.org:o\/s\.git/);
  assert.equal(R.fetchAdvice('fatal: other', {}), '');
});

test('prompts carry the range, the depth and the rules, and schemas are strict about what matters', () => {
  const pr = { title: 'T', author: 'A', sourceBranch: 'feat', targetBranch: 'main', headSha: 'h' };
  const full = P.reviewPrompt({ pr, language: 'English', depth: 'LIGHT', kind: 'BACKEND', existing: [{ author: 'x', body: 'said\nthis', inlinePath: 'a.ts', inlineLine: 3 }], guidelines: [{ name: 'G', content: 'rule', repoId: 'r' }] });
  assert.match(full, /Rango del diff: origin\/main\.\.\.origin\/feat/);
  assert.match(full, /PROFUNDIDAD: LIVIANA/);
  assert.match(full, /TIPO DE PROYECTO: BACKEND/);
  assert.match(full, /- x \[a\.ts:3\]: said this/);
  assert.match(full, /### G \(este repositorio\)/);
  assert.match(full, /2-4 oraciones en English/);
  const inc = P.incrementalPrompt({ pr, language: 'es', depth: 'HEAVY', kind: 'GENERIC', sinceSha: 's', carried: [{ id: 'f1', filePath: 'a.ts', lineNo: 1, severity: 'minor', title: 't', body: 'b', publishedId: 'c' }] });
  assert.match(inc, /Commits nuevos a revisar: s\.\.h/);
  assert.match(inc, /- id: f1[\s\S]*ya publicado/);
  assert.deepEqual(P.INCREMENTAL_SCHEMA.required, ['summary', 'findings', 'carried']);
  const big = P.guidelinesSection([{ name: 'a', content: 'x'.repeat(P.MAX_GUIDELINES_CHARS + 10) }, { name: 'b', content: 'y' }]);
  assert.match(big, /Se recortaron 2 documento/);
  const { items, thread } = P.resolutionItems([{ id: 'f1', publishedId: 'c1', filePath: 'a.ts', lineNo: 2, severity: 'major', title: 'T', body: 'B' }], [
    { commentId: 'r', author: 'dev', body: 'no aplica', ours: false, parentId: 'c1' },
    { commentId: 'z', author: 'pm', body: 'loose', ours: false },
  ]);
  assert.match(items, /id=f1 \[a\.ts:2\] \(major\) T: B\n    ↳ RESPUESTA de dev: no aplica/);
  assert.match(thread, /OTROS COMENTARIOS DEL HILO[\s\S]*pm: loose/);
  assert.match(P.fixPrompt({ finding: { filePath: 'a.ts', lineNo: 1, severity: 'major', title: 't', body: 'b', askedBy: 'Ana' }, prTitle: 'T', branch: 'feat', language: 'es' }), /Lo pidió: Ana[\s\S]*No hagas commit ni push/);
});

test('a failed read is said in words a person can act on', () => {
  assert.match(R.readableError('[billing-ms · vkarp/billing-ms] HTTP 404 — {"type":"error"}'), /^Not found: the repository does not exist, or the token cannot see it\.$/);
  assert.match(R.readableError('[x] HTTP 401 after 10 attempts — nope'), /rate-limits, so retry before replacing the token/);
  assert.match(R.readableError('[x] HTTP 403 — API rate limit exceeded'), /Rate limited/);
  assert.match(R.readableError('[x] HTTP 403 — forbidden'), /not allowed/);
  assert.match(R.readableError('[x] HTTP 502 — bad gateway'), /HTTP 502\)\. Usually temporary/);
  assert.match(R.readableError('[x] fetch failed'), /Could not reach/);
  assert.equal(R.readableError('[repo] something odd\nstack'), 'something odd');
});

test('the next step on a PR, in the order people are waiting', () => {
  const pr = { state: 'OPEN', headSha: 'h2' };
  const review = { headSha: 'h2' };
  const step = (extra) => R.nextStep({ pr, review, ...extra });
  assert.equal(R.nextStep({ pr: null }).action, 'load');
  assert.equal(R.nextStep({ pr: { state: 'MERGED' } }).kind, 'done');
  assert.equal(step({ running: [{ kind: 'review' }] }).kind, 'wait');
  assert.equal(R.nextStep({ pr, review: null }).action, 'run-review');
  assert.equal(step({ findings: [{ id: 'a' }, { id: 'b', askedBy: 'Ana' }], notes: [{}] }).title, 'Publish 2 findings', 'an adopted request is not ours to publish');
  assert.equal(step({ findings: [{ publishedId: 'c' }], threads: [{ state: 'DRAFT_READY' }] }).action, 'tab-conversation');
  assert.equal(R.nextStep({ pr, review: { headSha: 'h1' }, findings: [{ publishedId: 'c' }] }).action, 'verify');
  assert.equal(R.nextStep({ pr, review: { headSha: 'h1' }, findings: [] }).title, 'Review what is new');
  assert.equal(step({ findings: [{ publishedId: 'c' }] }).title, 'Waiting for the author');
  assert.equal(step({ findings: [{ publishedId: 'c', resolution: 'RESOLVED' }] }).action, 'final-pass');
  assert.equal(step({ finalPassDone: true, finalPassBlockers: 2 }).kind, 'warn');
  assert.equal(step({ finalPassDone: true, mergeBlocker: 'x' }).title, 'Almost ready to merge');
  assert.equal(step({ finalPassDone: true }).title, 'Ready to merge');
});

test('a forge time with its zone trimmed off is UTC', () => {
  const now = new Date('2026-09-14T17:30:00Z');
  assert.equal(R.daysBetween('2026-09-10 17:40', now), 3, 'not shifted by the local zone');
  assert.equal(R.daysBetween('2026-09-11T17:30:00Z', now), 3);
});

test('a finding already on the PR is recognised, whoever published it', () => {
  const finding = { title: 'Null check', filePath: 'src/a.ts', lineNo: 12 };
  const comments = [
    { commentId: '1', body: '_bug_ · **Null check**\n\nbody', inlinePath: 'src/other.ts', inlineLine: 12 },
    { commentId: '2', body: 'I agree about **Null check**', inlinePath: 'src/a.ts', inlineLine: 12, parentId: '9' },
    { commentId: '3', body: '_bug_ · **Null check**\n\nbody', inlinePath: 'src/a.ts', inlineLine: 14, deleted: true },
    { commentId: '4', body: '_bug_ · **Null check**\n\nbody', inlinePath: 'src/a.ts', inlineLine: 15 },
  ];
  assert.equal(R.matchPublished(finding, comments).commentId, '4', 'same file and title; a re-anchored line is still the comment');
  assert.equal(R.matchPublished({ ...finding, title: 'Other' }, comments), null);
  const wholeFile = { title: 'Naming', filePath: 'src/a.ts', lineNo: null };
  assert.equal(R.matchPublished(wholeFile, [{ commentId: '5', body: '`src/a.ts`\n\n_diseño_ · **Naming**\n\nx', inlinePath: null }]).commentId, '5');
  assert.equal(R.matchPublished(finding, [{ commentId: '6', body: '`src/a.ts`\n\n**Null check**', inlinePath: null }]), null, 'a finding with a line is not a general comment');
});

// ---------------------------------------------------------------- a comment argued away

/*
 * The case this exists for: the reviewer said something, the author answered
 * "no, and here is why", and the answer is right. That comment is finished —
 * it waits for no change in the code — and a review whose published comments
 * can only be closed by a fix is one that never reaches 100% and so never
 * means anything.
 */
const settled = (extra = {}) => ({ publishedId: 'c1', filePath: 'src/a.ts', lineNo: 4, resolution: 'WONT_FIX', resolutionBy: 'YOU', closedAt: '2026-09-22T10:00:00.000Z', ...extra });
const openOne = (extra = {}) => ({ publishedId: 'c2', filePath: 'src/b.ts', lineNo: 9, ...extra });

test('settling a comment the author argued away raises the readiness', () => {
  const pr = { state: 'OPEN', headSha: 'h1' };
  const review = { headSha: 'h1' };
  const base = { pr, review, threads: [], finalPassDone: true, finalPassBlockers: 0 };

  const before = R.readiness({ ...base, findings: [openOne(), openOne({ publishedId: 'c3' })] });
  const after = R.readiness({ ...base, findings: [settled({ publishedId: 'c2' }), openOne({ publishedId: 'c3' })] });
  assert.ok(after.percent > before.percent, `${after.percent}% should be above ${before.percent}%`);

  const all = R.readiness({ ...base, findings: [settled(), settled({ publishedId: 'c3' })] });
  assert.strictEqual(all.percent, 100, 'every comment answered, one way or the other, is a finished review');
});

test('a settled comment is not sent to be verified again', () => {
  assert.strictEqual(R.needsVerdict(openOne()), true);
  assert.strictEqual(R.needsVerdict(settled()), false, 'the person already decided; a run must not overwrite them');
  assert.strictEqual(R.closed(settled()), true);
  assert.strictEqual(R.openForCarry(settled()), false, 'and it is not carried into the next review');
});

// ---------------------------------------------------------------- a run does not move the row

/*
 * Pressing Review used to take the pull request out of the list you pressed it
 * in. The first review drops the "not reviewed" flag, and with nothing else
 * claiming the row it fell to a band called "In progress" — so the one pull
 * request you had just set to work on left "Needs you" and appeared somewhere
 * you were not looking. Work this app is doing on your say-so is still yours.
 */
test('a pull request being reviewed stays where the work is', () => {
  const pr = { state: 'OPEN', headSha: 'h1' };

  const idle = R.prFlags(pr, { reviewedSha: null });
  assert.ok(idle.includes('UNREVIEWED'));
  assert.strictEqual(R.rowRank(idle), 0, 'not reviewed is yours to do');

  const running = R.prFlags(pr, { reviewedSha: null, reviewing: true });
  assert.ok(running.includes('REVIEWING'));
  assert.strictEqual(R.rowRank(running), 0, 'and it does not move while the review runs');

  const fixing = R.prFlags(pr, { reviewedSha: 'h1', fixing: true });
  assert.strictEqual(R.rowRank(fixing), 0);
});

test('a run on somebody else’s waiting pull request is still work of yours', () => {
  const pr = { state: 'OPEN', headSha: 'h1' };
  // Published comments, nothing of ours pending: it was waiting on them.
  const waiting = R.prFlags(pr, { reviewedSha: 'h1', unresolved: 2 });
  assert.strictEqual(R.rowRank(waiting), 2);
  const swept = R.prFlags(pr, { reviewedSha: 'h1', unresolved: 2, reviewing: true });
  assert.strictEqual(R.rowRank(swept), 0, 'while a review runs on it, it is in front of you');
});

test('a closed pull request is last, run or no run', () => {
  assert.strictEqual(R.rowRank(R.prFlags({ state: 'MERGED' }, {})), 3);
  assert.strictEqual(R.rowRank(R.prFlags({ state: 'DECLINED' }, { reviewing: true })), 3);
});
