# Working on Smart Terminal

The README says what the app does. This says what you need to know before you change it —
including the things that cost hours to learn, and the mistakes worth not repeating.

---

## The first rule

**Never test against the app you are using.** A person running this app has a dozen live
Claude sessions in it, each with a conversation they care about. Restarting it kills every
one of them, and a lost thread cannot be reconstructed from the outside.

Work against an isolated instance instead:

```bash
npx vite                                    # the renderer, on :5173
SMART_TERMINAL_USER_DATA=/tmp/st-dev/data SMART_TERMINAL_DEV=1 \
  npx electron . --remote-debugging-port=9333
```

`SMART_TERMINAL_DEV=1` loads the renderer from Vite and turns on the dev-only logging.
`SMART_TERMINAL_USER_DATA` gives the copy its own database, workspace and profiles — and,
because the single-instance lock file lives in that directory too, it is also what lets a
development copy run beside an installed one at all.

### Seeing what the app is actually doing

```bash
node --experimental-websocket scripts/eval-renderer.mjs "window.store.getState().sessions"
EVAL_PORT=9334 node --experimental-websocket scripts/eval-renderer.mjs "…"   # a second copy
```

The store is on `window.store`; in dev builds the xterm handles are on `window.__terminals`,
a `Map` of sessionId → handle. Both are essential, because **terminals render to a canvas**:
the DOM tells you nothing about what a session shows or what size its text is.
`getComputedStyle('.xterm').fontSize` is *not* the terminal's font size — read
`handle.term.options.fontSize` and `handle.term.cols/rows`.

---

## What Claude Code does, learned by experiment

None of this is documented; all of it came from trying it.

- **Transcripts** live at `<configDir>/projects/<cwd with every "/" → "-">/<uuid>.jsonl`.
  The encoding is lossy — a folder whose own name contains a dash is indistinguishable from
  a separator — so `cwdFromFolderName()` rebuilds the path by walking the disk and keeping
  whichever reading exists.
- **A transcript carries no account.** That is the whole basis of the handoff feature: copy
  the file under another account's config dir and the conversation resumes there.
- **Credentials live in the macOS Keychain**, service `Claude Code-credentials-<hash of
  config dir>`. Copying a config directory does *not* copy the login.
- **The default account's config is `~/.claude.json`** — a file, not `~/.claude/.claude.json`.
- **`oauthAccount` in that file marks a real login.** A bare `userID` does not: the CLI
  writes that bootstrap key into any directory it is pointed at, including when the app only
  asks it for status. Treating it as a login gives false positives.
- **Folder trust** is `projects[path].hasTrustDialogAccepted` in `.claude.json`. In an
  untrusted folder Claude draws a dialog whose highlighted default is *No, exit* — so the
  session dies silently a few seconds after starting. This bites constantly in tests.
- **`claude -p /usage` works** and costs no tokens. Slash commands in `-p` mode were assumed
  not to work, and a whole PTY-driving TUI scraper was written and thrown away over that
  assumption. Test the assumption first.
- **Claude's input box does not submit** if the text and the Return arrive in the same write.
  It needs roughly 700 ms between them. This silently swallowed every autopilot nudge until
  it was found — the text was typed and simply never sent.

---

## Architecture, in the order it matters

```
electron/main.js          lifecycle, windows map, all IPC. The big one.
electron/pty-manager.js   node-pty spawn/write/resize + per-profile env
electron/context-store.js transcripts: locate, snapshot, carry across accounts,
                          and readTurnState() — whose turn it is
electron/autopilot.js     keeps a session moving; decides when not to
electron/restore.js       which sessions a window brings back. Pure, tested
electron/database.js      SQLite (node:sqlite) — sessions, groups, handoffs, FTS5
src/state/layout.ts       the split tree. Pure, tested
src/state/store.ts        zustand: sessions, layout, groups, settings, pty plumbing
src/terminals/registry.ts persistent xterm instances, re-parented across panes
```

The renderer never touches `fs` or `node-pty`; everything crosses through `preload.js`.

### Three rules that are load-bearing

**1. Anything that needs to know where a conversation lives calls `locateTranscript()`.**
Four separate places once guessed a folder instead, and each could silently start a fresh
thread on an id that already had history. That was a real data-loss bug. If you add a fifth
place, make it call `locateTranscript` too.

