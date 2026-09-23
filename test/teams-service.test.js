'use strict';

/**
 * The Teams extension end to end, against a network that is not there.
 *
 * What is being checked is the part that cannot be undone: a message that goes
 * out, or one that does not and should have. Every call the real thing would
 * make is answered here, so the rules, the outbox and the two ways of reaching
 * Teams are all exercised without anything leaving the machine.
 *
 * Needs `node:sqlite` (Node 22+) and skips itself without it.
 */

const test = require('node:test');
const assert = require('node:assert');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite needs Node 22 or newer';

const { TeamsService } = sqlite ? require('../electron/teams-service') : {};

/** A Wednesday at 10:00 — inside any working hours these tests set. */
const WEDNESDAY_10 = new Date('2026-09-23T10:00:00').getTime();

function setup({ at = WEDNESDAY_10, fail = null, known = ['b@kubrik.com', 'braian@kubrik.com', 'me@kubrik.com'] } = {}) {
  const knownSet = new Set(known.map((one) => one.toLowerCase()));
  const db = new sqlite.DatabaseSync(':memory:');
  const calls = [];
  const notices = [];
  let now = at;
  /*
   * A fake that refuses what the real thing refuses.
   *
   * The first version answered every request with yes, which is how a chat with
   * the same person in both seats — something Graph rejects outright — passed a
   * green suite and shipped unable to send a single message. A fake that cannot
   * say no tests the code around a call and not the call.
   */
  const fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : null });
    if (fail && fail(String(url))) return { ok: false, status: 500, json: async () => ({}) };
    if (String(url).includes('/oauth2/v2.0/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    if (String(url).includes('/v1.0/users/')) {
      const who = decodeURIComponent(String(url).split('/v1.0/users/')[1]);
      if (!knownSet.has(who.toLowerCase())) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: 'id-of-' + who }) };
    }
    if (String(url).endsWith('/v1.0/chats')) {
      const body = JSON.parse(init.body);
      const seats = (body.members || []).map((one) => one['user@odata.bind']);
      // Graph's own rule: a one-to-one chat is between two people.
      if (new Set(seats).size < 2) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'oneOnOne chat needs two distinct members' } }) };
      }
      return { ok: true, status: 201, json: async () => ({ id: 'chat-1' }) };
    }
    return { ok: true, status: 201, json: async () => ({ id: 'msg-1' }) };
  };
  const service = new TeamsService({
    db,
    secrets: { encrypt: (t) => `enc:${t}`, decrypt: (c) => c.replace(/^enc:/, '') },
    fetch,
    notify: (title, body) => notices.push(`${title} | ${body}`),
    now: () => now,
  });
  return { service, calls, notices, db, setNow: (value) => { now = value; } };
}

const graph = (service, sender = 'me@kubrik.com') =>
  service.saveConnection({ way: 'graph', tenantId: 't', clientId: 'c', clientSecret: 's', sender: sender });

const note = (extra = {}) => ({
  to: { handle: 'bitbucket:bchavez' },
  title: 'kubrik-pos-fe #43 is waiting on you',
  body: 'Two comments have had no answer for 6 days.',
  links: [{ text: 'Open the pull request', url: 'https://bitbucket.org/x/43' }],
  key: 'code-review:pr:43:unanswered',
  ...extra,
});

// ---------------------------------------------------------------- the contract

/*
 * The first time anything asks, it stops and shows you. A silent refusal
 * teaches nobody what wanted to speak, and a silent allow is how an extension
 * you have never heard of starts messaging your colleagues.
 */
