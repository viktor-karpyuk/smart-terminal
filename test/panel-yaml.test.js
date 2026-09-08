'use strict';

/**
 * The panel's YAML colouring must agree with the app's, line for line.
 *
 * The panel is a sandboxed frame in an origin of its own, so it cannot call into
 * the app's editor and has to carry its own copy of the rules. A copy is a thing
 * that drifts, and drift here means the same manifest is coloured one way in the
 * editor and another way in the panel — which is worse than no colour at all,
 * because it teaches people that the colours mean nothing.
 *
 * So the copy is not trusted: it is extracted from the panel document, run in a
 * sandbox with nothing in it, and compared against the app's own function on
 * real kubectl output. If somebody improves one and forgets the other, this
 * fails on the line where they disagree.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('../.test-build/lib/preview.js');

/** The highlighter as the panel actually ships it, with nothing else attached. */
function panelHighlighter() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'kubernetes', 'panel.html'), 'utf8');
  const source = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const wanted = ['BLOCK_OPENER', 'keyColon', 'splitTrailingComment', 'scalarClass', 'flowTokens', 'valueSpans', 'yamlSpans', 'opensYamlBlock'];

  // Each declaration, taken whole, by finding where the next one starts.
  const starts = wanted.map((name) => {
    const at = source.search(new RegExp(`\\n  (?:var|function) ${name}\\b`));
    assert.ok(at >= 0, `the panel no longer defines ${name}`);
    return { name, at };
  });
  /*
   * Each declaration ends where the *next* one begins — any next one, not just
   * the next one wanted. Running to the end of the file instead would drag the
   * whole panel in behind the last piece, DOM and all.
   */
  const boundary = /\n  (?:var|function) [A-Za-z_$]/g;
  const pieces = starts.map((piece) => {
    boundary.lastIndex = piece.at + 1;
    const next = boundary.exec(source);
    return source.slice(piece.at, next ? next.index : source.length).trimEnd();
  });

  const context = vm.createContext({});
  vm.runInContext(
    // Nothing is trimmed to the first brace, so an unbalanced piece throws here
    // rather than silently colouring nothing.
    `${pieces.join('\n')}\nglobalThis.out = { yamlSpans, opensYamlBlock, scalarClass };`,
    context,
  );
  return context.out;
}

const MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
  labels:
    app.kubernetes.io/name: api
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: |
      {"apiVersion":"apps/v1","kind":"Deployment"}
      still inside the block: not a key
spec:
  replicas: 3
  paused: false
  selector:
    matchLabels: {app: api, tier: web}
  template:
    spec:
      containers:
        - name: api
          image: registry.example.com/api:0.0.8
          args: ["--port", "8080"]
          env:
            - name: URL
              value: https://example.com/path   # a trailing comment
            - name: EMPTY
              value: ""
          resources:
            limits: {cpu: 500m, memory: 1Gi}
# a whole-line comment
---
%YAML 1.2
`;

test('the panel colours a manifest exactly as the app does', () => {
  const panel = panelHighlighter();
  const lines = MANIFEST.split('\n');
  let blockAt = -1;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const inBlock = blockAt >= 0 && (!line.trim() || indent > blockAt);
    if (!inBlock) blockAt = -1;

    assert.deepEqual(
      panel.yamlSpans(line, inBlock),
      app.yamlSpans(line, inBlock),
      `they disagree about: ${JSON.stringify(line)}`,
    );
    assert.equal(
      panel.opensYamlBlock(line),
      app.opensYamlBlock(line),
      `they disagree about whether this opens a block: ${JSON.stringify(line)}`,
    );

    if (!inBlock && app.opensYamlBlock(line)) blockAt = indent;
  }
});

test('the two agree about what a bare value is', () => {
  const panel = panelHighlighter();
  const values = ['true', 'FALSE', 'no', '~', 'null', '3', '-2.5', '1e9', '500m', '&anchor', '*ref', '|', '>-', 'nginx:latest', ''];
  for (const value of values) {
    assert.equal(panel.scalarClass(value), app.scalarClass(value), `they disagree about ${JSON.stringify(value)}`);
  }
});
