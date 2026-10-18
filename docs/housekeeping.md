# Housekeeping

What Smart Terminal and the work around it leave on disk, and giving it back.
Open it from **Session › Housekeeping…**, from the bin icon in the sidebar's
Monitor header, or from the link in the Monitor's database view.

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
`hk_log` (removals), all in `smart-terminal.db` under their own `hk_schema`
version. At start, sizes of folders that no longer exist are forgotten and the
log is cut to a year.
