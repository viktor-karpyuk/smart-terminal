'use strict';

/*
 * Your Smart Terminal sessions, on your phone, served by your own computer.
 *
 * The page asks the computer which sessions are open and shows them; tapping
 * one opens a WebSocket to the computer for that session, which passes what it
 * prints here and what is typed here back. On a phone the session takes the
 * phone's width while it is open here, so the text is readable; on a wide
 * screen it keeps the size the app gave it and the font shrinks to fit.
 *
 * Phones lose their connection all the time: the screen locks, Wi-Fi hands
 * over to data, Safari suspends the tab. A session that drops comes back on
 * its own, with the same tab, and the list polls only while the page is shown.
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
/** A phone, or a tablet held upright: one screen at a time, and the session takes this screen's size. */
const NARROW = matchMedia('(max-width: 759px)');
/** A finger, not a mouse: no focus that would raise the keyboard uninvited, and the extra keys are shown. */
const COARSE = matchMedia('(pointer: coarse)');
const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
/** The text size on a phone, remembered on this phone. */
const FONT_MIN = 8;
const FONT_MAX = 22;
let phoneFont = 12;
try { phoneFont = Math.min(FONT_MAX, Math.max(FONT_MIN, Number(localStorage.getItem('fontSize')) || 12)); } catch { /* no storage: the default */ }

let computer = '';
let sessions = [];
let sessionsDrawn = '';
/** session id → { key, title, kind, term, ws, pane, tab, fitter, cols, rows, state, drives, tries, retryTimer, waiting } */
const open = new Map();
let current = null;
let listTimer = null;
let reachable = true;
/** The next key goes with Ctrl held, from the keys bar. */
let ctrlArmed = false;

function view(name) {
  document.body.dataset.view = name;
}

/** The line under the terminal: short, because the phone is narrow. */
function status(text, bad = false) {
  $('status').textContent = text;
  $('status').classList.toggle('is-bad', bad);
}

function railNote(text, bad = false) {
  $('rail-note').textContent = text;
  $('rail-note').classList.toggle('is-bad', bad);
  $('dot').classList.toggle('is-bad', bad);
  $('dot').classList.toggle('is-on', !bad && Boolean(text));
  $('retry').hidden = !bad;
}

/** The tab's title and the home-screen badge say when a session needs you. */
function updateTitle() {
  const waiting = sessions.filter((s) => /waiting/.test(s.state)).length;
  const name = computer || 'Smart Terminal';
  document.title = waiting ? `(${waiting}) ${name}` : name;
  if (navigator.setAppBadge) {
    try { waiting ? navigator.setAppBadge(waiting) : navigator.clearAppBadge(); } catch { /* badges are a nicety */ }
  }
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

/** The computer runs a newer build than the page in this tab: reload once, so the two speak the same version. */
function checkVersion(me) {
  if (!me?.version) return;
  try {
    const seen = sessionStorage.getItem('serverVersion');
    sessionStorage.setItem('serverVersion', me.version);
    if (seen && seen !== me.version) location.reload();
  } catch { /* no storage: the page is what it is */ }
}

function showPair() {
  $('shell').hidden = true;
  $('pair').hidden = false;
  view('pair');
  $('home-hint').hidden = STANDALONE || !/iPhone|iPad/.test(navigator.userAgent);
  // A link from the computer may carry the code: `?code=ABC123` pairs with one tap.
  const given = new URLSearchParams(location.search).get('code');
  if (given) {
    $('code').value = given.toUpperCase();
    history.replaceState(null, '', location.pathname);
    $('name').focus();
  } else if (!COARSE.matches) $('code').focus();
}

/** What the computer said, in words that tell the person what to do. */
function pairError(status, message) {
  if (status === 403 && /No code/.test(message)) return 'No code is waiting. On the computer, open Remote and press "Pair a phone", then type the code here.';
  if (status === 403 && /Too many/.test(message)) return 'Too many wrong codes. Ask the computer for a new one.';
  if (status === 429) return 'Wait a second, then try again.';
  return message || 'Could not pair.';
}

$('code').addEventListener('focus', () => $('code').select());
$('code').addEventListener('input', () => { $('pair-error').textContent = ''; });
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('pair-button');
  const code = $('code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 6) {
    $('pair-error').textContent = 'The code has six letters and digits.';
    $('code').focus();
    return;
  }
  button.disabled = true;
  button.textContent = 'Pairing…';
  $('pair-error').textContent = '';
  try {
    const r = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, name: $('name').value.trim(), standalone: STANDALONE }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(pairError(r.status, data.error));
    checkVersion(data);
    enter(data);
  } catch (error) {
    $('pair-error').textContent = /fetch|network/i.test(error.message) ? 'Cannot reach the computer. Is it on, and on the same network?' : error.message;
    if (!COARSE.matches) $('code').focus();
  } finally {
    button.disabled = false;
    button.textContent = 'Pair';
  }
});

