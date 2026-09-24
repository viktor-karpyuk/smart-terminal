'use strict';

const { TeamsStore } = require('./teams-store');
const rules = require('./teams-rules');
const { postWebhook, sendDirect, tokenCache, card, asText } = require('./teams-send');

/** Often enough that "waits for the morning" is the morning, rarely enough to be nothing. */
const HOLD_SWEEP_MS = 5 * 60 * 1000;

/**
 * Teams, as a thing anything in this app can ask to deliver a message.
 *
 * It knows nothing about pull requests, builds or clusters. It takes a person,
 * a few lines and some links, and gets them there — and everything that asks
 * shows up in its own screen with a switch of its own.
 *
 * The credentials live here, in the main process, for the same reason the
 * reviewer's tokens do: a panel runs with `connect-src 'none'` and cannot reach
 * the network at all. That is also why this is an extension of its own rather
 * than a section inside the Code Reviewer — one connection, many senders, and
 * none of them ever holds a token.
 */
class TeamsService {
  constructor({ db, secrets, fetch, notify = () => {}, emit = () => {}, now = Date.now }) {
    this.store = new TeamsStore(db, secrets);
    this.fetch = fetch;
    this.notify = notify;
    this.emit = emit;
    this.now = now;
    this.tokens = tokenCache();
    this.timer = null;
  }

  // --- what it is set up to do ------------------------------------------------

  /** How it reaches Teams, and whether it can. Never includes a secret. */
  connection() {
    const way = this.store.setting('way', 'graph');
    const hasWebhook = Boolean(this.store.secret('webhook.url'));
    // A direct message needs somebody it is from, so a registration without one
    // is not ready — saying it is would be a green light in front of a failure.
    const hasGraph = Boolean(
      this.store.setting('graph.tenantId') && this.store.setting('graph.clientId') &&
      this.store.secret('graph.clientSecret') && this.store.setting('graph.sender'),
    );
    return {
      way,
      ready: way === 'webhook' ? hasWebhook : hasGraph,
      hasWebhook,
      hasGraph,
      tenantId: this.store.setting('graph.tenantId', ''),
      clientId: this.store.setting('graph.clientId', ''),
      sender: this.store.setting('graph.sender', ''),
      checkedAt: this.store.setting('checkedAt'),
      checkError: this.store.setting('checkError'),
    };
  }

  settings() {
    /*
     * A setting nobody has written is the fallback, not zero.
     *
     * `Number(null)` is 0 and `Number.isFinite(0)` is true, so reading it that
     * way gave every default the value 0 — which made the sending window run
     * from midnight to midnight, and held every message on the machine as
     * "outside the hours it may send in".
     */
    const number = (key, fallback) => {
      const stored = this.store.setting(key);
      if (stored === null || stored === undefined || stored === '') return fallback;
      const value = Number(stored);
      return Number.isFinite(value) ? value : fallback;
    };
    return {
      hoursFrom: number('hours.from', 9),
      hoursTo: number('hours.to', 18),
      weekdaysOnly: this.store.setting('hours.weekdaysOnly', 'true') !== 'false',
      perPersonPerDay: number('cap.person', 1),
      dedupeDays: number('dedupe.days', 7),
      matchByEmail: this.store.setting('match.byEmail', 'true') !== 'false',
    };
  }

