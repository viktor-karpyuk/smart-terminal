# Smart Terminal

> **Beta.** Usable day to day, but the shape of things is still moving.

A VS Code–style workbench for running many **Claude Code** sessions at once, where each
session can belong to a **different Claude account**.

Two problems it solves:

1. **Multiple accounts side by side.** A *profile* points at its own `CLAUDE_CONFIG_DIR`
   — the directory where Claude Code keeps that account's credentials and state. Every
   terminal is launched with the profile's config dir, so a pane running as *user X* and a
   pane running as *user Y* never see each other's login.
2. **A layout you can actually rearrange.** Panes split horizontally and vertically to any
   depth, dividers drag to resize, and any session can be dragged to any edge of any pane
   to re-split the workspace around it.

## Running it

```bash
npm install     # also rebuilds node-pty against Electron
npm run dev     # Vite + Electron with hot reload
npm start       # production build, then launch
npm run dist    # package a .dmg (unsigned unless the Apple variables are set)
npm test        # split-tree engine, transcript reading, autopilot's stop/go rules
npm run typecheck
```

`npm install` runs `electron-rebuild` for `node-pty`, which needs Xcode Command Line Tools
on macOS. If the native module ever mismatches after an Electron upgrade, run `npm run rebuild`.

## Accounts

Open **Accounts** (⌘,) to manage them. On first launch the app seeds a `Default` account
and auto-detects any per-account config dirs it finds under:

- `~/Library/Application Support/AICodeReviewer/accounts/*`
- `~/.claude-accounts/*`
- `~/.config/claude-accounts/*`

A directory counts as an account if it contains `.claude.json`, `settings.json`, or `projects/`.

### Adding one

**+ Add account** asks for a name and proposes where to keep that login's credentials,
derived from the name:

| Option | Path | When |
| --- | --- | --- |
| Managed by Smart Terminal *(suggested)* | `~/Library/Application Support/Smart Terminal/accounts/<slug>` | Normal use — kept with the app, invisible to every other tool. |
| Shared account folder | `~/.claude-accounts/<slug>` | You also want `CLAUDE_CONFIG_DIR=…` to work from your own shell. |

Any other path works too; existing logins found on the machine are offered as chips.
A folder that already holds a login is flagged, so you do not silently reuse one account
for two profiles. (The flag reads `oauthAccount` out of the folder's `.claude.json` —
merely existing is not enough, because the CLI writes a bare config into any folder it is
pointed at, including when this app only asks it for status.)

**Sign in…** creates the folder, saves the account, and opens a session running
`claude auth login` against it. Complete the browser handshake in that terminal; the app
polls until the account reports itself signed in, then shows the email everywhere that
account appears — the tab, the sidebar group, the title-bar chip, the account list.

**Check** asks `claude auth status --json` who a folder is currently signed in as, without
touching anything.

Each account carries:

| Field | Purpose |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Which account the session logs in as. Empty = the default `~/.claude`. |
| Starting folder | Where sessions from this account *open*. Only a starting point — see below. |
| Claude command | Binary to run (default `claude`). |
| Extra arguments | Appended to every launch, e.g. `--model opus`. |
| Environment | Extra `KEY=value` pairs for the session. |
| Colour | Identifies the account on every tab, sidebar row, and title-bar chip. |

A session starts an interactive login shell (so your `PATH`, nvm, and prompt load normally)
and then types the launch line into it. When a profile sets a config dir the line is
prefixed with `command `, which bypasses any user-defined `claude` shell function — on this
machine one such function rewrites `CLAUDE_CONFIG_DIR` based on the current directory and
would otherwise override the profile.

Inherited `CLAUDE_*`, `ANTHROPIC_API_KEY`, and stale `TERM_PROGRAM*` variables are stripped
before the shell starts, so a session's environment depends only on its profile.

## Layout

- **`+`** on a pane's tab strip opens another tab right there, reusing the account and
  folder of the tab in front (double-clicking empty tab-strip space does the same).
  **`⌄`** next to it opens the picker for starting a session as a *different* account.
- **Split** the focused pane with ⌘D (right) / ⇧⌘D (down), or the title-bar buttons.
- **Drag a tab** (from the tab strip or the sidebar) onto another pane. Dropping near an
  edge splits that pane along the matching axis; dropping in the middle adds it as a tab.
