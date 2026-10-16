'use strict';

/**
 * Which jobs are one service in different environments — worked out from
 * names, so what is checked is names: the ones a real company Jenkins has,
 * the ones that look like they belong and do not, and the settings a person
 * may tune.
 */

const test = require('node:test');
const assert = require('node:assert');
const { families, familyOf, mergeSettings, inName: realInName, normal, vocabulary, orderOf, DEFAULT_SETTINGS } = require('../electron/jenkins-board');

const job = (path, extra = {}) => ({ kind: 'job', path, ...extra });
const folder = (path, extra = {}) => ({ kind: 'folder', path, ...extra });
const members = (result, key) => result.families.find((one) => one.key === key)?.members;

test('a name is an environment word at one end of it, and what is left is the service', () => {
  const words = vocabulary({});
  const inName = (name, w) => { const r = realInName(name, w); return r && { env: r.env, service: r.service }; };
  assert.deepEqual(inName('TIMELOG MS DEV', words), { env: 'DEV', service: 'TIMELOG MS' });
  assert.deepEqual(inName('KUBRIK-CORE-PROD', words), { env: 'PROD', service: 'KUBRIK CORE' });
  assert.deepEqual(inName('TIMELOGBOOK-V5-DEV', words), { env: 'DEV', service: 'TIMELOGBOOK V5' });
  assert.deepEqual(inName('DEV-gateway', words), { env: 'DEV', service: 'gateway' });
  assert.deepEqual(inName('orders_staging', words), { env: 'STG', service: 'orders' });
  assert.deepEqual(inName('billing.production', words), { env: 'PROD', service: 'billing' });
  assert.deepEqual(inName('web Develop', words), { env: 'DEV', service: 'web' });
  // "PRE PROD" is the environment before production, not production.
  assert.deepEqual(inName('api PRE-PROD', words), { env: 'PRE', service: 'api' });
  assert.deepEqual(inName('api PREPROD', words), { env: 'PRE', service: 'api' });
  // Nothing to be the service of, or no environment word at all.
  assert.equal(inName('DEV', words), null);
  assert.equal(inName('LIB RELEASE', words), null);
  assert.equal(inName('TLOG WEBSITE', words), null);
  // A word is a whole word: not the end of something longer.
  assert.equal(inName('web FIREDEV', words), null);
  assert.equal(inName('Product launch', words), null);
});

test('the same service in two environments is a family, however it is spelled', () => {
  const rows = [
    folder('KUBRIK'), folder('KUBRIK/TIMELOG'),
    job('KUBRIK/TIMELOG/AGENT MS DEV'), job('KUBRIK/TIMELOG/AGENT MS PROD'),
    job('KUBRIK/TIMELOG/KUBRIK-CORE-DEV'), job('KUBRIK/TIMELOG/KUBRIK-CORE-PROD'),
    job('KUBRIK/TIMELOG/TIMELOGBOOK-V5-DEV'), job('KUBRIK/TIMELOG/TIMELOGBOOK-V5-PROD'),
    job('KUBRIK/TIMELOG/TIMELOG MS DEV'), job('KUBRIK/TIMELOG/Timelog-MS_prod'),
    job('KUBRIK/TIMELOG/LIB RELEASE'), job('KUBRIK/TIMELOG/TLOG WEBSITE'),
  ];
  const result = families(rows);
  assert.deepEqual(result.envs, ['DEV', 'PROD']);
  assert.deepEqual(result.families.map((f) => f.service), ['AGENT MS', 'KUBRIK CORE', 'TIMELOG MS', 'TIMELOGBOOK V5']);
  assert.deepEqual(members(result, 'KUBRIK/TIMELOG|agent ms'), { DEV: 'KUBRIK/TIMELOG/AGENT MS DEV', PROD: 'KUBRIK/TIMELOG/AGENT MS PROD' });
  assert.deepEqual(members(result, 'KUBRIK/TIMELOG|timelog ms'), { DEV: 'KUBRIK/TIMELOG/TIMELOG MS DEV', PROD: 'KUBRIK/TIMELOG/Timelog-MS_prod' }, 'dashes, underscores, spaces and case are the same service');
  // What has no counterpart is not a family.
  assert.equal(result.families.some((f) => f.service.includes('LIB') || f.service.includes('WEBSITE')), false);
  assert.deepEqual(result.labels, { DEV: 'DEV', PROD: 'PROD' });
});

