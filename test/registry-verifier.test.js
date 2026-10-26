'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGstin, verifyRegistration } = require('../src/registryVerifier');

// A GSTIN is proven by its check digit, not by its shape. A registration is proven by being active on the day that matters.

const REGISTRY = [
  { id: 'HOSP-1', type: 'hospital', name: 'City Hospital', status: 'active', expiresOn: '2027-12-31', source: 'state register' },
  { id: 'HOSP-2', type: 'hospital', name: 'Lapsed Hospital', status: 'active', expiresOn: '2025-01-01', source: 'state register' },
  { id: 'GAR-1', type: 'garage', name: 'Rao Motors', status: 'suspended', source: 'panel' },
  { id: 'GAR-2', type: 'garage', name: 'Good Garage', status: 'active', source: 'panel' },
];

test('a well-formed GSTIN with a correct check digit passes', () => {
  const result = validateGstin('27AAPFU0939F1ZV');
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.stateCode, '27');
  assert.equal(result.pan, 'AAPFU0939F');
});

test('a single wrong check digit is caught, and the message names both digits', () => {
  const result = validateGstin('27AAPFU0939F1ZX');
  assert.equal(result.valid, false);
  assert.match(result.reason, /check digit does not match/);
});

test('the shape and the state code are checked before the checksum', () => {
  assert.match(validateGstin('').reason, /No GSTIN/);
  assert.match(validateGstin('27AAPFU0939F1Z').reason, /fifteen characters/);
  assert.match(validateGstin('99AAPFU0939F1ZV').reason, /does not have the expected shape|State code/);
  assert.equal(validateGstin('27aapfu0939f1zv').valid, true, 'lower case is normalised');
});

test('an active, unexpired hospital verifies, with its source and expiry', () => {
  const result = verifyRegistration({ type: 'hospital', id: 'HOSP-1', registry: REGISTRY, asOf: '2026-03-15' });
  assert.equal(result.verified, true);
  assert.equal(result.source, 'state register');
  assert.equal(result.expiresOn, '2027-12-31');
});

test('an expired registration is refused on the date of the claim, even though its status says active', () => {
  const result = verifyRegistration({ type: 'hospital', id: 'HOSP-2', registry: REGISTRY, asOf: '2026-03-15' });
  assert.equal(result.verified, false);
  assert.match(result.reason, /expired on 2025-01-01/);
});

test('a suspended garage and an unknown id are both refused, and say why', () => {
  assert.match(verifyRegistration({ type: 'garage', id: 'GAR-1', registry: REGISTRY }).reason, /suspended/);
  assert.match(verifyRegistration({ type: 'garage', id: 'NOPE', registry: REGISTRY }).reason, /is on the panel/);
});

test('a hospital id does not verify as a garage', () => {
  const result = verifyRegistration({ type: 'garage', id: 'HOSP-1', registry: REGISTRY });
  assert.equal(result.verified, false);
});

test('the type and the id are required, and the date must be a date', () => {
  assert.throws(() => verifyRegistration({ id: 'X' }), /type must be/);
  assert.throws(() => verifyRegistration({ type: 'hospital' }), /registration id is required/);
  assert.throws(() => verifyRegistration({ type: 'hospital', id: 'HOSP-1', asOf: 'soon' }), /not a date/);
});
