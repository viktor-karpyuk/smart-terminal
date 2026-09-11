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
  assert.equal(H.route('spring.projects'), 'spring');
  assert.equal(H.route('spring.start'), 'spring');
  assert.equal(H.route('spring.stop'), 'spring');
  assert.equal(H.route('spring.actuator'), 'spring');
  assert.equal(H.route('spring.shell'), 'app');
  assert.equal(H.route('spring.ask'), 'app');
  assert.equal(H.route('spring.debugger'), 'app');
  assert.equal(H.route('spring.exec'), null, 'a Spring panel cannot run a command of its own either');
  assert.equal(H.route('spring.'), null);

  assert.equal(H.route('kube.exec'), null, 'there is no verb that runs a command of the extension’s choosing');
  // Drain arrived once it could be watched: it is a stream, because the whole
  // point is seeing it stop against a disruption budget.
  assert.equal(H.route('kube.drain'), 'kube-stream');
  assert.equal(H.route('kube.edit'), null, 'there is no verb that opens an editor of its own');
  assert.equal(H.route('kube.patch'), null);
  assert.equal(H.route('kube.'), null);
  assert.equal(H.route('list'), null, 'a bare list would not say which subsystem it means');
  assert.equal(H.route('eval'), null);
  assert.equal(H.route('__proto__'), null);
  assert.equal(H.route('toString'), null, 'the table is a Map, so nothing inherited is callable');
  assert.equal(H.allowed('kube.logs'), true);
  assert.equal(H.allowed('rm'), false);

  // Helm is a different tool and gets a different door.
  assert.equal(H.route('helm.releases'), 'helm');
  assert.equal(H.route('helm.rollback'), 'helm');
  assert.equal(H.route('helm.install'), null, 'installing a chart is not something a panel may do');
  assert.equal(H.route('helm.upgrade'), null);
  assert.equal(H.route('helm.'), null);
});

test('rolling a release back says what goes with it', () => {
  const back = H.needsConsent('helm.rollback', { name: 'jenkins', revision: 24, namespace: 'jenkins', context: 'live' });
  assert.match(back, /Roll jenkins back to revision 24 in namespace jenkins on live/);
  assert.match(back, /Everything changed since that revision goes with it/);

  assert.match(H.needsConsent('helm.uninstall', { name: 'redis', namespace: 'dev' }), /Uninstall redis in namespace dev/);
  assert.equal(H.needsConsent('helm.history', { name: 'jenkins' }), null);
  assert.equal(H.needsConsent('helm.values', { name: 'jenkins' }), null);
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
  // A dry run is a question: the server validates it and throws it away.
  assert.equal(H.needsConsent('kube.apply', { namespace: 'prod', dryRun: true }), null);

  /*
   * When something else owns the object, the question says so. Editing a
   * Helm-installed resource by hand works, and then the next upgrade puts it
   * back — which is a confusing afternoon if nobody mentioned it.
   */
  const owned = H.needsConsent('kube.apply', {
    namespace: 'argocd',
    yaml: 'metadata:\n  annotations:\n    meta.helm.sh/release-name: argocd\n',
  });
  assert.match(owned, /Helm installed this, as part of the release "argocd"/);
  assert.match(owned, /next upgrade of that release will put it back/);
  assert.ok(!/Helm installed/.test(H.needsConsent('kube.apply', { yaml: 'kind: ConfigMap' }) ?? ''));
  /*
   * A patch says what it will change, because it can. "Apply this manifest?" is
   * a question nobody can answer without reading the manifest; a list of four
   * lines is a question you can actually answer.
   */
  const patched = H.needsConsent('kube.configure', {
    kind: 'Deployment',
    name: 'api',
    namespace: 'prod',
    summary: ['image of api: registry/api:1 → registry/api:2', 'memory limit of api: 1Gi → 2Gi'],
    patch: { spec: { template: {} } },
  });
  assert.match(patched, /Change Deployment api in namespace prod/);
  assert.match(patched, /• image of api: registry\/api:1 → registry\/api:2/);
  assert.match(patched, /• memory limit of api: 1Gi → 2Gi/);
  assert.equal(H.needsConsent('kube.configure', { name: 'api', dryRun: true }), null);
  // Scaling to zero still says what scaling to zero means, whichever form it took.
  assert.match(
    H.needsConsent('kube.configure', { name: 'api', summary: ['replicas: 3 → 0'], patch: { spec: { replicas: 0 } } }),
    /everything it runs stops/,
  );

  assert.match(H.needsConsent('kube.cordon', { name: 'node-1' }), /Stop scheduling/);

  const drain = H.needsConsent('kube.drain', { name: 'ip-10-0-1-2', context: 'live' });
  assert.match(drain, /Move everything off ip-10-0-1-2 on live/);
  assert.match(drain, /disruption budget/);

  // Several at once: the count is the part that is easy to get wrong.
  assert.match(
    H.needsConsent('kube.remove', { kind: 'Pod', count: 7, namespace: 'prod' }),
    /Delete 7 Pods in namespace prod/,
  );
  assert.match(H.needsConsent('kube.remove', { kind: 'Pod', name: 'one', count: 1 }), /Delete Pod one/);
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

/*
 * The graph puts "Rebase onto this" next to "Merge into current". They read
 * alike and one of them replays every commit on the branch under a new hash, so
 * that one is asked about and the other is not.
 */
test('a rebase says what it is about to rewrite; a merge is left alone', () => {
  const asked = H.needsConsent('rebase', { ref: 'origin/main' });
  assert.match(asked, /Rebase the current branch onto origin\/main/);
  assert.match(asked, /replayed as a new one/);
  assert.equal(H.needsConsent('merge', { ref: 'origin/main' }), null);
  assert.equal(H.needsConsent('checkout', { ref: 'main' }), null);
});

/*
 * The terminal a Spring panel opens stands in the application's folder with
 * its JDK first — two named parts, each one word to the shell, and nothing
 * the panel typed.
 */
test('a spring shell is a cd and a JAVA_HOME, quoted', () => {
  assert.equal(H.springShellSetup({ dir: '/w/my app' }), "cd '/w/my app'");
  assert.equal(
    H.springShellSetup({ dir: '/w/app', javaHome: '/jdk/17' }),
    `cd '/w/app' && export JAVA_HOME='/jdk/17' && export PATH="$JAVA_HOME/bin:$PATH"`,
  );
  assert.throws(() => H.springShellSetup({ dir: "/w/it's" }), /quote/);
  assert.throws(() => H.springShellSetup({ dir: '' }), /missing/);
});

test('the debugger terminal is jdb attached to the port the app chose, in the folder, with the sources', () => {
  assert.equal(
    H.jdbCommand({ dir: '/w/app', port: 5005, javaHome: '/jdk/25' }),
    `cd '/w/app' && export JAVA_HOME='/jdk/25' && export PATH="$JAVA_HOME/bin:$PATH" && jdb -attach 5005 -sourcepath 'src/main/java:src/main/kotlin'`,
  );
  assert.equal(H.jdbCommand({ dir: '/w/app', port: 5006 }), `cd '/w/app' && jdb -attach 5006 -sourcepath 'src/main/java:src/main/kotlin'`);
  assert.throws(() => H.jdbCommand({ dir: '/w/app', port: Number('5005; ls') }), /not a port/);
  assert.throws(() => H.jdbCommand({ dir: '/w/app', port: 0 }), /not a port/);
});