  saveConnection({ way, webhookUrl, tenantId, clientId, clientSecret, sender } = {}) {
    /*
     * Refuse first, write second.
     *
     * A URL that is not https used to be stored as the way before it was
     * checked, so a rejected save still left the connection switched to a
     * webhook it had not kept.
     */
    const url = typeof webhookUrl === 'string' ? webhookUrl.trim() : null;
    if (url && !/^https:\/\//i.test(url)) throw new Error('A webhook URL has to be https.');

    if (way === 'webhook' || way === 'graph') this.store.setSetting('way', way);
    /*
     * An empty box is "leave it alone", not "erase it".
     *
     * Neither secret is ever sent back to the panel — the field shows a
     * placeholder saying so — which means pressing Save without retyping sends
     * an empty string. The client secret had this guard from the start; the
     * webhook URL did not, so saving the Connection screen without touching it
     * deleted a working webhook and every reminder after it came back with
     * nowhere to go.
     */
    if (url) this.store.setSecret('webhook.url', url);
    if (typeof tenantId === 'string') this.store.setSetting('graph.tenantId', tenantId.trim());
    if (typeof clientId === 'string') this.store.setSetting('graph.clientId', clientId.trim());
    if (typeof sender === 'string') this.store.setSetting('graph.sender', sender.trim());
    if (typeof clientSecret === 'string' && clientSecret.trim()) this.store.setSecret('graph.clientSecret', clientSecret.trim());
    this.tokens.forget();
    this.changed();
    return this.connection();
  }

  /** Really forget a webhook, for the panel's own "forget this" rather than a blank save. */
  forgetWebhook() {
    this.store.setSecret('webhook.url', null);
    this.changed();
    return this.connection();
  }

  saveSettings(input = {}) {
    const write = (key, value, low, high) => {
      /*
       * A box somebody cleared is a box they have not decided about yet.
       *
       * `Number('')` is 0 and 0 is finite, so clearing a field and pressing Save
       * for an unrelated change used to store a real zero — which for the dedupe
       * window means "never hold anything back" and for a ceiling means "no
       * ceiling". The same shape as the quiet hours that read 0–0 and held every
       * message for ever.
       */
      if (value === null || value === undefined || String(value).trim() === '') return;
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      this.store.setSetting(key, String(Math.min(high, Math.max(low, Math.round(number)))));
    };
    write('hours.from', input.hoursFrom, 0, 23);
    write('hours.to', input.hoursTo, 0, 24);
    write('cap.person', input.perPersonPerDay, 0, 50);
    write('dedupe.days', input.dedupeDays, 0, 365);
    if (input.weekdaysOnly !== undefined) this.store.setSetting('hours.weekdaysOnly', input.weekdaysOnly ? 'true' : 'false');
    if (input.matchByEmail !== undefined) this.store.setSetting('match.byEmail', input.matchByEmail ? 'true' : 'false');
    this.changed();
    return this.settings();
  }

  // --- the one thing other extensions call -------------------------------------

  /**
   * Deliver a message, or say why not.
   *
   * The sender learns nothing about Teams from this — not a tenant, not an
   * address, not whether the person was even matched. It gets `ok`, or a word
   * it can show in its own screen: `no-address`, `not-allowed`, `quiet-hours`,
   * `already-sent`, `asks-first`.
   */
  /**
   * Who this is for, and whether it may go — asked the same way every time.
   *
   * Separate from `send` because a message held back has to be asked again
   * later, from scratch: the hours may have opened, the ceiling may have
   * cleared, or the same thing may since have been said another way. Asking it
   * in two places written twice is how the two answers drift apart.
   */
  #judge(message, app, { display = '' } = {}) {
    const settings = this.settings();
    const handle = message.to.handle ?? (message.to.email ? `email:${message.to.email}` : null);
    let person = null;
    if (handle) {
      const read = rules.readHandle(handle);
      const address = rules.addressFrom(read.handle, { matchByEmail: settings.matchByEmail });
      person = this.store.rememberPerson({
        handle: read.handle,
        display,
        address,
        matchedBy: address ? 'EMAIL' : null,
      });
    }

    const at = this.now();
    const dayAgo = new Date(at - rules.DAY_MS).toISOString();
    const decision = rules.decide({
      message,
      app,
      person,
      now: at,
      hours: { from: settings.hoursFrom, to: settings.hoursTo, weekdaysOnly: settings.weekdaysOnly },
      perPersonPerDay: settings.perPersonPerDay,
      sentByAppToday: this.store.sentSince(app.id, dayAgo),
      sentToPersonToday: person ? this.store.sentToSince(person.id, dayAgo) : 0,
      alreadySent: this.store.alreadySent(message.key, settings.dedupeDays * rules.DAY_MS, at),
    });
    return { person, handle, decision };
  }

