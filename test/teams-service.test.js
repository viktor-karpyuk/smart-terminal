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
  const pollAnswers = [];
  const timers = [];
  const opened = [];
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
    if (String(url).endsWith('/oauth2/v2.0/devicecode')) {
      return { ok: true, status: 200, json: async () => ({ device_code: 'dc', user_code: 'ABC123', verification_uri: 'https://microsoft.com/devicelogin', interval: 5, expires_in: 900 }) };
    }
    if (String(url).includes('/oauth2/v2.0/token')) {
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === 'revoked') {
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'AADSTS70008: expired' }) };
      }
      if (body.get('device_code') === 'dc' && pollAnswers.length) {
        const answer = pollAnswers.shift();
        return { ok: !answer.error, status: answer.error ? 400 : 200, json: async () => answer };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', refresh_token: 'r2', expires_in: 3600 }) };
    }
    if (String(url).endsWith('/v1.0/me')) {
      return { ok: true, status: 200, json: async () => ({ id: 'id-of-me@kubrik.com', displayName: 'Me Myself', userPrincipalName: 'me@kubrik.com' }) };
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
    openExternal: (url) => opened.push(url),
    later: (fn) => timers.push(fn),
  });
  return { service, calls, notices, db, pollAnswers, timers, opened, setNow: (value) => { now = value; } };
}

/** Signed in, as far as anything after signing in can tell. */
const graph = (service, address = 'me@kubrik.com') => {
  service.saveConnection({ tenantId: 't', clientId: 'c' });
  service.store.setSecret('graph.refreshToken', 'r1');
  service.store.setSetting('graph.me.name', 'Me Myself');
  service.store.setSetting('graph.me.address', address);
};

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
  service.saveConnection({ webhookUrl: 'https://outlook.office.com/webhook/abc' });
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
  assert.throws(() => service.saveConnection({ webhookUrl: 'http://inside/hook' }), /https/);
});

// ---------------------------------------------------------------- what a panel may see

/*
 * The panel draws this, and a panel is a frame with an origin of its own that
 * an extension wrote. A secret that reached it would be a secret on the wrong
 * side of the only wall there is.
 */
test('nothing a panel is given contains a secret', { skip }, async () => {
  const { service } = setup();
  service.saveConnection({ tenantId: 'tenant-1', clientId: 'client-1' });
  service.store.setSecret('graph.refreshToken', 'THE-SECRET');
  service.saveConnection({ webhookUrl: 'https://outlook.office.com/webhook/SECRET-PATH' });

  const text = JSON.stringify(service.overview());
  assert.ok(!text.includes('THE-SECRET'), 'the sign-in');
  assert.ok(!text.includes('SECRET-PATH'), 'the webhook URL');
  assert.ok(text.includes('tenant-1'), 'what is not a secret is still shown');
  assert.strictEqual(service.connection().hasGraph, true);
});

