'use strict';

/**
 * Talking to Kubernetes.
 *
 * Through `kubectl`, always as `execFile('kubectl', [...args])` with the
 * arguments as an array and never a shell string. That matters more here than
 * it does for git: the names come from a cluster, and a cluster is a place other
 * people put things. Nothing below is ever concatenated into a command line, and
 * every name that arrives from outside is checked for a leading dash before it
 * is passed — a resource called `--all-namespaces` is a legal name and would
 * otherwise stop being a name and start being a flag.
 *
 * Two decisions are worth stating rather than discovering.
 *
 * **The context is never switched.** Every call carries `--context`, and
 * `kubectl config use-context` is not offered at all. Clicking a cluster in a
 * panel must not change what the person's own shell does in another window an
 * hour later; the panel looks at a cluster, it does not move the machine to it.
 *
 * **The rows are shaped here, not in the panel.** A namespace of five hundred
 * pods is several megabytes of JSON, and sending all of it across for a table
 * with six columns in it is a waste that shows up as a stutter. What crosses is
 * the table. The whole object is still one call away, for the one object being
 * looked at.
 */

const { execFile, spawn } = require('node:child_process');
const { resolvedPath } = require('./cli-env');

/** Long enough for a slow API server, short enough that a panel is never stuck. */
const TIMEOUT = 30000;
/** How long kubectl itself waits before giving up on the API server. */
const REQUEST_TIMEOUT = '20s';

/**
 * A name that cannot be mistaken for a flag.
 *
 * Kubernetes names are lowercase DNS labels, namespaces likewise, and contexts
 * are whatever kubeconfig says — an EKS context is an ARN, full of slashes and
 * colons. So this is not a spelling rule; it is the one check that matters:
 * nothing that starts with a dash, and nothing empty.
 */
function safeArg(value, what) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${what} is missing`);
  if (text.startsWith('-')) throw new Error(`${what} cannot start with "-"`);
  return text;
}

/**
 * Is this a name a cluster could actually have?
 *
 * `safeArg` is the right check for `execFile`, where a slash is harmless — an
 * EKS context is an ARN and is full of them. It is the wrong check for a path
 * built by interpolation, where a slash is a way out: a namespace of
 * `x/services/y:1/proxy/../../../api/v1/...` turns one fixed URL into any GET
 * at all against the API server. Kubernetes names are DNS labels, so requiring
 * one costs nothing and closes it.
 */
function isDnsName(value) {
  return /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i.test(String(value ?? '').trim());
}

/**
 * The flags that go *before* the subcommand, and the one that cannot.
 *
 * `--context` and `--namespace` belong to kubectl itself, so they lead. But
 * `--all-namespaces` belongs to `get`, `describe` and `top` individually, and
 * putting it in front produces "flags cannot be placed before plugin name" —
 * kubectl reads an unknown leading flag as an attempt to run a plugin. The
 * split is not tidiness; it is the difference between working and not.
 */
function scope({ context, namespace, allNamespaces, forever } = {}) {
  /*
   * `forever` is for the two commands that are *meant* to go on: a followed log
   * and a held-open port. A request timeout on those is not a safety net, it is
   * a countdown — kubectl closes the connection when it expires, so a log
   * stopped after twenty seconds and a forwarded port went dead at the same
   * moment, both silently and both looking like the cluster's doing.
   */
  const args = forever ? [] : ['--request-timeout', REQUEST_TIMEOUT];
  if (context) args.push('--context', safeArg(context, 'the context'));
  if (!allNamespaces && namespace) args.push('--namespace', safeArg(namespace, 'the namespace'));
  return args;
}

/** The flag that has to come after the subcommand it belongs to. */
function everywhere({ allNamespaces } = {}) {
  return allNamespaces ? ['--all-namespaces'] : [];
}

let cachedEnv = null;
/**
 * The environment kubectl runs in.
 *
 * Its PATH is the app's plus whatever an interactive login shell would add:
 * started from Finder the app inherits launchd's bare PATH, and `kubectl` lives
 * in `/opt/homebrew/bin` or wherever a version manager put it. The same problem
 * the `claude` CLI had, and the same answer — except that here it bites twice,
 * because an EKS or GKE context runs an *auth plugin* (`aws`, `gke-gcloud-auth-plugin`)
 * that kubectl looks up on PATH itself. Without this the cluster does not fail
 * to be found; it fails to be authenticated to, which reads as a permissions
 * problem and is not one.
 */
async function environment() {
  // One lookup, however many callers arrive while it is happening — the same
  // reason `resolvedPath` dedupes: a burst of calls must not become a burst of
  // login shells.
  if (!cachedEnv) cachedEnv = resolvedPath().then((PATH) => ({ ...process.env, PATH }));
  return cachedEnv;
}

function forgetEnvironment() {
  cachedEnv = null;
}

async function run(args, { timeout = TIMEOUT, stdin = null } = {}) {
  const env = await environment();
  return new Promise((resolve) => {
    const child = execFile(
      'kubectl',
      args,
      { timeout, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout, stderr });
        resolve({
          ok: false,
          stdout: stdout || '',
          // kubectl's own words. Ours would be a worse version of "error: You
          // must be logged in to the server (Unauthorized)".
          error: cleanError(stderr, error),
          code: typeof error.code === 'number' ? error.code : null,
        });
      },
    );
    if (stdin != null) {
      child.stdin.end(stdin);
    }
  });
}

/**
 * What went wrong, said once.
 *
 * kubectl prefixes with "error: " and sometimes says the same thing twice; and
 * when the binary is simply not installed the message is about spawning a file,
 * which tells nobody what to do about it.
 */
/** A klog line: severity, timestamp, thread, file, and then the actual words. */
const KLOG = /^[EWIF]\d{4}\s[\d:.]+\s+\d+\s+\S+\]\s*/;

function cleanError(stderr, error) {
  /*
   * kubectl's client libraries log their retries to stderr in klog's format,
   * so a cluster nobody can reach answers with four lines of
   * `E0907 12:14:29.532977 37753 memcache.go:265] "Unhandled Error"…` before it
   * gets to the sentence a person can act on. The sentence is what is kept.
   */
  const lines = String(stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const plain = lines.filter((line) => !KLOG.test(line));
  const text = (plain.length ? plain : lines.map((line) => line.replace(KLOG, ''))).join('\n').trim();
  if (!text) {
    if (error?.code === 'ENOENT') {
      return 'kubectl is not installed, or not on the PATH this app can see.';
    }
    if (error?.killed) return `kubectl did not answer within ${TIMEOUT / 1000} seconds.`;
    return String(error?.message ?? 'kubectl failed');
  }
  return text.replace(/^error:\s*/i, '').trim();
}

/**
 * An API server error, cut down to the part a person can act on.
 *
 * kubectl echoes the entire patch it tried to send — four kilobytes of JSON for
 * a one-word mistake — and puts the actual reason at the very end. Nobody reads
 * to the end of that, so the reason is lifted out and the middle is dropped.
 *
 * The rule is deliberately dumb: what comes after the last colon in a very long
 * line is the reason, because that is how these are constructed. When something
 * names an unknown field, that is said first, because it is always the answer.
 */
function shortenApiError(text) {
  const raw = String(text || '').trim();
  if (raw.length < 400) return raw;

  const unknown = [...raw.matchAll(/unknown field "([^"]+)"/g)].map((match) => match[1]);
  if (unknown.length) {
    return `Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The cluster rejected the whole thing.`;
  }

  const lines = raw.split('\n').filter(Boolean);
  const shortened = lines.map((line) => {
    if (line.length < 400) return line;
    const tail = line.slice(-260);
    // From the last full stop or colon in the tail, so it starts on a sentence.
    const cut = Math.max(tail.lastIndexOf(': '), tail.lastIndexOf('. '));
    return `…${cut > 0 ? tail.slice(cut + 2) : tail}`;
  });
  return shortened.join('\n');
}

async function runJson(args, options) {
  const result = await run(args, options);
  if (!result.ok) return result;
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `kubectl answered with something that is not JSON — ${String(error?.message ?? error)}` };
  }
}

/* --------------------------------------------------------------------------
 * Shaping: the pure half. Everything below this line is a function of its
 * arguments, which is why it can be tested without a cluster.
 * ------------------------------------------------------------------------ */

/** How old, the way every Kubernetes tool says it: one or two units, largest first. */
function age(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours < 10 ? `${hours}h${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 10) return `${days}d${hours % 24}h`;
  if (days < 365) return `${days}d`;
  const years = Math.floor(days / 365);
  return `${years}y${days % 365}d`;
}