// Unpairing asks in the page: a browser dialog looks like somebody else's.
$('forget').addEventListener('click', () => {
  $('confirm').hidden = !$('confirm').hidden;
  if (!$('confirm').hidden) $('confirm-no').focus();
});
$('confirm-no').addEventListener('click', () => { $('confirm').hidden = true; });
$('confirm-yes').addEventListener('click', async () => {
  $('confirm').hidden = true;
  for (const key of [...open.keys()]) closeSession(key);
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* the cookie is gone either way */ }
  stopPolling();
  try { navigator.clearAppBadge?.(); } catch { /* fine */ }
  showPair();
});

function enter(me) {
  computer = me.computer || 'Smart Terminal';
  $('computer').textContent = computer;
  $('pair').hidden = true;
  $('shell').hidden = false;
  $('confirm').hidden = true;
  view('list');
  updateTitle();
  startPolling();
}

// ---------- the list ----------
/** Asked every few seconds while the page is shown; a hidden tab asks nothing and refreshes the moment it is back. */
function startPolling() {
  stopPolling();
  refresh();
  listTimer = setInterval(refresh, 4000);
}
function stopPolling() {
  clearInterval(listTimer);
  listTimer = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
    return;
  }
  if (!$('shell').hidden) startPolling();
  // Sessions that dropped while the phone was asleep come back now, not on their next timer.
  for (const e of open.values()) if (e.state === 'lost') reconnect(e, 0);
});
$('retry').addEventListener('click', () => refresh());

async function refresh() {
  try {
    const r = await fetch('/api/sessions', { headers: { accept: 'application/json' } });
    if (r.status === 401) {
      // Forgotten on the computer: everything open here is over, and the code is asked for again.
      stopPolling();
      for (const key of [...open.keys()]) closeSession(key);
      showPair();
      $('pair-error').textContent = 'This phone was unpaired on the computer. Pair it again with a new code.';
      return;
    }
    const data = await r.json();
    sessions = data.sessions ?? [];
    reachable = true;
    railNote(`Connected to ${computer}`);
  } catch {
    reachable = false;
    railNote(`Cannot reach ${computer}. Is it on, and on the same network?`, true);
  }
  drawSessions();
  updateTitle();
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

/** The list is rebuilt only when something in it changed, so a finger mid-scroll is not thrown off. */
function drawSessions() {
  const box = $('sessions');
  const signature = JSON.stringify([sessions, current, [...open.keys()], reachable]);
  if (signature === sessionsDrawn) return;
  sessionsDrawn = signature;
  const scroll = box.scrollTop;
  if (!sessions.length) {
    box.replaceChildren(el('div', { class: 'empty' },
      el('strong', {}, reachable ? 'No sessions open' : 'Nothing to show'),
      el('span', {}, reachable ? 'Open one in Smart Terminal on your computer and it appears here within a few seconds.' : 'The list comes back once the computer can be reached.')));
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
    el('ul', {}, list.map((s) => el('li', { role: 'listitem' }, el('button', {
      class: 'session',
      type: 'button',
      'aria-current': s.id === current ? 'true' : null,
      onclick: () => openSession(s),
    },
    el('span', { class: `kind is-${s.kind}`, 'aria-hidden': 'true' }, s.kind === 'claude' ? 'C' : '$'),
    el('span', { class: 'session-text' },
      el('span', { class: 'session-title' }, s.title || s.folder || 'Session'),
      el('span', { class: 'session-where' }, [s.folder, s.openOn?.length ? `open on ${s.openOn.join(', ')}` : ''].filter(Boolean).join(' · '))),
    stateLabel(s.state) ? el('span', { class: `state ${stateClass(s.state)}` }, stateLabel(s.state)) : null,
    open.has(s.id) ? el('span', { class: 'open-mark', title: 'Open here', 'aria-label': 'Open here' }) : null)))))));
  box.scrollTop = scroll;
}

