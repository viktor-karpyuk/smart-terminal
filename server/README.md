# Smart Terminal organization server

A company's own server for Smart Terminal. Developers sign in to it from the app
(the **Organization** extension), and the company sees, in a web backoffice:

- who is working, in which sessions, on which **repositories and branches**;
- which **tickets** that work is on, found in branch names, session titles and commit subjects;
- how much of each developer's **Claude usage** is left: the session and the week;
- time per repository, ticket, **project** and **team**, over the last 7 or 30 days;
- each developer's own numbers, which they see too (and only theirs).

No dependencies: Node 22.5 or newer (`node:sqlite`), one SQLite file.

## What a developer's machine sends

Every few minutes (the company chooses how often), per open session: its kind
and title, the folder and repository name, the branch, the tickets found, the
account it runs on, and whether it did anything lately. Per Claude account: how
much of the session and the week is used, and when each resets.

**Never** file contents, conversations, commands or credentials. A remote's
`user:password@` is stripped before the repository name is sent. Full folder
paths only if the company turns that on in the backoffice. The developer sees
the last report word for word in the app, can pause it, and the backoffice
shows that it is paused. They can also name folders that are **never shared**:
a session in one is counted, and nothing else about it is sent.

## Running it

```
cd server
ORG_PUBLIC_URL=https://smart-terminal.acme.com node bin/org-server.js create-admin you@acme.com "Your Name"
ORG_PUBLIC_URL=https://smart-terminal.acme.com ORG_TRUST_PROXY=1 node bin/org-server.js serve
```

`create-admin` prints a password once. `reset-password <email>` prints a new one.
`backup [file]` writes a consistent copy of the database while it is serving.

With Docker:

```
docker build -t smart-terminal-org server
docker run -d --name org -p 8787:8787 -v org-data:/data \
  -e ORG_PUBLIC_URL=https://smart-terminal.acme.com -e ORG_TRUST_PROXY=1 smart-terminal-org
docker exec org node bin/org-server.js create-admin you@acme.com "Your Name"
docker exec org node bin/org-server.js backup /data/backup.db
```

| Variable | Default | |
| --- | --- | --- |
| `ORG_DB` | `org.db` | the database file |
| `ORG_PORT` | `8787` | |
| `ORG_HOST` | `127.0.0.1` | put a TLS reverse proxy in front; the app refuses plain http unless the server is on the same machine |
| `ORG_PUBLIC_URL` | `http://localhost:8787` | how people reach it; used in sign-in redirects |
| `ORG_TRUST_PROXY` | off | `1` behind a proxy that sets `X-Forwarded-Proto` / `X-Forwarded-For` |

## Accounts

In the backoffice, **Accounts → Add an account**: an e-mail, a name, a role
(Developer or Administrator), and how they sign in:

- **a password made for them**, shown once to the administrator;
- **a password you type**;
- **Microsoft / Google only**: no password at all.

Disabling an account signs out every device it is signed in on, at once.

Give people a **team** (Add an account, or Edit on Accounts): Team can then show
one team at a time, and time adds up by team.

## Projects and keeping data

**Settings → Projects** groups repositories: a name and patterns such as
`acme/timelog-*, acme/billing`. A repository counts toward the first project that
matches; the export says which.

**Settings → Keeping data** deletes time, repositories, tickets and usage older
than 30 days to two years, when saved and daily after. Accounts and the activity
log are kept.

## Sign in with Microsoft, Google or another provider

**Sign-in & settings → Add a provider.** Every provider needs the redirect URI
shown on that page: `ORG_PUBLIC_URL/auth/callback`.

- **Microsoft (Entra ID).** App registrations → New registration. Redirect URI
  (Web): the one above. Copy the *Application (client) ID* and *Directory
  (tenant) ID*; under Certificates & secrets make a client secret. Put the
  tenant ID in, so only your organization can sign in.
- **Google.** Google Cloud console → APIs & Services → Credentials → OAuth client
  ID → Web application. Authorized redirect URI: the one above. Copy the client
  ID and secret.
- **Other.** Any OpenID Connect provider: its issuer URL, client ID and secret.

Only accounts that exist in the backoffice can sign in with a provider, matched
by e-mail. To let a whole domain in, list it under *Let anyone at these domains
in*; they are added as developers the first time they sign in.

In the app, a developer picks the provider; the browser opens, they sign in, and
the app receives a one-time code on a loopback address and exchanges it with a
PKCE verifier. The ID token is checked on the server: signature against the
provider's keys, issuer, audience, expiry and nonce.

## Security, briefly

- Passwords are scrypt hashes; tokens and one-time codes are stored as SHA-256.
- Ten sign-in attempts per address and e-mail per 15 minutes.
- Device tokens last 90 days and can be revoked from the backoffice; web
  sessions last a day, in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over https).
- A change made from the browser must be JSON from this site's own origin.
- The backoffice pages run with a strict Content-Security-Policy and put
  everything a device reported on the page as text.

## Tests

```
cd server && npm test     # Node 22+
```

A fake identity provider with a real RSA key drives the SSO tests end to end.