/**
 * What a pod is actually doing.
 *
 * `status.phase` is famously not the answer: a pod stuck pulling an image, one
 * in CrashLoopBackOff and one happily serving traffic are all `Running`, and a
 * pod being deleted stays `Running` until the moment it is gone. This follows
 * what `kubectl get pods` itself does — init containers first, then the
 * containers from last to first, with the deletion timestamp beating everything.
 */
function podStatus(item) {
  const status = item.status ?? {};
  if (item.metadata?.deletionTimestamp) return 'Terminating';

  let reason = status.reason || status.phase || 'Unknown';

  const inits = status.initContainerStatuses ?? [];
  for (let i = 0; i < inits.length; i += 1) {
    const state = inits[i]?.state ?? {};
    if (state.terminated?.exitCode === 0) continue;
    if (state.terminated) {
      return state.terminated.reason
        ? `Init:${state.terminated.reason}`
        : `Init:ExitCode:${state.terminated.exitCode ?? '?'}`;
    }
    if (state.waiting?.reason && state.waiting.reason !== 'PodInitializing') {
      return `Init:${state.waiting.reason}`;
    }
    return `Init:${i}/${inits.length}`;
  }

  const containers = status.containerStatuses ?? [];
  let running = false;
  // Backwards, as kubectl does: the last container to have something to say
  // about itself is the one that gets to say it.
  for (let i = containers.length - 1; i >= 0; i -= 1) {
    const container = containers[i] ?? {};
    const state = container.state ?? {};
    if (state.waiting?.reason) reason = state.waiting.reason;
    else if (state.terminated?.reason) reason = state.terminated.reason;
    else if (state.terminated) {
      reason = state.terminated.signal
        ? `Signal:${state.terminated.signal}`
        : `ExitCode:${state.terminated.exitCode ?? '?'}`;
    } else if (state.running && container.ready) running = true;
  }
  if (reason === 'Completed' && running) return 'Running';
  return reason;
}

/** Words that mean trouble, wherever they turn up. Everything else is fine or in progress. */
const BAD = [
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'ErrImageNeverPull',
  'CreateContainerConfigError',
  'CreateContainerError',
  'InvalidImageName',
  'Error',
  'Failed',
  'Evicted',
  'OOMKilled',
  'NodeLost',
  'Unschedulable',
  'DeadlineExceeded',
  'BackOff',
  'Unhealthy',
  'FailedScheduling',
  'FailedMount',
  'NotReady',
  'Lost',
];
const WAITING = [
  'Pending',
  'ContainerCreating',
  'PodInitializing',
  'Terminating',
  'Init:',
  'Progressing',
  'Provisioning',
  'Updating',
  'Released',
];

/**
 * Three colours, and no more.
 *
 * Because the only question a wall of rows has to answer at a glance is which
 * of them wants attention. A finer scale would be honest about Kubernetes and
 * useless as a signal.
 */
function health(text) {
  const value = String(text ?? '');
  if (!value) return 'idle';
  if (BAD.some((word) => value.includes(word))) return 'bad';
  if (WAITING.some((word) => value.includes(word))) return 'warn';
  return 'ok';
}

function ready(done, total) {
  return `${done}/${total}`;
}

/** The one thing every row has, whatever it is. */
function base(item, now) {
  return {
    uid: item.metadata?.uid ?? `${item.metadata?.namespace ?? ''}/${item.metadata?.name ?? ''}`,
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
    age: age(item.metadata?.creationTimestamp, now),
    createdAt: item.metadata?.creationTimestamp ?? null,
    labels: item.metadata?.labels ?? {},
  };
}

function podRow(item, now) {
  const containers = item.status?.containerStatuses ?? [];
  const wanted = item.spec?.containers?.length ?? containers.length;
  const status = podStatus(item);
  const restarts = containers.reduce((sum, container) => sum + (container.restartCount ?? 0), 0);
  const lastRestart = containers
    .map((container) => container.lastState?.terminated?.finishedAt)
    .filter(Boolean)
    .sort()
    .pop();
  return {
    ...base(item, now),
    status,
    health: health(status),
    ready: ready(containers.filter((container) => container.ready).length, wanted),
    restarts,
    restartNote: restarts > 0 && lastRestart ? `${age(lastRestart, now)} ago` : '',
    node: item.spec?.nodeName ?? '',
    ip: item.status?.podIP ?? '',
    containers: [
      ...(item.spec?.initContainers ?? []).map((container) => ({ name: container.name, init: true })),
      ...(item.spec?.containers ?? []).map((container) => ({ name: container.name, init: false })),
    ],
    // What could be forwarded to. Declared ports only: a container listening on
    // something it never declared is invisible from out here, and guessing
    // would offer a button that cannot work.
    forwardable: (item.spec?.containers ?? []).flatMap((container) =>
      (container.ports ?? []).map((port) => port.containerPort).filter(Boolean),
    ),
    controlledBy: (item.metadata?.ownerReferences ?? [])[0]?.kind ?? '',
  };
}

function deploymentRow(item, now) {
  const status = item.status ?? {};
  const wanted = item.spec?.replicas ?? 0;
  const available = status.availableReplicas ?? 0;
  const text = wanted === 0 ? 'Scaled to zero' : available >= wanted ? 'Available' : 'Progressing';
  return {
    ...base(item, now),
    status: text,
    health: wanted === 0 ? 'idle' : health(text),
    ready: ready(status.readyReplicas ?? 0, wanted),
    upToDate: status.updatedReplicas ?? 0,
    available,
    replicas: wanted,
    scalable: true,
    restartable: true,
  };
}

function statefulSetRow(item, now) {
  const status = item.status ?? {};
  const wanted = item.spec?.replicas ?? 0;
  const readyCount = status.readyReplicas ?? 0;
  const text = wanted === 0 ? 'Scaled to zero' : readyCount >= wanted ? 'Available' : 'Progressing';
  return {
    ...base(item, now),
    status: text,
    health: wanted === 0 ? 'idle' : health(text),
    ready: ready(readyCount, wanted),
    replicas: wanted,
    scalable: true,
    restartable: true,
  };
}

function daemonSetRow(item, now) {
  const status = item.status ?? {};
  const wanted = status.desiredNumberScheduled ?? 0;
  const readyCount = status.numberReady ?? 0;
  const text = readyCount >= wanted ? 'Available' : 'Progressing';
  return {
    ...base(item, now),
    status: text,
    health: health(text),
    ready: ready(readyCount, wanted),
    upToDate: status.updatedNumberScheduled ?? 0,
    available: status.numberAvailable ?? 0,
    replicas: wanted,
    restartable: true,
  };
}

function jobRow(item, now) {
  const status = item.status ?? {};
  const wanted = item.spec?.completions ?? 1;
  const succeeded = status.succeeded ?? 0;
  const failed = status.failed ?? 0;
  const text = failed > 0 ? 'Failed' : succeeded >= wanted ? 'Complete' : 'Running';
  return {
    ...base(item, now),
    status: text,
    health: health(text),
    ready: ready(succeeded, wanted),
    duration:
      status.completionTime && status.startTime
        ? age(status.startTime, Date.parse(status.completionTime))
        : status.startTime
          ? age(status.startTime, now)
          : '',
  };
}

function cronJobRow(item, now) {
  const suspended = item.spec?.suspend === true;
  return {
    ...base(item, now),
    status: suspended ? 'Suspended' : 'Scheduled',
    health: suspended ? 'idle' : 'ok',
    schedule: item.spec?.schedule ?? '',
    active: (item.status?.active ?? []).length,
    lastRun: item.status?.lastScheduleTime ? age(item.status.lastScheduleTime, now) : '',
  };
}

function serviceRow(item, now) {
  const spec = item.spec ?? {};
  const ingress = item.status?.loadBalancer?.ingress ?? [];
  const external = ingress
    .map((entry) => entry.hostname || entry.ip)
    .filter(Boolean)
    .join(', ');
  const pending = spec.type === 'LoadBalancer' && !external;
  return {
    ...base(item, now),
    status: pending ? 'Pending' : spec.type ?? 'ClusterIP',
    health: pending ? 'warn' : 'ok',
    type: spec.type ?? 'ClusterIP',
    clusterIP: spec.clusterIP ?? '',
    external: external || (spec.externalIPs ?? []).join(', '),
    ports: (spec.ports ?? [])
      .map((port) => `${port.port}${port.nodePort ? `:${port.nodePort}` : ''}/${port.protocol ?? 'TCP'}`)
      .join(' '),
    selector: spec.selector ?? {},
    forwardable: (spec.ports ?? []).map((port) => port.port),
  };
}