test('an empty box means “leave it alone”, not “erase it”', { skip }, async () => {
  const { service } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.saveConnection({ webhookUrl: '' });
  assert.strictEqual(service.connection().hasWebhook, true, 'still set up');
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

test('a registration with nobody signed in is not ready', { skip }, () => {
  const { service } = setup();
  service.saveConnection({ tenantId: 't', clientId: 'c' });
  assert.strictEqual(service.connection().person.ready, false, 'a green light in front of a failure is worse than a red one');
  graph(service);
  assert.strictEqual(service.connection().person.ready, true);
  assert.deepEqual(service.connection().signedInAs, { name: 'Me Myself', address: 'me@kubrik.com' });
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

// ------------------------------------------------- what the hours held back

/*
 * "Anything raised outside these hours waits for the morning rather than being
 * dropped" is what the screen says, and nothing kept it: HELD was written in one
 * place and read by nobody, so the morning never came. No button, no sweep, no
 * way back — the message simply stopped existing as far as anyone could tell.
 */
test('a message held outside the hours goes out when they open', { skip }, async () => {
  const { service, calls, setNow } = setup({ at: new Date('2026-09-23T23:40:00').getTime() });
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.saveSettings({ hoursFrom: 9, hoursTo: 18, weekdaysOnly: true, perPersonPerDay: 5, dedupeDays: 7 });
  service.store.setAppStance('code-review', 'ALLOW');

  const held = await service.send('code-review', 'Code Reviewer', { to: { channel: 'reviews' }, title: 'PR #43 is waiting on you', body: 'x', key: 'k1' });
  assert.equal(held.why, 'quiet-hours');
  assert.equal(calls.length, 0, 'nothing went out at twenty to midnight');

  setNow(new Date('2026-09-24T09:30:00').getTime());
  const out = await service.releaseHeld();
  assert.deepEqual(out.map((one) => one.ok), [true]);
  assert.equal(calls.length, 1, 'and it went out in the morning');
  assert.equal(service.store.message(held.id).state, 'SENT');
});

test('still outside the hours means it keeps waiting, not that it is dropped', { skip }, async () => {
  const { service, calls, setNow } = setup({ at: new Date('2026-09-23T23:40:00').getTime() });
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.saveSettings({ hoursFrom: 9, hoursTo: 18, weekdaysOnly: true, perPersonPerDay: 5, dedupeDays: 7 });
  service.store.setAppStance('code-review', 'ALLOW');
  const held = await service.send('code-review', 'Code Reviewer', { to: { channel: 'reviews' }, title: 'later', body: 'x', key: 'k2' });

  setNow(new Date('2026-09-24T03:00:00').getTime());
  assert.deepEqual(await service.releaseHeld(), []);
  assert.equal(calls.length, 0);
  assert.equal(service.store.message(held.id).state, 'HELD');
});

/*
 * A hold is not a queue that keeps for ever. Something worth saying at 23:40 is
 * worth saying at 09:00; the same thing three days later is only noise.
 */
test('a message held for more than a day is let go of, and says so', { skip }, async () => {
  const { service, calls, setNow } = setup({ at: new Date('2026-09-23T23:40:00').getTime() });
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.saveSettings({ hoursFrom: 9, hoursTo: 18, weekdaysOnly: true, perPersonPerDay: 5, dedupeDays: 7 });
  service.store.setAppStance('code-review', 'ALLOW');
  const held = await service.send('code-review', 'Code Reviewer', { to: { channel: 'reviews' }, title: 'stale', body: 'x', key: 'k3' });

  setNow(new Date('2026-09-26T10:00:00').getTime());
  const out = await service.releaseHeld();
  assert.deepEqual(out.map((one) => one.why), ['too-old']);
  assert.equal(calls.length, 0);
  const row = service.store.message(held.id);
  assert.equal(row.state, 'SKIPPED');
  assert.match(row.reason, /held too long/);
});

/*
 * Judged again, not sent again: a second row for one message would be counted
 * twice by every ceiling, and its own age would start over — so a held message
 * could never grow old enough to let go of.
 */
test('releasing judges the row it has rather than making another', { skip }, async () => {
  const { service, setNow } = setup({ at: new Date('2026-09-23T23:40:00').getTime() });
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.saveSettings({ hoursFrom: 9, hoursTo: 18, weekdaysOnly: true, perPersonPerDay: 5, dedupeDays: 7 });
  service.store.setAppStance('code-review', 'ALLOW');
  await service.send('code-review', 'Code Reviewer', { to: { channel: 'reviews' }, title: 'one', body: 'x', key: 'k4' });
  const before = service.store.messages({ limit: 100 }).length;

  setNow(new Date('2026-09-24T02:00:00').getTime());
  await service.releaseHeld();
  await service.releaseHeld();
  assert.equal(service.store.messages({ limit: 100 }).length, before, 'no new rows for a message still held');
});

/*
 * The count of what is waiting was never capped but the rows were, so a busy
 * extension could push the one message somebody had to decide about off the end
 * of the table — badge saying one, and no row to press Send on.
 */
test('a message waiting on you is in the outbox however much came after it', { skip }, async () => {
  const { service } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.store.setAppStance('code-review', 'ALLOW');
  service.saveSettings({ hoursFrom: 0, hoursTo: 24, weekdaysOnly: false, perPersonPerDay: 0, dedupeDays: 0 });
  service.store.seeApp('newcomer', 'Newcomer');
  service.store.setAppStance('newcomer', 'ASK');
  const asked = await service.send('newcomer', 'Newcomer', { to: { channel: 'reviews' }, title: 'may I?', body: 'x', key: 'w1' });
  assert.equal(asked.why, 'asks-first');

  for (let i = 0; i < 70; i += 1) {
    await service.send('code-review', 'Code Reviewer', { to: { channel: 'reviews' }, title: `noise ${i}`, body: 'x', key: `n${i}` });
  }
  const shown = service.store.messages({ limit: 60 });
  assert.ok(shown.some((row) => row.id === asked.id), 'the one you have to decide about is reachable');
  assert.equal(service.overview().waiting, 1);
});

/*
 * A room and a person are two errands, not two ways of doing one.
 *
 * They used to be a single radio button — webhook *or* app registration — and
 * whichever was chosen carried everything. So with the webhook picked, a
 * message addressed to one developer went into the channel where the whole team
 * read it. Where a message goes is decided by who it is addressed to.
 */
test('a message for one person does not go into the room', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.store.setAppStance('code-review', 'ALLOW');

  const out = await service.send('code-review', 'Code Reviewer', {
    to: { email: 'b@kubrik.com' }, title: 'a word in your ear', body: 'x', key: 'p1',
  });
  assert.equal(out.ok, false, 'there is no way to reach a person yet');
  assert.match(out.detail ?? '', /signed in/);
  assert.equal(calls.length, 0, 'and nothing was posted where everybody would read it');
});

test('a message for the room goes out on the webhook alone', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.store.setAppStance('code-review', 'ALLOW');

  const out = await service.send('code-review', 'Code Reviewer', {
    to: { channel: 'reviews' }, title: 'PR #43 is being reviewed', body: 'x', key: 'c1',
  });
  assert.equal(out.ok, true, 'a room needs no app registration');
  assert.equal(calls.length, 1);
});

test('each way out answers for itself', { skip }, () => {
  const { service } = setup();
  assert.deepEqual(
    [service.connection().channel.ready, service.connection().person.ready],
    [false, false],
  );
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  assert.equal(service.connection().channel.ready, true, 'the room can be reached');
  assert.equal(service.connection().person.ready, false, 'and nobody privately, yet');
});

// ---------------------------------------------------------------- rooms by name

/*
 * One webhook is one channel, so "the right room" is a second webhook with a
 * name a sender asks for — the payments repository's alerts in the payments
 * room, not in whichever channel happened to be set up first.
 */
test('a room with a name of its own gets its own webhook', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/default' });
  service.saveChannel({ name: '#Payments', webhookUrl: 'https://example.invalid/payments' });
  service.store.setAppStance('code-review', 'ALLOW');

  await service.send('code-review', 'Code Reviewer', { to: { channel: 'payments' }, title: 'two migrations numbered 12', key: 'm1' });
  await service.send('code-review', 'Code Reviewer', { to: { channel: 'reviews' }, title: 'somebody else', key: 'm2' });

  assert.deepEqual(calls.map((call) => call.url), ['https://example.invalid/payments', 'https://example.invalid/default'],
    'a name it knows goes to that room; one it does not goes where everything went before');
  assert.deepEqual(service.connection().channels, ['Payments'], 'kept as written, without the #');
});

test('a room can be the only way out, and a name nobody set up then says so', { skip }, async () => {
  const { service, calls } = setup();
  service.saveChannel({ name: 'payments', webhookUrl: 'https://example.invalid/payments' });
  service.store.setAppStance('code-review', 'ALLOW');
  assert.equal(service.connection().channel.ready, true);

  const out = await service.send('code-review', 'Code Reviewer', { to: { channel: 'elsewhere' }, title: 'x', key: 'm3' });
  assert.equal(out.ok, false);
  assert.match(out.detail, /no webhook or chat called “elsewhere”/);
  assert.equal(calls.length, 0);
});

test('a room keeps its webhook out of sight, and can be forgotten', { skip }, () => {
  const { service } = setup();
  assert.throws(() => service.saveChannel({ name: 'payments', webhookUrl: 'http://inside/hook' }), /https/);
  assert.throws(() => service.saveChannel({ name: '', webhookUrl: 'https://example.invalid/x' }), /name/);
  assert.throws(() => service.saveChannel({ name: 'payments' }), /Webhook URL/);
  service.saveChannel({ name: 'payments', webhookUrl: 'https://example.invalid/ROOM-SECRET' });
  // Saved again with the box empty: the name stays and so does its webhook.
  service.saveChannel({ name: 'Payments' });
  assert.deepEqual(service.channels(), [{ name: 'payments', hasWebhook: true }], 'one room, whatever the case');
  assert.ok(!JSON.stringify(service.overview()).includes('ROOM-SECRET'));
  service.forgetChannel('PAYMENTS');
  assert.deepEqual(service.channels(), []);
  assert.equal(service.webhookFor('payments'), null);
});

// ---------------------------------------------------------- both ways at once

/*
 * The screen used to be a radio button, and so did the thinking behind it: a
 * machine was "a webhook one" or "a registration one". Both are wanted at the
 * same time — the team's room told that a review started, the author told
 * privately that something waits on them — and each is set up, proved and
 * used without touching the other.
 */
test('a room and a person are both reachable at once, each by its own way', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  assert.deepEqual([service.connection().channel.ready, service.connection().person.ready], [true, true]);

  const room = await service.send('code-review', 'Code Reviewer', { to: { channel: 'reviews' }, title: 'PR #43 is being reviewed', key: 'r1' });
  const posted = calls.length;
  const person = await service.send('code-review', 'Code Reviewer', { to: { email: 'b@kubrik.com' }, title: 'a word in your ear', key: 'p1' });

  assert.deepEqual([room.ok, person.ok], [true, true]);
  assert.deepEqual(calls.slice(0, posted).map((call) => call.url), ['https://example.invalid/hook'], 'the room went on the webhook');
  assert.ok(calls.slice(posted).every((call) => !call.url.includes('example.invalid/hook')), 'and the person never went into the room');
  assert.ok(calls.slice(posted).some((call) => call.url.endsWith('/chats/chat-1/messages')), 'but into a chat of their own');
});

