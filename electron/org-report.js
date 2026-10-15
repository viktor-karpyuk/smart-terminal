'use strict';

/**
 * What this machine tells its company's Smart Terminal server, worked out
 * from what the app already knows. Pure, so what is said can be read and
 * tested apart from how it is sent.
 *
 * Per open session: what kind it is, its title, the folder and repository it
 * is in, the branch, the tickets those name, which account it runs on, and
 * whether anything happened in it lately. Per account: how much of the session
 * and the week is used. Nothing else — no file contents, no conversation, no
 * commands — and the full path only when the company asks for it.
 */

/** `git@github.com:acme/api.git`, `https://user:token@bitbucket.org/acme/api` → `acme/api`. */
function repoName(remote) {
  const text = String(remote ?? '').trim();
  if (!text) return '';
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(text.replace(/^[a-z]+:\/\/[^@/]*@/i, 'x://'));
  return match ? match[1] : '';
}

/** Every distinct match of the company's ticket pattern in these texts, in order. */
function ticketsIn(texts, pattern, { anyCase = [] } = {}) {
  let re;
  let loose;
  try {
    re = new RegExp(pattern, 'g');
    // Branch names are usually lower case (`feature/ks-142-totals`); titles and
    // commit subjects are matched as written, so "utf-8" is not a ticket.
    loose = new RegExp(pattern, 'gi');
  } catch {
    return [];
  }
  const found = [];
  for (const [index, text] of texts.entries()) {
    const which = anyCase.includes(index) ? loose : re;
    which.lastIndex = 0;
    for (const match of String(text ?? '').matchAll(which)) {
      const ticket = match[0].toUpperCase();
      if (ticket && !found.includes(ticket)) found.push(ticket);
      if (found.length >= 20) return found;
    }
  }
  return found;
}

const folderName = (cwd) => String(cwd ?? '').split('/').filter(Boolean).pop() ?? '';

/** Whether this folder is one of the never-shared ones, or inside one. */
function isPrivate(cwd, privateFolders) {
  const at = String(cwd ?? '').replace(/\/+$/, '');
  if (!at) return false;
  return (privateFolders ?? []).some((folder) => {
    const root = String(folder ?? '').replace(/\/+$/, '');
    return root && (at === root || at.startsWith(`${root}/`));
  });
}

/**
 * @param sessions  [{ kind, title, cwd, profileName, lastWorkedAt, lastOutputAt }]
 * @param repos     Map cwd → { remote, branch, subject } (what git said about that folder)
 * @param accounts  [{ name, email, plan, usage }]
 * @param privateFolders  folders whose sessions are only counted, never described
 */
function buildReport({ sessions, repos, accounts, policy, appVersion, paused, now, intervalSeconds, privateFolders = [] }) {
  if (paused) return { appVersion, paused: true, intervalSeconds, sessions: [], accounts: [] };
  const window = Math.max(60, intervalSeconds) * 1000;
  const shared = sessions.filter((s) => !isPrivate(s.cwd, privateFolders));
  return {
    appVersion,
    paused: false,
    intervalSeconds,
    hiddenSessions: sessions.length - shared.length,
    sessions: shared.map((s) => {
      const git = repos.get(s.cwd) ?? {};
      return {
        kind: s.kind === 'claude' ? 'claude' : 'shell',
        title: String(s.title ?? '').slice(0, 120),
        folder: folderName(s.cwd),
        path: policy.sharePaths ? String(s.cwd ?? '') : '',
        repo: repoName(git.remote) || (git.root ? folderName(git.root) : ''),
        branch: git.branch ?? '',
        tickets: ticketsIn([git.branch, s.title, git.subject], policy.ticketPattern, { anyCase: [0] }),
        account: s.profileName ?? '',
        busy: Boolean(s.lastOutputAt && now - s.lastOutputAt < 20_000),
        active: Boolean((s.lastWorkedAt && now - s.lastWorkedAt < window) || (s.lastOutputAt && now - s.lastOutputAt < window)),
      };
    }),
    accounts: accounts.map((a) => ({
      name: a.name ?? '',
      email: a.email ?? '',
      plan: a.plan ?? '',
      sessionUsed: a.usage?.session?.percentUsed ?? null,
      sessionResets: a.usage?.session?.resets ?? '',
      weekUsed: a.usage?.week?.percentUsed ?? null,
      weekResets: a.usage?.week?.resets ?? '',
      readAt: a.usage?.readAt ?? null,
    })),
  };
}

module.exports = { repoName, ticketsIn, buildReport, folderName, isPrivate };
