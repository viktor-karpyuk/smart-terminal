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
