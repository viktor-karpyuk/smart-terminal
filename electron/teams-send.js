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
 * - **Microsoft Graph**, signed in as a person, is how a direct message arrives
 *   from that person. An app registration on its own cannot write in a chat.
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

/**
 * The same card, with somebody tagged in it, so Teams tells them.
 *
 * Without this a post in a channel reaches whoever happens to read the channel.
 * The name goes in a line of its own and has to match the entity exactly, which
 * is the only rule Teams has about it — so nothing in it may look like markup.
 */
function tagged(content, tag) {
  if (!tag) return content;
  const name = String(tag.name || tag.address).replace(/[<>]/g, '').trim() || tag.address;
  const text = `<at>${name}</at>`;
  const [title, ...rest] = content.body;
  return {
    ...content,
    body: [title, { type: 'TextBlock', text, wrap: true, spacing: 'Small' }, ...rest],
    msteams: { entities: [{ type: 'mention', text, mentioned: { id: tag.address, name } }] },
  };
}

async function postWebhook(fetch, url, message, tag = null) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: tagged(card(message), tag) }],
    }),
  });
  if (!response.ok) throw new Error(`the webhook answered ${response.status}`);
  return { ok: true, how: 'webhook' };
}

/** What a sign-in asks for: to send as you, and to find who you are writing to. */
const SIGN_IN_SCOPES = 'offline_access User.Read User.ReadBasic.All Chat.Create ChatMessage.Send';

const authority = (tenantId) => `https://login.microsoftonline.com/${encodeURIComponent(tenantId || 'organizations')}/oauth2/v2.0`;

/** The sign-in ended at Microsoft's end: expired, revoked, or the permissions changed. */
class SignedOut extends Error {}

/** What Microsoft said, in the one line of it that a person can act on. */
function signInTrouble(data, status) {
  const said = String(data?.error_description ?? '').split(/\r?\n/)[0];
  // The one setting every registration starts without, and nothing in the error names it.
  if (/AADSTS7000218/.test(said)) return 'The app registration has to allow this: turn on “Allow public client flows” under Authentication in Entra ID.';
  return said || data?.error || `sign-in answered ${status}`;
}

/** Start signing in: a code for the person to type at Microsoft's page. */
async function startSignIn(fetch, { tenantId, clientId }) {
  const response = await fetch(`${authority(tenantId)}/devicecode`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SIGN_IN_SCOPES }).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.device_code) throw new Error(signInTrouble(data, response.status));
  return {
    deviceCode: data.device_code,
    code: data.user_code,
    url: data.verification_uri,
    interval: Number(data.interval) || 5,
    expiresIn: Number(data.expires_in) || 900,
  };
}

/** Whether the person has finished at Microsoft's page yet. */
async function checkSignIn(fetch, { tenantId, clientId, deviceCode }) {
  const response = await fetch(`${authority(tenantId)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok && data.refresh_token) return { state: 'done', accessToken: data.access_token, refreshToken: data.refresh_token };
  if (data.error === 'authorization_pending') return { state: 'pending' };
  if (data.error === 'slow_down') return { state: 'slower' };
  if (data.error === 'expired_token' || data.error === 'code_expired') return { state: 'failed', reason: 'The code expired before it was used. Sign in again.' };
  if (data.error === 'authorization_declined') return { state: 'failed', reason: 'The sign-in was declined at Microsoft.' };
  return { state: 'failed', reason: signInTrouble(data, response.status) };
}

/** Who signed in: the name and address these messages will come from. */
async function whoAmI(fetch, accessToken) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`asking who signed in answered ${response.status}`);
  const me = await response.json();
  return { id: me.id, name: me.displayName ?? '', address: me.userPrincipalName ?? me.mail ?? '' };
}

/**
 * A token for whoever signed in, not for the app.
 *
 * Cached until shortly before it expires: asking for one per message would put
 * a network round trip in front of every reminder and a rate limit in front of
 * a busy afternoon. Microsoft may hand back a new refresh token each time, and
 * the old one stops working, so it is given to `keep` the moment it arrives.
 */
function tokenCache() {
  let held = null;
  return {
    async get(fetch, { tenantId, clientId, refreshToken, keep = () => {} }, now = Date.now) {
      if (held && held.expires > now() + 60_000 && held.key === `${tenantId}:${clientId}`) return held.token;
      const response = await fetch(`${authority(tenantId)}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SIGN_IN_SCOPES }).toString(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.access_token) {
        if (data.error === 'invalid_grant' || data.error === 'interaction_required') throw new SignedOut(signInTrouble(data, response.status));
        throw new Error(signInTrouble(data, response.status));
      }
      if (data.refresh_token && data.refresh_token !== refreshToken) keep(data.refresh_token);
      held = { key: `${tenantId}:${clientId}`, token: data.access_token, expires: now() + (Number(data.expires_in) || 3600) * 1000 };
      return held.token;
    },
    forget() { held = null; },
  };
}

/**
 * A direct message, from whoever signed in.
 *
 * It has to be a person. Graph names `ChatMessage.Send.All` in the refusal it
 * gives an app acting on its own, but Entra offers no such thing to grant: an
 * app registration can open a chat and can never write in it. This was written
 * for that first, against a fake that said yes to everything, and it could not
 * have sent one message.
 */
async function sendDirect(fetch, credentials, tokens, { address, message }) {
  const from = String(credentials.senderAddress ?? '').trim();
  if (from && from.toLowerCase() === String(address).toLowerCase()) {
    throw new Error(`These messages are sent from ${from}, so they cannot be sent to ${from}.`);
  }

  const token = await tokens.get(fetch, credentials);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const refused = async (what, response) => {
    const said = String((await response.json().catch(() => ({})))?.error?.message ?? '').split(/\r?\n/)[0];
    return new Error(`${what} answered ${response.status}${said ? `: ${said}` : ''}`);
  };

  const found = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(address)}`, { headers: auth });
  if (!found.ok) throw found.status === 404 ? new Error(`Teams has nobody at ${address}`) : await refused(`looking up ${address}`, found);
  const user = await found.json();
  const sender = await whoAmI(fetch, token);

  const member = (id) => ({
    '@odata.type': '#microsoft.graph.aadUserConversationMember',
    roles: ['owner'],
    'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${id}')`,
  });
  const chat = await fetch('https://graph.microsoft.com/v1.0/chats', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ chatType: 'oneOnOne', members: [member(sender.id), member(user.id)] }),
  });
  if (!chat.ok) throw await refused('opening the chat', chat);
  const { id: chatId } = await chat.json();

  const sent = await fetch(`https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      body: { contentType: 'html', content: '<attachment id="card"></attachment>' },
      attachments: [{ id: 'card', contentType: 'application/vnd.microsoft.card.adaptive', content: JSON.stringify(card(message)) }],
    }),
  });
  if (!sent.ok) throw await refused('sending', sent);
  return { ok: true, how: 'graph' };
}

module.exports = { card, tagged, asText, postWebhook, sendDirect, tokenCache, startSignIn, checkSignIn, whoAmI, SignedOut };
