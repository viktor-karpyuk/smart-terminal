#!/usr/bin/env node
'use strict';

/**
 * Tell Smart Terminal what just happened, and pass its answer back to Claude.
 *
 * This runs inside a Claude session, as a child of it, once per event. Three
 * rules follow from that and shape everything below.
 *
 * It must be **fast**, because Claude waits for it. It talks to a unix socket
 * in the app's own data directory — no network, no disk, no dependencies — and
 * gives up quickly if the app is not there.
 *
 * It must be **quiet**. Anything on stdout that is not JSON is noise in
 * somebody's session, so the only thing ever printed is the app's answer, and
 * `{}` when there is nothing to say.
 *
 * And it must **never be the reason something fails**. Smart Terminal being
 * closed, mid-restart, or simply not the thing that started this session are
 * all ordinary; every one of them exits 0 having printed nothing. A hook that
 * can break a session is worse than no hook at all.
 */

const net = require('node:net');

/** Claude waits on this, so it is short on purpose. */
const DEADLINE_MS = 1500;

/** Say nothing, successfully. The normal outcome when the app is not listening. */
function quiet() {
  process.stdout.write('{}\n');
  process.exit(0);
}

function read(stream) {
  return new Promise((resolve) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
    });
    stream.on('end', () => resolve(text));
    stream.on('error', () => resolve(''));
    // A hook invoked with nothing on stdin should not hang waiting for it.
    setTimeout(() => resolve(text), 400).unref?.();
  });
}

async function main() {
  const socketPath = process.env.SMART_TERMINAL_BRIDGE;
  if (!socketPath) quiet(); // not a session this app started

  const event = process.argv[2];
  if (!event) quiet();

  let payload = {};
  try {
    const raw = await read(process.stdin);
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    // Claude sends well-formed JSON; if this ever is not, reporting a broken
    // event is worse than reporting none.
    quiet();
  }

  const request = {
    op: 'hook',
    event,
    // The app's own id for this session, handed to the shell that started it.
    // Present for sessions the app launched, absent for one somebody typed
    // `claude` into — and the app can still place that one by conversation.
    session: process.env.SMART_TERMINAL_SESSION_ID || null,
    cwd: process.cwd(),
    at: Date.now(),
    payload,
  };

  const socket = net.createConnection(socketPath);
  let answered = false;
  let buffer = '';

  const done = (text) => {
    if (answered) return;
    answered = true;
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
    process.stdout.write(`${text}\n`);
    process.exit(0);
  };

  const timer = setTimeout(() => done('{}'), DEADLINE_MS);
  timer.unref?.();

  socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on('error', () => done('{}'));
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const cut = buffer.indexOf('\n');
    if (cut === -1) return;
    let answer;
    try {
      answer = JSON.parse(buffer.slice(0, cut));
    } catch {
      done('{}');
      return;
    }
    // The app replies with what Claude should be told, or with nothing. Its
    // bookkeeping — `ok`, an error — is not Claude's business.
    done(JSON.stringify(answer && answer.reply ? answer.reply : {}));
  });
  socket.on('end', () => done('{}'));
}

main().catch(() => quiet());
