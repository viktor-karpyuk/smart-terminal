'use strict';

/*
 * The backoffice. Everything a developer's machine reported is put on the page
 * as text, never as markup.
 */
const $ = (id) => document.getElementById(id);
const svgNs = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    // Through the CSSOM: the page's policy refuses style attributes, and a
    // width set as one is silently ignored — every bar drawn full, or empty.
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(3)) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
  return node;
}
function icon(d) {
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const part of d.split('|')) {
    const p = document.createElementNS(svgNs, 'path');
    p.setAttribute('d', part);
    svg.append(p);
  }
  return svg;
}
const ICONS = {
  mine: 'M10 10a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 10 10Z|M3.8 16.6c.9-2.8 3.3-4.3 6.2-4.3s5.3 1.5 6.2 4.3',
  team: 'M7.2 9a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4Z|M2.4 16c.7-2.4 2.6-3.7 4.8-3.7s4.1 1.3 4.8 3.7|M13.4 9.2a2.3 2.3 0 1 0 0-4.6|M14.6 12.4c1.6.4 2.7 1.6 3.1 3.6',
  work: 'M3 16.5h14|M5.5 16.5V10|M10 16.5V5|M14.5 16.5v-8',
  users: 'M3.5 5.5h13v10h-13z|M7 9h6|M7 12h4',
  settings: 'M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z|M10 2.8v2|M10 15.2v2|M2.8 10h2|M15.2 10h2|M4.9 4.9l1.4 1.4|M13.7 13.7l1.4 1.4|M4.9 15.1l1.4-1.4|M13.7 6.3l1.4-1.4',
  chevron: 'M7.5 5l5 5-5 5',
  account: 'M6.5 8.5V6.3a3.5 3.5 0 0 1 7 0v2.2|M4.5 8.5h11v8h-11z|M10 11.6v2',
  log: 'M5 4.5h10|M5 8.5h10|M5 12.5h6|M5 16.5h4',
  download: 'M10 3.5v9|M6.5 9l3.5 3.5L13.5 9|M4 16.5h12',
  copy: 'M7 7h9v9H7z|M4 13V4h9',
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) location.href = '/login';
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

function toast(text, bad = false) {
  const t = el('div', { class: `toast${bad ? ' is-bad' : ''}` }, text);
  $('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

// ---------- words and numbers ----------
const ago = (at) => {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const duration = (m) => {
  if (!m) return '0 min';
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  return rest ? `${h} h ${rest} min` : `${h} h`;
};
const initials = (person) => {
  const from = (person.name || person.email || '?').replace(/@.*/, '');
  const parts = from.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const weekday = (iso, long = false) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: long ? 'long' : 'short' });

function personState(p) {
  if (!p.online) return { key: 'off', text: p.lastSeen ? `Away, seen ${ago(p.lastSeen)}` : 'Has not signed in from the app yet' };
  if (p.paused) return { key: 'paused', text: 'Sharing paused' };
  if (p.sessions.some((s) => s.busy || s.active)) return { key: 'working', text: 'Working now' };
  return { key: 'idle', text: 'Online, idle' };
}

// ---------- pieces ----------
function gauge(label, used, title) {
  if (used == null) return null;
  const left = Math.max(0, 100 - used);
  const tone = left < 15 ? ' is-low' : left < 40 ? ' is-mid' : '';
  return el('div', { class: 'gauge', title: title || `${left}% of the ${label.toLowerCase()} left` },
    el('span', { class: 'gauge-label' }, label),
    el('span', { class: 'gauge-track' }, el('span', { class: `gauge-fill${tone}`, style: `width:${left}%` })),
    el('span', { class: 'gauge-value' }, `${left}%`));
}

function accountBlock(a) {
  return el('div', { class: 'gauges' },
    el('div', { class: 'small' }, el('strong', {}, a.name || 'Claude'), a.plan ? el('span', { class: 'faint' }, `  ${a.plan} plan`) : null),
    gauge('Session', a.sessionUsed, a.sessionResets ? `Resets ${a.sessionResets}` : null),
    gauge('Week', a.weekUsed, a.weekResets ? `Resets ${a.weekResets}` : null),
    el('div', { class: 'faint small' }, [a.weekResets ? `Week resets ${a.weekResets}` : null, `read ${ago(a.readAt || a.reportedAt)}`].filter(Boolean).join(', ')));
}

function ranked(rows, empty, { tickets = false } = {}) {
  if (!rows.length) return el('p', { class: 'faint' }, empty);
  const most = Math.max(...rows.map((r) => r.minutes), 1);
  return el('ol', { class: 'ranked' }, rows.map((r) => el('li', {},
    el('span', { class: 'key' }, tickets && ticketUrl ? ticket(r.key) : r.key),
    el('span', { class: 'value' }, duration(r.minutes)),
    el('span', { class: 'bar' }, el('span', { style: `width:${Math.max(3, (r.minutes / most) * 100)}%` })))));
}

function panel(title, body, note) {
  return el('section', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, title), note ? el('span', { class: 'faint' }, note) : null),
    el('div', { class: 'panel-body' }, body));
}

function sessionsTable(sessions, { withDevice = false } = {}) {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ['Session', 'Repository', 'Branch', 'Tickets', 'State', withDevice ? 'Device' : null].filter(Boolean).map((h) => el('th', {}, h)))),
    el('tbody', {}, sessions.map((s) => el('tr', {},
      el('td', {}, s.title || 'Untitled', el('div', { class: 'faint small' }, s.kind === 'claude' ? 'Claude session' : 'Terminal')),
      el('td', { title: s.path || null }, s.repo || s.folder || '—'),
      el('td', { class: 'muted' }, s.branch || '—'),
      el('td', {}, s.tickets.length ? s.tickets.map((t) => [ticket(t), ' ']) : el('span', { class: 'faint' }, '—')),
      el('td', {}, s.busy ? el('span', { class: 'state is-working' }, 'Working') : s.active ? el('span', { class: 'state is-working' }, 'Active') : el('span', { class: 'state is-off' }, 'Idle')),
      withDevice ? el('td', { class: 'faint small' }, s.device || '') : null)))));
}