- **Drag a divider** to resize. ⌥⌘0 evens everything out.
- **⌥⌘⏎** maximizes the focused pane; press again to restore.
- Dropping onto a pane whose parent already splits along the same axis joins that split as
  a sibling rather than nesting a new one, so dividers stay aligned.

Terminals are owned by a registry outside the React tree and re-parented into whichever
pane holds them, so moving a session never restarts the process or loses its scrollback.

## Shortcuts

| | |
| --- | --- |
| ⌘T / ⇧⌘T | New Claude session / new shell |
| ⇧⌘K | Duplicate the focused session |
| ⌘W | Close session |
| ⌘R | Restart session (same profile, same folder) |
| ⌘E | Rename tab (double-click also works) |
| ⌘D / ⇧⌘D | Split right / split down |
| ⌥⌘← ↑ → ↓ | Move focus between panes |
| ⌃Tab / ⌃⇧Tab | Next / previous tab in the pane |
| ⌥⌘0 / ⌥⌘⏎ | Even out splits / maximize pane |
| ⌘B | Toggle sidebar |
| ⌘F / ⌘K | Find in terminal / clear terminal |
| ⌘+ / ⌘- / ⌘0 | Font size |
| ⌘, | Accounts |

## Naming and folders

A session's **folder is its own**, and it is read from the running shell rather than
assumed: `cd` anywhere in a terminal and that session follows, alone. The account's
starting folder only decides where a new session opens; the folder shown in the tab, the
sidebar, and the status bar is wherever that shell actually is right now (polled from the
OS every 2.5s — one `lsof` call covers every session).

Because of that, a tab is labelled with its **folder**, not with the program running in
it — three panes all reading "claude" tell you nothing. Give a session a name of your own
with **⌘E**, a double-click on its tab, or **right-click → Rename**; the name sticks and
survives restarts. Right-click also offers Duplicate, Restart, Split, and Close, on both
tabs and sidebar rows.

The status bar keeps the volatile part: account, live folder, and whatever the running
program currently calls itself.

## Running out of usage

An account with no usage left stops being useful mid-conversation, and starting over on
another account throws the whole thread away. So conversations are saved continuously and
can be carried between accounts.

**How it works.** Claude Code stores a conversation as one JSONL file per session, under
the account's config dir, in a folder named after the working directory. That file holds
no account or organisation — which is what makes the move possible: drop the same file
into another account's config dir and `claude --resume <id>` picks the conversation up
exactly where it stopped. The app pins each conversation's id at launch
(`claude --session-id <uuid>`) so the transcript's path is known rather than guessed.

**Auto context save.** Every Claude session's transcript is copied into
`~/Library/Application Support/Smart Terminal/context-snapshots/<session>/` every 8
seconds when it changes, and once more on quit. The snapshot is the safety net: it
survives the account's config dir being rotated or deleted.

**Moving a session.** Right-click a tab → *Move conversation to* → an account. The app
takes a final snapshot, copies the transcript into that account's config dir, opens a
session there resuming it, and retires the original. The new tab is marked `↷` and its
terminal says which account it came from.

**Automatically.** Session output is watched for an account reporting it is out of usage.
When that happens the session is carried over on its own, to the account set in
*Carry sessions over to*, or else any other signed-in account that has not also run out.
Turn it off with the *auto* box on the banner, or in the account editor.

The detection is a regular expression over terminal output, not an API signal, so it is a
heuristic — the pattern is editable (`limitPattern` in `workspace.json`) and an
unrecognised notice just means the banner does not appear and you move the session by
hand. Restarting a session (⌘R) also resumes its conversation rather than starting over.

## Session state

Every tab is labelled with the account it runs as, in that account's colour, so two panes
belonging to different Claude logins are never confused. The same colour underlines the
selected tab, marks the pane's status bar, and appears as a chip in the title bar.

The sidebar groups every session by account and shows a dot per session:

- green — running, blue — starting, red — exited
- pulsing — output is arriving right now (a rough "Claude is working" light)
- a small blue dot — output arrived while the tab was hidden

## Groups

Tabs can be gathered into a named group, the way a browser folds related tabs together. A
group has a name, a colour and a text size, and it owns those for every session in it — a
tab standing on its own carries the same two settings for itself, and joining a group
hides them rather than discarding them, so leaving one brings them back.

