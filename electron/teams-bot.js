'use strict';

/**
 * The Code Reviewer's bot, the half that runs on this machine.
 *
 * Teams cannot reach a laptop, so it talks to a small Function in Azure that
 * leaves every message on a queue (azure/bot-relay). This reads that queue,
 * decides what each message asks for (teams-bot-brain.js), does it through the
 * Code Reviewer's own verbs, and answers through the Bot Connector — as the bot,
 * which is what makes a direct message arrive from the Code Reviewer and not
 * from a person.
 *
 * It also writes first. Once somebody has the bot installed, Teams tells it so
 * and the conversation is remembered; from then on anything the app wants to
 * say to that person privately goes through the bot, with buttons that act on
 * the pull request it is about. Somebody the bot has never met is still reached
 * the old way, through Graph, and the screen says which is which.
 */

const brain = require('./teams-bot-brain');
const { card } = require('./teams-send');
const { closed } = require('./review-rules');

const LOGIN = 'https://login.microsoftonline.com';
const QUIET_AFTER_MS = 10 * 60 * 1000;
const FAST_MS = 5000;
const SLOW_MS = 20000;
const BACKOFF_MS = 60000;
const MAX_DEQUEUE = 5;

class NoRoute extends Error {}

// ── the queue ───────────────────────────────────────────────────────────────

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function parseQueue(xml) {
  const out = [];
  for (const [, block] of String(xml).matchAll(/<QueueMessage>([\s\S]*?)<\/QueueMessage>/g)) {
    const field = (name) => unxml((new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block) || [])[1] ?? '');
    out.push({ id: field('MessageId'), popReceipt: field('PopReceipt'), text: field('MessageText'), dequeueCount: Number(field('DequeueCount')) || 1 });
  }
  return out;
}