test('the first time something asks, it waits for you', { skip }, async () => {
  const { service, calls, notices } = setup();
  graph(service);
  service.store.matchPerson('bitbucket:bchavez', 'b@kubrik.com');

  const out = await service.send('spring-boot', 'Spring Boot', note({ key: 'spring:down' }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.why, 'asks-first');
  assert.strictEqual(calls.length, 0, 'nothing went anywhere');
  assert.match(notices[0] ?? '', /Spring Boot wants to send/);

  const waiting = service.store.waiting();
  assert.strictEqual(waiting.length, 1);

  // Said yes, it goes — and the message it sends is the one that was waiting.
  const sent = await service.approve(waiting[0].id);
  assert.strictEqual(sent.ok, true);
  assert.strictEqual(service.store.message(waiting[0].id).state, 'SENT');
  assert.ok(calls.some((call) => call.url.endsWith('/messages')));
});

test('an extension that is allowed just sends', { skip }, async () => {
  const { service, calls } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  service.store.matchPerson('bitbucket:bchavez', 'b@kubrik.com');

  const out = await service.send('code-review', 'Code Reviewer', note());
  assert.strictEqual(out.ok, true, JSON.stringify(out));

  // Three calls and no way around them: the token, who they are, the chat, the message.
  assert.ok(calls.some((call) => call.url.includes('/oauth2/v2.0/token')));
  assert.ok(calls.some((call) => call.url.includes('/v1.0/users/b%40kubrik.com')));
  const message = calls.find((call) => call.url.endsWith('/messages'));
  assert.ok(message, 'the message itself');
  assert.match(message.body, /kubrik-pos-fe #43 is waiting on you/);
  assert.match(message.body, /Action\.OpenUrl/);
});

/*
 * The one that must never be a silent success. An extension told its message
 * went, when nobody could be found to send it to, quietly stops reminding
 * anybody while reporting that it has.
 */
test('a person nobody matched is refused by name', { skip }, async () => {
  const { service, calls } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');

  const out = await service.send('code-review', 'Code Reviewer', note({ to: { handle: 'bitbucket:mperano' } }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.why, 'no-address');
  assert.strictEqual(calls.length, 0);
  // And they are written down, so somebody can match them in the People screen.
  assert.ok(service.store.people().some((one) => one.handle === 'bitbucket:mperano'));
});

test('an address for a handle that is one is worked out on its own', { skip }, async () => {
  const { service } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  const out = await service.send('code-review', 'Code Reviewer', note({ to: { email: 'braian@kubrik.com' } }));
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(service.store.person('email:braian@kubrik.com').matchedBy, 'EMAIL');
});

// ---------------------------------------------------------------- what protects the person

test('the same key is never sent twice', { skip }, async () => {
  const { service, calls } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  service.store.matchPerson('bitbucket:bchavez', 'b@kubrik.com');
  service.saveSettings({ perPersonPerDay: 5 });

  assert.strictEqual((await service.send('code-review', 'Code Reviewer', note())).ok, true);
  const sentCalls = calls.length;

  const again = await service.send('code-review', 'Code Reviewer', note());
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.why, 'already-sent');
  assert.strictEqual(calls.length, sentCalls, 'nothing went out the second time');
  assert.strictEqual(service.store.message(again.id).state, 'HELD');
});

test('a person hears from us once a day, whoever asks', { skip }, async () => {
  const { service } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  service.store.setAppStance('spring-boot', 'ALLOW');
  service.store.matchPerson('bitbucket:bchavez', 'b@kubrik.com');

  assert.strictEqual((await service.send('code-review', 'Code Reviewer', note())).ok, true);
  const second = await service.send('spring-boot', 'Spring Boot', note({ key: 'spring:other' }));
  assert.strictEqual(second.why, 'person-cap');
});

test('out of hours it is held, not lost; urgent still goes', { skip }, async () => {
  const { service, setNow } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  service.store.matchPerson('bitbucket:bchavez', 'b@kubrik.com');
  setNow(new Date('2026-09-23T23:40:00').getTime());

  const held = await service.send('code-review', 'Code Reviewer', note());
  assert.strictEqual(held.why, 'quiet-hours');
  assert.strictEqual(service.store.message(held.id).state, 'HELD');

  const urgent = await service.send('code-review', 'Code Reviewer', note({ key: 'other', level: 'urgent' }));
  assert.strictEqual(urgent.ok, true, JSON.stringify(urgent));
});

test('an extension that has spent its day waits for tomorrow', { skip }, async () => {
  const { service } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  service.store.setAppCap('code-review', 1);
  service.saveSettings({ perPersonPerDay: 9 });
  service.store.matchPerson('bitbucket:bchavez', 'b@kubrik.com');

  assert.strictEqual((await service.send('code-review', 'Code Reviewer', note({ key: 'a' }))).ok, true);
  assert.strictEqual((await service.send('code-review', 'Code Reviewer', note({ key: 'b' }))).why, 'app-cap');
});

// ---------------------------------------------------------------- when it goes wrong

test('a failure is kept with its reason, and can be tried again', { skip }, async () => {
  let broken = true;
  const { service, calls } = setup({ fail: (url) => broken && url.endsWith('/messages') });
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  service.store.matchPerson('bitbucket:bchavez', 'b@kubrik.com');

  const out = await service.send('code-review', 'Code Reviewer', note());
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.why, 'failed');
  const row = service.store.message(out.id);
  assert.strictEqual(row.state, 'FAILED');
  assert.match(row.reason, /answered 500/);

  // A failed message was never said, so the same key is not held back by it.
  broken = false;
  const retried = await service.retry(out.id);
  assert.strictEqual(retried.ok, true);
  assert.strictEqual(service.store.message(out.id).state, 'SENT');
  assert.ok(calls.length >= 2);
});

test('a webhook is the other way in, and posts a card', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ way: 'webhook', webhookUrl: 'https://outlook.office.com/webhook/abc' });
  service.store.setAppStance('spring-boot', 'ALLOW');

  const out = await service.send('spring-boot', 'Spring Boot', {
    to: { channel: 'builds' },
    title: 'orders-api has been down for 2 minutes',
    links: [{ text: 'Open the dashboard', url: 'https://grafana.example/x' }],
    key: 'spring:orders-api:down',
  });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(calls.length, 1, 'one call: no sign-in, no lookup');
  assert.strictEqual(calls[0].url, 'https://outlook.office.com/webhook/abc');
  assert.match(calls[0].body, /adaptive/);
  assert.match(calls[0].body, /orders-api has been down/);
});