test('services in different folders are different services, even when they are called the same', () => {
  const rows = [
    job('a/web DEV'), job('a/web PROD'),
    job('b/web DEV'), job('b/web PROD'),
    job('web DEV'),
  ];
  const result = families(rows);
  assert.deepEqual(result.families.map((f) => f.key), ['a|web', 'b|web']);
  assert.equal(families(rows, { includeSingles: true }).families.length, 3, 'a service seen in one environment only, when it is asked for');
});

test('a folder named for the environment is an environment too', () => {
  const rows = [folder('pay'), folder('pay/DEV'), folder('pay/PROD'), job('pay/DEV/deploy'), job('pay/PROD/deploy'), job('pay/QA/deploy'), job('pay/DEV/build')];
  const result = families(rows);
  assert.deepEqual(result.envs, ['DEV', 'QA', 'PROD']);
  assert.deepEqual(members(result, 'pay|deploy'), { DEV: 'pay/DEV/deploy', QA: 'pay/QA/deploy', PROD: 'pay/PROD/deploy' });
  assert.equal(members(result, 'pay|build'), undefined, 'one environment only');
  // A name that says an environment wins over a folder that does.
  const both = families([job('x/DEV/api PROD'), job('x/DEV/api QA')]);
  assert.deepEqual(both.envs, ['QA', 'PROD']);
});

test('the branches of a multibranch project are branches, not environments', () => {
  const rows = [
    folder('app', { multibranch: true }), job('app/dev'), job('app/prod'), job('app/main'),
    folder('lib'), job('lib/dev'), job('lib/prod'),
  ];
  const result = families(rows);
  assert.equal(result.families.some((f) => f.folder === 'app'), false);
  assert.deepEqual(result.families.map((f) => f.key), []);
});

test('two jobs that claim the same environment are not silently merged', () => {
  const rows = [job('svc DEV'), job('svc-dev'), job('svc PROD')];
  const result = families(rows);
  const family = result.families[0];
  assert.equal(family.members.DEV, 'svc DEV', 'the first, by path');
  assert.deepEqual(family.extras, ['svc-dev']);
  assert.equal(family.members.PROD, 'svc PROD');
});

test('environments come in the order a change travels, unless the person says otherwise, and their own words work', () => {
  const rows = [job('x PROD'), job('x QA'), job('x DEV'), job('x HOM'), job('y STG'), job('y UAT'), job('y PRE')];
  assert.deepEqual(families(rows).envs, ['DEV', 'QA', 'STG', 'UAT', 'PRE', 'PROD'], 'the order a change travels: x has DEV QA PROD, y has STG UAT PRE');
  const custom = families(rows, { envTokens: { HOM: 'HOMOLOG' }, order: ['DEV', 'HOMOLOG', 'PROD'] });
  assert.deepEqual(custom.envs.slice(0, 4), ['DEV', 'HOMOLOG', 'PROD', 'QA'], 'the order given first, then the usual one');
  assert.equal(members(custom, '|x').HOMOLOG, 'x HOM');
  assert.deepEqual(orderOf(new Set(['ZED', 'PROD', 'DEV', 'ALPHA']), {}), ['DEV', 'PROD', 'ALPHA', 'ZED'], 'unknown ones last, alphabetical');
});

test('rows can be hidden, renamed, or put together by hand', () => {
  const rows = [job('a DEV'), job('a PROD'), job('b DEV'), job('b PROD'), job('c DEV'), job('c PROD'), job('odd-one'), job('odd-two')];
  const result = families(rows, {
    hide: ['|b'],
    rowOverrides: {
      '|a': { name: 'The A service' },
      'hand': { name: 'Odd pair', cells: { DEV: 'odd-one', PROD: 'odd-two' } },
      'ghost': { cells: { DEV: 'no such job' } },
    },
  });
  assert.deepEqual(result.families.map((f) => f.service).sort(), ['Odd pair', 'The A service', 'c']);
  assert.deepEqual(members(result, 'hand'), { DEV: 'odd-one', PROD: 'odd-two' });
  assert.equal(members(result, 'ghost'), undefined, 'a job that is not there is not a row');
  // Hidden by a folder too: everything under it.
  const nested = [job('team/z DEV'), job('team/z PROD'), job('top DEV'), job('top PROD')];
  assert.deepEqual(families(nested, { hide: ['team'] }).families.map((f) => f.service), ['top']);
});

