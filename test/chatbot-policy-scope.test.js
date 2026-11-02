'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterPolicies } = require('../src/chatbot');

// The rule that matters: naming one policy must return one policy, never a summary of the book.

const BOOK = [
  { policyNumber: 'HO-0000001', product: 'Homeowners', state: 'TX', status: 'In Force' },
  { policyNumber: 'PA-0000001', product: 'PersonalAuto', state: 'TX', status: 'In Force' },
  { policyNumber: 'HO-0000002', product: 'Homeowners', state: 'CA', status: 'Expired' },
];

test('a named policy returns exactly that policy', () => {
  const out = filterPolicies(BOOK, { policy: 'HO-0000001' });
  assert.equal(out.length, 1);
  assert.equal(out[0].policyNumber, 'HO-0000001');
  assert.equal(filterPolicies(BOOK, { policy: 'ho-0000001' }).length, 1, 'case does not matter');
});

test('a named policy that does not exist returns nothing, not everything', () => {
  assert.deepEqual(filterPolicies(BOOK, { policy: 'HO-9999999' }), []);
});

test('without a policy the other filters still apply, and an empty filter keeps the list', () => {
  assert.equal(filterPolicies(BOOK, { product: 'Homeowners' }).length, 2);
  assert.equal(filterPolicies(BOOK, { product: 'Homeowners', state: 'CA' }).length, 1);
  assert.equal(filterPolicies(BOOK, {}).length, 3);
});
