'use strict';

/**
 * The parts of the Port Forward panel that decide something, lifted out of the
 * page and run on their own: reading a `kubectl port-forward` line somebody
 * pasted, choosing a local port that will not clash, and which ports get a URL.
 *
 * The panel is one script in one file with no modules, by design — so the
 * functions are cut out of its source by name. A function that is renamed or
 * removed fails here, loudly, rather than passing by testing nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'port-forward', 'panel.html'), 'utf8');
const script = /<script>([\s\S]*)<\/script>/.exec(source)[1];

function cut(name) {
  const found = new RegExp(`\\n  function ${name}\\([\\s\\S]*?\\n  }\\n`).exec(script);
  assert.ok(found, `the panel still has a function called ${name}`);
  return found[0];
}
function value(name) {
  const found = new RegExp(`\\n  var ${name} = [\\s\\S]*?;\\n`).exec(script);
  assert.ok(found, `the panel still has ${name}`);
  return found[0];
}

test('the whole page is one script that parses', () => {
  assert.doesNotThrow(() => new Function(script));
});

const parseKubectl = new Function(`${value('KIND_WORDS')}${cut('parseKubectl')}; return parseKubectl;`)();

test('a kubectl port-forward line is read into the form, however it was written', () => {
  assert.deepEqual(parseKubectl('kubectl port-forward -n mongodb-dev pod/mongodb-0 27517:27017'), {
    ports: [{ local: '27517', remote: '27017' }], namespace: 'mongodb-dev', kind: 'pod', target: 'mongodb-0',
  });
  const full = parseKubectl('kubectl --context "arn:aws:eks:sa-east-1:1:cluster/k" --namespace=erp port-forward --address 0.0.0.0,::1 svc/api 8080:80 9090');
  assert.equal(full.context, 'arn:aws:eks:sa-east-1:1:cluster/k');
  assert.equal(full.namespace, 'erp');
  assert.equal(full.address, '0.0.0.0', 'the first of several addresses');
  assert.deepEqual([full.kind, full.target], ['service', 'api']);
  assert.deepEqual(full.ports, [{ local: '8080', remote: '80' }, { local: '9090', remote: '9090', bare: true }]);
  // The two-word spelling, a bare pod name, and a local port left to the system.
  assert.deepEqual([parseKubectl('k port-forward deploy web 3000').kind, parseKubectl('k port-forward deploy web 3000').target], ['deployment', 'web']);
  assert.equal(parseKubectl('kubectl port-forward mypod :5432').kind, 'pod');
  assert.deepEqual(parseKubectl('kubectl port-forward mypod :5432').ports, [{ local: '', remote: '5432' }]);
  assert.equal(parseKubectl('kubectl port-forward sts/pg 5432 --kubeconfig /tmp/other').target, 'pg', 'a flag it does not use, and its value, are stepped over');
});

test('a line that is not a port-forward, or not a whole one, is not read as one', () => {
  assert.equal(parseKubectl('kubectl get pods'), null);
  assert.equal(parseKubectl('kubectl port-forward svc/x'), null, 'no port');
  assert.equal(parseKubectl('kubectl port-forward 8080:80'), null, 'no target');
  assert.equal(parseKubectl('kubectl port-forward widget/x 80'), null, 'not a kind that can be forwarded to');
  assert.equal(parseKubectl(''), null);
});

test('the local port suggested is the one inside, unless that cannot work', () => {
  const freeLocal = (forwards) => new Function('state', `${cut('holder')}${cut('freeLocal')}; return freeLocal;`)({ forwards });
  const none = freeLocal([]);
  assert.equal(none(5432), 5432);
  assert.equal(none(80), 8080, 'below 1024 needs rights an ordinary program does not have');
  assert.equal(none(443), 8443);
  assert.equal(none(''), '');
  const some = freeLocal([{ id: 'a', ports: [{ local: 5432, remote: 5432 }] }, { id: 'b', ports: [{ local: 5433, remote: 5432 }] }]);
  assert.equal(some(5432), 5434, 'past the ones saved forwards already ask for');
  assert.equal(some(5432, 'a'), 5432, 'its own port is not in its own way');
  assert.equal(some(5432, null, { 5434: true }), 5435, 'nor two picked in the same breath');
});

test('a database port gets a URL, and only web ports are for a browser', () => {
  const made = new Function(`${value('SCHEMES')}${cut('urlFor')}${cut('isWeb')}; return { urlFor, isWeb };`)();
  assert.equal(made.urlFor(27017, 37017), 'mongodb://localhost:37017');
  assert.equal(made.urlFor(5432, 5544), 'postgresql://localhost:5544');
  assert.equal(made.urlFor(4242, 4242), null);
  assert.equal(made.urlFor(27017, 0), null, 'nothing to say before it has a port');
  assert.equal(made.isWeb(8080), true);
  assert.equal(made.isWeb(27017), false);
});
