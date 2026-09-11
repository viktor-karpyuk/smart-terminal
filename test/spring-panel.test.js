'use strict';

/*
 * The parts of the Spring Boot panel that read rather than draw: the colour
 * codes Spring prints, turned into spans; the words for a run's state; the
 * port a run is going to be on before it says. Extracted from the panel as it
 * ships, as the other panel tests do, so a copy cannot drift.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fromPanel() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'spring-boot', 'panel.html'), 'utf8');
  const source = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const wanted = ['esc', 'ANSI_COLOURS', 'ansiToHtml', 'statusClass', 'statusWords', 'majorOf', 'profileList', 'relativeTo'];
  const starts = wanted.map((name) => {
    const at = source.search(new RegExp(`\\n  (?:var|function) ${name}\\b`));
    assert.ok(at >= 0, `the panel no longer defines ${name}`);
    return { name, at };
  });
  const pieces = starts.map(({ at }) => {
    const rest = source.slice(at + 1);
    const end = rest.slice(1).search(/\n  (?:var|function|\/\*\*|\/\*|\$\(|host\.|draw\(\)|[A-Za-z$_][\w$]*\s*(?:=|\())/);
    return end < 0 ? rest : rest.slice(0, end + 1);
  });
  const context = { state: { root: '/w', jdks: [], configs: {} } };
  vm.createContext(context);
  vm.runInContext(pieces.join('\n'), context);
  return context;
}

const P = fromPanel();

test('colour codes become spans, and everything else is escaped', () => {
  assert.equal(P.ansiToHtml('plain <b>'), 'plain &lt;b&gt;');
  assert.equal(P.ansiToHtml('\x1b[32m INFO\x1b[0m x'), '<span class="a-green"> INFO</span> x');
  assert.equal(P.ansiToHtml('\x1b[1;31mERROR\x1b[m'), '<span class="a-b"><span class="a-red">ERROR</span></span>');
  assert.equal(P.ansiToHtml('\x1b[36mlogger\x1b[0;39m rest'), '<span class="a-cyan">logger</span> rest');
  assert.equal(P.ansiToHtml('\x1b[38;5;208mx\x1b[0m'), '<span class="a-black">x</span>');
  assert.equal(P.ansiToHtml('a\x1b[2Kb'), 'ab', 'cursor codes are dropped');
  assert.equal(P.ansiToHtml('\x1b[90mfaint'), '<span class="a-black">faint</span>', 'an unclosed span is closed');
});

test('a run has a colour and a sentence', () => {
  assert.equal(P.statusClass('up'), 'up');
  assert.equal(P.statusClass('building'), 'busy');
  assert.equal(P.statusClass('starting'), 'busy');
  assert.equal(P.statusClass('failed'), 'bad');
  assert.equal(P.statusClass('buildFailed'), 'bad');
  assert.equal(P.statusClass('stopped'), 'off');
  assert.equal(P.statusWords(null), 'not running');
  assert.equal(P.statusWords({ status: 'up', port: 8222, seconds: 12.3 }), 'up on :8222 · 12.3s');
  assert.equal(P.statusWords({ status: 'building', phase: 'mvn install' }), 'building — mvn install');
  assert.equal(P.statusWords({ status: 'failed', code: 1 }), 'failed to start (exit 1)');
  assert.equal(P.statusWords({ status: 'exited', code: 0 }), 'exited (0)');
});

test('the small readers agree with the backend', () => {
  assert.equal(P.majorOf('17.0.12'), '17');
  assert.equal(P.majorOf('1.8'), '8');
  assert.deepEqual(P.profileList(' local, dev  prod'), ['local', 'dev', 'prod']);
  assert.equal(P.relativeTo('/w', '/w/be/app'), 'be/app');
  assert.equal(P.relativeTo('/w', '/w'), 'w');
  assert.equal(P.relativeTo('/w', '/elsewhere'), '/elsewhere');
});
