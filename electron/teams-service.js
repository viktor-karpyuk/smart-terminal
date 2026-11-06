'use strict';

const { TeamsStore } = require('./teams-store');
const rules = require('./teams-rules');
const { NoRoute } = require('./teams-bot');
const { postWebhook, sendDirect, tokenCache, startSignIn, checkSignIn, whoAmI, SignedOut, card, asText } = require('./teams-send');

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
  constructor({
    db, secrets, fetch, notify = () => {}, emit = () => {}, now = Date.now,
    openExternal = () => {},
    later = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  }) {
    // One clock for deciding and for stamping: the store dates its rows by the same "now".
    this.store = new TeamsStore(db, secrets, () => this.now());
    this.fetch = fetch;
    this.notify = notify;
    this.emit = emit;
    this.now = now;
    this.openExternal = openExternal;
    this.later = later;
    this.tokens = tokenCache();
    /** A sign-in somebody has started and not finished at Microsoft yet. Memory only. */
    this.signing = null;
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
    const botRooms = botReady ? Object.values(this.bot.rooms()).map((room) => room.name) : [];
    const channel = { ready: hasWebhook || channels.length > 0 || botRooms.length > 0, via: botRooms.length ? 'webhook-or-bot' : 'webhook', ...this.#check('channel') };
    const person = { ready: hasGraph || botReady, via: botReady ? (hasGraph ? 'bot-or-graph' : 'bot') : 'graph', ...this.#check('person') };
    // The newest of the two proofs, for anything that still reads one.
    const latest = [channel, person].filter((one) => one.checkedAt).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
    return {
      // Anything at all can be said, which is what a sender asks before trying.
      ready: channel.ready || person.ready,
      /** A room: the webhook posts as the app rather than as anybody. */
      channel,
      /** Every room a sender can name: a webhook of its own, or a chat the bot is in. Names only: a URL is a secret. */
      channels: [...new Set([...channels.map((one) => one.name), ...botRooms])],
      /** One person, privately: as the bot to whoever has it installed, through Graph otherwise. */
      person,
      bot: this.bot ? this.bot.state() : null,
      hasWebhook,
      hasGraph,
      tenantId: this.store.setting('graph.tenantId', ''),
      clientId: this.store.setting('graph.clientId', ''),
      sender: hasGraph ? this.store.setting('graph.me.address', '') : '',
      /** Who is signed in: a name and an address, never a token. */
      signedInAs: hasGraph ? { name: this.store.setting('graph.me.name', ''), address: this.store.setting('graph.me.address', '') } : null,
      /** The code to type at Microsoft while a sign-in is under way. It is good for nothing else. */
      signingIn: this.signing ? { code: this.signing.code, url: this.signing.url } : null,
      signInError: this.store.setting('graph.signInError'),
      checkedAt: latest?.checkedAt ?? null,
      checkError: latest?.checkError ?? null,
    };
  }

  /*
   * A direct message is written by whoever signed in, so with nobody signed in
   * it is not ready — saying it is would be a green light in front of a failure.
   */
  #hasGraph() {
    return Boolean(this.store.setting('graph.clientId') && this.store.secret('graph.refreshToken'));
  }

  // --- signing in as yourself ---------------------------------------------------

  /**
   * A code, and Microsoft's page opened to type it into.
   *
   * The rest happens at Microsoft. This finds out by asking every few seconds,
   * which is how the device code flow is meant to be used, and it needs no
   * secret here: what it gets is good only for the person who signed in.
   */
  async signIn() {
    const clientId = this.store.setting('graph.clientId', '');
    if (!clientId) throw new Error('Put in the Client ID of the app registration first, and save it.');
    const tenantId = this.store.setting('graph.tenantId', '');
    this.store.setSetting('graph.signInError', null);
    const started = await startSignIn(this.fetch, { tenantId, clientId });
    const attempt = { ...started, tenantId, clientId, expiresAt: this.now() + started.expiresIn * 1000 };
    this.signing = attempt;
    this.later(() => this.#poll(attempt), attempt.interval * 1000);
    try { this.openExternal(started.url); } catch { /* the code and the address are on screen */ }
    this.changed();
    return { ok: true, code: started.code, url: started.url };
  }

  async #poll(attempt) {
    if (this.signing !== attempt) return;
    const stop = (reason) => {
      this.signing = null;
      if (reason) this.store.setSetting('graph.signInError', reason);
      this.changed();
    };
    if (this.now() > attempt.expiresAt) return stop('The code expired before it was used. Sign in again.');
    let result;
    try {
      result = await checkSignIn(this.fetch, attempt);
    } catch {
      // The network blinked. The code is still good until it expires.
      result = { state: 'pending' };
    }
    if (this.signing !== attempt) return;
    if (result.state === 'failed') return stop(result.reason);
    if (result.state === 'done') {
      try {
        const me = await whoAmI(this.fetch, result.accessToken);
        this.store.setSecret('graph.refreshToken', result.refreshToken);
        this.store.setSetting('graph.me.name', me.name);
        this.store.setSetting('graph.me.address', me.address);
        this.tokens.forget();
        return stop(null);
      } catch (error) {
        return stop(String(error?.message ?? error));
      }
    }
    if (result.state === 'slower') attempt.interval += 5;
    this.later(() => this.#poll(attempt), attempt.interval * 1000);
  }

  /** Signed out here, or a sign-in under way called off. */
  signOut() {
    this.signing = null;
    this.store.setSetting('graph.signInError', null);
    this.#forgetSignIn();
    this.changed();
    return this.connection();
  }

  #forgetSignIn() {
    this.signing = null;
    this.store.setSecret('graph.refreshToken', null);
    this.store.setSetting('graph.me.name', null);
    this.store.setSetting('graph.me.address', null);
    this.tokens.forget();
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

  saveConnection({ webhookUrl, tenantId, clientId } = {}) {
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
     * The webhook URL is never sent back to the panel — the field shows a
     * placeholder saying so — which means pressing Save without retyping sends
     * an empty string. Saving the Connection screen without touching it used to
     * delete a working webhook and every reminder after it came back with
     * nowhere to go.
     */
    if (url) this.store.setSecret('webhook.url', url);

    /*
     * A different registration or tenant is a different sign-in.
     *
     * A refresh token belongs to the client it was issued for, so keeping one
     * across a change would show "signed in" in front of a refusal.
     */
    const identity = () => `${this.store.setting('graph.tenantId', '')}:${this.store.setting('graph.clientId', '')}`;
    const before = identity();
    if (typeof tenantId === 'string') this.store.setSetting('graph.tenantId', tenantId.trim());
    if (typeof clientId === 'string') this.store.setSetting('graph.clientId', clientId.trim());
    if (identity() !== before) this.#forgetSignIn();
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

  async send(appId, appName, input, { chosen = false } = {}) {
    const message = rules.readMessage(input);
    // Buttons that act on a pull request, and speaking as you, are the Code Reviewer's alone.
    if (appId !== 'code-review') {
      message.about = null;
      message.voice = null;
      message.to.mention = [];
      message.byHand = false;
      message.group = null;
    }
    // Said by the app itself, never by an extension: somebody picked this room for this by hand, so it goes without asking
    // each time — the same as pressing Send. "Never" (Deny) still means never.
    if (chosen) message.byHand = true;
    const app = this.store.seeApp(appId, appName);
    const settings = this.settings();

    const { person, handle, decision } = this.#judge(message, app, { display: input?.to?.display ?? '' });
    const to = message.to.channel
      ? `#${message.to.channel}${message.to.mention.map((one) => ` @${one.display || one.handle}`).join('')}`
      : (person?.display ?? handle ?? '');
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
    // Meant for somebody and nobody knows who they are on Teams: asked, not posted
    // past them, so the same "Who is …?" that a direct message gets can answer it.
    if (message.to.channel && this.#tagsFor(message).some((one) => !one.tag)) {
      const row = record('SKIPPED', 'no-address');
      this.changed();
      return { ok: false, why: 'no-address', detail: null, id: row.id };
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
    if (message.group) return this.#toPerson(message, { address: message.group });
    if (message.to.channel) return this.#toChannel(message);
    return this.#toPerson(message, person);
  }

  /**
   * A room: its own webhook if it has one, then a chat or channel the bot is in,
   * then the webhook there always was. The webhook posts one way; the bot's post
   * can be answered, which is why a chat of the bot's beats the catch-all.
   */
  async #toChannel(message) {
    const tag = this.#requiredTags(message);
    const name = message.to.channel;
    const own = this.store.secret(channelKey(name));
    if (own) return postWebhook(this.fetch, own, message, tag);
    const room = this.bot?.roomNamed(name);
    if (room) return this.bot.sendToRoom(room, message, tag);
    const url = this.webhookFor(name);
    if (!url) throw new Error(`There is no webhook or chat called “${name}”, and no default one to fall back on.`);
    return postWebhook(this.fetch, url, message, tag);
  }

  /** Everybody a post is meant for who can be tagged, as Teams knows them. */
  #tagsFor(message) {
    return message.to.mention.map((mention) => {
      const read = rules.readHandle(mention.handle);
      if (!read) return { mention, tag: null };
      const address = rules.addressFrom(read.handle, { matchByEmail: this.settings().matchByEmail });
      const person = this.store.rememberPerson({ handle: read.handle, display: mention.display, address, matchedBy: address ? 'EMAIL' : null });
      return { mention, tag: person?.address ? { address: person.address, name: mention.display || read.name } : null };
    });
  }

  #requiredTags(message) {
    const found = this.#tagsFor(message);
    const missing = found.find((one) => !one.tag);
    if (missing) throw new Error(`There is no Teams address for ${missing.mention.display || missing.mention.handle}, so they cannot be tagged.`);
    return found.map((one) => one.tag);
  }

  /** One person, privately. */
  async #toPerson(message, person) {
    const address = person?.address;
    if (!address) throw new Error('There is no Teams address for them.');
    /*
     * As the bot, unless it is you speaking. The bot can only write first to
     * somebody who has it installed; anybody else is reached through whoever
     * signed in, so nothing that used to arrive stops arriving.
     */
    if (message.voice !== 'me' && this.bot?.canReach(address)) {
      try {
        return await this.bot.sendTo(address, message);
      } catch (error) {
        if (!(error instanceof NoRoute)) throw error;
      }
    }
    if (!this.#hasGraph()) throw new Error('Nobody is signed in to Teams here, so nothing can be said to somebody directly.');
    const credentials = {
      tenantId: this.store.setting('graph.tenantId'),
      clientId: this.store.setting('graph.clientId'),
      refreshToken: this.store.secret('graph.refreshToken'),
      senderAddress: this.store.setting('graph.me.address') || null,
      keep: (next) => this.store.setSecret('graph.refreshToken', next),
    };
    try {
      return await sendDirect(this.fetch, credentials, this.tokens, { address, message });
    } catch (error) {
      if (!(error instanceof SignedOut)) throw error;
      // Said once, on the screen where it can be fixed, instead of failing the same way for ever.
      this.#forgetSignIn();
      this.store.setSetting('graph.signInError', 'Your sign-in ended. Sign in again.');
      this.changed();
      throw new Error('The sign-in to Teams ended; sign in again on the Teams panel.');
    }
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
  async compose({ title, body, channel, to, mention, together = false } = {}) {
    const heading = String(title ?? '').trim();
    const text = String(body ?? '').trim();
    if (!heading && !text) throw new Error('There is nothing to say.');
    const room = channel == null || channel === false ? null : channelName(channel === true ? '' : channel);
    const addresses = listOf(to);
    if (room === null && !addresses.length) throw new Error('Choose a room, somebody to tell, or both.');

    // With no title, the first line stands in for one — and the rest is still said.
    const [first, ...rest] = text.split('\n');
    const shared = heading
      ? { title: heading, body: text, level: 'urgent', key: null }
      : { title: first.slice(0, 120), body: first.length > 120 ? text : rest.join('\n').trim(), level: 'urgent', key: null };
    const out = { channel: null, person: null };

    if (room !== null) {
      const tags = listOf(mention);
      if (tags.some((one) => !one.includes('@'))) {
        out.channel = { ok: false, why: 'no-address', detail: 'Somebody is tagged by their Teams address — something@yourcompany.com.' };
      } else {
        const message = this.#forRoom(room, shared, tags.map((one) => ({ handle: `email:${one}`, display: this.#nameOf(one) })));
        const label = `${room ? `#${room}` : '# the default room'}${message.to.mention.map((one) => ` @${one.display}`).join('')}`;
        out.channel = await this.#sendNow(message, null, label, () => this.deliver(message, null));
      }
    }

    const wrong = addresses.find((one) => !one.includes('@'));
    if (wrong) {
      out.person = { ok: false, why: 'no-address', detail: `A person is reached by their Teams address — something@yourcompany.com, not “${wrong}”.` };
    } else if (together && addresses.length > 1) {
      // One message in one chat: all of them see it and each other.
      const message = rules.readMessage({ ...shared, to: { email: addresses[0] } });
      message.group = addresses;
      message.voice = 'me';
      out.person = await this.#sendNow(message, null, `chat: ${addresses.map((one) => this.#nameOf(one)).join(', ')}`, () => this.deliver(message, null));
    } else if (addresses.length) {
      out.people = [];
      for (const address of addresses) {
        const message = rules.readMessage({ ...shared, to: { email: address } });
        // Your words, from your own account when there is one; the bot otherwise.
        message.voice = this.#hasGraph() ? 'me' : null;
        const person = this.store.rememberPerson({ handle: `email:${address}`, address, matchedBy: 'EMAIL' });
        out.people.push({ address, ...await this.#sendNow(message, person, address, () => this.deliver(message, person)) });
      }
      const failed = out.people.filter((one) => !one.ok);
      out.person = addresses.length === 1
        ? out.people[0]
        : { ok: !failed.length, why: failed.length ? 'failed' : undefined, detail: failed.map((one) => `${one.address}: ${one.detail ?? one.why}`).join('; ') || undefined };
    }

    this.changed();
    return { ok: true, ...out };
  }

  /** The name somebody is known by here, or their address. */
  #nameOf(address) {
    const known = this.store.people().find((one) => String(one.address ?? '').toLowerCase() === address.toLowerCase() && !one.display.includes(':'));
    return known?.display ?? address;
  }

  /**
   * A message for a room by name, or for the default room when there is none.
   *
   * The mark is set after `readMessage`, which drops it: only this service can
   * say "the default room", never a sender.
   */
  #forRoom(name, input, mention = null) {
    const message = rules.readMessage({ ...input, to: { channel: name || 'the default room', mention } });
    if (!name) message.defaultRoom = true;
    return message;
  }

  /** The webhook there always was, asked for by no name at all. */
  #toDefaultRoom(message) {
    const url = this.store.secret('webhook.url');
    if (!url) throw new Error('There is no default webhook — paste one under “To a channel” first.');
    return postWebhook(this.fetch, url, message, this.#requiredTags(message));
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

  renameBotRoom(id, name) {
    if (!this.bot) throw new Error('The bot needs both Teams and the Code Reviewer running.');
    const bot = this.bot.renameRoom(String(id ?? ''), name);
    this.changed();
    return bot;
  }

  forgetBotRoom(id) {
    if (!this.bot) throw new Error('The bot needs both Teams and the Code Reviewer running.');
    const bot = this.bot.forgetRoom(String(id ?? ''));
    this.changed();
    return bot;
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

/** Several addresses, however they were written or handed over, each once. */
function listOf(value) {
  const all = [].concat(value ?? []).flatMap((one) => String(one).split(/[\s,;]+/)).map((one) => one.trim()).filter(Boolean);
  const seen = new Set();
  return all.filter((one) => !seen.has(one.toLowerCase()) && seen.add(one.toLowerCase()));
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
