'use strict';

const test = require('node:test');
const assert = require('node:assert');
const kube = require('../electron/kube');

const NOW = Date.parse('2026-09-07T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('age says one or two units, largest first', () => {
  assert.equal(kube.age(ago(12 * 1000), NOW), '12s');
  assert.equal(kube.age(ago(5 * 60 * 1000), NOW), '5m');
  assert.equal(kube.age(ago(3 * 3600 * 1000 + 20 * 60 * 1000), NOW), '3h20m');
  assert.equal(kube.age(ago(20 * 3600 * 1000), NOW), '20h');
  assert.equal(kube.age(ago(2 * 86400 * 1000 + 5 * 3600 * 1000), NOW), '2d5h');
  assert.equal(kube.age(ago(40 * 86400 * 1000), NOW), '40d');
  assert.equal(kube.age(ago(400 * 86400 * 1000), NOW), '1y35d');
  assert.equal(kube.age(null, NOW), '');
  assert.equal(kube.age('not a date', NOW), '');
});

/*
 * The status of a pod is the thing this file exists to get right. `phase` says
 * Running for a pod that is crashing, for one that cannot pull its image, and
 * for one that is being deleted — three situations nobody would call the same.
 */
test('a pod that is crash-looping says so, not Running', () => {
  const pod = {
    metadata: { name: 'api', creationTimestamp: ago(3600 * 1000) },
    spec: { containers: [{ name: 'api' }] },
    status: {
      phase: 'Running',
      containerStatuses: [
        { name: 'api', ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } },
      ],
    },
  };
  assert.equal(kube.podStatus(pod), 'CrashLoopBackOff');
  assert.equal(kube.health(kube.podStatus(pod)), 'bad');
});

test('a pod being deleted is Terminating, whatever its phase claims', () => {
  const pod = {
    metadata: { name: 'api', deletionTimestamp: ago(2000) },
    status: { phase: 'Running', containerStatuses: [{ ready: true, state: { running: {} } }] },
  };
  assert.equal(kube.podStatus(pod), 'Terminating');
  assert.equal(kube.health('Terminating'), 'warn');
});

test('an init container that has not finished is named, with its position', () => {
  const waiting = {
    metadata: {},
    status: {
      phase: 'Pending',
      initContainerStatuses: [
        { state: { terminated: { exitCode: 0 } } },
        { state: { waiting: { reason: 'PodInitializing' } } },
      ],
    },
  };
  assert.equal(kube.podStatus(waiting), 'Init:1/2');

  const failing = {
    metadata: {},
    status: {
      phase: 'Pending',
      initContainerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }],
    },
  };
  assert.equal(kube.podStatus(failing), 'Init:ImagePullBackOff');
  assert.equal(kube.health(kube.podStatus(failing)), 'bad');
});

test('a completed sidecar does not make a running pod look finished', () => {
  const pod = {
    metadata: {},
    status: {
      phase: 'Running',
      containerStatuses: [
        { name: 'main', ready: true, state: { running: {} } },
        { name: 'done', ready: false, state: { terminated: { reason: 'Completed', exitCode: 0 } } },
      ],
    },
  };
  assert.equal(kube.podStatus(pod), 'Running');
});

test('a pod row counts what is ready, and when it last restarted', () => {
  const { rows } = kube.table('Pod', {
    items: [
      {
        kind: 'Pod',
        metadata: { name: 'web', namespace: 'prod', uid: 'u1', creationTimestamp: ago(86400 * 1000) },
        spec: { nodeName: 'node-1', containers: [{ name: 'web', ports: [{ containerPort: 8080 }] }, { name: 'sidecar' }] },
        status: {
          phase: 'Running',
          podIP: '10.0.0.9',
          containerStatuses: [
            { name: 'web', ready: true, restartCount: 2, state: { running: {} }, lastState: { terminated: { finishedAt: ago(600 * 1000) } } },
            { name: 'sidecar', ready: false, restartCount: 1, state: { running: {} } },
          ],
        },
      },
    ],
  }, NOW);

  assert.equal(rows[0].ready, '1/2');
  assert.equal(rows[0].restarts, 3);
  assert.equal(rows[0].restartNote, '10m ago');
  assert.equal(rows[0].node, 'node-1');
  assert.deepEqual(rows[0].forwardable, [8080]);
});

