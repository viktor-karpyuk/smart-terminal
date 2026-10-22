'use strict';

/**
 * Timelogbook through its agent door, against a fake of it.
 *
 * The fake answers JSON-RPC the way Timelogbook's `GateMcp` does — one JSON
 * answer per POST, 401 for a key it does not know, 403 APP_NOT_IN_KEY for an
 * app the key was not made for — and records what it was sent, so "the key
 * goes only as a Bearer to the saved address" is observed, not assumed.
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
const { TimelogbookService, apiBase, appOf } = require('../electron/timelogbook-service');

const KEY = j('tl', 'bk_', 'Ab12Cd34', '_', 'x'.repeat(40));
const OTHER = j('tl', 'bk_', 'Zz99Yy88', '_', 'y'.repeat(40));

const TOOLS = {
  me: [
    { name: 'me_search_my_tasks', title: 'Search my tasks', description: 'The caller tasks', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'me_get_task', title: 'Get task', description: 'One task', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ],
  tasks: [
    { name: 'tasks_get_task', title: 'Get task', description: 'A project task', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'tasks_move_task', title: 'Move task', description: 'Moves it', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  ],
};

function fakeTimelogbook({ keys = { [KEY]: ['me', 'tasks'] } } = {}) {
  const sent = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, auth: init.headers.Authorization, body });
    const m = /\/api\/agent\/mcp\/v1\/([a-z]+)$/.exec(url);
    const reply = (status, json) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(json) });
    if (!m) return reply(404, { code: 'NOT_FOUND', message: 'No such app.' });
    const key = String(init.headers.Authorization).replace(/^Bearer /, '');
    if (!keys[key]) return reply(401, { code: 'UNAUTHENTICATED', message: 'Unknown key.' });
    const app = m[1];
    if (!keys[key].includes(app)) return reply(403, { code: 'APP_NOT_IN_KEY', message: `This key has no access to ${app}.` });
    if (body.method === 'tools/list') return reply(200, { jsonrpc: '2.0', id: body.id, result: { tools: TOOLS[app] ?? [] } });
    if (body.method === 'tools/call') {
      const out = { items: [{ key: 'KBK-12', title: 'Fix the login' }], page: { totalElements: 1, hasMore: false }, asked: body.params };
      return reply(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } });
    }
    return reply(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  };
  return { fetch, sent };
}

function service(options = {}) {
  const fake = fakeTimelogbook(options);
  const asked = [];
  const svc = new TimelogbookService({
    db: new sqlite.DatabaseSync(':memory:'),
    fetch: fake.fetch,
    confirm: async (q) => { asked.push(q); return options.answer ?? 'no'; },
  });
  return { svc, fake, asked };
}

test('the address is the API base whatever was pasted', () => {
  assert.equal(apiBase('app.timelogbook.com'), 'https://app.timelogbook.com/api');
  assert.equal(apiBase('https://app.timelogbook.com/'), 'https://app.timelogbook.com/api');
  assert.equal(apiBase('https://app.timelogbook.com/api'), 'https://app.timelogbook.com/api');
  assert.equal(apiBase('https://app.timelogbook.com/api/agent/mcp/v1/tasks'), 'https://app.timelogbook.com/api');
  assert.equal(apiBase('http://localhost:8090'), 'http://localhost:8090/api');
  assert.throws(() => apiBase('http://app.timelogbook.com'), /https/);
  assert.throws(() => apiBase('ftp://x'), /https/);
  assert.throws(() => apiBase(''), /address/);
});

test('a tool belongs to the app its name starts with', () => {
  assert.equal(appOf('tasks_get_board'), 'tasks');
  assert.equal(appOf('me_get_week'), 'me');
  assert.equal(appOf('home_anything'), null);
  assert.equal(appOf('../x'), null);
});

test('connecting finds what the key reaches and keeps only a key that works', { skip }, async () => {
  const { svc, fake } = service();
  const bad = await svc.call('connect', { url: 'https://tlb.example', key: OTHER });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /refused the key/);
  assert.equal((await svc.call('overview')).connected, false, 'a refused key is not kept');

  const shape = await svc.call('connect', { url: 'https://tlb.example', key: 'not-a-key' });
  assert.match(shape.error, /not a Timelogbook API key/);

  const o = await svc.call('connect', { url: 'https://tlb.example/api/agent/mcp/v1/me', key: KEY });
  assert.equal(o.ok, true);
  assert.equal(o.connected, true);
  assert.equal(o.base, 'https://tlb.example/api');
  assert.equal(o.keyHint, j('tl', 'bk_', 'Ab12Cd34_…'));
  assert.ok(!JSON.stringify(o).includes(KEY), 'the panel never sees the key');
  assert.deepEqual(o.apps.filter((a) => a.reached).map((a) => a.app), ['me', 'tasks']);
  assert.equal(o.apps.find((a) => a.app === 'crm').why, 'not in this key');
  // Every request carried the key as a Bearer, to the address that was typed.
  for (const s of fake.sent) assert.ok(s.url.startsWith('https://tlb.example/api/agent/mcp/v1/') || s.url.startsWith('https://tlb.example/api/'), s.url);
  assert.ok(fake.sent.filter((s) => s.url.startsWith('https://tlb.example/')).every((s) => s.auth === `Bearer ${KEY}` || s.auth === `Bearer ${OTHER}`));
});

test('a key for none of the apps says so once', { skip }, async () => {
  const { svc } = service({ keys: { [KEY]: [] } });
  const r = await svc.call('connect', { url: 'https://tlb.example', key: KEY });
  assert.equal(r.ok, false);
  assert.match(r.error, /reaches none of the apps/);
});

test('a blank key keeps the saved one only at the same address', { skip }, async () => {
  const { svc } = service();
  await svc.call('connect', { url: 'https://tlb.example', key: KEY });
  assert.equal((await svc.call('connect', { url: 'https://tlb.example/api', key: '' })).ok, true);
  const moved = await svc.call('connect', { url: 'https://elsewhere.example', key: '' });
  assert.match(moved.error, /new address needs the key/);
});

test('a read-only tool runs; one that changes things waits for a person', { skip }, async () => {
  const { svc, fake, asked } = service({ answer: 'no' });
  await svc.call('connect', { url: 'https://tlb.example', key: KEY });
  const r = await svc.call('run', { tool: 'me_search_my_tasks', args: { q: 'login' } });
  assert.equal(r.ok, true);
  assert.equal(r.data.items[0].key, 'KBK-12');
  assert.deepEqual(r.data.asked, { name: 'me_search_my_tasks', arguments: { q: 'login' } });
  assert.equal(asked.length, 0);

  const calls = fake.sent.length;
  const refused = await svc.call('run', { tool: 'tasks_move_task', args: { key: 'KBK-12' } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /said no/);
  assert.equal(asked.length, 1);
  assert.equal(fake.sent.length, calls, 'nothing was sent after a no');

  const unknown = await svc.call('run', { tool: 'crm_search_leads', args: {} });
  assert.match(unknown.error, /cannot use/);
});

test('sessions get nothing until the person lets them, then exactly what the key reaches', { skip }, async () => {
  const { svc } = service();
  const session = { id: 's1', name: 'work' };
  assert.deepEqual((await svc.handleSession({ tool: '_available', session })).tools, []);
  await svc.call('connect', { url: 'https://tlb.example', key: KEY });
  const off = await svc.handleSession({ tool: '_available', session });
  assert.deepEqual(off.tools, []);
  assert.match(off.message, /Switch it on/);
  assert.equal((await svc.handleSession({ tool: 'me_search_my_tasks', args: {}, session })).ok, false);

  await svc.call('claudeAccessSave', { on: true });
  const on = await svc.handleSession({ tool: '_available', session });
  assert.deepEqual(on.tools.map((t) => t.name), ['me_search_my_tasks', 'me_get_task', 'tasks_get_task', 'tasks_move_task']);
  const r = await svc.handleSession({ tool: 'me_search_my_tasks', args: { q: 'x' }, session });
  assert.equal(r.ok, true);
  assert.match(r.text, /KBK-12/);
});

test('a session is held to a rate', { skip }, async () => {
  const { svc } = service();
  await svc.call('connect', { url: 'https://tlb.example', key: KEY });
  await svc.call('claudeAccessSave', { on: true });
  const session = { id: 's2', name: 'loop' };
  let last;
  for (let i = 0; i < 41; i++) last = await svc.handleSession({ tool: 'me_get_task', args: {}, session });
  assert.equal(last.ok, false);
  assert.match(last.error, /Too many/);
});

test('a brief reads the task from the app it belongs to', { skip }, async () => {
  const { svc, fake } = service();
  await svc.call('connect', { url: 'https://tlb.example', key: KEY });
  const b = await svc.call('brief', { key: 'KBK-12', title: 'Fix the login' });
  assert.equal(b.ok, true);
  assert.match(b.text, /KBK-12 — Fix the login/);
  assert.match(b.text, /tasks_get_task/);
  assert.equal(fake.sent.at(-1).body.params.name, 'tasks_get_task');
  await svc.call('brief', { key: 'T-7' });
  assert.equal(fake.sent.at(-1).body.params.name, 'me_get_task');
});

test('disconnecting forgets the key', { skip }, async () => {
  const { svc } = service();
  await svc.call('connect', { url: 'https://tlb.example', key: KEY });
  await svc.call('disconnect');
  assert.equal(svc.connection(), null);
  assert.equal((await svc.call('overview')).connected, false);
});
