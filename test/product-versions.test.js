'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveVersion, versionsFor } = require('../src/productVersions');

// A policy must read the version it was written on. These are the cases that matter when a new version is published.

test('a date before any version refuses rather than guessing', () => {
  assert.throws(() => resolveVersion({ product: 'Homeowners', asOf: '2023-12-31' }), /No version of Homeowners was in force/);
});

test('a date inside a version returns that version and its forms', () => {
  const result = resolveVersion({ product: 'Homeowners', asOf: '2025-06-01' });
  assert.equal(result.version, 2);
  assert.deepEqual(result.forms, ['HO-3', 'HO-5']);
  assert.equal(result.current, false, 'version 3 exists later, so this is not current');
});

test('a date on the effective day uses the new version, not the old one', () => {
  assert.equal(resolveVersion({ product: 'Homeowners', asOf: '2026-07-01' }).version, 3);
  assert.equal(resolveVersion({ product: 'Homeowners', asOf: '2026-06-30' }).version, 2);
});

test('the newest version is marked current', () => {
  const result = resolveVersion({ product: 'PersonalAuto', asOf: '2026-10-23' });
  assert.equal(result.version, 2);
  assert.equal(result.current, true);
});

test('a malformed date is refused', () => {
  assert.throws(() => resolveVersion({ product: 'Homeowners', asOf: '23/10/2026' }), /asOf must be a date/);
});

test('the history is ordered and complete', () => {
  const history = versionsFor('Homeowners');
  assert.deepEqual(history.map((v) => v.version), [1, 2, 3]);
  assert.equal(history[2].note, 'older-home form added');
});
