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
 * Maven and Gradle. Reading is free; the one thing that is not a read opens a
 * terminal, and the command in it is written here from named parts.
 */
test('the build verbs route to the reader, and run goes to the app', () => {
  assert.equal(H.route('build.root'), 'build');
  assert.equal(H.route('build.project'), 'build');
  assert.equal(H.route('build.tasks'), 'build');
  assert.equal(H.route('build.dependencies'), 'build');
  assert.equal(H.route('build.run'), 'app');
  assert.equal(H.route('build.exec'), null, 'there is no verb that runs a line of the panel’s choosing');
  assert.equal(H.route('build.write'), null, 'a build panel changes nothing on disk');
  assert.equal(H.route('build.'), null);
});

test('buildCommand writes the Maven line in the module, with the wrapper when there is one', () => {
  const run = H.buildCommand({
    tool: 'maven',
    root: '/p/shop',
    wrapper: true,
    dir: '/p/shop/core',
    goals: ['clean', 'install'],
    profiles: ['dev', 'fast'],
    skipTests: true,
    offline: true,
    extra: ['-Dtest=Foo*', '-X'],
  });
  assert.equal(run.command, "'/p/shop/mvnw' -o -Pdev,fast clean install -DskipTests '-Dtest=Foo*' -X");
  assert.equal(run.cwd, '/p/shop/core', 'in the module, the way IntelliJ runs it');
  assert.equal(run.title, 'mvn clean install');

  const plain = H.buildCommand({ tool: 'maven', root: '/p/shop', goals: ['compiler:compile'] });
  assert.equal(plain.command, 'mvn compiler:compile');
  assert.equal(plain.cwd, '/p/shop');
});

test('buildCommand writes the Gradle line at the root, with task paths as given', () => {
  const run = H.buildCommand({
    tool: 'gradle',
    root: '/p/shop',
    wrapper: true,
    goals: [':app:build'],
    skipTests: true,
    offline: true,
  });
  assert.equal(run.command, './gradlew --offline :app:build -x test');
  assert.equal(run.cwd, '/p/shop');
  assert.equal(run.title, 'gradle build');
  assert.equal(H.buildCommand({ tool: 'gradle', root: '/p/shop', goals: ['test'] }).command, 'gradle test');
});

test('buildCommand refuses a word a shell would read as anything else, and a module outside the project', () => {
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p', goals: ["install'; rm -rf ~"] }), /quote/);
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p', goals: [] }), /Nothing to run/);
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p', dir: '/etc', goals: ['install'] }), /not inside/);
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p', dir: '/pwned', goals: ['install'] }), /not inside/);
  // `..` is folded before the question is asked: `/p/shop/../../etc` starts
  // with `/p/shop/` and is `/etc`.
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p/shop', dir: '/p/shop/../../etc', goals: ['install'] }), /not inside/);
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p/shop', dir: '/p/shop/core/../../.ssh', goals: ['x'] }), /not inside/);
  assert.equal(H.buildCommand({ tool: 'maven', root: '/p/shop', dir: '/p/shop/./core/', goals: ['x'] }).cwd, '/p/shop/core');
  assert.equal(H.buildCommand({ tool: 'maven', root: '/p/shop/', dir: '/p/shop/core', goals: ['x'] }).cwd, '/p/shop/core', 'a trailing slash on the root is not a different root');
  assert.throws(() => H.buildCommand({ tool: 'npm', root: '/p', goals: ['x'] }), /not a build tool/);
  // A space or a dollar is quoted, not refused: `-Dexec.args="a b"` is a real thing to type.
  const spaced = H.buildCommand({ tool: 'maven', root: '/p', goals: ['exec:java'], extra: ['-Dexec.args=a b'] });
  assert.equal(spaced.command, "mvn exec:java '-Dexec.args=a b'");
  // zsh's `=cmd` expansion: quoted, and therefore text.
  assert.equal(H.buildCommand({ tool: 'maven', root: '/p', goals: ['x'], extra: ['=ls'] }).command, "mvn x '=ls'");
});