**2. One database, one app.** `app.requestSingleInstanceLock()` in `electron/main.js` is not
politeness, it is data integrity. Installing a new build launches it while the old copy is
still running, and both point at the same `smart-terminal.db`. The second copy reads the
first's windows and sessions; the first then writes its own shutdown over them — sessions
marked ended, windows marked closed. A window marked closed does not come back, and its
sessions have nowhere to come back *to*. That is how a window's worth of live sessions was
lost once, and it looked like a mystery for days.

**3. A window's layout is the record of what was on it.** `electron/restore.js` decides what
comes back, starting from the session ids the layout names. Restoring by the `window_id` on
the session row instead loses a session the moment that id names a window that is gone: the
row is offered to no window at all, the renderer prunes the pane out of the layout it just
loaded, and saves the pruned layout. The conversation survives in History; its pane does not.
For the same reason the rows are fetched by id and uncapped — asking for a page of recent
history means that, once history is longer than the page, an old session silently stops being
offered.

---

## Autopilot, since it is the subtlest part

The checkbox is *Keep working on its own* in the tab menu. When on, a session that has stopped
is told to carry on; a session waiting on a human decision is left alone.

Two signals, consulted in this order:

1. **The screen** (`looksLikeADecision`). Claude Code draws some questions only on screen —
   folder trust, plan approval, its own setup prompts — and they leave no trace in the
   transcript. From the transcript those look exactly like "the turn ended", so a nudge would
   land *inside the dialog* and the Return would pick whatever option is highlighted. The
   screen therefore goes first, and it is only ever used to **refuse**: a false positive costs
   a pause that one keystroke ends, a false negative answers a question on the person's
   behalf. Keep that asymmetry.
2. **The transcript** (`readTurnState`). Last entry is `assistant` with `stop_reason:
   end_turn` → the turn is over, safe to nudge. Last entry is a `tool_use` with no result
   after it → a permission prompt is up, leave it. Anything else → still working. Transcripts
   also carry Claude's own bookkeeping entries (`ai-title`, `mode`, `permission-mode`, …), so
   filter to `user`/`assistant`.

The screen comes from the renderer (`readTail`), pushed to main whenever a session falls
quiet. Reconstructing it from the raw output stream in main does not work, because a dialog
drawn *before* autopilot was switched on has printed nothing since.

It stops by itself two ways: Claude is asked to reply `AUTOPILOT-DONE`, and two nudges that
produce no tool use end the run regardless. **Stopping means stopping.** Reaching `done` once
only changed what the tab said — the session stayed watched, so the next turn, one the person
had started themselves after reading the result, was met with "Continue with the plan". That
is the one thing this must never do. A finished run is finished; switching the checkbox off
and on starts another.

Do not widen the screen patterns carelessly. A bare `1. … 2. …` matches ordinary prose —
Claude writes numbered lists constantly — so the rule requires the selection caret (`❯ 1.`)
or a confirm/cancel affordance.

A question written in prose is judged separately from a dialog, because the two are not the
same thing. *"Should I continue?"* is the exact question autopilot exists to answer, and
Claude ends turns with it constantly; refusing there would leave the feature refusing almost
every time it was needed. So the prose branch defaults to refusing, makes one exception for a
question asking nothing but leave to carry on, and takes that exception back twice over: when
the sentence offers alternatives (*"continue, or start over?"* is a decision), and when it
names something destructive (*"sigo y borro las viejas?"* is a decision too). Both languages
are matched — these sessions are worked in Spanish, and an English-only rule would simply
never fire for them. The tests in `test/autopilot.test.js` use screens captured
verbatim from a narrow pane, wrapping and all, because the wrapping is what breaks naive
matching.

---

## Reading the CLI when the app was not started from a terminal

`electron/cli-env.js` resolves a PATH before running `claude` for anything that is
not a session — the auth check and `/usage`.

Launched from Finder (or by `open`, which is what an installer does) the app inherits
launchd's environment, and its PATH is the bare system one. Running the CLI through
`zsh -lc` does not rescue that: a **non-interactive login shell reads `.zshenv`,
`.zprofile` and `.zlogin`, and never `.zshrc`** — which is where PATH additions
overwhelmingly live. The CLI is then not found at all.

What that looked like was nothing like "command not found". The account reported
itself signed out, and the usage gauge and the usage panel are both gated on being
signed in, so they rendered nothing — no error, no placeholder, no clue. Started
from a terminal the very same build worked, because it inherited a PATH that already
had the CLI on it, which is why it never showed up in testing.