test('saving one way out leaves the other as it was', { skip }, () => {
  const { service } = setup();
  graph(service);
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  assert.equal(service.connection().person.ready, true, 'the webhook did not switch the registration off');
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook2' });
  assert.equal(service.connection().channel.ready, true, 'nor the registration the webhook');
  assert.equal(service.connection().way, undefined, 'and there is no switch between them any more');
});

test('each way out is tested on its own, and remembers how that went', { skip }, async () => {
  const { service, calls } = setup({ fail: (url) => url.includes('/v1.0/chats') });
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  graph(service);

  assert.match((await service.test('')).error, /Type somebody/, 'a person test needs a person, whatever else is set up');
  assert.equal((await service.testChannel('')).ok, true, 'no name is the default room');
  assert.equal(calls.at(-1).url, 'https://example.invalid/hook');
  assert.equal((await service.test('b@kubrik.com')).ok, false);

  const c = service.connection();
  assert.ok(c.channel.checkedAt && !c.channel.checkError, 'the room proved itself');
  assert.match(c.person.checkError, /opening the chat/, 'and the person route says why it did not');
});

test('what you write goes to the room and the person together, each answered for', { skip }, async () => {
  // Late at night: none of the rules for machines hold back somebody pressing Send.
  const { service, calls } = setup({ at: new Date('2026-09-23T23:30:00').getTime() });
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.saveChannel({ name: 'payments', webhookUrl: 'https://example.invalid/payments' });
  graph(service);

  const out = await service.compose({ title: 'Frozen until 15:00', body: 'Nothing merges into main.', channel: 'payments', to: 'b@kubrik.com' });
  assert.deepEqual([out.channel.ok, out.person.ok], [true, true]);
  assert.equal(calls[0].url, 'https://example.invalid/payments');
  assert.ok(calls.some((call) => call.url.endsWith('/chats/chat-1/messages')));

  const rows = service.store.messages();
  assert.deepEqual(rows.map((row) => [row.appId, row.state]).sort(), [['you', 'SENT'], ['you', 'SENT']], 'both in the outbox, from you');
  assert.ok(rows.some((row) => row.to === '#payments'));
  assert.ok(!service.store.apps().some((app) => app.id === 'you'), 'and you are not an extension asking for permission');
});

