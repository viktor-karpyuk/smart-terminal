/**
 * Hosting a whole view that came with an extension.
 *
 * A preview was easy to make safe: text in, HTML out, run in a worker with no
 * DOM and shown in a frame that runs no scripts. A panel cannot work that way,
 * because a panel is worked in — it has to answer a click, ask a question and
 * draw the answer. So it gets scripts, and the question becomes where.
 *
 * In a frame with `sandbox="allow-scripts"` and deliberately *not*
 * `allow-same-origin`. That combination puts the document in an opaque origin
 * of its own: it cannot touch this page, cannot read a cookie or a stored value
 * belonging to the app, has no `window.api`, no `require`, no filesystem, and
 * no way to navigate anything but itself. Everything it wants from the app it
 * has to ask for by message, and every message lands on the table below, which
 * is a fixed list of names rather than anything derived from what was asked.
 *
 * Two things remain true and are said rather than implied. Such a frame can
 * still reach the network — the renderer has no CSP yet, which is the next
 * thing worth closing. And a panel can be wrong: it can throw, hang or draw
 * nonsense. It cannot take the app with it, which is the line that matters.
 */

/** Reading the repository. Free: none of it changes anything. */
const READ_VERBS = [
  'root',
  'status',
  'graph',
  'refs',
  'compare',
  'commitFiles',
  'head',
  'diff',
] as const;

/**
 * Changing the repository.
 *
 * Allowed, because a graph you cannot check out a branch from is a picture, not
 * a tool — and an extension was installed on purpose, from the repository, by
 * somebody who wanted what it does. What it is not allowed to do is anything
 * that is not on this list.
 */
const WRITE_VERBS = [
  'stage',
  'unstage',
  'commit',
  'push',
  'pull',
  'fetch',
  'checkout',
  'createBranch',
  'renameBranch',
  'trackRemote',
  'deleteBranch',
  'merge',
  'rebase',
  'abortMerge',
  'revert',
  'stash',
  'stashPop',
] as const;

/**
 * Reading a cluster. Free, in the same sense: none of it changes anything.
 *
 * Namespaced, unlike the git verbs, because there are now two things an
 * extension can be talking to and a bare `list` would not say which. The git
 * names stay bare so the graph extension keeps working; anything new is
 * prefixed.
 */
const KUBE_READ = [
  'contexts',
  'reachable',
  'resources',
  'list',
  'manifest',
  'describe',
  'logs',
  'events',
  'top',
  'summary',
  'brief',
] as const;

/**
 * Changing a cluster.
 *
 * A shorter list than git's, and deliberately so. There is no `drain`, no
 * `cordon` of a whole pool, no `edit`, no `exec` that runs a command of the
 * extension's choosing. What is here is what a dashboard is for: take one thing
 * away, make more or fewer of it, roll it, put an edited manifest back.
 */
const KUBE_WRITE = ['remove', 'scale', 'restart', 'apply', 'cordon'] as const;

/** The two long-running ones: following a log, holding a port open. */
const KUBE_STREAM = ['follow', 'stopFollow', 'forward', 'stopForward'] as const;

/**
 * The two that reach into the app rather than into a cluster.
 *
 * `shell` opens a real terminal tab running `kubectl exec` — a real pty, with a
 * real TTY, because a shell drawn inside a panel is a toy and everybody who has
 * used one knows it. `ask` opens a Claude session that has already been handed
 * everything about the object.
 *
 * Neither takes a command or a prompt from the extension. It names an object;
 * the app writes the command line and the app writes the words. That is the
 * whole reason these can exist at all: an extension that could compose the text
 * going into a Claude session could ask it to do anything.
 */
const KUBE_APP = ['shell', 'terminal', 'ask'] as const;

/**
 * Helm, which is a different tool and gets a different door.
 *
 * Reading is free. Of the three that change something, two can take a running
 * system away — a rollback replaces what is deployed with what used to be, and
 * an uninstall removes the lot — so both stop and ask.
 */
const HELM_READ = ['version', 'releases', 'history', 'values', 'manifest', 'notes'] as const;
const HELM_WRITE = ['rollback', 'uninstall'] as const;