test('a deployment scaled to zero is idle, not broken', () => {
  const { rows, columns } = kube.table('Deployment', {
    items: [
      {
        kind: 'Deployment',
        metadata: { name: 'batch', namespace: 'dev', creationTimestamp: ago(86400 * 1000) },
        spec: { replicas: 0 },
        status: {},
      },
    ],
  }, NOW);
  assert.equal(rows[0].status, 'Scaled to zero');
  assert.equal(rows[0].health, 'idle');
  assert.equal(rows[0].ready, '0/0');
  assert.ok(columns.includes('upToDate'));
});

test('a node that is cordoned is a warning, one that is not ready is a fault', () => {
  const shape = (conditions, unschedulable) =>
    kube.table('Node', {
      items: [{ kind: 'Node', metadata: { name: 'n', creationTimestamp: ago(86400 * 1000), labels: { 'node-role.kubernetes.io/control-plane': '' } }, spec: { unschedulable }, status: { conditions, nodeInfo: { kubeletVersion: 'v1.30.1' } } }],
    }, NOW).rows[0];

  const ok = shape([{ type: 'Ready', status: 'True' }], false);
  assert.equal(ok.status, 'Ready');
  assert.equal(ok.health, 'ok');
  assert.equal(ok.roles, 'control-plane');

  const cordoned = shape([{ type: 'Ready', status: 'True' }], true);
  assert.equal(cordoned.status, 'Ready,SchedulingDisabled');
  assert.equal(cordoned.health, 'warn');

  const down = shape([{ type: 'Ready', status: 'False' }], false);
  assert.equal(down.status, 'NotReady');
  assert.equal(down.health, 'bad');
});

test('a custom resource is read by its Ready condition, whatever it is', () => {
  const { rows, columns } = kube.table('Certificate', {
    items: [
      {
        kind: 'Certificate',
        metadata: { name: 'tls', namespace: 'web', creationTimestamp: ago(86400 * 1000) },
        status: { conditions: [{ type: 'Ready', status: 'False', reason: 'Issuing', message: 'waiting on the order' }] },
      },
    ],
  }, NOW);
  assert.deepEqual(columns, ['name', 'namespace', 'status', 'age']);
  assert.equal(rows[0].status, 'Issuing');
  assert.equal(rows[0].health, 'bad');
  assert.equal(rows[0].message, 'waiting on the order');
});

test('a list says what it is a list of, because kubectl does not', () => {
  // `kubectl get pods -o json` answers `kind: "List"`. Only the items know.
  assert.equal(kube.kindOf({ kind: 'List', items: [{ kind: 'Pod' }] }), 'Pod');
  assert.equal(kube.kindOf({ kind: 'PodList', items: [] }), 'Pod');
  assert.equal(kube.kindOf({ kind: 'List', items: [] }), null);
});

test('api-resources is read by column, not by splitting on spaces', () => {
  // SHORTNAMES and CATEGORIES are routinely empty; a positional split gets
  // every later column wrong the moment one of them is.
  const text = [
    'NAME                    SHORTNAMES   APIVERSION                             NAMESPACED   KIND                  VERBS',
    'configmaps              cm           v1                                     true         ConfigMap             [get list]',
    'certificates                         cert-manager.io/v1                     true         Certificate           [get list]',
    'storageclasses          sc           storage.k8s.io/v1                      false        StorageClass          [get list]',
  ].join('\n');

  const rows = kube.apiResources(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    name: 'configmaps', kind: 'ConfigMap', apiVersion: 'v1', namespaced: true,
    short: ['cm'], group: '', builtIn: true,
  });
  assert.equal(rows[1].kind, 'Certificate');
  assert.deepEqual(rows[1].short, []);
  assert.equal(rows[1].group, 'cert-manager.io');
  assert.equal(rows[1].builtIn, false, 'somebody else’s operator is not a core group');
  assert.equal(rows[2].namespaced, false);
  assert.equal(rows[2].builtIn, true, 'anything under k8s.io ships with kubernetes');
});

test('kubeconfig is read without touching a cluster', () => {
  const { contexts, current } = kube.contextsFrom({
    'current-context': 'prod',
    contexts: [
      { name: 'prod', context: { cluster: 'c1', user: 'u1', namespace: 'live' } },
      { name: 'dev', context: { cluster: 'c2', user: 'u2' } },
    ],
  });
  assert.equal(current, 'prod');
  assert.equal(contexts[0].namespace, 'live');
  assert.equal(contexts[1].namespace, 'default', 'a context with no namespace means default');
});