test('nonsense in does not throw, and what is not a job is ignored', () => {
  assert.deepEqual(families(null), { envs: [], labels: {}, families: [] });
  assert.deepEqual(families(undefined, null), { envs: [], labels: {}, families: [] });
  assert.deepEqual(families([null, 5, 'x', {}, { kind: 'job' }, { kind: 'job', path: 5 }, job('only DEV')]).families, []);
  assert.doesNotThrow(() => families([job('a DEV'), job('a PROD')], { envTokens: 'x', order: 5, hide: 3, rowOverrides: [] }));
  assert.equal(normal('  Timelog -- MS__x '), 'timelog ms x');
});

test('settings are replaced by field, reset by null, and refused when they are not what they claim', () => {
  const first = mergeSettings(DEFAULT_SETTINGS, { envTokens: { hom: 'homolog' }, order: ['dev', 'prod', 'dev'], hide: ['a', ' ', 'a'], includeSingles: true, rowOverrides: { 'k': { name: '  Name  ', cells: { dev: '/a/b/' } } } });
  assert.deepEqual(first, { envTokens: { HOM: 'HOMOLOG' }, order: ['DEV', 'PROD'], rowOverrides: { k: { name: 'Name', cells: { DEV: 'a/b' } } }, hide: ['a'], includeSingles: true });
  // What is not named stays; null resets.
  const second = mergeSettings(first, { order: null, includeSingles: false });
  assert.deepEqual(second.envTokens, { HOM: 'HOMOLOG' });
  assert.deepEqual(second.order, []);
  assert.equal(second.includeSingles, false);
  assert.deepEqual(mergeSettings(first, { envTokens: null, rowOverrides: null, hide: null }), { ...DEFAULT_SETTINGS, order: ['DEV', 'PROD'], includeSingles: true });
  const bad = (input, pattern) => assert.throws(() => mergeSettings(DEFAULT_SETTINGS, input), pattern, JSON.stringify(input).slice(0, 60));
  bad(null, /have to be an object/);
  bad([], /have to be an object/);
  bad({ envTokens: [] }, /envTokens has to be an object/);
  bad({ envTokens: { 'bad word!': 'DEV' } }, /letters and digits only/);
  bad({ envTokens: { OK: 'way too long to be a key' } }, /not an environment/);
  bad({ envTokens: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`W${i}`, 'DEV'])) }, /too many words/);
  bad({ order: 'DEV' }, /list of environments/);
  bad({ order: Array.from({ length: 13 }, (_, i) => `E${i}`) }, /too many environments/);
  bad({ order: ['bad env'] }, /not an environment/);
  bad({ hide: 'x' }, /list of rows or paths/);
  bad({ hide: Array.from({ length: 201 }, (_, i) => `h${i}`) }, /too many entries/);
  bad({ rowOverrides: [] }, /keyed by row/);
  bad({ rowOverrides: { '': {} } }, /needs the row's key/);
  bad({ rowOverrides: { k: 5 } }, /has to be an object/);
  bad({ rowOverrides: { k: { cells: [] } } }, /have to be an object/);
  bad({ rowOverrides: { k: { cells: { DEV: '../etc' } } } }, /not a job path/);
  bad({ rowOverrides: { k: { cells: { DEV: 'a/./b' } } } }, /not a job path/);
  bad({ rowOverrides: { k: { cells: { 'x y': 'a' } } } }, /not an environment/);
  bad({ rowOverrides: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, {}])) }, /too many rows/);
  // Control characters are spaces, and length is cut: it is kept on disk.
  const long = mergeSettings(DEFAULT_SETTINGS, { rowOverrides: { k: { name: `a\u0000b${'x'.repeat(500)}` } }, hide: ['p\nq'] });
  assert.equal(long.rowOverrides.k.name.length, 120);
  assert.equal(long.rowOverrides.k.name.startsWith('a b'), true);
  assert.deepEqual(long.hide, ['p q']);
});

test('a big server is families in time to be a page', () => {
  const rows = [];
  for (let f = 0; f < 50; f += 1) {
    rows.push(folder(`team${f}`));
    for (let s = 0; s < 100; s += 1) for (const env of ['DEV', 'QA', 'PROD']) rows.push(job(`team${f}/service-${s} ${env}`));
  }
  const started = Date.now();
  const result = families(rows);
  assert.equal(result.families.length, 5000);
  assert.deepEqual(result.envs, ['DEV', 'QA', 'PROD']);
  assert.equal(Date.now() - started < 2000, true, `15,000 jobs took ${Date.now() - started}ms`);
});

