'use strict';

/**
 * The app's side of the session-to-session channel.
 *
 * Every MCP server spawned beside a Claude session connects here over a unix
 * socket in the app's own data directory — local, unreachable from the network,
 * and gone when the app is. It answers three questions: who can I reach, say
 * this to them, and what has been said to me.
 *
 * **Delivery is the part worth being careful about.** A message is typed into the
 * recipient's terminal, which is the same act as the user typing it, so it is
 * only ever done to a session that is genuinely idle at its prompt. A session
 * that is mid-turn, or sitting on a dialog, is left alone and the message waits.
 * Typing into a dialog does not deliver a message — it answers a question on the
 * user's behalf, and `looksLikeADecision` is the veto that already knows what
 * that looks like.
 *
 * Nothing is dropped. A message that cannot be delivered now is in the database,
 * and it is delivered when the session is next free or read on demand.
 */

const fs = require('node:fs');
const net = require('node:net');
const { audienceFor, normalizeReach, resolveRecipient, formatMessage, formatNote } = require('./messaging');

/**
 * Who a message from the app itself is from.
 *
 * Not a session, and not null: the column is `NOT NULL` and should stay that
 * way, since a sender is the one thing a message cannot be missing. A reserved
 * id says the same thing without loosening the schema — and no session can
 * collide with it, because session ids are UUIDs.
 */
const APP_SENDER = 'smart-terminal';

/** How often the queue is retried against sessions that were busy. */
const SWEEP_MS = 4000;

/**
 * Claude's input box does not submit when the text and the Return arrive in the
 * same write. The same 700ms autopilot learned the hard way applies here, for the
 * same reason — and getting it wrong means the message is typed and never sent.
 */
const SUBMIT_DELAY_MS = 700;

class MessageBridge {
  /**
   * @param {object} deps
   * @param {string} deps.socketPath          where the MCP servers connect
   * @param {() => string} deps.reach         'off' | 'group' | 'all'
   * @param {() => Array} deps.roster         live sessions, with group and state
   * @param {(id: string, text: string) => boolean} deps.write   type into a session
   * @param {(id: string) => boolean} deps.isFree   idle at a Claude prompt, no dialog up
   * @param {object} deps.store               the queue: queue/pending/markDelivered/markRead
   */
  constructor({ socketPath, reach, roster, write, isFree, store, health = null, lookup = null }) {
    this.socketPath = socketPath;
    this.reach = reach;
    this.roster = roster;
    this.write = write;
    this.isFree = isFree;
    this.store = store;
    /** How a session is behaving, asked of the monitor. Optional: without it the
     *  channel still carries messages, it just cannot answer for anyone. */
    this.health = health;
    /** Sessions the app knows but is not running, so "gone" can be told from
     *  "never existed" — two answers that need completely different replies. */
    this.lookup = lookup;
    this.server = null;
    this.sweep = null;
  }

  start() {
    // A socket file left by a crash would refuse the bind; it names nothing that
    // can still be listening, since the listener died with the app that made it.
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* not there, which is the normal case */
    }
    this.server = net.createServer((socket) => this.#serve(socket));
    this.server.on('error', (error) => {
      console.log(`[messages] the channel could not open: ${error.message}`);
    });
    this.server.listen(this.socketPath);
    this.sweep = setInterval(() => this.flush(), SWEEP_MS);
    this.sweep.unref?.();
  }