const HELM_VERBS = new Map<string, Channel>([
  ...HELM_READ.map((name) => [name, 'helm'] as [string, Channel]),
  ...HELM_WRITE.map((name) => [name, 'helm'] as [string, Channel]),
]);

const GIT_VERBS = new Set<string>([...READ_VERBS, ...WRITE_VERBS]);
const KUBE_VERBS = new Map<string, Channel>([
  ...KUBE_READ.map((name) => [name, 'kube'] as [string, Channel]),
  ...KUBE_WRITE.map((name) => [name, 'kube'] as [string, Channel]),
  ...KUBE_STREAM.map((name) => [name, 'kube-stream'] as [string, Channel]),
  ...KUBE_APP.map((name) => [name, 'app'] as [string, Channel]),
]);

export type Channel = 'git' | 'kube' | 'kube-stream' | 'app' | 'helm';

/**
 * Which door a call goes through, or none.
 *
 * One function rather than a set of names, because the answer is no longer only
 * yes or no: a panel now talks to two different subsystems and to the app
 * itself, and the routing is the security boundary. Anything not named here
 * does not run — there is no default channel.
 */
export function route(name: string): Channel | null {
  if (GIT_VERBS.has(name)) return 'git';
  if (name.startsWith('kube.')) return KUBE_VERBS.get(name.slice(5)) ?? null;
  if (name.startsWith('helm.')) return HELM_VERBS.get(name.slice(5)) ?? null;
  return null;
}

export function allowed(name: string): boolean {
  return route(name) !== null;
}

/**
 * The calls the app stops to ask about first.
 *
 * Not because the extension is suspect — it is the same list a person should be
 * asked about anyway. In a repository that is the pair that can destroy work
 * existing nowhere else: a force push over somebody's commits, and deleting a
 * branch git itself would have refused to delete. In a cluster it is anything
 * that takes a running thing away.
 */
export function needsConsent(name: string, args: Record<string, unknown>): string | null {
  if (name === 'push' && args?.force) {
    return 'Force-push, overwriting what is on the remote?';
  }
  if (name === 'deleteBranch' && args?.force) {
    return `Delete the branch "${String(args.name ?? '')}" even though it is not merged?`;
  }

  /*
   * A cluster is not a working tree. There is no undo, no reflog and no copy on
   * disk of what was there a second ago, and the same click is harmless in a
   * scratch namespace and an outage in production. So the question always says
   * *where* as well as *what*: the namespace and the context are the whole
   * difference between the two, and a dialog that omits them is a dialog people
   * learn to click through.
   */
  if (name.startsWith('kube.')) {
    const where = whereItIs(args);
    const what = `${String(args.kind ?? 'resource')} ${String(args.name ?? '')}`.trim();
    if (name === 'kube.remove') return `Delete ${what}${where}?\n\nNothing brings it back.`;
    // A dry run is a question, not a change: the server validates it and throws
    // it away. Asking about that is asking about nothing.
    if (name === 'kube.apply' && !args.dryRun) {
      /*
       * Whether something else owns this object is the thing worth knowing
       * before you change it, and the object says so itself: Helm stamps every
       * resource it installs with the release it belongs to. Editing one by
       * hand works, and then the next `helm upgrade` puts it back — which is a
       * confusing afternoon if nobody said so beforehand.
       */
      const owner = /meta\.helm\.sh\/release-name:\s*(\S+)/.exec(String(args.yaml ?? ''));
      const managed = owner
        ? `\n\nHelm installed this, as part of the release "${owner[1]}". ` +
          'The next upgrade of that release will put it back the way the chart says.'
        : '';
      return `Apply this manifest${where}?${managed}`;
    }
    if (name === 'kube.scale' && Number(args.replicas) === 0) {
      return `Scale ${what} to zero${where}?\n\nEverything it runs stops.`;
    }
    if (name === 'kube.cordon' && args.on !== false) {
      return `Stop scheduling new pods onto ${String(args.name ?? 'this node')}${where}?`;
    }
  }
/*
   * Helm's two. A rollback is not obviously destructive until you have watched
   * one — it replaces what is deployed with what used to be, including the
   * things that were deliberately changed since — so it says which revision is
   * being left behind as well as which is coming back.
   */
  if (name === 'helm.rollback') {
    return (
      `Roll ${String(args.name ?? 'this release')} back to revision ${String(args.revision ?? '?')}` +
      `${whereItIs(args)}?\n\nEverything changed since that revision goes with it.`
    );
  }
  if (name === 'helm.uninstall') {
    return (
      `Uninstall ${String(args.name ?? 'this release')}${whereItIs(args)}?\n\n` +
      'Everything the chart installed is deleted.'
    );
  }
  return null;
}

