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
  'object',
  'describe',
  'logs',
  'events',
  'top',
  'summary',
  'brief',
  'prometheus',
  'history',
  'promQuery',
  'promNow',
] as const;

/**
 * Changing a cluster.
 *
 * A shorter list than git's, and deliberately so. There is no `drain`, no
 * `cordon` of a whole pool, no `edit`, no `exec` that runs a command of the
 * extension's choosing. What is here is what a dashboard is for: take one thing
 * away, make more or fewer of it, roll it, put an edited manifest back.
 */
const KUBE_WRITE = [
  'remove',
  'scale',
  'restart',
  'apply',
  'configure',
  'cordon',
  'rollback',
  'pause',
  'suspend',
  'trigger',
] as const;

/**
 * The long-running ones: following a log, holding a port open, and watching a
 * kind for changes — which is the same shape as the other two and replaces the
 * asking-again that a table would otherwise have to do.
 */
const KUBE_STREAM = ['follow', 'stopFollow', 'forward', 'stopForward', 'watch', 'stopWatch', 'drain'] as const;

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

/**
 * Maven and Gradle.
 *
 * Reading is the project's own files and, for Gradle, one question put to
 * Gradle itself. There is no write verb at all: a build panel changes nothing
 * on disk by itself. The one thing that is not a read is `run`, which opens a
 * real terminal under the panel with the goal in it — and like `kube.shell`,
 * the panel names the goal and the app writes the command line.
 */
const BUILD_READ = ['root', 'project', 'tasks', 'dependencies'] as const;
const BUILD_APP = ['run'] as const;

const BUILD_VERBS = new Map<string, Channel>([
  ...BUILD_READ.map((name) => [name, 'build'] as [string, Channel]),
  ...BUILD_APP.map((name) => [name, 'app'] as [string, Channel]),
]);

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