So the PATH is asked for once from an *interactive* login shell and merged into what
the app has, with the usual install directories as a fallback. Only the PATH is
taken: the command itself still runs in a non-interactive shell, which stays quiet
and cannot block on a prompt. Sessions are unaffected — a pty runs an interactive
shell already, which is why they always worked.

Two habits came out of it, both worth keeping. **A reading that failed should not be
rendered as absence**: the gauge now shows its placeholder when an account reads as
signed out, and the placeholder opens the panel that explains why. And **a check
that runs once at startup runs at the worst possible moment** — the account check
fires while a restored workspace is spawning every one of its sessions, so it is
repeated on a timer rather than trusted the first time.

---

## Traps

- **Zustand selectors that build something new.** `useStore((s) => ids.map(...))` returns a
  fresh array every render, the store looks changed every render, and React dies with
  *Maximum update depth exceeded* — the whole UI goes blank. Wrap with `useShallow`, or
  return a primitive. When the app renders nothing, check the renderer console first.
- **`profiles.get(id)` falls back to the first profile.** Fine when creating a session, wrong
  when a request is explicitly *about* one account — it would run under credentials nobody
  asked for. Use `profiles.exactly(id)` there.
- **A stale dev instance.** It is easy to spend a debugging round on code that was correct
  because the running copy predates the edit. Compare `ls -lT` on the file against the process
  start time before concluding anything.
- **Text size is stored in two places and applied in a third.** Group → session → global,
  resolved in `applyGroupAppearance`. A new terminal is born at the global size, so anything
  that creates one has to re-apply, or the setting is remembered everywhere except where it
  shows.
- **A native file dialog blocks the main process.** Do not open one in a test you cannot
  dismiss.

---

## Code Reviewer

The `code-review` extension is a port of AI Code Reviewer, a Kotlin desktop app that reviews
pull requests by running the person's own `claude -p`. The rules came across rule for rule —
each of them cost that app a real mistake — and the comments in `electron/review-*.js` say
which. What it keeps, and what a change must not break:

- **No API key, ever.** Every run is the local CLI on a Smart Terminal account
  (`review-claude.js`), spawned without a shell, prompt on stdin, **each permission pattern
  its own argument** — joined with commas, `Bash(git diff *)` is split by the CLI and the
  review runs blind to the diff without saying so. An account out of room is rested and the
  next one takes the run; a session is never resumed across accounts.
- **A review is read-only, and one that used no tool is failed.** The model sometimes answers
  "I cannot access the diff" without trying, with no permission denial to show for it.
- **Nothing is published by itself.** Findings are drafts. The only automatic publication is
  an answer to a reply, for a repository whose reply mode is AUTO.
- **Fixes are written in a workshop** — a `git clone --local` under
  `userData/code-review/fixes` — never in the person's clone, with `git push` and
  `git commit` denied to the model. The tool commits; a clean tree means nothing was fixed.
  A written fix closes its finding and says so in the thread, from a template that always
  says the commit is not on the branch yet.
- **One database.** Its tables live in `smart-terminal.db`, prefixed `cr_`, with their own
  forward-only migration list and a guard against a newer schema. The columns are the
  original app's, name for name, which is what makes `review-import.js` a copy.
- **Tokens** are encrypted with Electron's `safeStorage`; the store refuses to keep one in the
  clear, and no view the panel receives carries it.
- **The panel cannot reach the network.** Everything goes through `review:call`, a fixed verb
  table in `review-service.js`; `extensionHost.ts` routes `review.*` and asks before the five
  things that cannot be undone — merge, decline, push, deleting a repository, discarding a
  workshop.

Two deliberate departures from the original: the sweep drafts answers to replies even when no
repository reviews automatically, and it reads the thread of every open PR with published
comments each cycle, so a reply is noticed without opening the PR. And a GitHub PR is read with
its state and stances, which the original never mapped.

Not ported, by decision: the Constructor (spec-driven implementation), statistics, Jira and
the stories board, and the database-engine choice — the reviewer uses Smart Terminal's
database.

### The bus

