const test = require('node:test');
const assert = require('node:assert/strict');
const { editableYaml, eventsAbout } = require('../electron/kube-edit');

const PRINTED = [
  'apiVersion: apps/v1',
  'kind: Deployment',
  'metadata:',
  '  annotations:',
  '    deployment.kubernetes.io/revision: "7"',
  '    kubectl.kubernetes.io/last-applied-configuration: |',
  '      {"apiVersion":"apps/v1","kind":"Deployment","status":{}}',
  '    team: shop',
  '  creationTimestamp: "2026-01-02T03:04:05Z"',
  '  generation: 12',
  '  labels:',
  '    app: web',
  '  managedFields:',
  '  - apiVersion: apps/v1',
  '    manager: kubectl',
  '  name: web',
  '  namespace: shop',
  '  resourceVersion: "991"',
  '  uid: 1f0c',
  'spec:',
  '  replicas: 3',
  '  template:',
  '    metadata:',
  '      creationTimestamp: null',
  '      annotations:',
  '        uid: keep-me',
  '    spec:',
  '      containers:',
  '      - name: web',
  '        args:',
  '        - |',
  '          status: this is text, not the status',
  '',
  '          uid: nor is this',
  'status:',
  '  readyReplicas: 3',
  '  conditions:',
  '  - type: Available',
  '',
].join('\n');

test('what is edited is the manifest somebody would have written', () => {
  const text = editableYaml(PRINTED);
  // The cluster's own fields are gone…
  for (const gone of ['resourceVersion', 'managedFields', 'manager: kubectl', 'generation: 12', 'readyReplicas',
    'last-applied-configuration', 'deployment.kubernetes.io/revision', 'type: Available', '  uid: 1f0c']) {
    assert.ok(!text.includes(gone), `${gone} should not be in the editor`);
  }
  // …and nothing a person wrote went with them, however much it looks like one.
  for (const kept of ['    team: shop', '  name: web', '  namespace: shop', '    app: web', '  replicas: 3',
    '      creationTimestamp: null', '        uid: keep-me', '          status: this is text, not the status', '          uid: nor is this']) {
    assert.ok(text.includes(kept), `${kept} should still be there`);
  }
  assert.ok(text.includes('  annotations:\n    team: shop'));
  // Doing it twice changes nothing: the text is compared with itself later to notice a change in the cluster.
  assert.equal(editableYaml(text), text);
});

test('annotations that held only the cluster\'s own do not stay behind as an empty key', () => {
  const text = editableYaml('kind: ConfigMap\nmetadata:\n  annotations:\n    deployment.kubernetes.io/revision: "1"\n  name: a\ndata:\n  status: fine\n');
  assert.equal(text, 'kind: ConfigMap\nmetadata:\n  name: a\ndata:\n  status: fine\n');
});

test('a workload\'s events include those of what it made, and say they were found by name', () => {
  const rows = [
    { uid: '1', objectKind: 'Deployment', objectName: 'web' },
    { uid: '2', objectKind: 'Pod', objectName: 'web-7d9f-abc12' },
    { uid: '3', objectKind: 'Pod', objectName: 'webhook-1' },
    { uid: '4', objectKind: 'Deployment', objectName: 'web-admin' },
    { uid: '5', objectKind: 'ReplicaSet', objectName: 'web-7d9f' },
    { uid: '6', objectKind: 'Node', objectName: 'web-node' },
    { uid: '7', objectKind: 'HorizontalPodAutoscaler', objectName: 'web' },
    { uid: '8', objectKind: 'HorizontalPodAutoscaler', objectName: 'web-admin' },
  ];
  const about = eventsAbout(rows, 'Deployment', 'web');
  assert.deepEqual(about.map((row) => row.uid), ['1', '2', '5', '7']);
  assert.equal(about[0].related, undefined);
  assert.equal(about[1].related, true);
});
