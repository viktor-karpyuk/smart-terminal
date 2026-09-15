'use strict';

/*
 * GitHub and Bitbucket without a network: a fake `fetch` answers from a script,
 * and `sleep` returns at once, so the retry rules can be watched attempt by
 * attempt.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Forge, ForgeError, lenientParse, retryDelay, nextLink, parseRemote } = require('../electron/review-forge');

function scripted(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    const value = typeof next === 'function' ? next(url, init) : next;
    const headers = new Map(Object.entries(value.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: value.status ?? 200, text: async () => (typeof value.body === 'string' ? value.body : JSON.stringify(value.body ?? {})), headers: { get: (name) => headers.get(name.toLowerCase()) ?? null } };
  };
  const slept = [];
  const forge = new Forge({ fetch, sleep: async (ms) => { slept.push(ms); }, random: () => 0 });
  return { forge, calls, slept };
}

const bitbucket = { id: 'r', name: 'repo', provider: 'BITBUCKET', owner: 'team', slug: 'app', token: 'tok' };
const github = { id: 'g', name: 'gh', provider: 'GITHUB', owner: 'me', slug: 'lib', token: 'pat' };

test('JSON with raw control characters inside strings still parses', () => {
  assert.deepEqual(lenientParse('{"description":"line one\nline two\ttab","n":1}'), { description: 'line one\nline two\ttab', n: 1 });
  assert.throws(() => lenientParse('{broken'));
});

test('backoff starts at 250 ms and doubles from a second, capped at twenty', () => {
  const none = () => 0;
  assert.deepEqual([0, 1, 2, 3, 4, 10].map((attempt) => retryDelay(attempt, none)), [250, 500, 1000, 2000, 4000, 20000]);
});

test('a Bitbucket 401 is retried, even on a POST, because it usually is not the token', async () => {
  const { forge, calls, slept } = scripted([{ status: 401, body: 'nope' }, { status: 401, body: 'nope' }, { status: 201, body: { id: 77 } }]);
  const posted = await forge.of(bitbucket).comment(5, 'hello');
  assert.deepEqual(posted, { id: '77', url: 'https://bitbucket.org/team/app/pull-requests/5#comment-77' });
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [250, 500]);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok', 'Bearer, never Basic');
  assert.deepEqual(calls[2].body, { content: { raw: 'hello' } });
});

test('a 500 on a POST is not retried: it may have happened', async () => {
  const { forge, calls } = scripted([{ status: 500, body: 'boom' }, { status: 201, body: { id: 1 } }]);
  await assert.rejects(forge.of(bitbucket).comment(5, 'x'), (error) => error instanceof ForgeError && error.status === 500);
  assert.equal(calls.length, 1);
});

test('a 500 on a GET is retried, a 404 is not', async () => {
  const first = scripted([{ status: 502 }, { body: { values: [] } }]);
  await first.forge.of(bitbucket).comments(3);
  assert.equal(first.calls.length, 2);
  const second = scripted([{ status: 404, body: 'gone' }]);
  await assert.rejects(second.forge.of(bitbucket).get(3), /HTTP 404/);
  assert.equal(second.calls.length, 1);
});

test('an exhausted 401 explains that the token may be fine', async () => {
  const { forge, calls } = scripted([{ status: 401, body: 'x' }]);
  await assert.rejects(forge.of(bitbucket).get(1), /after 10 attempts[\s\S]*does not necessarily mean the token expired/);
  assert.equal(calls.length, 10);
});

test('Bitbucket pages follow `next`, and PRs map their stances', async () => {
  const pr = (id, extra = {}) => ({ id, title: `PR ${id}`, author: { display_name: 'Ana' }, source: { branch: { name: 'feat' }, commit: { hash: 'abc' } }, destination: { branch: { name: 'main' } }, state: 'OPEN', created_on: '2026-09-01T10:20:30.000Z', updated_on: '2026-09-02T11:00:00Z', links: { html: { href: 'https://bitbucket.org/x' } }, ...extra });
  const { forge, calls } = scripted([
    // The conditional first page, then the whole list again from the start.
    { body: { values: [pr(1)], next: 'https://api.bitbucket.org/2.0/page2' } },
    { body: { values: [pr(1)], next: 'https://api.bitbucket.org/2.0/page2' } },
    { body: { values: [pr(2)] } },
  ]);
  const listed = await forge.of(bitbucket).listOpen({ etag: 'e1' });
  assert.deepEqual(listed.prs.map((p) => p.id), [1, 2]);
  assert.equal(listed.etag, null, 'with more than one page an ETag says nothing about the rest');
  assert.equal(calls[0].headers['If-None-Match'], 'e1');
  assert.equal(listed.prs[0].createdOn, '2026-09-01 10:20');
  const one = scripted([{ body: pr(9, { state: 'SUPERSEDED', participants: [{ state: 'approved', user: { display_name: 'Bo' } }, { state: 'changes_requested', user: { display_name: 'Cy' } }, { state: null, user: { display_name: 'Di' } }] }) }]);
  const got = await one.forge.of(bitbucket).get(9);
  assert.equal(got.state, 'DECLINED');
  assert.deepEqual([got.approvedBy, got.changesRequestedBy, got.participantsIdle], [['Bo'], ['Cy'], ['Di']]);
});

test('Bitbucket answers 304 to an unchanged open list', async () => {
  const { forge } = scripted([{ status: 304, body: '' }]);
  assert.deepEqual(await forge.of(bitbucket).listOpen({ etag: 'e9' }), { prs: [], etag: 'e9', notModified: true });
});

test('Bitbucket threads: inline anchors, parents, and a null line posted as a general comment naming the file', async () => {
  const { forge, calls } = scripted([
    { body: { values: [{ id: 1, user: { display_name: 'A' }, content: { raw: 'x' }, inline: { path: 'a.ts', to: null, from: 7 }, created_on: 't', parent: { id: 9 } }] } },
    { status: 201, body: { id: 2 } },
    { status: 201, body: { id: 3 } },
    { status: 201, body: { id: 4 } },
  ]);
  const [comment] = await forge.of(bitbucket).comments(5);
  assert.deepEqual(comment, { commentId: '1', author: 'A', body: 'x', inlinePath: 'a.ts', inlineLine: 7, deleted: false, createdOn: 't', parentId: '9' });
  await forge.of(bitbucket).inline(5, 'body', 'a.ts', null, 'sha');
  assert.deepEqual(calls[1].body, { content: { raw: '`a.ts`\n\nbody' } });
  await forge.of(bitbucket).inline(5, 'body', 'a.ts', 12, 'sha');
  assert.deepEqual(calls[2].body, { content: { raw: 'body' }, inline: { path: 'a.ts', to: 12 } });
  await forge.of(bitbucket).reply(5, '42', 'r');
  assert.deepEqual(calls[3].body, { content: { raw: 'r' }, parent: { id: 42 } });
});

test('Bitbucket merge and decline: the reason goes first, as a comment', async () => {
  const { forge, calls } = scripted([{ status: 201, body: { id: 1 } }, { status: 200, body: {} }, { status: 200, body: { links: { html: { href: 'u' } } } }]);
  await forge.of(bitbucket).decline(5, 'duplicated');
  assert.deepEqual(calls.map((c) => [c.method, c.url.split('/pullrequests/')[1]]), [['POST', '5/comments'], ['POST', '5/decline']]);
  assert.equal(await forge.of(bitbucket).merge(5, { message: 'm', closeSourceBranch: true, strategy: 'SQUASH' }), 'u');
  assert.deepEqual(calls[2].body, { message: 'm', close_source_branch: true, merge_strategy: 'squash' });
});

test('GitHub pages by Link, merges both comment kinds, and threads replies only under review comments', async () => {
  assert.equal(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'), 'https://api.github.com/x?page=2');
  const { forge, calls } = scripted([
    { body: [{ id: 1, user: { login: 'a' }, body: 'general', created_at: '2026-01-02' }] },
    { body: [{ id: 10, user: { login: 'b' }, body: 'inline', path: 'x.ts', line: 3, created_at: '2026-01-01' }, { id: 11, user: { login: 'c' }, body: 'reply', path: 'x.ts', line: 3, in_reply_to_id: 10, created_at: '2026-01-03' }] },
    { status: 201, body: { id: 12, html_url: 'u12' } },
    { status: 201, body: { id: 13, html_url: 'u13' } },
  ]);
  const comments = await forge.of(github).comments(7);
  assert.deepEqual(comments.map((c) => [c.commentId, c.parentId]), [['rc-10', null], ['ic-1', null], ['rc-11', 'rc-10']]);
  assert.deepEqual(await forge.of(github).reply(7, 'rc-10', 'ok'), { id: 'rc-12', url: 'u12' });
  assert.match(calls[2].url, /pulls\/7\/comments\/10\/replies$/);
  assert.deepEqual(await forge.of(github).reply(7, 'ic-1', 'ok'), { id: 'ic-13', url: 'u13' });
  assert.match(calls[3].url, /issues\/7\/comments$/);
  assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('GitHub reads a PR with its state and who stands where, latest review per person winning', async () => {
  const { forge } = scripted([
    { body: { number: 4, title: 't', user: { login: 'a' }, head: { ref: 'f', sha: 's' }, base: { ref: 'main' }, state: 'closed', merged_at: '2026-01-01', draft: false } },
    { body: [{ user: { login: 'x' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'x' }, state: 'APPROVED' }, { user: { login: 'y' }, state: 'COMMENTED' }, { user: { login: 'z' }, state: 'CHANGES_REQUESTED' }] },
  ]);
  const pr = await forge.of(github).get(4);
  assert.equal(pr.state, 'MERGED');
  assert.deepEqual([pr.approvedBy, pr.changesRequestedBy], [['x'], ['z']]);
});

test('GitHub inline comments anchor on the right side of the head commit', async () => {
  const { forge, calls } = scripted([{ status: 201, body: { id: 5, html_url: 'u' } }]);
  await forge.of(github).inline(7, 'b', 'src/a.ts', 9, 'headsha');
  assert.deepEqual(calls[0].body, { body: 'b', commit_id: 'headsha', path: 'src/a.ts', side: 'RIGHT', line: 9 });
});

test('remotes are read into provider, owner and slug', () => {
  assert.deepEqual(parseRemote('git@bitbucket.org:team/app.git'), { provider: 'BITBUCKET', owner: 'team', slug: 'app' });
  assert.deepEqual(parseRemote('https://github.com/me/lib'), { provider: 'GITHUB', owner: 'me', slug: 'lib' });
  assert.deepEqual(parseRemote('ssh://git@github.com/me/lib.git'), { provider: 'GITHUB', owner: 'me', slug: 'lib' });
  assert.equal(parseRemote('git@gitlab.com:x/y.git'), null);
});

test('a PR from another repository is named owner/repo:branch; 401 is retried only for Bitbucket', () => {
  const { forkBranch, isRetryable } = require('../electron/review-forge');
  assert.equal(forkBranch('someone/app', 'me/app', 'main'), 'someone/app:main');
  assert.equal(forkBranch('me/app', 'me/app', 'feature'), 'feature');
  assert.equal(forkBranch(undefined, 'me/app', 'feature'), 'feature');
  assert.equal(forkBranch(undefined, 'me/app', 'main', true), 'deleted-fork:main', 'GitHub: a deleted fork has no head repository');
  assert.equal(isRetryable(401, '', true), true);
  assert.equal(isRetryable(401, '', true, false), false);
});

test('a GitHub 401 fails at once instead of ten slow tries', async () => {
  const { forge, calls, slept } = scripted([{ status: 401, body: { message: 'Bad credentials' } }]);
  await assert.rejects(forge.of(github).json('https://api.github.com/repos/me/lib/pulls/1'), /HTTP 401/);
  assert.equal(calls.length, 1);
  assert.equal(slept.length, 0);
});

test('withdrawing an approval on GitHub dismisses our own review, not a comment beside it', async () => {
  const { forge, calls } = scripted([
    (url) => (url.endsWith('/user') ? { body: { login: 'me' } } : { body: [{ id: 5, user: { login: 'other' }, state: 'APPROVED' }, { id: 9, user: { login: 'me' }, state: 'APPROVED' }] }),
    { body: [{ id: 5, user: { login: 'other' }, state: 'APPROVED' }, { id: 9, user: { login: 'me' }, state: 'APPROVED' }] },
    { body: {} },
  ]);
  await forge.of(github).unapprove(3);
  const last = calls[calls.length - 1];
  assert.equal(last.method, 'PUT');
  assert.match(last.url, /\/pulls\/3\/reviews\/9\/dismissals$/);
});

test('a GitHub PR whose reviews cannot be read says its stances are unknown', async () => {
  const { forge } = scripted([
    { body: { number: 4, title: 't', user: { login: 'a' }, head: { ref: 'f', sha: 'abc', repo: { full_name: 'me/lib' } }, base: { ref: 'main', repo: { full_name: 'me/lib' } }, state: 'open' } },
    { status: 404, body: { message: 'Not Found' } },
  ]);
  const pr = await forge.of(github).get(4);
  assert.equal(pr.stancesUnknown, true);
  assert.equal(pr.sourceBranch, 'f');
});