function week(days) {
  // Scaled to this week, so a short day still shows next to a shorter one.
  const most = Math.max(1, ...days.map((d) => d.minutes));
  const today = days.at(-1)?.day;
  return el('div', { class: `week${days.length > 10 ? ' is-long' : ''}`, style: `grid-template-columns: repeat(${days.length}, 1fr)` }, days.map((d, i) => el('div', { class: `week-day${d.day === today ? ' is-today' : ''}`, title: `${weekday(d.day, true)}: ${duration(d.minutes)}` },
    el('span', { class: 'week-value' }, d.minutes ? duration(d.minutes) : ''),
    el('span', { class: 'week-track' }, el('span', { class: 'week-bar', style: `height:${d.minutes ? Math.max(3, (d.minutes / most) * 100) : 0}%` })),
    el('span', { class: 'week-label' }, d.day === today ? 'Today' : days.length > 10 ? (i % 5 === 0 ? String(Number(d.day.slice(8))) : '') : weekday(d.day)))));
}

// ---------- overlays ----------
function overlay(content, onClose) {
  const scrim = el('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim) close(); } }, content);
  const close = () => { scrim.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  document.body.append(scrim);
  content.querySelector('input, button.primary, button')?.focus();
  return close;
}

function confirmDialog({ title, body, action, danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const close = overlay(el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
      el('h2', {}, title),
      el('p', { class: 'muted' }, body),
      el('div', { class: 'dialog-actions' },
        el('button', { onclick: () => close() }, 'Cancel'),
        el('button', { class: danger ? 'primary danger-fill' : 'primary', onclick: () => { answered = true; resolve(true); close(); } }, action))),
    () => { if (!answered) resolve(false); });
  });
}

function secretDialog({ title, body, secret }) {
  const copy = el('button', { onclick: async () => {
    await navigator.clipboard.writeText(secret);
    copy.textContent = 'Copied';
  } }, icon(ICONS.copy), 'Copy');
  overlay(el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
    el('h2', {}, title),
    el('p', { class: 'muted' }, body),
    el('div', { class: 'secret' }, el('code', {}, secret), copy),
    el('p', { class: 'faint small' }, 'It is not shown again. Send it to them some way other than e-mail if you can.'),
    el('div', { class: 'dialog-actions' }, el('button', { class: 'primary', onclick: (e) => e.target.closest('.scrim').remove() }, 'Done'))));
}

// ---------- pages ----------
let me = null;
let current = null;
let ticketUrl = '';
let teams = [];
let period = (() => { try { return Number(localStorage.getItem('period')) === 30 ? 30 : 7; } catch { return 7; } })();
const setPeriod = (days) => { period = days; try { localStorage.setItem('period', String(days)); } catch {} redraw(); };
const periodWords = () => (period === 30 ? 'the last 30 days' : 'the last seven days');

function periodPicker() {
  return el('div', { class: 'segmented', role: 'group', 'aria-label': 'Period' }, [[7, '7 days'], [30, '30 days']].map(([d, t]) =>
    el('button', { 'aria-pressed': String(period === d), onclick: () => setPeriod(d) }, t)));
}

