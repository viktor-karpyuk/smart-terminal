'use strict';

/**
 * When a pull request has been waiting long enough to say something about it.
 *
 * This is the half that belongs to the reviewer: only it knows what an
 * unanswered comment is, or that a branch has not moved since changes were
 * asked for. *How* a message gets to somebody — an address, a quiet hour, a
 * ceiling — is a delivery extension's business, and none of it is here.
 *
 * Every rule is one sentence a person can read out loud, and every one of them
 * is measured from the last thing anybody actually said or did, never from a
 * timer the app set for itself.
 */

/** The rules, as they are stored and as the panel draws them. */
const RULES = {
  UNANSWERED: {
    label: 'A comment nobody answered',
    says: (days) => `A published comment of ours has had no reply for ${days} days, and no commit has arrived since.`,
    who: 'the pull request’s author',
    defaultDays: 3,
  },
  NO_COMMITS: {
    label: 'Changes requested and nothing moved',
    says: (days) => `We asked for changes ${days} days ago and the branch has not moved.`,
    who: 'the pull request’s author',
    defaultDays: 5,
  },
  UNREVIEWED: {
    label: 'A pull request nobody has reviewed',
    says: (days) => `It has been open ${days} days with no review at all.`,
    who: 'me',
    defaultDays: 2,
  },
};

const MODES = ['OFF', 'ASK', 'AUTO'];

function readRule(id, stored = {}) {
  const spec = RULES[id];
  if (!spec) return null;
  const days = Number(stored.days);
  const mode = MODES.includes(stored.mode) ? stored.mode : 'OFF';
  return {
    id,
    label: spec.label,
    who: spec.who,
    mode,
    days: Number.isFinite(days) && days > 0 ? Math.round(days) : spec.defaultDays,
  };
}

function readRules(stored = {}) {
  return Object.keys(RULES).map((id) => readRule(id, stored[id] ?? {}));
}

/*
 * A key names the thing being said, not the day it is being said on.
 *
 * All three keys used to end in a number that grew — how many days unanswered,
 * how old the pull request is — so no two days ever produced the same key, and
 * the delivery extension's "the same thing is not said twice within N days"
 * could never match anything. A pull request nobody had reviewed sent a message
 * every single day for three weeks, each one passing the check because the key
 * had moved. The age belongs in the words, where somebody reads it; the key is
 * only what tells "this again" from "something new".
 */

/**
 * Whether a pull request has tripped a rule, and what to say about it.
 *
 * `null` for every pull request that is fine, which is most of them. A closed,
 * merged or draft pull request trips nothing: nobody owes anybody an answer on
 * something that is not open.
 */
function dueFor({ row, threads = [], rules, skipMine = true, me = null }) {
  const pr = row?.pr;
  if (!pr || pr.state !== 'OPEN' || pr.isDraft) return null;

  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const on = (id) => {
    const rule = byId.get(id);
    return rule && rule.mode !== 'OFF' ? rule : null;
  };

  // Nothing is said to you about your own pull request; you are already looking at it.
  const mine = me && String(pr.author ?? '').toLowerCase() === String(me).toLowerCase();

  const unanswered = on('UNANSWERED');
  if (unanswered && !(skipMine && mine)) {
    // Threads still open, with the ball on their side, quiet for long enough.
    const waiting = threads.filter(
      (thread) => thread.state !== 'OK' && thread.state !== 'UNPUBLISHED' && (thread.waitingDays ?? -1) >= unanswered.days,
    );
    if (waiting.length) {
      const longest = Math.max(...waiting.map((thread) => thread.waitingDays ?? 0));
      return {
        rule: unanswered,
        to: pr.author,
        days: longest,
        key: `code-review:${row.repoId}:${pr.id}:unanswered`,
        title: `${row.repoName} #${pr.id} is waiting on you`,
        body: waiting.length === 1
          ? `A comment has had no answer for ${longest} days.`
          : `${waiting.length} comments have had no answer for ${longest} days.`,
        quote: waiting[0]?.title ?? null,
      };
    }
  }

  const stalled = on('NO_COMMITS');
  // "and nothing moved" is half the sentence: a branch that has had commits
  // since we asked is a branch somebody is working on, whatever the date says.
  if (stalled && !(skipMine && mine) && row.changesRequestedByUs && !row.movedSinceReview) {
    const since = row.changesRequestedDays;
    if (Number.isFinite(since) && since >= stalled.days) {
      return {
        rule: stalled,
        to: pr.author,
        days: since,
        key: `code-review:${row.repoId}:${pr.id}:no-commits`,
        title: `${row.repoName} #${pr.id} is waiting on you`,
        body: `Changes were asked for ${since} days ago and no commit has arrived since.`,
        quote: null,
      };
    }
  }

  const unreviewed = on('UNREVIEWED');
  if (unreviewed && row.flags?.includes('UNREVIEWED') && Number.isFinite(row.ageDays) && row.ageDays >= unreviewed.days) {
    return {
      rule: unreviewed,
      to: null, // yourself: there is nobody else to tell
      days: row.ageDays,
      key: `code-review:${row.repoId}:${pr.id}:unreviewed`,
      title: `${row.repoName} #${pr.id} has not been reviewed`,
      body: `It has been open ${row.ageDays} days by ${pr.author}, and nothing has looked at it.`,
      quote: pr.title,
    };
  }

  return null;
}

/**
 * The message, as the delivery extension's contract wants it.
 *
 * Nothing in here mentions Teams, a channel or an address: a person as the
 * forge names them, a few lines, and a link. Swap the delivery extension for
 * another and not a word of this changes.
 */
function asMessage(due, { row, provider, me }) {
  const pr = row.pr;
  /*
   * A person, named the way the forge names them — including you.
   *
   * `me` is the setting called "your name on the forge", a display name and not
   * an address. Building `email:Viktor Karpyuk` out of it produced a handle
   * nothing could ever match, so the one rule meant to tell *you* reached
   * nobody. Named like everybody else, you appear in the delivery extension's
   * own list of people and are matched there, once.
   */
  const forge = String(provider ?? 'forge').toLowerCase();
  const handle = due.to ? `${forge}:${due.to}` : (me ? `${forge}:${me}` : null);
  return {
    to: handle ? { handle, display: due.to ?? me } : {},
    title: due.title,
    body: due.body,
    quote: due.quote,
    facts: [
      { label: 'Pull request', value: `#${pr.id} ${pr.title}` },
      pr.sourceBranch ? { label: 'Branch', value: `${pr.sourceBranch} → ${pr.targetBranch}` } : null,
      { label: 'Waiting', value: `${due.days} days` },
    ].filter(Boolean),
    links: pr.url ? [{ text: 'Open the pull request', url: pr.url }] : [],
    key: due.key,
    level: 'normal',
    // So the bot can offer to look again, put it off, or fix it, right under the reminder.
    about: row.repoId ? { repoId: row.repoId, prId: pr.id } : null,
  };
}

module.exports = { RULES, MODES, readRule, readRules, dueFor, asMessage };