function ingressRow(item, now) {
  const rules = item.spec?.rules ?? [];
  const hosts = rules.map((rule) => rule.host).filter(Boolean);
  const address = (item.status?.loadBalancer?.ingress ?? [])
    .map((entry) => entry.hostname || entry.ip)
    .filter(Boolean)
    .join(', ');
  return {
    ...base(item, now),
    status: address ? 'Ready' : 'Pending',
    health: address ? 'ok' : 'warn',
    hosts: hosts.join(', ') || '*',
    address,
    class: item.spec?.ingressClassName ?? '',
  };
}

function nodeRow(item, now) {
  const conditions = item.status?.conditions ?? [];
  const readyCondition = conditions.find((condition) => condition.type === 'Ready');
  const complaints = conditions
    .filter((condition) => condition.type !== 'Ready' && condition.status === 'True')
    .map((condition) => condition.type);
  const isReady = readyCondition?.status === 'True';
  const unschedulable = item.spec?.unschedulable === true;
  const status = !isReady ? 'NotReady' : unschedulable ? 'Ready,SchedulingDisabled' : 'Ready';
  return {
    ...base(item, now),
    status,
    health: !isReady ? 'bad' : complaints.length || unschedulable ? 'warn' : 'ok',
    roles:
      Object.keys(item.metadata?.labels ?? {})
        .filter((key) => key.startsWith('node-role.kubernetes.io/'))
        .map((key) => key.slice('node-role.kubernetes.io/'.length))
        .filter(Boolean)
        .join(',') || '<none>',
    version: item.status?.nodeInfo?.kubeletVersion ?? '',
    instance: item.metadata?.labels?.['node.kubernetes.io/instance-type'] ?? '',
    zone: item.metadata?.labels?.['topology.kubernetes.io/zone'] ?? '',
    cpu: item.status?.capacity?.cpu ?? '',
    memory: item.status?.capacity?.memory ?? '',
    pods: item.status?.capacity?.pods ?? '',
    warnings: complaints,
    schedulable: !unschedulable,
  };
}

function pvcRow(item, now) {
  const phase = item.status?.phase ?? 'Pending';
  return {
    ...base(item, now),
    status: phase,
    health: health(phase === 'Bound' ? 'Bound' : phase),
    capacity: item.status?.capacity?.storage ?? item.spec?.resources?.requests?.storage ?? '',
    class: item.spec?.storageClassName ?? '',
    volume: item.spec?.volumeName ?? '',
    modes: (item.spec?.accessModes ?? []).join(','),
  };
}

function namespaceRow(item, now) {
  const phase = item.status?.phase ?? '';
  return {
    ...base(item, now),
    status: phase,
    health: phase === 'Active' ? 'ok' : 'warn',
  };
}

function eventRow(item, now) {
  const type = item.type ?? 'Normal';
  const at = item.lastTimestamp || item.eventTime || item.firstTimestamp || item.metadata?.creationTimestamp;
  return {
    ...base(item, now),
    status: item.reason ?? '',
    health: type === 'Warning' ? 'bad' : 'ok',
    type,
    message: (item.message ?? '').trim(),
    object: `${item.involvedObject?.kind ?? ''}/${item.involvedObject?.name ?? ''}`,
    objectKind: item.involvedObject?.kind ?? '',
    objectName: item.involvedObject?.name ?? '',
    count: item.count ?? 1,
    at: at ?? null,
    age: age(at, now),
  };
}

function configRow(item, now) {
  const keys = Object.keys(item.data ?? {}).length + Object.keys(item.binaryData ?? {}).length;
  return {
    ...base(item, now),
    status: '',
    health: 'idle',
    keys,
    type: item.type ?? '',
  };
}

/**
 * A row for something the app has never heard of.
 *
 * Which is most of a real cluster: cert-manager, Argo, Karpenter and every
 * operator anybody installed all bring their own kinds. A custom resource gets
 * its name, its age, and whatever its `Ready` condition says — which is the
 * convention nearly all of them follow, and is worth reading even when the app
 * cannot know what the thing is.
 */
function genericRow(item, now) {
  const conditions = item.status?.conditions ?? [];
  const readyCondition = conditions.find((condition) => condition.type === 'Ready' || condition.type === 'Available');
  const status = readyCondition
    ? readyCondition.status === 'True'
      ? readyCondition.type
      : readyCondition.reason || `Not${readyCondition.type}`
    : (item.status?.phase ?? item.status?.state ?? '');
  return {
    ...base(item, now),
    status,
    health: readyCondition ? (readyCondition.status === 'True' ? 'ok' : 'bad') : health(status),
    message: readyCondition?.message ?? '',
  };
}

/**
 * Which shaper draws which kind, and what its columns are called.
 *
 * Keyed by the kind kubernetes itself reports, so a CRD that happens to be
 * called `Deployment` in another group is not accidentally drawn as one — the
 * table is chosen by what was asked for, not by what came back.
 */
const SHAPES = {
  Pod: { row: podRow, columns: ['name', 'namespace', 'ready', 'status', 'restarts', 'node', 'age'] },
  Deployment: { row: deploymentRow, columns: ['name', 'namespace', 'ready', 'upToDate', 'available', 'status', 'age'] },
  StatefulSet: { row: statefulSetRow, columns: ['name', 'namespace', 'ready', 'status', 'age'] },
  DaemonSet: { row: daemonSetRow, columns: ['name', 'namespace', 'ready', 'upToDate', 'available', 'status', 'age'] },
  ReplicaSet: { row: deploymentRow, columns: ['name', 'namespace', 'ready', 'status', 'age'] },
  Job: { row: jobRow, columns: ['name', 'namespace', 'ready', 'status', 'duration', 'age'] },
  CronJob: { row: cronJobRow, columns: ['name', 'namespace', 'schedule', 'active', 'lastRun', 'status', 'age'] },
  Service: { row: serviceRow, columns: ['name', 'namespace', 'type', 'clusterIP', 'external', 'ports', 'age'] },
  Ingress: { row: ingressRow, columns: ['name', 'namespace', 'class', 'hosts', 'address', 'age'] },
  Node: { row: nodeRow, columns: ['name', 'status', 'roles', 'version', 'instance', 'zone', 'age'] },
  PersistentVolumeClaim: { row: pvcRow, columns: ['name', 'namespace', 'status', 'capacity', 'class', 'age'] },
  PersistentVolume: { row: pvcRow, columns: ['name', 'status', 'capacity', 'class', 'age'] },
  Namespace: { row: namespaceRow, columns: ['name', 'status', 'age'] },
  Event: { row: eventRow, columns: ['type', 'status', 'object', 'message', 'count', 'age'] },
  ConfigMap: { row: configRow, columns: ['name', 'namespace', 'keys', 'age'] },
  Secret: { row: configRow, columns: ['name', 'namespace', 'type', 'keys', 'age'] },
};

function shapeFor(kind) {
  return SHAPES[kind] ?? { row: genericRow, columns: ['name', 'namespace', 'status', 'age'] };
}

/** A list from kubectl, as a table. */
function table(kind, payload, now = Date.now()) {
  const shape = shapeFor(kind);
  const items = payload?.items ?? (payload?.kind && payload.kind !== 'List' ? [payload] : []);
  return {
    kind,
    columns: shape.columns,
    rows: items.map((item) => ({ kind: item.kind ?? kind, ...shape.row(item, now) })),
  };
}

/**
 * Which kind a list is a list of.
 *
 * Not `data.kind`: a plain `kubectl get pods -o json` answers `List`, not
 * `PodList`, and the resource name that was asked for is plural and lowercase.
 * The items know what they are, and they are the only ones that do.
 */
function kindOf(payload) {
  const first = payload?.items?.[0]?.kind;
  if (first) return first;
  const declared = String(payload?.kind ?? '');
  if (declared && declared !== 'List' && declared.endsWith('List')) return declared.slice(0, -4);
  return declared && declared !== 'List' ? declared : null;
}

/**
 * The groups that ship with Kubernetes.
 *
 * Everything else is somebody's operator, and belongs under Custom Resources
 * rather than mixed into the navigation. Group names are not a reliable guide
 * on their own — `apps` and `batch` have no dot in them and are as core as it
 * gets, while `cert-manager.io` has one and is not — so the core ones are
 * listed rather than guessed at.
 */
const CORE_GROUPS = new Set([
  '',
  'apps',
  'batch',
  'extensions',
  'policy',
  'autoscaling',
  'apiregistration.k8s.io',
]);

function isCore(group) {
  return CORE_GROUPS.has(group) || group.endsWith('.k8s.io') || group === 'k8s.io';
}

/**
 * What this cluster can hold.
 *
 * `kubectl api-resources` has no JSON form, so its columns are read by where
 * the header puts them rather than by splitting on spaces — CATEGORIES and
 * SHORTNAMES are routinely empty, and a positional split gets every later
 * column wrong the moment one is. Reading by column offset is the only way that
 * survives a CRD with no short name.
 */