/** A ticket, as a link to where the company keeps it when it said where that is. */
function ticket(key) {
  if (!ticketUrl) return el('span', { class: 'ticket' }, key);
  return el('a', { class: 'ticket', href: ticketUrl.replace('{ticket}', encodeURIComponent(key)), target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, key);
}
const filters = { query: '', show: 'all', accounts: '', team: '' };
const openPeople = new Set();

const pages = {
  account: { label: 'Your account', icon: ICONS.account, hidden: true, async draw() {
    const a = await api('GET', '/api/web/account');
    const form = el('form', { class: 'settings-fields', onsubmit: async (event) => {
      event.preventDefault();
      const f = event.target;
      if (f.next.value !== f.again.value) { toast('The two new passwords are not the same.', true); return; }
      try {
        await api('POST', '/api/web/password', { current: f.current?.value ?? '', next: f.next.value });
        f.reset();
        toast('Password changed. Other browsers signed in as you are signed out.');
      } catch (error) { toast(error.message, true); }
    } },
    a.ssoOnly ? el('p', { class: 'muted' }, 'You sign in with single sign-on. Setting a password lets you sign in without it too.') :
      el('label', { class: 'field' }, el('span', {}, 'Current password'), el('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
    el('label', { class: 'field' }, el('span', {}, 'New password'), el('input', { name: 'next', type: 'password', autocomplete: 'new-password', minlength: 10, required: true }), el('small', {}, 'At least 10 characters.')),
    el('label', { class: 'field' }, el('span', {}, 'New password again'), el('input', { name: 'again', type: 'password', autocomplete: 'new-password', minlength: 10, required: true })),
    el('div', {}, el('button', { class: 'primary', type: 'submit' }, a.ssoOnly ? 'Set password' : 'Change password')));
    const devices = a.devices.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Device', 'Signed in', 'Last report', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, a.devices.map((d) => el('tr', {},
        el('td', {}, d.label),
        el('td', { class: 'muted' }, ago(d.createdAt)),
        el('td', { class: 'muted' }, ago(d.lastSeen)),
        el('td', { style: 'text-align:right' }, el('button', { class: 'quiet danger', onclick: async () => {
          if (!await confirmDialog({ title: `Sign out ${d.label}?`, body: 'Smart Terminal on that device stops reporting until you sign in there again.', action: 'Sign out device', danger: true })) return;
          try { await api('DELETE', `/api/web/devices/${d.id}`); toast(`${d.label} is signed out.`); redraw(); } catch (error) { toast(error.message, true); }
        } }, 'Sign out')))))))
      : el('p', { class: 'faint' }, 'Not signed in on any device. In Smart Terminal, open the Organization extension and sign in.');
    return [
      el('header', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Your account'), el('p', { class: 'lede' }, `${a.user.name ? `${a.user.name}, ` : ''}${a.user.email}. ${a.user.role === 'admin' ? 'Administrator.' : 'Developer.'}`))),
      section('Password', 'Used to sign in here and in Smart Terminal.', form),
      section('Devices', 'Where Smart Terminal is signed in as you and reporting.', devices),
    ];
  } },

  mine: { label: 'My week', icon: ICONS.mine, async draw() {
    const s = await api('GET', `/api/web/stats?days=${period}`);
    ticketUrl = s.ticketUrl || '';
    const today = s.days.at(-1)?.minutes ?? 0;
    const busiest = [...s.days].sort((a, b) => b.minutes - a.minutes)[0];
    const lede = s.totalMinutes
      ? [el('strong', {}, duration(today)), ' today and ', el('strong', {}, duration(s.totalMinutes)), ` in ${periodWords()}`, busiest?.minutes ? [', most of it on ', el('strong', {}, period === 30 ? new Date(`${busiest.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : weekday(busiest.day, true))] : null, '.']
      : 'Nothing counted yet this week. Time is counted while one of your Smart Terminal sessions is doing something.';
    return [
      el('header', { class: 'page-head' }, el('div', {}, el('h1', {}, period === 30 ? 'Your month' : 'Your week'), el('p', { class: 'lede summary' }, lede)), el('div', { class: 'actions' }, periodPicker())),
      panel('Time worked', week(s.days), 'Two repositories at once count as one stretch of time'),
      s.accounts.length ? panel('Claude usage left', [el('div', { class: 'split' }, s.accounts.map(accountBlock)), usageHistory(s.usageHistory)]) : null,
      el('div', { class: 'split' },
        panel('Repositories', ranked(s.repos, 'No time in a repository yet.')),
        panel('Tickets', ranked(s.tickets, 'No tickets yet. They are read from branch names, session titles and commit subjects.', { tickets: true }))),
      s.sessions.length ? panel('Open now', [sessionsTable(s.sessions), privateNote(s.hiddenSessions)]) : privateNote(s.hiddenSessions),
      el('p', { class: 'faint small', style: 'margin-top:20px' }, s.devices.length
        ? `Signed in on ${s.devices.map((d) => d.label).join(', ')}. Only you and ${s.orgName}'s administrators see this page.`
        : 'You are not signed in on any device yet. In Smart Terminal, open the Organization extension and sign in.'),
    ];
  } },

  team: { label: 'Team', icon: ICONS.team, admin: true, async draw() {
    const data = await api('GET', `/api/web/overview?days=${period}`);
    ticketUrl = data.ticketUrl || '';
    const people = data.people.map((p) => ({ ...p, state: personState(p), low: lowOn(p) }));
    const low = people.filter((p) => p.low);
    const working = people.filter((p) => p.state.key === 'working').length;
    const sessions = people.reduce((n, p) => n + (p.online ? p.sessions.length : 0), 0);
    const tickets = new Set(people.flatMap((p) => (p.online ? p.sessions.flatMap((s) => s.tickets) : [])));
    const shown = people.filter((p) => {
      const q = filters.query.toLowerCase();
      if (filters.team && (p.team || '') !== filters.team) return false;
      if (q && !`${p.name} ${p.email} ${p.team ?? ''} ${p.sessions.map((s) => `${s.repo} ${s.branch} ${s.tickets.join(' ')}`).join(' ')}`.toLowerCase().includes(q)) return false;
      if (filters.show === 'working') return p.state.key === 'working';
      if (filters.show === 'paused') return p.state.key === 'paused';
      if (filters.show === 'away') return p.state.key === 'off';
      if (filters.show === 'low') return Boolean(p.low);
      return true;
    }).sort((a, b) => ({ working: 0, idle: 1, paused: 2, off: 3 }[a.state.key] - { working: 0, idle: 1, paused: 2, off: 3 }[b.state.key]) || (a.name || a.email).localeCompare(b.name || b.email));

    const search = el('input', { type: 'search', placeholder: 'Find a person, repository or ticket', value: filters.query, 'aria-label': 'Filter the team' });
    search.addEventListener('input', () => { filters.query = search.value; redraw({ keepFocus: true }); });
    const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' }, [['all', 'Everyone'], ['working', 'Working'], ['paused', 'Paused'], ['away', 'Away'], ['low', `Running low${low.length ? ` (${low.length})` : ''}`]].map(([k, t]) =>
      el('button', { 'aria-pressed': String(filters.show === k), onclick: () => { filters.show = k; redraw(); } }, t)));

    if (filters.team && !data.teamNames.includes(filters.team)) filters.team = '';
    const teamPick = data.teamNames.length ? el('select', { 'aria-label': 'Team', onchange: (e) => { filters.team = e.target.value; redraw(); } },
      el('option', { value: '' }, 'Every team'), data.teamNames.map((t) => el('option', { value: t, selected: filters.team === t }, t))) : null;

    return [
      el('header', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Team'),
        el('p', { class: 'lede summary' },
          el('strong', {}, `${working} of ${people.length}`), people.length === 1 ? ' person is working now' : ' people are working now',
          sessions ? [', in ', el('strong', {}, plural(sessions, 'session', 'sessions')), tickets.size ? [' on ', el('strong', {}, plural(tickets.size, 'ticket', 'tickets'))] : null] : null, '.'))),
      low.length ? el('div', { class: 'notice is-low' }, el('strong', {}, low.length === 1 ? `${low[0].name || low[0].email} is running low on Claude usage` : `${low.length} people are running low on Claude usage`),
        el('span', {}, ' ', low.map((p) => `${p.name || p.email}: ${p.low}`).join('; '), '.')) : null,
      el('div', { class: 'toolbar' }, search, seg, teamPick, el('span', { style: 'margin-left:auto' }, periodPicker())),
      shown.length ? el('div', { class: 'roster' }, shown.map(personRow)) : el('div', { class: 'roster' }, el('div', { class: 'empty' },
        people.length <= 1 ? [el('strong', {}, 'Nobody to show yet'), el('span', {}, 'Add your developers under Accounts. They appear here once they sign in from Smart Terminal.')] : el('span', {}, 'Nobody matches that.'))),
    ];
  } },

  work: { label: 'Where the time went', icon: ICONS.work, admin: true, async draw() {
    const data = await api('GET', `/api/web/overview?days=${period}`);
    ticketUrl = data.ticketUrl || '';
    const total = data.repos.reduce((n, r) => n + r.minutes, 0);
    return [
      el('header', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Where the time went'),
        el('p', { class: 'lede' }, `${periodWords()[0].toUpperCase()}${periodWords().slice(1)}, across everyone. Time is counted while a session is doing something; an open but idle session counts for nothing.`)),
        el('div', { class: 'actions' }, periodPicker(),
          el('a', { class: 'button', href: `/api/admin/export.csv?days=${period}`, download: '' }, icon(ICONS.download), 'Export CSV'))),
      el('div', { class: 'split' },
        panel('Repositories', ranked(data.repos, 'No time counted yet.'), total ? duration(total) : null),
        panel('Tickets', ranked(data.tickets, 'No tickets yet. Set how tickets look under Settings.', { tickets: true }))),
      el('div', { class: 'split' },
        panel('By project', data.projects.length ? ranked(data.projects, 'No time counted yet.')
          : el('p', { class: 'faint' }, 'Group repositories into projects under ', el('a', { href: '#settings', onclick: (e) => { e.preventDefault(); go('settings'); } }, 'Settings'), '.')),
        panel('By team', data.teams.length ? ranked(data.teams, 'No time counted yet.')
          : el('p', { class: 'faint' }, 'Give people a team under ', el('a', { href: '#users', onclick: (e) => { e.preventDefault(); go('users'); } }, 'Accounts'), '.'))),
    ];
  } },

  users: { label: 'Accounts', icon: ICONS.users, admin: true, async draw() {
    const { users: all } = await api('GET', '/api/admin/users');
    const q = filters.accounts.toLowerCase();
    const users = all.filter((u) => !q || `${u.name} ${u.email} ${u.team ?? ''}`.toLowerCase().includes(q));
    teams = [...new Set(all.map((u) => u.team).filter(Boolean))].sort();
    const search = el('input', { type: 'search', placeholder: 'Find an account', value: filters.accounts, 'aria-label': 'Find an account' });
    search.addEventListener('input', () => { filters.accounts = search.value; redraw({ keepFocus: true }); });
    return [
      el('header', { class: 'page-head' },
        el('div', {}, el('h1', {}, 'Accounts'), el('p', { class: 'lede' }, 'Who can sign in, from Smart Terminal and to this page.')),
        el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: addAccount }, 'Add account'))),
      el('div', { class: 'toolbar' }, search, el('span', { class: 'faint small', style: 'margin-left:auto' }, `${plural(all.length, 'account', 'accounts')}, ${all.filter((u) => u.role === 'admin').length} administrators`)),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ['Person', 'Team', 'Role', 'Signs in with', 'Last seen', 'Devices', 'Status', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, users.map((u) => el('tr', {},
          el('td', {}, el('div', { class: 'who-cell' }, el('span', { class: 'avatar' }, initials(u)),
            el('div', {}, el('div', { class: 'name' }, u.name || u.email), u.name ? el('div', { class: 'faint small' }, u.email) : null))),
          el('td', { class: u.team ? '' : 'faint' }, u.team || '—'),
          el('td', {}, u.role === 'admin' ? 'Administrator' : 'Developer'),
          el('td', { class: 'muted' }, u.hasPassword ? 'Password or SSO' : 'SSO only'),
          el('td', { class: 'muted' }, u.lastSeen ? ago(u.lastSeen) : 'Never'),
          el('td', { class: 'muted' }, String(u.devices ?? 0)),
          el('td', {}, u.disabled ? el('span', { class: 'state is-low' }, 'Disabled') : el('span', { class: 'state is-working' }, 'Active')),
          el('td', { style: 'text-align:right; white-space:nowrap' },
            el('button', { class: 'quiet', onclick: () => editAccount(u) }, u.id === me.id ? 'Edit' : 'Manage'))))))),
    ];
  } },

  log: { label: 'Activity log', icon: ICONS.log, admin: true, async draw() {
    const { entries } = await api('GET', '/api/admin/audit?limit=300');
    const words = {
      'signin.web': 'Signed in to this page', 'signin.app': 'Signed in from Smart Terminal', 'account.created': 'Added an account',
      'account.disabled': 'Disabled an account', 'account.enabled': 'Enabled an account', 'account.role': 'Changed a role',
      'account.password_reset': 'Made a new password', 'account.team': 'Changed a team', 'password.changed': 'Changed their password', 'device.signed_out': 'Signed out a device',
      'settings.changed': 'Changed settings', export: 'Exported time',
    };
    return [
      el('header', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Activity log'), el('p', { class: 'lede' }, 'Who signed in, and every change made to accounts, devices and settings.'))),
      entries.length ? el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ['When', 'Who', 'What', 'About', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, entries.map((e) => el('tr', {},
          el('td', { class: 'muted', title: new Date(e.at).toLocaleString() }, ago(e.at)),
          el('td', {}, e.actor_name || e.actor_email || 'Someone removed'),
          el('td', {}, words[e.action] ?? e.action),
          el('td', {}, e.target || '—'),
          el('td', { class: 'faint small' }, e.detail || '')))))) : el('div', { class: 'empty' }, el('strong', {}, 'Nothing yet')),
    ];
  } },

  settings: { label: 'Settings', icon: ICONS.settings, admin: true, async draw() {
    const s = await api('GET', '/api/admin/settings');
    const providers = el('div', { class: 'settings-fields' });
    const addProvider = (p) => providers.append(providerCard(p));
    const projects = el('div', { class: 'settings-fields' });
    const addProject = (p) => projects.append(projectRow(p));
    (s.projects ?? []).forEach(addProject);
    (s.providers ?? []).forEach(addProvider);
    const form = el('form', { onsubmit: async (event) => {
      event.preventDefault();
      const f = event.target;
      const body = {
        orgName: f.orgName.value,
        reportEveryMinutes: Number(f.reportEveryMinutes.value),
        ticketPattern: f.ticketPattern.value,
        ticketUrl: f.ticketUrl.value,
        sharePaths: f.sharePaths.checked,
        retentionDays: Number(f.retentionDays.value),
        projects: [...projects.querySelectorAll('.project-row')].map((row) => ({ name: row.querySelector('[name=projectName]').value, patterns: row.querySelector('[name=projectPatterns]').value })),
        providers: [...providers.querySelectorAll('.provider')].map((card) => Object.fromEntries([...card.querySelectorAll('input, select')].map((i) => [i.name, i.value]))),
      };
      try {
        await api('PUT', '/api/admin/settings', body);
        toast('Settings saved.');
        redraw();
      } catch (error) { toast(error.message, true); }
    } },
    section('Your organization', 'The name people see when they sign in, in the app and here.',
      el('label', { class: 'field' }, el('span', {}, 'Name'), el('input', { name: 'orgName', value: s.orgName, required: true }))),
    section('What devices report', 'How often each signed-in Smart Terminal tells this server what it is working on, and what it may say.',
      el('div', { class: 'field' }, el('span', {}, 'Report every'),
        el('div', { class: 'inline-field' }, el('input', { name: 'reportEveryMinutes', type: 'number', min: 1, max: 60, value: s.reportEveryMinutes }), el('span', { class: 'muted' }, 'minutes'))),
      el('label', { class: 'field' }, el('span', {}, 'Tickets look like'),
        el('input', { name: 'ticketPattern', value: s.ticketPattern, spellcheck: 'false', style: 'font-family: ui-monospace, Menlo, monospace' }),
        el('small', {}, 'A regular expression, looked for in branch names, session titles and the latest commit subject. The default finds Jira keys such as KS-142.')),
      el('label', { class: 'field' }, el('span', {}, 'Link tickets to'),
        el('input', { name: 'ticketUrl', value: s.ticketUrl ?? '', placeholder: 'https://acme.atlassian.net/browse/{ticket}', spellcheck: 'false' }),
        el('small', {}, 'Where a ticket opens when someone clicks it. {ticket} is replaced by the ticket. Empty, tickets are not links.')),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'sharePaths', checked: s.sharePaths }),
        el('span', {}, el('span', {}, 'Collect full folder paths'), el('small', { class: 'faint' }, 'When off, only the folder and repository names are kept.')))),
    section('Projects', 'Group repositories so time adds up by product or client. A repository goes to the first project that matches.',
      projects,
      el('div', { class: 'button-row' }, el('button', { type: 'button', onclick: () => { addProject({}); projects.lastElementChild.querySelector('input').focus(); } }, 'Add project'))),
    section('Keeping data', 'How long time worked, repositories, tickets and usage are kept. Accounts and the activity log are kept.',
      el('label', { class: 'field' }, el('span', {}, 'Keep'),
        el('select', { name: 'retentionDays' }, [[0, 'Everything'], [30, '30 days'], [90, '90 days'], [180, 'Six months'], [365, 'One year'], [730, 'Two years']]
          .concat([0, 30, 90, 180, 365, 730].includes(s.retentionDays) ? [] : [[s.retentionDays, `${s.retentionDays} days`]])
          .map(([v, t]) => el('option', { value: v, selected: s.retentionDays === v }, t))),
        el('small', {}, 'Older days are deleted when you save and once a day after that.'))),
    section('Single sign-on', 'Let people sign in with Microsoft, Google or your own identity provider instead of a password.',
      el('div', { class: 'field' }, el('span', {}, 'Redirect URI to register with the provider'),
        el('div', { class: 'copy-line' }, el('code', {}, s.callbackUrl),
          el('button', { type: 'button', onclick: async () => { await navigator.clipboard.writeText(s.callbackUrl); toast('Redirect URI copied.'); } }, icon(ICONS.copy), 'Copy'))),
      providers,
      el('div', { class: 'button-row' },
        el('button', { type: 'button', onclick: () => addProvider({ type: 'microsoft', id: 'microsoft', label: 'Microsoft' }) }, 'Add Microsoft'),
        el('button', { type: 'button', onclick: () => addProvider({ type: 'google', id: 'google', label: 'Google' }) }, 'Add Google'),
        el('button', { type: 'button', onclick: () => addProvider({ type: 'oidc', id: `sso${Date.now() % 1000}`, label: '' }) }, 'Add another provider'))),
    el('div', { class: 'savebar' }, el('button', { class: 'primary', type: 'submit' }, 'Save settings')));
    return [el('header', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Settings'))), form];
  } },
};

