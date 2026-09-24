'use strict';

/**
 * The decisions this extension makes before anything leaves the machine.
 *
 * Pure functions, because every one of them is a rule somebody will want to
 * argue with, and an argument about a rule is only worth having against a test.
 * What they protect is the person on the other end: an extension decides *what*
 * is worth saying and *when*, and everything here decides whether it may.
 */

/** What an extension may hand over. Anything else is not a message. */
function readMessage(input = {}) {
  const text = (value, max) => String(value ?? '').trim().slice(0, max);
  const to = input.to && typeof input.to === 'object' ? input.to : {};
  const links = Array.isArray(input.links) ? input.links : [];
  const facts = Array.isArray(input.facts) ? input.facts : [];
  return {
    to: {
      email: text(to.email, 320) || null,
      handle: text(to.handle, 200) || null,
      channel: text(to.channel, 200) || null,
    },
    title: text(input.title, 300),
    body: text(input.body, 4000),
    quote: text(input.quote, 1000) || null,
    facts: facts
      .filter((fact) => fact && typeof fact === 'object')
      .slice(0, 12)
      .map((fact) => ({ label: text(fact.label, 60), value: text(fact.value, 300) }))
      .filter((fact) => fact.label && fact.value),
    // Only what a person can be sent to safely. A card's button opens a link and
    // nothing else, so a link that is not the web is a link that cannot be used.
    links: links
      .filter((link) => link && typeof link === 'object' && /^https:\/\//i.test(String(link.url ?? '')))
      .slice(0, 5)
      .map((link) => ({ text: text(link.text, 80) || 'Open', url: text(link.url, 2000) })),
    key: text(input.key, 200) || null,
    level: input.level === 'urgent' ? 'urgent' : 'normal',
  };
}

/** Enough to be worth anybody's attention. */
function problemWith(message) {
  if (!message.title) return 'a title is needed';
  if (!message.to.email && !message.to.handle && !message.to.channel) return 'nobody to send it to';
  return null;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Whether the clock allows it.
 *
 * Quiet hours hold a message rather than dropping it: something worth saying at
 * 23:40 is still worth saying at 09:00, and a rule that silently swallowed it
 * would make the whole thing untrustworthy. Urgent goes through — that is what
 * the word is for, and the extension that says it is accountable for it.
 */
function withinHours(at, { from = 9, to = 18, weekdaysOnly = true } = {}) {
  const when = at instanceof Date ? at : new Date(at);
  const day = when.getDay();
  if (weekdaysOnly && (day === 0 || day === 6)) return false;
  const hour = when.getHours() + when.getMinutes() / 60;
  /*
   * Both ends the same is the whole day.
   *
   * `9 and 9` read literally is "after nine and before nine", which is never —
   * a setting that looks like all day and holds everything for ever. Nobody
   * types two equal hours meaning silence, so it is the day, and the screen
   * says as much underneath the fields.
   */
  if (from === to) return true;
  // A window that wraps midnight is two windows, and both of them count.
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/**
 * The whole decision, given what is already known.
 *
 * Returns what to do with this message and why, in the words the outbox shows
 * and the caller is told: an extension that hears `no-address` can say so in
 * its own screen, which is the difference between a reminder that failed and a
 * reminder nobody knows did not happen.
 */
function decide({
  message,
  app,
  person,
  now = Date.now(),
  hours = {},
  dedupeDays = 7,
  perPersonPerDay = 1,
  sentByAppToday = 0,
  sentToPersonToday = 0,
  alreadySent = null,
}) {
  const problem = problemWith(message);
  if (problem) return { verdict: 'REFUSE', why: 'not-a-message', detail: problem };

  if (!app || app.stance === 'DENY') return { verdict: 'REFUSE', why: 'not-allowed' };

  // A channel is a place, not a person: no address to match and nobody's day to
  // protect, so the per-person rules do not apply to it.
  const toChannel = Boolean(message.to.channel);
  if (!toChannel && !person?.address) return { verdict: 'REFUSE', why: 'no-address' };

  if (alreadySent) return { verdict: 'HOLD', why: 'already-sent', detail: `said ${describeAge(now - Date.parse(alreadySent.sentAt ?? alreadySent.createdAt))} ago` };

  if (app.stance === 'ASK') return { verdict: 'ASK', why: 'asks-first' };

  // Zero is no ceiling, not a ban — the same as the per-person one, and the
  // Apps tab now says so where it always meant it.
  if (app.dailyCap > 0 && sentByAppToday >= app.dailyCap) {
    return { verdict: 'HOLD', why: 'app-cap', detail: `${app.name} has sent its ${app.dailyCap} for today` };
  }

  if (!toChannel && perPersonPerDay > 0 && sentToPersonToday >= perPersonPerDay) {
    return { verdict: 'HOLD', why: 'person-cap', detail: 'they have already heard from us today' };
  }

  if (message.level !== 'urgent' && !withinHours(now, hours)) {
    return { verdict: 'HOLD', why: 'quiet-hours', detail: 'outside the hours it may send in' };
  }

  void dedupeDays;
  return { verdict: 'SEND', why: null };
}

function describeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'a moment';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * An identifier as somebody's world names them, split into its two halves.
 *
 * `bitbucket:bchavez`, `github:viktor`, `email:a@b.c`, `rota:payments`. A bare
 * string with no colon is taken as an email when it looks like one and as a
 * handle otherwise, because an extension written before this existed should
 * not have to be rewritten to keep working.
 */
function readHandle(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const cut = text.indexOf(':');
  if (cut > 0) {
    const kind = text.slice(0, cut).toLowerCase();
    const name = text.slice(cut + 1).trim();
    if (name) return { kind, name, handle: `${kind}:${name}` };
  }
  if (text.includes('@')) return { kind: 'email', name: text, handle: `email:${text}` };
  return { kind: 'handle', name: text, handle: `handle:${text}` };
}

/*
 * The address a handle gives away on its own, when that is allowed.
 *
 * An `email:` handle used to be answered before the switch was consulted, so
 * turning "match by address on its own" off left it matching exactly the
 * handles most obviously made of an address. Off means off.
 */
function addressFrom(handle, { matchByEmail = true } = {}) {
  const read = readHandle(handle);
  if (!read || !matchByEmail) return null;
  if (read.kind === 'email') return read.name;
  return read.name.includes('@') ? read.name : null;
}

const DAY_MS = DAY;

module.exports = { readMessage, problemWith, withinHours, decide, readHandle, addressFrom, describeAge, DAY_MS };