test('kubectl top is read by heading, because pods and nodes do not match', () => {
  const scoped = kube.metrics(['NAMESPACE   NAME   CPU(cores)   MEMORY(bytes)', 'prod        web    12m          140Mi'].join('\n'));
  assert.deepEqual(scoped['prod/web'], { cpu: '12m', memory: '140Mi' });

  const pods = kube.metrics(['NAME   CPU(cores)   MEMORY(bytes)', 'web    12m          140Mi'].join('\n'));
  assert.deepEqual(pods['/web'], { cpu: '12m', memory: '140Mi' });

  // A node has a CPU% column between the two. Reading the third field as memory
  // reports 5% as this node's memory use — a plausible-looking wrong number.
  const nodes = kube.metrics(
    ['NAME     CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%', 'node-1   210m         5%     3000Mi          19%'].join('\n'),
  );
  assert.deepEqual(nodes['/node-1'], { cpu: '210m', memory: '3000Mi' });

  assert.deepEqual(kube.metrics(''), {});
});

test('the overview counts what is wrong, not what exists', () => {
  const out = kube.overview({
    nodes: [{ name: 'a', health: 'ok' }, { name: 'b', health: 'bad', status: 'NotReady' }],
    pods: [
      { name: 'p1', namespace: 'x', health: 'ok', restarts: 0 },
      { name: 'p2', namespace: 'x', health: 'bad', status: 'CrashLoopBackOff', restarts: 9 },
    ],
    events: [{ type: 'Warning' }],
  });
  assert.equal(out.nodes, 2);
  assert.equal(out.nodesUnhealthy, 1);
  assert.equal(out.podsFailing, 1);
  assert.equal(out.restarts, 9);
  assert.equal(out.warnings, 1);
  assert.deepEqual(out.trouble.map((row) => row.name), ['b', 'p2']);
});

test('removing a cluster takes only what nothing else is pointing at', () => {
  // Two contexts into one cluster with two different logins: removing the
  // admin one must not take the cluster entry the read-only one still needs.
  const config = {
    contexts: [
      { name: 'prod-admin', context: { cluster: 'prod', user: 'admin' } },
      { name: 'prod-ro', context: { cluster: 'prod', user: 'readonly' } },
      { name: 'scratch', context: { cluster: 'kind', user: 'kind-user' } },
    ],
  };

  assert.deepEqual(kube.whatToRemove(config, 'prod-admin'), {
    context: 'prod-admin',
    cluster: null,
    user: 'admin',
    keptFor: ['prod-ro'],
  });

  // Nothing else refers to either, so both go with it.
  assert.deepEqual(kube.whatToRemove(config, 'scratch'), {
    context: 'scratch',
    cluster: 'kind',
    user: 'kind-user',
    keptFor: [],
  });

  assert.equal(kube.whatToRemove(config, 'not-there'), null);
});

/*
 * Argument building. Nothing here spawns anything — which is the point: the two
 * ways this can be wrong are a name that turns into a flag and a flag in the
 * wrong place, and both are visible in the array before it is ever run.
 */
test('a name that would become a flag is refused', () => {
  assert.throws(() => kube.safeArg('--all-namespaces', 'the name'), /cannot start with/);
  assert.throws(() => kube.safeArg('', 'the name'), /missing/);
  // An EKS context is an ARN, and a name is a DNS label. Both are fine.
  assert.equal(kube.safeArg('arn:aws:eks:sa-east-1:1:cluster/k8s', 'the context'), 'arn:aws:eks:sa-east-1:1:cluster/k8s');
  assert.equal(kube.safeArg('web-7d9f', 'the name'), 'web-7d9f');
});

test('--all-namespaces goes after the subcommand, and --context before it', () => {
  // kubectl reads an unknown leading flag as a plugin name: `--all-namespaces`
  // in front produces "flags cannot be placed before plugin name".
  const before = kube.scope({ context: 'prod', namespace: 'web', allNamespaces: true });
  assert.deepEqual(before, ['--request-timeout', '20s', '--context', 'prod']);
  assert.deepEqual(kube.everywhere({ allNamespaces: true }), ['--all-namespaces']);
  assert.deepEqual(kube.everywhere({}), []);

  const scoped = kube.scope({ context: 'prod', namespace: 'web' });
  assert.deepEqual(scoped, ['--request-timeout', '20s', '--context', 'prod', '--namespace', 'web']);
});