test('one job\'s own view of its family: where it is, and what is before and after it', () => {
  const rows = new Map([
    folder('KUBRIK'), folder('KUBRIK/TIMELOG'),
    job('KUBRIK/TIMELOG/TIMELOG MS DEV', { id: 1 }), job('KUBRIK/TIMELOG/TIMELOG MS QA', { id: 2 }), job('KUBRIK/TIMELOG/TIMELOG MS PROD', { id: 3 }),
    job('KUBRIK/TIMELOG/AGENT MS DEV'), job('KUBRIK/TIMELOG/LIB RELEASE'),
  ].map((row) => [row.path, row]));
  const qa = familyOf(rows, 'KUBRIK/TIMELOG/TIMELOG MS QA');
  assert.equal(qa.service, 'TIMELOG MS');
  assert.deepEqual([qa.me.env, qa.me.rank], ['QA', 1]);
  assert.deepEqual(qa.members.map((m) => m.env), ['DEV', 'QA', 'PROD']);
  assert.deepEqual(qa.downstream.map((m) => m.env), ['PROD']);
  assert.deepEqual(qa.upstream.map((m) => m.env), ['DEV']);
  assert.equal(qa.members[2].row.id, 3, 'the job list\'s own row comes with each member');
  assert.equal(qa.single, false);
  const dev = familyOf(rows, 'KUBRIK/TIMELOG/TIMELOG MS DEV');
  assert.deepEqual(dev.downstream.map((m) => m.env), ['QA', 'PROD'], 'nearest first: the one a build here is promoted to is first');
  assert.deepEqual(dev.upstream, []);
  const prod = familyOf([...rows.values()], 'KUBRIK/TIMELOG/TIMELOG MS PROD');
  assert.deepEqual(prod.upstream.map((m) => m.env), ['QA', 'DEV'], 'a list works as well as a Map');
  assert.deepEqual(prod.downstream, []);
  // A service seen in one environment is a family of one; a job with no environment word is in none.
  const alone = familyOf(rows, 'KUBRIK/TIMELOG/AGENT MS DEV');
  assert.equal(alone.single, true);
  assert.deepEqual([alone.downstream, alone.upstream], [[], []]);
  assert.equal(familyOf(rows, 'KUBRIK/TIMELOG/LIB RELEASE'), null);
  assert.equal(familyOf(rows, 'no/such/job'), null);
  assert.equal(familyOf(null, 'x'), null);
  // The person\'s settings apply: their own word, their own order.
  const own = familyOf(rows, 'KUBRIK/TIMELOG/TIMELOG MS DEV', { order: ['PROD', 'QA', 'DEV'] });
  assert.deepEqual(own.members.map((m) => m.env), ['PROD', 'QA', 'DEV'], 'order is theirs');
  assert.deepEqual(own.downstream, [], 'and "downstream" follows it');
});

// --- what is and is not a family: the names of a real company, and the names that only look like it ---------------------

test('the owner\'s own names pair correctly, and a word that only looks like an environment is not one', () => {
  const rows = [
    folder('KUBRIK'), folder('KUBRIK/TIMELOG'),
    job('KUBRIK/TIMELOG MS DEV'), job('KUBRIK/TIMELOG MS PROD'),
    job('KUBRIK/KUBRIK-CORE-DEV'), job('KUBRIK/KUBRIK-CORE-PROD'),
    job('KUBRIK/TIMELOGBOOK-V5-DEV'), job('KUBRIK/TIMELOGBOOK-V5-PROD'),
    job('KUBRIK/(ConversaAI) BACKOFFICE DEV'), job('KUBRIK/(ConversaAI) BACKOFFICE PROD'),
    job('KUBRIK/PROJECTS MS DEV'), job('KUBRIK/PROJECTS MS PROD'),
    job('KUBRIK/PROJECTS MS TEST'),
    job('KUBRIK/DEVICES MS DEV'), job('KUBRIK/DEVICES MS PROD'),
    job('KUBRIK/PRODUCT launch'), job('KUBRIK/DEVELOPMENT PORTAL'),
  ];
  const result = families(rows);
  const table = Object.fromEntries(result.families.map((f) => [f.service, f.members]));
  assert.deepEqual(Object.keys(table).sort(), ['(ConversaAI) BACKOFFICE', 'DEVICES MS', 'KUBRIK CORE', 'PROJECTS MS', 'TIMELOG MS', 'TIMELOGBOOK V5']);
  assert.deepEqual(table['TIMELOG MS'], { DEV: 'KUBRIK/TIMELOG MS DEV', PROD: 'KUBRIK/TIMELOG MS PROD' });
  assert.deepEqual(table['KUBRIK CORE'], { DEV: 'KUBRIK/KUBRIK-CORE-DEV', PROD: 'KUBRIK/KUBRIK-CORE-PROD' });
  assert.deepEqual(table['TIMELOGBOOK V5'], { DEV: 'KUBRIK/TIMELOGBOOK-V5-DEV', PROD: 'KUBRIK/TIMELOGBOOK-V5-PROD' });
  assert.deepEqual(table['(ConversaAI) BACKOFFICE'], { DEV: 'KUBRIK/(ConversaAI) BACKOFFICE DEV', PROD: 'KUBRIK/(ConversaAI) BACKOFFICE PROD' });
  // PRO is not read in PROJECTS, PRODUCT, DEVICES or DEVELOPMENT: the service is PROJECTS MS, in DEV, TEST and PROD.
  assert.deepEqual(table['PROJECTS MS'], { DEV: 'KUBRIK/PROJECTS MS DEV', TEST: 'KUBRIK/PROJECTS MS TEST', PROD: 'KUBRIK/PROJECTS MS PROD' });
  assert.equal(result.families.every((f) => !f.ambiguous && !f.inactive), true);
});