test('what you write says which half did not go, without hiding the half that did', { skip }, async () => {
  const { service } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  graph(service);

  const out = await service.compose({ title: 'hello', channel: '', to: 'nobody@elsewhere.com' });
  assert.equal(out.channel.ok, true, 'the default room took it');
  assert.equal(out.person.ok, false);
  assert.match(out.person.detail, /Teams has nobody at nobody@elsewhere.com/);

  await assert.rejects(service.compose({ title: 'x' }), /room, somebody to tell, or both/);
  await assert.rejects(service.compose({ channel: '' }), /nothing to say/);
  const bad = await service.compose({ title: 'x', to: 'bchavez' });
  assert.equal(bad.person.why, 'no-address', 'a name is not an address, and it says so before trying');
});

test('what you write without a title keeps every line, not just the first', { skip }, async () => {
  const { service } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });

  await service.compose({ body: 'Frozen until 15:00\nNothing merges into main.\nAsk me first.', channel: '' });
  const [row] = service.store.messages();
  assert.equal(row.title, 'Frozen until 15:00');
  assert.equal(row.body, 'Nothing merges into main.\nAsk me first.');
});

test('what you write yourself does not spend the day a machine has with them', { skip }, async () => {
  const { service } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  assert.equal(service.settings().perPersonPerDay, 1);

  assert.equal((await service.compose({ title: 'a note by hand', to: 'b@kubrik.com' })).person.ok, true);
  const reminder = await service.send('code-review', 'Code Reviewer', { to: { email: 'b@kubrik.com' }, title: 'waiting on you', key: 'r-after-note' });
  assert.equal(reminder.ok, true, 'the reminder still goes: the ceiling is about machines, not about you');
});

test('the default room is its own place, not a room that happens to be called “default”', { skip }, async () => {
  const { service, calls } = setup({ fail: (url) => url === 'https://example.invalid/hook' && calls.length === 1 });
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.saveChannel({ name: 'default', webhookUrl: 'https://example.invalid/a-room-called-default' });

  const out = await service.compose({ title: 'to the default room', channel: '' });
  assert.equal(out.channel.ok, false, 'the first try fails');
  assert.equal((await service.retry(out.channel.id)).ok, true);
  assert.deepEqual(calls.map((call) => call.url), ['https://example.invalid/hook', 'https://example.invalid/hook'],
    'and the retry goes where the first try went, not into the room named default');
  assert.equal(service.store.message(out.channel.id).to, '# the default room');
});

test('a room name that cleans to nothing is asked about, not taken for the default', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  assert.equal((await service.testChannel('#')).error, 'Which room?');
  assert.equal((await service.testChannel('## ')).error, 'Which room?');
  assert.equal(calls.length, 0);
  assert.equal(service.connection().channel.checkedAt, null, 'and nothing was recorded as the channel’s test');
});

