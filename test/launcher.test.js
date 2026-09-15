'use strict';

/*
 * Where a view opened from its activity-bar button goes: into the section in
 * front, and the one open copy is brought over rather than a second one opened.
 */

const test = require('node:test');
const assert = require('node:assert');
const { launchPlan } = require('../.test-build/lib/launcher');

const leaves = [
  { id: 'left', tabs: ['s1', 'reviewer'] },
  { id: 'right', tabs: ['s2'] },
];

test('not open anywhere: it is opened', () => {
  assert.deepEqual(launchPlan({ leaves, activeLeafId: 'right', existingId: null, minimizedIds: [] }), { action: 'open' });
});

test('already in the section in front: it is selected there', () => {
  assert.deepEqual(launchPlan({ leaves, activeLeafId: 'left', existingId: 'reviewer', minimizedIds: [] }), { action: 'focus', panelId: 'reviewer', leafId: 'left' });
});

test('open in another section: it comes to the one in front, not a second copy', () => {
  assert.deepEqual(launchPlan({ leaves, activeLeafId: 'right', existingId: 'reviewer', minimizedIds: [] }), { action: 'move', panelId: 'reviewer', leafId: 'right' });
});

test('folded into the dock: it comes back into the section in front', () => {
  const docked = [{ id: 'left', tabs: ['s1'] }, { id: 'right', tabs: ['s2'] }];
  assert.deepEqual(launchPlan({ leaves: docked, activeLeafId: 'right', existingId: 'reviewer', minimizedIds: ['reviewer'] }), { action: 'restore', panelId: 'reviewer', leafId: 'right' });
});

test('a section in front that is gone falls back to the first, and a lost tab is opened again', () => {
  assert.deepEqual(launchPlan({ leaves, activeLeafId: 'gone', existingId: 'reviewer', minimizedIds: [] }), { action: 'focus', panelId: 'reviewer', leafId: 'left' });
  assert.deepEqual(launchPlan({ leaves: [{ id: 'left', tabs: ['s1'] }], activeLeafId: 'left', existingId: 'reviewer', minimizedIds: [] }), { action: 'open' });
});
