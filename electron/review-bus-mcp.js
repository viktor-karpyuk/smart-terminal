'use strict';

/**
 * The Code Reviewer bus, as an MCP server a Claude process starts.
 *
 * Two kinds of Claude start it. A Smart Terminal session gets it from the app's
 * MCP config and is known by `SMART_TERMINAL_SESSION_ID`, which the app put in
 * its environment. A fix the reviewer runs gets it inline, with
 * `SMART_TERMINAL_BUS_TOKEN`, a token the app made for that run. Either way this
 * process only relays: every question crosses the app's socket, and the app —
 * which knows the repositories, the PRs and who is running — answers it.
 *
 * Like `group-mcp.js`, the protocol is spoken by hand, and **stdout is the
 * protocol**: a stray `console.log` here takes the tools away from the session.
 */

const net = require('node:net');
const readline = require('node:readline');

const BRIDGE = process.env.SMART_TERMINAL_BRIDGE || '';
const TOKEN = process.env.SMART_TERMINAL_BUS_TOKEN || '';
const SESSION_ID = process.env.SMART_TERMINAL_SESSION_ID || '';
/** Some answers read other PRs' branches with git; give them room, but not forever. */
const TIMEOUT_MS = 60000;

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

const paths = (description) => ({ type: 'array', items: { type: 'string' }, description });

const TOOLS = [
  {
    name: 'peers',
    description:
      'Who else is writing right now — the Code Reviewer\'s fixes and the Smart Terminal sessions — in which ' +
      'repository and PR, and which files they have claimed. Use it when you start, before you touch anything: ' +
      'if someone is in the same files it is worth knowing before you write, not after the conflict exists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'inbox',
    description:
      'Read the messages others left since you last looked. Use it when you start and whenever you are about ' +
      'to touch something someone else may have changed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'notify',
    description:
      'Leave a message for the others. Use it when what you did changes someone else\'s work: you created or ' +
      'renamed a type, a table or an endpoint; changed a signature; settled on a pattern worth repeating; found ' +
      'something broken. Do not use it to narrate progress — commits show that.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'What happened, in one or two sentences. Concrete and actionable.' },
        scope: {
          type: 'string',
          enum: ['PR', 'REPO', 'ALL'],
          description: 'PR (default): whoever works on the same pull request. REPO: whoever writes in this repository. ALL: everyone.',
        },
        kind: { type: 'string', enum: ['note', 'warning', 'question', 'answer'], description: 'note by default.' },
        subject: { type: 'string', description: 'What it is about: a file, a type, a module.' },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'claim',
    description:
      'Announce which files you are about to change, before changing them. Nobody can overwrite you — every ' +
      'branch has its own copy — so this is not a lock: it is so nobody edits the same file on another branch ' +
      'and you both meet at the merge, when fixing it is expensive. If someone already claimed one, you are told who.',
    inputSchema: {
      type: 'object',
      properties: { paths: paths('Paths relative to the repository root.'), reason: { type: 'string', description: 'What you will do to them.' } },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'who_touched',
    description:
      'Ask whether another branch already changes these files — the repository\'s other open pull requests, read ' +
      'from git, and the fixes written for them. It blocks nothing: it tells you where you will meet at the merge, ' +
      'so you can change as little as possible there.',
    inputSchema: { type: 'object', properties: { paths: paths('Paths relative to the repository root.') }, required: ['paths'], additionalProperties: false },
  },
  {
    name: 'release',
    description: 'Release files you claimed and will not touch after all, so you do not hold anyone up. With no paths, releases all of yours.',
    inputSchema: { type: 'object', properties: { paths: paths('Paths to release. Empty releases all of yours.') }, additionalProperties: false },
  },
  {
    name: 'migration_number',
    description:
      'Ask for the migration number (V<n>__name.sql) you should use, instead of looking at the repository and taking ' +
      'the next one. Another open PR may already use it on its branch, or another session may have reserved one it has ' +
      'not written yet — and two migrations with the same number are only discovered at the merge.',
    inputSchema: { type: 'object', properties: { count: { type: 'string', description: 'How many numbers you need. 1 by default, at most 10.' } }, additionalProperties: false },
  },
];

function ask(tool, args) {
  return new Promise((resolve) => {
    if (!BRIDGE || (!TOKEN && !SESSION_ID)) {
      resolve({ ok: false, error: 'This Claude is not connected to Smart Terminal, so there is no bus to talk to.' });
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
    const timer = setTimeout(() => done({ ok: false, error: 'Smart Terminal did not answer.' }), TIMEOUT_MS);
    timer.unref?.();
    socket.on('connect', () => {
      const identity = TOKEN ? { token: TOKEN } : { from: SESSION_ID };
      socket.write(`${JSON.stringify({ op: 'bus', tool, args, ...identity })}\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const cut = buffer.indexOf('\n');
      if (cut === -1) return;
      try {
        done(JSON.parse(buffer.slice(0, cut)));
      } catch {
        done({ ok: false, error: 'Smart Terminal sent something unreadable.' });
      }
    });
    socket.on('error', (error) => done({ ok: false, error: `Could not reach Smart Terminal: ${error.message}` }));
    socket.on('close', () => done({ ok: false, error: 'Smart Terminal closed the connection.' }));
  });
}

const text = (body, isError = false) => ({ content: [{ type: 'text', text: String(body) }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args = {}) {
  if (!TOOLS.some((tool) => tool.name === name)) return text(`No such tool: ${name}`, true);
  const reply = await ask(name, args);
  return reply.ok ? text(reply.text) : text(reply.error, true);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'code-review-bus', version: '1.0.0' } } });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
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
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    Promise.resolve(handle(message)).catch((error) => {
      if (message.id !== undefined && message.id !== null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
    });
  });
  lines.on('close', () => process.exit(0));
}

module.exports = { TOOLS };
