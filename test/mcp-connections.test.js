'use strict';

/**
 * MCP connections the person adds by hand, against two fakes:
 *
 * - a server that speaks Streamable HTTP with a session: it refuses anything
 *   before `initialize`, hands back an `Mcp-Session-Id`, answers some calls as
 *   an event stream, pages `tools/list`, and can forget a session (404);
 * - a product with one stateless server per module, like Kubrik OS: 401 for a
 *   token it does not know, 403 for a module the token was not made for,
 *   `ask_agent` in every module, and a write that comes back as a proposal.
 *
 * Needs `node:sqlite` (Node 22+) for the service's tests and skips them without it.
 */

/** Token-shaped fixtures are built from pieces so no source line looks like a real secret to a scanner. */
const j = (...parts) => parts.join('');
const test = require('node:test');
const assert = require('node:assert');
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';
const { McpConnections, nameOf, addressOf, modulesOf, answerIn } = require('../electron/mcp-connections');

const TOKEN = j('ko', 's_', 'Ab12Cd34', '_', 'x'.repeat(40));
const ro = { readOnlyHint: true };

function reply(status, body, headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status < 400, status, headers: { get: (k) => h[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

/** A product with a stateless server per module at https://mcp.example.com/<module>. */
function modular(sent) {
  const shared = [{ name: 'ask_agent', description: 'Ask the module agent.', inputSchema: { type: 'object' }, annotations: ro }];
  const TOOLS = {
    acc: [
      { name: 'acc_get_invoice', description: 'One invoice.', inputSchema: { type: 'object' }, annotations: ro },
      { name: 'acc_create_invoice', description: 'Creates an invoice.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
      ...shared,
    ],
    crm: [{ name: 'crm_find_customer', description: 'Find a customer.', inputSchema: { type: 'object' }, annotations: ro }, ...shared],
  };
  return (url, init, body) => {
    const m = /^https:\/\/mcp\.example\.com\/([a-z]+)$/.exec(url);
    if (!m) return reply(404, { message: 'No such server.' });
    if (init.headers.Authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'Unauthorized' });
    if (!TOOLS[m[1]]) return reply(403, { code: 'MODULE_NOT_IN_KEY', message: `This API key does not include ${m[1].toUpperCase()}.` });
    if (body.id === undefined) return reply(202, '');
    if (body.method === 'initialize') return reply(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: m[1] }, instructions: `Tools of ${m[1]}.` } });
    if (body.method === 'tools/list') return reply(200, { jsonrpc: '2.0', id: body.id, result: { tools: TOOLS[m[1]] } });
    if (body.method === 'tools/call') {
      sent.push({ module: m[1], params: body.params });
      const out = body.params.name === 'acc_create_invoice'
        ? { status: 'proposal_pending', proposalId: 'p-1', confirmUrl: 'https://erp.example.com/pending/p-1' }
        : { module: m[1], asked: body.params };
      return reply(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } });
    }
    return reply(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  };
}

