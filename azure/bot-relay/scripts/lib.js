'use strict';

/**
 * The laptop's half, as small as it can be: read what the relay left on the
 * queue, and answer through the Bot Connector. Smart Terminal will carry its
 * own copy of this; here it proves the pipe works before anything is built on it.
 */

const fs = require('node:fs');

function readEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const unxml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The Queue service answers in XML; three fields per message are all we need. */
function parseMessages(xml) {
  const out = [];
  for (const [, block] of xml.matchAll(/<QueueMessage>([\s\S]*?)<\/QueueMessage>/g)) {
    const field = (name) => unxml((new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block) || [])[1] ?? '');
    out.push({ id: field('MessageId'), popReceipt: field('PopReceipt'), text: field('MessageText') });
  }
  return out;
}

/** The runtime writes base64 by default; plain JSON is accepted too, in case that is ever switched off. */
function decode(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
}

function queue(fetch, { url, sas }) {
  const base = url.replace(/\/+$/, '');
  const q = sas.replace(/^\?/, '');
  const headers = { 'x-ms-version': '2021-12-02' };
  return {
    async receive(count = 32, visibility = 60) {
      const r = await fetch(`${base}/messages?numofmessages=${count}&visibilitytimeout=${visibility}&${q}`, { headers });
      if (!r.ok) throw new Error(`reading the queue answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return parseMessages(await r.text());
    },
    async remove({ id, popReceipt }) {
      const r = await fetch(`${base}/messages/${encodeURIComponent(id)}?popreceipt=${encodeURIComponent(popReceipt)}&${q}`,
        { method: 'DELETE', headers });
      if (!r.ok && r.status !== 404) throw new Error(`deleting from the queue answered ${r.status}`);
    },
  };
}

async function botToken(fetch, { tenantId, appId, secret }) {
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: secret,
      scope: 'https://api.botframework.com/.default',
    }).toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(data.error_description || `sign-in answered ${r.status}`);
  return data.access_token;
}

async function reply(fetch, token, activity, text) {
  const service = activity.serviceUrl.replace(/\/+$/, '');
  const conv = encodeURIComponent(activity.conversation.id);
  const r = await fetch(`${service}/v3/conversations/${conv}/activities/${encodeURIComponent(activity.id)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', text, replyToId: activity.id }),
  });
  if (!r.ok) throw new Error(`answering answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

module.exports = { readEnv, parseMessages, decode, queue, botToken, reply };
