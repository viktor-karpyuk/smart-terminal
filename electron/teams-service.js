'use strict';

const { TeamsStore } = require('./teams-store');
const rules = require('./teams-rules');
const { NoRoute } = require('./teams-bot');
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
    /** The Code Reviewer's bot, once main has made it. Private messages go through it when it can. */
    this.bot = null;
  }

  setBot(bot) {
    this.bot = bot;
  }

  // --- what it is set up to do ------------------------------------------------

  /**
   * The two ways out, each answered for on its own. Never includes a secret.
   *
   * There is no "way" any more. It was a radio button — webhook *or* app
   * registration — and the screen drew only the half that was picked, so a
   * machine could be set up to post in a room or to tell somebody privately
   * but never be seen to do both. A room and a person are two errands, both
   * wanted at once, and each says for itself whether it can carry anything and
   * when it was last proved.
   */
  connection() {
    const hasWebhook = Boolean(this.store.secret('webhook.url'));
    const channels = this.channels();
    const hasGraph = this.#hasGraph();
    const botReady = Boolean(this.bot?.ready());
    const channel = { ready: hasWebhook || channels.length > 0, via: 'webhook', ...this.#check('channel') };
    const person = { ready: hasGraph || botReady, via: botReady ? (hasGraph ? 'bot-or-graph' : 'bot') : 'graph', ...this.#check('person') };
    // The newest of the two proofs, for anything that still reads one.
    const latest = [channel, person].filter((one) => one.checkedAt).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
    return {
      // Anything at all can be said, which is what a sender asks before trying.
      ready: channel.ready || person.ready,
      /** A room: the webhook posts as the app rather than as anybody. */
      channel,
      /** The rooms that have a webhook of their own, by name. Names only: a URL is a secret. */
      channels: channels.map((one) => one.name),
      /** One person, privately: as the bot to whoever has it installed, through Graph otherwise. */
      person,
      bot: this.bot ? this.bot.state() : null,
      hasWebhook,
      hasGraph,
      tenantId: this.store.setting('graph.tenantId', ''),
      clientId: this.store.setting('graph.clientId', ''),
      sender: this.store.setting('graph.sender', ''),
      checkedAt: latest?.checkedAt ?? null,
      checkError: latest?.checkError ?? null,
    };
  }

  /*
   * A direct message needs somebody it is from, so a registration without one
   * is not ready — saying it is would be a green light in front of a failure.
   */
  #hasGraph() {
    return Boolean(
      this.store.setting('graph.tenantId') && this.store.setting('graph.clientId') &&
      this.store.secret('graph.clientSecret') && this.store.setting('graph.sender'),
    );
  }

  /** When one way out was last tried, and what it said. */
  #check(what) {
    return {
      checkedAt: this.store.setting(`check.${what}.at`),
      checkError: this.store.setting(`check.${what}.error`),
    };
  }

  #noteCheck(what, error) {
    this.store.setSetting(`check.${what}.at`, new Date(this.now()).toISOString());
    this.store.setSetting(`check.${what}.error`, error ? String(error?.message ?? error) : null);
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

  saveConnection({ webhookUrl, tenantId, clientId, clientSecret, sender } = {}) {
    /*
     * Refuse first, write second.
     *
     * A URL that is not https is not kept, and nothing else in the same save
     * is written either.
     */
    const url = typeof webhookUrl === 'string' ? webhookUrl.trim() : null;
    if (url && !/^https:\/\//i.test(url)) throw new Error('A webhook URL has to be https.');

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

  // --- named rooms -------------------------------------------------------------

  /**
   * The rooms this machine can post in, each with its own webhook.
   *
   * An Incoming Webhook belongs to one channel, so "the right room" for
   * something — the payments team for the payments repository — is a second
   * webhook, and it needs a name a sender can ask for. The one webhook there
   * always was stays as the room for anything that names a room nobody set up,
   * which is every sender written before rooms had names.
   */
  channels() {
    let names;
    try {
      names = JSON.parse(this.store.setting('channels', '[]'));
    } catch {
      names = [];
    }
    return (Array.isArray(names) ? names : []).filter((name) => typeof name === 'string' && name.trim()).map((name) => ({ name, hasWebhook: Boolean(this.store.secret(channelKey(name))) }));
  }

  saveChannel({ name, webhookUrl } = {}) {
    const clean = channelName(name);
    if (!clean) throw new Error('A room needs a name — the one a sender will ask for it by.');
    const url = String(webhookUrl ?? '').trim();
    const known = this.channels().find((channel) => channelKey(channel.name) === channelKey(clean));
    if (!url && !known?.hasWebhook) throw new Error('A room needs the Incoming Webhook URL of its channel.');
    if (url && !/^https:\/\//i.test(url)) throw new Error('A webhook URL has to be https.');
    if (url) this.store.setSecret(channelKey(clean), url);
    if (!known) this.store.setSetting('channels', JSON.stringify([...this.channels().map((channel) => channel.name), clean]));
    this.changed();
    return this.channels();
  }

  forgetChannel(name) {
    const key = channelKey(name);
    this.store.setSecret(key, null);
    this.store.setSetting('channels', JSON.stringify(this.channels().map((channel) => channel.name).filter((one) => channelKey(one) !== key)));
    this.changed();
    return this.channels();
  }

  /** The webhook a room name reaches: its own, or the one there always was. */
  webhookFor(name) {
    const own = name ? this.store.secret(channelKey(name)) : null;
    return own || this.store.secret('webhook.url');
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
    // Buttons that act on a pull request, and speaking as you, are the Code Reviewer's alone.
    if (appId !== 'code-review') {
      message.about = null;
      message.voice = null;
    }
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
    const result = await this.#attempt(row, person, () => this.deliver(message, person));
    this.changed();
    return result;
  }

  /** A row already written as being tried, put on the wire, and written down as what became of it. */
  async #attempt(row, person, go) {
    try {
      await go();
      this.store.markSent(row.id);
      if (person) this.store.notePersonSent(person.handle);
      return { ok: true, id: row.id };
    } catch (error) {
      const detail = String(error?.message ?? error);
      this.store.markFailed(row.id, detail);
      return { ok: false, why: 'failed', detail, id: row.id };
    }
  }

  /** Put it on the wire, whichever way this machine is set up. */
  /**
   * Put it on the wire, by where it is going rather than by a switch.
   *
   * A channel and a person are two different errands, not two ways of doing
   * one. They were a single radio button — webhook *or* app registration — and
   * whichever was picked carried everything: with the webhook chosen, a message
   * addressed to one developer went into the channel where everybody read it.
   * Announcing to a room and telling somebody privately are both wanted, at the
   * same time, which is the shape this has now.
   */
  async deliver(message, person) {
    // The default room by no name at all, which no room called "default" can be
    // taken for — so a retry goes where the first try went.
    if (message.defaultRoom) return this.#toDefaultRoom(message);
    if (message.to.channel) return this.#toChannel(message);
    return this.#toPerson(message, person);
  }

  /** A room. The webhook is the app's own identity there, which is what a room wants. */
  async #toChannel(message) {
    const url = this.webhookFor(message.to.channel);
    if (!url) throw new Error(`There is no webhook for “${message.to.channel}”, and no default one to fall back on.`);
    return postWebhook(this.fetch, url, message);
  }

  /** One person, privately. */
  async #toPerson(message, person) {
    const address = person?.address;
    if (!address) throw new Error('There is no Teams address for them.');
    /*
     * As the bot, unless it is you speaking. The bot can only write first to
     * somebody who has it installed; anybody else is reached through Graph as
     * before, so nothing that used to arrive stops arriving.
     */
    if (message.voice !== 'me' && this.bot?.canReach(address)) {
      try {
        return await this.bot.sendTo(address, message);
      } catch (error) {
        if (!(error instanceof NoRoute)) throw error;
      }
    }
    const credentials = {
      tenantId: this.store.setting('graph.tenantId'),
      clientId: this.store.setting('graph.clientId'),
      clientSecret: this.store.secret('graph.clientSecret'),
      senderAddress: this.store.setting('graph.sender') || null,
    };
    if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
      throw new Error('The app registration is not filled in, so nothing can be said to somebody directly.');
    }
    if (!credentials.senderAddress) {
      throw new Error('Nobody is set as who these messages come from — a direct message is between two people.');
    }
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

  /**
   * A test message to one person, to find out whether a direct message works.
   *
   * Asked for what it needs rather than tried and refused for a reason that
   * sounds like a different problem — it used to answer "there is no Teams
   * address for them" when what it meant was "you did not type one".
   */
  async test(to) {
    const address = String(to ?? '').trim();
    if (!address) return { ok: false, error: 'Type somebody to send it to — a direct message has to go to a person.' };
    const message = rules.readMessage({
      to: { email: address },
      title: 'Smart Terminal can reach you here',
      body: 'Nothing is wrong. Somebody pressed “Send a test message” to find out whether this works.',
    });
    try {
      const person = this.store.rememberPerson({ handle: `email:${message.to.email}`, address: message.to.email, matchedBy: 'EMAIL' });
      await this.deliver(message, person);
      this.#noteCheck('person', null);
      this.changed();
      return { ok: true };
    } catch (error) {
      this.#noteCheck('person', error);
      this.changed();
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * A test message to one room, so each webhook can be proved on its own.
   *
   * No name is the default room — the webhook anything lands in when the room
   * it asks for was never set up — and that is the one the screen's own
   * "Send a test" for a channel means. Only that one is kept as the channel's
   * record: a named room proving itself is not the default room proving itself.
   */
  async testChannel(name) {
    const clean = channelName(name);
    // Something that cleans to nothing ("#", spaces) named a room and named it
    // badly; only no name at all means the default one.
    if (!clean && String(name ?? '').trim()) return { ok: false, error: 'Which room?' };
    if (!clean && !this.store.secret('webhook.url')) return { ok: false, error: 'There is no default webhook to test yet — paste one and save it first.' };
    const message = this.#forRoom(clean, {
      title: clean ? `Smart Terminal can post in ${clean}` : 'Smart Terminal can post here',
      body: 'Nothing is wrong. Somebody pressed “Send a test message” for this room to find out whether its webhook works.',
    });
    try {
      await this.deliver(message, null);
      if (!clean) this.#noteCheck('channel', null);
      this.changed();
      return { ok: true };
    } catch (error) {
      if (!clean) this.#noteCheck('channel', error);
      this.changed();
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  // --- saying something yourself ----------------------------------------------

  /**
   * A message you write here, to a room, to a person, or to both at once.
   *
   * The same two errands the senders have, without a sender in between: the
   * room is told as the app, the person is told privately. Each is tried and
   * answered for on its own, so a room that took it and a person who did not
   * are both said rather than one hiding the other.
   *
   * Nothing is judged. The hours, the ceilings and the "never twice" all
   * protect somebody from a machine that will not stop, and none of them is
   * about you pressing Send. It is still written in the outbox, from `you`,
   * like everything else that went out.
   */
  async compose({ title, body, channel, to } = {}) {
    const heading = String(title ?? '').trim();
    const text = String(body ?? '').trim();
    if (!heading && !text) throw new Error('There is nothing to say.');
    const room = channel == null || channel === false ? null : channelName(channel === true ? '' : channel);
    const address = String(to ?? '').trim();
    if (room === null && !address) throw new Error('Choose a room, somebody to tell, or both.');

    // With no title, the first line stands in for one — and the rest is still said.
    const [first, ...rest] = text.split('\n');
    const shared = heading
      ? { title: heading, body: text, level: 'urgent', key: null }
      : { title: first.slice(0, 120), body: first.length > 120 ? text : rest.join('\n').trim(), level: 'urgent', key: null };
    const out = { channel: null, person: null };

    if (room !== null) {
      const message = this.#forRoom(room, shared);
      out.channel = await this.#sendNow(message, null, room ? `#${room}` : '# the default room', () => this.deliver(message, null));
    }

    if (address) {
      if (!address.includes('@')) {
        out.person = { ok: false, why: 'no-address', detail: 'A person is reached by their Teams address — something@yourcompany.com.' };
      } else {
        const message = rules.readMessage({ ...shared, to: { email: address } });
        // Your words, from your own account when there is one; the bot otherwise.
        message.voice = this.#hasGraph() ? 'me' : null;
        const person = this.store.rememberPerson({ handle: `email:${address}`, address, matchedBy: 'EMAIL' });
        out.person = await this.#sendNow(message, person, address, () => this.deliver(message, person));
      }
    }

    this.changed();
    return { ok: true, ...out };
  }

  /**
   * A message for a room by name, or for the default room when there is none.
   *
   * The mark is set after `readMessage`, which drops it: only this service can
   * say "the default room", never a sender.
   */
  #forRoom(name, input) {
    const message = rules.readMessage({ ...input, to: { channel: name || 'the default room' } });
    if (!name) message.defaultRoom = true;
    return message;
  }

  /** The webhook there always was, asked for by no name at all. */
  #toDefaultRoom(message) {
    const url = this.store.secret('webhook.url');
    if (!url) throw new Error('There is no default webhook — paste one under “To a channel” first.');
    return postWebhook(this.fetch, url, message);
  }

  /** Written as being tried, then as what became of it — the same life as any other message. */
  async #sendNow(message, person, to, go) {
    const row = this.store.addMessage({
      appId: 'you', key: null, personId: person?.id ?? null, to,
      title: message.title, body: message.body, payload: message, state: 'SENDING', reason: null,
    });
    return this.#attempt(row, person, go);
  }

  overview() {
    return {
      connection: this.connection(),
      channels: this.channels(),
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
      /** Asked per destination, because a room and a person are reached differently. */
      canReach: (what) => Boolean(this.connection()[what === 'channel' ? 'channel' : 'person']?.ready),
      send: (appId, appName, message) => this.send(appId, appName, message),
    };
  }
}

/** A room's name as written, without the `#` people put in front of channel names out of habit. */
function channelName(name) {
  return String(name ?? '').trim().replace(/^#+/, '').trim().slice(0, 80);
}

/** Where a room's webhook is kept. Case does not make two rooms: `Payments` and `payments` are one. */
function channelKey(name) {
  return `webhook.channel.${channelName(name).toLowerCase()}`;
}

module.exports = { TeamsService, card, asText, channelName };
