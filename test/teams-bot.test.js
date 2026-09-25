'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const brain = require('../electron/teams-bot-brain');
const { TeamsBot, NoRoute, parseQueue } = require('../electron/teams-bot');

const NOW = Date.parse('2026-09-25T15:00:00Z');
const SERVICE = 'https://smba.trafficmanager.net/amer/';
const MATEO = { aad: 'aad-mateo', id: '29:mateo', email: 'mateo@kubrik.com', name: 'Mateo' };
const SANTI = { aad: 'aad-santi', id: '29:santi', email: 'santi@kubrik.com', name: 'Santiago' };

// ── the brain ───────────────────────────────────────────────────────────────
test('buttons are read exactly; words only when they are one of the few it knows', () => {
  const about = { repoId: 'r1', prId: 43 };
  assert.deepEqual(
    brain.readCommand({ value: { action: 'fix', repoId: 'r1', prId: '43', findingId: 'f1' } }),
    { action: 'fix', repoId: 'r1', prId: 43, findingId: 'f1', days: 1, from: 'button' },
  );
  assert.equal(brain.readCommand({ text: '<at>Code Reviewer</at> volvé a revisar' }, about).action, 'rereview');
  assert.equal(brain.readCommand({ text: 'posponelo 30 dias' }, about).days, 7, 'at most a week');
  assert.equal(brain.readCommand({ text: 'arreglalo' }, about).action, 'findings', 'words never pick a finding to fix');
  assert.equal(brain.readCommand({ text: 'borrá la rama' }, about).action, 'unknown');
  assert.equal(brain.readCommand({ value: { action: 'merge' }, text: '' }), null, 'a button for something not allowed is nothing');
});

test('only the author, joined through the Teams people list, counts as the author', () => {
  const people = [{ handle: 'bitbucket:Mateo Perano', address: 'mateo@kubrik.com' }];
  assert.equal(brain.isAuthor({ senderAddress: 'MATEO@kubrik.com', people, provider: 'Bitbucket', author: 'Mateo Perano' }), true);
  assert.equal(brain.isAuthor({ senderAddress: 'santi@kubrik.com', people, provider: 'bitbucket', author: 'Mateo Perano' }), false);
  assert.equal(brain.isAuthor({ senderAddress: 'mateo@kubrik.com', people, provider: 'github', author: 'Mateo Perano' }), false);
  assert.equal(brain.isAuthor({ senderAddress: null, people, provider: 'bitbucket', author: 'Mateo Perano' }), false);
});

test('there is a ceiling on fixes and reviews per pull request per day', () => {
  const counts = {};
  const key = { conversation: 'c', pr: 'r1#43', action: 'fix' };
  for (let i = 0; i < brain.CAPS.fixesPerPr; i += 1) {
    assert.equal(brain.withinCaps(counts, key, NOW), null);
    brain.countIn(counts, key, NOW);
  }
  assert.match(brain.withinCaps(counts, key, NOW), /arreglos/);
  assert.equal(brain.withinCaps(counts, key, NOW + 24 * 3600 * 1000), null, 'a new day starts over');
});

