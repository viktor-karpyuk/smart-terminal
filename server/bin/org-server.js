#!/usr/bin/env node
'use strict';

/**
 *   org-server serve                      start the server
 *   org-server create-admin <email> [name] make the first administrator; prints a password once
 *   org-server reset-password <email>      print a new password for an account
 *   org-server backup [file]               a consistent copy of the database, while it runs
 *
 * Settings from the environment:
 *   ORG_DB          where the database lives            (./org.db)
 *   ORG_PORT        the port to listen on               (8787)
 *   ORG_HOST        the address to listen on            (127.0.0.1)
 *   ORG_PUBLIC_URL  how people reach it, for sign-in redirects (http://localhost:8787)
 *   ORG_TRUST_PROXY "1" behind a reverse proxy that sets X-Forwarded-Proto/For
 */
const { createServer } = require('../src/app');
const { hashPassword, makePassword } = require('../src/auth');

const db = process.env.ORG_DB || 'org.db';
const port = Number(process.env.ORG_PORT || 8787);
const host = process.env.ORG_HOST || '127.0.0.1';
const publicUrl = process.env.ORG_PUBLIC_URL || `http://localhost:${port}`;

async function main() {
  const [command = 'serve', ...args] = process.argv.slice(2);
  if (command === 'serve') {
    const { server } = createServer({ dbFile: db, publicUrl, trustProxy: process.env.ORG_TRUST_PROXY === '1' });
    server.listen(port, host, () => console.log(`Smart Terminal organization server on ${publicUrl} (listening on ${host}:${port}, data in ${db})`));
    return;
  }
  const { store } = createServer({ dbFile: db, publicUrl });
  if (command === 'create-admin') {
    const [email, ...name] = args;
    if (!email) throw new Error('usage: org-server create-admin <email> [name]');
    if (store.userByEmail(email)) throw new Error(`${email} already has an account; use reset-password.`);
    const password = makePassword();
    store.createUser({ email, name: name.join(' '), role: 'admin', passHash: await hashPassword(password) });
    console.log(`Administrator ${email} created.\nPassword (shown once): ${password}\nSign in at ${publicUrl}`);
  } else if (command === 'backup') {
    const file = args[0] || `org-backup-${new Date().toISOString().slice(0, 10)}.db`;
    store.backupTo(file);
    console.log(`Backed up to ${file}. Copy it somewhere else; restoring is pointing ORG_DB at it.`);
  } else if (command === 'reset-password') {
    const user = store.userByEmail(args[0] ?? '');
    if (!user) throw new Error('No account with that e-mail.');
    const password = makePassword();
    store.setPassword(user.id, await hashPassword(password));
    console.log(`New password for ${user.email} (shown once): ${password}`);
  } else {
    throw new Error(`unknown command: ${command}`);
  }
  store.close();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
