'use strict';

const test = require('node:test');
const assert = require('node:assert');
const H = require('../.test-build/lib/extensionHost');

/*
 * The routing table is the security boundary. Everything an extension is able
 * to do to the app is a name on one of these lists, and anything that is not on
 * one of them has no channel to travel down — there is no default.
 */
test('every call is routed by name, and an unknown name goes nowhere', () => {
  assert.equal(H.route('status'), 'git');
  assert.equal(H.route('commit'), 'git');
  assert.equal(H.route('kube.list'), 'kube');
  assert.equal(H.route('kube.remove'), 'kube');
  assert.equal(H.route('kube.follow'), 'kube-stream');
  assert.equal(H.route('kube.ask'), 'app');
  assert.equal(H.route('kube.shell'), 'app');

  assert.equal(H.route('kube.exec'), null, 'there is no verb that runs a command of the extension’s choosing');
  assert.equal(H.route('kube.drain'), null);
  assert.equal(H.route('kube.'), null);
  assert.equal(H.route('list'), null, 'a bare list would not say which subsystem it means');
  assert.equal(H.route('eval'), null);
  assert.equal(H.route('__proto__'), null);
  assert.equal(H.route('toString'), null, 'the table is a Map, so nothing inherited is callable');
  assert.equal(H.allowed('kube.logs'), true);
  assert.equal(H.allowed('rm'), false);
});

test('the questions asked before changing a cluster name where, not just what', () => {
  const remove = H.needsConsent('kube.remove', { kind: 'Deployment', name: 'api', namespace: 'prod', context: 'live' });
  assert.match(remove, /Delete Deployment api in namespace prod on live/);
  assert.match(remove, /Nothing brings it back/);

  const zero = H.needsConsent('kube.scale', { kind: 'Deployment', name: 'api', namespace: 'prod', replicas: 0 });
  assert.match(zero, /to zero in namespace prod/);
  // Scaling up or down is a normal thing to do and is not worth a dialog.
  assert.equal(H.needsConsent('kube.scale', { name: 'api', replicas: 3 }), null);
  assert.equal(H.needsConsent('kube.restart', { name: 'api' }), null);
  assert.equal(H.needsConsent('kube.list', { kind: 'pods' }), null);

  assert.match(H.needsConsent('kube.apply', { namespace: 'prod' }), /Apply this manifest in namespace prod/);
  assert.match(H.needsConsent('kube.cordon', { name: 'node-1' }), /Stop scheduling/);
  assert.equal(H.needsConsent('kube.cordon', { name: 'node-1', on: false }), null, 'putting a node back is not destructive');

  // The git ones still behave the way they did.
  assert.match(H.needsConsent('push', { force: true }), /Force-push/);
  assert.equal(H.needsConsent('push', {}), null);
});

test('a name that would break out of a shell is refused rather than escaped', () => {
  assert.equal(H.shellQuote('web-7d9f', 'The pod'), "'web-7d9f'");
  assert.equal(H.shellQuote('a b; rm -rf ~', 'The pod'), "'a b; rm -rf ~'");
  assert.throws(() => H.shellQuote("it's", 'The pod'), /contains a quote/);
  assert.throws(() => H.shellQuote('', 'The pod'), /missing/);
});

test('the shell command is built by the app from named parts', () => {
  const line = H.execCommand({
    context: 'arn:aws:eks:sa-east-1:1:cluster/k8s',
    namespace: 'prod',
    pod: 'api-7d9f',
    container: 'api',
  });
  assert.equal(
    line,
    "kubectl --context 'arn:aws:eks:sa-east-1:1:cluster/k8s' --namespace 'prod' exec -it 'api-7d9f' -c 'api' " +
      "-- sh -c 'command -v bash >/dev/null && exec bash || exec sh'",
  );

  // With nothing to scope by, it is still one well-formed command line.
  assert.equal(
    H.execCommand({ pod: 'api' }),
    "kubectl exec -it 'api' -- sh -c 'command -v bash >/dev/null && exec bash || exec sh'",
  );
});

test('a cluster is called what people call it, not what kubeconfig calls it', () => {
  // An EKS context is an ARN and a GKE one is four fields joined by
  // underscores. Neither fits on a tab; the last segment is the name.
  assert.equal(H.shortContext('arn:aws:eks:sa-east-1:532465846520:cluster/kubrik-k8s'), 'kubrik-k8s');
  assert.equal(H.shortContext('gke_my-project_us-central1-a_staging'), 'staging');
  assert.equal(H.shortContext('docker-desktop'), 'docker-desktop');
  assert.equal(H.shortContext(''), '');
  // An ARN with no slash in it is unusual, and is still better than nothing.
  assert.equal(H.shortContext('arn:aws:eks:x'), 'arn:aws:eks:x');
});

test('a kubectl terminal is an alias, so nothing outside the tab changes', () => {
  // Two layers of quoting: single on the outside so the alias is one word,
  // double on the inside so a name with a space in it stays one argument.
  assert.equal(
    H.terminalSetup({ context: 'arn:aws:eks:sa-east-1:1:cluster/k8s', namespace: 'prod' }),
    `alias k='kubectl --context "arn:aws:eks:sa-east-1:1:cluster/k8s" --namespace "prod"'`,
  );
  assert.equal(H.terminalSetup({ context: 'prod' }), `alias k='kubectl --context "prod"'`);
  assert.equal(H.terminalSetup({}), `alias k='kubectl'`);
  // Nothing that a shell would read as an expansion when the alias is used.
  assert.throws(() => H.terminalSetup({ context: 'a$(whoami)' }), /cannot pass to a shell safely/);
});