A group also remembers how it was arranged — as tabs, side by side, stacked or in a grid.
**Close these sessions** puts the whole group away at once; the group record outlives its
sessions, so History can bring the whole thing back later with the same colour, text size,
arrangement, folders, accounts and conversations.

## Working on its own

A Claude session spends a lot of its life stopped at a prompt with nothing left to say —
the plan is clear, the next step is obvious, and it is only waiting to be told to go on.
**Keep working on its own**, a checkbox in the tab's menu, removes that waiting.

What it deliberately does *not* remove is the other kind of stop: the one where a person
has to decide something. Those are the stops worth having.

The difference is read from Claude's own transcript, not from the screen. A finished turn
is an assistant message with `stop_reason: end_turn`; a pending decision is a tool request
with no result after it. Some questions, though, live only on the screen — trusting a
folder, approving a plan, Claude Code's own setup prompts — and leave no trace in the
transcript. So the screen gets a veto, consulted first: if it looks like a menu awaiting a
choice, nothing is typed. The veto is only ever used to refuse, because a false positive
costs a pause the user ends with one keystroke, while a false negative would answer a
question on their behalf.

It stops on its own too: Claude is asked to reply `AUTOPILOT-DONE` when there is nothing
left, and two nudges that produce no work end the run regardless. The title bar counts the
sessions stopped on a question, since decisions are what actually halt a run.

## Moving a conversation between accounts

Transcripts carry no account of their own, which is what makes this possible: a copy filed
under another account's config dir can be resumed there. **Move conversation to** does that
for a live session; in History, the caret beside **Continue** does it for a closed one, so
reopening a session and changing accounts is a single step — which is the point when the
reason it closed was that account running out.

## Which build is this

The sidebar footer shows the version and build number, and clicking it copies the full
build line. The same details are in the macOS About panel. Each `npm run dist` stamps
`electron/build-info.json` with the version, an incrementing build number and a timestamp,
so two builds of the same version are still tellable apart.

## Persistence

`~/Library/Application Support/Smart Terminal/` holds `profiles.json`, `workspace.json`
and `smart-terminal.db` — a SQLite database (via `node:sqlite`) with the session index,
group records, handoff history and, for sessions that opt in, stored transcripts.
On quit the layout, tab order, and each session's account, folder and conversation id are
saved. On launch the panes come back and each Claude session **resumes its own
conversation** in the same folder under the same account. The processes themselves cannot
survive a restart, but what was said does.

## Project structure

```
electron/
  main.js         app lifecycle, BrowserWindow, IPC wiring
  preload.js      the only bridge exposed to the renderer (contextIsolation on)
  pty-manager.js  node-pty spawn/write/resize/kill + per-profile environment
  profiles.js     account store and auto-discovery
  auth.js         `claude auth status` probing, credential-folder suggestions
  cwd-watcher.js  polls each shell's real working directory
  context-store.js  transcript snapshots, cross-account carry-over, turn state
  autopilot.js    keeps a session moving, and knows when not to
  database.js     SQLite: sessions, groups, handoffs, transcript search
  usage.js        weekly and session limits, via `claude -p /usage`
  menu.js         accelerators (defined here so they fire while xterm has focus)
  restore.js      which sessions a window brings back after a restart
  store.js        atomic JSON files under userData
src/
  state/layout.ts    the split tree: split, drop, prune, resize, collapse
  state/store.ts     zustand store: sessions, layout, settings, pty plumbing
  terminals/registry.ts  persistent xterm instances, re-parented across panes
  components/        Pane, LayoutView (splits + dividers), Sidebar, ProfileEditor,
                     Popover (viewport-clamped, portalled), SessionContextMenu,
                     HandoffBanner…
```

## Building a release

`npm run dist` puts an unsigned `.dmg` in `release/`. Unsigned means macOS asks for
right-click → Open the first time, once per machine.

Removing that prompt takes a notarised build, which takes a paid Apple Developer account and
a **Developer ID Application** certificate. With one in the keychain the same command signs
and notarises:

```bash
APPLE_TEAM_ID=XXXXXXXXXX APPLE_ID=you@example.com \
  APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop npm run dist
```

## Working on it

[CONTRIBUTING.md](CONTRIBUTING.md) is the other half of this file: how to run a development
copy without disturbing a real one, how to see inside a running instance, what had to be
learned about Claude Code by experiment, and the handful of rules in this codebase that are
load-bearing.

## License

[MIT](LICENSE) © Viktor Karpyuk
