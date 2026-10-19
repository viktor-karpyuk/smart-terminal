'use strict';

/*
 * Your Smart Terminal sessions, on your phone, served by your own computer.
 *
 * The page asks the computer which sessions are open and shows them; tapping
 * one opens a WebSocket to the computer for that session, which passes what it
 * prints here and what is typed here back. On a phone the session takes the
 * phone's width while it is open here, so the text is readable; on a wide
 * screen it keeps the size the app gave it and the font shrinks to fit.
 */

const $ = (id) => document.getElementById(id);
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

const THEME = {
  background: '#0f121a', foreground: '#d8dcea', cursor: '#8c9cff', cursorAccent: '#0f121a', selectionBackground: '#33407a',
  black: '#1b1f2b', red: '#f07a83', green: '#3cc7b4', yellow: '#e2a84b', blue: '#8c9cff', magenta: '#c792ea', cyan: '#5fd3e8', white: '#d8dcea',
  brightBlack: '#5b6378', brightRed: '#ff9aa2', brightGreen: '#6fe0cf', brightYellow: '#f2c36f', brightBlue: '#aeb9ff', brightMagenta: '#ddb3f5', brightCyan: '#8fe6f3', brightWhite: '#ffffff',
};
const FONT = 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace';
const NARROW = matchMedia('(max-width: 759px)');
const PHONE_FONT = 12;

let computer = '';
let sessions = [];
/** session id → { key, title, kind, term, ws, pane, tab, fitter, cols, rows, state, drives } */
const open = new Map();
let current = null;
let listTimer = null;

function view(name) {
  document.body.dataset.view = name;
}

function status(text, bad = false) {
  $('status').textContent = text;
  $('status').classList.toggle('is-bad', bad);
}

function railNote(text, bad = false) {
  $('rail-note').textContent = text;
  $('rail-note').classList.toggle('is-bad', bad);
  $('dot').classList.toggle('is-bad', bad);
  $('dot').classList.toggle('is-on', !bad && Boolean(text));
}

// ---------- pairing ----------
async function whoAmI() {
  try {
    const r = await fetch('/api/me', { headers: { accept: 'application/json' } });
    if (r.status === 401) return null;
    const data = await r.json();
    return data.ok ? data : null;
  } catch {
    return null;
  }
}

function showPair() {
  $('shell').hidden = true;
  $('pair').hidden = false;
  view('pair');
  $('code').focus();
}

$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  $('pair-error').textContent = '';
  try {
    const r = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: $('code').value, name: $('name').value }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'Could not pair.');
    enter(data);
  } catch (error) {
    $('pair-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('forget').addEventListener('click', async () => {
  if (!confirm('Unpair this phone? Smart Terminal will forget it, and you will need a new code to come back.')) return;
  for (const key of [...open.keys()]) closeSession(key);
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* the cookie is gone either way */ }
  clearInterval(listTimer);
  showPair();
});

function enter(me) {
  computer = me.computer || 'Smart Terminal';
  $('computer').textContent = computer;
  document.title = `${computer} · Smart Terminal`;
  $('pair').hidden = true;
  $('shell').hidden = false;
  view('list');
  refresh();
  clearInterval(listTimer);
  listTimer = setInterval(refresh, 4000);
}

// ---------- the list ----------
async function refresh() {
  try {
    const r = await fetch('/api/sessions', { headers: { accept: 'application/json' } });
    if (r.status === 401) {
      clearInterval(listTimer);
      showPair();
      return;
    }
    const data = await r.json();
    sessions = data.sessions ?? [];
    railNote(`Connected to ${computer}`);
  } catch {
    railNote(`Cannot reach ${computer}. Is it on, and on the same network?`, true);
  }
  drawSessions();
  if (!open.size) drawEmpty();
}

function stateClass(state) {
  if (/waiting/.test(state)) return 'is-waiting';
  if (/working|busy/.test(state)) return 'is-working';
  return 'is-idle';
}

function stateLabel(state) {
  if (state === 'shell') return '';
  if (/waiting/.test(state)) return 'Needs you';
  if (state === 'working') return 'Working';
  if (state === 'busy') return 'Busy';
  if (/idle/.test(state)) return 'Idle';
  return 'No Claude';
}

