---
name: code-review-bus
description: Coordinate with whoever else is writing in the same repository — the Code Reviewer's fixes and the other Smart Terminal sessions. Use when you are about to change code in a repository the Code Reviewer knows, before editing files another branch or session may also be changing, before creating a numbered database migration (V<n>__name.sql), and when you change something others depend on — a type, a table, an endpoint, a signature.
allowed-tools:
  - mcp__code-review__peers
  - mcp__code-review__inbox
  - mcp__code-review__notify
  - mcp__code-review__claim
  - mcp__code-review__who_touched
  - mcp__code-review__release
  - mcp__code-review__migration_number
---

# The Code Reviewer's bus

Smart Terminal's Code Reviewer writes fixes for pull requests, each in its
own copy of the repository, several at once. You may be working in the very
same repository. Nobody can overwrite anybody — every branch has its own copy —
so the danger is not now: it is the merge, when two branches changed the same
file, or two migrations took the same number and one already ran somewhere.

The bus is how you see that coming. You are identified by Smart Terminal, and
where you are is worked out from your working directory: a clone the Code
Reviewer has configured, or one of its fix workshops. Outside those, the tools
say so and do nothing.

## Before you change code

1. `peers` and `inbox` first. Who else is writing in this repository, what
   they have claimed, and anything they left for you.
2. `who_touched` on the files you are going to edit. It reads the other open
   pull requests' branches from git. If one of them changes the same file,
   change as little as you can there and do not reorder or reformat it.
3. `claim` those files. If someone already holds one, you are told who — say
   so to the user, or `notify` the holder, instead of editing it anyway.

## While you work

- Creating a migration? Ask `migration_number` for it. The number that looks
  free on disk may already be used on another open PR's branch, or reserved by
  a fix that has not written its file yet. Use exactly the number you are given.
- Renamed a type, a table or an endpoint, changed a signature, found something
  broken that others will trip over? `notify`, with scope `REPO` when it
  concerns more than your own pull request. Do not narrate progress.

## When you are done

`release` whatever you claimed and did not end up touching. Your claims also
go on their own when your session ends or moves to another repository.