// ------------------------------------------------- a name kept the way it is sent

/*
 * "Who is Inés Núñez on Teams?" asked again after every answer: the address
 * was kept under `bitbucket:Inés Núñez` and looked for under
 * `bitbucket:inés núñez`, so the answer sat in a row nothing ever read.
 */
test('an address given for a name with capitals reaches the messages sent to that name', { skip }, async () => {
  const { service } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  const to = { handle: 'bitbucket:Inés Núñez', display: 'Inés Núñez' };

  const before = await service.send('code-review', 'Code Reviewer', { to, title: 'first', key: 'n1' });
  assert.equal(before.why, 'no-address');

  service.store.matchPerson('bitbucket:Inés Núñez', 'b@kubrik.com');
  const after = await service.send('code-review', 'Code Reviewer', { to, title: 'again', key: 'n2' });
  assert.equal(after.ok, true, 'the second try finds what was said');

  assert.equal(service.store.person('bitbucket:Inés Núñez').address, 'b@kubrik.com', 'and asking by the name as written finds it too');
  assert.equal(service.store.people().length, 1, 'one person, one row');
});

test('answers already kept under the name as written are found again on the next start', { skip }, async () => {
  const { service, db } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  const to = { handle: 'bitbucket:Inés Núñez', display: 'Inés Núñez' };
  await service.send('code-review', 'Code Reviewer', { to, title: 'first', key: 'n1' });
  // What the old build left: the answer in a row of its own, and one nobody chose to fold.
  const row = (handle, address) => db.prepare("INSERT INTO tm_person (id, handle, display, address, matched_by, created_at) VALUES (?,?,?,?,'HAND','2026-01-01')").run(`id-${handle}`, handle, handle, address);
  row('bitbucket:Inés Núñez', 'b@kubrik.com');
  row('bitbucket:Ana', 'ana@kubrik.com');
  db.prepare("INSERT INTO tm_message (id, app_id, person_id, state, created_at) VALUES ('m1', 'x', 'id-bitbucket:Inés Núñez', 'SENT', '2026-01-01')").run();

  const { TeamsStore } = require('../electron/teams-store');
  const store = new TeamsStore(db, { encrypt: (t) => t, decrypt: (t) => t });

  assert.deepEqual(store.people().map((one) => [one.handle, one.address]).sort(), [['bitbucket:ana', 'ana@kubrik.com'], ['bitbucket:inés núñez', 'b@kubrik.com']]);
  assert.equal(store.message('m1').personId, store.person('bitbucket:inés núñez').id, 'and what was sent to them stays theirs');
  new TeamsStore(db, { encrypt: (t) => t, decrypt: (t) => t });
  assert.equal(store.people().length, 2, 'starting again changes nothing');
});

// ------------------------------------------------- somebody, in a channel or chat

const asReviewer = (service) => { service.store.setAppStance('code-review', 'ALLOW'); };
const tagInes = { handle: 'bitbucket:Inés Núñez', display: 'Inés Núñez' };
const bodyOf = (call) => JSON.parse(call.body).attachments[0].content;

test('a post meant for somebody tags them, so Teams tells them', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  asReviewer(service);
  service.store.matchPerson('bitbucket:Inés Núñez', 'ines@kubrik.com');

  const out = await service.send('code-review', 'Code Reviewer', { to: { channel: 'pos', mention: tagInes }, title: 'Comments to resolve', key: 't1' });
  assert.equal(out.ok, true);
  assert.deepEqual(bodyOf(calls[0]).msteams.entities[0].mentioned, { id: 'ines@kubrik.com', name: 'Inés Núñez' });
  assert.equal(service.store.messages()[0].to, '#pos @Inés Núñez');
});

test('a post for somebody nobody knows is asked about rather than posted past them', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  asReviewer(service);

  const out = await service.send('code-review', 'Code Reviewer', { to: { channel: 'pos', mention: tagInes }, title: 'x', key: 't2' });
  assert.equal(out.why, 'no-address', 'the same word a direct message gets, so the same question answers it');
  assert.equal(calls.length, 0);
  assert.equal(service.store.person('bitbucket:inés núñez').display, 'Inés Núñez', 'and they are on the People page to be matched');

  service.store.matchPerson('bitbucket:Inés Núñez', 'ines@kubrik.com');
  assert.equal((await service.send('code-review', 'Code Reviewer', { to: { channel: 'pos', mention: tagInes }, title: 'x', key: 't3' })).ok, true);
});

test('being tagged in a room does not spend the one message a day they get privately', { skip }, async () => {
  const { service } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  graph(service);
  asReviewer(service);
  service.store.matchPerson('bitbucket:Inés Núñez', 'b@kubrik.com');
  await service.send('code-review', 'Code Reviewer', { to: { channel: 'pos', mention: tagInes }, title: 'x', key: 't4' });
  const direct = await service.send('code-review', 'Code Reviewer', { to: tagInes, title: 'y', key: 't5' });
  assert.equal(direct.ok, true);
});