function section(title, about, ...fields) {
  return el('div', { class: 'settings-section' },
    el('div', { class: 'about' }, el('h2', {}, title), el('p', {}, about)),
    el('div', { class: 'settings-fields' }, fields));
}

function projectRow(p) {
  const row = el('div', { class: 'project-row' },
    el('label', { class: 'field' }, el('span', {}, 'Project'), el('input', { name: 'projectName', value: p.name ?? '', placeholder: 'Timelog', required: true })),
    el('label', { class: 'field' }, el('span', {}, 'Repositories'), el('input', { name: 'projectPatterns', value: (p.patterns ?? []).join(', '), placeholder: 'acme/timelog-*, acme/billing', spellcheck: 'false', required: true })),
    el('button', { type: 'button', class: 'quiet danger', 'aria-label': `Remove ${p.name || 'project'}`, onclick: () => row.remove() }, 'Remove'));
  return row;
}

function providerCard(p) {
  const type = p.type || 'oidc';
  const card = el('div', { class: 'provider' },
    el('div', { class: 'provider-head' },
      el('h3', {}, type === 'microsoft' ? 'Microsoft Entra ID' : type === 'google' ? 'Google' : 'OpenID Connect provider'),
      el('button', { type: 'button', class: 'quiet danger', onclick: () => card.remove() }, 'Remove')),
    el('input', { type: 'hidden', name: 'type', value: type }),
    el('input', { type: 'hidden', name: 'id', value: p.id || type }),
    el('div', { class: 'two' },
      el('label', { class: 'field' }, el('span', {}, 'Button text'), el('input', { name: 'label', value: p.label ?? '', placeholder: type === 'oidc' ? 'Okta' : '' })),
      el('label', { class: 'field' }, el('span', {}, 'Client ID'), el('input', { name: 'clientId', value: p.clientId ?? '', required: true }))),
    el('label', { class: 'field' }, el('span', {}, 'Client secret'), el('input', { name: 'clientSecret', type: 'password', autocomplete: 'off', placeholder: p.hasSecret ? 'Saved. Type a new one to replace it.' : '' })),
    type === 'microsoft' ? el('label', { class: 'field' }, el('span', {}, 'Tenant ID'), el('input', { name: 'tenant', value: p.tenant ?? '' }),
      el('small', {}, 'Your directory’s ID, so only your organization can sign in.')) : el('input', { type: 'hidden', name: 'tenant', value: '' }),
    type === 'oidc' ? el('label', { class: 'field' }, el('span', {}, 'Issuer URL'), el('input', { name: 'issuer', value: p.issuer ?? '', placeholder: 'https://login.example.com' })) : el('input', { type: 'hidden', name: 'issuer', value: '' }),
    el('label', { class: 'field' }, el('span', {}, 'Let in anyone from these domains'), el('input', { name: 'allowDomains', value: (p.allowDomains ?? []).join(', '), placeholder: 'acme.com' }),
      el('small', {}, 'Empty means only the accounts you add can sign in this way. Anyone else from a listed domain joins as a developer.')));
  return card;
}

