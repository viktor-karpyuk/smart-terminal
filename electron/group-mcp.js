'use strict';

/**
 * The MCP server a Claude session talks to its neighbours through.
 *
 * It is spawned by the Claude CLI, one per session, and it is deliberately thin:
 * it knows who it is and where the app is listening, and every question it is
 * asked goes over a socket to the app, which is the only thing that knows the
 * roster, the groups and how to reach a terminal. Nothing here decides who may
 * speak to whom — that lives in `messaging.js`, on the app's side of the socket,
 * because a rule enforced in a process the model can see is not a rule.
 *
 * The protocol is spoken by hand rather than through an SDK. The subset that
 * matters is `initialize`, `tools/list` and `tools/call` over newline-delimited
 * JSON-RPC on stdin/stdout, which is a page of code — and this app ships with
 * seven runtime dependencies, none of which it could have avoided.
 *
 * One rule holds the whole thing up: **stdout is the protocol**. A stray
 * `console.log` anywhere in this file corrupts the stream and the session loses
 * its tools with no error worth reading. Diagnostics go to stderr.
 */

const net = require('node:net');
const readline = require('node:readline');

const SESSION_ID = process.env.SMART_TERMINAL_SESSION_ID || '';
const BRIDGE = process.env.SMART_TERMINAL_BRIDGE || '';
/** The app is local and answering from memory; a request that hangs is a bug, not slow. */
const TIMEOUT_MS = 10000;

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'List the other Smart Terminal sessions you can talk to right now, with what each is ' +
      'working on and whether it is busy. Reach is set by the user: normally the other sessions ' +
      'in your own group, optionally every session in the app. Call this before sending anything, ' +
      'so you address a session that is actually there.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_message',
    description:
      'Send a message to one other session you can reach. Give the name or id from list_sessions. ' +
      'The message arrives in that session as a labelled note saying it came from you — it is ' +
      'delivered when that session is next waiting at its prompt, and waits in its inbox until ' +
      'then. Use it to hand over a finding, ask for something, or answer what was asked of you.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Name or id of the session, from list_sessions.' },
        message: { type: 'string', description: 'What to say. Plain text.' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'broadcast_message',
    description:
      'Send a message to every session you can reach at once — your whole group, or every ' +
      'session, depending on what the user has set. Use it for something they all need; prefer ' +
      'send_message when it concerns one of them.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'What to say. Plain text.' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_messages',
    description:
      'Read the messages other sessions have sent you that you have not seen yet. Messages are ' +
      'normally delivered into your conversation on their own, so this is for catching up after ' +
      'you have been busy, or for checking deliberately before you act.',
    inputSchema: {
      type: 'object',
      properties: {
        peek: {
          type: 'boolean',
          description: 'Read without marking them seen. Defaults to false.',
        },
      },
      additionalProperties: false,
    },
  },
];

/** One round trip to the app. A fresh connection per call: these are rare and small. */
function ask(op, payload = {}) {
  return new Promise((resolve) => {
    if (!BRIDGE || !SESSION_ID) {
      resolve({ ok: false, error: 'This session is not connected to Smart Terminal.' });
      return;
    }
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    const socket = net.createConnection(BRIDGE);
    const timer = setTimeout(() => done({ ok: false, error: 'Smart Terminal did not answer.' }), TIMEOUT_MS);
    timer.unref?.();

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ op, from: SESSION_ID, ...payload })}\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const line = buffer.indexOf('\n');
      if (line === -1) return;
      clearTimeout(timer);
      try {
        done(JSON.parse(buffer.slice(0, line)));
      } catch {
        done({ ok: false, error: 'Smart Terminal sent something unreadable.' });
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, error: `Could not reach Smart Terminal: ${error.message}` });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      done({ ok: false, error: 'Smart Terminal closed the connection.' });
    });
  });
}

/** A tool result. `isError` is how a tool says "that did not work" without failing the call. */
const text = (body, isError = false) => ({
  content: [{ type: 'text', text: String(body) }],
  ...(isError ? { isError: true } : {}),
});

async function callTool(name, args = {}) {
  if (name === 'list_sessions') {
    const reply = await ask('roster');
    if (!reply.ok) return text(reply.error, true);
    if (!reply.sessions.length) {
      return text(
        reply.reach === 'off'
          ? 'Session messaging is turned off in Smart Terminal, so you cannot reach anyone.'
          : reply.reach === 'group'
            ? 'There is nobody else to talk to: you reach only the other sessions in your own ' +
              'group, and right now there are none. The user can widen this to every session in ' +
              "Smart Terminal's settings."
            : 'There are no other sessions running.',
      );
    }
    const lines = reply.sessions.map(
      (s) =>
        `- ${s.name} (${s.id.slice(0, 8)}) — ${s.profile}, in ${s.cwd}` +
        `${s.group ? `, group ${s.group}` : ''} — ${s.state}`,
    );
    return text(
      `You can reach ${reply.sessions.length} session${reply.sessions.length === 1 ? '' : 's'} ` +
        `(${reply.reach === 'all' ? 'every session in the app' : `your group, ${reply.group ?? 'unnamed'}`}):\n` +
        lines.join('\n'),
    );
  }

  if (name === 'send_message') {
    const reply = await ask('send', { to: args.to, message: args.message });
    if (!reply.ok) return text(reply.error, true);
    return text(reply.detail);
  }

  if (name === 'broadcast_message') {
    const reply = await ask('broadcast', { message: args.message });
    if (!reply.ok) return text(reply.error, true);
    return text(reply.detail);
  }

  if (name === 'read_messages') {
    const reply = await ask('inbox', { peek: args.peek === true });
    if (!reply.ok) return text(reply.error, true);
    if (!reply.messages.length) return text('No messages waiting.');
    return text(
      reply.messages
        .map((m) => `From ${m.from} at ${new Date(m.at).toLocaleTimeString()}:\n${m.text}`)
        .join('\n\n'),
    );
  }

  return text(`No such tool: ${name}`, true);
}

// --- the JSON-RPC plumbing --------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(message) {
  const { id, method, params } = message;
  // A notification has no id and takes no answer — replying to one is a protocol
  // error, and `notifications/initialized` arrives on every single startup.
  const isRequest = id !== undefined && id !== null;

  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    return reply(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'smart-terminal-sessions', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const result = await callTool(params?.name, params?.arguments || {});
    return reply(id, result);
  }
  // Servers that declare neither capability are still asked for both by some
  // clients; an empty list is the honest answer and keeps the session quiet.
  if (method === 'resources/list') return reply(id, { resources: [] });
  if (method === 'prompts/list') return reply(id, { prompts: [] });
  if (method === 'ping') return reply(id, {});
  if (!isRequest) return undefined;
  return fail(id, -32601, `Method not found: ${method}`);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  Promise.resolve(handle(message)).catch((error) => {
    if (message.id !== undefined && message.id !== null) {
      fail(message.id, -32603, String(error?.message ?? error));
    }
  });
});
lines.on('close', () => process.exit(0));