test('a word at the start of a name is not an environment: Dev Tools and QA TOOLS are two jobs', () => {
  const rows = [job('Dev Tools'), job('QA TOOLS'), job('TEST-gateway'), job('gateway-PROD'), job('Test Cleanup'), job('Stage Artifacts'), job('QA Report')];
  assert.deepEqual(families(rows).families, []);
  assert.equal(familyOf(rows, 'Dev Tools'), null);
  // Unless the person says that word is theirs.
  const own = families([job('HOM billing'), job('billing PROD')], { envTokens: { HOM: 'STG' } });
  assert.deepEqual(own.families.map((f) => f.members), [{ STG: 'HOM billing', PROD: 'billing PROD' }]);
});

test('two jobs for one environment make the family ambiguous, and nothing is promoted until the person says which', () => {
  const rows = [job('Billing_PROD'), job('billing-prod'), job('Billing_DEV')];
  const result = families(rows);
  const [family] = result.families;
  assert.equal(family.ambiguous, true);
  assert.deepEqual(family.candidates.PROD, ['Billing_PROD', 'billing-prod']);
  assert.deepEqual(family.extras, ['billing-prod']);
  for (const path of ['Billing_DEV', 'Billing_PROD', 'billing-prod']) {
    const one = familyOf(rows, path);
    assert.equal(one.ambiguous, true, path);
    assert.deepEqual(one.downstream, [], `${path}: no promotion along a guess`);
    assert.deepEqual(one.upstream, [], path);
  }
  assert.equal(familyOf(rows, 'billing-prod').me.env, 'PROD', 'the one that lost the choice is still that environment');
  // Settled by hand: the cells are exactly what was said.
  const settled = { rowOverrides: { [family.key]: { cells: { DEV: 'Billing_DEV', PROD: 'billing-prod' } } } };
  const fixed = families(rows, settled).families[0];
  assert.equal(fixed.ambiguous, false);
  assert.deepEqual(fixed.members, { DEV: 'Billing_DEV', PROD: 'billing-prod' });
  assert.equal(familyOf(rows, 'Billing_DEV', settled).downstream[0].path, 'billing-prod');
});

test('a folder that says it is old holds families that are not shown or promoted into', () => {
  const rows = [
    job('KUBRIK (old - do not use)/svc DEV'), job('KUBRIK (old - do not use)/svc PROD'),
    job('DEPRECATED/api DEV'), job('DEPRECATED/api PROD'),
    job('Legacy/x DEV'), job('Legacy/x PROD'),
    job('live/svc DEV'), job('live/svc PROD'),
    job('Golden/gold DEV'), job('Golden/gold PROD'), job('Folder/f DEV'), job('Folder/f PROD'),
  ];
  const result = families(rows);
  const byFolder = Object.fromEntries(result.families.map((f) => [f.folder, f.inactive]));
  assert.deepEqual(byFolder, { 'KUBRIK (old - do not use)': true, DEPRECATED: true, Legacy: true, live: false, Golden: false, Folder: false }, '"old" inside Golden or Folder is not a word');
  const old = familyOf(rows, 'DEPRECATED/api DEV');
  assert.equal(old.inactive, true);
  assert.deepEqual(old.downstream, []);
  assert.equal(familyOf(rows, 'live/svc DEV').downstream[0].path, 'live/svc PROD');
});
