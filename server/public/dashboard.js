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

function ranked(rows, empty) {
  if (!rows.length) return el('p', { class: 'faint' }, empty);
  const most = Math.max(...rows.map((r) => r.minutes), 1);
  return el('ol', { class: 'ranked' }, rows.map((r) => el('li', {},
    el('span', { class: 'key' }, r.key),
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
      el('td', {}, s.tickets.length ? s.tickets.map((t) => el('span', { class: 'ticket' }, t), ' ') : el('span', { class: 'faint' }, '—')),
      el('td', {}, s.busy ? el('span', { class: 'state is-working' }, 'Working') : s.active ? el('span', { class: 'state is-working' }, 'Active') : el('span', { class: 'state is-off' }, 'Idle')),
      withDevice ? el('td', { class: 'faint small' }, s.device || '') : null)))));
}

function week(days) {
  // Scaled to this week, so a short day still shows next to a shorter one.
  const most = Math.max(1, ...days.map((d) => d.minutes));
  const today = days.at(-1)?.day;
  return el('div', { class: 'week' }, days.map((d) => el('div', { class: `week-day${d.day === today ? ' is-today' : ''}`, title: `${weekday(d.day, true)}: ${duration(d.minutes)}` },
    el('span', { class: 'week-value' }, d.minutes ? duration(d.minutes) : ''),
    el('span', { class: 'week-track' }, el('span', { class: 'week-bar', style: `height:${d.minutes ? Math.max(3, (d.minutes / most) * 100) : 0}%` })),
    el('span', { class: 'week-label' }, d.day === today ? 'Today' : weekday(d.day)))));
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
const filters = { query: '', show: 'all' };
const openPeople = new Set();

const pages = {
  mine: { label: 'My week', icon: ICONS.mine, async draw() {
    const s = await api('GET', '/api/web/stats');
    const today = s.days.at(-1)?.minutes ?? 0;
    const busiest = [...s.days].sort((a, b) => b.minutes - a.minutes)[0];
    const lede = s.totalMinutes
      ? [el('strong', {}, duration(today)), ' today and ', el('strong', {}, duration(s.totalMinutes)), ' in the last seven days', busiest?.minutes ? [', most of it on ', el('strong', {}, weekday(busiest.day, true))] : null, '.']
      : 'Nothing counted yet this week. Time is counted while one of your Smart Terminal sessions is doing something.';
    return [
      el('header', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Your week'), el('p', { class: 'lede summary' }, lede))),
      panel('Time worked', week(s.days), 'Two repositories at once count as one stretch of time'),
      s.accounts.length ? panel('Claude usage left', el('div', { class: 'split' }, s.accounts.map(accountBlock))) : null,
      el('div', { class: 'split' },
        panel('Repositories', ranked(s.repos, 'No time in a repository yet.')),
        panel('Tickets', ranked(s.tickets, 'No tickets yet. They are read from branch names, session titles and commit subjects.'))),
      s.sessions.length ? panel('Open now', sessionsTable(s.sessions)) : null,
      el('p', { class: 'faint small', style: 'margin-top:20px' }, s.devices.length
        ? `Signed in on ${s.devices.map((d) => d.label).join(', ')}. Only you and ${s.orgName}'s administrators see this page.`
        : 'You are not signed in on any device yet. In Smart Terminal, open the Organization extension and sign in.'),
    ];
  } },

  team: { label: 'Team', icon: ICONS.team, admin: true, async draw() {
    const data = await api('GET', '/api/web/overview');
    const people = data.people.map((p) => ({ ...p, state: personState(p) }));
    const working = people.filter((p) => p.state.key === 'working').length;
    const sessions = people.reduce((n, p) => n + (p.online ? p.sessions.length : 0), 0);
    const tickets = new Set(people.flatMap((p) => (p.online ? p.sessions.flatMap((s) => s.tickets) : [])));
    const shown = people.filter((p) => {
      const q = filters.query.toLowerCase();
      if (q && !`${p.name} ${p.email} ${p.sessions.map((s) => `${s.repo} ${s.branch} ${s.tickets.join(' ')}`).join(' ')}`.toLowerCase().includes(q)) return false;
      if (filters.show === 'working') return p.state.key === 'working';
      if (filters.show === 'paused') return p.state.key === 'paused';
      if (filters.show === 'away') return p.state.key === 'off';
      return true;
    }).sort((a, b) => ({ working: 0, idle: 1, paused: 2, off: 3 }[a.state.key] - { working: 0, idle: 1, paused: 2, off: 3 }[b.state.key]) || (a.name || a.email).localeCompare(b.name || b.email));

    const search = el('input', { type: 'search', placeholder: 'Find a person, repository or ticket', value: filters.query, 'aria-label': 'Filter the team' });
    search.addEventListener('input', () => { filters.query = search.value; redraw({ keepFocus: true }); });
    const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' }, [['all', 'Everyone'], ['working', 'Working'], ['paused', 'Paused'], ['away', 'Away']].map(([k, t]) =>
      el('button', { 'aria-pressed': String(filters.show === k), onclick: () => { filters.show = k; redraw(); } }, t)));

    return [
      el('header', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Team'),
        el('p', { class: 'lede summary' },
          el('strong', {}, `${working} of ${people.length}`), people.length === 1 ? ' person is working now' : ' people are working now',
          sessions ? [', in ', el('strong', {}, plural(sessions, 'session', 'sessions')), tickets.size ? [' on ', el('strong', {}, plural(tickets.size, 'ticket', 'tickets'))] : null] : null, '.'))),
      el('div', { class: 'toolbar' }, search, seg),
      shown.length ? el('div', { class: 'roster' }, shown.map(personRow)) : el('div', { class: 'roster' }, el('div', { class: 'empty' },
        people.length <= 1 ? [el('strong', {}, 'Nobody to show yet'), el('span', {}, 'Add your developers under Accounts. They appear here once they sign in from Smart Terminal.')] : el('span', {}, 'Nobody matches that.'))),
    ];
  } },

  work: { label: 'Where the time went', icon: ICONS.work, admin: true, async draw() {
    const data = await api('GET', '/api/web/overview');
    const total = data.repos.reduce((n, r) => n + r.minutes, 0);
    return [
      el('header', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Where the time went'),
        el('p', { class: 'lede' }, `The last seven days, across everyone. Time is counted while a session is doing something; an open but idle session counts for nothing.`))),
      el('div', { class: 'split' },
        panel('Repositories', ranked(data.repos, 'No time counted yet.'), total ? duration(total) : null),
        panel('Tickets', ranked(data.tickets, 'No tickets yet. Set how tickets look under Settings.'))),
    ];
  } },

  users: { label: 'Accounts', icon: ICONS.users, admin: true, async draw() {
    const { users } = await api('GET', '/api/admin/users');
    return [
      el('header', { class: 'page-head' },
        el('div', {}, el('h1', {}, 'Accounts'), el('p', { class: 'lede' }, 'Who can sign in, from Smart Terminal and to this page.')),
        el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: addAccount }, 'Add account'))),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ['Person', 'Role', 'Signs in with', 'Status', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, users.map((u) => el('tr', {},
          el('td', {}, el('div', { class: 'who-cell' }, el('span', { class: 'avatar' }, initials(u)),
            el('div', {}, el('div', { class: 'name' }, u.name || u.email), u.name ? el('div', { class: 'faint small' }, u.email) : null))),
          el('td', {}, u.role === 'admin' ? 'Administrator' : 'Developer'),
          el('td', { class: 'muted' }, u.hasPassword ? 'Password or single sign-on' : 'Single sign-on only'),
          el('td', {}, u.disabled ? el('span', { class: 'state is-low' }, 'Disabled') : el('span', { class: 'state is-working' }, 'Active')),
          el('td', { style: 'text-align:right; white-space:nowrap' },
            u.id === me.id ? el('span', { class: 'faint small' }, 'You') : [
              el('button', { class: 'quiet', onclick: () => resetPassword(u) }, 'New password'),
              el('button', { class: 'quiet', onclick: () => changeRole(u) }, u.role === 'admin' ? 'Make developer' : 'Make administrator'),
              el('button', { class: `quiet${u.disabled ? '' : ' danger'}`, onclick: () => toggleDisabled(u) }, u.disabled ? 'Enable' : 'Disable'),
            ])))))),
    ];
  } },

  settings: { label: 'Settings', icon: ICONS.settings, admin: true, async draw() {
    const s = await api('GET', '/api/admin/settings');
    const providers = el('div', { class: 'settings-fields' });
    const addProvider = (p) => providers.append(providerCard(p));
    (s.providers ?? []).forEach(addProvider);
    const form = el('form', { onsubmit: async (event) => {
      event.preventDefault();
      const f = event.target;
      const body = {
        orgName: f.orgName.value,
        reportEveryMinutes: Number(f.reportEveryMinutes.value),
        ticketPattern: f.ticketPattern.value,
        sharePaths: f.sharePaths.checked,
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
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'sharePaths', checked: s.sharePaths }),
        el('span', {}, el('span', {}, 'Collect full folder paths'), el('small', { class: 'faint' }, 'When off, only the folder and repository names are kept.')))),
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
    if (open && !detail.childElementCount) detail.append(...personDetail(p));
  } },
  el('span', { class: 'who-cell' },
    el('span', { class: `avatar is-${p.state.key}` }, initials(p)),
    el('span', { style: 'min-width:0' }, el('div', { class: 'name' }, p.name || p.email), el('div', { class: `status is-${p.state.key}` }, p.state.text))),
  el('span', { class: 'work-cell' }, lead
    ? [el('span', { class: 'work-line' }, el('span', { class: 'repo' }, lead.repo || lead.folder || lead.title || 'A session'), lead.tickets.map((t) => el('span', { class: 'ticket' }, t))),
      el('span', { class: 'branch' }, lead.branch || (lead.repo ? '' : 'Not in a repository')),
      others > 0 ? el('span', { class: 'more' }, `and ${plural(others, 'other session', 'other sessions')}`) : null]
    : el('span', { class: 'faint' }, p.paused ? 'Not sharing what they work on' : 'Nothing open')),
  el('span', { class: 'gauges' }, best ? [gauge('Session', best.sessionUsed), gauge('Week', best.weekUsed)] : el('span', { class: 'faint small' }, 'No usage reported')),
  el('span', { class: 'chevron' }, icon(ICONS.chevron)));
  const wrap = el('div', { class: 'person', open: isOpen }, row, detail);
  if (isOpen) detail.append(...personDetail(p));
  return wrap;
}