function drawEmpty() {
  if (open.size) return;
  $('stage').replaceChildren(el('div', { class: 'stage-empty' },
    el('strong', {}, sessions.length ? 'Pick a session' : 'Nothing to open yet'),
    el('span', {}, sessions.length ? 'Choose one on the left. Typing here types into it, exactly as in Smart Terminal.' : 'Sessions appear here while Smart Terminal is open on your computer.')));
  $('tabs').replaceChildren();
  $('compose').hidden = true;
  status('');
  $('reconnect').hidden = true;
}

// ---------- one session ----------
function openSession(s) {
  const key = s.id;
  if (open.has(key)) {
    show(key);
    return;
  }
  if ($('stage').querySelector('.stage-empty')) $('stage').replaceChildren();

  const pane = el('div', { class: 'pane', hidden: true, role: 'tabpanel' });
  $('stage').append(pane);
  const term = new Terminal({
    fontFamily: FONT, fontSize: 13, lineHeight: 1, theme: THEME, cursorBlink: true, scrollback: 5000,
    allowProposedApi: false, macOptionIsMeta: true, convertEol: false,
  });
  const fitter = new FitAddon.FitAddon();
  term.loadAddon(fitter);
  term.open(pane);
  const entry = { key, title: s.title || s.folder || 'Session', kind: s.kind, term, pane, fitter, drives: false, cols: 80, rows: 24, state: 'connecting', tries: 0, retryTimer: null, sizeTimer: null, ws: null };
  entry.tab = el('div', { class: 'tab', role: 'tab' },
    el('button', { class: 'tab-name', type: 'button', onclick: () => show(key) }, el('span', { class: 'tab-dot', 'aria-hidden': 'true' }), el('span', { class: 'tab-text' }, entry.title)),
    el('button', { class: 'tab-close', type: 'button', 'aria-label': `Close ${entry.title} here`, title: 'Close here. The session keeps running.', onclick: () => closeSession(key) }, '×'));
  $('tabs').append(entry.tab);
  open.set(key, entry);

  // On a phone the session takes this screen's size; the computer is told of each change,
  // once it settles, since a size that changes twice in a row makes Claude draw twice.
  term.onResize(({ cols, rows }) => {
    if (!entry.drives) return;
    entry.cols = cols; entry.rows = rows;
    clearTimeout(entry.sizeTimer);
    entry.sizeTimer = setTimeout(() => {
      entry.sizeTimer = null;
      if (entry.ws?.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify({ t: 'resize', cols: entry.cols, rows: entry.rows }));
    }, 150);
    if (current === key) status(describe(entry));
  });
  term.onData((data) => send(entry, data));
  // The keys bar's Ctrl: the next key typed goes with it.
  term.attachCustomKeyEventHandler((event) => {
    if (!ctrlArmed || event.type !== 'keydown' || event.key.length !== 1) return true;
    ctrlArmed = false;
    $('keys').classList.remove('is-ctrl');
    const code = event.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) send(entry, String.fromCharCode(code - 64));
    return false;
  });

  connect(entry);
  show(key);
  drawSessions();
}

function send(e, data) {
  if (e.ws?.readyState === WebSocket.OPEN && e.state === 'open') e.ws.send(JSON.stringify({ t: 'in', data }));
}

