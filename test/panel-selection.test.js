'use strict';

/**
 * The drawer, and whether it is still about the thing it says it is about.
 *
 * Every refresh replaces the whole table with new row objects, and the detail
 * pane held the one it was opened with — so a pod that started failing went on
 * reading Running for as long as anybody looked at it, and the buttons decided
 * what they did from the same stale copy: after pausing a rollout the button
 * still said Pause, and pressing it paused the thing again.
 *
 * Two things are tested, and they pull against each other. The object has to
 * take the new facts, or the pane is a photograph. And it has to stay the *same
 * object*, because the detail's own in-flight answers are guarded by
 * `state.selected === row` and a swapped reference makes every one of them
 * arrive too late to count.
 *
 * Extracted from the panel as it ships, for the same reason the other panel
 * tests do it: a copy in the test would be a copy that drifts.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fromPanel() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'kubernetes', 'panel.html'), 'utf8');
  const source = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const wanted = ['assign', 'WATCHED_FIELDS', 'paneWouldChange', 'adoptInto', 'shortContext'];

  const starts = wanted.map((name) => {
    const at = source.search(new RegExp(`\\n  (?:var|function) ${name}\\b`));
    assert.ok(at >= 0, `the panel no longer defines ${name}`);
    return { name, at };
  });
  /*
   * Where one piece ends: the next thing at the top level of the panel's script,
   * which is any line indented exactly two spaces that is not a continuation or
   * a closing brace. Wider than the other panel tests' boundary on purpose —
   * `shortContext` is followed by a listener rather than by another declaration,
   * and a narrower rule swallowed the whole rest of the file.
   */
  const boundary = /\n  (?![ }\])])\S/g;
  const pieces = starts.map((piece) => {
    boundary.lastIndex = piece.at + 1;
    const next = boundary.exec(source);
    return source.slice(piece.at, next ? next.index : source.length).trimEnd();
  });

  const context = vm.createContext({});
  vm.runInContext(`${pieces.join('\n')}\nglobalThis.out = { ${wanted.join(', ')} };`, context);
  return context.out;
}

const panel = fromPanel();

/** A pod row, in the shape the list verb hands one over. */
const pod = (extra) =>
  Object.assign({ uid: 'u-1', name: 'api-7f9', namespace: 'prod', kind: 'Pod', status: 'Running', health: 'ok', ready: '1/1', restarts: 0, age: '3d' }, extra);

// ---------------------------------------------------------------- adopting

test('the open object takes the new facts and stays the same object', () => {
  const chosen = pod();
  const rows = [pod({ uid: 'u-0', name: 'other' }), pod({ status: 'CrashLoopBackOff', health: 'bad', restarts: 4 })];

  const moved = panel.adoptInto(chosen, rows);

  assert.strictEqual(moved, true, 'the pane is showing something different now');
  assert.strictEqual(chosen.status, 'CrashLoopBackOff', 'and it took the new facts');
  assert.strictEqual(chosen.restarts, 4);
  assert.strictEqual(rows[1], chosen, 'the row and the selection are one object again');
});

/*
 * The identity is the load-bearing half. `loadDetail` fires four requests and
 * each one checks `state.selected === row` before it draws — so an object that
 * is replaced rather than updated silently drops the describe, the YAML, the
 * events and the pods that were already on their way.
 */
test('a refresh does not break the identity the detail pane is keyed on', () => {
  const chosen = pod();
  const inFlight = chosen; // what a request in the air is holding
  panel.adoptInto(chosen, [pod({ status: 'Pending' })]);
  assert.ok(inFlight === chosen, 'the answer that is already on its way still counts');
});

test('nothing to adopt is not a change', () => {
  assert.strictEqual(panel.adoptInto(pod(), [pod({ uid: 'somebody-else' })]), false);
  assert.strictEqual(panel.adoptInto(pod(), []), false);
  assert.strictEqual(panel.adoptInto(null, [pod()]), false);
  assert.strictEqual(panel.adoptInto(pod(), null), false);
});

/*
 * Without a uid there is no "the same object" to look for, and matching on
 * nothing would hand the pane whichever row happened to be first.
 */
test('an object with no uid adopts nothing at all', () => {
  const rows = [pod({ uid: 'u-9', name: 'not-this-one' })];
  const chosen = pod({ uid: undefined, name: 'mine' });
  assert.strictEqual(panel.adoptInto(chosen, rows), false);
  assert.strictEqual(chosen.name, 'mine');
  assert.strictEqual(rows[0].name, 'not-this-one');
});

test('the same row twice is neither a change nor a copy onto itself', () => {
  const chosen = pod();
  assert.strictEqual(panel.adoptInto(chosen, [chosen]), false);
});

// ---------------------------------------------------------------- redrawing

/*
 * A watch on a busy namespace delivers dozens of events a second, and the pane
 * is rebuilt from scratch each time it is drawn — which takes the reader back to
 * the top of whatever they were reading. So it is only drawn when something it
 * actually shows has moved.
 */
test('a change the drawer shows is worth a redraw', () => {
  for (const field of ['status', 'health', 'ready', 'restarts', 'replicas', 'paused', 'suspended', 'schedulable', 'age']) {
    const before = pod({ [field]: 'a' });
    const after = pod({ [field]: 'b' });
    assert.strictEqual(panel.paneWouldChange(before, after), true, `${field} moved and nobody noticed`);
  }
});

test('a change the drawer does not show is not', () => {
  assert.strictEqual(panel.paneWouldChange(pod(), pod()), false);
  // The resource version and the managed fields move constantly and are on
  // screen nowhere.
  assert.strictEqual(panel.paneWouldChange(pod({ node: 'ip-10-0-1-1' }), pod({ node: 'ip-10-0-1-2' })), false);
});

// ---------------------------------------------------------------- the cluster's name

/*
 * The same two rules the app itself uses. They are written twice — the panel is
 * a sandboxed frame in an origin of its own and cannot reach the app's code —
 * so if they ever disagree, this is where it shows.
 */
test('a cluster is called what people call it, not what kubeconfig calls it', () => {
  assert.strictEqual(panel.shortContext('arn:aws:eks:sa-east-1:532465846520:cluster/kubrik-k8s'), 'kubrik-k8s');
  assert.strictEqual(panel.shortContext('gke_my-project_southamerica-east1-a_prod'), 'prod');
  assert.strictEqual(panel.shortContext('minikube'), 'minikube');
  assert.strictEqual(panel.shortContext(''), '');
  assert.strictEqual(panel.shortContext(null), '');
});