  stop() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
    try {
      this.server?.close();
    } catch {
      /* already down */
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* already gone */
    }
  }

  #serve(socket) {
    let buffer = '';
    socket.on('error', () => socket.destroy());
    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      const cut = buffer.indexOf('\n');
      if (cut === -1) return;
      const line = buffer.slice(0, cut);
      buffer = '';
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: 'unreadable request' })}\n`);
        return;
      }
      let answer;
      try {
        answer = await this.handle(request);
      } catch (error) {
        answer = { ok: false, error: String(error?.message ?? error) };
      }
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  }

  /**
   * Put a note from the app itself into a session's conversation.
   *
   * Not a message from anybody: it queues through the same store so it obeys the
   * same rule that makes any of this bearable — it is delivered when the session
   * is next waiting at its prompt, never onto work in progress and never onto a
   * question it is asking the user.
   */
  note(sessionId, body, { subject = null, fromName = 'monitor' } = {}) {
    const text = String(body ?? '').trim();
    if (!sessionId || !text) return { ok: false, error: 'A note needs a session and something to say.' };
    this.store.queue({ from: APP_SENDER, to: sessionId, fromName, body: formatNote({ text, subject }) });
    const delivered = this.flush();
    return {
      ok: true,
      delivered: delivered.includes(sessionId),
      detail: delivered.includes(sessionId)
        ? 'It arrived in the session.'
        : 'The session is busy; it is waiting and arrives the moment it is free.',
    };
  }

  /**
   * Hand a fresh session its brief.
   *
   * Unlike a note, this is not wrapped in anything: it *is* the first thing said
   * to that session, and a header explaining who it came from would only invite
   * an answer about the header. It rides the same queue, so it arrives when the
   * session is at its prompt and not before — which for a session that has just
   * been started means once Claude has finished coming up.
   */
  handOver(sessionId, text) {
    const body = String(text ?? '').trim();
    if (!sessionId || !body) return { ok: false, error: 'A handover needs a session and something to say.' };
    this.store.queue({ from: APP_SENDER, to: sessionId, fromName: 'handover', body });
    const delivered = this.flush();
    return { ok: true, delivered: delivered.includes(sessionId) };
  }

  /**
   * Why a message could not be addressed — which is three different answers.
   *
   * Collapsing them into "no session called that" is what sends a session round
   * in circles: it is told something false about a session that plainly exists,
   * has nothing to act on, and tries again. Each of these leaves somebody
   * something to do.
   */
  #whyNot(target, from, roster, reach) {
    const wanted = String(target ?? '').trim();

    // Running, but the reach does not include it.
    const beyond = resolveRecipient(wanted, roster.filter((entry) => entry.id !== from));
    if (beyond && !beyond.ambiguous) {
      return (
        `"${beyond.name}" is running, but it is outside your reach: you can talk to ` +
        `${reach === 'group' ? 'the other sessions in your own group' : 'every session'}, and it is ` +
        `${beyond.groupName ? `in group ${beyond.groupName}` : 'in no group'}. ` +
        'Tell the user: they can put you both in one group, or widen the reach to every session.'
      );
    }
    if (beyond?.ambiguous) {
      return `More than one session is called that: ${beyond.ambiguous.map((s) => `${s.name} (${s.id.slice(0, 8)})`).join(', ')}. Use an id.`;
    }

    // Known to the app, but not running — the case that reads as "does not
    // exist" and is nothing of the sort.
    const past = this.lookup?.(wanted) ?? null;
    if (past) {
      return (
        `"${past.title ?? wanted}" is a session the app knows, but it is not running` +
        `${past.endedAt ? ` — it ended ${new Date(past.endedAt).toLocaleString()}` : ''}. ` +
        'Nothing can be delivered to it. Its conversation is still on disk, so the user can open it again, ' +
        'and then it can be reached like any other.'
      );
    }

    return `Nothing running or on record matches "${wanted}". Call list_sessions to see who is there.`;
  }

  /** Every request, resolved against the live roster. Kept separate so it is testable. */
  async handle(request) {
    const { op, from } = request ?? {};
    if (!from) return { ok: false, error: 'This session did not identify itself.' };

    const reach = normalizeReach(this.reach());
    const roster = this.roster();
    const me = roster.find((entry) => entry.id === from);
    if (!me) return { ok: false, error: 'Smart Terminal does not have this session as running.' };
    const audience = audienceFor(from, roster, reach);

    if (op === 'roster') {
      const reachable = new Set(audience.map((entry) => entry.id));
      return {
        ok: true,
        reach,
        group: me.groupName ?? null,
        // Who you are, which a session cannot otherwise tell: it knows its own
        // id and nothing else about how the app has it listed.
        you: { id: me.id, name: me.name, conversation: me.conversation ?? null, group: me.groupName ?? null },
        sessions: audience.map((entry) => ({
          id: entry.id,
          name: entry.name,
          profile: entry.profile,
          cwd: entry.cwd,
          conversation: entry.conversation ?? null,
          group: entry.groupName ?? null,
          state: entry.state,
        })),
        // The ones that exist but are out of reach. Naming them turns "there is
        // no session called that" — which is false and unhelpable — into "it is
        // there, and here is why you cannot reach it".
        beyond: roster
          .filter((entry) => entry.id !== from && !reachable.has(entry.id))
          .map((entry) => ({ name: entry.name, group: entry.groupName ?? null })),
      };
    }

    // Asking how you are going is not messaging, so reach does not gate it for
    // yourself — only for asking about anybody else.
    if (op === 'health') {
      if (!this.health) return { ok: false, error: 'Smart Terminal is not measuring sessions.' };
      const scope = request.scope === 'reach' ? 'reach' : 'me';
      if (scope === 'me') {
        return { ok: true, scope, me: this.health(from), name: me.name };
      }
      if (reach === 'off') {
        return { ok: false, error: 'Session messaging is turned off, so you cannot ask about others.' };
      }
      return {
        ok: true,
        scope,
        reach,
        me: this.health(from),
        name: me.name,
        others: audience
          .map((entry) => ({ name: entry.name, verdict: this.health(entry.id, { brief: true }) }))
          .filter((entry) => entry.verdict),
      };
    }

    if (op === 'inbox') {
      const waiting = this.store.pending(from, { unreadOnly: true });
      if (request.peek !== true && waiting.length) {
        this.store.markRead(waiting.map((m) => m.id));
      }
      return {
        ok: true,
        messages: waiting.map((m) => ({ from: m.fromName, at: m.at, text: m.body })),
      };
    }

    if (op === 'send' || op === 'broadcast') {
      if (reach === 'off') {
        return { ok: false, error: 'Session messaging is turned off in Smart Terminal.' };
      }
      const body = String(request.message ?? '').trim();
      if (!body) return { ok: false, error: 'A message needs something in it.' };

      let targets;
      if (op === 'broadcast') {
        targets = audience;
      } else {
        const found = resolveRecipient(request.to, audience);
        if (found?.ambiguous) {
          return {
            ok: false,
            error:
              `More than one session you can reach is called that: ` +
              `${found.ambiguous.map((s) => `${s.name} (${s.id.slice(0, 8)})`).join(', ')}. ` +
              'Use the id.',
          };
        }
        if (!found) {
          return { ok: false, error: this.#whyNot(request.to, from, roster, reach) };
        }
        targets = [found];
      }

      if (!targets.length) {
        return {
          ok: false,
          error:
            reach === 'group'
              ? 'There is nobody else in your group to tell.'
              : 'There are no other sessions running.',
        };
      }

      const text = formatMessage({
        fromName: me.name,
        fromProfile: me.profile,
        groupName: me.groupName,
        text: body,
        broadcast: op === 'broadcast',
      });
      for (const target of targets) {
        this.store.queue({ from, to: target.id, fromName: me.name, body: text });
      }
      const delivered = this.flush();

      const who =
        op === 'broadcast'
          ? `${targets.length} session${targets.length === 1 ? '' : 's'}`
          : targets[0].name;
      const waiting = targets.length - delivered.filter((id) => targets.some((t) => t.id === id)).length;
      return {
        ok: true,
        detail:
          `Sent to ${who}.` +
          (waiting > 0
            ? ` ${waiting === targets.length ? (targets.length === 1 ? 'It is' : 'They are') : `${waiting} of them are`} ` +
              'not free to take it right now — working, or stopped on a question — so it is ' +
              'waiting in their inbox and arrives the moment they are.'
            : ' It arrived in their conversation.'),
      };
    }

    return { ok: false, error: `Unknown request: ${op}` };
  }

  /**
   * Deliver everything queued for a session that is free to receive it.
   *
   * Returns the sessions written to, so a caller can tell the sender whether the
   * message landed or is waiting.
   */
  flush() {
    const landed = [];
    for (const message of this.store.pending(null, { undeliveredOnly: true })) {
      if (!this.isFree(message.to)) continue;
      if (!this.write(message.to, message.body)) continue;
      // The Return goes separately, or Claude's input box takes the text and
      // never submits it — the message would sit in the box looking delivered.
      setTimeout(() => this.write(message.to, '\r'), SUBMIT_DELAY_MS);
      this.store.markDelivered([message.id]);
      landed.push(message.to);
    }
    return landed;
  }
}

module.exports = { APP_SENDER, MessageBridge, SUBMIT_DELAY_MS };
