'use strict';

/**
 * Letting sessions talk to each other.
 *
 * Two Claude sessions working on the same thing cannot see each other at all:
 * each one knows its own folder and its own conversation, and everything the
 * other has learned has to be carried across by hand. This is the channel that
 * removes the carrying — one session asks who else is here and says something to
 * them, and the message arrives in their conversation.
 *
 * Reach is deliberately narrow by default. A session reaches **its own group**,
 * because a group is the app's word for "these sessions are the same piece of
 * work"; that is the set where an unannounced message is useful rather than an
 * interruption. `all` widens it to every live session, and `off` closes it.
 *
 * The routing is kept here, pure and without a socket or a database in sight,
 * because who may speak to whom is the part that must be right.
 */

/** What a session may reach, given the setting and who is live. */
const REACH = ['off', 'group', 'all'];

function normalizeReach(value) {
  return REACH.includes(value) ? value : 'group';
}

/**
 * The sessions `senderId` may address.
 *
 * `roster` is every live session as `{ id, groupId, ... }`. The sender is never
 * in its own audience: a broadcast that came back to the sender would be read as
 * a reply to itself, and on a session with autopilot on that is a loop.
 *
 * An ungrouped session under `group` reach has no audience at all rather than an
 * audience of every other ungrouped session. "Not in a group" is not a group —
 * treating it as one would put unrelated work in earshot of each other, which is
 * exactly what the narrow default exists to prevent.
 */
function audienceFor(senderId, roster = [], reach = 'group') {
  const mode = normalizeReach(reach);
  if (mode === 'off') return [];

  const sender = roster.find((entry) => entry && entry.id === senderId);
  if (!sender) return [];

  const others = roster.filter((entry) => entry && entry.id !== senderId);
  if (mode === 'all') return others;
  if (!sender.groupId) return [];
  return others.filter((entry) => entry.groupId === sender.groupId);
}

/**
 * Resolve what a caller named into a session id it is allowed to address.
 *
 * A model naming a recipient will use whatever it saw in the roster — the name,
 * or the id, or the short id printed beside it — so all three resolve. Anything
 * outside the audience is refused by the same code path as a name that does not
 * exist: a session it may not reach must not be distinguishable from one that is
 * not there.
 */
function resolveRecipient(target, audience = []) {
  const wanted = String(target ?? '').trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();

  const byId = audience.find((entry) => entry.id === wanted);
  if (byId) return byId;

  const byShortId = audience.find((entry) => entry.id.startsWith(lower) && lower.length >= 6);
  if (byShortId) return byShortId;

  const named = audience.filter((entry) => String(entry.name ?? '').toLowerCase() === lower);
  // An ambiguous name is refused rather than guessed at: delivering to the wrong
  // session of two with the same name is worse than saying which two they are.
  if (named.length === 1) return named[0];
  if (named.length > 1) return { ambiguous: named };
  return null;
}

/**
 * A message as the recipient will read it.
 *
 * It is labelled, always. A line arriving in a conversation with no mark of where
 * it came from is indistinguishable from the user typing it, and a session that
 * cannot tell those apart cannot weigh them differently either.
 */
function formatMessage({ fromName, fromProfile, groupName, text, broadcast }) {
  const who = [fromName, fromProfile && `on ${fromProfile}`].filter(Boolean).join(' ');
  const scope = broadcast ? (groupName ? `everyone in ${groupName}` : 'every session') : 'you';
  return `[Smart Terminal · message from ${who} to ${scope}]\n${String(text ?? '').trim()}`;
}

module.exports = { REACH, normalizeReach, audienceFor, resolveRecipient, formatMessage };