test('buildCommand lets through the flags that change how a build runs, and refuses the ones that change what it builds', () => {
  const ok = (tool, extra) => H.buildCommand({ tool, root: '/p', goals: ['x'], extra }).command;
  assert.equal(ok('maven', ['-pl', ':app', '-am', '-T', '4', '-Dspring.profiles.active=dev', '-Pprod,fast', '-U', '-X']), 'mvn x -pl :app -am -T 4 -Dspring.profiles.active=dev -Pprod,fast -U -X');
  assert.equal(ok('gradle', ['-x', 'test', '--tests', 'com.acme.FooTest', '--info', '--stacktrace', '-Pfoo=bar', '--rerun-tasks']), 'gradle x -x test --tests com.acme.FooTest --info --stacktrace -Pfoo=bar --rerun-tasks');

  const no = (tool, extra) => assert.throws(() => H.buildCommand({ tool, root: '/p', goals: ['x'], extra }), /not a flag a panel may pass/, extra.join(' '));
  no('maven', ['-f', '/etc/evil/pom.xml']);
  no('maven', ['--file', 'other.xml']);
  no('maven', ['-s', '/tmp/settings.xml']);
  no('maven', ['-gs', 'x']);
  no('maven', ['-t', 'toolchains.xml']);
  no('maven', ['-l', '/tmp/log']);
  no('gradle', ['--init-script', '/tmp/evil.gradle']);
  no('gradle', ['-I', 'x']);
  no('gradle', ['-b', 'other.gradle']);
  no('gradle', ['-p', '/other']);
  no('gradle', ['--project-dir', '/other']);
  no('gradle', ['-g', '/tmp/gradle-home']);
  no('gradle', ['-t', 'x', '-c', 'settings.gradle']);
  // The same letter is a different flag per tool.
  no('maven', ['-i']);
  no('gradle', ['-pl', ':app']);
  // System properties are fine, unless they relocate the build.
  no('maven', ['-Dmaven.repo.local=/tmp/x']);
  no('gradle', ['-Dorg.gradle.java.home=/x']);
  no('gradle', ['-Dorg.gradle.jvmargs=-javaagent:x.jar']);
  no('maven', ['-Duser.home=/x']);
  // A flag that wants a value does not take a flag as one.
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p', goals: ['x'], extra: ['-pl', '-am'] }), /needs a value/);
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p', goals: ['x'], extra: ['-pl'] }), /needs a value/);
  // Flags in the goals list are checked like flags anywhere.
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p', goals: ['-f', 'x'] }), /not a flag/);
  // A profile is an id (`!dev` deactivates one); anything a shell could read is not one.
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p', goals: ['x'], profiles: ['a b'] }), /not a profile/);
  assert.throws(() => H.buildCommand({ tool: 'maven', root: '/p', goals: ['x'], profiles: ['x;rm'] }), /not a profile/);
  assert.equal(H.buildCommand({ tool: 'maven', root: '/p', goals: ['x'], profiles: ['!dev', 'ci'] }).command, "mvn '-P!dev,ci' x", 'a `!` would be a history expansion to zsh');
  assert.equal(H.buildCommand({ tool: 'maven', root: '/p', goals: ['x'], profiles: ['dev'] }).command, 'mvn -Pdev x');
});

test('deploying and publishing stop to ask; everything else in a build runs', () => {
  assert.match(H.needsConsent('build.run', { goals: ['clean', 'deploy'] }), /publishes the artifact/);
  assert.match(H.needsConsent('build.run', { goals: ['release:perform'] }), /publishes/);
  assert.match(H.needsConsent('build.run', { goals: [':lib:publish'] }), /publishes/);
  assert.match(H.needsConsent('build.run', { goals: ['publishAllPublicationsToGitHubRepository'] }), /publishes/);
  assert.equal(H.needsConsent('build.run', { goals: ['publishToMavenLocal'] }), null, 'local is local');
  assert.equal(H.needsConsent('build.run', { goals: ['publishMavenPublicationToMavenLocal'] }), null);
  assert.equal(H.needsConsent('build.run', { goals: ['clean', 'install'] }), null);
  assert.equal(H.needsConsent('build.run', { goals: ['spring-boot:run'] }), null);
  assert.equal(H.needsConsent('build.project', {}), null);
  assert.equal(H.needsConsent('build.run', undefined), null);
  // What is typed into the box is on the line too.
  assert.match(H.needsConsent('build.run', { goals: ['clean'], extra: ['deploy'] }), /publishes/);
  // An execution id is not part of the name; fully-qualified goals are goals.
  assert.match(H.needsConsent('build.run', { goals: ['deploy@release'] }), /publishes/);
  assert.match(H.needsConsent('build.run', { goals: ['org.apache.maven.plugins:maven-deploy-plugin:3.1.1:deploy'] }), /publishes/);
  assert.match(H.needsConsent('build.run', { goals: ['site:deploy'] }), /publishes/);
  assert.match(H.needsConsent('build.run', { goals: ['docker:push'] }), /publishes/);
  assert.match(H.needsConsent('build.run', { goals: ['jib:build'] }), /publishes/);
  assert.equal(H.needsConsent('build.run', { goals: ['jib:dockerBuild'] }), null, 'a local image is local');
  assert.match(H.needsConsent('build.run', { goals: ['nexus-staging:release'] }), /publishes/);
});

test('normalisePath folds dots and doubled slashes', () => {
  assert.equal(H.normalisePath('/p/shop/../../etc'), '/etc');
  assert.equal(H.normalisePath('/p/shop/./core//'), '/p/shop/core');
  assert.equal(H.normalisePath('/../x'), '/x');
  assert.equal(H.normalisePath('/'), '/');
});