test('only the Code Reviewer may tag anybody', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.store.setAppStance('other', 'ALLOW');
  service.store.matchPerson('bitbucket:Inés Núñez', 'ines@kubrik.com');
  const out = await service.send('other', 'Other', { to: { channel: 'pos', mention: tagInes }, title: 'x', key: 't6' });
  assert.equal(out.ok, true, 'it still posts');
  assert.equal(bodyOf(calls[0]).msteams, undefined, 'without a tag');
});

test('a chat the bot is in is a room like any other, and its own webhook still wins', { skip }, async () => {
  const { service, calls } = setup();
  const said = [];
  service.setBot({
    ready: () => true, state: () => ({ ready: true, rooms: [] }), canReach: () => false,
    rooms: () => ({ '19:a': { name: 'POS devs' } }),
    roomNamed: (name) => (String(name).toLowerCase() === 'pos devs' ? { id: '19:a', name: 'POS devs' } : null),
    sendToRoom: async (room, message, tag) => { said.push([room.id, message.title, tag]); return { ok: true, how: 'bot' }; },
  });
  asReviewer(service);
  const c = service.connection();
  assert.equal(c.channel.ready, true, 'a chat is enough to say a room can be reached');
  assert.deepEqual(c.channels, ['POS devs'], 'and senders can ask for it by name');

  service.store.matchPerson('bitbucket:Inés Núñez', 'ines@kubrik.com');
  assert.equal((await service.send('code-review', 'Code Reviewer', { to: { channel: 'pos devs', mention: tagInes }, title: 'in the chat', key: 'c1' })).ok, true);
  assert.deepEqual(said, [['19:a', 'in the chat', [{ address: 'ines@kubrik.com', name: 'Inés Núñez' }]]]);
  assert.equal(calls.length, 0);

  service.saveChannel({ name: 'POS devs', webhookUrl: 'https://example.invalid/own' });
  await service.send('code-review', 'Code Reviewer', { to: { channel: 'pos devs' }, title: 'by webhook', key: 'c2' });
  assert.equal(said.length, 1);
  assert.equal(calls[0].url, 'https://example.invalid/own');
});

test('what you write can tag somebody, and a retry tags them too', { skip }, async () => {
  const { service, calls } = setup({ fail: (url) => url === 'https://example.invalid/hook' && calls.length === 1 });
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  const out = await service.compose({ title: 'hola', channel: '', mention: 'ines@kubrik.com' });
  assert.equal(out.channel.ok, false);
  assert.equal((await service.retry(out.channel.id)).ok, true);
  assert.equal(bodyOf(calls[1]).msteams.entities[0].mentioned.id, 'ines@kubrik.com');

  const bad = await service.compose({ title: 'hola', channel: '', mention: 'ines' });
  assert.equal(bad.channel.why, 'no-address');
  assert.equal(calls.length, 2, 'a name is not an address, and nothing went');
});

test('nothing a panel is given about a chat holds how to reach it', { skip }, () => {
  const { service } = setup();
  service.setBot({ ready: () => true, state: () => ({ ready: true, rooms: [{ id: '19:a', name: 'x', kind: 'chat' }] }), rooms: () => ({ '19:a': { name: 'x' } }) });
  assert.ok(!JSON.stringify(service.overview()).includes('serviceUrl'));
});

// ------------------------------------------------------- somebody pressed a button

test('a button somebody pressed goes now, even for an app that asks first; never still means never', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.store.seeApp('code-review', 'Code Reviewer');
  assert.equal(service.store.app('code-review').stance, 'ASK');

  const pressed = await service.send('code-review', 'Code Reviewer', { to: { channel: 'pos' }, title: 'x', byHand: true });
  assert.equal(pressed.ok, true);
  assert.equal(calls.length, 1);

  const onItsOwn = await service.send('code-review', 'Code Reviewer', { to: { channel: 'pos' }, title: 'y', key: 'auto' });
  assert.equal(onItsOwn.why, 'asks-first', 'what it decides by itself still asks');

  service.store.setAppStance('code-review', 'DENY');
  assert.equal((await service.send('code-review', 'Code Reviewer', { to: { channel: 'pos' }, title: 'z', byHand: true })).why, 'not-allowed');
});

test('another extension cannot claim somebody pressed a button', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  service.store.seeApp('other', 'Other');
  const out = await service.send('other', 'Other', { to: { channel: 'pos' }, title: 'x', byHand: true });
  assert.equal(out.why, 'asks-first');
  assert.equal(calls.length, 0);
});

