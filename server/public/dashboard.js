'use strict';

/*
 * The backoffice. Everything that came from a developer's machine is text and
 * is put on the page as text — never as markup.
 */
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
  return node;
};
const api = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) location.href = '/login';
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`);
  return data;
};
const note = (text, bad = false) => {
  $('note').textContent = text;
  $('note').className = `note${bad ? ' bad' : ''}`;
};
const ago = (at) => {
  if (!at) return 'never';
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const hours = (minutes) => (minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`);

let me = null;
let tab = 'team';

function meter(label, used, resets) {
  if (used == null) return null;
  const left = 100 - used;
  return el('div', { class: 'meter' },
    el('span', { class: 'meter-label' }, label),
    el('span', { class: 'meter-bar' }, el('span', { class: `meter-fill${left < 15 ? ' low' : left < 40 ? ' mid' : ''}`, style: `width:${left}%` })),
    el('span', { class: 'meter-value' }, `${left}% left`),
    resets ? el('span', { class: 'dim small' }, `resets ${resets}`) : null);
}

function list(title, rows, empty) {
  return el('div', { class: 'card' }, el('h3', {}, title),
    rows.length ? el('ol', { class: 'ranked' }, rows.map((r) => el('li', {}, el('span', { class: 'key' }, r.key), el('span', { class: 'dim' }, hours(r.minutes)))))
      : el('p', { class: 'dim' }, empty));
}

