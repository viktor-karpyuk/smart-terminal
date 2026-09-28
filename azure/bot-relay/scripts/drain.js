#!/usr/bin/env node
'use strict';

/**
 * Read what the bot was told, and optionally answer it.
 *
 *   node scripts/drain.js                 read once, answer nothing, leave the queue as it was
 *   node scripts/drain.js --reply         read, answer "Recibido: …", and remove what was answered
 *   node scripts/drain.js --reply --wait 120   keep looking for up to 120 s until something arrives
 *
 * Values come from .env.local, which the setup wizard writes.
 */

const path = require('node:path');
const { readEnv, decode, queue, botToken, reply } = require('./lib');

const args = process.argv.slice(2);
const answering = args.includes('--reply');
const waitFor = Number(args[args.indexOf('--wait') + 1]) || 0;
const env = { ...readEnv(path.join(__dirname, '..', '.env.local')), ...process.env };

for (const key of ['QUEUE_URL', 'QUEUE_SAS', 'AZ_TENANT_ID', 'BOT_APP_ID', 'BOT_APP_SECRET']) {
  if (!env[key]) { console.error(`${key} is missing from .env.local; run the setup wizard first.`); process.exit(2); }
}

(async () => {
  const q = queue(fetch, { url: env.QUEUE_URL, sas: env.QUEUE_SAS });
  const deadline = Date.now() + waitFor * 1000;
  let messages = [];
  for (;;) {
    // Without --reply the message is only borrowed for a second, so it is back for the next reader.
    messages = await q.receive(32, answering ? 60 : 1);
    if (messages.length || Date.now() >= deadline) break;
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (waitFor) process.stdout.write('\n');
  if (!messages.length) { console.log('The queue is empty.'); process.exit(waitFor ? 1 : 0); }

  const token = answering ? await botToken(fetch, { tenantId: env.AZ_TENANT_ID, appId: env.BOT_APP_ID, secret: env.BOT_APP_SECRET }) : null;
  for (const m of messages) {
    const { activity, receivedAt } = decode(m.text);
    const who = activity.from?.name || activity.from?.aadObjectId || activity.from?.id;
    console.log(`${receivedAt}  ${activity.channelId}  ${activity.type}  from ${who}${activity.text ? `: ${activity.text}` : ''}`);
    if (!answering) continue;
    if (activity.type === 'message') {
      await reply(fetch, token, activity, `Recibido: ${String(activity.text ?? '').trim().slice(0, 200)}`);
      console.log('  answered');
    }
    await q.remove(m);
  }
})().catch((error) => { console.error(error.message); process.exit(1); });