function apiResources(text) {
  const lines = String(text || '').split('\n').filter((line) => line.trim());
  if (!lines.length) return [];
  const header = lines[0];
  const names = ['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND', 'VERBS', 'CATEGORIES'];
  const starts = names.map((name) => header.indexOf(name)).filter((at) => at >= 0);
  const found = names.filter((name) => header.indexOf(name) >= 0);

  const out = [];
  for (const line of lines.slice(1)) {
    const cell = (which) => {
      const at = found.indexOf(which);
      if (at < 0) return '';
      const from = starts[at];
      const to = at + 1 < starts.length ? starts[at + 1] : line.length;
      return line.slice(from, to).trim();
    };
    const name = cell('NAME');
    const kind = cell('KIND');
    if (!name || !kind) continue;
    const version = cell('APIVERSION');
    const group = version.includes('/') ? version.split('/')[0] : '';
    out.push({
      name,
      kind,
      apiVersion: cell('APIVERSION'),
      namespaced: cell('NAMESPACED') === 'true',
      short: cell('SHORTNAMES').split(',').filter(Boolean),
      group,
      builtIn: isCore(group),
    });
  }
  return out;
}

/**
 * What removing a context takes with it.
 *
 * A context names a cluster and a user, and both are separate entries that
 * other contexts may also name — an EKS account with four clusters shares
 * neither, but a cluster you have an admin and a read-only login for shares the
 * cluster between two contexts. Deleting the entry somebody else is still
 * pointing at leaves a context that cannot connect and says something baffling
 * about a cluster that "does not exist"; leaving an orphan behind is untidy but
 * harmless. So: take what nothing else refers to, and only that.
 */
function whatToRemove(config, name) {
  const contexts = config?.contexts ?? [];
  const found = contexts.find((entry) => entry.name === name);
  if (!found) return null;
  const cluster = found.context?.cluster ?? null;
  const user = found.context?.user ?? null;
  const others = contexts.filter((entry) => entry.name !== name);
  return {
    context: name,
    cluster: cluster && !others.some((entry) => entry.context?.cluster === cluster) ? cluster : null,
    user: user && !others.some((entry) => entry.context?.user === user) ? user : null,
    // What is left pointing at the same things, so the person can be told why
    // only part of it went.
    keptFor: others
      .filter((entry) => entry.context?.cluster === cluster || entry.context?.user === user)
      .map((entry) => entry.name),
  };
}

/** The contexts in kubeconfig, and which one kubectl would use. Reads a file; touches no cluster. */
function contextsFrom(config) {
  const contexts = (config?.contexts ?? []).map((entry) => ({
    name: entry.name,
    cluster: entry.context?.cluster ?? '',
    user: entry.context?.user ?? '',
    namespace: entry.context?.namespace ?? 'default',
  }));
  return { contexts, current: config?.['current-context'] ?? null };
}

/**
 * Prometheus, through the API server rather than around it.
 *
 * `kubectl get --raw` on the service proxy path, which is how Lens does it and
 * is the only way that needs nothing new: no port-forward to keep alive, no
 * second set of credentials, no ingress that may not exist. The same token that
 * reads pods reads this, and it works from wherever kubectl works — including
 * a cluster whose Prometheus is not exposed outside at all.
 */
async function promQuery({ service, port = 9090, namespace, query, minutes = 60, step, context }) {
  // These go into a URL rather than into an argument array, so: a DNS label,
  // a DNS label, and a number.
  const at = String(namespace ?? '').trim();
  const name = String(service ?? '').trim();
  const onPort = Number(port);
  if (!isDnsName(at)) return { ok: false, error: `Not a namespace a cluster could have: ${at}` };
  if (!isDnsName(name)) return { ok: false, error: `Not a service a cluster could have: ${name}` };
  if (!Number.isInteger(onPort) || onPort < 1 || onPort > 65535) return { ok: false, error: `Not a port: ${port}` };
  const end = Math.floor(Date.now() / 1000);
  const start = end - Math.max(60, Number(minutes) || 60) * 60;
  /*
   * About a hundred and twenty points, whatever the range.
   *
   * A fixed step gives an hour a fine line and a day a coarse one, and the day
   * is the range where a spike matters most — it is the one you look at
   * *because* something happened and you do not know when. Prometheus is asked
   * for the same resolution either way.
   */
  const seconds = Number(step) || Math.max(15, Math.round((end - start) / 120));

  const search = new URLSearchParams({
    query: String(query ?? ''),
    start: String(start),
    end: String(end),
    step: String(seconds),
  });
  const path = `/api/v1/namespaces/${at}/services/${name}:${onPort}/proxy/api/v1/query_range?${search}`;

  const result = await run([...scope({ context }), 'get', '--raw', path], { timeout: 20000 });
  if (!result.ok) return result;
  try {
    return { ok: true, ...seriesFrom(JSON.parse(result.stdout)) };
  } catch (error) {
    return { ok: false, error: `Prometheus answered with something unreadable — ${String(error?.message ?? error)}` };
  }
}

/**
 * One number per series, now.
 *
 * A range is for a shape; this is for a gauge. Disk is the case that needs it:
 * nobody wants a line of how full a node has been, they want to know how full
 * it is, and asking for a range and throwing away all but the last point is a
 * hundred and twenty values fetched to use one.
 */
async function promNow({ service, port = 9090, namespace, query, context }) {
  const at = String(namespace ?? '').trim();
  const name = String(service ?? '').trim();
  const onPort = Number(port);
  if (!isDnsName(at) || !isDnsName(name)) return { ok: false, error: 'Not a place a cluster could have.' };
  if (!Number.isInteger(onPort)) return { ok: false, error: `Not a port: ${port}` };

  const search = new URLSearchParams({ query: String(query ?? '') });
  const path = `/api/v1/namespaces/${at}/services/${name}:${onPort}/proxy/api/v1/query?${search}`;
  const result = await run([...scope({ context }), 'get', '--raw', path], { timeout: 20000 });
  if (!result.ok) return result;
  try {
    const answer = JSON.parse(result.stdout);
    return {
      ok: true,
      values: (answer?.data?.result ?? []).map((entry) => ({
        labels: entry.metric ?? {},
        value: Number(entry.value?.[1]),
      })),
    };
  } catch (error) {
    return { ok: false, error: `Prometheus answered with something unreadable — ${String(error?.message ?? error)}` };
  }
}

/**
 * A range answer, as points a line can be drawn from.
 *
 * Prometheus sends every value as a string, and gaps as missing samples rather
 * than as nulls — so a series that stopped for five minutes has fewer points
 * than its neighbour, and anything that assumes they line up draws a lie.
 */
function seriesFrom(answer) {
  const result = answer?.data?.result ?? [];
  const series = result.map((entry) => ({
    name:
      entry.metric?.pod ??
      entry.metric?.node ??
      entry.metric?.instance ??
      entry.metric?.__name__ ??
      '',
    points: (entry.values ?? [])
      .map(([at, value]) => [Number(at) * 1000, Number(value)])
      .filter(([, value]) => Number.isFinite(value)),
  }));
  return { series, empty: series.every((one) => !one.points.length) };
}

/**
 * Where this cluster keeps its Prometheus, if it keeps one.
 *
 * Found rather than configured, because on a cluster with kube-prometheus-stack
 * installed it is always in the same shape — a service on 9090 with prometheus
 * in its name — and asking somebody to type that in is asking them to look it
 * up. A cluster without one gets no charts and no apology.
 */
function findPrometheus(services) {
  const items = services?.items ?? [];
  const candidates = items
    .filter((item) => (item.spec?.ports ?? []).some((port) => port.port === 9090))
    .map((item) => ({
      name: item.metadata?.name ?? '',
      namespace: item.metadata?.namespace ?? '',
    }))
    .filter((item) => /prometheus|thanos-query|mimir/i.test(item.name));

  // The operated one is the StatefulSet's headless service; the plain one is
  // what everything else talks to, so it is the better guess.
  const plain = candidates.find((item) => !/operated|headless/i.test(item.name));
  return plain ?? candidates[0] ?? null;
}

/**
 * `kubectl top`, as a lookup rather than a table.
 *
 * Merged into rows the panel already has, so metrics never decide whether a row
 * exists: a cluster without metrics-server shows the same table, minus two
 * columns, instead of showing nothing.
 */
