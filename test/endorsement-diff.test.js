'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffCoverages, checkExclusions } = require('../src/endorsementDiff');

// An endorsement is a diff. These tests state what changed, and whether an exclusion contradicts it.

const before = {
  HODwellingCov: { selected: true, terms: { limit: 450000 } },
  HOPersonalPropertyCov: { selected: true, terms: { limit: 250000 } },
  HOWaterBackupCov: { selected: false, terms: { limit: 10000 } },
};

test('a changed limit is reported field by field, with both values', () => {
  const after = { ...before, HOPersonalPropertyCov: { selected: true, terms: { limit: 400000 } } };
  const diff = diffCoverages(before, after);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  const change = diff.changed.find((c) => c.code === 'HOPersonalPropertyCov');
  assert.equal(change.field, 'limit');
  assert.equal(change.from, 250000);
  assert.equal(change.to, 400000);
});

test('an added coverage is added, a deselected one is removed', () => {
  const after = {
    ...before,
    HOScheduledJewelryCov: { selected: true, terms: { limit: 2500 } },
    HOWaterBackupCov: { selected: true, terms: { limit: 10000 } },
  };
  const diff = diffCoverages({ ...before, HOWaterBackupCov: { selected: true, terms: { limit: 10000 } } }, after);
  assert.deepEqual(diff.added, ['HOScheduledJewelryCov']);
  const removedDiff = diffCoverages(
    { ...before, HOWaterBackupCov: { selected: true, terms: { limit: 10000 } } },
    { ...before, HOWaterBackupCov: { selected: false, terms: { limit: 10000 } } },
  );
  assert.deepEqual(removedDiff.removed, ['HOWaterBackupCov']);
});

test('an unchanged endorsement reports nothing changed', () => {
  const diff = diffCoverages(before, before);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
  assert.ok(diff.unchanged.includes('HOPersonalPropertyCov'));
});

test('an exclusion that contradicts a requested coverage is reported with its reason', () => {
  const exclusions = [{ id: 'EX-FLOOD-1', appliesTo: 'jewellery', text: 'Scheduled jewellery is excluded while the property is untenanted.' }];
  const result = checkExclusions({ coverages: { HOScheduledJewelryCov: { selected: true, name: 'Scheduled Jewellery' } }, exclusions });
  assert.equal(result.excluded, true);
  assert.equal(result.conflicts[0].coverage, 'HOScheduledJewelryCov');
  assert.match(result.conflicts[0].reason, /untenanted/);
});

test('an exclusion that touches nothing selected is not a conflict', () => {
  const exclusions = [{ id: 'EX-FLOOD-1', appliesTo: 'flood', text: 'Flood is excluded.' }];
  const result = checkExclusions({ coverages: { HODwellingCov: { selected: true, name: 'Dwelling' } }, exclusions });
  assert.equal(result.excluded, false);
  assert.deepEqual(result.conflicts, []);
});
