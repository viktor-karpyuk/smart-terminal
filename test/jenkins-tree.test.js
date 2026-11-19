'use strict';

/**
 * What the sidebar's Jenkins list decides for itself: the dot on a job, how
 * long ago, which folders a failing job counts against, and where the panel is.
 */

const test = require('node:test');
const assert = require('node:assert');
const { agoShort, ancestorsOf, ciTone, jenkinsDot, jenkinsHere } = require('../.test-build/lib/jenkinsTree');

test('a job gets the dot of its last build, and blue while one is going', () => {
  assert.equal(jenkinsDot({ status: 'success', running: false }), 'ok');
  assert.equal(jenkinsDot({ status: 'failed', running: false }), 'bad');
  assert.equal(jenkinsDot({ status: 'unstable', running: false }), 'warn');
  assert.equal(jenkinsDot({ status: 'none', running: false }), 'none');
  assert.equal(jenkinsDot({ status: 'disabled', running: false }), 'none');
  assert.equal(jenkinsDot({ status: 'aborted', running: false }), 'none');
  // A running build wins over what the last finished one was.
  assert.equal(jenkinsDot({ status: 'failed', running: true }), 'run');
});

test('how long ago says as little as it can', () => {
  const now = 1_000_000_000_000;
  assert.equal(agoShort(null, now), '');
  assert.equal(agoShort(0, now), '');
  assert.equal(agoShort(now - 5_000, now), 'now');
  assert.equal(agoShort(now - 59_000, now), 'now');
  assert.equal(agoShort(now - 60_000, now), '1m');
  assert.equal(agoShort(now - 59 * 60_000, now), '59m');
  assert.equal(agoShort(now - 3_600_000, now), '1h');
  assert.equal(agoShort(now - 23 * 3_600_000, now), '23h');
  assert.equal(agoShort(now - 86_400_000, now), '1d');
  assert.equal(agoShort(now - 213 * 86_400_000, now), '213d');
  // A clock a little ahead of the server's is not a build from the future.
  assert.equal(agoShort(now + 60_000, now), 'now');
});

test('a failing job counts against every folder above it, and a top-level one against none', () => {
  assert.deepEqual(ancestorsOf('KUBRIK/TIMELOG/LIB RELEASE'), ['KUBRIK', 'KUBRIK/TIMELOG']);
  assert.deepEqual(ancestorsOf('KUBRIK/KS'), ['KUBRIK']);
  assert.deepEqual(ancestorsOf('nightly'), []);
  assert.deepEqual(ancestorsOf(''), []);
});

test('which server the panel is on is read too, so the list beside it can follow', () => {
  assert.equal(jenkinsHere({ server: 'jk-1', page: { type: 'home' } }).server, 'jk-1');
  assert.equal(jenkinsHere({ server: 5, page: { type: 'home' } }).server, null);
  assert.equal(jenkinsHere({ server: 'jk-2' }).server, 'jk-2');
});

test('where the panel is comes from what it remembered, and anything odd is nowhere', () => {
  assert.deepEqual(jenkinsHere({ page: { type: 'build', path: 'a/b', number: 7 } }), { type: 'build', path: 'a/b', number: 7, kind: null, name: null, server: null });
  assert.deepEqual(jenkinsHere({ page: { type: 'view', kind: 'smart', name: 'failing' } }), { type: 'view', path: null, number: null, kind: 'smart', name: 'failing', server: null });
  const nowhere = { type: null, path: null, number: null, kind: null, name: null, server: null };
  for (const odd of [null, undefined, 'x', 5, {}, { page: null }, { page: 'home' }, { page: { type: 5, path: {}, number: '7' } }]) {
    assert.deepEqual(jenkinsHere(odd), nowhere, JSON.stringify(odd));
  }
});

test('a notice is red for trouble, green for good news, and plain otherwise — read from what the service wrote', () => {
  // The wording the service uses today, so a change there that breaks the colour fails here.
  for (const title of ['backend/main #482 failed', 'nightly #3 is unstable', 'x #9 was aborted', 'kubrik-ci is not answering', 'deploy-prod is waiting for your approval', 'build-arm-02 is offline', 'integration-tests is stuck in the queue']) {
    assert.equal(ciTone({ title }), 'bad', title);
  }
  for (const title of ['web/main #1204 passed', 'backend/main is green again', 'kubrik-ci is back', 'kubrik-ci is answering again']) {
    assert.equal(ciTone({ title }), 'ok', title);
  }
  for (const title of ['3 builds changed', 'Jenkins', '', 'imported 2 servers']) assert.equal(ciTone({ title }), 'plain', title);
  // A job that merely has a scary word in its name is not a failure: only the words of the sentence count.
  assert.equal(ciTone({ title: 'Failedover cluster restarted' }), 'plain');
});