export type Channel = 'git' | 'kube' | 'kube-stream' | 'app' | 'helm' | 'build';

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
  if (name.startsWith('build.')) return BUILD_VERBS.get(name.slice(6)) ?? null;
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
   * A rebase, unlike the two above, takes nothing away that the reflog cannot
   * give back. It is here because of where the button is: in the graph it sits
   * beside "Merge into current", the two read alike, and one of them replays
   * every commit on this branch as a new commit with a new hash. On a branch
   * anybody else has pulled, that is the difference between a merge and an
   * afternoon — and it is one click either way.
   */
  if (name === 'rebase') {
    return (
      `Rebase the current branch onto ${String(args.ref ?? 'this commit')}?\n\n` +
      'Every commit on it is replayed as a new one. If the branch is already pushed, ' +
      'what is on the remote no longer matches it.'
    );
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
    // Several at once first: the count is the part that is easy to get wrong,
    // and one question for the lot beats five that get waved through.
    if (name === 'kube.remove' && Number(args.count) > 1) {
      return `Delete ${String(args.count)} ${String(args.kind ?? 'object')}s${where}?\n\nNothing brings them back.`;
    }
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
    /*
     * Changing a few fields, and the question says which.
     *
     * "Apply this manifest?" is a question nobody can answer without reading the
     * manifest. A patch is small enough to say out loud, and what it says is
     * exactly what will be different a second from now — so the dialog lists it,
     * and scaling to zero still says what scaling to zero means.
     */
    if (name === 'kube.configure' && !args.dryRun) {
      const lines = Array.isArray(args.summary) ? args.summary.map((line) => `• ${String(line)}`) : [];
      const zero = Number((args.patch as { spec?: { replicas?: number } })?.spec?.replicas) === 0
        ? '\n\nAt zero replicas everything it runs stops.'
        : '';
      return `Change ${what}${where}?\n\n${lines.join('\n')}${zero}`;
    }
    if (name === 'kube.scale' && Number(args.replicas) === 0) {
      return `Scale ${what} to zero${where}?\n\nEverything it runs stops.`;
    }
    /*
     * A rollback is the one that reads as safe and is not. It does not undo the
     * last change; it replaces the workload's template with an older one, and
     * everything changed since — a bumped limit, a new environment variable, a
     * different image somebody pushed on Friday — goes back with it.
     */
    if (name === 'kube.rollback') {
      return (
        `Roll ${what} back to ${args.revision ? `revision ${String(args.revision)}` : 'its previous revision'}` +
        `${where}?\n\nEverything changed since that revision goes with it, not only the last change.`
      );
    }
    // Suspending is reversible and takes nothing away, but it does stop work
    // from happening, which somebody will otherwise wait for in silence.
    if (name === 'kube.suspend' && args.on !== false) {
      return `Stop ${what} running${where}?\n\nIt stays, and fires nothing until it is resumed.`;
    }
    if (name === 'kube.trigger') {
      return `Run ${String(args.name ?? 'this cron job')} now${where}?\n\nIt makes a real job, off schedule.`;
    }
    if (name === 'kube.cordon' && args.on !== false) {
      return `Stop scheduling new pods onto ${String(args.name ?? 'this node')}${where}?`;
    }
    /*
     * The one that was deliberately left out until it could be watched. A drain
     * moves everything off a node — which is a normal thing to do before
     * replacing one, and an outage if the thing being moved has nowhere to go.
     */
    if (name === 'kube.drain') {
      return (
        `Move everything off ${String(args.name ?? 'this node')}${where}?\n\n` +
        'Every pod on it is evicted, one at a time. It stops if a disruption budget will not allow it, ' +
        'and you will see that happen in the dock.'
      );
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

  /*
   * A build is local and reversible right up to the one step that is not. The
   * `deploy` phase, and Gradle's `publish`, copy the artifact to a repository
   * other people resolve from — and a snapshot pushed by accident is on every
   * colleague's next build. It sits one row below `install` in the tree, so it
   * is one double-click away from the one everybody runs.
   */
  if (name === 'build.run') {
    const goals = Array.isArray(args.goals) ? args.goals.map(String) : [];
    if (goals.some(publishes)) {
      return (
        `Run ${goals.join(' ')}?\n\n` +
        'This publishes the artifact to a remote repository, where everybody else resolves it from.'
      );
    }
  }
  return null;
}

/** Whether a goal or task sends something to a remote repository. */
function publishes(goal: string): boolean {
  const name = goal.includes(':') ? goal.slice(goal.lastIndexOf(':') + 1) : goal;
  if (name === 'deploy' || name === 'deploy-file' || name === 'perform') return true;
  // Gradle: `publish`, `publishAllPublicationsToX`, … but not to mavenLocal.
  return /^publish/i.test(name) && !/mavenlocal$/i.test(name);
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
 * A word on a command line, quoted only when it has to be.
 *
 * `mvn clean install -DskipTests` reads as what it is; `'mvn' 'clean'
 * 'install'` reads as a machine talking. So a token made of the characters a
 * goal, a flag or a property can contain goes as it is, and anything else — a
 * `*` in `-Dtest=Foo*`, a space in a property value — goes in single quotes,
 * which is what a person would type.
 */
function word(value: string, what: string): string {
  const text = String(value ?? '');
  if (!text) throw new Error(`${what} is missing`);
  if (/^[A-Za-z0-9_.:@=/,+-]+$/.test(text)) return text;
  return shellQuote(text, what);
}

export type BuildRun = {
  tool: 'maven' | 'gradle';
  /** The project root: where `mvnw` or `gradlew` lives, and what a Gradle task path is relative to. */
  root: string;
  wrapper?: boolean;
  /** For Maven, the module directory to run in; the root when absent. */
  dir?: string;
  goals: string[];
  profiles?: string[];
  skipTests?: boolean;
  offline?: boolean;
  /** Anything extra typed into the run box, already split into words. */
  extra?: string[];
};

/**
 * The command that runs a goal, and where it runs.
 *
 * Built from named parts and never from a line the panel wrote. The panel says
 * which goals, which profiles, which module; the app says which executable
 * runs and from which directory — and that directory is the project the panel
 * was opened on, not one of the panel's choosing.
 *
 * Maven runs *in the module*, the way IntelliJ does: `cd module && mvn
 * package` builds that module and its own children, and leaves the terminal
 * where the person is working. Gradle runs at the root always, because a task
 * path (`:app:build`) already says which project and the wrapper lives there.
 */
export function buildCommand(run: BuildRun): { command: string; cwd: string; title: string } {
  const goals = (run.goals ?? []).map((goal) => word(goal, 'A goal'));
  if (!goals.length) throw new Error('Nothing to run');
  const extra = (run.extra ?? []).map((part) => word(part, 'An argument'));
  if (!run.root) throw new Error('The project has no root');
  // Inside the project, or not at all: the panel was opened on this root, and
  // a module it names is one of the root's, not a directory of its own choosing.
  if (run.dir && run.dir !== run.root && !run.dir.startsWith(`${run.root}/`)) {
    throw new Error('That module is not inside the project');
  }

  if (run.tool === 'maven') {
    // The wrapper lives at the root; from a module it is reached by its path.
    const executable = run.wrapper ? shellQuote(`${run.root}/mvnw`, 'The wrapper') : 'mvn';
    const parts = [executable];
    if (run.offline) parts.push('-o');
    if (run.profiles?.length) parts.push(`-P${run.profiles.map((p) => word(p, 'A profile')).join(',')}`);
    parts.push(...goals);
    if (run.skipTests) parts.push('-DskipTests');
    parts.push(...extra);
    return {
      command: parts.join(' '),
      cwd: run.dir || run.root,
      title: `mvn ${goals.join(' ')}`.slice(0, 28),
    };
  }

  const parts = [run.wrapper ? './gradlew' : 'gradle'];
  if (run.offline) parts.push('--offline');
  parts.push(...goals);
  if (run.skipTests) parts.push('-x', 'test');
  parts.push(...extra);
  return {
    command: parts.join(' '),
    cwd: run.root,
    title: `gradle ${goals.map((g) => g.slice(g.lastIndexOf(':') + 1)).join(' ')}`.slice(0, 28),
  };
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
  /* Everything a panel shows can be selected and copied. A button cannot, so a
     click on one does not start a selection instead of doing what it says. */
  body { user-select: text; -webkit-user-select: text; }
  button, .btn, select { user-select: none; -webkit-user-select: none; }
</style>
<script>${SHIM}</script>
</head>
<body>
${body}
</body>
</html>`;
}