function metrics(text) {
  const lines = String(text || '').split('\n').filter((line) => line.trim());
  const out = {};
  if (lines.length < 2) return out;

  /*
   * Read by heading, not by position. `kubectl top nodes` is
   * NAME CPU(cores) CPU% MEMORY(bytes) MEMORY% and `kubectl top pods` is
   * NAME CPU(cores) MEMORY(bytes) — so the second-and-third-column rule that
   * works for pods reports a node's *CPU percentage* as its memory, which is a
   * number that looks entirely plausible and is wrong.
   */
  const heads = lines[0].trim().split(/\s+/);
  const byNamespace = heads[0] === 'NAMESPACE';
  const nameAt = byNamespace ? 1 : 0;
  const cpuAt = heads.findIndex((head) => head.startsWith('CPU(') || head === 'CPU');
  const memoryAt = heads.findIndex((head) => head.startsWith('MEMORY(') || head === 'MEMORY');

  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length <= nameAt) continue;
    const namespace = byNamespace ? parts[0] : '';
    out[`${namespace}/${parts[nameAt]}`] = {
      cpu: cpuAt >= 0 ? (parts[cpuAt] ?? '') : '',
      memory: memoryAt >= 0 ? (parts[memoryAt] ?? '') : '',
    };
  }
  return out;
}

/**
 * A Kubernetes quantity, as a number.
 *
 * CPU is written in cores or in thousandths of one — `2`, `500m` — and memory
 * in bytes with a binary or decimal suffix, which are not the same thing:
 * `1Ki` is 1024 and `1k` is 1000, and a cluster's manifests use both. Returned
 * in the smallest sensible unit for its kind — millicores, and bytes — so that
 * adding two of them is just addition.
 */
function quantity(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const match = /^(-?[\d.]+)([a-zA-Z]*)$/.exec(text);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const suffix = match[2];

  const scale = {
    '': 1,
    m: 0.001,
    k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
    n: 1e-9, u: 1e-6,
  };
  return amount * (scale[suffix] ?? 1);
}

/** CPU as millicores, which is how Kubernetes itself counts it. */
function millicores(value) {
  return Math.round(quantity(value) * 1000);
}

/**
 * What the cluster has, what has been promised, and what is actually in use.
 *
 * Three different numbers that get conflated constantly, and the gap between
 * them is the whole story. *Allocatable* is what the nodes will give out.
 * *Requested* is what the scheduler has already promised to pods, and it is
 * what decides whether the next pod fits — not usage. *Used* is what is being
 * consumed right now, and a cluster with 90% requested and 12% used is one
 * where somebody wrote the requests without measuring.
 */
function capacityFrom(nodes, pods, usage = {}) {
  const totals = {
    cpu: { allocatable: 0, requested: 0, limit: 0, used: 0 },
    memory: { allocatable: 0, requested: 0, limit: 0, used: 0 },
    // Disk on the nodes themselves. What a volume claims is a different pool
    // entirely — an EBS disk is not the node's — so it is counted separately.
    disk: { allocatable: 0, requested: 0, limit: 0, used: 0 },
  };

  for (const node of nodes) {
    const room = node.status?.allocatable ?? node.status?.capacity ?? {};
    totals.cpu.allocatable += millicores(room.cpu);
    totals.memory.allocatable += quantity(room.memory);
    totals.disk.allocatable += quantity(room['ephemeral-storage']);
  }

  for (const pod of pods) {
    // A pod that has finished is not holding anything.
    const phase = pod.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    for (const container of pod.spec?.containers ?? []) {
      totals.cpu.requested += millicores(container.resources?.requests?.cpu);
      totals.memory.requested += quantity(container.resources?.requests?.memory);
      totals.disk.requested += quantity(container.resources?.requests?.['ephemeral-storage']);
      totals.cpu.limit += millicores(container.resources?.limits?.cpu);
      totals.memory.limit += quantity(container.resources?.limits?.memory);
      totals.disk.limit += quantity(container.resources?.limits?.['ephemeral-storage']);
    }
  }

  for (const key of Object.keys(usage)) {
    totals.cpu.used += millicores(usage[key].cpu);
    totals.memory.used += quantity(usage[key].memory);
  }
  return totals;
}

/**
 * Where the cluster's room is going, by namespace.
 *
 * Sorted by what they have been promised rather than by what they are using:
 * the namespace holding a third of the cluster's CPU without touching it is the
 * one worth finding, and by usage it looks like the quietest thing there.
 */
function byNamespace(pods, limit = 8) {
  const seen = new Map();
  for (const pod of pods) {
    const phase = pod.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    const at = pod.metadata?.namespace ?? '';
    const row = seen.get(at) ?? { namespace: at, pods: 0, cpu: 0, memory: 0 };
    row.pods += 1;
    for (const container of pod.spec?.containers ?? []) {
      row.cpu += millicores(container.resources?.requests?.cpu);
      row.memory += quantity(container.resources?.requests?.memory);
    }
    seen.set(at, row);
  }
  return [...seen.values()].sort((a, b) => b.cpu - a.cpu || b.pods - a.pods).slice(0, limit);
}

/**
 * The warnings, gathered by what they are rather than listed as they came.
 *
 * Forty lines of `FailedScheduling` are one problem, and a list shows them as
 * forty. Grouping says how many kinds of thing are wrong, which is the number
 * somebody actually wants.
 */
