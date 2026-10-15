'use strict';

/**
 * The company's Smart Terminal server.
 *
 * Three audiences, three doors:
 * - the app on a developer's machine, with a device token (Bearer) it got by
 *   signing in with a password or with a company identity provider;
 * - the backoffice in a browser, with a session cookie, where an administrator
 *   creates accounts, sets up Microsoft or Google sign-in and reads the
 *   dashboard;
 * - the identity provider, coming back from a sign-in.
 *
 * Plain `node:http`, no framework: a small server whose every route is here.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./db');
const { hashPassword, checkPassword, makePassword, passwordProblem, limiter } = require('./auth');
const oidc = require('./oidc');
const { readReport, minutesFrom } = require('./report');
const { createRelay } = require('./relay');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/assets/app.css': 'text/css; charset=utf-8',
  '/assets/dashboard.js': 'text/javascript; charset=utf-8',
  '/assets/login.js': 'text/javascript; charset=utf-8',
  '/assets/terminal.js': 'text/javascript; charset=utf-8',
  '/assets/xterm.js': 'text/javascript; charset=utf-8',
  '/assets/xterm.css': 'text/css; charset=utf-8',
  '/assets/addon-fit.js': 'text/javascript; charset=utf-8',
};
const DEVICE_DAYS = 90;
const WEB_DAYS = 1;
const ONLINE_MS = 5 * 60_000;
const DEFAULTS = {
  orgName: 'Your company',
  ticketUrl: '',
  /** Repositories grouped into projects: [{ name, patterns: ['acme/api', 'acme/web-*'] }] */
  projects: [],
  /** Days of activity kept; 0 keeps everything. */
  retentionDays: 0,
  reportEveryMinutes: 2,
  ticketPattern: '\\b[A-Z][A-Z0-9]{1,9}-\\d{1,6}\\b',
  sharePaths: false,
  /** People may open their own sessions from the browser, when their app allows it too. */
  webTerminal: true,
  providers: [],
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** How far back a view looks: 7 or 30 days, or anything from 1 to 90 asked for. */
const periodOf = (url) => Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get('days')) || 7)));
const csvCell = (value) => {
  const text = String(value ?? '');
  // A cell a spreadsheet would read as a formula is written as text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
/** Which project a repository belongs to, by the first project with a matching pattern; `*` matches anything. */
function projectOf(repo, projects) {
  for (const project of projects ?? []) {
    for (const pattern of project.patterns ?? []) {
      const re = new RegExp(`^${String(pattern).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      if (re.test(repo)) return project.name;
    }
  }
  return null;
}

const emailOk = (email) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/.test(String(email ?? '').trim());
const day = (at) => new Date(at).toISOString().slice(0, 10);

function createServer({ dbFile, publicUrl, fetch = globalThis.fetch, now = Date.now, trustProxy = false } = {}) {
  const store = new Store(dbFile, { now });
  const sso = oidc.client({ fetch, now });
  const logins = limiter({ limit: 10, windowMs: 15 * 60_000, now });
  const base = String(publicUrl || '').replace(/\/+$/, '');

  const settings = () => ({ ...DEFAULTS, ...store.setting('org', {}) });
  /** What a device is told to do: never a secret. */
  const policy = () => {
    const s = settings();
    return { orgName: s.orgName, reportEveryMinutes: s.reportEveryMinutes, ticketPattern: s.ticketPattern, sharePaths: s.sharePaths, ticketUrl: s.ticketUrl, webTerminal: s.webTerminal !== false };
  };
  const publicProviders = () => settings().providers.filter((p) => p.enabled !== false && p.clientId)
    .map((p) => ({ id: p.id, label: p.label || (p.type === 'microsoft' ? 'Microsoft' : p.type === 'google' ? 'Google' : 'Single sign-on'), type: p.type }));
  const provider = (id) => settings().providers.find((p) => p.id === id && p.enabled !== false && p.clientId) ?? null;
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, team: u.team ?? '', disabled: Boolean(u.disabled_at), hasPassword: Boolean(u.pass_hash) });

  /** Retention, applied when the server starts and once a day after. */
  function applyRetention() {
    const keep = Number(settings().retentionDays) || 0;
    if (!keep) return 0;
    return store.forgetBefore(day(now() - keep * 86_400_000));
  }
  applyRetention();
  const retentionTimer = setInterval(applyRetention, 86_400_000);
  retentionTimer.unref?.();

  // --- plumbing --------------------------------------------------------------
  function send(res, status, body, headers = {}) {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      ...headers,
    });
    res.end(json);
  }
  const redirect = (res, to, headers = {}) => { res.writeHead(302, { location: to, 'cache-control': 'no-store', ...headers }); res.end(); };

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 512 * 1024) throw new HttpError(413, 'Too large.');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'That is not JSON.');
    }
  }

  const isHttps = (req) => Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

  function cookie(req, name) {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
  }
  function sessionCookie(req, value, maxAge) {
    return `org_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }

  /** The browser's signed-in user, or null. */
  const webUser = (req) => store.resolveToken(cookie(req, 'org_session'), 'web');

  const relay = createRelay({
    store,
    enabled: () => settings().webTerminal !== false,
    webUser,
    // A browser always says where a WebSocket comes from; one from another site is refused.
    sameOrigin: (req) => Boolean(req.headers.origin) && (!base || req.headers.origin === new URL(base).origin),
    log: (line) => console.log(line),
  });

  /**
   * A change made from the browser must come from this site's own pages: the
   * session cookie is Lax, and on top of that the Origin has to be ours and the
   * body JSON, which a plain cross-site form cannot send.
   */
  function sameSite(req) {
    const origin = req.headers.origin;
    if (origin && base && origin !== new URL(base).origin) throw new HttpError(403, 'Not from this site.');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  }
  function needWeb(req, role = null) {
    const who = webUser(req);
    if (!who) throw new HttpError(401, 'Sign in first.');
    if (role && who.user.role !== role) throw new HttpError(403, 'Only an administrator can do that.');
    return who;
  }
  function needDevice(req) {
    const header = String(req.headers.authorization ?? '');
    const who = header.startsWith('Bearer ') ? store.resolveToken(header.slice(7), 'device') : null;
    if (!who) throw new HttpError(401, 'This device is not signed in, or was signed out.');
    return who;
  }

  // --- signing in ------------------------------------------------------------
  async function passwordLogin(req, body) {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!logins.allow(`${clientIp(req)}|${email}`)) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
    const user = store.userByEmail(email);
    const ok = await checkPassword(String(body.password ?? ''), user?.pass_hash);
    if (!user || !ok || user.disabled_at) throw new HttpError(401, 'That e-mail and password do not match an account.');
    logins.reset(`${clientIp(req)}|${email}`);
    return user;
  }

  /** The user an SSO sign-in is for: one that exists, or one an allowed domain may create. */
  function userForSso(p, who) {
    let user = store.userByEmail(who.email);
    if (user?.disabled_at) throw new HttpError(403, 'That account is disabled.');
    if (!user) {
      const domain = who.email.split('@')[1];
      const allowed = (p.allowDomains ?? []).map((d) => String(d).toLowerCase());
      if (!allowed.includes(domain)) throw new HttpError(403, `${who.email} has no account here. Ask an administrator to add it.`);
      user = store.createUser({ email: who.email, name: who.name, role: 'member' });
    } else if (!user.name && who.name) {
      store.updateUser(user.id, { name: who.name });
    }
    return user;
  }

  function deviceAnswer(user, label) {
    const token = store.issueToken(user.id, { kind: 'device', label, days: DEVICE_DAYS });
    return { ok: true, token: token.secret, user: publicUser(user), policy: policy() };
  }

  // --- the dashboard's numbers -------------------------------------------------
  function overview(period = 7) {
    const t = now();
    const users = store.users();
    const snaps = store.snapshots();
    const since = day(t - (period - 1) * 86_400_000);
    const activity = store.activitySince(since);
    const usage = new Map(store.usageSince(since).map((u) => [u.user_id, u]));
    const projects = settings().projects;
    const people = users.map((u) => {
      const mine = snaps.filter((s) => s.user_id === u.id);
      const latest = mine.sort((a, b) => b.at - a.at)[0] ?? null;
      const devices = store.tokensOf(u.id).filter((tk) => tk.kind === 'device');
      const sessions = mine.filter((s) => t - s.at < ONLINE_MS).flatMap((s) => s.payload.sessions.map((x) => ({ ...x, device: s.label })));
      const accounts = mine.flatMap((s) => s.payload.accounts.map((a) => ({ ...a, device: s.label, reportedAt: s.at })));
      const mineActivity = activity.filter((a) => a.user_id === u.id);
      const top = (kind) => mineActivity.filter((a) => a.kind === kind).sort((a, b) => b.minutes - a.minutes).slice(0, 8)
        .map((a) => ({ key: a.key, minutes: Math.round(a.minutes) }));
      return {
        ...publicUser(u),
        online: Boolean(latest && t - latest.at < ONLINE_MS),
        paused: Boolean(latest?.payload.paused),
        lastSeen: latest?.at ?? null,
        devices: devices.map((d) => ({ id: d.id, label: d.label, lastSeen: d.last_seen_at })),
        sessions,
        accounts,
        repos: top('repo'),
        tickets: top('ticket'),
        hiddenSessions: mine.filter((s) => t - s.at < ONLINE_MS).reduce((n, s) => n + (Number(s.payload.hiddenSessions) || 0), 0),
        usageHistory: usage.has(u.id) ? {
          daysRanOut: Number(usage.get(u.id).days_ran_out) || 0,
          lowestWeekLeft: usage.get(u.id).lowest_week,
          lowestSessionLeft: usage.get(u.id).lowest_session,
        } : null,
      };
    });
    const totals = (kind) => {
      const by = new Map();
      for (const a of activity) if (a.kind === kind) by.set(a.key, (by.get(a.key) ?? 0) + a.minutes);
      return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([key, minutes]) => ({ key, minutes: Math.round(minutes) }));
    };
    const byProject = new Map();
    const byTeam = new Map();
    const teamOf = new Map(users.map((u) => [u.id, u.team || '']));
    for (const a of activity) {
      if (a.kind !== 'repo') continue;
      const project = projectOf(a.key, projects) ?? 'No project';
      byProject.set(project, (byProject.get(project) ?? 0) + a.minutes);
    }
    for (const d of store.all('SELECT user_id, SUM(minutes) AS minutes FROM days WHERE day >= ? GROUP BY user_id', since)) {
      const team = teamOf.get(d.user_id) || 'No team';
      byTeam.set(team, (byTeam.get(team) ?? 0) + d.minutes);
    }
    const ranked = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, minutes]) => ({ key, minutes: Math.round(minutes) }));
    return {
      orgName: settings().orgName, ticketUrl: settings().ticketUrl, period, since, now: t, people,
      repos: totals('repo'), tickets: totals('ticket'),
      projects: projects.length ? ranked(byProject) : [],
      teams: users.some((u) => u.team) ? ranked(byTeam) : [],
      teamNames: [...new Set(users.map((u) => u.team).filter(Boolean))].sort(),
    };
  }

  /**
   * One person's own numbers: what they see about themselves, in the backoffice
   * and in the app. Never anybody else's.
   */
  function personalStats(userId, period = 7) {
    const t = now();
    const days = [];
    for (let i = period - 1; i >= 0; i -= 1) days.push(day(t - i * 86_400_000));
    const worked = new Map(store.daysOf(userId, days[0]).map((d) => [d.day, d.minutes]));
    const me = overview(period).people.find((p) => p.id === userId);
    return {
      orgName: settings().orgName,
      ticketUrl: settings().ticketUrl,
      period,
      since: days[0],
      days: days.map((d) => ({ day: d, minutes: Math.round(worked.get(d) ?? 0) })),
      totalMinutes: Math.round(days.reduce((sum, d) => sum + (worked.get(d) ?? 0), 0)),
      repos: me?.repos ?? [],
      tickets: me?.tickets ?? [],
      sessions: me?.sessions ?? [],
      accounts: me?.accounts ?? [],
      devices: me?.devices ?? [],
      online: me?.online ?? false,
      paused: me?.paused ?? false,
      hiddenSessions: me?.hiddenSessions ?? 0,
      usageHistory: me?.usageHistory ?? null,
    };
  }

  // --- routes ------------------------------------------------------------------
  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const method = req.method;

    if (method === 'GET' && STATIC[p]) {
      const file = path.join(PUBLIC, path.basename(p));
      return send(res, 200, fs.readFileSync(file, 'utf8'), { 'content-type': STATIC[p], 'cache-control': 'no-cache' });
    }
    if (method === 'GET' && (p === '/' || p === '/login')) {
      const who = webUser(req);
      const page = who ? 'dashboard.html' : 'login.html';
      if (p === '/login' && who) return redirect(res, '/');
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, page), 'utf8'), {
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
    }
    if (method === 'GET' && p === '/terminal') {
      if (!webUser(req)) return redirect(res, '/login');
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'terminal.html'), 'utf8'), {
        // The terminal draws with style elements of its own; scripts stay as strict as everywhere else.
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
    }
    if (method === 'GET' && p === '/api/web/terminals') {
      const { user } = needWeb(req);
      return send(res, 200, { ok: true, enabled: settings().webTerminal !== false, devices: relay.devicesOf(user.id) });
    }
    if (method === 'GET' && p === '/api/health') return send(res, 200, { ok: true });
    if (method === 'GET' && p === '/api/providers') return send(res, 200, { orgName: settings().orgName, providers: publicProviders() });

    // ----- the app -----
    if (method === 'POST' && p === '/api/app/login') {
      const body = await readJson(req);
      const user = await passwordLogin(req, body);
      store.log(user.id, 'signin.app', String(body.device ?? 'a device'), 'password');
      return send(res, 200, deviceAnswer(user, String(body.device ?? 'a device')));
    }
    if (method === 'POST' && p === '/api/app/exchange') {
      const body = await readJson(req);
      const held = store.takePending(String(body.code ?? ''), 'app-code');
      if (!held) throw new HttpError(400, 'That sign-in expired. Try again.');
      const challenge = crypto.createHash('sha256').update(String(body.verifier ?? '')).digest('base64url');
      if (challenge !== held.challenge) throw new HttpError(400, 'That sign-in was started somewhere else.');
      const user = store.user(held.userId);
      if (!user || user.disabled_at) throw new HttpError(403, 'That account is disabled.');
      store.log(user.id, 'signin.app', String(body.device ?? 'a device'), 'single sign-on');
      return send(res, 200, deviceAnswer(user, String(body.device ?? 'a device')));
    }
    if (method === 'GET' && p === '/api/app/me') {
      const { user } = needDevice(req);
      return send(res, 200, { ok: true, user: publicUser(user), policy: policy() });
    }
    if (method === 'POST' && p === '/api/app/report') {
      const { user, token } = needDevice(req);
      const { report, error } = readReport(await readJson(req));
      if (error) throw new HttpError(400, error);
      const previous = store.snapshots().find((s) => s.token_id === token.id);
      const counted = minutesFrom(report, { previousAt: previous?.at ?? null, now: now(), everyMinutes: settings().reportEveryMinutes });
      if (!report.paused && counted.minutes > 0) {
        if (counted.repos.length || counted.tickets.length || report.sessions.some((s) => s.active)) {
          store.addDayMinutes(user.id, day(now()), counted.minutes);
        }
        for (const repo of counted.repos) store.addMinutes(user.id, day(now()), 'repo', repo, counted.minutes);
        for (const ticket of counted.tickets) store.addMinutes(user.id, day(now()), 'ticket', ticket, counted.minutes);
      }
      if (!settings().sharePaths) for (const s of report.sessions) s.path = '';
      if (!report.paused) {
        for (const a of report.accounts) {
          store.noteUsage(user.id, day(now()), a.name || 'Claude', a.sessionUsed == null ? null : 100 - a.sessionUsed, a.weekUsed == null ? null : 100 - a.weekUsed);
        }
      }
      store.saveSnapshot(token.id, user.id, report);
      return send(res, 200, { ok: true, policy: policy() });
    }
    if (method === 'GET' && p === '/api/app/stats') {
      const { user } = needDevice(req);
      return send(res, 200, { ok: true, ...personalStats(user.id, periodOf(url)) });
    }
    if (method === 'POST' && p === '/api/app/logout') {
      const { token } = needDevice(req);
      store.revokeToken(token.id);
      relay.forgetToken(token.id);
      return send(res, 200, { ok: true });
    }

    // ----- single sign-on, for the browser and for the app -----
    const startMatch = /^\/auth\/([a-z0-9-]{1,40})\/start$/.exec(p);
    if (method === 'GET' && startMatch) {
      const prov = provider(startMatch[1]);
      if (!prov) throw new HttpError(404, 'No such sign-in provider.');
      const forApp = url.searchParams.get('for') === 'app';
      const keep = { providerId: prov.id, forApp };
      if (forApp) {
        const appRedirect = String(url.searchParams.get('redirect') ?? '');
        // Only back to the app on this machine: a loopback address, as RFC 8252 says.
        if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/callback$/.test(appRedirect)) throw new HttpError(400, 'Not a sign-in the app started.');
        keep.appRedirect = appRedirect;
        keep.appState = String(url.searchParams.get('state') ?? '').slice(0, 200);
        keep.challenge = String(url.searchParams.get('challenge') ?? '').slice(0, 100);
        if (!keep.appState || keep.challenge.length < 43) throw new HttpError(400, 'Not a sign-in the app started.');
      }
      const started = await sso.start(prov, `${base}/auth/callback`);
      store.putPending(started.state, 'sso', { ...keep, ...started.keep }, 10 * 60_000);
      return redirect(res, started.url);
    }
    if (method === 'GET' && p === '/auth/callback') {
      const held = store.takePending(String(url.searchParams.get('state') ?? ''), 'sso');
      if (!held) throw new HttpError(400, 'That sign-in expired or was already used. Start again.');
      const prov = provider(held.providerId);
      if (!prov) throw new HttpError(404, 'That sign-in provider is no longer set up.');
      if (url.searchParams.get('error')) throw new HttpError(401, String(url.searchParams.get('error_description') || url.searchParams.get('error')).slice(0, 300));
      // Whatever the provider or its token got wrong is said to the person, not hidden as a server error.
      const who = await sso.finish(prov, String(url.searchParams.get('code') ?? ''), held).catch((error) => {
        throw new HttpError(401, String(error?.message ?? error).slice(0, 300));
      });
      const user = userForSso(prov, who);
      if (held.forApp) {
        const code = crypto.randomBytes(24).toString('base64url');
        store.putPending(code, 'app-code', { userId: user.id, challenge: held.challenge }, 2 * 60_000);
        const back = new URL(held.appRedirect);
        back.searchParams.set('code', code);
        back.searchParams.set('state', held.appState);
        return redirect(res, back.toString());
      }
      const token = store.issueToken(user.id, { kind: 'web', label: 'browser', days: WEB_DAYS });
      store.log(user.id, 'signin.web', '', `single sign-on (${prov.label || prov.type})`);
      return redirect(res, '/', { 'set-cookie': sessionCookie(req, token.secret, WEB_DAYS * 86_400) });
    }

    // ----- the backoffice -----
    if (method === 'POST' && p === '/api/web/login') {
      sameSite(req);
      const user = await passwordLogin(req, await readJson(req));
      const token = store.issueToken(user.id, { kind: 'web', label: 'browser', days: WEB_DAYS });
      store.log(user.id, 'signin.web', '', 'password');
      return send(res, 200, { ok: true, user: publicUser(user) }, { 'set-cookie': sessionCookie(req, token.secret, WEB_DAYS * 86_400) });
    }
    if (method === 'POST' && p === '/api/web/logout') {
      sameSite(req);
      const who = webUser(req);
      if (who) store.revokeToken(who.token.id);
      return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
    }
    if (method === 'GET' && p === '/api/web/me') {
      const { user } = needWeb(req);
      return send(res, 200, { ok: true, user: publicUser(user) });
    }
    if (method === 'GET' && p === '/api/web/stats') {
      const { user } = needWeb(req);
      return send(res, 200, { ok: true, ...personalStats(user.id, periodOf(url)) });
    }
    if (method === 'GET' && p === '/api/web/overview') {
      // Everybody's work is the administrators' view. A developer has their own: /api/web/stats.
      needWeb(req, 'admin');
      return send(res, 200, overview(periodOf(url)));
    }

    // ----- your own account, whoever you are -----
    if (method === 'GET' && p === '/api/web/account') {
      const { user, token } = needWeb(req);
      const devices = store.tokensOf(user.id).filter((t) => t.kind === 'device')
        .map((t) => ({ id: t.id, label: t.label, lastSeen: t.last_seen_at, createdAt: t.created_at }));
      return send(res, 200, { ok: true, user: publicUser(user), devices, ssoOnly: !user.pass_hash, thisSession: token.id });
    }
    if (method === 'POST' && p === '/api/web/password') {
      sameSite(req);
      const { user, token } = needWeb(req);
      const body = await readJson(req);
      if (!logins.allow(`${clientIp(req)}|password|${user.id}`)) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
      if (user.pass_hash && !(await checkPassword(String(body.current ?? ''), user.pass_hash))) throw new HttpError(400, 'Your current password is not right.');
      const problem = passwordProblem(body.next);
      if (problem) throw new HttpError(400, problem);
      store.setPassword(user.id, await hashPassword(String(body.next)));
      // Every other browser that was signed in as you is signed out; devices stay.
      for (const t of store.tokensOf(user.id)) if (t.kind === 'web' && t.id !== token.id) store.revokeToken(t.id);
      store.log(user.id, 'password.changed', user.email);
      return send(res, 200, { ok: true });
    }
    const ownDevice = /^\/api\/web\/devices\/([0-9a-f-]{36})$/.exec(p);
    if (method === 'DELETE' && ownDevice) {
      if (req.headers.origin && base && req.headers.origin !== new URL(base).origin) throw new HttpError(403, 'Not from this site.');
      const { user } = needWeb(req);
      const mine = store.tokensOf(user.id).find((t) => t.id === ownDevice[1] && t.kind === 'device');
      if (!mine) throw new HttpError(404, 'No such device of yours.');
      store.revokeToken(mine.id);
      relay.forgetToken(mine.id);
      store.log(user.id, 'device.signed_out', mine.label, 'by its owner');
      return send(res, 200, { ok: true });
    }

    // ----- administrators: one person, the log, an export -----
    const personMatch = /^\/api\/admin\/people\/([0-9a-f-]{36})\/stats$/.exec(p);
    if (method === 'GET' && personMatch) {
      needWeb(req, 'admin');
      if (!store.user(personMatch[1])) throw new HttpError(404, 'No such account.');
      return send(res, 200, { ok: true, ...personalStats(personMatch[1], periodOf(url)) });
    }
    if (method === 'GET' && p === '/api/admin/audit') {
      needWeb(req, 'admin');
      return send(res, 200, { ok: true, entries: store.auditLog(Number(url.searchParams.get('limit')) || 200) });
    }
    if (method === 'GET' && p === '/api/admin/export.csv') {
      const { user } = needWeb(req, 'admin');
      const period = periodOf(url);
      const since = day(now() - (period - 1) * 86_400_000);
      const teams = new Map(store.users().map((u) => [u.email, u.team ?? '']));
      const projects = settings().projects;
      const lines = [['date', 'name', 'email', 'team', 'what', 'key', 'project', 'minutes'].join(',')];
      for (const r of store.dayRows(since)) lines.push([r.day, r.name, r.email, teams.get(r.email), 'worked', '', '', Math.round(r.minutes)].map(csvCell).join(','));
      for (const r of store.activityRows(since)) {
        lines.push([r.day, r.name, r.email, teams.get(r.email), r.kind, r.key, r.kind === 'repo' ? projectOf(r.key, projects) ?? '' : '', Math.round(r.minutes)].map(csvCell).join(','));
      }
      store.log(user.id, 'export', `${period} days`);
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="smart-terminal-${since}-${day(now())}.csv"`,
        'cache-control': 'no-store',
      });
      return res.end(lines.join('\n') + '\n');
    }
    if (method === 'GET' && p === '/api/admin/users') {
      needWeb(req, 'admin');
      return send(res, 200, { users: store.users().map((u) => {
        const tokens = store.tokensOf(u.id);
        const devices = tokens.filter((t) => t.kind === 'device');
        const lastSeen = Math.max(0, ...tokens.map((t) => t.last_seen_at ?? 0)) || null;
        return { ...publicUser(u), devices: devices.length, lastSeen, createdAt: u.created_at };
      }) });
    }
    if (method === 'POST' && p === '/api/admin/users') {
      sameSite(req);
      needWeb(req, 'admin');
      const body = await readJson(req);
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!emailOk(email)) throw new HttpError(400, 'That is not an e-mail address.');
      if (store.userByEmail(email)) throw new HttpError(409, 'There is already an account with that e-mail.');
      const role = body.role === 'admin' ? 'admin' : 'member';
      let password = null;
      if (body.password !== 'sso-only') {
        password = body.password ? String(body.password) : makePassword();
        const problem = passwordProblem(password);
        if (problem) throw new HttpError(400, problem);
      }
      const user = store.createUser({ email, name: body.name ?? '', role, passHash: password ? await hashPassword(password) : null });
      if (body.team) store.updateUser(user.id, { team: String(body.team) });
      store.log(webUser(req).user.id, 'account.created', email, `${role}${password ? '' : ', single sign-on only'}`);
      // The generated password is shown once, to the administrator who made it.
      return send(res, 201, { ok: true, user: publicUser(user), password: body.password ? null : password });
    }
    const userMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})$/.exec(p);
    if (method === 'PATCH' && userMatch) {
      sameSite(req);
      const { user: me } = needWeb(req, 'admin');
      const target = store.user(userMatch[1]);
      if (!target) throw new HttpError(404, 'No such account.');
      const body = await readJson(req);
      if (target.id === me.id && (body.disabled === true || body.role === 'member')) {
        throw new HttpError(400, 'You cannot disable yourself or take away your own administrator role.');
      }
      store.updateUser(target.id, {
        name: body.name === undefined ? undefined : String(body.name),
        role: body.role === undefined ? undefined : body.role === 'admin' ? 'admin' : 'member',
        team: body.team === undefined ? undefined : String(body.team),
      });
      if (body.team !== undefined && String(body.team).trim() !== (target.team ?? '')) store.log(me.id, 'account.team', target.email, String(body.team).trim() || 'no team');
      if (body.disabled !== undefined) {
        store.setDisabled(target.id, body.disabled === true);
        if (body.disabled === true) relay.forgetUser(target.id);
        store.log(me.id, body.disabled === true ? 'account.disabled' : 'account.enabled', target.email);
      }
      if (body.role !== undefined && body.role !== target.role) store.log(me.id, 'account.role', target.email, body.role === 'admin' ? 'administrator' : 'developer');
      let password = null;
      if (body.resetPassword === true) {
        password = makePassword();
        store.setPassword(target.id, await hashPassword(password));
        store.log(me.id, 'account.password_reset', target.email);
      }
      return send(res, 200, { ok: true, user: publicUser(store.user(target.id)), password });
    }
    const deviceMatch = /^\/api\/admin\/devices\/([0-9a-f-]{36})$/.exec(p);
    if (method === 'DELETE' && deviceMatch) {
      if (req.headers.origin && base && req.headers.origin !== new URL(base).origin) throw new HttpError(403, 'Not from this site.');
      const { user: admin } = needWeb(req, 'admin');
      const device = store.get('SELECT t.label, u.email FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?', deviceMatch[1]);
      store.revokeToken(deviceMatch[1]);
      relay.forgetToken(deviceMatch[1]);
      store.log(admin.id, 'device.signed_out', device ? `${device.label} (${device.email})` : deviceMatch[1]);
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && p === '/api/admin/settings') {
      needWeb(req, 'admin');
      const s = settings();
      // Secrets are never sent back; the page only learns that one is set.
      return send(res, 200, { ...s, providers: s.providers.map(({ clientSecret, ...rest }) => ({ ...rest, hasSecret: Boolean(clientSecret) })), callbackUrl: `${base}/auth/callback` });
    }
    if (method === 'PUT' && p === '/api/admin/settings') {
      sameSite(req);
      needWeb(req, 'admin');
      const body = await readJson(req);
      const current = settings();
      const next = { ...current };
      if (typeof body.orgName === 'string') next.orgName = body.orgName.trim().slice(0, 80) || DEFAULTS.orgName;
      if (body.reportEveryMinutes !== undefined) next.reportEveryMinutes = Math.max(1, Math.min(60, Math.round(Number(body.reportEveryMinutes) || 2)));
      if (typeof body.ticketPattern === 'string') {
        try { new RegExp(body.ticketPattern, 'g'); } catch { throw new HttpError(400, 'The ticket pattern is not a valid regular expression.'); }
        next.ticketPattern = body.ticketPattern.slice(0, 200);
      }
      if (body.sharePaths !== undefined) next.sharePaths = body.sharePaths === true;
      if (body.webTerminal !== undefined) next.webTerminal = body.webTerminal === true;
      if (Array.isArray(body.projects)) {
        next.projects = body.projects.slice(0, 50).map((p) => ({
          name: String(p.name ?? '').trim().slice(0, 60),
          patterns: (Array.isArray(p.patterns) ? p.patterns : String(p.patterns ?? '').split(','))
            .map((x) => String(x).trim()).filter(Boolean).slice(0, 20).map((x) => x.slice(0, 120)),
        })).filter((p) => p.name && p.patterns.length);
      }
      if (body.retentionDays !== undefined) {
        const keep = Math.round(Number(body.retentionDays) || 0);
        if (keep !== 0 && (keep < 30 || keep > 3650)) throw new HttpError(400, 'Keep at least 30 days, or 0 to keep everything.');
        next.retentionDays = keep;
      }
      if (typeof body.ticketUrl === 'string') {
        const t = body.ticketUrl.trim();
        if (t && (!/^https:\/\//.test(t) || !t.includes('{ticket}'))) throw new HttpError(400, 'A ticket link is an https address with {ticket} where the ticket goes.');
        next.ticketUrl = t.slice(0, 300);
      }
      if (Array.isArray(body.providers)) {
        next.providers = body.providers.slice(0, 6).map((raw, i) => {
          const type = ['microsoft', 'google', 'oidc'].includes(raw.type) ? raw.type : 'oidc';
          const id = String(raw.id || type).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || `sso${i}`;
          const kept = current.providers.find((p) => p.id === id);
          const issuer = String(raw.issuer ?? '').trim();
          if (type === 'oidc' && !/^https:\/\//.test(issuer)) throw new HttpError(400, 'A generic provider needs an https issuer URL.');
          return {
            id,
            type,
            label: String(raw.label ?? '').slice(0, 40),
            clientId: String(raw.clientId ?? '').trim().slice(0, 200),
            // Blank keeps the one already stored.
            clientSecret: raw.clientSecret ? String(raw.clientSecret).slice(0, 500) : kept?.clientSecret ?? '',
            tenant: String(raw.tenant ?? '').trim().slice(0, 100),
            issuer,
            allowDomains: (Array.isArray(raw.allowDomains) ? raw.allowDomains : String(raw.allowDomains ?? '').split(','))
              .map((d) => String(d).trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)).slice(0, 20),
            enabled: raw.enabled !== false,
          };
        });
      }
      store.setSetting('org', next);
      if (next.retentionDays !== current.retentionDays) applyRetention();
      if (current.webTerminal !== false && next.webTerminal === false) relay.turnedOff();
      const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]) && k !== 'providers');
      if (JSON.stringify(next.providers.map(({ clientSecret, ...r }) => r)) !== JSON.stringify(current.providers.map(({ clientSecret, ...r }) => r))) changed.push('sign-in providers');
      store.log(webUser(req).user.id, 'settings.changed', '', changed.join(', ') || 'nothing');
      return send(res, 200, { ok: true });
    }

    throw new HttpError(404, 'Not found.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      const wantsJson = String(req.url).startsWith('/api/');
      const message = status === 500 ? 'Something went wrong on the server.' : error.message;
      if (wantsJson) return send(res, status, { ok: false, error: message });
      return send(res, status, `<!doctype html><meta charset="utf-8"><title>Smart Terminal</title><link rel="stylesheet" href="/assets/app.css"><main class="narrow"><h1>Could not sign in</h1><p>${message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p><p><a href="/">Back</a></p></main>`);
    });
  });

  server.on('upgrade', (req, socket) => relay.upgrade(req, socket));

  return { server, store, overview, relay };
}

module.exports = { createServer, DEFAULTS };
