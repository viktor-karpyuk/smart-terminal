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
 * its own, with the same tab and the same size, and the list polls only while
 * the page is shown. iOS also kills a background tab outright: the sessions
 * that were open are remembered and opened again when the page is back.
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
const IOS = /iPhone|iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** The text size on a phone, remembered on this phone; the default suits the screen's width. */
const FONT_MIN = 8;
const FONT_MAX = 22;
let phoneFont = Math.max(11, Math.min(14, Math.round(window.innerWidth / 30)));
try { phoneFont = Math.min(FONT_MAX, Math.max(FONT_MIN, Number(localStorage.getItem('fontSize')) || phoneFont)); } catch { /* no storage: the default */ }
/** How often the list is asked for: often while it is on screen, rarely while a terminal covers it. */
const POLL_LIST_MS = 4000;
const POLL_BEHIND_MS = 15000;
/** A socket that said nothing for this long after a probe is dead, whatever it says. */
const PROBE_MS = 3000;

let computer = '';
let sessions = [];
let sessionsDrawn = '';
/** session id → { key, title, kind, term, ws, pane, tab, fitter, cols, rows, state, drives, tries, retryTimer, followed, probeTimer } */
const open = new Map();
let current = null;
let listTimer = null;
let reachable = true;
/** The next key goes with Ctrl held, from the keys bar. */
let ctrlArmed = false;
let wakeLock = null;

function view(name) {
  document.body.dataset.view = name;
  if (name !== 'term') {
    document.body.classList.remove('has-keyboard');
    document.documentElement.style.setProperty('--keyboard', '0px');
  }
  keepAwake();
  schedulePolling();
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
    try { (waiting ? navigator.setAppBadge(waiting) : navigator.clearAppBadge()).catch(() => {}); } catch { /* badges are a nicety */ }
  }
}

/** The screen stays on while a terminal is watched: a lock would cut the connection and lose the place. */
let wakeLockPending = null;
async function keepAwake() {
  const want = document.body.dataset.view === 'term' && !document.hidden && Boolean(navigator.wakeLock);
  if (want && !wakeLock && !wakeLockPending) {
    // Several events fire together on return; one request serves them all.
    wakeLockPending = navigator.wakeLock.request('screen').then((lock) => {
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      // Asked for, then no longer wanted while it was coming: let it go.
      if (document.body.dataset.view !== 'term' || document.hidden) keepAwake();
    }, () => {}).finally(() => { wakeLockPending = null; });
    await wakeLockPending;
  } else if (!want && wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    try { await lock.release(); } catch { /* gone anyway */ }
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
  $('home-hint').hidden = STANDALONE || !IOS;
  // A link from the computer may carry the code: `?code=ABC123` pairs with one tap. The code stays in the field if pairing fails.
  const given = new URLSearchParams(location.search).get('code');
  if (given) {
    $('code').value = given.toUpperCase();
    if (!COARSE.matches) $('name').focus();
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
$('code').addEventListener('input', () => {
  $('pair-error').textContent = '';
  // Six characters is a whole code: on to the name, as the keyboard's "next" promises.
  if ($('code').value.replace(/[^A-Za-z0-9]/g, '').length === 6) $('name').focus();
});
$('code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); $('name').focus(); }
});
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
    history.replaceState(null, '', location.pathname);
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
  try { await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch { /* the cookie is gone either way */ }
  stopPolling();
  try { navigator.clearAppBadge?.()?.catch?.(() => {}); } catch { /* fine */ }
  remember();
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
/** Asked every few seconds while the list is on screen, rarely while a terminal covers it, never while the page is hidden. */
function startPolling() {
  stopPolling();
  refresh();
  schedulePolling();
}
function schedulePolling() {
  if ($('shell').hidden || document.hidden) return;
  clearInterval(listTimer);
  const behind = NARROW.matches && document.body.dataset.view === 'term';
  listTimer = setInterval(refresh, behind ? POLL_BEHIND_MS : POLL_LIST_MS);
}
function stopPolling() {
  clearInterval(listTimer);
  listTimer = null;
}
/** Back from the lock screen or another app: ask again, and check every open socket is really alive. */
function resume() {
  if (document.hidden) return;
  if (!$('shell').hidden) { refresh(); schedulePolling(); }
  for (const e of open.values()) {
    if (e.state === 'lost') reconnect(e, 0);
    else if (e.state === 'open') probe(e);
  }
  keepAwake();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPolling(); keepAwake(); return; }
  resume();
});
window.addEventListener('pageshow', resume);
window.addEventListener('focus', resume);
window.addEventListener('online', resume);
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
    reopenRemembered();
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
      'data-session': s.id,
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

// ---------- which sessions were open, across a reload ----------
/** iOS throws a background page away and loads it fresh: what was open here is written down, and opened again. */
function remember() {
  try { sessionStorage.setItem('open', JSON.stringify({ keys: [...open.keys()], current, view: document.body.dataset.view })); } catch { /* not remembered */ }
}
let reopened = false;
let reopenPolls = 0;
function reopenRemembered() {
  if (reopened) return;
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('open') ?? 'null'); } catch { saved = null; }
  if (!saved?.keys?.length) { reopened = true; return; }
  // The list can be empty for a moment right after the computer's app starts: a few more looks before giving up.
  if (!sessions.length && reopenPolls++ < 5) return;
  reopened = true;
  for (const key of saved.keys) {
    const s = sessions.find((x) => x.id === key);
    if (s && !open.has(key)) openSession(s, { quiet: true });
  }
  if (saved.view === 'term' && saved.current && open.has(saved.current)) show(saved.current);
  else if (NARROW.matches) view('list');
}

