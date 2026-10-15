'use strict';

/*
 * Your Smart Terminal sessions, in the browser.
 *
 * Each session opened here is one WebSocket to the server, which passes it on
 * to the app on the machine the session runs on. The session keeps the size
 * the app gave it — the app is still showing it — so the text here is sized
 * to fit that many columns and rows into the window, not the other way round.
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

let devices = [];
let enabled = true;
/** key `${device}/${session}` → { key, device, session, title, term, ws, pane, tab, cols, rows, state } */
const open = new Map();
let current = null;

const keyOf = (device, session) => `${device}/${session}`;

function status(text, bad = false) {
  $('status').textContent = text;
  $('status').classList.toggle('is-bad', bad);
}

// ---------- the list of devices and sessions ----------
async function refresh() {
  try {
    const r = await fetch('/api/web/terminals', { headers: { accept: 'application/json' } });
    if (r.status === 401) { location.href = '/login'; return; }
    const data = await r.json();
    enabled = data.enabled;
    devices = data.devices;
  } catch {
    // Keep what is on screen; the next try may reach the server.
  }
  drawDevices();
  if (!open.size) drawEmpty();
}

function drawDevices() {
  const box = $('devices');
  if (!enabled) {
    box.replaceChildren(el('p', { class: 'term-note' }, 'Your company has turned off the terminal in the browser.'));
    return;
  }
  if (!devices.length) {
    box.replaceChildren(el('p', { class: 'term-note' }, 'No device is connected. In Smart Terminal, open the Organization extension and turn on ', el('strong', {}, 'Open my sessions from the browser'), '.'));
    return;
  }
  box.replaceChildren(...devices.map((d) => el('section', { class: 'term-device' },
    el('h2', {}, el('span', { class: 'term-dot', 'aria-hidden': 'true' }), d.label),
    d.sessions.length ? el('ul', {}, d.sessions.map((s) => {
      const key = keyOf(d.id, s.id);
      return el('li', {}, el('button', {
        class: 'term-session',
        'aria-current': key === current ? 'true' : null,
        onclick: () => openSession(d, s),
      },
      el('span', { class: `term-kind is-${s.kind}` }, s.kind === 'claude' ? 'C' : '$'),
      el('span', { class: 'term-session-text' },
        el('span', { class: 'term-session-title' }, s.title || s.folder || 'Session'),
        el('span', { class: 'term-session-where' }, s.repo || s.folder || '')),
      open.has(key) ? el('span', { class: 'term-open-mark', title: 'Open here' }) : null));
    })) : el('p', { class: 'term-note' }, 'No sessions open.'))));
}

function drawEmpty() {
  if (open.size) return;
  const any = devices.some((d) => d.sessions.length);
  $('stage').replaceChildren(el('div', { class: 'term-empty' },
    el('strong', {}, !enabled ? 'Turned off' : any ? 'Pick a session' : 'Nothing to open yet'),
    el('span', {}, !enabled ? 'Ask an administrator to turn on the terminal in the browser.'
      : any ? 'Choose one on the left. Typing here types into it, on your machine, exactly as in Smart Terminal.'
        : 'Sessions appear here while Smart Terminal is open on a computer you are signed in on, and it allows it.')));
  $('tabs').replaceChildren();
  status('');
}

// ---------- one session ----------
function openSession(device, session) {
  const key = keyOf(device.id, session.id);
  if (open.has(key)) return show(key);
  if ($('stage').querySelector('.term-empty')) $('stage').replaceChildren();

  const pane = el('div', { class: 'term-pane', hidden: true });
  $('stage').append(pane);
  const term = new Terminal({
    fontFamily: FONT, fontSize: 13, lineHeight: 1, theme: THEME, cursorBlink: true, scrollback: 5000,
    allowProposedApi: false, macOptionIsMeta: true, convertEol: false,
  });
  term.open(pane);
  const entry = { key, device: device.id, session: session.id, title: session.title || session.folder || 'Session', term, pane, cols: 80, rows: 24, state: 'connecting' };
  entry.tab = el('div', { class: 'term-tab', role: 'tab' },
    el('button', { class: 'term-tab-name', onclick: () => show(key) }, entry.title),
    el('button', { class: 'term-tab-close', 'aria-label': `Close ${entry.title} here`, title: 'Close here. The session keeps running.', onclick: () => closeSession(key) }, '×'));
  $('tabs').append(entry.tab);
  open.set(key, entry);

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/api/web/terminal?device=${encodeURIComponent(device.id)}&session=${encodeURIComponent(session.id)}`);
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
      fit(entry);
      if (current === key) { status(describe(entry)); term.focus(); }
    } else if (m.t === 'out') {
      term.write(m.data);
    } else if (m.t === 'size') {
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
    if (entry.state !== 'ended') entry.ended = entry.state === 'connecting' ? 'Could not open that session. It may have closed, or the device may not allow it.' : 'The connection closed.';
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
  drawDevices();
}

function describe(e) {
  return `${e.title} · ${e.cols}×${e.rows} · what you type goes to the session on your computer`;
}

function show(key) {
  current = key;
  for (const e of open.values()) {
    const on = e.key === key;
    e.pane.hidden = !on;
    e.tab.setAttribute('aria-selected', String(on));
  }
  const e = open.get(key);
  if (!e) return;
  fit(e);
  e.term.focus();
  status(e.state === 'open' ? describe(e) : e.state === 'ended' ? e.ended : 'Opening…', e.state === 'ended');
  drawDevices();
}

function closeSession(key) {
  const e = open.get(key);
  if (!e) return;
  open.delete(key);
  try { e.ws.close(); } catch {}
  e.term.dispose();
  e.pane.remove();
  e.tab.remove();
  if (current === key) {
    current = null;
    const next = [...open.keys()].at(-1);
    if (next) show(next); else { drawEmpty(); drawDevices(); }
  } else drawDevices();
}

/**
 * The session's size is the app's; the font is what changes, so that all of
 * its columns and rows fit in this window. Measured, then corrected once.
 */
function fit(e) {
  if (e.pane.hidden) return;
  const box = $('stage').getBoundingClientRect();
  const width = box.width - 24;
  const height = box.height - 24;
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
const KEYS = [['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl C', '\x03'], ['Ctrl D', '\x04'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Enter', '\r']];
$('keys').replaceChildren(...KEYS.map(([label, data]) => el('button', {
  type: 'button',
  onclick: () => {
    const e = open.get(current);
    if (e?.state === 'open') { e.ws.send(JSON.stringify({ t: 'in', data })); e.term.focus(); }
  },
}, label)));

(async () => {
  const info = await fetch('/api/providers').then((r) => r.json()).catch(() => ({}));
  if (info.orgName) { $('org').textContent = info.orgName; document.title = `Terminal · ${info.orgName}`; }
  await refresh();
  setInterval(refresh, 5000);
})();
