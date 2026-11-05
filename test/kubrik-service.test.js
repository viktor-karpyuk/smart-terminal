'use strict';

/**
 * Kubrik OS through its external MCP gateway, against a fake of it.
 *
 * The fake answers the way `ExternalMcpGateway` does: one JSON answer per POST,
 * 401 for a key it does not know, 403 MODULE_NOT_IN_KEY for a module the key was
 * not made for, `ask_agent` and `kos_proposal_status` in every module, and a
 * write below Autonomous coming back as `proposal_pending` with a `confirmUrl`.
 *
 * Needs `node:sqlite` (Node 22+) for the service's tests and skips them without it.
 */

/** Key-shaped fixtures are built from pieces so no source line looks like a real secret to a scanner. */
const j = (...parts) => parts.join('');
const test = require('node:test');
const assert = require('node:assert');
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';
const { KubrikService } = require('../electron/kubrik-service');
const { apiBase, mcpUrl, siteOf } = require('../electron/key-mcp-service');

const KEY = j('ko', 's_', 'Ab12Cd34', '_', 'x'.repeat(40));

const ro = { readOnlyHint: true };
const shared = [
  { name: 'kos_proposal_status', description: 'Whether a proposal was confirmed.', inputSchema: { type: 'object' }, annotations: ro },
  { name: 'ask_agent', description: 'Ask the module agent.', inputSchema: { type: 'object' }, annotations: ro },
];
const TOOLS = {
  acc: [
    { name: 'acc_get_invoice', description: 'One invoice.', inputSchema: { type: 'object' }, annotations: ro },
    { name: 'acc_create_invoice', description: 'Creates an invoice.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: false } },
    ...shared,
  ],
  crm: [{ name: 'crm_find_customer', description: 'Find a customer.', inputSchema: { type: 'object' }, annotations: ro }, ...shared],
};

function fakeKubrik() {
  const sent = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, auth: init.headers.Authorization, body, signal: init.signal });
    const reply = (status, json) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(json) });
    const m = /^https:\/\/mcp\.kubrik\.io\/([a-z]+)$/.exec(url);
    if (!m) return reply(404, { code: 'UNKNOWN_SERVER', message: 'No such server.' });
    if (init.headers.Authorization !== `Bearer ${KEY}`) return reply(401, { error: 'Unauthorized' });
    if (!TOOLS[m[1]]) return reply(403, { code: 'MODULE_NOT_IN_KEY', message: `This API key does not include ${m[1].toUpperCase()}.` });
    if (body.method === 'tools/list') return reply(200, { jsonrpc: '2.0', id: body.id, result: { tools: TOOLS[m[1]] } });
    if (body.method === 'tools/call') {
      const out = body.params.name === 'acc_create_invoice'
        ? { status: 'proposal_pending', proposalId: 'p-1', confirmUrl: 'https://erp.kubrik.io/copilot/pending/p-1' }
        : { module: m[1], asked: body.params };
      return reply(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } });
    }
    return reply(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  };
  return { fetch, sent };
}

function service({ answer = 'yes' } = {}) {
  const fake = fakeKubrik();
  const asked = [];
  const opened = [];
  const svc = new KubrikService({
    db: new sqlite.DatabaseSync(':memory:'),
    fetch: fake.fetch,
    confirm: async (q) => { asked.push(q); return answer; },
    openExternal: async (url) => { opened.push(url); },
  });
  return { svc, fake, asked, opened };
}

test('kubrik addresses: the MCP host serves /<module>, the backend /api/mcp/v1/<module>', () => {
  assert.equal(apiBase('mcp.kubrik.io'), 'https://mcp.kubrik.io');
  assert.equal(apiBase('https://mcp.kubrik.io/acc'), 'https://mcp.kubrik.io');
  assert.equal(mcpUrl('https://mcp.kubrik.io', 'acc', '/mcp/v1'), 'https://mcp.kubrik.io/acc');
  assert.equal(apiBase('http://localhost:8222/api/mcp/v1/acc'), 'http://localhost:8222/api');
  assert.equal(mcpUrl('http://localhost:8222/api', 'acc', '/mcp/v1'), 'http://localhost:8222/api/mcp/v1/acc');
  assert.equal(siteOf('https://mcp.kubrik.io', 'erp', 'dev-erp'), 'https://erp.kubrik.io/');
  assert.equal(siteOf('https://dev-mcp.kubrik.io', 'erp', 'dev-erp'), 'https://dev-erp.kubrik.io/');
});

