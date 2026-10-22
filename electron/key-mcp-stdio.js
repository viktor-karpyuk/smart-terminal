'use strict';

/**
 * A product reached with an API key (Timelogbook, Kubrik OS), as an MCP server
 * a Claude session starts. Which product is `SMART_TERMINAL_RELAY` in its
 * environment, set by the app's MCP config.
 *
 * A relay, like `jenkins-mcp-stdio.js`. The product's own servers are on the
 * network and want the person's API key; the key is the app's, encrypted, and
 * never written into a session's config or environment. So the session talks
 * to this, this crosses the app's socket, and the app — a `KeyMcpService` —
 * calls the product with the key and answers. Which tools exist is whatever the
 * key reaches, and only while the person lets sessions use it.
 *
 * **stdout is the protocol**: a stray `console.log` here takes the tools away.
 */

const net = require('node:net');
const readline = require('node:readline');

/** What a session is told about each product when it starts. */
const PRODUCTS = {
  timelogbook: {
    name: 'Timelogbook',
    instructions: 'Timelogbook v4: tasks, hours, projects and the rest of the suite, as the person who made the API key sees them. Tool names start with their app (me_, tasks_, projects_…). Read-only tools run at once; anything that changes Timelogbook is shown to the person first.',
  },
  kubrik: {
    name: 'Kubrik OS',
    instructions: 'Kubrik OS (kubrik.io): the ERP — accounting, orders, warehouse, CRM, purchasing, people, projects, documents — as the person who made the API key sees them. Tool names start with their module (acc_, oms_, crm_…); <module>_ask_agent asks that module\'s own agent. Read-only tools run at once; anything that changes Kubrik OS is shown to the person first, and below the Autonomous tier a write comes back as proposal_pending: nothing changed yet — tell the person to confirm it at confirmUrl in Kubrik OS, and check it with <module>_kos_proposal_status.',
  },
};

const BRIDGE = process.env.SMART_TERMINAL_BRIDGE || '';
const SESSION_ID = process.env.SMART_TERMINAL_SESSION_ID || '';
const SECRET = process.env.SMART_TERMINAL_SESSION_SECRET || '';
/** Which product: the op the app's socket answers it under. */
const RELAY = PRODUCTS[process.env.SMART_TERMINAL_RELAY] ? process.env.SMART_TERMINAL_RELAY : 'timelogbook';
const PRODUCT = PRODUCTS[RELAY];
/** A tool that changes something waits up to two minutes for a person's answer, and an agent's turn may take two and a half more. */
const TIMEOUT_MS = 5 * 60_000;
const POLL_MS = Math.max(200, Number(process.env.SMART_TERMINAL_RELAY_POLL_MS) || 30_000);

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

function ask(tool, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!BRIDGE || !SESSION_ID) {
      resolve({ ok: false, error: `This Claude is not connected to Smart Terminal, so there is no ${PRODUCT.name} to ask.` });
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
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: RELAY, tool, args, from: SESSION_ID, secret: SECRET })}\n`));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
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

let offered = [];
let lastOffered = null;
let polling = null;

async function available() {
  const reply = await ask('_available', {}, 30_000);
  if (!reply.ok || !Array.isArray(reply.tools)) return { tools: [], message: null };
  return { tools: reply.tools, message: reply.enabled === false && typeof reply.message === 'string' ? reply.message : null };
}

const names = (tools) => tools.map((t) => t.name).join(',');

function watchOffer() {
  if (polling) return;
  polling = setInterval(async () => {
    const now = await available();
    if (names(now.tools) === lastOffered) return;
    offered = now.tools;
    lastOffered = names(now.tools);
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }, POLL_MS);
  polling.unref?.();
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callTool(name, args = {}) {
  if (typeof name !== 'string' || !/^[a-z]+_[a-z0-9_]+$/.test(name)) return text(`No such tool: ${String(name).slice(0, 60)}`, true);
  const reply = await ask(name, args);
  return reply.ok ? text(reply.text) : text(reply.error, true);
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    const offer = await available();
    offered = offer.tools;
    lastOffered = names(offer.tools);
    watchOffer();
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: RELAY, version: '1.0.0' },
        instructions: offer.message ?? PRODUCT.instructions,
      },
    });
  }
  if (method === 'tools/list') {
    const offer = await available();
    offered = offer.tools;
    lastOffered = names(offer.tools);
    return send({ jsonrpc: '2.0', id, result: { tools: offered } });
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
