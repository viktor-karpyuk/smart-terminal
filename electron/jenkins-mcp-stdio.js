'use strict';

/**
 * Jenkins, as an MCP server a Claude session starts.
 *
 * A relay and nothing more. It knows which session it belongs to (the id the
 * app put in its environment) and where the app listens; every question
 * crosses the app's socket and the app — which holds the servers, the tokens
 * and the rules — answers it. Nothing here is checked, redacted or limited,
 * because a rule enforced in a process the model can influence is not a rule:
 * all of that is in `jenkins-mcp.js`, on the other side of the socket.
 *
 * Which tools exist is also the app's say. With no Jenkins connected the list
 * is empty, so a session that will never use them is not charged for their
 * descriptions. (A session started before a server was added keeps the empty
 * list until it restarts: the CLI asks once.)
 *
 * The protocol is spoken by hand, like `review-bus-mcp.js`, and **stdout is
 * the protocol**: a stray `console.log` here takes the tools away.
 */

const net = require('node:net');
const readline = require('node:readline');
const { BY_NAME, listing } = require('./jenkins-mcp-tools');

const BRIDGE = process.env.SMART_TERMINAL_BRIDGE || '';
const SESSION_ID = process.env.SMART_TERMINAL_SESSION_ID || '';
/** What the app told this session at its start, in nobody's roster: how it proves it is itself. */
const SECRET = process.env.SMART_TERMINAL_SESSION_SECRET || '';
/** A request to run a job waits for a person to answer a dialog: it gets minutes, the rest get seconds. */
const TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 6 * 60_000;

/** How often a running session is told the list of tools changed, if it did: the person may turn Jenkins off while it works. */
const POLL_MS = Math.max(200, Number(process.env.SMART_TERMINAL_JENKINS_POLL_MS) || 20_000);

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

function ask(tool, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!BRIDGE || !SESSION_ID) {
      resolve({ ok: false, error: 'This Claude is not connected to Smart Terminal, so there is no Jenkins to ask.' });
      return;
    }
    let settled = false;
    const socket = net.createConnection(BRIDGE);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'Smart Terminal did not answer.' }), timeoutMs);
    timer.unref?.();
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'jenkins', tool, args, from: SESSION_ID, secret: SECRET })}\n`));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // The longest answer is a few dozen kilobytes; a peer that sends megabytes without a newline is not the app.
      if (buffer.length > 2_000_000) return done({ ok: false, error: 'Smart Terminal sent something too large.' });
      const cut = buffer.indexOf('\n');
      if (cut === -1) return undefined;
      try {
        return done(JSON.parse(buffer.slice(0, cut)));
      } catch {
        return done({ ok: false, error: 'Smart Terminal sent something unreadable.' });
      }
    });
    socket.on('error', (error) => done({ ok: false, error: `Could not reach Smart Terminal: ${error.message}` }));
    socket.on('close', () => done({ ok: false, error: 'Smart Terminal closed the connection.' }));
  });
}

const text = (body, isError = false) => ({ content: [{ type: 'text', text: String(body) }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args = {}) {
  // Only a name this file knows is forwarded; the app checks it again.
  if (typeof name !== 'string' || !BY_NAME.has(name)) return text(`No such tool: ${String(name).slice(0, 60)}`, true);
  const reply = await ask(name, args, name === 'request_run' ? RUN_TIMEOUT_MS : TIMEOUT_MS);
  return reply.ok ? text(reply.text) : text(reply.error, true);
}

/** What the app offers right now, and — when it offers nothing because the person said so — why. */
async function available() {
  const reply = await ask('_available', {}, 5000);
  // Asked too often: what was offered a moment ago still stands.
  if (reply.limited) return { tools: lastOffered ? lastOffered.split(',').filter(Boolean) : [], message: null };
  // Not reachable, or nothing connected: no tools, rather than tools that can only say no.
  if (!reply.ok || !Array.isArray(reply.tools)) return { tools: [], message: null };
  return { tools: reply.tools, message: reply.enabled === false && typeof reply.message === 'string' ? reply.message : null };
}

let lastOffered = null;
let polling = null;

/** Tell the session when what is offered changes, so turning Jenkins off or on does not wait for a restart. */
function watchOffer(initial) {
  lastOffered = initial.join(',');
  if (polling) return;
  polling = setInterval(async () => {
    const now = (await available()).tools.join(',');
    if (now === lastOffered) return;
    lastOffered = now;
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }, POLL_MS);
  polling.unref?.();
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    // Said up front, so a session that finds no tools knows it was a decision and not a fault.
    const offer = await available();
    watchOffer(offer.tools);
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'jenkins', version: '1.0.0' },
        ...(offer.message ? { instructions: offer.message } : {}),
      },
    });
  }
  if (method === 'tools/list') {
    const offer = await available();
    lastOffered = offer.tools.join(',');
    return send({ jsonrpc: '2.0', id, result: { tools: listing(offer.tools) } });
  }
  if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments || {}) });
  if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
  if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (!isRequest) return undefined;
  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

if (require.main === module) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    Promise.resolve(handle(message)).catch((error) => {
      if (message.id !== undefined && message.id !== null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
    });
  });
  lines.on('close', () => process.exit(0));
}

module.exports = { handle };