test('the two commands that are meant to go on carry no request timeout', () => {
  /*
   * A request timeout on a streaming command is a countdown, not a safety net:
   * kubectl closes the connection when it expires, so a followed log stopped
   * after twenty seconds and a forwarded port went dead at the same moment —
   * both silently, and both looking like the cluster had done it.
   */
  const follow = kube.followArgs({ context: 'prod', namespace: 'web', pod: 'api-1', container: 'api', tail: 50 });
  assert.deepEqual(follow, ['--context', 'prod', '--namespace', 'web', 'logs', 'api-1', '--follow', '--tail=50', '-c', 'api']);
  assert.ok(!follow.includes('--request-timeout'));

  const forward = kube.forwardArgs({ context: 'prod', namespace: 'web', kind: 'service', name: 'api', local: 8080, remote: 80 });
  assert.deepEqual(forward, ['--context', 'prod', '--namespace', 'web', 'port-forward', 'service/api', '8080:80']);
  assert.ok(!forward.includes('--request-timeout'));

  // Everything that is a question rather than a stream still has one.
  assert.ok(kube.scope({ context: 'prod' }).includes('--request-timeout'));

  assert.throws(() => kube.forwardArgs({ name: 'api', remote: 0 }), /port to forward to/);
  assert.throws(() => kube.forwardArgs({ name: '-rf', local: 1, remote: 2 }), /cannot start with/);
});

test('the port a forward actually got is read from what kubectl says', () => {
  assert.equal(kube.forwardedPort('Forwarding from 127.0.0.1:54123 -> 8080'), 54123);
  assert.equal(kube.forwardedPort('Forwarding from [::1]:54123 -> 8080'), 54123);
  assert.equal(kube.forwardedPort('bind: address already in use'), null);
});

test('kubectl not being installed says so, rather than talking about spawn', () => {
  assert.match(kube.cleanError('', { code: 'ENOENT' }), /not installed/);
  assert.equal(kube.cleanError('error: You must be logged in to the server\n', {}), 'You must be logged in to the server');
  assert.match(kube.cleanError('', { killed: true }), /did not answer within/);
});

test('the client library’s retry logging is not the error message', () => {
  // A cluster nobody can reach answers with four klog lines before the sentence
  // a person can act on. The sentence is the whole of what is worth showing.
  const noisy = [
    'E0907 12:14:29.532977   37753 memcache.go:265] "Unhandled Error" err="couldn\'t get current server API group list"',
    'W0907 12:14:29.533111   37753 shortcut.go:100] falling back',
    'The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?',
  ].join('\n');
  assert.equal(
    kube.cleanError(noisy, {}),
    'The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?',
  );

  // When klog is all there is, its prefixes go and its words stay.
  assert.equal(
    kube.cleanError('E0907 12:14:29.532977   37753 memcache.go:265] the API server is unreachable', {}),
    'the API server is unreachable',
  );
});

test('a cluster that did not answer is not a cluster that said no', () => {
  // The regex that decides which. Getting this wrong paints a healthy
  // production cluster red because an auth plugin took a moment.
  const timedOut = [
    'Unable to connect to the server: context deadline exceeded',
    'Unable to connect to the server: net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
    'dial tcp 10.0.0.1:443: i/o timeout',
  ];
  const said = [
    'The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?',
    'You must be logged in to the server (Unauthorized)',
    'Failed to fetch credentials for cluster "abc"',
  ];
  const slow = (text) => /deadline exceeded|Client\.Timeout|did not answer within|i\/o timeout/i.test(text);
  for (const text of timedOut) assert.ok(slow(text), `should read as slow: ${text}`);
  for (const text of said) assert.ok(!slow(text), `should read as a refusal: ${text}`);
});

test('a stream is stoppable, and stopping one that is gone is not an error', () => {
  const streams = new kube.Streams();
  assert.equal(streams.stop('nothing'), false);
  assert.equal(streams.size, 0);
  streams.stopAll();
});