function drawSessions() {
  const box = $('sessions');
  if (!sessions.length) {
    box.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'No sessions open'), el('span', {}, 'Open one in Smart Terminal on your computer and it appears here.')));
    return;
  }
  // Needing you first, then working, then the rest, each in its own group.
  const groups = [
    ['Waiting on you', sessions.filter((s) => /waiting/.test(s.state))],
    ['Working', sessions.filter((s) => s.state === 'working' || s.state === 'busy')],
    ['Idle', sessions.filter((s) => /idle/.test(s.state))],
    ['Shells', sessions.filter((s) => s.state === 'shell' || /not running/.test(s.state))],
  ].filter(([, list]) => list.length);
  box.replaceChildren(...groups.map(([name, list]) => el('section', { class: 'group' },
    el('h2', {}, name),
    el('ul', {}, list.map((s) => el('li', {}, el('button', {
      class: 'session',
      type: 'button',
      'aria-current': s.id === current ? 'true' : null,
      onclick: () => openSession(s),
    },
    el('span', { class: `kind is-${s.kind}` }, s.kind === 'claude' ? 'C' : '$'),
    el('span', { class: 'session-text' },
      el('span', { class: 'session-title' }, s.title || s.folder || 'Session'),
      el('span', { class: 'session-where' }, s.folder || '')),
    stateLabel(s.state) ? el('span', { class: `state ${stateClass(s.state)}` }, stateLabel(s.state)) : null,
    open.has(s.id) ? el('span', { class: 'open-mark', title: 'Open here' }) : null)))))));
}

function drawEmpty() {
  if (open.size) return;
  $('stage').replaceChildren(el('div', { class: 'stage-empty' },
    el('strong', {}, sessions.length ? 'Pick a session' : 'Nothing to open yet'),
    el('span', {}, sessions.length ? 'Choose one on the left. Typing here types into it, exactly as in Smart Terminal.' : 'Sessions appear here while Smart Terminal is open on your computer.')));
  $('tabs').replaceChildren();
  status('');
}

