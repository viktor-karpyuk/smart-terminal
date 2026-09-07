---
name: kubernetes
description: Investigate and change Kubernetes clusters from a Smart Terminal session. Use when the user asks why a pod, deployment, node or job is unhealthy, when a Smart Terminal Kubernetes panel has handed you a description and logs to explain, when they ask what is running in a cluster or namespace, or when they ask you to scale, restart, roll back or apply something.
---

# Kubernetes from a Smart Terminal session

You have a terminal and `kubectl` on it. That is the whole toolkit, and
it is enough — what follows is the part `kubectl --help` cannot tell you:
how this app expects you to use it, and which answers are worth
believing.

## Always pass `--context`

Smart Terminal never runs `kubectl config use-context`, deliberately: a
panel pointed at a cluster must not change what the user's own shell does
in another window an hour later. So there is no ambient "current
cluster" you can rely on being the one under discussion.

If a Kubernetes panel handed you this work, the context is named in what
it gave you. Use it on every command:

```
kubectl --context '<the context>' -n <namespace> get pods
```

If you were not given one, run `kubectl config get-contexts` and **ask
which** rather than guessing. On a machine with a `dev` and a `prod`
context whose names differ by four letters, guessing is how a debugging
session becomes an incident.

The tab may already have `k` aliased to `kubectl` with the right context
and namespace — the panel's Terminal button opens one like that. `alias
k` tells you whether you are in such a tab, and what it points at.

## Reading before writing

Everything in this section is safe, and none of it needs to be asked
about first:

- `get <kind> -o wide` — the table. Add `-A` for every namespace.
- `describe <kind> <name>` — conditions, and the events about this one
  object at the bottom. Usually the fastest answer in the whole toolkit.
- `logs <pod> -c <container> --tail=200` — and, when a container has
  restarted, **`--previous`**. The log of the run that died is the one
  that says why; the current one is usually a container that has only
  just started and knows nothing yet.
- `get events --sort-by=.lastTimestamp` — what the cluster has been
  saying. Warnings first: `--field-selector type=Warning`.
- `top pods` / `top nodes` — real usage, if metrics-server is installed.
  It often is not, and its absence is not a fault.

`status.phase` is not the status. A pod is `Running` while it crash-loops,
while it cannot pull its image, and while it is being deleted. Read the
container states, `restartCount`, and the deletion timestamp.

## Changing things

Ask first, every time, and say what will happen. A cluster has no undo:
there is no reflog, no stash, and nothing on disk that remembers what was
there a second ago.

- `scale --replicas=N` — reversible, and scaling to zero stops
  everything the workload serves. Say the number it is at now.
- `rollout restart` — disruptive but recoverable; say which workload.
- `rollout undo` — worth offering by name when a bad deploy is the
  diagnosis, along with `rollout history`.
- `delete` — the one to be most careful with. A deleted Deployment comes
  back from git if it is in git; a deleted PVC takes its data with it,
  and a deleted namespace takes everything in it.
- `apply -f` — say which file, and offer `--dry-run=server` first. It
  catches an invalid manifest without changing anything.

Never `drain`, `cordon` a whole pool, `delete` with `--all`, or edit
anything in `kube-system` without the user saying so in that message.

## When the panel hands you something

The Kubernetes panel's *Ask Claude* button opens a session with the
description, the warning events and the log — including the previous
container's log — already gathered. When that is how you arrived:

1. **Read what you were given before running anything.** It usually
   contains the answer, and the user has already waited for it once.
2. Say what is wrong in one or two sentences, in plain words. "The
   container is being OOM-killed: its memory limit is 256Mi and it asks
   for more within about a minute of starting."
3. Then say what you would do, and what it would cost. Distinguish the
   thing that stops the bleeding from the thing that fixes the cause —
   they are rarely the same, and the user may want only the first right
   now.
4. Run more read-only `kubectl` freely to check a hypothesis. Ask before
   anything that changes the cluster.

## The failures that are not failures

Three answers look like a broken cluster and are not:

- **`Unauthorized`, `error: You must be logged in`, or an exec-plugin
  failure** — an expired token, usually. `aws eks update-kubeconfig`,
  `gcloud container clusters get-credentials`, or whatever this context
  authenticates with. Ask; do not guess the command.
- **`no such host` or a connection timeout** — a private endpoint. The
  user is probably not on the VPN.
- **`the server doesn't have a resource type`** — that kind is not
  installed in *this* cluster. `kubectl api-resources` says what is.

Say which of these it is. "The cluster is unreachable" and "your token
expired" send somebody looking in two very different places.