async function drawTeam() {
  const data = await api('GET', '/api/web/overview');
  $('org').textContent = data.orgName;
  const section = $('team');
  section.replaceChildren();
  if (!data.people.length) section.append(el('p', { class: 'dim' }, 'Nobody yet. Add accounts under Accounts.'));
  for (const person of data.people) {
    const status = person.online ? (person.paused ? 'sharing paused' : 'online') : `last seen ${ago(person.lastSeen)}`;
    const card = el('article', { class: `person${person.online ? ' is-online' : ''}` },
      el('header', {},
        el('span', { class: `dot${person.online ? (person.paused ? ' paused' : ' on') : ''}` }),
        el('strong', {}, person.name || person.email),
        el('span', { class: 'dim' }, person.name ? person.email : ''),
        el('span', { class: 'spacer' }),
        el('span', { class: 'dim' }, status)),
    );
    if (person.accounts.length) {
      card.append(el('div', { class: 'accounts' }, person.accounts.map((a) =>
        el('div', { class: 'account' },
          el('div', { class: 'account-name' }, a.name || 'Claude', a.plan ? el('span', { class: 'dim' }, ` · ${a.plan}`) : null,
            el('span', { class: 'dim small' }, ` · read ${ago(a.readAt || a.reportedAt)}`)),
          meter('Session', a.sessionUsed, a.sessionResets),
          meter('Week', a.weekUsed, a.weekResets)))));
    }
    if (person.online && person.sessions.length) {
      card.append(el('table', { class: 'sessions' },
        el('thead', {}, el('tr', {}, ['Session', 'Repository / folder', 'Branch', 'Tickets', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, person.sessions.map((s) => el('tr', {},
          el('td', {}, s.title || '—', el('span', { class: 'dim small' }, ` ${s.kind}`)),
          el('td', { title: s.path || '' }, s.repo || s.folder || '—'),
          el('td', {}, s.branch || '—'),
          el('td', {}, s.tickets.length ? s.tickets.map((t) => el('span', { class: 'chip' }, t)) : '—'),
          el('td', {}, s.busy ? el('span', { class: 'chip on' }, 'working') : s.active ? el('span', { class: 'chip' }, 'active') : ''))))));
    } else if (person.online && !person.paused) {
      card.append(el('p', { class: 'dim' }, 'No sessions open.'));
    }
    card.append(el('div', { class: 'columns' },
      list('Repositories, last 7 days', person.repos, 'Nothing yet.'),
      list('Tickets, last 7 days', person.tickets, 'No tickets seen in branch names or titles.')));
    if (me.role === 'admin' && person.devices.length) {
      card.append(el('p', { class: 'dim small' }, 'Signed in on: ', person.devices.map((d) =>
        el('span', { class: 'chip' }, `${d.label} · ${ago(d.lastSeen)} `,
          el('button', { class: 'link', title: 'Sign this device out', onclick: async () => {
            if (!confirm(`Sign ${d.label} out? It will have to sign in again.`)) return;
            await api('DELETE', `/api/admin/devices/${d.id}`);
            note('Signed out.');
            drawTeam();
          } }, '×')))));
    }
    section.append(card);
  }
}

async function drawWork() {
  const data = await api('GET', '/api/web/overview');
  $('work').replaceChildren(
    el('p', { class: 'dim' }, `Time in sessions that were working, since ${data.since}. A session counts while it does something; an idle one does not.`),
    el('div', { class: 'columns' },
      list('Repositories', data.repos, 'Nothing yet.'),
      list('Tickets', data.tickets, 'No tickets seen yet.')));
}

async function drawUsers() {
  const { users } = await api('GET', '/api/admin/users');
  const form = el('form', { class: 'card stack inline', onsubmit: async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (data.how === 'sso') data.password = 'sso-only';
    else if (data.how === 'generate') delete data.password;
    try {
      const made = await api('POST', '/api/admin/users', data);
      event.target.reset();
      note(made.password ? `Account created. Its password, shown only now: ${made.password}` : 'Account created.');
      drawUsers();
    } catch (error) { note(error.message, true); }
  } },
  el('h3', {}, 'Add an account'),
  el('label', {}, 'E-mail ', el('input', { name: 'email', type: 'email', required: true })),
  el('label', {}, 'Name ', el('input', { name: 'name' })),
  el('label', {}, 'Role ', el('select', { name: 'role' }, el('option', { value: 'member' }, 'Developer'), el('option', { value: 'admin' }, 'Administrator'))),
  el('label', {}, 'Signs in with ', el('select', { name: 'how' },
    el('option', { value: 'generate' }, 'a password made for them'),
    el('option', { value: 'set' }, 'a password I type'),
    el('option', { value: 'sso' }, 'Microsoft / Google only'))),
  el('label', {}, 'Password ', el('input', { name: 'password', type: 'password', autocomplete: 'new-password', placeholder: 'only if you type one' })),
  el('button', { class: 'primary', type: 'submit' }, 'Add'));

  const table = el('table', { class: 'users' },
    el('thead', {}, el('tr', {}, ['Name', 'E-mail', 'Role', 'Signs in with', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, users.map((u) => el('tr', { class: u.disabled ? 'disabled' : '' },
      el('td', {}, u.name || '—'),
      el('td', {}, u.email),
      el('td', {}, u.role === 'admin' ? 'Administrator' : 'Developer'),
      el('td', {}, u.hasPassword ? 'password or SSO' : 'SSO only'),
      el('td', { class: 'actions' },
        el('button', { onclick: async () => {
          try {
            const r = await api('PATCH', `/api/admin/users/${u.id}`, { resetPassword: true });
            note(`New password for ${u.email}, shown only now: ${r.password}`);
            drawUsers();
          } catch (error) { note(error.message, true); }
        } }, 'New password'),
        el('button', { onclick: async () => {
          try {
            await api('PATCH', `/api/admin/users/${u.id}`, { role: u.role === 'admin' ? 'member' : 'admin' });
            drawUsers();
          } catch (error) { note(error.message, true); }
        } }, u.role === 'admin' ? 'Make developer' : 'Make admin'),
        el('button', { class: u.disabled ? '' : 'danger', onclick: async () => {
          if (!u.disabled && !confirm(`Disable ${u.email}? Every device it is signed in on is signed out.`)) return;
          try {
            await api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled });
            drawUsers();
          } catch (error) { note(error.message, true); }
        } }, u.disabled ? 'Enable' : 'Disable'))))));
  $('users').replaceChildren(form, table);
}

async function drawSettings() {
  const s = await api('GET', '/api/admin/settings');
  const providerRow = (p = {}) => el('fieldset', { class: 'card stack provider' },
    el('legend', {}, p.label || p.type || 'New provider'),
    el('label', {}, 'Type ', el('select', { name: 'type' },
      ['microsoft', 'google', 'oidc'].map((t) => el('option', { value: t, selected: p.type === t }, t === 'oidc' ? 'Other (OpenID Connect)' : t[0].toUpperCase() + t.slice(1))))),
    el('label', {}, 'Button label ', el('input', { name: 'label', value: p.label ?? '' })),
    el('label', {}, 'Client ID ', el('input', { name: 'clientId', value: p.clientId ?? '' })),
    el('label', {}, 'Client secret ', el('input', { name: 'clientSecret', type: 'password', placeholder: p.hasSecret ? 'kept; type to replace' : '' })),
    el('label', {}, 'Microsoft tenant ID ', el('input', { name: 'tenant', value: p.tenant ?? '', placeholder: 'your tenant, so only your organization can sign in' })),
    el('label', {}, 'Issuer URL (other) ', el('input', { name: 'issuer', value: p.issuer ?? '', placeholder: 'https://…' })),
    el('label', {}, 'Let anyone at these domains in ', el('input', { name: 'allowDomains', value: (p.allowDomains ?? []).join(', '), placeholder: 'empty: only accounts added here' })),
    el('input', { type: 'hidden', name: 'id', value: p.id ?? '' }),
    el('button', { type: 'button', class: 'danger', onclick: (e) => e.target.closest('fieldset').remove() }, 'Remove'));

  const providers = el('div', { class: 'stack' }, (s.providers ?? []).map(providerRow));
  const form = el('form', { class: 'stack', onsubmit: async (event) => {
    event.preventDefault();
    const f = event.target;
    const body = {
      orgName: f.orgName.value,
      reportEveryMinutes: Number(f.reportEveryMinutes.value),
      ticketPattern: f.ticketPattern.value,
      sharePaths: f.sharePaths.checked,
      providers: [...providers.querySelectorAll('fieldset')].map((fs) => Object.fromEntries(
        [...fs.querySelectorAll('input, select')].map((i) => [i.name, i.value]))),
    };
    try {
      await api('PUT', '/api/admin/settings', body);
      note('Saved.');
      drawSettings();
    } catch (error) { note(error.message, true); }
  } },
  el('div', { class: 'card stack' },
    el('h3', {}, 'Organization'),
    el('label', {}, 'Name ', el('input', { name: 'orgName', value: s.orgName })),
    el('label', {}, 'Devices report every (minutes) ', el('input', { name: 'reportEveryMinutes', type: 'number', min: 1, max: 60, value: s.reportEveryMinutes })),
    el('label', {}, 'Tickets look like ', el('input', { name: 'ticketPattern', value: s.ticketPattern, class: 'mono' })),
    el('p', { class: 'dim small' }, 'A regular expression, looked for in branch names, session titles and the last commit subject. The default matches Jira-style keys such as KS-142.'),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'sharePaths', checked: s.sharePaths }), ' Collect full folder paths, not only folder and repository names')),
  el('div', { class: 'card stack' },
    el('h3', {}, 'Sign in with Microsoft, Google or another provider'),
    el('p', { class: 'dim small' }, 'Register an application with the provider, with this redirect URI: ', el('code', {}, s.callbackUrl), '. Only accounts that exist here can sign in, unless you list domains whose people may sign in and be added as developers.'),
    providers,
    el('button', { type: 'button', onclick: () => providers.append(providerRow({ type: 'microsoft' })) }, 'Add a provider')),
  el('button', { class: 'primary', type: 'submit' }, 'Save'));
  $('settings').replaceChildren(form);
}

const draws = { team: drawTeam, work: drawWork, users: drawUsers, settings: drawSettings };
function show(name) {
  tab = name;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const key of Object.keys(draws)) $(key).hidden = key !== name;
  note('');
  draws[name]().catch((error) => note(error.message, true));
}

(async () => {
  ({ user: me } = await api('GET', '/api/web/me'));
  $('me').textContent = me.email;
  if (me.role !== 'admin') for (const b of document.querySelectorAll('[data-admin]')) b.remove();
  $('tabs').addEventListener('click', (event) => {
    const b = event.target.closest('button[data-tab]');
    if (b) show(b.dataset.tab);
  });
  $('logout').addEventListener('click', async () => {
    await api('POST', '/api/web/logout', {});
    location.href = '/login';
  });
  show('team');
  // The team view is what is on screen most of the time; keep it current.
  setInterval(() => { if (tab === 'team' || tab === 'work') draws[tab]().catch(() => {}); }, 30_000);
})();