AI Code Reviewer's MCP bus let its parallel tasks see each other; here it does the same for
the reviewer's fixes and the person's own Claude sessions (`review-bus.js`). Seven tools —
`peers`, `inbox`, `notify`, `claim`, `who_touched`, `release`, `migration_number` — served by
`review-bus-mcp.js`, a stdio MCP server that only relays over the app's message socket
(`op: 'bus'` in `message-bridge.js`). What holds it up:

- **Identity is the app's.** A fix run gets a token the app made, inline in its
  `--mcp-config` together with `--strict-mcp-config`; a session is known by the
  `SMART_TERMINAL_SESSION_ID` the app put in its environment, and only while it is in the
  live roster. Where a session is — which repository, which PR — is worked out from its
  working directory: a configured clone, or a fix workshop.
- **Claims never block.** Every branch has its own copy; a claim is for the merge. They go
  when the fix ends, or when the session stops or moves to another repository.
- **`who_touched` and `migration_number` read real branches.** The repository's other open
  PRs are diffed with git (cached per head), so a file or a migration number another PR
  already uses is seen before the merge. Numbers are reserved in a transaction and never
  handed out twice.
- **A fix reads back a day** when it joins, because it is a new writer each run; a session
  starts from the moment it joins. After a fix commits, the files it changed are recorded
  against its branch, and if another open branch changes them too, the repository is told.

The panel's Coordination tab shows it, read-only. The plugin's `code-review-bus` skill tells
a session when to reach for the tools.

Testing it by hand needs no real review: import an AI Code Reviewer history into an isolated
instance and every screen has data. `test/review-engine.test.js` drives the whole thing — a
review, publishing, a reply, verification, a fix, handing it back and pushing — on real git
repositories with a fake forge and a fake CLI. It needs `node:sqlite` (Node 22+) and skips
itself on an older Node.

---

## Tests

```bash
npm test        # split tree, transcript reading, turn state, autopilot rules, restore
npm run typecheck
```

The pure modules are the ones with real tests, and new logic is worth extracting into one for
exactly that reason — `electron/restore.js` exists as a separate file so its rules could be
tested without an app, a database or a screen.

---

## Building and signing

```bash
npm run dist    # unsigned .dmg into release/
```

Unsigned is the default and needs no Apple account. macOS then asks for right-click → Open on
first launch, once per machine.

Making that prompt go away for someone who downloaded the DMG takes a **notarised** build,
which takes a paid Apple Developer account and a **Developer ID Application** certificate.
An *Apple Distribution* or *iPhone Distribution* certificate is not the same thing — those are
for the App Store and cannot sign a directly downloaded app. An ad-hoc signature does not
count either.

With the certificate in the keychain, the same command signs and notarises:

```bash
APPLE_TEAM_ID=XXXXXXXXXX \
APPLE_ID=you@example.com \
APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop \
npm run dist
```

`electron-builder.config.js` reads those and switches on the hardened runtime, the
entitlements and notarisation together; with none of them set it produces exactly the
unsigned build as before. The entitlements in `resources/entitlements.mac.plist` are each
there for a reason, listed in the file: the hardened runtime switches off precisely what
Electron and a terminal need — JIT, inherited environments, and a native module (`node-pty`)
that lives unpacked outside the asar.

## Improving an extension means bumping its version

The version in an `extension.json` is the whole of what the gallery compares against the
version somebody has installed, and the only thing that turns a row into "Update to
v1.1.0". An extension improved without its version moving is an improvement **nobody is
ever offered** — the files ship, the panel even runs the new code, and the app has no way
to say that anything happened.

That is not hypothetical. It had happened three times before `test/extension-versions.test.js`
existed: the Code Reviewer (+449 lines), the Maven and Gradle panel (+535) and the Spring
Boot panel (+170) all changed substantially while their manifests sat at `1.0.0`. The
machinery to offer those had been there the whole time and had never once lit up.

So the rule, and the test that keeps it: **if anything under `extensions/<id>/` differs
from the integration branch, `version` must differ too.** The test compares against the
branch rather than against the previous commit on purpose — bumping first and then editing
more is exactly right, and a test that compared neighbouring commits would fail it for the
ordering. It asks about untracked files separately, since `git diff` cannot see a file that
was never added and half the extensions here are one file plus a manifest.

It skips, rather than fails, where there is no branch to compare against.

## Where an update is offered

Two things can be behind, and they are not the same thing:

- **The app.** Downloaded and swapped, which is the rest of this section.
- **A built-in extension**, which travels *inside* the app. Its new version arrives with an
  app update, so there is nothing to download — the offer is to record it as installed.