function personDetail(p) {
  return [
    p.online && p.sessions.length ? sessionsTable(p.sessions, { withDevice: p.devices.length > 1 }) : null,
    p.accounts.length > 0 ? el('div', { class: 'split' }, p.accounts.map(accountBlock)) : null,
    el('div', { class: 'split' },
      el('div', {}, el('h3', { style: 'margin-bottom:10px' }, 'Repositories, last 7 days'), ranked(p.repos, 'No time counted yet.')),
      el('div', {}, el('h3', { style: 'margin-bottom:10px' }, 'Tickets, last 7 days'), ranked(p.tickets, 'No tickets yet.'))),
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
  el('label', { class: 'field' }, el('span', {}, 'Name'), el('input', { name: 'name', autocomplete: 'off' })),
  el('label', { class: 'field' }, el('span', {}, 'Role'), el('select', { name: 'role' }, el('option', { value: 'member' }, 'Developer, sees only their own numbers'), el('option', { value: 'admin' }, 'Administrator, sees everyone and manages accounts'))),
  el('label', { class: 'field' }, el('span', {}, 'Signs in with'), how),
  pw,
  el('div', { class: 'sheet-actions' }, el('button', { type: 'button', onclick: () => close() }, 'Cancel'), el('button', { class: 'primary', type: 'submit' }, 'Add account')));
  const close = overlay(form);
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
  $('nav').replaceChildren(...Object.entries(pages).filter(([, p]) => !p.admin || me.role === 'admin').map(([key, p]) =>
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
  $('me').textContent = me.name ? `${me.name}` : me.email;
  $('me').title = me.email;
  $('logout').addEventListener('click', async () => { await api('POST', '/api/web/logout', {}); location.href = '/login'; });
  go(location.hash.slice(1) || (me.role === 'admin' ? 'team' : 'mine'));
  // The live pages are what is on screen most of the day; keep them current without moving anything under the reader.
  setInterval(() => {
    if (['team', 'work', 'mine'].includes(current) && !document.querySelector('.scrim') && document.activeElement?.type !== 'search') redraw();
  }, 30_000);
})();