// ---------- one session ----------
function openSession(s, { quiet = false } = {}) {
  const key = s.id;
  if (open.has(key)) {
    if (open.get(key).state !== 'ended') {
      show(key);
      return;
    }
    // Over here, but back in the list: it opens again from scratch.
    closeSession(key, { keepPlace: true });
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
  // The hidden textarea the keyboard types into: no autocorrect, no capitals, no suggestions; a shell wants what was typed.
  if (term.textarea) {
    for (const [k, v] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: 'text', 'data-gramm': 'false' })) term.textarea.setAttribute(k, v);
  }
  const entry = { key, title: s.title || s.folder || 'Session', kind: s.kind, term, pane, fitter, drives: false, followed: false, cols: 80, rows: 24, state: 'connecting', tries: 0, retryTimer: null, sizeTimer: null, probeTimer: null, ws: null };
  entry.tab = el('div', { class: 'tab', role: 'tab' },
    el('button', { class: 'tab-name', type: 'button', onclick: () => show(key) }, el('span', { class: 'tab-dot', 'aria-hidden': 'true' }), el('span', { class: 'tab-text' }, entry.title)),
    el('button', { class: 'tab-close', type: 'button', 'aria-label': `Close ${entry.title} here`, title: 'Close here. The session keeps running.', onclick: () => closeSession(key) }, '×'));
  $('tabs').append(entry.tab);
  open.set(key, entry);
  remember();

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
  // What is typed goes to the session, with the phone's curly quotes made plain and the keys bar's Ctrl applied to the next key.
  term.onData((data) => {
    let out = COARSE.matches ? plain(data) : data;
    if (ctrlArmed && out.length === 1) {
      disarmCtrl();
      const code = out.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) out = String.fromCharCode(code - 64);
    }
    send(entry, out);
  });
  // Swiping on Claude's screen scrolls it: Claude draws its own transcript, so the swipe becomes arrow keys.
  swipeToArrows(entry);

  connect(entry);
  if (!quiet) show(key);
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
      const back = entry.everOpened === true;
      entry.everOpened = true;
      entry.state = 'open';
      entry.tries = 0;
      if (m.kind) entry.kind = m.kind;
      if (m.title) setTitle(entry, m.title);
      // Another device has this session at its size: this screen follows it rather than fighting over it.
      entry.followed = Boolean(m.driven);
      if (m.resumed && entry.drives) {
        // Back within the grace: the computer kept this phone's size, so nothing moves and nothing redraws.
        entry.cols = m.cols; entry.rows = m.rows;
      } else if (back && entry.drives && !m.driven && NARROW.matches) {
        // Back after the grace: the phone's size goes straight out, before the computer's size is drawn and undone.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: entry.cols, rows: entry.rows }));
      } else if (m.resumed && !m.driven && NARROW.matches) {
        // The page was reloaded within the grace: the computer still holds this phone's size, so this phone drives on
        // from where it was, and the computer's redraw fills the screen.
        entry.cols = m.cols; entry.rows = m.rows;
        entry.drives = true;
        entry.pane.classList.add('is-follows');
        term.resize(m.cols, m.rows);
        if (m.replay && !back) term.write(m.replay);
      } else {
        entry.cols = m.cols; entry.rows = m.rows;
        // Not driving any more, said before the resize so its handler does not send this size back as the phone's.
        entry.drives = false;
        entry.pane.classList.remove('is-follows');
        // A full-screen program draws itself again; a shell's scrollback is worth keeping across a blip.
        if (entry.kind === 'claude' || !back) term.reset();
        else term.write('\r\n\x1b[38;5;245m— reconnected\x1b[0m\r\n');
        term.resize(m.cols, m.rows);
        if (m.replay && !back) term.write(m.replay);
        // Turned to the wide side while dropped: the computer kept the phone's size, which nobody wants now.
        if (m.resumed && !m.driven && !NARROW.matches) release(entry);
      }
      fit(entry);
      if (current === key) {
        status(describe(entry));
        $('reconnect').hidden = true;
        if (!COARSE.matches) term.focus();
      }
    } else if (m.t === 'out') {
      term.write(m.data);
    } else if (m.t === 'pong') {
      clearTimeout(entry.probeTimer);
      entry.probeTimer = null;
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
    dropped(entry);
  };
}