  async send(appId, appName, input) {
    const message = rules.readMessage(input);
    const app = this.store.seeApp(appId, appName);
    const settings = this.settings();

    const { person, handle, decision } = this.#judge(message, app, { display: input?.to?.display ?? '' });
    const to = message.to.channel ? `#${message.to.channel}` : (person?.display ?? handle ?? '');
    const record = (state, reason) =>
      this.store.addMessage({
        appId, key: message.key, personId: person?.id ?? null, to,
        title: message.title, body: message.body, payload: message, state, reason,
      });

    if (decision.verdict === 'REFUSE') {
      const row = record('SKIPPED', decision.detail ?? decision.why);
      this.changed();
      return { ok: false, why: decision.why, detail: decision.detail ?? null, id: row.id };
    }
    if (decision.verdict === 'HOLD') {
      const row = record('HELD', decision.detail ?? decision.why);
      this.changed();
      return { ok: false, why: decision.why, detail: decision.detail ?? null, id: row.id };
    }
    if (decision.verdict === 'ASK') {
      const row = record('WAITING', null);
      this.store.noteAppAsked(appId);
      this.notify(`${app.name} wants to send a message`, message.title);
      this.changed();
      return { ok: false, why: 'asks-first', id: row.id };
    }

    // Written as being tried, not as having gone: a row stamped with the moment
    // it was sent and then marked FAILED keeps a time that never happened, and
    // the first thing to ask "when did this go" gets a wrong answer.
    const row = record('SENDING', null);
    try {
      await this.deliver(message, person);
      this.store.markSent(row.id);
      if (person) this.store.notePersonSent(person.handle);
      this.changed();
      return { ok: true, id: row.id };
    } catch (error) {
      this.store.markFailed(row.id, String(error?.message ?? error));
      this.changed();
      return { ok: false, why: 'failed', detail: String(error?.message ?? error), id: row.id };
    }
  }