test('a refusal from Graph is said in Graph\'s words, rather than blaming the person', { skip }, async () => {
  const { service, calls } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  const real = service.fetch;
  service.fetch = async (url, init) => (String(url).endsWith('/messages')
    ? { ok: false, status: 403, json: async () => ({ error: { code: 'Forbidden', message: 'Insufficient privileges.' } }) }
    : real(url, init));
  const out = await service.send('code-review', 'Code Reviewer', { to: { email: 'b@kubrik.com' }, title: 'x', key: 'p1' });
  assert.equal(out.ok, false);
  assert.match(out.detail, /sending answered 403: Insufficient privileges/);
  assert.ok(calls.length > 0);
});

// -------------------------------------------------------- signing in as yourself

/*
 * An app registration can open a chat and can never write in it, so a direct
 * message comes from a person who signed in. Every step here is what Microsoft's
 * device code flow really answers, including the ones that mean "not yet".
 */
test('signing in shows a code, opens the page, and finishes on its own', { skip }, async () => {
  const { service, timers, opened, pollAnswers } = setup();
  service.saveConnection({ tenantId: 't', clientId: 'c' });
  const started = await service.signIn();
  assert.equal(started.code, 'ABC123');
  assert.deepEqual(opened, ['https://microsoft.com/devicelogin']);
  assert.equal(service.connection().signingIn.code, 'ABC123');
  assert.equal(service.connection().person.ready, false, 'not until it is finished');

  pollAnswers.push({ error: 'authorization_pending' });
  await timers.shift()();
  assert.equal(service.connection().signingIn.code, 'ABC123', 'still waiting');
  assert.equal(timers.length, 1, 'and asking again');

  pollAnswers.push({ access_token: 'a', refresh_token: 'THE-REFRESH', expires_in: 3600 });
  await timers.shift()();
  const c = service.connection();
  assert.equal(c.signingIn, null);
  assert.equal(c.person.ready, true);
  assert.equal(c.sender, 'me@kubrik.com', 'from whoever signed in, and nobody typed it');
  assert.equal(timers.length, 0, 'and it stops asking');
  assert.ok(!JSON.stringify(service.overview()).includes('THE-REFRESH'));
});

test('a registration that does not allow it says which switch to turn on', { skip }, async () => {
  const { service, timers, pollAnswers } = setup();
  service.saveConnection({ tenantId: 't', clientId: 'c' });
  await service.signIn();
  pollAnswers.push({ error: 'invalid_client', error_description: "AADSTS7000218: The request body must contain 'client_secret'.\r\nTrace ID: x" });
  await timers.shift()();
  assert.match(service.connection().signInError, /Allow public client flows/);
  assert.equal(service.connection().signingIn, null);
});

test('a code that ran out says so, and asks no more', { skip }, async () => {
  const { service, timers, setNow } = setup();
  service.saveConnection({ tenantId: 't', clientId: 'c' });
  await service.signIn();
  setNow(WEDNESDAY_10 + 16 * 60 * 1000);
  await timers.shift()();
  assert.match(service.connection().signInError, /expired/);
  assert.equal(timers.length, 0);
});

