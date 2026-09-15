'use strict';

/*
 * The Code Reviewer's bus: who is writing where, claims, messages, what other
 * branches change, migration numbers — on real git repositories — and the two
 * ends of its wire: the MCP server a Claude starts, and the socket it talks to.
 * The database parts need `node:sqlite` (Node 22+) and skip themselves without it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { buildArgs } = require('../electron/review-claude');
const { TOOLS } = require('../electron/review-bus-mcp');
const { TOOL_NAMES, busSection, pathList, scope } = require('../electron/review-bus');
const { MessageBridge } = require('../electron/message-bridge');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

test('the MCP server offers exactly the tools the bus answers', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), TOOL_NAMES);
});

test('a run on the bus gets only the servers it is given', () => {
  const args = buildArgs({ mcpConfig: { mcpServers: { 'code-review': { command: 'x' } } }, allowedTools: ['Read', 'mcp__code-review__peers'] });
  const at = args.indexOf('--mcp-config');
  assert.equal(JSON.parse(args[at + 1]).mcpServers['code-review'].command, 'x');
  assert.equal(args[at + 2], '--strict-mcp-config', 'the person\'s own MCP servers stay out of a fix');
  assert.ok(args.includes('mcp__code-review__peers'));
  assert.ok(!buildArgs({}).includes('--mcp-config'));
});

test('scopes and path lists are read leniently', () => {
  assert.equal(scope('project'), 'PR', 'the original\'s PROJECT is this PR');
  assert.equal(scope('repo'), 'REPO');
  assert.equal(scope('nonsense'), 'PR');
  assert.deepEqual(pathList('a.ts, ./b.ts,,a.ts'), ['a.ts', 'b.ts']);
  assert.deepEqual(pathList(['x', ' x ']), ['x']);
  assert.match(busSection([{ kind: 'warning', fromLabel: 'Fix #3', subject: 'V0550', body: 'taken' }]), /NO ESTÁS SOLO\n\nTE DEJARON DICHO:\n· \[warning\] Fix #3 · V0550: taken[\s\S]*migration_number/);
});

test('the socket answers a bus request apart from messaging, token or session alike', async () => {
  const seen = [];
  const bridge = new MessageBridge({ socketPath: '/nowhere', reach: () => 'off', roster: () => [], write: () => false, isFree: () => false, store: {}, onBus: (request) => { seen.push(request); return { ok: true, text: 'hi' }; } });
  assert.deepEqual(await bridge.handle({ op: 'bus', token: 'fix:1', tool: 'peers' }), { ok: true, text: 'hi' });
  assert.equal(seen[0].token, 'fix:1', 'a fix has no session id, and still gets through');
  const none = new MessageBridge({ socketPath: '/nowhere', reach: () => 'off', roster: () => [], write: () => false, isFree: () => false, store: {} });
  assert.match((await none.handle({ op: 'bus', tool: 'peers' })).error, /not running/);
});

test('the MCP server speaks the protocol and relays each call over the socket with its identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-mcp-'));
  const socketPath = path.join(dir, 's.sock');
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      received.push(request);
      socket.end(`${JSON.stringify(request.tool === 'claim' ? { ok: false, error: 'nope' } : { ok: true, text: `answered ${request.tool}` })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'electron', 'review-bus-mcp.js')], { env: { ...process.env, SMART_TERMINAL_BRIDGE: socketPath, SMART_TERMINAL_BUS_TOKEN: 'fix:abc', SMART_TERMINAL_SESSION_ID: '' } });
  const replies = new Map();
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    let cut;
    while ((cut = out.indexOf('\n')) >= 0) {
      const message = JSON.parse(out.slice(0, cut));
      out = out.slice(cut + 1);
      replies.get(message.id)?.(message);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve) => { replies.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.name, 'code-review-bus');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await rpc(2, 'tools/list', {});
    assert.deepEqual(list.result.tools.map((tool) => tool.name), TOOL_NAMES);
    const peers = await rpc(3, 'tools/call', { name: 'peers', arguments: {} });
    assert.deepEqual(peers.result, { content: [{ type: 'text', text: 'answered peers' }] });
    assert.deepEqual(received[0], { op: 'bus', tool: 'peers', args: {}, token: 'fix:abc' });
    const refused = await rpc(4, 'tools/call', { name: 'claim', arguments: { paths: ['a'] } });
    assert.equal(refused.result.isError, true);
    const unknown = await rpc(5, 'tools/call', { name: 'rm', arguments: {} });
    assert.equal(unknown.result.isError, true);
    assert.equal(received.length, 2, 'an unknown tool never reaches the app');
  } finally {
    child.kill();
    server.close();
  }
});

// --- the bus on a database and real repositories ---------------------------------------

/**
 * An origin with main and two open PR branches: `feature` (PR 7) and `other`
 * (PR 8), which changes app.js too and adds migration V0012. The clone has main.
 */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-bus-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, seed);
  fs.mkdirSync(path.join(seed, 'db', 'migration'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'app.js'), 'one\n');
  fs.writeFileSync(path.join(seed, 'db', 'migration', 'V0010__init.sql'), 'create table x();\n');
  fs.mkdirSync(path.join(seed, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'node_modules', 'dep', 'V9999__ignored.sql'), '');
  git(seed, 'add', '-f', '.');
  git(seed, 'commit', '-m', 'base');
  git(seed, 'push', 'origin', 'HEAD:main');
  git(seed, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(seed, 'readme.md'), 'feature\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'feature');
  git(seed, 'push', 'origin', 'feature');
  git(seed, 'checkout', 'main');
  git(seed, 'checkout', '-b', 'other');
  fs.writeFileSync(path.join(seed, 'app.js'), 'two\n');
  fs.writeFileSync(path.join(seed, 'db', 'migration', 'V0012__other.sql'), 'alter table x;\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'other');
  git(seed, 'push', 'origin', 'other');
  git(root, 'clone', origin, clone);
  return { root, clone, seed };
}

function setup() {
  const { ReviewStore } = require('../electron/review-store');
  const { ReviewGit } = require('../electron/review-git');
  const { ReviewBus } = require('../electron/review-bus');
  const w = world();
  const db = new sqlite.DatabaseSync(':memory:');
  const store = new ReviewStore(db);
  const repo = store.saveRepo({ name: 'Demo App', provider: 'GITHUB', owner: 'me', slug: 'demo', localPath: w.clone, token: 't' });
  store.upsertPr(repo.id, { id: 7, title: 'Feature', author: 'Ana', sourceBranch: 'feature', targetBranch: 'main', headSha: 'h7', state: 'OPEN' });
  store.upsertPr(repo.id, { id: 8, title: 'Other', author: 'Bo', sourceBranch: 'other', targetBranch: 'main', headSha: 'h8', state: 'OPEN' });
  const workshops = path.join(w.root, 'fixes');
  const events = [];
  const bus = new ReviewBus({ store, git: new ReviewGit({ resolvePath: async () => process.env.PATH }), workshopRoot: workshops, emit: (event) => events.push(event) });
  return { w, store, repo, bus, workshops, events };
}

test('claims are advisory, told, released when the writer leaves, and swept at startup', { skip }, async () => {
  const { bus, repo } = setup();
  const one = bus.openFix({ repoId: repo.id, prId: 7, label: 'Fix #7: null check', branch: 'feature' });
  const two = bus.openFix({ repoId: repo.id, prId: 8, label: 'Fix #8: rename', branch: 'other' });
  assert.match(await bus.call(bus.member(one), 'claim', { paths: ['app.js', 'x.ts'], reason: 'null check' }), /Claimed 2 file/);
  const answer = await bus.call(bus.member(two), 'claim', { paths: 'app.js, y.ts' });
  assert.match(answer, /already someone else's:\n- app\.js  → Fix #7: null check: null check/);
  const peers = await bus.call(bus.member(two), 'peers', {});
  assert.match(peers, /You are Fix #8: rename, in Demo App #8/);
  assert.match(peers, /- Fix #7: null check — Demo App #7  \(same repository\)/);
  assert.match(peers, /- app\.js  \(Fix #7: null check: null check\)/);
  assert.doesNotMatch(peers, /y\.ts/, 'your own claims are not listed as someone else\'s');
  bus.close(one);
  assert.deepEqual(bus.claims(repo.id).map((c) => c.path), ['y.ts']);
  assert.match(await bus.call(bus.member(two), 'release', {}), /Released everything/);
  bus.openFix({ repoId: repo.id, prId: 7, label: 'left running' });
  assert.equal(bus.sweep(), 2);
  assert.equal(bus.liveMembers().length, 0);
});

test('messages reach the right audience, never their author, and never from before a writer joined', { skip }, async () => {
  const { bus, repo, store } = setup();
  const second = store.saveRepo({ name: 'Elsewhere', provider: 'GITHUB', owner: 'me', slug: 'else', localPath: path.join(os.tmpdir()), token: 't' });
  bus.post({ scopeName: 'ALL', from: { label: 'old news' }, body: 'two days ago' });
  store.run('UPDATE cr_bus_message SET at = ?', new Date(Date.now() - 2 * 86400000).toISOString());
  bus.post({ scopeName: 'ALL', from: { label: 'this morning' }, body: 'earlier today' });
  store.run("UPDATE cr_bus_message SET at = ? WHERE body = 'earlier today'", new Date(Date.now() - 3600000).toISOString());
  const session = bus.sessionMember('s', [{ id: 's', name: 'mine', cwd: os.homedir() }]);
  const a = bus.member(bus.openFix({ repoId: repo.id, prId: 7, label: 'A' }));
  const b = bus.member(bus.openFix({ repoId: repo.id, prId: 7, label: 'B' }));
  const c = bus.member(bus.openFix({ repoId: repo.id, prId: 8, label: 'C' }));
  const d = bus.member(bus.openFix({ repoId: second.id, prId: 1, label: 'D' }));
  await bus.call(a, 'notify', { body: 'renamed Money to Amount', subject: 'Money' });
  await bus.call(a, 'notify', { body: 'migration table changed', scope: 'REPO', kind: 'warning' });
  await bus.call(d, 'notify', { body: 'hello everyone', scope: 'ALL', kind: 'question' });
  const texts = (member) => bus.inbox(member).map((m) => m.body);
  assert.deepEqual(texts(a), ['earlier today', 'hello everyone'], 'a fix reads back a day, not two');
  assert.deepEqual(texts(b), ['earlier today', 'renamed Money to Amount', 'migration table changed', 'hello everyone']);
  assert.deepEqual(texts(c), ['earlier today', 'migration table changed', 'hello everyone'], 'another PR hears the repository, not the PR');
  assert.deepEqual(texts(d), ['earlier today']);
  assert.deepEqual(texts(session), ['hello everyone'], 'a session starts from when it joined');
  const read = await bus.call(b, 'inbox', {});
  assert.match(read, /4 new message\(s\):\n- \[note\] this morning\n  earlier today\n- \[note\] A · Money\n  renamed Money to Amount/);
  assert.equal(await bus.call(b, 'inbox', {}), 'Nothing new since you last looked.');
  assert.match(await bus.call(a, 'notify', {}), /Missing `body`/);
});

test('a session is placed by where it stands: a clone, a workshop, or nowhere — and let go when it stops', { skip }, async () => {
  const { bus, repo, w, workshops } = setup();
  fs.mkdirSync(path.join(workshops, 'demo-app-pr8', 'src'), { recursive: true });
  const roster = [
    { id: 's1', name: 'backend', cwd: path.join(w.clone, 'db') },
    { id: 's2', name: 'fixer', cwd: path.join(workshops, 'demo-app-pr8', 'src') },
    { id: 's3', name: 'home', cwd: os.homedir() },
  ];
  assert.deepEqual([bus.sessionMember('s1', roster).repoId, bus.sessionMember('s1', roster).prId], [repo.id, null]);
  const inWorkshop = bus.sessionMember('s2', roster);
  assert.deepEqual([inWorkshop.repoId, inWorkshop.prId, inWorkshop.branch], [repo.id, 8, 'other']);
  const nowhere = bus.sessionMember('s3', roster);
  assert.equal(nowhere.repoId, null);
  assert.match(await bus.call(nowhere, 'claim', { paths: ['a'] }), /not in a repository the Code Reviewer knows/);
  assert.match(await bus.call(nowhere, 'notify', { body: 'x' }), /only scope ALL/);
  assert.equal(bus.sessionMember('ghost', roster), null);

  const s1 = bus.sessionMember('s1', roster);
  await bus.call(s1, 'claim', { paths: ['app.js'] });
  // The session moves out of the repository: what it claimed there is not held any more.
  const moved = [{ ...roster[0], cwd: os.homedir() }, roster[1]];
  bus.sessionMember('s1', moved);
  assert.equal(bus.claims(repo.id).length, 0);
  await bus.call(bus.sessionMember('s2', moved), 'claim', { paths: ['app.js'] });
  // And a session that stops running is let go on the next question anyone asks.
  bus.sessionMember('s1', [moved[0]]);
  assert.equal(bus.member('session:s2').endedAt !== null, true);
  assert.equal(bus.claims(repo.id).length, 0);

  const refused = await bus.handle({ tool: 'peers', from: 'ghost' }, roster);
  assert.match(refused.error, /does not have this session as running/);
  assert.match((await bus.handle({ tool: 'rm', from: 's1' }, roster)).error, /no tool called rm/);
  const ended = bus.openFix({ repoId: repo.id, prId: 7, label: 'x' });
  bus.close(ended);
  assert.match((await bus.handle({ tool: 'peers', token: ended }, roster)).error, /not on the bus any more/);
  assert.match((await bus.handle({ tool: 'peers', token: 'session:s1' }, roster)).error, /not on the bus/, 'a session token cannot be passed off as a fix');
  assert.equal((await bus.handle({ tool: 'peers', from: 's1' }, roster)).ok, true);
});

test('who touched: the other open branches, from git, and the fixes written for them', { skip }, async () => {
  const { bus, repo } = setup();
  const seven = bus.member(bus.openFix({ repoId: repo.id, prId: 7, label: 'Fix #7' }));
  const answer = await bus.call(seven, 'who_touched', { paths: ['app.js', 'readme.md'] });
  assert.match(answer, /- other \(PR #8, Bo\): app\.js/);
  assert.doesNotMatch(answer, /feature/, 'your own PR is not another branch');
  bus.touch({ repoId: repo.id, prId: 9, branch: 'hotfix', label: 'Fix #9', paths: ['readme.md'] });
  assert.match(await bus.call(seven, 'who_touched', { paths: ['readme.md'] }), /- hotfix \(PR #9\): readme\.md/);
  assert.match(await bus.call(seven, 'who_touched', { paths: ['nothing.txt'] }), /No other branch changes those files/);
});

test('migration numbers: above the disk and every other open branch, never handed out twice', { skip }, async () => {
  const { bus, repo } = setup();
  const seven = bus.member(bus.openFix({ repoId: repo.id, prId: 7, label: 'Fix #7' }));
  const eight = bus.member(bus.openFix({ repoId: repo.id, prId: 8, label: 'Fix #8' }));
  // On disk (the clone, main) the highest is V0010, and node_modules is not looked at; PR 8's branch adds V0012.
  assert.equal(await bus.call(seven, 'migration_number', { count: '2' }), 'Use exactly V0013, V0014. They are reserved for you: no other session or fix will be given them.');
  const [a, b] = await Promise.all([bus.call(seven, 'migration_number', {}), bus.call(eight, 'migration_number', {})]);
  const numbers = [a, b].map((text) => /V\d+/.exec(text)[0]).sort();
  assert.deepEqual(numbers.length, 2);
  assert.notEqual(numbers[0], numbers[1], 'two writers asking at once get two numbers');
  assert.equal(bus.reservations(repo.id).length, 4);
  // Its own branch is not a reason to skip: PR 8 asking sees only disk and PR 7.
  assert.match(await bus.call(eight, 'migration_number', { count: '99' }), /V0017, V0018, V0019, V0020, V0021, V0022, V0023, V0024, V0025, V0026\./, 'at most ten, after what was reserved');
});

test('a repository with no numbered migrations says so instead of inventing a number', { skip }, async () => {
  const { bus, store, w } = setup();
  const plain = path.join(w.root, 'plain');
  fs.mkdirSync(path.join(plain, '.git'), { recursive: true });
  const repo = store.saveRepo({ name: 'Plain', provider: 'GITHUB', owner: 'me', slug: 'plain', localPath: plain, token: 't' });
  const member = bus.member(bus.openFix({ repoId: repo.id, prId: 1, label: 'x' }));
  assert.match(await bus.call(member, 'migration_number', {}), /no numbered migrations/);
});

test('a fix joins the bus: its own token, its tools, what was left for it, what it touched, and it leaves', { skip }, async () => {
  const { ReviewService } = require('../electron/review-service');
  const w = world();
  const db = new sqlite.DatabaseSync(':memory:');
  const runs = [];
  const service = new ReviewService({
    db,
    secrets: { encrypt: (t) => t, decrypt: (t) => t },
    fetch: async () => { throw new Error('offline'); },
    profiles: { list: () => [{ id: 'p', name: 'Main' }] },
    resolvePath: async () => process.env.PATH,
    notify: () => {},
    emit: () => {},
    dataDir: w.root,
    DatabaseSync: sqlite.DatabaseSync,
    busServer: () => ({ command: '/electron', script: '/app/review-bus-mcp.js', socketPath: '/tmp/st.sock' }),
  });
  const posted = [];
  const client = { inline: async () => { posted.push('inline'); return { id: 'c1', url: 'u' }; }, reply: async () => ({ id: 'c2', url: 'u' }) };
  for (const holder of [service, service.engine, service.fixer]) holder.forge = { of: () => client };
  const claude = {
    run: async (options) => {
      runs.push(options);
      const member = service.bus.liveMembers().find((m) => m.kind === 'fix');
      assert.ok(member, 'on the bus while it runs');
      assert.equal(options.mcpConfig.mcpServers['code-review'].env.SMART_TERMINAL_BUS_TOKEN, member.token);
      fs.writeFileSync(path.join(options.cwd, 'app.js'), 'fixed\n');
      return { ok: true, text: '', stderr: '', structured: { fixed: true, summary: 'done' }, toolUses: 2, denials: [], limits: [], sessionId: 's', costUsd: 0 };
    },
  };
  for (const holder of [service, service.engine, service.fixer]) holder.claude = claude;
  const repo = service.store.saveRepo({ name: 'Demo', provider: 'GITHUB', owner: 'me', slug: 'demo', localPath: w.clone, token: 't' });
  service.store.upsertPr(repo.id, { id: 7, title: 'Feature', author: 'Ana', sourceBranch: 'feature', targetBranch: 'main', headSha: 'h7', state: 'OPEN' });
  service.store.upsertPr(repo.id, { id: 8, title: 'Other', author: 'Bo', sourceBranch: 'other', targetBranch: 'main', headSha: 'h8', state: 'OPEN' });
  const reviewId = service.store.startReview({ repoId: repo.id, prId: 7, headSha: 'h7' });
  service.store.finishReview(reviewId, { body: 'b' });
  service.store.replaceFindings(reviewId, repo.id, 7, [{ filePath: 'app.js', lineNo: 1, severity: 'major', title: 'wrong word', body: 'b' }]);
  const [finding] = service.store.findingsForReview(reviewId);
  service.bus.post({ scopeName: 'REPO', from: { repoId: repo.id, prId: 8, label: 'Bo (session)', token: 'session:x' }, kind: 'warning', body: 'I am rewriting app.js' });

  const result = await service.call('fix', { findingId: finding.id });
  assert.equal(result.ok, true, result.error);
  const options = runs[0];
  assert.deepEqual(options.mcpConfig.mcpServers['code-review'].args, ['/app/review-bus-mcp.js']);
  assert.ok(TOOL_NAMES.every((name) => options.allowedTools.includes(`mcp__code-review__${name}`)));
  assert.ok(options.allowedTools.includes('Edit') && !options.allowedTools.includes('Bash(git push *)'));
  assert.match(options.prompt, /NO ESTÁS SOLO\n\nTE DEJARON DICHO:\n· \[warning\] Bo \(session\): I am rewriting app\.js/);
  assert.equal(service.bus.liveMembers().length, 0, 'it left the bus when it ended');
  const touched = service.store.all('SELECT path, pr_id FROM cr_bus_touch');
  assert.deepEqual(touched, [{ path: 'app.js', pr_id: 7 }]);
  const warning = service.store.all("SELECT from_label, kind, body FROM cr_bus_message WHERE from_label = 'the tool'");
  assert.equal(warning.length, 1);
  assert.match(warning[0].body, /PR #7 \(feature\) changed files that other open branches also change[\s\S]*other \(PR #8\): app\.js/);
  const overview = (await service.call('bus')).messages;
  assert.equal(overview.length, 2);
});

test('without the app\'s socket a fix runs alone, as before', { skip }, async () => {
  const { FixEngine } = require('../electron/review-fix');
  const engine = new FixEngine({ store: {}, engine: {}, root: '/x', bus: { openFix: () => { throw new Error('should not join'); } }, busServer: () => null });
  assert.equal(engine.attach({ repo: {}, pr: {}, dir: '/x', label: 'l' }), null);
});