function warningsByReason(events, limit = 8) {
  const seen = new Map();
  for (const event of events) {
    const key = event.status || 'Unknown';
    const row = seen.get(key) ?? { reason: key, count: 0, newest: '', example: '' };
    row.count += event.count || 1;
    if (!row.newest) {
      row.newest = event.age;
      row.example = event.message;
    }
    seen.set(key, row);
  }
  return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * The one-line health of a cluster, from the rows already fetched.
 *
 * Deliberately computed rather than asked for: `kubectl cluster-info` says the
 * control plane is up, which is not the question anybody opens a dashboard to
 * ask. What they want to know is whether anything is on fire.
 */
function overview({ nodes = [], pods = [], events = [] } = {}) {
  const badPods = pods.filter((pod) => pod.health === 'bad');
  const badNodes = nodes.filter((node) => node.health !== 'ok');
  const warnings = events.filter((event) => event.type === 'Warning');
  return {
    nodes: nodes.length,
    nodesUnhealthy: badNodes.length,
    pods: pods.length,
    podsRunning: pods.filter((pod) => pod.health === 'ok').length,
    podsFailing: badPods.length,
    restarts: pods.reduce((sum, pod) => sum + (pod.restarts ?? 0), 0),
    warnings: warnings.length,
    trouble: [
      ...badNodes.map((node) => ({ kind: 'Node', name: node.name, namespace: '', status: node.status })),
      ...badPods.map((pod) => ({ kind: 'Pod', name: pod.name, namespace: pod.namespace, status: pod.status })),
    ].slice(0, 50),
  };
}

/* --------------------------------------------------------------------------
 * The verbs. Reading first, then the ones that change something.
 * ------------------------------------------------------------------------ */

async function contexts() {
  // `config view` reads kubeconfig only — no cluster is contacted, so this
  // answers instantly even when every cluster in the file is unreachable.
  const result = await runJson(['config', 'view', '-o', 'json'], { timeout: 8000 });
  if (!result.ok) return result;
  return { ok: true, ...contextsFrom(result.data) };
}

/**
 * Is this cluster answering?
 *
 * Its own verb rather than a `list` with a shorter clock, because it is asked
 * about every context in kubeconfig and most people have one or two they cannot
 * reach from where they are sitting — a VPN they are not on, an account they
 * are not logged into. Waiting the full thirty seconds on each of those to draw
 * a red dot would make the panel useless for the clusters that *are* up.
 */
async function reachable({ context } = {}) {
  /*
   * Twelve seconds, not six.
   *
   * A managed cluster runs an auth plugin before it says anything at all —
   * `aws eks get-token`, `gke-gcloud-auth-plugin` — and that alone is a couple
   * of seconds on a good day and more when several are asked at once. At six
   * this reported healthy production clusters as down, which is the worst thing
   * a status dot can do: a wrong red is not a small error, it is a lie told
   * confidently.
   */
  const result = await run([...scope({ context }).slice(2), '--request-timeout', '12s', 'get', 'namespaces', '-o', 'name'], {
    timeout: 20000,
  });
  if (result.ok) return { ok: true, up: true, slow: false, namespaces: result.stdout.split('\n').filter(Boolean).length };

  /*
   * And when it still does not answer, say *that* rather than "down".
   *
   * A cluster that refused the connection, or whose credentials are stale, has
   * told us something. One that simply did not answer in time has told us
   * nothing — it may be busy, or behind a VPN that drops packets rather than
   * refusing them — and reporting a guess as a fact is how a dashboard stops
   * being believed.
   */
  const slow = /deadline exceeded|Client\.Timeout|did not answer within|i\/o timeout/i.test(result.error ?? '');
  return { ok: true, up: false, slow, error: result.error };
}

async function resources(args) {
  const result = await run([...scope(args), 'api-resources', '--verbs=list', '-o', 'wide'], { timeout: 20000 });
  if (!result.ok) return result;
  return { ok: true, resources: apiResources(result.stdout) };
}

/**
 * A table of one kind of thing.
 *
 * `kind` here is what kubectl calls a resource name — `pods`, `deployments`,
 * or the full `widgets.example.com` for a custom one, which is the spelling
 * that cannot collide with anything.
 */
async function list({ kind, as, selector, fieldSelector, limit, ...rest }) {
  const args = [...scope(rest), 'get', safeArg(kind, 'the resource kind'), ...everywhere(rest)];
  if (selector) args.push('--selector', safeArg(selector, 'the label selector'));
  if (fieldSelector) args.push('--field-selector', safeArg(fieldSelector, 'the field selector'));
  if (limit) args.push(`--chunk-size=${Number(limit) || 500}`);
  args.push('-o', 'json');
  const result = await runJson(args);
  if (!result.ok) return result;
  return { ok: true, ...table(as || kindOf(result.data) || kind, result.data) };
}

/** One object, whole, as YAML — which is what people actually read. */
async function manifest({ kind, name, ...rest }) {
  const result = await run([
    ...scope(rest),
    'get',
    safeArg(kind, 'the resource kind'),
    safeArg(name, 'the name'),
    '-o',
    'yaml',
  ]);
  return result.ok ? { ok: true, yaml: result.stdout } : result;
}

async function describe({ kind, name, ...rest }) {
  const result = await run([
    ...scope(rest),
    'describe',
    safeArg(kind, 'the resource kind'),
    safeArg(name, 'the name'),
  ]);
  return result.ok ? { ok: true, text: result.stdout } : result;
}

async function logs({ pod, container, tail = 500, previous = false, timestamps = false, ...rest }) {
  const args = [...scope(rest), 'logs', safeArg(pod, 'the pod'), `--tail=${Number(tail) || 500}`];
  if (container) args.push('-c', safeArg(container, 'the container'));
  if (previous) args.push('--previous');
  if (timestamps) args.push('--timestamps');
  const result = await run(args);
  // A pod that has never run has no previous log, and that is not a failure
  // worth a red box — it is an answer.
  return result.ok ? { ok: true, text: result.stdout } : result;
}

/**
 * What the cluster has been saying.
 *
 * About one object when asked, about the namespace otherwise. Sorted by the API
 * server rather than here, because it knows the true order of events whose
 * timestamps tie.
 */
async function events({ kind, name, ...rest }) {
  const args = [...scope(rest), 'get', 'events', ...everywhere(rest), '--sort-by=.lastTimestamp'];
  if (kind && name) {
    args.push(
      '--field-selector',
      `involvedObject.kind=${safeArg(kind, 'the kind')},involvedObject.name=${safeArg(name, 'the name')}`,
    );
  }
  args.push('-o', 'json');
  const result = await runJson(args);
  if (!result.ok) return result;
  const shaped = table('Event', result.data);
  // Newest first: a log reads downwards, a dashboard reads from the top.
  shaped.rows.reverse();
  return { ok: true, ...shaped };
}

async function top({ what = 'pods', ...rest }) {
  const which = what === 'nodes' ? 'nodes' : 'pods';
  const result = await run([...scope(rest), 'top', which, ...everywhere(rest)], { timeout: 20000 });
  if (!result.ok) {
    return {
      ok: true,
      metrics: {},
      // Not an error to show: most clusters without metrics-server are working
      // perfectly well, and the two columns simply do not appear.
      missing: /metrics|not found|ServiceUnavailable/i.test(result.error ?? '') ? result.error : null,
    };
  }
  return { ok: true, metrics: metrics(result.stdout), missing: null };
}

/**
 * Everything the first screen needs, in one round trip rather than six.
 *
 * The raw objects are kept alongside the rows for exactly as long as it takes
 * to add them up: capacity and the per-namespace split need what is inside a
 * pod's spec, which a row deliberately throws away. What crosses to the panel
 * is still only the totals.
 */
async function summary({ context } = {}) {
  const [nodes, pods, warnings, usage, podUsage, workloads, claims] = await Promise.all([
    listRaw({ kind: 'nodes', context }),
    listRaw({ kind: 'pods', context, allNamespaces: true }),
    events({ context, allNamespaces: true }),
    top({ what: 'nodes', context }),
    top({ what: 'pods', context, allNamespaces: true }),
    // One call for all three kinds: what is not fully available is one question.
    listRaw({ kind: 'deployments,statefulsets,daemonsets', context, allNamespaces: true }),
    listRaw({ kind: 'persistentvolumeclaims', context, allNamespaces: true }),
  ]);
  if (!nodes.ok && !pods.ok) return nodes.ok ? pods : nodes;

  const nodeItems = nodes.data?.items ?? [];
  const podItems = pods.data?.items ?? [];
  const now = Date.now();
  const nodeRows = table('Node', nodes.data, now).rows;
  const podRows = table('Pod', pods.data, now).rows;
  const warningRows = (warnings.rows ?? []).filter((row) => row.type === 'Warning');

  return {
    ok: true,
    ...overview({ nodes: nodeRows, pods: podRows, events: warningRows }),
    capacity: capacityFrom(nodeItems, podItems, usage.metrics ?? {}),
    busiest: busiestPods(podUsage.metrics ?? {}),
    workloads: workloadHealth(workloads.data?.items ?? []),
    pressure: nodePressure(nodeItems),
    volumes: volumeTotals(claims.data?.items ?? []),
    namespaces: byNamespace(podItems),
    reasons: warningsByReason(warningRows),
    nodeUsage: nodeUsage(nodeItems, usage.metrics ?? {}, now),
    recent: warningRows.slice(0, 25),
    nodeRows,
  };
}

/**
 * What the persistent volumes add up to.
 *
 * Nothing to do with the disk on the nodes: a claim is fulfilled by a volume
 * the cloud attaches, and adding the two together would produce a number that
 * describes nothing. Kept apart, and counted — including the ones that are
 * still waiting, because a Pending claim is a pod that will never start.
 */
function volumeTotals(claims) {
  let claimed = 0;
  let bound = 0;
  let pending = 0;
  for (const claim of claims) {
    claimed += quantity(claim.status?.capacity?.storage ?? claim.spec?.resources?.requests?.storage);
    if (claim.status?.phase === 'Bound') bound += 1;
    else pending += 1;
  }
  return { count: claims.length, claimed, bound, pending };
}

/**
 * The pods actually burning the cluster's CPU and memory right now.
 *
 * Not what they asked for — what they are using. Requests tell you what the
 * scheduler believes; this tells you where the cluster's afternoon went, and
 * the two are routinely nowhere near each other.
 */
function busiestPods(usage, limit = 6) {
  const rows = Object.keys(usage).map((key) => {
    const cut = key.indexOf('/');
    return {
      namespace: key.slice(0, cut),
      name: key.slice(cut + 1),
      cpu: millicores(usage[key].cpu),
      memory: quantity(usage[key].memory),
    };
  });
  return {
    cpu: [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, limit),
    memory: [...rows].sort((a, b) => b.memory - a.memory).slice(0, limit),
  };
}

/**
 * Which workloads are not what they are supposed to be.
 *
 * A pod count says how many are running; it does not say that a Deployment
 * asked for five and has three, which is the thing somebody is paged about. A
 * DaemonSet counts differently from the other two — it wants one per node, not
 * a number — so it is asked its own question.
 */
function workloadHealth(items) {
  const short = [];
  let total = 0;
  for (const item of items) {
    const kind = item.kind ?? '';
    total += 1;
    const status = item.status ?? {};
    let wanted;
    let ready;
    if (kind === 'DaemonSet') {
      wanted = status.desiredNumberScheduled ?? 0;
      ready = status.numberReady ?? 0;
    } else {
      wanted = item.spec?.replicas ?? 0;
      ready = status.readyReplicas ?? 0;
    }
    // Scaled to zero on purpose is not a fault.
    if (wanted === 0 || ready >= wanted) continue;
    short.push({
      kind,
      name: item.metadata?.name ?? '',
      namespace: item.metadata?.namespace ?? '',
      ready,
      wanted,
    });
  }
  short.sort((a, b) => a.ready / (a.wanted || 1) - b.ready / (b.wanted || 1));
  return { total, short: short.slice(0, 10), shortCount: short.length };
}

/**
 * What the nodes are complaining about besides being ready.
 *
 * `Ready` is the condition everybody looks at and the last one to turn: disk
 * and memory pressure show up first, and a node under them is already
 * refusing pods and evicting things while still reporting itself ready.
 */
function nodePressure(nodes) {
  const found = [];
  for (const node of nodes) {
    for (const condition of node.status?.conditions ?? []) {
      if (condition.type === 'Ready' || condition.status !== 'True') continue;
      found.push({
        node: node.metadata?.name ?? '',
        condition: condition.type,
        message: condition.message ?? '',
      });
    }
  }
  return found;
}

/** A list as the API server sent it, for the sums that need what is inside. */
async function listRaw({ kind, ...rest }) {
  const args = [...scope(rest), 'get', safeArg(kind, 'the resource kind'), ...everywhere(rest), '-o', 'json'];
  return runJson(args);
}

/**
 * Each node, with what it is holding against what it can hold.
 *
 * Per node rather than only in total, because a cluster at 60% with one node at
 * 97% is not a cluster at 60% — it is a cluster with one node about to start
 * evicting things, and the average hides exactly that.
 */
function nodeUsage(nodes, usage, now = Date.now()) {
  return nodes
    .map((node) => {
      const name = node.metadata?.name ?? '';
      const room = node.status?.allocatable ?? node.status?.capacity ?? {};
      const measured = usage[`/${name}`] ?? usage[name] ?? {};
      const conditions = node.status?.conditions ?? [];
      const internal = (node.status?.addresses ?? []).find((one) => one.type === 'InternalIP');
      return {
        name,
        // What node-exporter labels its series with, so disk can be matched to
        // a node without a second lookup on the other side.
        ip: internal?.address ?? '',
        cpu: millicores(measured.cpu),
        cpuAllocatable: millicores(room.cpu),
        memory: quantity(measured.memory),
        memoryAllocatable: quantity(room.memory),
        ready: conditions.find((one) => one.type === 'Ready')?.status === 'True',
        schedulable: node.spec?.unschedulable !== true,
        age: age(node.metadata?.creationTimestamp, now),
      };
    })
    .sort((a, b) => b.cpu / (b.cpuAllocatable || 1) - a.cpu / (a.cpuAllocatable || 1));
}

/**
 * Everything worth knowing about one object, as text for Claude.
 *
 * Composed here rather than in the panel, and that is a deliberate line. The
 * panel says *which* object; the app decides what evidence is gathered and how
 * it is worded. So an extension cannot put words of its own into a session that
 * might then act on them — the most it can do is point at a thing in a cluster
 * it could already read.
 *
 * What goes in is what a person would actually go and get: the description with
 * its conditions and its recent events, the warnings the cluster raised about
 * it, and — for a pod — the tail of the log, including the log of the container
 * that died, which is the one that usually says why.
 */
async function brief({ kind, name, namespace, context, container, question, previous = false }) {
  const kindName = safeArg(kind, 'the resource kind');
  const objectName = safeArg(name, 'the name');
  const isPod = /^pods?$/i.test(kindName) || kindName === 'Pod';

  const [described, seen, log, crashed] = await Promise.all([
    describe({ kind: kindName, name: objectName, namespace, context }),
    events({ kind: isPod ? 'Pod' : undefined, name: isPod ? objectName : undefined, namespace, context }),
    isPod ? logs({ pod: objectName, container, tail: 120, namespace, context }) : Promise.resolve(null),
    isPod
      ? logs({ pod: objectName, container, tail: 60, previous: true, namespace, context })
      : Promise.resolve(null),
  ]);

  const where = [context ? `context ${context}` : null, namespace ? `namespace ${namespace}` : null]
    .filter(Boolean)
    .join(', ');

  const parts = [
    `I am looking at a Kubernetes ${kindName} called ${objectName}${where ? ` in ${where}` : ''}.`,
    question?.trim() ? question.trim() : 'Tell me what is wrong with it and what to do about it.',
    '',
    'Everything below was gathered by Smart Terminal just now with kubectl. You can run more',
    'read-only kubectl yourself if you need it — always pass',
    context ? `--context '${context}'` : 'the right --context',
    'and do not change anything without asking me first.',
  ];

  if (described?.ok && described.text) {
    parts.push('', `## kubectl describe ${kindName} ${objectName}`, '```', described.text.trim(), '```');
  }

  const warnings = (seen?.rows ?? []).filter((row) => row.type === 'Warning');
  const shownEvents = (warnings.length ? warnings : (seen?.rows ?? [])).slice(0, 25);
  if (shownEvents.length) {
    parts.push(
      '',
      `## Events${warnings.length ? ' (warnings)' : ''}`,
      '```',
      ...shownEvents.map((row) => `${row.age.padStart(6)}  ${row.type}  ${row.status}  ${row.message}`),
      '```',
    );
  }

  /*
   * The log of the run that died goes first when there is one, and says so.
   *
   * A container that has restarted is showing a log that has been running for
   * ten seconds and knows nothing; the one before it is where the reason is.
   * When the person was already looking at that one — they pressed Previous —
   * it is what they are asking about, and it is said in those words.
   */
  if (crashed?.ok && crashed.text?.trim()) {
    parts.push(
      '',
      previous
        ? '## The log I am looking at — the previous container, the one that stopped'
        : '## Log of the previous container — the one that stopped',
      '```',
      crashed.text.trim(),
      '```',
    );
  }
  if (log?.ok && log.text?.trim()) {
    parts.push('', `## Log${previous ? ' of the container running now' : ', last 120 lines'}`, '```', log.text.trim(), '```');
  } else if (isPod && log && !log.ok) {
    parts.push('', `The log could not be read: ${log.error}`);
  }

  return { ok: true, text: parts.join('\n'), gathered: {
    describe: Boolean(described?.ok),
    events: shownEvents.length,
    log: Boolean(log?.ok && log.text?.trim()),
    previousLog: Boolean(crashed?.ok && crashed.text?.trim()),
  } };
}

/** Look for a Prometheus in this cluster. Reads services and nothing else. */
async function prometheus({ context } = {}) {
  const result = await runJson([...scope({ context }), 'get', 'services', '--all-namespaces', '-o', 'json'], {
    timeout: 20000,
  });
  if (!result.ok) return { ok: true, found: null };
  return { ok: true, found: findPrometheus(result.data) };
}

/* ---- the ones that change something ---- */

async function remove({ kind, name, ...rest }) {
  const result = await run([
    ...scope(rest),
    'delete',
    safeArg(kind, 'the resource kind'),
    safeArg(name, 'the name'),
    '--wait=false',
  ]);
  return result.ok ? { ok: true, text: result.stdout.trim() } : result;
}

async function scale({ kind, name, replicas, ...rest }) {
  const count = Number(replicas);
  if (!Number.isInteger(count) || count < 0) return { ok: false, error: 'A replica count is a whole number, zero or more.' };
  const result = await run([
    ...scope(rest),
    'scale',
    safeArg(kind, 'the resource kind'),
    safeArg(name, 'the name'),
    `--replicas=${count}`,
  ]);
  return result.ok ? { ok: true, text: result.stdout.trim() } : result;
}

async function restart({ kind, name, ...rest }) {
  const result = await run([
    ...scope(rest),
    'rollout',
    'restart',
    safeArg(kind, 'the resource kind'),
    safeArg(name, 'the name'),
  ]);
  return result.ok ? { ok: true, text: result.stdout.trim() } : result;
}

/**
 * Apply an edited manifest, through stdin so nothing is ever written to disk.
 *
 * `dryRun` sends it to the API server to be validated and thrown away, which is
 * the whole difference between finding out about a bad indent and finding out
 * about an outage. The panel does that first, every time, and only applies for
 * real once the server has said the thing is legal.
 */
async function apply({ yaml, dryRun = false, ...rest }) {
  const body = String(yaml ?? '');
  if (!body.trim()) return { ok: false, error: 'There is nothing to apply.' };
  const args = [...scope(rest), 'apply', '-f', '-'];
  if (dryRun) args.push('--dry-run=server');
  const result = await run(args, { stdin: body });
  if (result.ok) return { ok: true, text: result.stdout.trim(), dryRun };
  return { ...result, error: shortenApiError(result.error) };
}

/**
 * Take a cluster out of kubeconfig.
 *
 * The one thing in this file that edits a file of the person's rather than
 * talking to a cluster, and the only one whose damage is on their machine. It
 * is done through `kubectl config` rather than by writing YAML, so whatever
 * kubeconfig kubectl is actually using — including one assembled from several
 * files by `KUBECONFIG` — is the one that changes.
 */
async function removeContext({ name }) {
  const wanted = safeArg(name, 'the context');
  const config = await runJson(['config', 'view', '-o', 'json'], { timeout: 8000 });
  if (!config.ok) return config;

  const plan = whatToRemove(config.data, wanted);
  if (!plan) return { ok: false, error: `There is no context called ${wanted}.` };

  const done = [];
  const context = await run(['config', 'delete-context', plan.context], { timeout: 8000 });
  if (!context.ok) return context;
  done.push(`context ${plan.context}`);

  // The cluster and the user only if nothing else is pointing at them. A
  // failure here is worth reporting and not worth undoing the rest for: the
  // context is already gone, which is what was asked.
  if (plan.cluster) {
    const result = await run(['config', 'delete-cluster', plan.cluster], { timeout: 8000 });
    if (result.ok) done.push(`cluster ${plan.cluster}`);
  }
  if (plan.user) {
    const result = await run(['config', 'delete-user', plan.user], { timeout: 8000 });
    if (result.ok) done.push(`user ${plan.user}`);
  }
  return { ok: true, removed: done, kept: plan.keptFor, text: `Removed ${done.join(', ')}.` };
}

/**
 * Make a context the one a plain `kubectl` uses.
 *
 * The only place this app ever runs `use-context`, and it takes an explicit
 * menu item to get here. Everything else carries `--context`, so that looking
 * at a cluster cannot quietly change what the person's own shell does — but
 * *asking* for that to change is a perfectly reasonable thing to want, and
 * refusing to do it would only mean typing it somewhere else.
 */
async function useContext({ name }) {
  const result = await run(['config', 'use-context', safeArg(name, 'the context')], { timeout: 8000 });
  return result.ok ? { ok: true, text: result.stdout.trim() } : result;
}

/**
 * The arguments for draining a node.
 *
 * A stream, not a call, and that is the whole reason it is safe to offer: a
 * drain evicts every pod on a node one at a time and waits for each, and it
 * stops dead against a PodDisruptionBudget that will not let the last replica
 * go. Watching that happen is the difference between a drain and a mystery, so
 * this goes to the same dock the logs do.
 *
 * `--ignore-daemonsets` because a DaemonSet pod comes straight back and without
 * it the drain refuses to start at all. Local data is *not* deleted by default:
 * `--delete-emptydir-data` is asked for explicitly, because that flag is how
 * you throw away something nobody meant to lose.
 */
function drainArgs({ name, force = false, emptyDir = false, ...rest }) {
  const args = [
    ...scope({ ...rest, forever: true }),
    'drain',
    safeArg(name, 'the node'),
    '--ignore-daemonsets',
    '--timeout=300s',
  ];
  if (emptyDir) args.push('--delete-emptydir-data');
  // Pods no controller owns are not coming back anywhere. Off unless asked for.
  if (force) args.push('--force');
  return args;
}

async function cordon({ name, on = true, ...rest }) {
  const result = await run([...scope(rest), on ? 'cordon' : 'uncordon', safeArg(name, 'the node')]);
  return result.ok ? { ok: true, text: result.stdout.trim() } : result;
}

/* --------------------------------------------------------------------------
 * The long-running ones.
 *
 * Following a log and forwarding a port are the same shape — a process that
 * keeps talking until it is told to stop — so they are one mechanism. Every one
 * is owned by the window that asked for it and dies with it; a port-forward
 * that outlives the panel that opened it is a hole nobody can see.
 * ------------------------------------------------------------------------ */

class Streams {
  #live = new Map();

  async start(id, args, { onData, onEnd }) {
    this.stop(id);
    const env = await environment();
    const child = spawn('kubectl', args, { env, windowsHide: true });
    this.#live.set(id, child);

    const send = (text, stream) => {
      if (this.#live.get(id) !== child) return;
      onData({ id, text: String(text), stream });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => send(chunk, 'out'));
    child.stderr.on('data', (chunk) => send(chunk, 'err'));
    child.on('error', (error) => {
      send(`${cleanError('', error)}\n`, 'err');
    });
    child.on('close', (code) => {
      if (this.#live.get(id) === child) this.#live.delete(id);
      onEnd({ id, code });
    });
    return { ok: true, id };
  }

  stop(id) {
    const child = this.#live.get(id);
    if (!child) return false;
    this.#live.delete(id);
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    return true;
  }

  stopAll() {
    for (const id of [...this.#live.keys()]) this.stop(id);
  }

  get size() {
    return this.#live.size;
  }
}

/** The arguments for following a log. Built here so they can be checked without spawning anything. */
function followArgs({ pod, container, tail = 200, timestamps = false, ...rest }) {
  const args = [
    ...scope({ ...rest, forever: true }),
    'logs',
    safeArg(pod, 'the pod'),
    '--follow',
    `--tail=${Number(tail) || 200}`,
  ];
  if (container) args.push('-c', safeArg(container, 'the container'));
  if (timestamps) args.push('--timestamps');
  return args;
}

/**
 * The arguments for watching a kind.
 *
 * `--watch-only`, so it streams changes and does not re-send the world. The
 * first picture comes from an ordinary `get`, which is fast and finite, and
 * this takes over from there. Anything that happens in the second between the
 * two is caught by the slow resync the panel keeps running — a smaller and much
 * rarer cost than sending four megabytes twice on every open.
 *
 * `--output-watch-events` is what makes this usable at all: without it kubectl
 * prints the object and leaves you guessing whether it was added or changed,
 * and says nothing whatsoever about a deletion.
 */
function watchArgs({ kind, ...rest }) {
  return [
    ...scope({ ...rest, forever: true }),
    'get',
    safeArg(kind, 'the resource kind'),
    ...everywhere(rest),
    '--watch-only',
    '--output-watch-events',
    '-o',
    'json',
  ];
}

/**
 * Whole lines out of what has arrived, keeping the half-line for next time.
 *
 * `--output-watch-events -o json` writes one compact object per line, which is
 * the one thing that makes this cheap — but a pod's JSON is seventeen kilobytes
 * and arrives in several pieces, so the tail almost never lands on a boundary.
 */
function wholeLines(buffer) {
  const parts = String(buffer ?? '').split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((line) => line.trim()), rest };
}

/**
 * A watch event, as the row a table draws.
 *
 * Shaped here for the same reason lists are: what crosses to the panel is a
 * row, not the seventeen kilobytes the API server had to say about a pod whose
 * restart count went up by one.
 */
function watchRow(kind, line, now = Date.now()) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null; // a line that is not JSON is not an event; there is nothing to do with it
  }
  const object = event?.object;
  if (!object || !event.type) return null;
  // A watch can report an error — most often "too old resource version", which
  // means the connection is stale and everything has to be read again.
  if (event.type === 'ERROR') return { type: 'ERROR', error: object.message ?? 'the watch failed' };
  const shape = shapeFor(kind);
  return { type: event.type, row: { kind: object.kind ?? kind, ...shape.row(object, now) } };
}

/** The arguments for a port-forward. `local` may be 0, which lets the OS choose. */
function forwardArgs({ kind = 'pod', name, local, remote, ...rest }) {
  const localPort = Number(local);
  const remotePort = Number(remote);
  if (!Number.isInteger(remotePort) || remotePort <= 0) throw new Error('A port to forward to is required.');
  if (!Number.isInteger(localPort) || localPort < 0) throw new Error('A local port is required, or 0 to be given one.');
  return [
    ...scope({ ...rest, forever: true }),
    'port-forward',
    `${safeArg(kind, 'the kind')}/${safeArg(name, 'the name')}`,
    `${localPort}:${remotePort}`,
  ];
}

/** The port a forward actually got, from the line kubectl prints when it starts. */
function forwardedPort(text) {
  const match = /Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+)/.exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

module.exports = {
  // reading
  contexts,
  reachable,
  resources,
  list,
  manifest,
  describe,
  logs,
  events,
  top,
  summary,
  brief,
  promQuery,
  promNow,
  prometheus,
  // changing
  remove,
  scale,
  restart,
  apply,
  cordon,
  removeContext,
  useContext,
  // long-running
  Streams,
  followArgs,
  drainArgs,
  watchArgs,
  wholeLines,
  watchRow,
  forwardArgs,
  forwardedPort,
  // pure, and tested as such
  age,
  podStatus,
  health,
  table,
  shapeFor,
  apiResources,
  kindOf,
  isCore,
  contextsFrom,
  whatToRemove,
  metrics,
  overview,
  quantity,
  millicores,
  nodeUsage,
  capacityFrom,
  busiestPods,
  workloadHealth,
  nodePressure,
  volumeTotals,
  byNamespace,
  warningsByReason,
  seriesFrom,
  findPrometheus,
  safeArg,
  isDnsName,
  scope,
  everywhere,
  cleanError,
  shortenApiError,
  forgetEnvironment,
};