/** The socket is gone: over for good if the computer said so, otherwise back on its own, more slowly each time. */
function dropped(entry) {
  const { term, key } = entry;
  {
    clearTimeout(entry.probeTimer);
    entry.probeTimer = null;
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
    if (current === key) {
      status(document.hidden ? 'Connection lost. Back when you return.' : entry.tries > 1 ? `Connection lost. Reconnecting in ${Math.round(wait / 1000)} s…` : 'Connection lost. Reconnecting…', true);
      $('reconnect').hidden = false;
    }
    reconnect(entry, document.hidden ? Infinity : wait);
  }
}

/** A socket that looks open after the phone slept may be dead: ask, and if nothing comes back, drop it so it reconnects. */
function probe(e) {
  if (e.probeTimer || e.ws?.readyState !== WebSocket.OPEN) return;
  e.ws.send(JSON.stringify({ t: 'ping' }));
  e.probeTimer = setTimeout(() => {
    e.probeTimer = null;
    if (e.state !== 'open' || !e.ws) return;
    // A close handshake on a dead socket can take the browser a long while to give up on: it is let go of here and now.
    const dead = e.ws;
    e.ws = null;
    dead.onmessage = null;
    dead.onclose = null;
    try { dead.close(); } catch { /* already gone */ }
    dropped(e);
  }, PROBE_MS);
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

function show(key, { fromHistory = false } = {}) {
  const wasList = document.body.dataset.view !== 'term';
  current = key;
  view('term');
  // In a Safari tab the left-edge swipe goes back: with the list in the history, it goes back to the list, not out of the page.
  if (wasList && NARROW.matches && !fromHistory) {
    if (history.state?.view === 'term') history.replaceState({ view: 'term', key }, '');
    else history.pushState({ view: 'term', key }, '');
  }
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
  else if (wasList) $('back').focus({ preventScroll: true });
  if (e.state === 'open') { status(describe(e)); $('reconnect').hidden = true; }
  else if (e.state === 'ended') { status(e.ended, true); $('reconnect').hidden = true; }
  else if (e.state === 'lost') { status('Connection lost.', true); $('reconnect').hidden = false; }
  else { status('Opening…'); $('reconnect').hidden = true; }
  remember();
  drawSessions();
}

function closeSession(key, { keepPlace = false } = {}) {
  const e = open.get(key);
  if (!e) return;
  open.delete(key);
  clearTimeout(e.sizeTimer);
  clearTimeout(e.retryTimer);
  clearTimeout(e.probeTimer);
  try { e.ws?.close(); } catch { /* already closed */ }
  e.term.dispose();
  e.pane.remove();
  e.tab.remove();
  remember();
  if (keepPlace) { drawSessions(); return; }
  if (current === key) {
    current = null;
    const next = [...open.keys()].at(-1);
    if (next) show(next, { fromHistory: true });
    else {
      drawEmpty();
      drawSessions();
      if (history.state?.view === 'term') history.back();
      else backToList();
    }
  } else drawSessions();
}

function backToList() {
  // The keyboard goes down with the terminal, or it would cover the list.
  document.activeElement?.blur?.();
  view('list');
  drawSessions();
  const row = current ? $('sessions').querySelector(`[data-session="${CSS.escape(current)}"]`) : null;
  if (row && COARSE.matches) row.focus({ preventScroll: true });
  remember();
}
$('back').addEventListener('click', () => {
  if (history.state?.view === 'term') history.back();
  else backToList();
});
window.addEventListener('popstate', () => {
  if (document.body.dataset.view === 'term' && !history.state?.view) backToList();
  else if (history.state?.view === 'term' && open.has(history.state.key)) show(history.state.key, { fromHistory: true });
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
  if (e.drives) release(e);
  const box = $('stage').getBoundingClientRect();
  const width = box.width - 16;
  const height = box.height - 16;
  if (width <= 0 || height <= 0) return;
  let size = Math.min(width / (e.cols * 0.602), height / (e.rows * 1.18));
  // Following another phone on a wide screen, the text may be as big as a phone's; the app's 160 columns may not.
  size = Math.max(6, Math.min(e.followed && COARSE.matches ? FONT_MAX : 16, Math.floor(size * 2) / 2));
  e.term.options.fontSize = size;
  requestAnimationFrame(() => {
    const screen = e.pane.querySelector('.xterm-screen');
    if (!screen) return;
    const r = screen.getBoundingClientRect();
    const over = Math.max(r.width / width, r.height / height);
    if (over > 1) e.term.options.fontSize = Math.max(6, Math.floor((size / over) * 2) / 2);
  });
}

/** Wide again: the session goes back to the computer's size, which arrives as a size message. */
function release(e) {
  e.drives = false;
  e.pane.classList.remove('is-follows');
  if (e.ws?.readyState === WebSocket.OPEN) e.ws.send(JSON.stringify({ t: 'resize', release: true }));
}

let fitTimer = null;
function refit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    // Wide now: every session this screen sized goes back, not only the one in front.
    if (!NARROW.matches) for (const e of open.values()) if (e.drives) release(e);
    const e = open.get(current);
    if (e) fit(e);
  }, 80);
}
window.addEventListener('resize', refit);
// The on-screen keyboard: the page is kept to what is left of the screen, so the bottom of the terminal is not under it.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const keyboard = () => {
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--keyboard', `${Math.round(covered)}px`);
    // What Safari scrolled out of view at the top, when the page itself cannot scroll back.
    document.documentElement.style.setProperty('--viewport-top', `${Math.round(vv.offsetTop)}px`);
    document.body.classList.toggle('has-keyboard', covered > 80);
    // Safari scrolls the page to show the field; the page has nowhere to scroll to.
    if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
    refit();
  };
  vv.addEventListener('resize', keyboard);
  vv.addEventListener('scroll', keyboard);
}
// A pinch on the terminal means bigger or smaller text, not a zoomed page.
let pinchFrom = null;
document.addEventListener('gesturestart', (event) => { event.preventDefault(); pinchFrom = phoneFont; }, { passive: false });
document.addEventListener('gesturechange', (event) => {
  event.preventDefault();
  if (pinchFrom == null || document.body.dataset.view !== 'term') return;
  const next = Math.round(pinchFrom * event.scale);
  if (next !== phoneFont) setFont(next);
}, { passive: false });
document.addEventListener('gestureend', (event) => { event.preventDefault(); pinchFrom = null; }, { passive: false });