function connect(entry) {
  const { key, term } = entry;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/api/terminal?session=${encodeURIComponent(key)}`);
  entry.ws = ws;
  entry.state = 'connecting';
  entry.tab.classList.remove('is-ended', 'is-lost');
  if (current === key) { status(entry.tries ? 'Reconnecting…' : 'Opening…'); $('reconnect').hidden = true; }
  ws.onmessage = (event) => {
    let m;
    try { m = JSON.parse(event.data); } catch { return; }
    if (m.t === 'opened') {
      entry.state = 'open';
      entry.tries = 0;
      entry.cols = m.cols; entry.rows = m.rows;
      if (m.kind) entry.kind = m.kind;
      if (m.title) setTitle(entry, m.title);
      // Another device has this session at its size: this screen follows it rather than fighting over it.
      entry.followed = Boolean(m.driven);
      // What was on the screen was drawn for another size, or for the connection before this one.
      term.reset();
      term.resize(m.cols, m.rows);
      if (m.replay) term.write(m.replay);
      fit(entry);
      if (current === key) {
        status(describe(entry));
        $('reconnect').hidden = true;
        if (!COARSE.matches) term.focus();
      }
    } else if (m.t === 'out') {
      term.write(m.data);
    } else if (m.t === 'size') {
      // Sized by another device, or back to the computer's size: this screen follows.
      entry.followed = Boolean(m.driven);
      if (entry.drives && !m.driven) return;
      if (entry.drives && m.driven) { entry.drives = false; entry.pane.classList.remove('is-follows'); }
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
    if (!open.has(key) || entry.ws !== ws) return;
    if (entry.state === 'ended') {
      // Over for good: the computer said so.
      term.write(`\r\n\x1b[38;5;245m— ${entry.ended}\x1b[0m\r\n`);
      entry.tab.classList.add('is-ended');
      if (current === key) { status(entry.ended, true); $('reconnect').hidden = true; }
      refresh();
      return;
    }
    // Dropped, not closed: the phone slept, or the network changed. Back on its own, more slowly each time.
    entry.state = 'lost';
    entry.tab.classList.add('is-lost');
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(entry.tries, 5));
    entry.tries += 1;
    if (current === key) { status(entry.tries > 1 ? `Connection lost. Reconnecting in ${Math.round(wait / 1000)} s…` : 'Connection lost. Reconnecting…', true); $('reconnect').hidden = false; }
    reconnect(entry, document.hidden ? Infinity : wait);
  };
}

function reconnect(entry, wait) {
  clearTimeout(entry.retryTimer);
  entry.retryTimer = null;
  if (!open.has(entry.key) || entry.state !== 'lost') return;
  if (wait === Infinity) return;
  entry.retryTimer = setTimeout(() => { if (open.has(entry.key) && entry.state === 'lost') connect(entry); }, wait);
}
$('reconnect').addEventListener('click', () => {
  const e = open.get(current);
  if (e && e.state === 'lost') { e.tries = 0; reconnect(e, 0); }
});

function setTitle(e, title) {
  e.title = title;
  e.tab.querySelector('.tab-text').textContent = title;
  e.tab.querySelector('.tab-close').setAttribute('aria-label', `Close ${title} here`);
}

function describe(e) {
  if (e.followed) return `${e.cols}×${e.rows} · sized by another device`;
  if (e.drives) return `${e.cols}×${e.rows} · sized to this screen`;
  return `${e.cols}×${e.rows} · the computer's size`;
}

function show(key) {
  current = key;
  view('term');
  for (const e of open.values()) {
    const on = e.key === key;
    e.pane.hidden = !on;
    e.tab.setAttribute('aria-selected', String(on));
    e.pane.setAttribute('aria-hidden', String(!on));
  }
  const e = open.get(key);
  if (!e) return;
  requestAnimationFrame(() => fit(e));
  $('compose').hidden = !COARSE.matches;
  if (!COARSE.matches) e.term.focus();
  if (e.state === 'open') { status(describe(e)); $('reconnect').hidden = true; }
  else if (e.state === 'ended') { status(e.ended, true); $('reconnect').hidden = true; }
  else if (e.state === 'lost') { status('Connection lost.', true); $('reconnect').hidden = false; }
  else { status('Opening…'); $('reconnect').hidden = true; }
  drawSessions();
}

function closeSession(key) {
  const e = open.get(key);
  if (!e) return;
  open.delete(key);
  clearTimeout(e.sizeTimer);
  clearTimeout(e.retryTimer);
  try { e.ws?.close(); } catch { /* already closed */ }
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
  // The keyboard goes down with the terminal, or it would cover the list.
  document.activeElement?.blur?.();
  view('list');
  drawSessions();
});

/**
 * On a phone the session takes this screen's size while it is open here. On a
 * wide screen the size is the app's and only the font changes, so all of its
 * columns and rows fit: measured, then corrected once.
 */
function fit(e) {
  if (e.pane.hidden || e.state !== 'open') return;
  if (NARROW.matches && !e.followed) {
    if (e.drives) {
      try { e.fitter.fit(); } catch { /* not laid out yet */ }
      return;
    }
    e.drives = true;
    e.pane.classList.add('is-follows');
    e.term.options.fontSize = phoneFont;
    // Claude draws its whole screen again at the new size; what it drew at the old one would only wrap into a mess.
    if (e.kind === 'claude') e.term.reset();
    requestAnimationFrame(() => {
      try { e.fitter.fit(); } catch { /* not laid out yet */ }
      clearTimeout(e.sizeTimer);
      e.sizeTimer = null;
      e.cols = e.term.cols; e.rows = e.term.rows;
      if (e.ws?.readyState === WebSocket.OPEN) e.ws.send(JSON.stringify({ t: 'resize', cols: e.cols, rows: e.rows }));
      if (current === e.key) status(describe(e));
    });
    return;
  }
  if (e.drives) {
    // Wide again: the session goes back to the computer's size, which arrives as a size message.
    e.drives = false;
    e.pane.classList.remove('is-follows');
    if (e.ws?.readyState === WebSocket.OPEN) e.ws.send(JSON.stringify({ t: 'resize', release: true }));
  }
  const box = $('stage').getBoundingClientRect();
  const width = box.width - 16;
  const height = box.height - 16;
  if (width <= 0 || height <= 0) return;
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
function refit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { const e = open.get(current); if (e) fit(e); }, 80);
}
window.addEventListener('resize', refit);
// The on-screen keyboard: the page is kept to what is left of the screen, so the bottom of the terminal is not under it.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const keyboard = () => {
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--keyboard', `${Math.round(covered)}px`);
    document.body.classList.toggle('has-keyboard', covered > 80);
    refit();
  };
  vv.addEventListener('resize', keyboard);
  vv.addEventListener('scroll', keyboard);
}