/** How close to the limit someone got over the period, or null when nothing was reported. */
function usageHistory(h) {
  if (!h) return null;
  const parts = [];
  parts.push(h.daysRanOut ? el('strong', { class: 'low-text' }, `Ran out of session ${plural(h.daysRanOut, 'day', 'days')}`) : 'Never ran out of session');
  if (h.lowestWeekLeft != null) parts.push(['lowest the week got to was ', el('strong', {}, `${h.lowestWeekLeft}% left`)]);
  return el('p', { class: 'small muted history' }, `In ${periodWords()}: `, parts.map((p, i) => [i ? '; ' : '', p]), '.');
}

const privateNote = (n) => (n ? el('p', { class: 'faint small' }, `And ${plural(n, 'private session', 'private sessions')}, in folders never shared.`) : null);

function teamList(names) {
  return el('datalist', { id: 'team-names' }, (names ?? []).map((t) => el('option', { value: t })));
}

/** Words for an account running out, or null: under 15% of the session or 10% of the week left. */
function lowOn(p) {
  const words = [];
  for (const a of p.accounts) {
    const session = a.sessionUsed == null ? null : 100 - a.sessionUsed;
    const week = a.weekUsed == null ? null : 100 - a.weekUsed;
    if (session != null && session < 15) words.push(`${session}% of the session left${a.sessionResets ? `, back ${a.sessionResets}` : ''}`);
    if (week != null && week < 10) words.push(`${week}% of the week left${a.weekResets ? `, back ${a.weekResets}` : ''}`);
  }
  return words.length ? words.join(', ') : null;
}

