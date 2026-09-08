'use strict';

/**
 * The patch a form builds is the dangerous part of it.
 *
 * A form that shows the wrong number is a nuisance. A form that sends the wrong
 * patch changes a production workload into something nobody asked for — so what
 * is tested here is not the drawing, it is what leaves: that only what somebody
 * edited appears in the patch, that emptying a field removes the field rather
 * than setting it to the empty string, that a variable the person deleted is
 * spelled out as a deletion because a merge would otherwise leave it, and that
 * a container nobody touched is not mentioned at all.
 *
 * The functions are extracted from the panel as it ships, for the same reason
 * the colouring test does it: a copy in the test would be a copy that drifts.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function panelConfigure() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'kubernetes', 'panel.html'), 'utf8');
  const source = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const wanted = ['assign', 'templatePath', 'dig', 'envSource', 'configOf', 'copyOf', 'same',
    'configChanges', 'configPatch', 'deepen'];

  const starts = wanted.map((name) => {
    const at = source.search(new RegExp(`\\n  (?:var|function) ${name}\\b`));
    assert.ok(at >= 0, `the panel no longer defines ${name}`);
    return { name, at };
  });
  // Each piece ends where the next declaration begins — any next one, or the
  // whole panel comes along behind the last of them.
  const boundary = /\n  (?:var|function) [A-Za-z_$]/g;
  const pieces = starts.map((piece) => {
    boundary.lastIndex = piece.at + 1;
    const next = boundary.exec(source);
    return source.slice(piece.at, next ? next.index : source.length).trimEnd();
  });

  const context = vm.createContext({});
  vm.runInContext(
    `${pieces.join('\n')}\nglobalThis.out = { configOf, configChanges, configPatch, copyOf, templatePath };`,
    context,
  );
  return context.out;
}

const panel = panelConfigure();

/** A deployment shaped like the ones a cluster actually holds. */
function deployment() {
  return {
    spec: {
      replicas: 2,
      template: {
        spec: {
          containers: [
            {
              name: 'api',
              image: 'registry/api:1.0.0',
              resources: { requests: { cpu: '100m', memory: '512Mi' }, limits: { cpu: '1', memory: '1Gi' } },
              env: [
                { name: 'LOG_LEVEL', value: 'info' },
                { name: 'SECRET', valueFrom: { secretKeyRef: { name: 'creds', key: 'token' } } },
                { name: 'GONE', value: 'yes' },
              ],
            },
            { name: 'sidecar', image: 'registry/sidecar:2', resources: {}, env: [] },
          ],
          initContainers: [{ name: 'migrate', image: 'registry/migrate:1', resources: {}, env: [] }],
        },
      },
    },
  };
}

function drafted(change) {
  const live = panel.configOf(deployment(), 'Deployment');
  const draft = panel.copyOf(live);
  change(draft);
  return { kind: 'Deployment', live, draft };
}

test('reads what a form can honestly offer, and nothing else', () => {
  const live = panel.configOf(deployment(), 'Deployment');
  assert.equal(live.replicas, 2);
  assert.deepEqual(live.containers.map((c) => c.name), ['api', 'sidecar', 'migrate']);
  assert.equal(live.containers[2].init, true);
  assert.equal(live.containers[0].limits.memory, '1Gi');
  assert.equal(live.containers[0].env[1].from, 'secret creds · token');
});

test('a workload nobody edited produces no patch at all', () => {
  const config = drafted(() => {});
  assert.deepEqual(panel.configChanges(config), []);
  assert.deepEqual(panel.configPatch(config), {});
});

test('only the container that changed is named', () => {
  const config = drafted((draft) => { draft.containers[0].image = 'registry/api:1.1.0'; });
  const patch = panel.configPatch(config);
  const containers = patch.spec.template.spec.containers;
  assert.equal(containers.length, 1);
  assert.deepEqual(containers[0], { image: 'registry/api:1.1.0', name: 'api' });
  assert.equal(patch.spec.replicas, undefined);
  assert.equal(patch.spec.template.spec.initContainers, undefined);
});

test('an emptied limit is removed rather than set to nothing', () => {
  const config = drafted((draft) => { draft.containers[0].limits.cpu = ''; });
  const container = panel.configPatch(config).spec.template.spec.containers[0];
  assert.deepEqual(container.resources, { limits: { cpu: null } });
  assert.deepEqual(panel.configChanges(config), ['cpu limit of api: 1 → none']);
});

test('a deleted variable is spelled out, because merging would keep it', () => {
  const config = drafted((draft) => {
    draft.containers[0].env = draft.containers[0].env.filter((entry) => entry.name !== 'GONE');
  });
  const container = panel.configPatch(config).spec.template.spec.containers[0];
  assert.deepEqual(container.env, [{ name: 'GONE', $patch: 'delete' }]);
});

test('a variable that comes from a secret is never sent as a value', () => {
  const config = drafted((draft) => { draft.containers[0].image = 'registry/api:2'; });
  const container = panel.configPatch(config).spec.template.spec.containers[0];
  assert.equal(container.env, undefined);
});

test('a new variable is added, and an init container patches its own list', () => {
  const config = drafted((draft) => {
    draft.containers[0].env.push({ name: 'NEW', value: 'yes', from: null });
    draft.containers[2].image = 'registry/migrate:2';
  });
  const pod = panel.configPatch(config).spec.template.spec;
  assert.deepEqual(pod.containers[0].env, [{ name: 'NEW', value: 'yes' }]);
  assert.deepEqual(pod.initContainers, [{ image: 'registry/migrate:2', name: 'migrate' }]);
});

test('replicas travel at the top, where they live', () => {
  const config = drafted((draft) => { draft.replicas = 0; });
  assert.deepEqual(panel.configPatch(config), { spec: { replicas: 0 } });
  assert.deepEqual(panel.configChanges(config), ['replicas: 2 → 0']);
});

test('a cron job keeps its template one level deeper', () => {
  const cron = {
    spec: {
      jobTemplate: {
        spec: { template: { spec: { containers: [{ name: 'run', image: 'registry/run:1', resources: {}, env: [] }] } } },
      },
    },
  };
  const live = panel.configOf(cron, 'CronJob');
  assert.equal(live.replicas, null, 'a cron job has no replicas to offer');
  const draft = panel.copyOf(live);
  draft.containers[0].image = 'registry/run:2';
  const patch = panel.configPatch({ kind: 'CronJob', live, draft });
  assert.deepEqual(patch.spec.jobTemplate.spec.template.spec.containers, [{ image: 'registry/run:2', name: 'run' }]);
});

test('a daemon set offers no replicas, because it has as many as there are nodes', () => {
  const live = panel.configOf({ spec: { template: { spec: { containers: [] } } } }, 'DaemonSet');
  assert.equal(live.replicas, null);
});