  /** Put it on the wire, whichever way this machine is set up. */
  async deliver(message, person) {
    const way = this.store.setting('way', 'graph');
    if (way === 'webhook') {
      const url = this.store.secret('webhook.url');
      if (!url) throw new Error('No webhook is set up.');
      return postWebhook(this.fetch, url, message);
    }
    const credentials = {
      tenantId: this.store.setting('graph.tenantId'),
      clientId: this.store.setting('graph.clientId'),
      clientSecret: this.store.secret('graph.clientSecret'),
      senderAddress: this.store.setting('graph.sender') || null,
    };
    if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
      throw new Error('The app registration is not filled in.');
    }
    if (!credentials.senderAddress) {
      throw new Error('Nobody is set as who these messages come from — a direct message is between two people.');
    }
    const address = message.to.channel ? null : person?.address;
    if (!address) throw new Error('There is no Teams address for them.');
    return sendDirect(this.fetch, credentials, this.tokens, { address, message });
  }

  /** A message somebody had to say yes to. */
  async approve(id) {
    const row = this.store.message(id);
    if (!row || row.state !== 'WAITING') throw new Error('That message is not waiting for anything.');
    const person = row.personId ? this.store.people().find((one) => one.id === row.personId) : null;
    try {
      await this.deliver(row.payload, person);
      this.store.markSent(row.id);
      if (person) this.store.notePersonSent(person.handle);
      this.changed();
      return { ok: true };
    } catch (error) {
      this.store.markFailed(row.id, String(error?.message ?? error));
      this.changed();
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  skip(id) {
    const row = this.store.message(id);
    if (!row) throw new Error('That message is gone.');
    this.store.markSkipped(id, 'you said not this one');
    this.changed();
    return { ok: true };
  }

  async retry(id) {
    const row = this.store.message(id);
    if (!row || row.state !== 'FAILED') throw new Error('That message did not fail.');
    const person = row.personId ? this.store.people().find((one) => one.id === row.personId) : null;
    try {
      await this.deliver(row.payload, person);
      this.store.markSent(row.id);
      // Counts as a message that went, because it did: the People screen said
      // "never" for somebody who had just been written to.
      if (person) this.store.notePersonSent(person.handle);
      this.changed();
      return { ok: true };
    } catch (error) {
      this.store.markFailed(row.id, String(error?.message ?? error));
      this.changed();
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * Let out what the hours or a ceiling held back.
   *
   * The whole promise of holding rather than dropping — the panel says
   * "anything raised outside these hours waits for the morning" — and nothing
   * kept it: `HELD` was written in one place and read by nobody, so the morning
   * never came. Judged again from scratch, because the hours may still be
   * closed, the ceiling may still be full, and the thing may since have been
   * said another way.
   *
   * A hold does not last for ever. Something worth saying at 23:40 is worth
   * saying at 09:00; the same thing three days later is just noise, so it is
   * let go of and says so.
   */
  async releaseHeld() {
    const out = [];
    for (const row of this.store.held()) {
      const age = this.now() - Date.parse(row.createdAt || 0);
      if (!Number.isFinite(age) || age > rules.DAY_MS) {
        this.store.markSkipped(row.id, 'held too long to be worth saying now');
        out.push({ id: row.id, ok: false, why: 'too-old' });
        continue;
      }
      const app = this.store.app(row.appId);
      if (!app) continue;

      // The same row, judged again — not a new one. A second row for one
      // message would be counted twice by every ceiling, and its own age would
      // start over, so a held message could never grow old enough to let go of.
      const message = rules.readMessage(row.payload);
      const { person, decision } = this.#judge(message, app);
      if (decision.verdict === 'HOLD') continue;
      if (decision.verdict === 'REFUSE') {
        this.store.markSkipped(row.id, decision.detail ?? decision.why);
        out.push({ id: row.id, ok: false, why: decision.why });
        continue;
      }
      if (decision.verdict === 'ASK') {
        this.store.markWaiting(row.id);
        out.push({ id: row.id, ok: false, why: 'asks-first' });
        continue;
      }
      this.store.markSending(row.id);
      try {
        await this.deliver(message, person);
        this.store.markSent(row.id);
        if (person) this.store.notePersonSent(person.handle);
        out.push({ id: row.id, ok: true });
      } catch (error) {
        this.store.markFailed(row.id, String(error?.message ?? error));
        out.push({ id: row.id, ok: false, why: 'failed' });
      }
    }
    if (out.length) this.changed();
    return out;
  }

  /** The clock the hold runs on: what was held back is looked at again. */
  start() {
    if (this.timer) return;
    // Whatever a previous process left in flight is not in flight any more.
    try { this.store.orphanedSends(); } catch { /* an empty outbox is the normal case */ }
    this.timer = setInterval(() => { this.releaseHeld().catch(() => {}); }, HOLD_SWEEP_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Say something to yourself, to find out whether any of this works. */
  async test(to) {
    const way = this.store.setting('way', 'graph');
    /*
     * A webhook has one channel and needs nobody named; a direct message has
     * nowhere to go without somebody. Asked for what it needs, rather than
     * tried and refused for a reason that sounds like a different problem —
     * it used to answer "there is no Teams address for them" when what it
     * meant was "you did not type one".
     */
    if (way !== 'webhook' && !String(to ?? '').trim()) {
      return { ok: false, error: 'Type somebody to send it to — a direct message has to go to a person.' };
    }
    const message = rules.readMessage({
      to: to && to.trim() ? { email: to.trim() } : { channel: 'test' },
      title: 'Smart Terminal can reach you here',
      body: 'Nothing is wrong. Somebody pressed “Send a test message” to find out whether this works.',
    });
    try {
      const person = message.to.email ? this.store.rememberPerson({ handle: `email:${message.to.email}`, address: message.to.email, matchedBy: 'EMAIL' }) : null;
      await this.deliver(message, person);
      this.store.setSetting('checkedAt', new Date(this.now()).toISOString());
      this.store.setSetting('checkError', null);
      this.changed();
      return { ok: true };
    } catch (error) {
      this.store.setSetting('checkedAt', new Date(this.now()).toISOString());
      this.store.setSetting('checkError', String(error?.message ?? error));
      this.changed();
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  overview() {
    return {
      connection: this.connection(),
      settings: this.settings(),
      apps: this.store.apps(),
      people: this.store.people(),
      messages: this.store.messages({ limit: 60 }),
      waiting: this.store.waiting().length,
    };
  }

  changed() {
    this.emit({ type: 'changed' });
  }

  /** What the app hands the Code Reviewer and anything else that asks. */
  asDelivery() {
    return {
      id: 'teams',
      name: 'Teams',
      ready: () => this.connection().ready,
      send: (appId, appName, message) => this.send(appId, appName, message),
    };
  }
}

module.exports = { TeamsService, card, asText };