function personRow(p) {
  const isOpen = openPeople.has(p.id);
  const active = p.online ? p.sessions.filter((s) => s.busy || s.active) : [];
  const lead = active[0] ?? (p.online ? p.sessions[0] : null);
  const others = p.online ? p.sessions.length - (lead ? 1 : 0) : 0;
  const best = [...p.accounts].sort((a, b) => (a.sessionUsed ?? 100) - (b.sessionUsed ?? 100))[0];
  const detail = el('div', { class: 'person-detail', hidden: !isOpen });
  const row = el('button', { class: 'person-row', 'aria-expanded': String(isOpen), onclick: () => {
    const open = !openPeople.has(p.id);
    if (open) openPeople.add(p.id); else openPeople.delete(p.id);
    row.setAttribute('aria-expanded', String(open));
    detail.hidden = !open;
    wrap.toggleAttribute('open', open);
    if (open && !detail.childElementCount) detail.append(...personDetail(p).filter(Boolean));
  } },
  el('span', { class: 'who-cell' },
    el('span', { class: `avatar is-${p.state.key}` }, initials(p)),
    el('span', { style: 'min-width:0' }, el('div', { class: 'name' }, p.name || p.email), el('div', { class: `status is-${p.state.key}` }, p.state.text, p.team ? el('span', { class: 'faint' }, ` · ${p.team}`) : null))),
  el('span', { class: 'work-cell' }, lead
    ? [el('span', { class: 'work-line' }, el('span', { class: 'repo' }, lead.repo || lead.folder || lead.title || 'A session'), lead.tickets.map((t) => ticket(t))),
      el('span', { class: 'branch' }, lead.branch || (lead.repo ? '' : 'Not in a repository')),
      others > 0 ? el('span', { class: 'more' }, `and ${plural(others, 'other session', 'other sessions')}`) : null]
    : el('span', { class: 'faint' }, p.paused ? 'Not sharing what they work on' : 'Nothing open')),
  el('span', { class: 'gauges' }, best ? [gauge('Session', best.sessionUsed), gauge('Week', best.weekUsed)] : el('span', { class: 'faint small' }, 'No usage reported')),
  el('span', { class: 'chevron' }, icon(ICONS.chevron)));
  const wrap = el('div', { class: 'person', open: isOpen }, row, detail);
  if (isOpen) detail.append(...personDetail(p).filter(Boolean));
  return wrap;
}