/** " in namespace prod on cluster X" — the half of the question that is usually the answer. */
function whereItIs(args: Record<string, unknown>): string {
  const namespace = args?.namespace ? ` in namespace ${String(args.namespace)}` : '';
  const context = args?.context ? ` on ${String(args.context)}` : '';
  return `${namespace}${context}`;
}

/**
 * A value that will be one word to a shell, whatever is in it.
 *
 * Names come out of a cluster, which is to say out of whatever anybody put
 * there — and unlike everything else here, these two end up on a real command
 * line in a real terminal rather than in an `execFile` array. Single quotes
 * make a shell take the whole thing literally; the one thing they cannot
 * contain is a single quote, so a value carrying one is refused rather than
 * escaped into something clever that a different shell might read differently.
 */
export function shellQuote(value: string, what: string): string {
  const text = String(value ?? '');
  if (!text) throw new Error(`${what} is missing`);
  if (text.includes("'")) throw new Error(`${what} contains a quote, which this cannot pass to a shell safely`);
  return `'${text}'`;
}

export type Where = { context?: string; namespace?: string };

/**
 * What people call a cluster, out of what kubeconfig calls it.
 *
 * An EKS context is an ARN and a GKE one is four fields joined by underscores.
 * Neither fits on a tab, and neither is what anybody says out loud: the last
 * segment is the cluster's name, and the whole thing stays in the tooltip.
 */
export function shortContext(name: string): string {
  const text = String(name ?? '');
  if (text.startsWith('arn:')) {
    const cut = text.lastIndexOf('/');
    return cut >= 0 ? text.slice(cut + 1) : text;
  }
  if (text.startsWith('gke_')) {
    const parts = text.split('_');
    return parts[parts.length - 1] || text;
  }
  return text;
}

/** `--context X --namespace Y`, quoted, for a command line a person will see and edit. */
function whereFlags({ context, namespace }: Where): string {
  const parts: string[] = [];
  if (context) parts.push(`--context ${shellQuote(context, 'The context')}`);
  if (namespace) parts.push(`--namespace ${shellQuote(namespace, 'The namespace')}`);
  return parts.join(' ');
}

/**
 * The command that gets a person a shell inside a container.
 *
 * `sh -c` with a fallback, because the two-thirds of images that have bash and
 * the third that have only ash are not distinguishable from out here, and
 * "OCI runtime exec failed: exec: bash: not found" is a bad first impression of
 * a button called Shell.
 *
 * It is built from named parts and never from anything the extension wrote:
 * the panel says which pod, the app says what runs.
 */
export function execCommand(args: { pod: string; container?: string; shell?: string } & Where): string {
  const flags = whereFlags(args);
  const container = args.container ? ` -c ${shellQuote(args.container, 'The container')}` : '';
  const shell = args.shell
    ? shellQuote(args.shell, 'The shell')
    : `sh -c 'command -v bash >/dev/null && exec bash || exec sh'`;
  return `kubectl ${flags} exec -it ${shellQuote(args.pod, 'The pod')}${container} -- ${shell}`.replace(/\s+/g, ' ');
}

/**
 * A value safe inside a *double*-quoted string, which is a stricter question.
 *
 * Single quotes stop a shell reading anything at all; double quotes still let
 * it read `$`, a backtick and a backslash. The alias below has to nest one kind
 * of quoting inside the other, so this is the inner half — and rather than
 * escape those four characters into something a different shell might read
 * differently, a value carrying one is refused. No cluster or namespace anybody
 * has is named with a dollar sign in it.
 */
