# Bot relay

The only piece of the Code Reviewer bot that lives in Azure.

A bot can send without a server, but to **receive** it needs a public URL, and a laptop
behind a router has none. So Teams talks to a small Function, the Function checks the
message is really Teams speaking to this bot from this organisation, and leaves it on a
Storage Queue. Smart Terminal reads the queue from the laptop and answers through the
Bot Connector. Nothing is answered in Azure; the Function only has to be awake.

```
Teams ──► Azure Bot ──► Function /api/messages ──► queue teams-inbound ◄── Smart Terminal
                                                                            │
Teams ◄───────────────────── Bot Connector (reply / proactive DM) ◄─────────┘
```

## Setting it up

```
azure/bot-relay/setup-azure-bot.sh
```

Eleven stages: tools, sign-in, names, storage and queue, the bot's app registration,
the Function, the Azure Bot with its Teams channel, a Web Chat test, the Teams app
package, a Teams test, and what Smart Terminal needs. Every value lands in
`.env.local` here, which is gitignored and readable only by you. Re-running is safe.

## Checking it by hand

```
node scripts/drain.js              # show what is waiting, leave it there
node scripts/drain.js --reply      # answer "Recibido: …" and remove it
node scripts/make-teams-app.js     # rebuild the Teams package (bump TEAMS_APP_VERSION first)
npm test
```

## What expires

- The bot's client secret, two years after setup (`BOT_APP_SECRET_EXPIRES`).
- The queue key, one year after setup (`QUEUE_SAS_EXPIRES`). Re-running stage 4 issues a new one.