function personDetail(p) {
  const chart = el('div', {}, el('p', { class: 'faint small' }, 'Reading…'));
  api('GET', `/api/admin/people/${p.id}/stats?days=${period}`)
    .then((s) => chart.replaceChildren(el('h3', { style: 'margin-bottom:10px' }, `Time worked, ${periodWords().replace('the ', '')}: ${duration(s.totalMinutes)}`), week(s.days)))
    .catch((e) => chart.replaceChildren(el('p', { class: 'faint small' }, e.message)));
  return [
    chart,
    p.online && p.sessions.length ? sessionsTable(p.sessions, { withDevice: p.devices.length > 1 }) : null,
    p.online ? privateNote(p.hiddenSessions) : null,
    p.accounts.length > 0 ? el('div', { class: 'split' }, p.accounts.map(accountBlock)) : null,
    usageHistory(p.usageHistory),
    el('div', { class: 'split' },
      el('div', {}, el('h3', { style: 'margin-bottom:10px' }, `Repositories, ${periodWords().replace('the ', '')}`), ranked(p.repos, 'No time counted yet.')),
      el('div', {}, el('h3', { style: 'margin-bottom:10px' }, `Tickets, ${periodWords().replace('the ', '')}`), ranked(p.tickets, 'No tickets yet.', { tickets: true }))),
    p.devices.length ? el('div', { class: 'small muted' }, 'Signed in on ', p.devices.map((d, i) => [i ? ', ' : '', el('strong', {}, d.label), ` (${ago(d.lastSeen)}) `,
      el('button', { class: 'quiet danger small', onclick: async (e) => {
        e.stopPropagation();
        if (!await confirmDialog({ title: `Sign out ${d.label}?`, body: `${p.name || p.email} will have to sign in again on that device before it reports anything.`, action: 'Sign out device', danger: true })) return;
        try { await api('DELETE', `/api/admin/devices/${d.id}`); toast(`${d.label} is signed out.`); redraw(); } catch (error) { toast(error.message, true); }
      } }, 'Sign out')])) : el('div', { class: 'faint small' }, 'Not signed in on any device.'),
  ];
}

// ---------- account actions ----------
function addAccount() {
  const how = el('select', { name: 'how' },
    el('option', { value: 'generate' }, 'A password made for them'),
    el('option', { value: 'set' }, 'A password you choose'),
    el('option', { value: 'sso' }, 'Single sign-on only'));
  const pw = el('label', { class: 'field', hidden: true }, el('span', {}, 'Password'), el('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 10 }), el('small', {}, 'At least 10 characters.'));
  how.addEventListener('change', () => { pw.hidden = how.value !== 'set'; });
  const form = el('form', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', onsubmit: async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (data.how === 'sso') data.password = 'sso-only';
    else if (data.how === 'generate') delete data.password;
    delete data.how;
    try {
      const made = await api('POST', '/api/admin/users', data);
      close();
      redraw();
      if (made.password) secretDialog({ title: 'Account added', body: `Give ${made.user.email} this password. They can sign in with it in Smart Terminal and here.`, secret: made.password });
      else toast(`${made.user.email} added.`);
    } catch (error) { toast(error.message, true); }
  } },
  el('h2', {}, 'Add an account'),
  el('label', { class: 'field' }, el('span', {}, 'E-mail'), el('input', { name: 'email', type: 'email', required: true, autocomplete: 'off' })),
  el('div', { class: 'two' },
    el('label', { class: 'field' }, el('span', {}, 'Name'), el('input', { name: 'name', autocomplete: 'off' })),
    el('label', { class: 'field' }, el('span', {}, 'Team'), el('input', { name: 'team', autocomplete: 'off', list: 'team-names', placeholder: 'Optional' }))),
  teamList(teams),
  el('label', { class: 'field' }, el('span', {}, 'Role'), el('select', { name: 'role' }, el('option', { value: 'member' }, 'Developer, sees only their own numbers'), el('option', { value: 'admin' }, 'Administrator, sees everyone and manages accounts'))),
  el('label', { class: 'field' }, el('span', {}, 'Signs in with'), how),
  pw,
  el('div', { class: 'sheet-actions' }, el('button', { type: 'button', onclick: () => close() }, 'Cancel'), el('button', { class: 'primary', type: 'submit' }, 'Add account')));
  const close = overlay(form);
}

