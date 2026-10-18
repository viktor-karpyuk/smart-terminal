# Housekeeping

What Smart Terminal and the work around it leave on disk, and giving it back.
It has a menu of its own in the menu bar — **Housekeeping › Open Housekeeping**
(⌘⇧H), one entry per tab, Clean Up Finished Worktrees, Weigh Everything Now,
Check Health Now — and is also reachable from the bin icon in the sidebar's
Monitor header and from the link in the Monitor's database view.

## What it lists

Everything is one kind of thing to the panel: a path, what it weighs, how long
it has been idle, why it cannot be removed right now, and one action. Items
fall in three buckets.

| Bucket | Items | Reversible |
|---|---|---|
| Sessions | each session's kept conversation in the database plus its saved copy under `context-snapshots/` | no |
| Worktrees | build caches directly inside the checkouts under the folders you name (`.angular`, `node_modules`, `target`, `dist`, `build`, `.gradle`, `.next`, `.vite`, `coverage`, …); the Code Reviewer's clones under `code-review/fixes/` | caches yes, clones no |
| App | `smart-terminal.db.backup-*` files; `Smart Terminal.backup-*` / `.state-*` folders beside the data folder; installers under `updates/`; pasted images older than a week; the window's own cache | yes |

*Reversible* means the thing comes back by itself or was never the only copy:
a cache is rebuilt by the next build, an installer by the next update. These
can go behind one button, **Free … now**. Everything else is the only copy of
something and is picked row by row and confirmed.

An item with a *blocker* is shown and counted but refused: a session still
running or still being recorded, a cache in a checkout a live session is
working in, a folder named like a cache that git does not ignore, a clone
whose pull request is still open or that holds fixes not yet handed back.

## Where it looks

The folders under **Worktrees › Folders looked through** are the ones you add.
A folder counts if it is a git checkout itself, and so does each of its direct
children that is one. Nothing deeper is crawled, so pointing it at
`~/dev/worktrees` is fine and pointing it at `~` is pointless.

## How sizes are measured

Measuring is the expensive half. Sizes are walked on a worker thread, never on
the thread that draws the window, and each one is remembered in the database
with the folder's mtime. The panel opens on the numbers it already has and
fills in the rest as they land; a very large folder shows its running total
while the walk is still going. A remembered size is trusted for an hour unless
the folder's mtime changed. **Measure again** walks everything regardless.

A session's path is the folder it worked in, which may be a whole repository.
It is never walked.

## Worktrees

Every worktree of every repository the panel knows is listed under
**Worktrees › Worktrees**: the repositories under the folders you added, the
ones your live sessions are standing in, and the Code Reviewer's. Each
repository's main working tree is left out; it is never removable.

Each row carries:

- **State** — `merged into origin/develop` (its commits are in a base branch and
  it had commits of its own), `branch deleted on origin` (what a squash-merge
  with "delete branch" leaves), `open`, `uncommitted changes`, `detached`,
  `folder gone` (git still lists it; the folder was removed by hand).
- **Idle** — the latest of three signs of life: the last commit, the mtime of
  the worktree's `.git` file (moved by checkout and commit), and the last time a
  Smart Terminal session was inside it, which the database knows.
- **Blockers** — changes not committed; commits never pushed, or pushed but
  ahead of the upstream; ignored files nothing could rebuild (an `.env`, a
  key); a session inside; locked; detached HEAD; a base branch.

Each row also answers "is the work in it done" in one word: **done** (merged,
or branch gone on origin), **unmerged** (commits no base branch has, or
uncommitted changes; the state says how many, e.g. `3 commits not merged`),
**empty** (no commit of its own). A worktree whose branch has no commit of
its own and is clean has nothing to lose and no push blocker.

Filter by idle days (default fourteen) and **finished only**. **Remove** takes
the selection through `git worktree remove` without `--force`, so git refuses
anything that changed since it was looked at; a finished branch is deleted with
`-d`, an unfinished one keeps its commits. **Remove all finished** takes every
merged or branch-gone worktree that has nothing in the way.

Answers are remembered per worktree against its HEAD and `.git` mtime for ten
minutes, at most six git processes run at a time per repository, and origin is
fetched once per repository every ten minutes at most. Two hundred worktrees
are a few seconds the first time and nothing the second.

A build cache inside a listed worktree is still shown under **Build caches**
but counted once, inside the worktree's size.

## Health

The **Health** tab is a small job that measures the machine and says when a
line is crossed.

- **Every minute**: free disk (bytes and percent of the volume holding the
  data folder), free memory, load per core (the five-minute average), the app's
  own memory, open sessions, the database and its write-ahead log.