/** A Streamable HTTP server with sessions at https://tools.example.org/mcp. */
function sessioned(state) {
  return (url, init, body) => {
    if (url !== 'https://tools.example.org/mcp') return reply(404, '');
    if (body.method === 'initialize') {
      state.sessions += 1;
      const id = `sess-${state.sessions}`;
      state.live.add(id);
      return reply(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'tools' } } })}\n\n`, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': id });
    }
    const session = init.headers['Mcp-Session-Id'];
    if (!session) return reply(400, { message: 'No session.' });
    if (!state.live.has(session)) return reply(404, '');
    state.seen.push({ method: body.method, session, protocol: init.headers['MCP-Protocol-Version'] });
    if (body.id === undefined) return reply(202, '');
    if (body.method === 'tools/list') {
      const page = body.params?.cursor === 'p2'
        ? { tools: [{ name: 'search_docs', description: 'Search.', inputSchema: { type: 'object' }, annotations: ro }] }
        : { tools: [{ name: 'get_doc', description: 'One doc.', inputSchema: { type: 'object' }, annotations: ro }], nextCursor: 'p2' };
      return reply(200, { jsonrpc: '2.0', id: body.id, result: page });
    }
    if (body.method === 'tools/call') {
      return reply(200, `: keep-alive\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'plain answer' }], structuredContent: { doc: body.params.arguments.id } } })}\n\n`, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    }
    return reply(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } });
  };
}

function service({ answer = 'yes' } = {}) {
  const sent = [];
  const state = { sessions: 0, live: new Set(), seen: [] };
  const urls = [];
  const servers = [modular(sent), sessioned(state)];
  const fetch = async (url, init) => {
    urls.push({ url, auth: init.headers.Authorization ?? null });
    const body = JSON.parse(init.body);
    for (const serve of servers) {
      const r = serve(url, init, body);
      if (r.status !== 404 || url.startsWith('https://tools.example.org') === (serve === servers[1])) return r;
    }
    return reply(404, '');
  };
  const asked = [];
  const opened = [];
  let changes = 0;
  let n = 0;
  const svc = new McpConnections({
    db: new sqlite.DatabaseSync(':memory:'),
    fetch,
    confirm: async (q) => { asked.push(q); return answer; },
    openExternal: async (url) => { opened.push(url); },
    changed: () => { changes += 1; },
    newId: () => `c${++n}`,
  });
  return { svc, sent, state, urls, asked, opened, changes: () => changes };
}

test('names, addresses and modules as typed', () => {
  assert.equal(nameOf(' Kubrik '), 'kubrik');
  assert.equal(nameOf('timelogbook dev'), 'timelogbook-dev');
  assert.throws(() => nameOf('jenkins'), /app's own servers/);
  assert.throws(() => nameOf('a/b'), /letters, numbers and dashes/);
  assert.equal(addressOf('mcp.kubrik.io/'), 'https://mcp.kubrik.io');
  assert.equal(addressOf('http://localhost:8222/api/mcp/v1'), 'http://localhost:8222/api/mcp/v1');
  assert.throws(() => addressOf('http://mcp.kubrik.io'), /https/);
  assert.deepEqual(modulesOf('acc, CRM\noms acc'), ['acc', 'crm', 'oms']);
  assert.deepEqual(modulesOf(''), []);
  assert.throws(() => modulesOf('acc, ../x'), /not a module name/);
});

test('an answer is found in JSON or in an event stream', () => {
  assert.deepEqual(answerIn('{"jsonrpc":"2.0","id":3,"result":{"a":1}}', 'application/json', 3).result, { a: 1 });
  const stream = ': ping\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"b":2}}\n\n';
  assert.deepEqual(answerIn(stream, 'text/event-stream', 7).result, { b: 2 });
  assert.equal(answerIn('<html>', 'text/html', 1), null);
});

test('a modular connection is kept only once the token reaches something, and never shows the token', { skip }, async () => {
  const { svc, changes } = service();
  const bad = await svc.call('save', { name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc, crm', token: j('ko', 's_', 'Zz99Yy88', '_', 'y'.repeat(40)) });
  assert.match(bad.error, /refused the token/);
  assert.equal(svc.all().length, 0);
  const saved = await svc.call('save', { name: 'Kubrik', url: 'https://mcp.example.com', modules: 'acc, crm, hr', token: TOKEN });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(changes(), 1, 'the MCP config is written again');
  const view = await svc.call('inspect', { id: saved.id });
  assert.ok(!JSON.stringify(view).includes(TOKEN) && !JSON.stringify(svc.list()).includes(TOKEN), 'the panel never sees the token');
  assert.deepEqual(view.endpoints.map((e) => [e.module, e.reached]), [['acc', true], ['crm', true], ['hr', false]]);
  assert.equal(view.endpoints[2].why, 'not in this token');
  const names = view.endpoints.flatMap((e) => e.tools.map((t) => t.name));
  assert.deepEqual(names, ['acc_get_invoice', 'acc_create_invoice', 'acc_ask_agent', 'crm_find_customer', 'crm_ask_agent']);
  assert.equal(view.endpoints[0].instructions, 'Tools of acc.');
});

test('a tool renamed after its module goes to that module under its real name', { skip }, async () => {
  const { svc, sent } = service();
  const { id } = await svc.call('save', { name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc, crm', token: TOKEN });
  const r = await svc.call('run', { id, tool: 'crm_ask_agent', args: { question: 'who owes most?' } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(sent.at(-1), { module: 'crm', params: { name: 'ask_agent', arguments: { question: 'who owes most?' } } });
});

test('a server with sessions: initialize first, the session id after, an event stream understood, pages followed', { skip }, async () => {
  const { svc, state } = service();
  const saved = await svc.call('save', { name: 'docs', url: 'https://tools.example.org/mcp', token: '' });
  assert.equal(saved.ok, true, saved.error);
  const view = await svc.call('inspect', { id: saved.id });
  assert.deepEqual(view.endpoints[0].tools.map((t) => t.name), ['get_doc', 'search_docs']);
  const r = await svc.call('run', { id: saved.id, tool: 'get_doc', args: { id: 'D-1' } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data, { doc: 'D-1' }, 'structured content wins over text');
  assert.ok(state.seen.every((s) => /^sess-\d+$/.test(s.session) && s.protocol === '2025-03-26'));
  assert.ok(state.seen.some((s) => s.method === 'notifications/initialized'));
});

test('a session the server forgot is started again, once', { skip }, async () => {
  const { svc, state } = service();
  const { id } = await svc.call('save', { name: 'docs', url: 'https://tools.example.org/mcp' });
  await svc.call('inspect', { id });
  const before = state.sessions;
  state.live.clear();
  const r = await svc.call('run', { id, tool: 'get_doc', args: { id: 'D-2' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(state.sessions, before + 1);
});

test('a blank token keeps the saved one only at the same address', { skip }, async () => {
  const { svc, urls } = service();
  const { id } = await svc.call('save', { name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc', token: TOKEN });
  assert.equal((await svc.call('save', { id, name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc, crm', token: '' })).ok, true);
  const before = urls.length;
  const moved = await svc.call('save', { id, name: 'kubrik', url: 'https://elsewhere.example.com', modules: 'acc', token: '' });
  assert.match(moved.error, /new address needs the token/);
  assert.equal(urls.length, before, 'the saved token was sent nowhere new');
});

test('two connections cannot share a name', { skip }, async () => {
  const { svc } = service();
  await svc.call('save', { name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc', token: TOKEN });
  assert.match((await svc.call('save', { name: 'kubrik', url: 'https://tools.example.org/mcp' })).error, /already a connection called kubrik/);
});

test('a write asks the person first; a no sends nothing', { skip }, async () => {
  const { svc, sent, asked } = service({ answer: 'no' });
  const { id } = await svc.call('save', { name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc', token: TOKEN });
  const r = await svc.call('run', { id, tool: 'acc_create_invoice', args: { customer: 'C-1' } });
  assert.match(r.error, /said no/);
  assert.equal(asked.length, 1);
  assert.equal(sent.length, 0);
});

test('a proposal opens only on the connection’s own site', { skip }, async () => {
  const { svc, opened } = service({ answer: 'yes' });
  const { id } = await svc.call('save', { name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc', token: TOKEN });
  const r = await svc.call('run', { id, tool: 'acc_create_invoice', args: {} });
  assert.equal(r.data.status, 'proposal_pending');
  assert.equal((await svc.call('openLink', { id, url: r.data.confirmUrl })).ok, true);
  assert.match((await svc.call('openLink', { id, url: 'https://evil.example.net/example.com' })).error, /Only addresses on example\.com/);
  assert.match((await svc.call('openLink', { id, url: 'http://erp.example.com/x' })).error, /Only addresses/);
  assert.deepEqual(opened, ['https://erp.example.com/pending/p-1']);
});

test('sessions get a connection only once the person lets them, under its own name', { skip }, async () => {
  const { svc, changes } = service();
  const { id } = await svc.call('save', { name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc', token: TOKEN });
  const session = { id: 's1', name: 'work' };
  assert.deepEqual(svc.forSessions(), []);
  const off = await svc.handleSession({ connection: id, tool: '_available', session });
  assert.deepEqual(off.tools, []);
  assert.match(off.message, /Switch it on/);
  assert.equal((await svc.handleSession({ connection: id, tool: 'acc_get_invoice', args: {}, session })).ok, false);
  await svc.call('claudeSave', { id, on: true });
  assert.equal(changes(), 2);
  assert.deepEqual(svc.forSessions(), [{ id, name: 'kubrik' }]);
  const on = await svc.handleSession({ connection: id, tool: '_available', session });
  assert.ok(on.tools.some((t) => t.name === 'acc_ask_agent'));
  assert.equal(on.instructions, 'Tools of acc.');
  const r = await svc.handleSession({ connection: id, tool: 'acc_get_invoice', args: { number: 'F-1' }, session });
  assert.equal(r.ok, true, r.error);
  assert.equal((await svc.handleSession({ connection: 'gone', tool: '_available', session })).tools.length, 0);
});

test('a session is held to a rate per connection', { skip }, async () => {
  const { svc } = service();
  const { id } = await svc.call('save', { name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc', token: TOKEN, claude: true });
  const session = { id: 's2', name: 'loop' };
  let last;
  for (let i = 0; i < 41; i++) last = await svc.handleSession({ connection: id, tool: 'acc_get_invoice', args: {}, session });
  assert.equal(last.ok, false);
  assert.match(last.error, /Too many/);
});

test('removing a connection forgets its token and takes it from sessions', { skip }, async () => {
  const { svc } = service();
  const { id } = await svc.call('save', { name: 'kubrik', url: 'https://mcp.example.com', modules: 'acc', token: TOKEN, claude: true });
  assert.equal(svc.forSessions().length, 1);
  assert.equal((await svc.call('remove', { id })).ok, true);
  assert.equal(svc.get(id), null);
  assert.deepEqual(svc.forSessions(), []);
});