function editAccount(u) {
  const form = el('form', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', onsubmit: async (event) => {
    event.preventDefault();
    const f = event.target;
    try {
      await api('PATCH', `/api/admin/users/${u.id}`, { name: f.name.value, team: f.team.value });
      close();
      toast('Saved.');
      redraw();
    } catch (error) { toast(error.message, true); }
  } },
  el('h2', {}, u.name || u.email),
  el('p', { class: 'muted small' }, u.email),
  el('label', { class: 'field' }, el('span', {}, 'Name'), el('input', { name: 'name', value: u.name ?? '', autocomplete: 'off' })),
  el('label', { class: 'field' }, el('span', {}, 'Team'), el('input', { name: 'team', value: u.team ?? '', autocomplete: 'off', list: 'team-names', placeholder: 'No team' }),
    el('small', {}, 'Time adds up by team under Where the time went, and Team can show one team at a time.')),
  teamList(teams),
  el('div', { class: 'sheet-actions' }, el('button', { type: 'button', onclick: () => close() }, 'Cancel'), el('button', { class: 'primary', type: 'submit' }, 'Save')),
  u.id === me.id ? null : el('div', { class: 'sheet-more' },
    el('h3', {}, 'Sign-in and access'),
    el('div', { class: 'button-row' },
      el('button', { type: 'button', onclick: () => { close(); resetPassword(u); } }, 'Make a new password'),
      el('button', { type: 'button', onclick: () => { close(); changeRole(u); } }, u.role === 'admin' ? 'Make developer' : 'Make administrator'),
      el('button', { type: 'button', class: u.disabled ? '' : 'danger', onclick: () => { close(); toggleDisabled(u); } }, u.disabled ? 'Enable account' : 'Disable account'))));
  const close = overlay(form);
  form.querySelector('[name=team]').focus();
}

async function resetPassword(u) {
  if (!await confirmDialog({ title: `Make a new password for ${u.name || u.email}?`, body: 'Their old password stops working at once. Devices already signed in stay signed in.', action: 'Make new password' })) return;
  try {
    const r = await api('PATCH', `/api/admin/users/${u.id}`, { resetPassword: true });
    secretDialog({ title: 'New password', body: `Give ${u.email} this password.`, secret: r.password });
  } catch (error) { toast(error.message, true); }
}

async function changeRole(u) {
  const toAdmin = u.role !== 'admin';
  if (!await confirmDialog({ title: toAdmin ? `Make ${u.name || u.email} an administrator?` : `Make ${u.name || u.email} a developer?`,
    body: toAdmin ? 'Administrators see everyone’s work and manage accounts and sign-in.' : 'They will see only their own numbers from now on.', action: toAdmin ? 'Make administrator' : 'Make developer' })) return;
  try { await api('PATCH', `/api/admin/users/${u.id}`, { role: toAdmin ? 'admin' : 'member' }); toast('Role changed.'); redraw(); } catch (error) { toast(error.message, true); }
}

async function toggleDisabled(u) {
  if (!u.disabled && !await confirmDialog({ title: `Disable ${u.name || u.email}?`, body: 'They cannot sign in, and every device they are signed in on is signed out now.', action: 'Disable account', danger: true })) return;
  try { await api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled }); toast(u.disabled ? 'Account enabled.' : 'Account disabled.'); redraw(); } catch (error) { toast(error.message, true); }
}

// ---------- the frame ----------
function nav() {
  $('nav').replaceChildren(...Object.entries(pages).filter(([, p]) => !p.hidden && (!p.admin || me.role === 'admin')).map(([key, p]) =>
    el('button', { 'aria-current': key === current ? 'page' : null, onclick: () => go(key) }, icon(p.icon), key === 'mine' ? 'My week' : p.label)));
}

async function redraw({ keepFocus = false } = {}) {
  const focused = keepFocus ? document.activeElement : null;
  const caret = focused?.selectionStart;
  try {
    const parts = await pages[current].draw();
    $('page').replaceChildren(...parts.filter(Boolean));
    if (keepFocus && focused?.type === 'search') {
      const again = $('page').querySelector('input[type=search]');
      again?.focus();
      again?.setSelectionRange(caret, caret);
    }
  } catch (error) {
    $('page').replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'This page could not be loaded'), el('span', {}, error.message)));
  }
}

function go(key) {
  if (!pages[key] || (pages[key].admin && me.role !== 'admin')) key = me.role === 'admin' ? 'team' : 'mine';
  current = key;
  history.replaceState(null, '', `#${key}`);
  nav();
  redraw();
}

(async () => {
  ({ user: me } = await api('GET', '/api/web/me'));
  const info = await fetch('/api/providers').then((r) => r.json()).catch(() => ({}));
  if (info.orgName) {
    $('org').textContent = info.orgName;
    $('mark').textContent = info.orgName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    document.title = `${info.orgName} · Smart Terminal`;
  }
  $('me').replaceChildren(el('button', { class: 'quiet', style: 'padding-left:0', onclick: () => go('account') }, icon(ICONS.account), me.name || me.email));
  $('me').title = me.email;
  $('logout').addEventListener('click', async () => { await api('POST', '/api/web/logout', {}); location.href = '/login'; });
  go(location.hash.slice(1) || (me.role === 'admin' ? 'team' : 'mine'));
  // The live pages are what is on screen most of the day; keep them current without moving anything under the reader.
  setInterval(() => {
    if (['team', 'work', 'mine'].includes(current) && !document.querySelector('.scrim') && document.activeElement?.type !== 'search') redraw();
  }, 30_000);
})();