- **Every hour**, and on **Weigh everything now**: what the three buckets
  weigh, how many worktrees there are, how many are idle for two weeks or more,
  how many are finished.

Each metric has two lines, **attention** and **limit**, with defaults (disk
free below 15% or 50 GB, memory free below 2 GB, load above one per core,
database above 1 GB, its log above 256 MB, more than twenty inactive
worktrees, more than thirty open sessions). Two **budgets** have no default:
what the app's data may weigh, and what the worktrees and caches may. Type a
number to set a line (bytes in GB), empty the field to turn it off.

A crossing is said once by a system notification with the reason in plain
words, and not again for a day unless it gets worse; a metric that comes back
to fine may be said again the next time it crosses. Clicking the notification
opens the panel on the tab the metric belongs to. The sidebar's housekeeping
button carries a dot while anything is crossed, and the panel opens with a
strip naming the conditions.

Swap is read too (`sysctl vm.swapusage` on macOS, `/proc/meminfo` on Linux):
swap in use above 50% is attention and above 80% a limit, because swap is what
makes typing in the terminals lag.

**What to do, in order** — the Health tab's own plan, before anybody asks
Claude: memory first when the machine is swapping (which processes hold it,
how many sessions are open), then the disk by what is largest and safest
(build caches in worktrees idle for two weeks, finished worktrees, old
installations and backups, conversations of sessions idle three months), then
the database (fold the log, compact the file). Each proposal says what it
frees and carries the button that does it; the same ones appear as **Quick
actions** under the bar. Nothing that would lose unmerged work is ever
proposed for removal; it is pointed at.

**Progress** — every action and every inventory report as they go: which item,
how many of how many, how much given back so far, how many refused. The panel
opens on the last inventory kept and says so while a fresh one is read.

**The last 30 days** — what housekeeping gave back (by week), and how the disk,
the worktrees and the database moved, from the kept log and readings.

Swap in use is history; **pages swapped out per minute** (from `vm_stat` on
macOS) is swapping happening now, with lines at 200 and 2000 a minute.

**Ask Claude** — in the strip at the top, in the bar, and in the Health tab —
opens a Claude session (one per panel, on a signed-in account) and hands it the
machine's state as text: the lines crossed and why they matter, memory and
swap, the processes holding the most memory, the disk and the buckets, the
worktrees with whether their work is merged, the largest caches, and a
question: which processes or sessions to close first, what to free on disk
without losing unmerged work, and what would stop it happening again. The
session proposes; nothing is run by the panel.

Readings are kept for a month in `hk_reading`. From them the tab shows how
fast the disk, the worktrees and the app's data are growing per week (a
least-squares slope over the last two weeks, nothing with fewer than two days
of readings) and, for the disk, how many days are left at that rate.

## What each action does

- **Free … now** — removes every reversible, unblocked item, except the newest
  downloaded update (that one is waiting to be installed). One confirmation.
- **Forget conversations** — deletes the kept conversation and the saved copy
  of the selected sessions. The record of what ran, when and where stays in
  History.
- **Delete sessions entirely** — removes the selected sessions and everything
  attached: record, conversation, messages, readings. One transaction. Cannot
  be undone. Running sessions and ones still being recorded are skipped.
- **Clear caches** — a cache folder is first renamed to `<name>.trash-<time>`
  (one atomic step, after which the build no longer sees it) and deleted in the
  background. Before that, git is asked whether it ignores the folder; a `dist`
  that is committed is refused. A removal interrupted by quitting is finished
  at the next start.
- **Discard clones** — hands the request to the Code Reviewer, whose own rules
  apply: a clone with a fix waiting to be handed back is refused.
- **Remove worktrees** — see Worktrees above. Never forced; a finished branch
  deleted, an unfinished one kept.

Every action is written to the **Log** tab with what it gave back. Nothing is
removed on a timer or because the panel was opened.

## The database itself

The SQLite file is tended from the Monitor's database view: orphaned rows,
the write-ahead log, VACUUM, rebuilding the search index. Housekeeping links
there rather than repeating it.

## Safety

Before anything is removed its path is checked against where its kind lives:
a database backup must be beside the database and named like one, a copied
data folder must be beside the live one and never be it, a cache must sit
directly inside a checkout the panel looks through, an installer must be in
`updates/`. Symbolic links in a cache's place are unlinked, never followed.
git is never run with `--force`.

## Tables

`hk_root` (the folders you added), `hk_size` (remembered measurements),
`hk_log` (removals), `hk_reading` (the health job's measurements) and
`hk_setting` (lines and budgets you changed, and what was already said), all in
`smart-terminal.db` under their own `hk_schema` version. At start, sizes of
folders that no longer exist are forgotten, the log is cut to a year and the
readings to a month.
