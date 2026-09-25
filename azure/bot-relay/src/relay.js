'use strict';

/**
 * What the endpoint does with one request, apart from Azure: decide whether it
 * is a real message for this bot from this organisation, and if so what goes
 * on the queue.
 *
 * It never answers the message. The answer comes from Smart Terminal, on the
 * laptop, which is the only place that knows the pull requests; this piece only
 * has to be awake when Teams calls, which the laptop cannot promise.
 */

const { verify, AuthError } = require('./auth');

/**
 * A queue message holds 64 KB, and the Functions runtime base64-encodes it on
 * the way in, which costs a third. What is kept under that is the whole
 * activity; what is not loses its attachments and the tail of its text, and
 * says so, rather than being dropped.
 */
const MAX_JSON = 46 * 1024;

function envelope(activity, receivedAt) {
  const whole = JSON.stringify({ receivedAt, activity });
  if (Buffer.byteLength(whole) <= MAX_JSON) return whole;
  const trimmed = { ...activity, attachments: undefined, truncated: true };
  if (typeof trimmed.text === 'string') trimmed.text = trimmed.text.slice(0, 8000);
  const smaller = JSON.stringify({ receivedAt, activity: trimmed });
  if (Buffer.byteLength(smaller) <= MAX_JSON) return smaller;
  return JSON.stringify({ receivedAt, activity: { ...pick(activity), truncated: true } });
}

/** Enough to answer and to know who spoke, when nothing else fits. */
function pick(a) {
  return {
    type: a.type, id: a.id, timestamp: a.timestamp, serviceUrl: a.serviceUrl, channelId: a.channelId,
    from: a.from, recipient: a.recipient, conversation: a.conversation,
    channelData: a.channelData && { tenant: a.channelData.tenant },
    text: typeof a.text === 'string' ? a.text.slice(0, 2000) : undefined,
  };
}

/**
 * @returns {{ status: number, enqueue?: string, reason?: string }}
 */
async function relay({ authorization, body, config, keys, now = Date.now }) {
  let activity;
  try {
    activity = JSON.parse(body);
  } catch {
    return { status: 400, reason: 'the body is not JSON' };
  }
  if (!activity || typeof activity !== 'object' || typeof activity.type !== 'string' ||
      typeof activity.serviceUrl !== 'string' || !activity.conversation?.id) {
    return { status: 400, reason: 'the body is not a Bot Framework activity' };
  }

  try {
    await verify({ authorization, activity, appId: config.appId, keys, now });
  } catch (error) {
    if (error instanceof AuthError) return { status: 401, reason: error.message };
    throw error;
  }

  if (!config.channels.includes(activity.channelId)) {
    return { status: 403, reason: `the ${activity.channelId} channel is not let through` };
  }
  // Teams says which organisation a message comes from. The bot is for this
  // one's developers; anybody else who found it in a store is not let in.
  if (activity.channelId === 'msteams') {
    const tenant = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId;
    if (!tenant || tenant.toLowerCase() !== config.tenantId.toLowerCase()) {
      return { status: 403, reason: 'the message comes from another organisation' };
    }
  }

  return { status: 200, enqueue: envelope(activity, new Date(now()).toISOString()) };
}

function configFrom(env) {
  const appId = String(env.MicrosoftAppId ?? '').trim();
  const tenantId = String(env.MicrosoftAppTenantId ?? '').trim();
  if (!appId || !tenantId) throw new Error('MicrosoftAppId and MicrosoftAppTenantId have to be set');
  const channels = String(env.RELAY_ALLOWED_CHANNELS || 'msteams,webchat')
    .split(',').map((c) => c.trim()).filter(Boolean);
  return { appId, tenantId, channels };
}

module.exports = { relay, configFrom, envelope, MAX_JSON };