// ── the bot, against fakes that say no when the real thing would ────────────
function world({ pr = { id: 43, title: 'Add totals', author: 'Mateo Perano', sourceBranch: 'feature/totals' } } = {}) {
  const settings = new Map();
  const secrets = new Map();
  const store = {
    setting: (k, d) => (settings.has(k) ? settings.get(k) : d),
    setSetting: (k, v) => settings.set(k, v),
    secret: (k) => secrets.get(k) ?? null,
    setSecret: (k, v) => secrets.set(k, v),
    people: () => [{ handle: 'bitbucket:Mateo Perano', address: MATEO.email }, { handle: 'bitbucket:Santiago', address: SANTI.email }],
  };
  const queue = [];
  const sent = [];
  const deleted = [];
  const verbs = [];
  const findings = [
    { id: 'f1', title: 'Null check missing', path: 'a.js', line: 3 },
    { id: 'f2', title: 'Already closed', closedAt: '2026-09-20' },
  ];
  const review = {
    async call(name, args) {
      verbs.push([name, args]);
      if (name === 'pr') return args.repoId === 'r1' && args.prId === 43 ? { ok: true, repo: { id: 'r1', provider: 'bitbucket' }, pr, findings } : { ok: false, error: 'gone' };
      if (name === 'fix') return { ok: true, fix: { id: 'x1', state: 'COMMITTED', sha: 'abcdef1234567' } };
      if (name === 'giveBack' || name === 'push' || name === 'closeFinding' || name === 'review') return { ok: true };
      return { ok: false, error: `unexpected ${name}` };
    },
  };
  const fetch = async (url, init = {}) => {
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
    if (url.includes('/oauth2/v2.0/token')) {
      assert.match(String(init.body), /scope=https%3A%2F%2Fapi.botframework.com%2F.default/);
      return reply(200, { access_token: 'tok', expires_in: 3600 });
    }
    if (url.startsWith('https://acct.queue.core.windows.net/teams-inbound/messages')) {
      assert.match(url, /sv=2021/, 'every queue call carries its key');
      if (init.method === 'DELETE') { deleted.push(url); return reply(204, ''); }
      const xml = queue.splice(0).map((m, i) => `<QueueMessage><MessageId>m${i}</MessageId><PopReceipt>p${i}</PopReceipt><DequeueCount>1</DequeueCount><MessageText>${Buffer.from(JSON.stringify({ activity: m })).toString('base64')}</MessageText></QueueMessage>`).join('');
      return reply(200, `<QueueMessagesList>${xml}</QueueMessagesList>`);
    }
    if (url.startsWith(SERVICE.replace(/\/$/, ''))) {
      assert.equal(init.headers?.authorization, 'Bearer tok');
      const member = /\/members\/([^/]+)$/.exec(url);
      if (member) {
        const who = [MATEO, SANTI].find((p) => p.id === decodeURIComponent(member[1]));
        return who ? reply(200, { id: who.id, email: who.email, name: who.name }) : reply(404, {});
      }
      if (init.method === 'POST') { sent.push({ url, body: JSON.parse(init.body) }); return reply(201, { id: 'a1' }); }
    }
    return reply(404, {});
  };
  const bot = new TeamsBot({ store, review, fetch, now: () => NOW });
  bot.save({ tenantId: 't1', appId: 'app1', secret: 's3cret', queueUrl: 'https://acct.queue.core.windows.net/teams-inbound', queueSas: '?sv=2021-12-02&sig=x' });
  bot.stop();
  const from = (who, over = {}) => ({
    type: 'message', id: `act-${Math.random()}`, serviceUrl: SERVICE, channelId: 'msteams',
    from: { id: who.id, aadObjectId: who.aad, name: who.name },
    conversation: { id: `a:${who.aad}`, conversationType: 'personal', tenantId: 't1' }, ...over,
  });
  const texts = () => sent.map((s) => s.body.text ?? '[card]');
  return { bot, queue, sent, deleted, verbs, from, texts, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

test('installing the bot is when it learns how to write to somebody first', async () => {
  const w = world();
  assert.equal(w.bot.canReach(MATEO.email), false);
  w.queue.push(w.from(MATEO, { type: 'conversationUpdate', membersAdded: [{ id: MATEO.id }] }));
  assert.equal(await w.bot.tick(), 1);
  assert.equal(w.deleted.length, 1, 'handled messages leave the queue');
  assert.equal(w.bot.canReach(MATEO.email), true);
  await assert.rejects(w.bot.sendTo(SANTI.email, { title: 'x', facts: [], links: [] }), NoRoute);
});

test('a reminder from the bot carries buttons about its pull request, and words then mean that one', async () => {
  const w = world();
  w.queue.push(w.from(MATEO, { type: 'conversationUpdate' }));
  await w.bot.tick();
  await w.bot.sendTo(MATEO.email, { title: 'Waiting on you', body: '', facts: [], links: [], about: { repoId: 'r1', prId: 43 } });
  const card = w.sent.at(-1).body.attachments[0].content;
  assert.deepEqual(card.actions.filter((a) => a.type === 'Action.Submit').map((a) => a.data.action), ['findings', 'rereview', 'snooze']);
  assert.ok(card.actions.every((a) => a.type !== 'Action.Submit' || (a.data.repoId === 'r1' && a.data.prId === 43)));

  w.queue.push(w.from(MATEO, { text: 'posponer 2' }));
  await w.bot.tick();
  assert.equal(w.bot.snoozed('r1', 43), true);
  assert.match(w.texts().at(-1), /no te recuerdo nada de #43/);
});

test('somebody who is not the author is told so, and nothing happens', async () => {
  const w = world();
  w.queue.push(w.from(SANTI, { text: '', value: { action: 'fix', repoId: 'r1', prId: 43, findingId: 'f1' } }));
  await w.bot.tick();
  assert.match(w.texts().at(-1), /sólo el autor del PR #43/);
  assert.deepEqual(w.verbs.map(([name]) => name), ['pr']);
});

test('fix and push: fixed in the workshop, handed back, pushed, and reported with the commit', async () => {
  const w = world();
  w.queue.push(w.from(MATEO, { text: '', value: { action: 'fix', repoId: 'r1', prId: 43, findingId: 'f1' } }));
  await w.bot.tick();
  await w.settle();
  assert.deepEqual(w.verbs.map(([name]) => name), ['pr', 'fix', 'giveBack', 'push']);
  assert.deepEqual(w.verbs[2][1], { repoId: 'r1', prId: 43, upToFixId: 'x1' }, 'hands back exactly the fix it made');
  assert.match(w.texts()[0], /Arreglo \*\*Null check missing\*\*/);
  assert.match(w.texts().at(-1), /Subí el arreglo.*feature\/totals.*abcdef12/);
});

test('a finding that is not in that pull request is refused, whatever the button says', async () => {
  const w = world();
  w.queue.push(w.from(MATEO, { text: '', value: { action: 'resolve', repoId: 'r1', prId: 43, findingId: 'f-from-another-pr' } }));
  await w.bot.tick();
  assert.match(w.texts().at(-1), /ya no está en este PR/);
  assert.ok(!w.verbs.some(([name]) => name === 'closeFinding'));
});

test('asking for the findings lists only the open ones, each with its two buttons', async () => {
  const w = world();
  w.queue.push(w.from(MATEO, { text: 'hallazgos' }));
  w.queue.push(w.from(MATEO, { text: '', value: { action: 'findings', repoId: 'r1', prId: 43 } }));
  await w.bot.tick();
  assert.match(w.texts()[0], /Sobre qué PR/, 'words with nothing to be about ask which');
  const card = w.sent.at(-1).body.attachments[0].content;
  const containers = card.body.filter((b) => b.type === 'Container');
  assert.equal(containers.length, 1);
  assert.deepEqual(containers[0].items.at(-1).actions.map((a) => a.data.action), ['fix', 'resolve']);
});

test('the queue XML is read as the Queue service writes it', () => {
  const [m] = parseQueue('<QueueMessagesList><QueueMessage><MessageId>a</MessageId><PopReceipt>b&amp;c</PopReceipt><DequeueCount>3</DequeueCount><MessageText>e30=</MessageText></QueueMessage></QueueMessagesList>');
  assert.deepEqual(m, { id: 'a', popReceipt: 'b&c', text: 'e30=', dequeueCount: 3 });
});

// ── the Teams service: who speaks, and who may say what ─────────────────────
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }

test('your own words go from your account; the app\'s go as the bot; an extension cannot claim either', { skip: sqlite ? false : 'node:sqlite needs Node 22 or newer' }, async () => {
  const { TeamsService } = require('../electron/teams-service');
  const graph = [];
  const fetch = async (url, init = {}) => {
    graph.push(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes('/oauth2/')) return ok({ access_token: 't', expires_in: 3600 });
    if (url.includes('/users/')) return ok({ id: url.split('/users/')[1] });
    if (url.endsWith('/chats')) return ok({ id: 'chat1' });
    return ok({});
  };
  const service = new TeamsService({ db: new sqlite.DatabaseSync(':memory:'), secrets: { encrypt: (t) => t, decrypt: (t) => t }, fetch, now: () => Date.parse('2026-09-23T10:00:00') });
  service.saveConnection({ way: 'graph', tenantId: 't', clientId: 'c', clientSecret: 's', sender: 'viktor@kubrik.com' });
  service.store.matchPerson('bitbucket:mateo perano', MATEO.email);
  service.store.matchPerson('bitbucket:santiago', SANTI.email);
  const viaBot = [];
  service.setBot({ ready: () => true, state: () => ({}), canReach: () => true, sendTo: async (address, message) => { viaBot.push(message); return { ok: true, how: 'bot' }; } });
  service.store.setAppStance('code-review', 'ALLOW');
  const to = { handle: 'bitbucket:Mateo Perano', display: 'Mateo' };

  const first = await service.send('code-review', 'Code Reviewer', { to, title: 'Reminder', key: 'k1', level: 'urgent', about: { repoId: 'r1', prId: 43 } });
  assert.equal(viaBot.length, 1, JSON.stringify(first));
  assert.deepEqual(viaBot[0].about, { repoId: 'r1', prId: 43 });

  const graphBefore = graph.length;
  // Somebody else: one message per person per day holds whatever comes second.
  const mine = await service.send('code-review', 'Code Reviewer', { to: { handle: 'bitbucket:Santiago', display: 'Santiago' }, title: 'From me', key: 'k2', level: 'urgent', voice: 'me' });
  assert.equal(viaBot.length, 1, 'you speaking never goes through the bot');
  assert.ok(graph.length > graphBefore, `it went through Graph, from your account: ${JSON.stringify(mine)}`);

  service.store.setAppStance('some-extension', 'ALLOW');
  service.store.matchPerson('bitbucket:tercero', 'tercero@kubrik.com');
  const theirs = await service.send('some-extension', 'Some extension', { to: { handle: 'bitbucket:tercero' }, title: 'Hi', key: 'k3', level: 'urgent', voice: 'me', about: { repoId: 'r1', prId: 43 } });
  assert.equal(theirs.ok, true, JSON.stringify(theirs));
  const last = viaBot.at(-1);
  assert.equal(last.title, 'Hi', 'it went, and through the bot, because it did not get to speak as you');
  assert.equal(last.about, null, 'no buttons that act on a PR from an extension');
  assert.equal(last.voice, null);
});
