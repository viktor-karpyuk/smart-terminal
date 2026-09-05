---
name: sessions
description: Work with the other Smart Terminal sessions and with your own context budget. Use when the user asks you to tell, ask or hand something to another session by name, when they ask how this session is doing or whether it is getting full, when a long task is about to start, or when answers have started to feel slow or forgetful.
allowed-tools:
  - mcp__smart-terminal__list_sessions
  - mcp__smart-terminal__send_message
  - mcp__smart-terminal__broadcast_message
  - mcp__smart-terminal__session_health
  - mcp__smart-terminal__read_messages
---

# Sessions in Smart Terminal

You are one of several Claude sessions running side by side in Smart
Terminal, each usually on its own account and its own piece of work. Two
things follow from that, and neither is obvious from inside a single
conversation: you can talk to the others, and you can find out how you
yourself are doing.

The tools describe themselves. What follows is the part no tool
description can carry — when to reach for them, and what the answers are
worth.

## Talking to another session

**Always call `list_sessions` first.** Names are the user's, not yours:
they rename tabs, and the name in their head may be the folder, the tab
or the branch. Addressing a session you have not just seen listed is the
one reliable way to fail at this.

The listing tells you three things worth using:

- **who you are** — your own name and the id of your conversation, which
  you cannot learn any other way
- **who you can reach** — the user decides this, normally the sessions in
  your own group
- **who is out of reach** — running, but not yours to talk to

That last one matters. If the user asks you to tell "the docs session"
something and it is listed under *beyond*, say so plainly: it exists, and
here is why you cannot reach it. Do not report it as missing, and do not
retry — the answer will not change until the user changes the setting.

A message is **delivered when the other session is next waiting at its
prompt**, never onto work in progress. So it will usually not have been
read by the time you reply. Say that it was sent, not that it was
answered.

The pattern this exists for is two sessions on one job: one writes what
should be built, the other builds it. If you are the one handing over,
send what the other session needs to act — the decision, the file, the
constraint — not a summary of your afternoon. If you are the one
receiving, and it is not enough to act on, send a question back rather
than guessing.

## Knowing how you are doing

`session_health` reads the conversation already on disk. **It costs
nothing** — no request, no tokens — so there is no reason to ration it.

Ask when:

- a piece of work has just finished, before picking up the next
- you are about to start something long, and want to know if you have the
  room for it
- answers have started to feel slow, or you notice yourself having lost
  something that was said earlier

It answers with how much of the window you are using, what has been
spent, whether you have already been compacted automatically, and
anything that is going wrong — each with what usually helps.

**Act on it rather than reporting it.** If it says the context is nearly
full and there is a long task ahead, the useful move is to say so to the
user and suggest starting fresh, before the work rather than in the
middle of it. A compaction that happens on its own, halfway through
something, is the outcome this is meant to avoid.

## When you come back and something is missing

If your context was compacted or cleared, Smart Terminal hands you a
brief of what this session was doing: what it was called, the last thing
asked of it, the tasks still open. **It is a summary, so treat it as a
starting point rather than as the truth** — read the files before
changing them, and ask if it is not enough to go on.

Messages sent to you while you were busy are not lost either. Call
`read_messages` if you suspect you missed something, or after a long
stretch of work.