// ---------- a line at a time ----------
/** Phones put curly quotes and long dashes where a shell wants the plain ones. */
function plain(text) {
  return text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ');
}
$('compose').addEventListener('submit', (event) => {
  event.preventDefault();
  const e = open.get(current);
  const text = $('compose-text').value;
  if (!e || e.state !== 'open') return;
  send(e, `${plain(text)}\r`);
  $('compose-text').value = '';
  $('compose-text').style.height = '';
  $('compose-text').focus();
});
$('compose-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('compose').requestSubmit();
  }
});
$('compose-text').addEventListener('input', () => {
  const box = $('compose-text');
  box.style.height = '';
  box.style.height = `${Math.min(120, box.scrollHeight)}px`;
});

// ---------- keys a phone keyboard does not have ----------
const KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'], ['Ctrl', null], ['^C', '\x03'],
  ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['Enter', '\r'], ['⌥Enter', '\x1b\r'], ['1', '1'], ['2', '2'], ['3', '3'], ['^D', '\x04'],
];
$('keys').replaceChildren(...KEYS.map(([label, data]) => el('button', {
  type: 'button',
  class: data === null ? 'ctrl' : null,
  'aria-label': label === '^C' ? 'Control C' : label === '^D' ? 'Control D' : label === '⇧Tab' ? 'Shift Tab' : label === '⌥Enter' ? 'Option Enter' : label === 'Ctrl' ? 'Control, held for the next key' : label,
  'aria-pressed': data === null ? 'false' : null,
  onclick: (event) => {
    const e = open.get(current);
    if (data === null) {
      ctrlArmed = !ctrlArmed;
      $('keys').classList.toggle('is-ctrl', ctrlArmed);
      event.currentTarget.setAttribute('aria-pressed', String(ctrlArmed));
      if (ctrlArmed && e) e.term.focus();
      return;
    }
    if (e?.state === 'open') {
      let out = data;
      if (ctrlArmed && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        out = code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
        ctrlArmed = false;
        $('keys').classList.remove('is-ctrl');
        $('keys').querySelector('.ctrl')?.setAttribute('aria-pressed', 'false');
      }
      send(e, out);
      // A finger on the keys bar should not raise the keyboard; a mouse may keep the cursor.
      if (!COARSE.matches) e.term.focus();
    }
  },
}, label)));

// ---------- the text size on a phone ----------
/** Bigger or smaller text: the session is then asked for the columns and rows that fit. */
function setFont(size) {
  phoneFont = Math.min(FONT_MAX, Math.max(FONT_MIN, size));
  try { localStorage.setItem('fontSize', String(phoneFont)); } catch { /* not remembered, still applied */ }
  $('smaller').disabled = phoneFont <= FONT_MIN;
  $('bigger').disabled = phoneFont >= FONT_MAX;
  for (const e of open.values()) {
    if (!e.drives) continue;
    e.term.options.fontSize = phoneFont;
    if (!e.pane.hidden) {
      requestAnimationFrame(() => {
        try { e.fitter.fit(); } catch { /* not laid out yet */ }
      });
    }
  }
}
$('smaller').addEventListener('click', () => setFont(phoneFont - 1));
$('bigger').addEventListener('click', () => setFont(phoneFont + 1));
setFont(phoneFont);

// A tablet turned, or a window dragged across the line: the open session changes mode.
NARROW.addEventListener?.('change', refit);

(async () => {
  const me = await whoAmI();
  if (me) {
    checkVersion(me);
    enter(me);
  } else showPair();
})();