function innerQuote(value: string, what: string): string {
  const text = String(value ?? '');
  if (!text) throw new Error(`${what} is missing`);
  if (/["'$`\\]/.test(text)) throw new Error(`${what} contains a character this cannot pass to a shell safely`);
  return `"${text}"`;
}

/**
 * A terminal that is already pointed at what the panel is looking at.
 *
 * An alias rather than `use-context`, and that is the whole idea: the tab is
 * aimed at this cluster and this namespace, and nothing outside the tab has
 * changed. `k get pods` in it means what the panel means by it, and the same
 * command in any other window still means what it always did.
 *
 * Two layers of quoting, both needed: the outer single quotes are what make the
 * alias one word to the shell defining it, and the inner double quotes are what
 * keep a context name in one piece if it ever contains a space.
 */
export function terminalSetup({ context, namespace }: Where): string {
  const parts = ['kubectl'];
  if (context) parts.push(`--context ${innerQuote(context, 'The context')}`);
  if (namespace) parts.push(`--namespace ${innerQuote(namespace, 'The namespace')}`);
  return `alias k='${parts.join(' ')}'`;
}

/**
 * The bridge given to the panel, as source.
 *
 * Deliberately tiny, and deliberately the only way out: a panel that wants
 * anything says so through `host`, and what comes back is whatever the app
 * decided to answer.
 *
 * `postMessage` targets `'*'` because a sandboxed frame has no origin to name;
 * the host tells frames apart by comparing `event.source`, which is identity
 * rather than a string anyone could claim.
 */
const SHIM = `(function () {
  var pending = {};
  var listeners = {};
  var next = 0;
  function post(message) { parent.postMessage(message, '*'); }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'reply') {
      var waiting = pending[message.id];
      if (!waiting) return;
      delete pending[message.id];
      if (message.ok) waiting.resolve(message.data);
      else waiting.reject(new Error(message.error || 'the app would not do that'));
      return;
    }
    var fns = listeners[message.type] || [];
    for (var i = 0; i < fns.length; i += 1) {
      try { fns[i](message.payload); } catch (error) { /* one listener's problem */ }
    }
  });

  window.host = {
    /** Ask the app to run one of the things it allows. Resolves with its answer. */
    call: function (name, args) {
      var id = ++next;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        post({ type: 'call', id: id, name: name, args: args || {} });
      });
    },
    /** Listen for something the app pushes: 'context', 'changed', 'theme'. */
    on: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    /** Tell the app something: 'openFile', 'notify', 'title'. */
    emit: function (name, payload) { post({ type: 'event', name: name, payload: payload }); },
    /** Say the panel is up, and get the context back. */
    ready: function () { post({ type: 'ready' }); }
  };
})();`;

/** The theme values a panel is given, so it looks like part of the app. */
export type PanelTheme = { dark: boolean; tokens: Record<string, string> };

/**
 * The tokens handed across.
 *
 * Named rather than "whatever the app happens to define": a panel written
 * against a list can be relied on to keep working, and the app can change the
 * rest of its stylesheet without silently changing what extensions look like.
 */
export const THEME_TOKENS = [
  'bg',
  'bg-panel',
  'bg-elevated',
  'bg-input',
  'border',
  'border-strong',
  'text',
  'text-dim',
  'text-faint',
  'accent',
  'accent-soft',
  'danger',
  'ok',
  'git-new',
  'radius',
];

/** Read the app's own theme, to hand to a panel. */
export function readTheme(): PanelTheme {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const token of THEME_TOKENS) tokens[token] = style.getPropertyValue(`--${token}`).trim();
  return { dark: document.documentElement.dataset.theme !== 'light', tokens };
}

function cssVariables(theme: PanelTheme): string {
  return THEME_TOKENS.map((token) => `--${token}: ${theme.tokens[token] || 'inherit'};`).join('\n    ');
}

/**
 * Build the document a panel runs as.
 *
 * The extension supplies the body; the app supplies the head. That is not
 * tidiness — it is what stops a panel from declaring its own `<base>`, its own
 * charset, or a `<meta>` that changes how the frame behaves, and it is what
 * guarantees the bridge is in place before any of the extension's own script
 * runs.
 */
export function panelDocument(body: string, theme: PanelTheme): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  :root {
    ${cssVariables(theme)}
    color-scheme: ${theme.dark ? 'dark' : 'light'};
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong); border: 3px solid transparent; background-clip: content-box; border-radius: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
</style>
<script>${SHIM}</script>
</head>
<body>
${body}
</body>
</html>`;
}
