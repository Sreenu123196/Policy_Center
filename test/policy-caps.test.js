'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLimit, capsFor } = require('../src/policyCaps');

const CAPS = [
  { product: 'Homeowners', coverage: 'contents', limit: 250000, kind: 'general' },
  { product: 'Homeowners', coverage: 'jewellery', limit: 2500, kind: 'specific' },
  { product: 'Homeowners', appliesTo: 'all-coverages', limit: 500000, kind: 'general' },
  { product: 'PersonalAuto', coverage: 'rental', limit: 1500, kind: 'specific' },
];

test('a specific cap displaces the general one instead of stacking with it', () => {
  const result = resolveLimit({ product: 'Homeowners', coverage: 'jewellery', requested: 10000, caps: CAPS });
  assert.equal(result.limit, 2500);
  assert.equal(result.capped, true);
  assert.match(result.applied, /jewellery @ 2500/);
  assert.ok(result.displaced.length >= 1, 'the general caps are recorded as displaced');
});

test('with no specific cap, the general cap applies', () => {
  const result = resolveLimit({ product: 'Homeowners', coverage: 'contents', requested: 400000, caps: CAPS });
  assert.equal(result.limit, 250000, 'the tighter general cap wins over the all-coverages one');
  assert.equal(result.capped, true);
});

test('a request below every cap is returned unchanged and says so', () => {
  const result = resolveLimit({ product: 'Homeowners', coverage: 'jewellery', requested: 1000, caps: CAPS });
  assert.equal(result.limit, 1000);
  assert.equal(result.capped, false);
  assert.equal(result.reason, 'within the cap');
});

test('caps from other products never apply', () => {
  // The auto rental cap is 1,500; if it were applied the answer would be 1,500. The Homeowners all-coverages cap is
  // 500,000, so a 9,000 request is within it and comes back unchanged.
  const result = resolveLimit({ product: 'Homeowners', coverage: 'rental', requested: 9000, caps: CAPS });
  assert.equal(result.limit, 9000);
  assert.equal(result.capped, false);
  assert.equal(result.applied, 'all-coverages @ 500000');
  assert.deepEqual(result.displaced, []);
});

test('an unlisted coverage with no caps is left alone', () => {
  const result = resolveLimit({ product: 'WorkersComp', coverage: 'medical', requested: 7000, caps: CAPS });
  assert.equal(result.limit, 7000);
  assert.equal(result.applied, null);
  assert.equal(result.reason, 'no cap applies');
});

test('a negative requested limit is refused rather than resolved', () => {
  assert.throws(() => resolveLimit({ product: 'Homeowners', coverage: 'jewellery', requested: -1, caps: CAPS }), /non-negative/);
});

test('the caps that could apply to a product can be listed', () => {
  assert.equal(capsFor('Homeowners', CAPS).length, 3);
  assert.equal(capsFor('WorkersComp', CAPS).length, 0);
});