test('cancelling a sign-in stops it, even with an answer already on its way', { skip }, async () => {
  const { service, timers, pollAnswers } = setup();
  service.saveConnection({ tenantId: 't', clientId: 'c' });
  await service.signIn();
  service.signOut();
  pollAnswers.push({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  await timers.shift()();
  assert.equal(service.connection().person.ready, false);
});

test('a new refresh token is kept the moment it arrives', { skip }, async () => {
  const { service } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  assert.equal((await service.send('code-review', 'Code Reviewer', { to: { email: 'b@kubrik.com' }, title: 'x', key: 'k' })).ok, true);
  assert.equal(service.store.secret('graph.refreshToken'), 'r2', 'the old one stops working');
});

test('a sign-in Microsoft ended is said where it can be fixed, once', { skip }, async () => {
  const { service } = setup();
  graph(service);
  service.store.setSecret('graph.refreshToken', 'revoked');
  service.store.setAppStance('code-review', 'ALLOW');
  const out = await service.send('code-review', 'Code Reviewer', { to: { email: 'b@kubrik.com' }, title: 'x', key: 'k' });
  assert.match(out.detail, /sign in again/);
  const c = service.connection();
  assert.equal(c.person.ready, false, 'no green light in front of the same failure');
  assert.match(c.signInError, /Sign in again/);
});

test('another registration is another sign-in; the same one saved again is not', { skip }, () => {
  const { service } = setup();
  graph(service);
  service.saveConnection({ tenantId: 't', clientId: 'c' });
  assert.equal(service.connection().person.ready, true);
  service.saveConnection({ tenantId: 't', clientId: 'other' });
  assert.equal(service.connection().person.ready, false);
  assert.equal(service.store.secret('graph.refreshToken'), null);
});

// ------------------------------------------------------------- several people at once

test('several people separately: a private message to each, answered for each', { skip }, async () => {
  const { service, calls } = setup();
  graph(service);
  const out = await service.compose({ title: 'hola', to: ['b@kubrik.com', 'braian@kubrik.com', 'nobody@kubrik.com', 'B@kubrik.com'] });
  assert.deepEqual(out.people.map((one) => [one.address, one.ok]), [['b@kubrik.com', true], ['braian@kubrik.com', true], ['nobody@kubrik.com', false]], 'each once, whatever the case');
  assert.equal(out.person.ok, false, 'one did not go, and that is not hidden');
  assert.match(out.person.detail, /nobody@kubrik.com: Teams has nobody/);
  const chats = calls.filter((call) => call.url.endsWith('/v1.0/chats')).map((call) => JSON.parse(call.body));
  assert.deepEqual(chats.map((chat) => [chat.chatType, chat.members.length]), [['oneOnOne', 2], ['oneOnOne', 2]]);
});

test('several people together: one group chat with all of them and you, and a retry is the same chat', { skip }, async () => {
  const { service, calls } = setup({ fail: (url) => url.endsWith('/messages') && calls.filter((call) => call.url.endsWith('/messages')).length === 1 });
  graph(service);
  const out = await service.compose({ title: 'hola', to: 'b@kubrik.com, braian@kubrik.com', together: true });
  assert.equal(out.person.ok, false);
  const chat = JSON.parse(calls.find((call) => call.url.endsWith('/v1.0/chats')).body);
  assert.equal(chat.chatType, 'group');
  const seats = chat.members.map((one) => one['user@odata.bind']);
  assert.equal(new Set(seats).size, 3, 'you and the two of them');
  assert.ok(seats.some((seat) => seat.includes('id-of-me@kubrik.com')));

  assert.equal((await service.retry(out.person.id)).ok, true);
  const again = calls.filter((call) => call.url.endsWith('/v1.0/chats')).at(-1);
  assert.equal(JSON.parse(again.body).chatType, 'group');
});

test('one person with "together" is still a direct message, and yourself in a group is refused', { skip }, async () => {
  const { service, calls } = setup();
  graph(service);
  await service.compose({ title: 'hola', to: ['b@kubrik.com'], together: true });
  assert.equal(JSON.parse(calls.find((call) => call.url.endsWith('/v1.0/chats')).body).chatType, 'oneOnOne');
  const self = await service.compose({ title: 'hola', to: ['b@kubrik.com', 'me@kubrik.com'], together: true });
  assert.match(self.person.detail, /cannot be sent to me@kubrik.com/);
});

test('several people can be tagged in one post', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://example.invalid/hook' });
  const out = await service.compose({ title: 'hola', channel: '', mention: ['b@kubrik.com', 'braian@kubrik.com'] });
  assert.equal(out.channel.ok, true);
  const content = bodyOf(calls[0]);
  assert.deepEqual(content.msteams.entities.map((one) => one.mentioned.id), ['b@kubrik.com', 'braian@kubrik.com']);
  assert.ok(content.body.some((block) => block.text === '<at>b@kubrik.com</at> <at>braian@kubrik.com</at>'), 'every name in the card, or Teams shows no tag');
});

test('the reviewer can ask for one chat with several; no other extension can', { skip }, async () => {
  const { service, calls } = setup();
  graph(service);
  service.store.setAppStance('code-review', 'ALLOW');
  const out = await service.send('code-review', 'Code Reviewer', { to: { email: 'b@kubrik.com' }, group: ['b@kubrik.com', 'braian@kubrik.com'], title: 'x', byHand: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(JSON.parse(calls.find((call) => call.url.endsWith('/v1.0/chats')).body).chatType, 'group');

  calls.length = 0;
  service.store.setAppStance('other', 'ALLOW');
  await service.send('other', 'Other', { to: { email: 'braian@kubrik.com' }, group: ['b@kubrik.com', 'braian@kubrik.com'], title: 'y', key: 'o1' });
  assert.equal(JSON.parse(calls.find((call) => call.url.endsWith('/v1.0/chats')).body).chatType, 'oneOnOne', 'a direct message to the one it named');
});

test('a room somebody picked for an app is told without asking, an extension cannot claim that for itself, and Deny still means never', { skip }, async () => {
  const { service, calls } = setup();
  service.saveConnection({ webhookUrl: 'https://outlook.office.com/webhook/abc' });
  service.store.seeApp('jenkins', 'Jenkins');
  const message = (key, extra = {}) => ({ to: { channel: 'builds' }, title: 'pay #2 started', key, ...extra });

  // A new app asks first, whatever it says about itself.
  assert.equal((await service.send('jenkins', 'Jenkins', message('k1', { byHand: true }))).why, 'asks-first');
  assert.equal(calls.length, 0);
  // The app's own call, for a room a person chose, goes.
  assert.equal((await service.send('jenkins', 'Jenkins', message('k2'), { chosen: true })).ok, true);
  assert.equal(calls.length, 1);
  service.store.setAppStance('jenkins', 'DENY');
  assert.equal((await service.send('jenkins', 'Jenkins', message('k3'), { chosen: true })).why, 'not-allowed');
  assert.equal(calls.length, 1);
});