// ---------- one session ----------
function openSession(s) {
  const key = s.id;
  if (open.has(key)) {
    show(key);
    return;
  }
  if ($('stage').querySelector('.stage-empty')) $('stage').replaceChildren();

  const pane = el('div', { class: 'pane', hidden: true });
  $('stage').append(pane);
  const term = new Terminal({
    fontFamily: FONT, fontSize: 13, lineHeight: 1, theme: THEME, cursorBlink: true, scrollback: 5000,
    allowProposedApi: false, macOptionIsMeta: true, convertEol: false,
  });
  const fitter = new FitAddon.FitAddon();
  term.loadAddon(fitter);
  term.open(pane);
  const entry = { key, title: s.title || s.folder || 'Session', kind: s.kind, term, pane, fitter, drives: false, cols: 80, rows: 24, state: 'connecting' };
  entry.tab = el('div', { class: 'tab', role: 'tab' },
    el('button', { class: 'tab-name', type: 'button', onclick: () => show(key) }, entry.title),
    el('button', { class: 'tab-close', type: 'button', 'aria-label': `Close ${entry.title} here`, title: 'Close here. The session keeps running.', onclick: () => closeSession(key) }, '×'));
  $('tabs').append(entry.tab);
  open.set(key, entry);

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/api/terminal?session=${encodeURIComponent(key)}`);
  entry.ws = ws;
  ws.onmessage = (event) => {
    let m;
    try { m = JSON.parse(event.data); } catch { return; }
    if (m.t === 'opened') {
      entry.state = 'open';
      entry.cols = m.cols; entry.rows = m.rows;
      if (m.title) entry.title = m.title;
      term.resize(m.cols, m.rows);
      if (m.replay) term.write(m.replay);
      // On a phone the session takes this screen's size; the computer is told of each change,
      // once it settles, since a size that changes twice in a row makes Claude draw twice.
      term.onResize(({ cols, rows }) => {
        if (!entry.drives) return;
        entry.cols = cols; entry.rows = rows;
        clearTimeout(entry.sizeTimer);
        entry.sizeTimer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: entry.cols, rows: entry.rows }));
        }, 150);
        if (current === key) status(describe(entry));
      });
      fit(entry);
      if (current === key) { status(describe(entry)); term.focus(); }
    } else if (m.t === 'out') {
      term.write(m.data);
    } else if (m.t === 'size' && !entry.drives) {
      entry.cols = m.cols; entry.rows = m.rows;
      term.resize(m.cols, m.rows);
      fit(entry);
      if (current === key) status(describe(entry));
    } else if (m.t === 'ended') {
      entry.state = 'ended';
      entry.ended = m.reason || 'The session closed.';
    }
  };
  ws.onclose = () => {
    if (!open.has(key)) return;
    if (entry.state !== 'ended') entry.ended = entry.state === 'connecting' ? 'Could not open that session. It may have closed.' : 'The connection closed.';
    entry.state = 'ended';
    term.write(`\r\n\x1b[38;5;245m— ${entry.ended}\x1b[0m\r\n`);
    entry.tab.classList.add('is-ended');
    if (current === key) status(entry.ended, true);
    refresh();
  };
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN && entry.state === 'open') ws.send(JSON.stringify({ t: 'in', data }));
  });
  show(key);
  drawSessions();
}

function describe(e) {
  const what = e.drives ? 'sized to this screen; it goes back to your computer\'s size when you close it' : 'what you type goes to the session on your computer';
  return `${e.title} · ${e.cols}×${e.rows} · ${what}`;
}

function show(key) {
  current = key;
  view('term');
  for (const e of open.values()) {
    const on = e.key === key;
    e.pane.hidden = !on;
    e.tab.setAttribute('aria-selected', String(on));
  }
  const e = open.get(key);
  if (!e) return;
  requestAnimationFrame(() => fit(e));
  e.term.focus();
  status(e.state === 'open' ? describe(e) : e.state === 'ended' ? e.ended : 'Opening…', e.state === 'ended');
  drawSessions();
}

function closeSession(key) {
  const e = open.get(key);
  if (!e) return;
  open.delete(key);
  try { e.ws.close(); } catch { /* already closed */ }
  e.term.dispose();
  e.pane.remove();
  e.tab.remove();
  if (current === key) {
    current = null;
    const next = [...open.keys()].at(-1);
    if (next) show(next);
    else {
      drawEmpty();
      drawSessions();
      view('list');
    }
  } else drawSessions();
}

$('back').addEventListener('click', () => {
  view('list');
  drawSessions();
});

/**
 * On a phone the session takes this screen's size while it is open here. On a
 * wide screen the size is the app's and only the font changes, so all of its
 * columns and rows fit: measured, then corrected once.
 */
function fit(e) {
  if (e.pane.hidden) return;
  if (NARROW.matches && e.state === 'open') {
    if (e.drives) {
      try { e.fitter.fit(); } catch { /* not laid out yet */ }
      return;
    }
    e.drives = true;
    e.pane.classList.add('is-follows');
    e.term.options.fontSize = PHONE_FONT;
    // Claude draws its whole screen again at the new size; what it drew at the old one would only wrap into a mess.
    if (e.kind === 'claude') e.term.reset();
    requestAnimationFrame(() => {
      try { e.fitter.fit(); } catch { /* not laid out yet */ }
      clearTimeout(e.sizeTimer);
      e.cols = e.term.cols; e.rows = e.term.rows;
      if (e.ws.readyState === WebSocket.OPEN) e.ws.send(JSON.stringify({ t: 'resize', cols: e.cols, rows: e.rows }));
      if (current === e.key) status(describe(e));
    });
    return;
  }
  if (e.drives) {
    // Wide again: the session goes back to the computer's size, which arrives as a size message.
    e.drives = false;
    e.pane.classList.remove('is-follows');
    if (e.ws.readyState === WebSocket.OPEN) e.ws.send(JSON.stringify({ t: 'resize', release: true }));
  }
  const box = $('stage').getBoundingClientRect();
  const width = box.width - 16;
  const height = box.height - 16;
  let size = Math.min(width / (e.cols * 0.602), height / (e.rows * 1.18));
  size = Math.max(6, Math.min(16, Math.floor(size * 2) / 2));
  e.term.options.fontSize = size;
  requestAnimationFrame(() => {
    const screen = e.pane.querySelector('.xterm-screen');
    if (!screen) return;
    const r = screen.getBoundingClientRect();
    const over = Math.max(r.width / width, r.height / height);
    if (over > 1) e.term.options.fontSize = Math.max(6, Math.floor((size / over) * 2) / 2);
  });
}

let fitTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { const e = open.get(current); if (e) fit(e); }, 80);
});

// ---------- keys a phone keyboard does not have ----------
const KEYS = [['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Enter', '\r'], ['Ctrl D', '\x04']];
$('keys').replaceChildren(...KEYS.map(([label, data]) => el('button', {
  type: 'button',
  onclick: () => {
    const e = open.get(current);
    if (e?.state === 'open') { e.ws.send(JSON.stringify({ t: 'in', data })); e.term.focus(); }
  },
}, label)));

(async () => {
  const me = await whoAmI();
  if (me) enter(me);
  else showPair();
})();