/** A swipe on a full-screen program is sent as arrow keys, one per row of movement, since it scrolls its own text. */
function swipeToArrows(e) {
  const screen = e.pane.querySelector('.xterm-screen') ?? e.pane;
  let lastY = null;
  let moved = 0;
  screen.addEventListener('touchstart', (event) => { if (e.kind === 'claude' && event.touches.length === 1) { lastY = event.touches[0].clientY; moved = 0; } }, { passive: true });
  screen.addEventListener('touchmove', (event) => {
    if (e.kind !== 'claude' || lastY == null || event.touches.length !== 1) return;
    const y = event.touches[0].clientY;
    const rowHeight = Math.max(10, (screen.getBoundingClientRect().height || 1) / Math.max(1, e.rows));
    moved += lastY - y;
    lastY = y;
    while (Math.abs(moved) >= rowHeight) {
      send(e, moved > 0 ? '\x1b[B' : '\x1b[A');
      moved += moved > 0 ? -rowHeight : rowHeight;
    }
  }, { passive: true });
  screen.addEventListener('touchend', () => { lastY = null; }, { passive: true });
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
  // Several lines for Claude are one message with soft breaks (Option+Enter); for a shell, one command per line.
  const lines = plain(text).replace(/\r\n?/g, '\n').split('\n');
  send(e, e.kind === 'claude' ? `${lines.join('\x1b\r')}\r` : `${lines.join('\r')}\r`);
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
function disarmCtrl() {
  ctrlArmed = false;
  $('keys').classList.remove('is-ctrl');
  $('keys').querySelector('.ctrl')?.setAttribute('aria-pressed', 'false');
}
const KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'], ['Ctrl', null], ['^C', '\x03'],
  ['↑', '\x1b[A', true], ['↓', '\x1b[B', true], ['←', '\x1b[D', true], ['→', '\x1b[C', true],
  ['Enter', '\r'], ['⌥Enter', '\x1b\r'], ['1', '1'], ['2', '2'], ['3', '3'],
  ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-'], ['Paste', 'paste'], ['^D', '\x04'],
  ['A−', 'smaller'], ['A+', 'bigger'],
];
const KEY_LABELS = { '^C': 'Control C', '^D': 'Control D', '⇧Tab': 'Shift Tab', '⌥Enter': 'Option Enter', Ctrl: 'Control, held for the next key', 'A−': 'Smaller text', 'A+': 'Bigger text', Paste: 'Paste from the clipboard' };
function pressKey(e, data) {
  if (data === 'smaller') return setFont(phoneFont - 1);
  if (data === 'bigger') return setFont(phoneFont + 1);
  if (!e || e.state !== 'open') return;
  if (data === 'paste') {
    navigator.clipboard?.readText?.().then((text) => { if (text) send(e, plain(text)); }).catch(() => status('Paste was not allowed. Hold the terminal and choose Paste instead.', true));
    return;
  }
  let out = data;
  if (ctrlArmed && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    out = code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
    disarmCtrl();
  }
  send(e, out);
}
$('keys').replaceChildren(...KEYS.map(([label, data, repeats]) => {
  let holdTimer = null;
  let repeatTimer = null;
  let repeated = false;
  const stopRepeat = () => { clearTimeout(holdTimer); clearInterval(repeatTimer); holdTimer = null; repeatTimer = null; };
  return el('button', {
    type: 'button',
    class: data === null ? 'ctrl' : data === 'smaller' || data === 'bigger' ? 'size' : null,
    'aria-label': KEY_LABELS[label] ?? label,
    'aria-pressed': data === null ? 'false' : null,
    // A finger on the keys bar must not take the focus: the keyboard would go down and come back up.
    onpointerdown: (event) => {
      event.preventDefault();
      if (!repeats) return;
      // Held: the arrow repeats, as a key does.
      repeated = false;
      holdTimer = setTimeout(() => { repeatTimer = setInterval(() => { repeated = true; pressKey(open.get(current), data); }, 60); }, 400);
    },
    onpointerup: stopRepeat,
    onpointercancel: stopRepeat,
    onpointerleave: stopRepeat,
    onclick: (event) => {
      const e = open.get(current);
      if (data === null) {
        ctrlArmed = !ctrlArmed;
        $('keys').classList.toggle('is-ctrl', ctrlArmed);
        event.currentTarget.setAttribute('aria-pressed', String(ctrlArmed));
        if (ctrlArmed && e && !COARSE.matches) e.term.focus();
        return;
      }
      // Held and repeated: the release is not one more press.
      if (repeated) { repeated = false; return; }
      pressKey(e, data);
      if (e && !COARSE.matches) e.term.focus();
    },
  }, label);
}));

// ---------- the text size on a phone ----------
/** Bigger or smaller text: the session is then asked for the columns and rows that fit. */
function setFont(size) {
  phoneFont = Math.min(FONT_MAX, Math.max(FONT_MIN, size));
  try { localStorage.setItem('fontSize', String(phoneFont)); } catch { /* not remembered, still applied */ }
  for (const b of $('keys').querySelectorAll('.size')) b.disabled = b.textContent === 'A−' ? phoneFont <= FONT_MIN : phoneFont >= FONT_MAX;
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