test('connecting finds the modules the key reaches, and a shared tool is named after its module', { skip }, async () => {
  const { svc } = service();
  const o = await svc.call('connect', { url: 'https://mcp.kubrik.io', key: KEY });
  assert.equal(o.ok, true, o.error);
  assert.deepEqual(o.apps.filter((a) => a.reached).map((a) => a.app), ['crm', 'acc']);
  assert.equal(o.apps.find((a) => a.app === 'hr').why, 'not in this key');
  assert.ok(!JSON.stringify(o).includes(KEY), 'the panel never sees the key');
  const names = o.apps.flatMap((a) => a.tools.map((t) => t.name));
  assert.deepEqual(names.filter((n) => /ask_agent|proposal_status/.test(n)).sort(),
    ['acc_ask_agent', 'acc_kos_proposal_status', 'crm_ask_agent', 'crm_kos_proposal_status']);
  assert.equal(new Set(names).size, names.length, 'every name means one server');
});

test('a renamed tool goes to its own module under its real name', { skip }, async () => {
  const { svc, fake } = service();
  await svc.call('connect', { url: 'https://mcp.kubrik.io', key: KEY });
  const r = await svc.call('run', { tool: 'crm_ask_agent', args: { question: 'who owes most?' } });
  assert.equal(r.ok, true, r.error);
  const last = fake.sent.at(-1);
  assert.equal(last.url, 'https://mcp.kubrik.io/crm');
  assert.deepEqual(last.body.params, { name: 'ask_agent', arguments: { question: 'who owes most?' } });
});

test('a key that is not a Kubrik key, or that Kubrik refuses, is not kept', { skip }, async () => {
  const { svc } = service();
  assert.match((await svc.call('connect', { url: 'https://mcp.kubrik.io', key: j('tl', 'bk_', 'Ab12Cd34', '_', 'x'.repeat(40)) })).error, /not a Kubrik OS API key/);
  assert.match((await svc.call('connect', { url: 'https://mcp.kubrik.io', key: j('ko', 's_', 'Zz99Yy88', '_', 'y'.repeat(40)) })).error, /refused the key/);
  assert.equal((await svc.call('overview')).connected, false);
});

test('a write asks the person first, and a proposal opens only on kubrik.io', { skip }, async () => {
  const { svc, asked, opened } = service({ answer: 'yes' });
  await svc.call('connect', { url: 'https://mcp.kubrik.io', key: KEY });
  const r = await svc.call('run', { tool: 'acc_create_invoice', args: { customer: 'C-1' } });
  assert.equal(asked.length, 1);
  assert.equal(r.data.status, 'proposal_pending');
  assert.equal((await svc.call('openLink', { url: r.data.confirmUrl })).ok, true);
  assert.deepEqual(opened, ['https://erp.kubrik.io/copilot/pending/p-1']);
  assert.match((await svc.call('openLink', { url: 'https://evil.example/kubrik.io' })).error, /Only addresses on kubrik\.io/);
  assert.match((await svc.call('openLink', { url: 'http://erp.kubrik.io/x' })).error, /Only addresses/);
  assert.equal(opened.length, 1);
});

test('sessions get the tools only once the person lets them', { skip }, async () => {
  const { svc } = service();
  const session = { id: 's1', name: 'work' };
  await svc.call('connect', { url: 'https://mcp.kubrik.io', key: KEY });
  assert.deepEqual((await svc.handleSession({ tool: '_available', session })).tools, []);
  await svc.call('claudeAccessSave', { on: true });
  const on = await svc.handleSession({ tool: '_available', session });
  assert.ok(on.tools.some((t) => t.name === 'acc_get_invoice'));
  const r = await svc.handleSession({ tool: 'acc_get_invoice', args: { number: 'F-1' }, session });
  assert.equal(r.ok, true);
  assert.match(r.text, /"module":"acc"/);
});
