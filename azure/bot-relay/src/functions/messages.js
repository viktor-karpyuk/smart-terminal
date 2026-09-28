'use strict';

/**
 * The bot's messaging endpoint: POST /api/messages.
 *
 * Teams wants an answer within seconds and retries when it does not get one,
 * so this does nothing slow: check, enqueue, 200.
 */

const { app, output } = require('@azure/functions');
const { keyring } = require('../auth');
const { relay, configFrom } = require('../relay');

const inbound = output.storageQueue({
  queueName: '%RELAY_QUEUE_NAME%',
  connection: 'RELAY_QUEUE_CONNECTION',
});

const keys = keyring({ fetch });
let config;

app.http('messages', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'messages',
  extraOutputs: [inbound],
  handler: async (request, context) => {
    config ??= configFrom(process.env);
    const result = await relay({
      authorization: request.headers.get('authorization'),
      body: await request.text(),
      config,
      keys,
    });
    if (result.enqueue) {
      context.extraOutputs.set(inbound, result.enqueue);
    } else {
      context.warn(`refused with ${result.status}: ${result.reason}`);
    }
    return { status: result.status };
  },
});