/** The Functions runtime writes base64 by default; plain JSON is accepted too. */
function decode(text) {
  const trimmed = String(text).trim();
  return JSON.parse(trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8'));
}

// ── the bot ─────────────────────────────────────────────────────────────────

class TeamsBot {
  /**
   * @param store   the Teams extension's store: settings, secrets and its people
   * @param review  { call(name, args) } — the Code Reviewer's verbs
   */
  constructor({ store, review, fetch, now = Date.now, log = () => {}, changed = () => {} }) {
    this.store = store;
    this.review = review;
    this.fetch = fetch;
    this.now = now;
    this.log = log;
    this.changed = changed;
    this.timer = null;
    this.running = false;
    this.token = null;
    this.lastHeard = 0;
    this.lastError = null;
    this.counts = {};
    this.inFlight = new Set();
  }

  // --- configuration ---------------------------------------------------------

  config() {
    return {
      tenantId: this.store.setting('bot.tenantId', ''),
      appId: this.store.setting('bot.appId', ''),
      secret: this.store.secret('bot.secret') ?? '',
      queueUrl: this.store.setting('bot.queueUrl', ''),
      queueSas: this.store.secret('bot.queueSas') ?? '',
    };
  }

  ready() {
    const c = this.config();
    return Boolean(c.tenantId && c.appId && c.secret && c.queueUrl && c.queueSas);
  }

  /** For the screen. Never a secret. */
  state() {
    const c = this.config();
    return {
      ready: this.ready(),
      running: this.running,
      tenantId: c.tenantId,
      appId: c.appId,
      queueUrl: c.queueUrl,
      hasSecret: Boolean(c.secret),
      hasQueueKey: Boolean(c.queueSas),
      people: Object.values(this.people()).map((p) => ({ name: p.name ?? null, address: p.address ?? null, since: p.since ?? null })),
      lastHeard: this.lastHeard || null,
      lastError: this.lastError,
    };
  }

  save({ tenantId, appId, secret, queueUrl, queueSas } = {}) {
    const text = (value) => (typeof value === 'string' ? value.trim() : null);
    if (text(queueUrl) && !/^https:\/\/[a-z0-9]+\.queue\.core\.windows\.net\/[a-z0-9-]+\/?$/i.test(text(queueUrl))) {
      throw new Error('The queue address looks like https://<account>.queue.core.windows.net/<queue>.');
    }
    if (text(tenantId) !== null) this.store.setSetting('bot.tenantId', text(tenantId));
    if (text(appId) !== null) this.store.setSetting('bot.appId', text(appId));
    if (text(queueUrl) !== null) this.store.setSetting('bot.queueUrl', text(queueUrl).replace(/\/+$/, ''));
    // A blank secret field means "keep the one you have", never "forget it".
    if (text(secret)) this.store.setSecret('bot.secret', text(secret));
    if (text(queueSas)) this.store.setSecret('bot.queueSas', text(queueSas).replace(/^\?/, ''));
    this.token = null;
    if (this.ready()) this.start();
    this.changed();
    return this.state();
  }

  // --- who it knows ------------------------------------------------------------

  people() {
    try {
      return JSON.parse(this.store.setting('bot.people', '{}')) ?? {};
    } catch {
      return {};
    }
  }

  remember(aadObjectId, patch) {
    if (!aadObjectId) return null;
    const all = this.people();
    const had = all[aadObjectId] ?? { since: this.now() };
    all[aadObjectId] = { ...had, ...patch, updatedAt: this.now() };
    this.store.setSetting('bot.people', JSON.stringify(all));
    return all[aadObjectId];
  }

  personByAddress(address) {
    const wanted = String(address ?? '').toLowerCase();
    if (!wanted) return null;
    return Object.entries(this.people()).find(([, p]) => String(p.address ?? '').toLowerCase() === wanted) ?? null;
  }

  /** Whether a private message to this address can go through the bot. */
  canReach(address) {
    return this.ready() && Boolean(this.personByAddress(address));
  }

  // --- snoozed reminders ---------------------------------------------------------

  snoozes() {
    try {
      return JSON.parse(this.store.setting('bot.snoozes', '{}')) ?? {};
    } catch {
      return {};
    }
  }

  /** Whether the reminders about this pull request are put off right now. */
  snoozed(repoId, prId) {
    const until = this.snoozes()[`${repoId}#${prId}`];
    return Boolean(until && until > this.now());
  }

  snooze(repoId, prId, days) {
    const all = this.snoozes();
    for (const [key, until] of Object.entries(all)) if (until <= this.now()) delete all[key];
    const until = this.now() + days * 24 * 60 * 60 * 1000;
    all[`${repoId}#${prId}`] = until;
    this.store.setSetting('bot.snoozes', JSON.stringify(all));
    return until;
  }

  // --- the Bot Connector -----------------------------------------------------------

  async accessToken() {
    if (this.token && this.token.expires > this.now() + 60_000) return this.token.value;
    const { tenantId, appId, secret } = this.config();
    const response = await this.fetch(`${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: secret, scope: 'https://api.botframework.com/.default' }).toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error(data.error_description || `signing the bot in answered ${response.status}`);
    this.token = { value: data.access_token, expires: this.now() + (Number(data.expires_in) || 3600) * 1000 };
    return this.token.value;
  }

  async connector(serviceUrl, path, { method = 'GET', body } = {}) {
    const base = String(serviceUrl).replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) throw new Error('The conversation has no service to answer through');
    const response = await this.fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Teams answered ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  /** Who is writing, as an address the people list knows. */
  async addressOf(activity) {
    const known = this.people()[activity.from?.aadObjectId];
    if (known?.address) return known.address;
    try {
      const member = await this.connector(
        activity.serviceUrl,
        `/v3/conversations/${encodeURIComponent(activity.conversation.id)}/members/${encodeURIComponent(activity.from.id)}`,
      );
      return String(member.email || member.userPrincipalName || '').toLowerCase() || null;
    } catch (error) {
      this.log(`teams bot: could not read who wrote: ${error.message}`);
      return null;
    }
  }

  async post(ref, activity) {
    return this.connector(ref.serviceUrl, `/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`, { method: 'POST', body: activity });
  }

  // --- saying things -----------------------------------------------------------------

  /** The same card the rest of Teams gets, with buttons that act when it is about a pull request. */
  cardFor(message) {
    const base = card(message);
    const about = message.about;
    if (!about?.repoId || !about?.prId) return base;
    const submit = (title, data) => ({ type: 'Action.Submit', title, data: { ...data, repoId: about.repoId, prId: about.prId } });
    return {
      ...base,
      actions: [
        ...base.actions,
        submit('Ver hallazgos', { action: 'findings' }),
        submit('Volver a revisar', { action: 'rereview' }),
        submit('Posponer 1 día', { action: 'snooze', days: 1 }),
      ],
    };
  }

  /**
   * A private message from the bot. Throws NoRoute when this person has never
   * had the bot installed, so the caller can reach them another way.
   */
  async sendTo(address, message) {
    const found = this.personByAddress(address);
    if (!this.ready() || !found) throw new NoRoute('The bot has not met them yet.');
    const [aad, ref] = found;
    await this.post(ref, {
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: this.cardFor(message) }],
    });
    if (message.about?.repoId) this.remember(aad, { about: { repoId: message.about.repoId, prId: message.about.prId } });
    return { ok: true, how: 'bot' };
  }

  async say(ref, text, extra = {}) {
    return this.post(ref, { type: 'message', text, textFormat: 'markdown', ...extra });
  }

  // --- listening ----------------------------------------------------------------------

  start() {
    if (this.timer || !this.ready()) return;
    this.running = true;
    const loop = async () => {
      let wait = this.now() - this.lastHeard < QUIET_AFTER_MS ? FAST_MS : SLOW_MS;
      try {
        await this.tick();
        if (this.lastError) {
          this.lastError = null;
          this.changed();
        }
      } catch (error) {
        const said = String(error?.message ?? error);
        if (said !== this.lastError) {
          this.lastError = said;
          this.changed();
        }
        wait = BACKOFF_MS;
      }
      if (this.running) this.timer = setTimeout(loop, wait);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  queueCall(path, init = {}) {
    const { queueUrl, queueSas } = this.config();
    const join = path.includes('?') ? '&' : '?';
    return this.fetch(`${queueUrl}${path}${join}${queueSas}`, { ...init, headers: { 'x-ms-version': '2021-12-02', ...(init.headers ?? {}) } });
  }

  async tick() {
    if (!this.ready()) return 0;
    const response = await this.queueCall('/messages?numofmessages=16&visibilitytimeout=90');
    if (!response.ok) throw new Error(response.status === 403 ? 'The queue key was refused; it may have expired.' : `Reading the queue answered ${response.status}`);
    const messages = parseQueue(await response.text());
    for (const message of messages) {
      let handled = false;
      try {
        const { activity } = decode(message.text);
        await this.handle(activity);
        handled = true;
      } catch (error) {
        this.log(`teams bot: ${error.message}`);
      }
      // Answered, or tried too often to be worth trying again: either way it is done.
      if (handled || message.dequeueCount >= MAX_DEQUEUE) {
        await this.queueCall(`/messages/${encodeURIComponent(message.id)}?popreceipt=${encodeURIComponent(message.popReceipt)}`, { method: 'DELETE' });
      }
    }
    if (messages.length) {
      this.lastHeard = this.now();
      this.changed();
    }
    return messages.length;
  }

  /** One thing Teams said. */
  async handle(activity) {
    if (!activity?.conversation?.id || !activity.serviceUrl) return;
    const personal = activity.conversation.conversationType === 'personal' || !activity.conversation.conversationType;
    const aad = activity.from?.aadObjectId;
    const ref = { conversationId: activity.conversation.id, serviceUrl: activity.serviceUrl, tenantId: activity.conversation.tenantId ?? activity.channelData?.tenant?.id ?? null };

    // Installed, or added to a chat: the one moment the bot learns how to write to somebody first.
    if (activity.type === 'conversationUpdate' || activity.type === 'installationUpdate') {
      if (personal && aad) {
        const address = await this.addressOf(activity);
        this.remember(aad, { ...ref, address, name: activity.from?.name ?? null });
        this.changed();
      }
      return;
    }
    if (activity.type !== 'message') return;

    const address = await this.addressOf(activity);
    const known = personal && aad ? this.remember(aad, { ...ref, address, name: activity.from?.name ?? null }) : null;
    const command = brain.readCommand(activity, known?.about ?? null);
    if (!command) return;
    const reply = (text, extra) => this.say(ref, text, extra);

    if (command.action === 'help') return reply(brain.HELP);
    if (command.action === 'unknown') return reply(`No entendí eso.\n\n${brain.HELP}`);
    if (!command.repoId || !command.prId) {
      return reply('¿Sobre qué PR? Usá los botones de uno de mis mensajes, o respondé a uno de ellos.');
    }

    const view = await this.review.call('pr', { repoId: command.repoId, prId: command.prId });
    if (!view || view.ok === false || !view.pr) return reply('Ese PR ya no está entre los que sigo.');
    const author = brain.isAuthor({
      senderAddress: address,
      people: this.store.people(),
      provider: view.repo?.provider,
      author: view.pr.author,
    });
    if (!author) return reply(`Eso lo puede pedir sólo el autor del PR #${view.pr.id}.`);

    const key = { conversation: ref.conversationId, pr: `${command.repoId}#${command.prId}`, action: command.action };
    if (command.action !== 'findings') {
      const refused = brain.withinCaps(this.counts, key, this.now());
      if (refused) return reply(refused);
      brain.countIn(this.counts, key, this.now());
    }
    if (aad) this.remember(aad, { about: { repoId: command.repoId, prId: command.prId } });
    return this.act(command, view, ref);
  }

  /** Doing it. The slow ones answer at once and again when they are done. */
  async act(command, view, ref) {
    const pr = view.pr;
    const label = `#${pr.id} ${pr.title}`;
    // Open the way the Code Reviewer means it, not a guess at its fields.
    const open = (view.findings ?? []).filter((f) => !closed(f));
    const finding = command.findingId ? (view.findings ?? []).find((f) => f.id === command.findingId) : null;
    if (command.findingId && !finding) return this.say(ref, 'Ese hallazgo ya no está en este PR.');

    switch (command.action) {
      case 'findings': {
        if (!open.length) return this.say(ref, `No hay hallazgos abiertos en ${label}.`);
        return this.post(ref, {
          type: 'message',
          attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: findingsCard(view, open) }],
        });
      }
      case 'snooze': {
        const until = this.snooze(command.repoId, command.prId, command.days);
        return this.say(ref, `Listo: no te recuerdo nada de ${label} hasta el ${new Date(until).toLocaleDateString('es')}.`);
      }
      case 'resolve': {
        const out = await this.review.call('closeFinding', { findingId: finding.id, closed: true });
        return this.say(ref, out?.ok === false ? `No pude marcarlo: ${out.error}` : `Marqué como resuelto: **${finding.title}**.`);
      }
      case 'rereview':
        return this.slow(ref, `rereview:${command.repoId}#${command.prId}`, `Arranco a revisar ${label} de nuevo. Te aviso cuando termine.`, async () => {
          const out = await this.review.call('review', { repoId: command.repoId, prId: command.prId });
          if (out?.ok === false) return `No pude revisar ${label}: ${out.error}`;
          const after = await this.review.call('pr', { repoId: command.repoId, prId: command.prId });
          const left = (after?.findings ?? []).filter((f) => !closed(f)).length;
          return `Terminé de revisar ${label}. ${left ? `Quedan ${left} hallazgos abiertos.` : 'No quedan hallazgos abiertos.'}`;
        });
      case 'fix':
        return this.slow(ref, `fix:${finding.id}`, `Arreglo **${finding.title}** y subo el commit a \`${pr.sourceBranch}\`. Te aviso.`, async () => {
          const fixed = await this.review.call('fix', { findingId: finding.id, note: 'Asked for by the author of the pull request, from Teams.' });
          if (fixed?.ok === false) return `No pude arreglarlo: ${fixed.error}`;
          const fix = fixed?.fix;
          if (!fix || fix.state !== 'COMMITTED' || !fix.sha) return 'Lo intenté pero no quedó un commit. Conviene mirarlo con una persona.';
          const back = await this.review.call('giveBack', { repoId: command.repoId, prId: command.prId, upToFixId: fix.id });
          if (back?.ok === false) return `El arreglo quedó hecho pero no pude pasarlo al repositorio: ${back.error}`;
          // Never forced, and only the pull request's own branch: the reviewer's push refuses anything else.
          const pushed = await this.review.call('push', { repoId: command.repoId, prId: command.prId });
          if (pushed?.ok === false) return `El arreglo está commiteado pero no pude subirlo: ${pushed.error}`;
          return `Subí el arreglo de **${finding.title}** a \`${pr.sourceBranch}\` (commit \`${String(fix.sha).slice(0, 8)}\`). Si no te convence, se puede deshacer desde el Code Reviewer.`;
        });
      default:
        return this.say(ref, brain.HELP);
    }
  }

  /** Answer now, do it without holding the queue, and answer again with how it went. */
  async slow(ref, key, starting, work) {
    if (this.inFlight.has(key)) return this.say(ref, 'Eso ya está en marcha.');
    this.inFlight.add(key);
    await this.say(ref, starting);
    void work()
      .then((text) => this.say(ref, text))
      .catch((error) => this.say(ref, `Algo salió mal: ${String(error?.message ?? error)}`))
      .catch((error) => this.log(`teams bot: could not report back: ${error.message}`))
      .finally(() => this.inFlight.delete(key));
    return null;
  }
}

