'use strict';

/**
 * What a device may report, cut to size and to shape.
 *
 * Anything else in the body is dropped, every string is trimmed to a length,
 * every list to a count. A report that does not fit is refused rather than
 * stored half-read.
 */
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const percent = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
};

function readReport(body) {
  if (!body || typeof body !== 'object') return { error: 'The report is not an object.' };
  const sessions = Array.isArray(body.sessions) ? body.sessions.slice(0, 100) : [];
  const accounts = Array.isArray(body.accounts) ? body.accounts.slice(0, 12) : [];
  return {
    report: {
      appVersion: text(body.appVersion, 40),
      paused: body.paused === true,
      intervalSeconds: Math.max(0, Math.min(3600, Number(body.intervalSeconds) || 0)),
      sessions: body.paused === true ? [] : sessions.filter((s) => s && typeof s === 'object').map((s) => ({
        kind: s.kind === 'claude' ? 'claude' : 'shell',
        title: text(s.title, 120),
        folder: text(s.folder, 120),
        path: text(s.path, 500),
        repo: text(s.repo, 200),
        branch: text(s.branch, 200),
        tickets: (Array.isArray(s.tickets) ? s.tickets : []).map((t) => text(t, 40)).filter(Boolean).slice(0, 20),
        account: text(s.account, 80),
        busy: s.busy === true,
        active: s.active === true,
      })),
      accounts: body.paused === true ? [] : accounts.filter((a) => a && typeof a === 'object').map((a) => ({
        name: text(a.name, 80),
        email: text(a.email, 120),
        plan: text(a.plan, 40),
        sessionUsed: percent(a.sessionUsed),
        sessionResets: text(a.sessionResets, 80),
        weekUsed: percent(a.weekUsed),
        weekResets: text(a.weekResets, 80),
        readAt: Number.isFinite(Number(a.readAt)) ? Number(a.readAt) : null,
      })),
    },
  };
}

/**
 * Minutes of work in one report, by repository and by ticket.
 *
 * Only sessions that did something since the last report count, and the
 * minutes are the interval since then — capped, so a laptop that slept for
 * a night does not report a night's work when it wakes.
 */
function minutesFrom(report, { previousAt, now, everyMinutes }) {
  const cap = Math.max(1, everyMinutes) * 2;
  const elapsed = previousAt ? (now - previousAt) / 60_000 : everyMinutes;
  const minutes = Math.max(0, Math.min(cap, elapsed));
  const repos = new Set();
  const tickets = new Set();
  for (const session of report.sessions) {
    if (!session.active) continue;
    const where = session.repo || session.folder;
    if (where) repos.add(where);
    for (const ticket of session.tickets) tickets.add(ticket);
  }
  return { minutes, repos: [...repos], tickets: [...tickets] };
}

module.exports = { readReport, minutesFrom };