Both are in the Updates panel, because the moment somebody has just taken an app update is
exactly the moment its extensions are behind, and leaving that news in a gallery nobody has
a reason to open is how the three above went unmentioned. The sidebar says one or the
other, never both: a new version of the app is the bigger news and carries the extensions
with it anyway, so the extension line only speaks in the gap.

One trap worth knowing, since it cost a blank window: a selector that `filter`s returns a
new array every time it runs, and the store compares by identity — so `useStore(s =>
s.rows.filter(…))` re-renders because it rendered, and React ends it by tearing the tree
down. Use `useShallow`, or select a count. The sidebar picks the count and says so in a
comment; the Updates panel needs the rows, so it uses `useShallow`.

## Updating, and why it is not electron-updater

`electron-updater` drives Squirrel.Mac on macOS, and Squirrel refuses to apply an update to
an application it cannot verify a code signature for. The builds here are unsigned — see
above for what fixing that costs — so the usual machinery is not an option, and pretending
otherwise would mean an update path that silently does nothing.

So `electron/updates.js` does the job the way the release notes already tell people to do it
by hand, and the way `scripts/reinstall-locally.sh` already does it from a terminal:

1. **Check.** An unauthenticated GET against `/repos/<slug>/releases`. Drafts are never
   offered, pre-releases only to somebody who asked, and a tag that cannot be read as a
   version is skipped rather than guessed at.
2. **Pick the file.** By extension and by the architecture *in the name*, never by
   predicting the name — electron-builder writes the product name into it and GitHub
   replaces the spaces with dots. Two builds of a kind with nothing saying which machine
   they are for is a release this declines to choose from: installing an Intel build over an
   Apple-silicon one is a working app replaced by one that limps, with no way back from
   inside it.
3. **Download and verify.** Streamed, hashed as it arrives, checked against the SHA-256
   GitHub recorded for the asset. A file that does not match is deleted rather than kept —
   left there, the next check would find it, trust its size, and offer to install it. The
   reading is remembered with the file's size and modification time, so a check every six
   hours does not mean re-reading 128 MB every six hours; anything that disagrees with
   either, a fresh launch included, is hashed again.

   The write stream has its own `'error'` listener and everything that can block races
   against it. An `'error'` on a Writable is an event and not a rejected promise, so with no
   listener a full disk during a 128 MB download would take down the main process — every
   window, every session — and the wait for `'drain'` would hang rather than report.
4. **Swap, from outside.** A process cannot replace its own bundle, so a small script is
   written with the paths already in it, spawned detached, and the app quits. The script
   waits on the app's pid, mounts the image, copies the new build in beside the old one and
   moves it over in one step.

Three things about that last step are load-bearing:

- **The install is the quit.** `app.quit()` is what lets the script proceed, so the
  confirmation a quit already puts up when sessions are live is the confirmation the update
  uses — there is no second dialog, and keeping the sessions cancels the update.
- **A cancelled quit has to be harmless, and the timeout alone does not make it so.** The
  script cannot tell a refused quit from a quit four minutes later for entirely unrelated
  reasons, and installing on the second one would replace the app against an answer somebody
  already gave. So `quitCancelled()` — called from `before-quit` — writes a marker file
  *synchronously* before signalling the script, because the marker is what survives this
  process being killed or quitting a moment later. The script checks it every second of its
  wait and once more after it, and the five-minute timeout is what is left if all of that
  fails.
- **Copy, then remove, then move.** Deleting first leaves a window in which a failed copy
  means no application at all. `test/updates.test.js` asserts that order, because it is the
  kind of thing a later edit reorders without noticing.

Release notes are parsed into blocks and spans (`src/lib/releaseNotes.ts`) and drawn as React
elements. They are never turned into HTML. They arrive over the network, they are shown in a
window that holds `window.api`, and they are written in a web form — three reasons that a
`dangerouslySetInnerHTML` here would be the worst one in the codebase.

### Rehearsing it

```bash
SMART_TERMINAL_UPDATE_AS_VERSION=0.1.0 npm start   # everything published looks newer
SMART_TERMINAL_UPDATE_REPO=owner/repo npm start    # check somewhere else entirely
```

The first is read once, at startup, and nothing else in the app knows about it. It is the
only way to exercise offer → download → verify → swap without cutting a release first.