test('a webhook URL that is not https is refused before it is stored', { skip }, () => {
  const { service } = setup();
  assert.throws(() => service.saveConnection({ way: 'webhook', webhookUrl: 'http://inside/hook' }), /https/);
});

// ---------------------------------------------------------------- what a panel may see

/*
 * The panel draws this, and a panel is a frame with an origin of its own that
 * an extension wrote. A secret that reached it would be a secret on the wrong
 * side of the only wall there is.
 */
test('nothing a panel is given contains a secret', { skip }, async () => {
  const { service } = setup();
  service.saveConnection({ way: 'graph', tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'THE-SECRET', sender: 'me@kubrik.com' });
  service.saveConnection({ way: 'webhook', webhookUrl: 'https://outlook.office.com/webhook/SECRET-PATH' });

  const text = JSON.stringify(service.overview());
  assert.ok(!text.includes('THE-SECRET'), 'the client secret');
  assert.ok(!text.includes('SECRET-PATH'), 'the webhook URL');
  assert.ok(text.includes('tenant-1'), 'what is not a secret is still shown');
  assert.strictEqual(service.connection().hasGraph, true);
});

test('an empty secret means “leave it alone”, not “erase it”', { skip }, async () => {
  const { service } = setup();
  service.saveConnection({ way: 'graph', tenantId: 't', clientId: 'c', clientSecret: 's', sender: 'me@kubrik.com' });
  service.saveConnection({ way: 'graph', tenantId: 't2', clientId: 'c', clientSecret: '' });
  assert.strictEqual(service.connection().hasGraph, true, 'still set up');
  assert.strictEqual(service.connection().tenantId, 't2');
});

// ---------------------------------------------------------------- a chat has two people in it

/*
 * The bug this file shipped with. A one-to-one chat takes two members and an
 * app is not a person, so a direct message is between the person being told and
 * somebody it is from. The first version filled the second seat with the
 * recipient, and the fake it was tested against said yes to everything.
 */
