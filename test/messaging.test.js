const assert = require('node:assert');
const test = require('node:test');

const {
  normalizeReach,
  audienceFor,
  resolveRecipient,
  formatMessage,
} = require('../electron/messaging');

const S = (id, groupId, name) => ({ id, groupId, name });

const ROSTER = [
  S('aaaaaaaa-1', 'erp', 'migration'),
  S('bbbbbbbb-2', 'erp', 'schema'),
  S('cccccccc-3', 'web', 'landing'),
  S('dddddddd-4', null, 'scratch'),
  S('eeeeeeee-5', null, 'notes'),
];

test('an unknown reach falls back to the narrow one', () => {
  assert.strictEqual(normalizeReach(undefined), 'group');
  assert.strictEqual(normalizeReach('everything'), 'group');
  assert.strictEqual(normalizeReach('all'), 'all');
  assert.strictEqual(normalizeReach('off'), 'off');
});

test('the default reach is the sender\'s own group', () => {
  const heard = audienceFor('aaaaaaaa-1', ROSTER, 'group').map((s) => s.id);
  assert.deepStrictEqual(heard, ['bbbbbbbb-2']);
});

test('a sender never hears itself', () => {
  for (const reach of ['group', 'all']) {
    const heard = audienceFor('aaaaaaaa-1', ROSTER, reach).map((s) => s.id);
    assert.ok(!heard.includes('aaaaaaaa-1'), `${reach} put the sender in its own audience`);
  }
});

/*
 * "Not in a group" is not a group. Two unrelated scratch sessions sharing the
 * property of being ungrouped are not the same piece of work, and putting them
 * in earshot of each other is the thing the narrow default exists to prevent.
 */
test('an ungrouped session reaches nobody on the group setting', () => {
  assert.deepStrictEqual(audienceFor('dddddddd-4', ROSTER, 'group'), []);
});

test('the wide reach is every other live session, grouped or not', () => {
  const heard = audienceFor('aaaaaaaa-1', ROSTER, 'all').map((s) => s.id);
  assert.deepStrictEqual(heard.sort(), ['bbbbbbbb-2', 'cccccccc-3', 'dddddddd-4', 'eeeeeeee-5']);
});

test('off reaches nobody, whatever the roster says', () => {
  assert.deepStrictEqual(audienceFor('aaaaaaaa-1', ROSTER, 'off'), []);
});

test('a sender that is not live addresses nobody', () => {
  assert.deepStrictEqual(audienceFor('ffffffff-9', ROSTER, 'all'), []);
});

test('a recipient resolves by name, by id, and by the short id shown in the roster', () => {
  const audience = audienceFor('aaaaaaaa-1', ROSTER, 'all');
  assert.strictEqual(resolveRecipient('schema', audience)?.id, 'bbbbbbbb-2');
  assert.strictEqual(resolveRecipient('bbbbbbbb-2', audience)?.id, 'bbbbbbbb-2');
  assert.strictEqual(resolveRecipient('bbbbbb', audience)?.id, 'bbbbbbbb-2');
  assert.strictEqual(resolveRecipient('SCHEMA', audience)?.id, 'bbbbbbbb-2');
});

/*
 * A session outside the audience has to be indistinguishable from one that does
 * not exist. Answering "you may not reach that" would confirm it is there, which
 * is the difference between a boundary and a directory.
 */
test('a session outside the audience resolves exactly like one that is not there', () => {
  const audience = audienceFor('aaaaaaaa-1', ROSTER, 'group');
  assert.strictEqual(resolveRecipient('landing', audience), null);
  assert.strictEqual(resolveRecipient('cccccccc-3', audience), null);
  assert.strictEqual(resolveRecipient('nothing-like-this', audience), null);
});

test('an ambiguous name is reported rather than guessed at', () => {
  const audience = [S('1111111111', 'g', 'build'), S('2222222222', 'g', 'build')];
  const found = resolveRecipient('build', audience);
  assert.strictEqual(found.ambiguous.length, 2);
});

test('an empty recipient is refused', () => {
  const audience = audienceFor('aaaaaaaa-1', ROSTER, 'all');
  assert.strictEqual(resolveRecipient('', audience), null);
  assert.strictEqual(resolveRecipient(null, audience), null);
  assert.strictEqual(resolveRecipient('   ', audience), null);
});

/*
 * A message that does not say where it came from is indistinguishable from the
 * user typing it, and a session that cannot tell those apart cannot weigh them
 * differently either.
 */
test('every message says who sent it and how widely', () => {
  const one = formatMessage({ fromName: 'migration', fromProfile: 'Kubrik', text: 'schema is ready' });
  assert.match(one, /^\[Smart Terminal · message from migration on Kubrik to you\]/);
  assert.match(one, /schema is ready/);

  const many = formatMessage({ fromName: 'migration', groupName: 'KS-ERP', text: 'done', broadcast: true });
  assert.match(many, /to everyone in KS-ERP\]/);

  const wide = formatMessage({ fromName: 'migration', text: 'done', broadcast: true });
  assert.match(wide, /to every session\]/);
});

test('a message with nothing but whitespace still carries its label', () => {
  const out = formatMessage({ fromName: 'a', text: '   ' });
  assert.match(out, /message from a to you/);
});