/** Every open finding with its two buttons. */
function findingsCard(view, open) {
  const pr = view.pr;
  const shown = open.slice(0, 8);
  const button = (title, action, finding) => ({
    type: 'Action.Submit',
    title,
    data: { action, repoId: view.repo?.id ?? pr.repoId, prId: pr.id, findingId: finding.id },
  });
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: `#${pr.id} ${pr.title}`, weight: 'Bolder', size: 'Medium', wrap: true },
      { type: 'TextBlock', text: `${open.length} hallazgo${open.length === 1 ? '' : 's'} abierto${open.length === 1 ? '' : 's'}`, isSubtle: true, spacing: 'None' },
      ...shown.map((finding) => ({
        type: 'Container',
        separator: true,
        spacing: 'Medium',
        items: [
          { type: 'TextBlock', text: finding.title, weight: 'Bolder', wrap: true },
          finding.path ? { type: 'TextBlock', text: `${finding.path}${finding.line ? `:${finding.line}` : ''}`, isSubtle: true, spacing: 'None', wrap: true } : null,
          { type: 'ActionSet', actions: [button('Arreglar y subir', 'fix', finding), button('Marcar resuelto', 'resolve', finding)] },
        ].filter(Boolean),
      })),
      open.length > shown.length ? { type: 'TextBlock', text: `Y ${open.length - shown.length} más en el Code Reviewer.`, isSubtle: true } : null,
    ].filter(Boolean),
  };
}

module.exports = { TeamsBot, NoRoute, parseQueue, decode, findingsCard };