test('a direct message is between two people, and names them both', { skip }, async () => {
  const { service, calls } = setup();
  graph(service, 'me@kubrik.com');
  service.store.setAppStance('code-review', 'ALLOW');
  service.store.matchPerson('bitbucket:bchavez', 'b@kubrik.com');

  const out = await service.send('code-review', 'Code Reviewer', note());
  assert.strictEqual(out.ok, true, JSON.stringify(out));

  const chat = calls.find((call) => call.url.endsWith('/v1.0/chats'));
  const seats = JSON.parse(chat.body).members.map((one) => one['user@odata.bind']);
  assert.strictEqual(seats.length, 2);
  assert.strictEqual(new Set(seats).size, 2, 'two distinct people, which is what Graph requires');
  assert.ok(seats.some((seat) => seat.includes('id-of-me@kubrik.com')), 'the one it is from');
  assert.ok(seats.some((seat) => seat.includes('id-of-b@kubrik.com')), 'the one being told');
});

test('an app registration with nobody to send from is not ready', { skip }, () => {
  const { service } = setup();
  service.saveConnection({ way: 'graph', tenantId: 't', clientId: 'c', clientSecret: 's' });
  assert.strictEqual(service.connection().ready, false, 'a green light in front of a failure is worse than a red one');
  service.saveConnection({ way: 'graph', sender: 'me@kubrik.com' });
  assert.strictEqual(service.connection().ready, true);
});

test('sending to the account it is sent from is refused in words', { skip }, async () => {
  const { service } = setup();
  graph(service, 'me@kubrik.com');
  service.store.setAppStance('code-review', 'ALLOW');
  service.store.matchPerson('bitbucket:bchavez', 'me@kubrik.com');

  const out = await service.send('code-review', 'Code Reviewer', note());
  assert.strictEqual(out.ok, false);
  assert.match(out.detail, /cannot be sent to me@kubrik.com/);
});

test('somebody Teams has never heard of is said by name', { skip }, async () => {
  const { service } = setup({ known: ['me@kubrik.com'] });
  graph(service, 'me@kubrik.com');
  service.store.setAppStance('code-review', 'ALLOW');
  service.store.matchPerson('bitbucket:bchavez', 'gone@kubrik.com');

  const out = await service.send('code-review', 'Code Reviewer', note());
  assert.strictEqual(out.ok, false);
  assert.match(out.detail, /Teams has nobody at gone@kubrik.com/);
});

/*
 * A choice outranks a guess.
 *
 * Sending works an address out of the handle when it can, and that guess used
 * to be written straight over one somebody had picked by hand in the People
 * screen — while the row went on saying it was matched by you. Mail then went
 * to whoever the handle happened to spell.
 */
test('an address chosen by hand is not overwritten by a guess', { skip }, () => {
  const { service } = setup();
  const store = service.store;
  store.rememberPerson({ handle: 'bitbucket:bchavez', display: 'Braian', address: 'braian@kubrik.com', matchedBy: 'HAND' });
  store.rememberPerson({ handle: 'bitbucket:bchavez', address: 'bchavez@kubrik.com', matchedBy: 'GUESS' });
  const person = store.person('bitbucket:bchavez');
  assert.strictEqual(person.address, 'braian@kubrik.com', 'the hand-made match stands');
  assert.strictEqual(person.matchedBy, 'HAND');
});

test('a guess still fills an address nobody has chosen', { skip }, () => {
  const { service } = setup();
  const store = service.store;
  store.rememberPerson({ handle: 'bitbucket:nobody', display: 'Nobody' });
  store.rememberPerson({ handle: 'bitbucket:nobody', address: 'nobody@kubrik.com', matchedBy: 'GUESS' });
  const person = store.person('bitbucket:nobody');
  assert.strictEqual(person.address, 'nobody@kubrik.com');
  assert.strictEqual(person.matchedBy, 'GUESS');
});

test('a hand-made match can still be changed by hand', { skip }, () => {
  const { service } = setup();
  const store = service.store;
  store.rememberPerson({ handle: 'bitbucket:bchavez', address: 'old@kubrik.com', matchedBy: 'HAND' });
  store.matchPerson('bitbucket:bchavez', 'new@kubrik.com');
  const person = store.person('bitbucket:bchavez');
  assert.strictEqual(person.address, 'new@kubrik.com', 'the People screen still decides');
  assert.strictEqual(person.matchedBy, 'HAND');
});
