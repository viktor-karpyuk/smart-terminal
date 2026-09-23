'use strict';

/**
 * Turning a message into something Teams will show, and getting it there.
 *
 * Two ways in, because they cost differently and reach differently, and a
 * screen that hid that would be choosing for somebody:
 *
 * - an **Incoming Webhook** is a URL a channel gives you. Two minutes, no
 *   administrator, and it can only post into that one channel, where everybody
 *   reads it.
 * - **Microsoft Graph** with an app registration and an administrator's consent
 *   is the only way a message arrives as a direct message from a bot.
 *
 * The card is the same either way, so a message written for one arrives looking
 * the same through the other.
 */

/** Everything a person wrote is data: it goes in as text, never as markup. */
function card(message) {
  const blocks = [
    { type: 'TextBlock', text: message.title, weight: 'Bolder', size: 'Medium', wrap: true },
  ];
  if (message.body) blocks.push({ type: 'TextBlock', text: message.body, wrap: true, spacing: 'Small' });
  if (message.facts.length) {
    blocks.push({ type: 'FactSet', facts: message.facts.map((fact) => ({ title: fact.label, value: fact.value })) });
  }
  if (message.quote) {
    blocks.push({
      type: 'Container',
      style: 'emphasis',
      spacing: 'Medium',
      items: [{ type: 'TextBlock', text: message.quote, wrap: true, isSubtle: true }],
    });
  }
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: blocks,
    // Only Action.OpenUrl: a card posted by a webhook has no bot behind it to
    // answer anything else, and an action that does nothing is worse than none.
    actions: message.links.map((link) => ({ type: 'Action.OpenUrl', title: link.text, url: link.url })),
  };
}

/** The same card as plain text, for anywhere a card is not shown. */
function asText(message) {
  const lines = [message.title];
  if (message.body) lines.push(message.body);
  for (const fact of message.facts) lines.push(`${fact.label}: ${fact.value}`);
  for (const link of message.links) lines.push(`${link.text}: ${link.url}`);
  return lines.join('\n');
}

async function postWebhook(fetch, url, message) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card(message) }],
    }),
  });
  if (!response.ok) throw new Error(`the webhook answered ${response.status}`);
  return { ok: true, how: 'webhook' };
}

/**
 * A token for the app itself, not for a person.
 *
 * Cached until shortly before it expires: asking for one per message would put
 * a network round trip in front of every reminder and a rate limit in front of
 * a busy afternoon.
 */
function tokenCache() {
  let held = null;
  return {
    async get(fetch, { tenantId, clientId, clientSecret }, now = Date.now) {
      if (held && held.expires > now() + 60_000 && held.key === `${tenantId}:${clientId}`) return held.token;
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      });
      const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.access_token) {
        throw new Error(data.error_description || `sign-in answered ${response.status}`);
      }
      held = {
        key: `${tenantId}:${clientId}`,
        token: data.access_token,
        expires: now() + (Number(data.expires_in) || 3600) * 1000,
      };
      return held.token;
    },
    forget() { held = null; },
  };
}

/**
 * A direct message, through Graph.
 *
 * Three calls and no way around them: who the person is, which one-to-one chat
 * this bot has with them, and then the message. The chat is created the first
 * time and found every time after.
 */
async function sendDirect(fetch, credentials, tokens, { address, message }) {
  const token = await tokens.get(fetch, credentials);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const who = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(address)}`, { headers: auth });
  if (!who.ok) throw new Error(who.status === 404 ? `Teams has nobody at ${address}` : `looking them up answered ${who.status}`);
  const user = await who.json();

  const chat = await fetch('https://graph.microsoft.com/v1.0/chats', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      chatType: 'oneOnOne',
      members: [
        { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${user.id}')` },
        { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${credentials.botUserId || user.id}')` },
      ],
    }),
  });
  if (!chat.ok) throw new Error(`opening the chat answered ${chat.status}`);
  const { id: chatId } = await chat.json();

  const sent = await fetch(`https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      body: { contentType: 'html', content: '<attachment id="card"></attachment>' },
      attachments: [{ id: 'card', contentType: 'application/vnd.microsoft.card.adaptive', content: JSON.stringify(card(message)) }],
    }),
  });
  if (!sent.ok) throw new Error(`sending answered ${sent.status}`);
  return { ok: true, how: 'graph' };
}

module.exports = { card, asText, postWebhook, sendDirect, tokenCache };
