'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gstOnPremium, commissionFor, round2 } = require('../src/billingRules');

// Money rules, tested at the edges: the band boundaries, the rounding, and the inclusive-versus-exclusive question.

test('a gross premium splits into net and 18% GST that add back exactly', () => {
  const result = gstOnPremium({ amount: 11800 });
  assert.equal(result.net, 10000);
  assert.equal(result.gst, 1800);
  assert.equal(round2(result.net + result.gst), result.gross);
});

test('an odd amount still adds back to the gross, to the paise', () => {
  const result = gstOnPremium({ amount: 1000.01 });
  assert.equal(round2(result.net + result.gst), 1000.01);
});

test('zero premium is allowed and produces zero GST', () => {
  const result = gstOnPremium({ amount: 0 });
  assert.deepEqual([result.net, result.gst], [0, 0]);
});

test('a negative premium or a nonsensical rate is refused', () => {
  assert.throws(() => gstOnPremium({ amount: -1 }), /non-negative/);
  assert.throws(() => gstOnPremium({ amount: 100, rate: 1.5 }), /fraction between 0 and 1/);
});

test('commission follows the band the premium falls in, at the boundaries', () => {
  assert.deepEqual(commissionFor({ premium: 8000 }).ratePercent, 15);
  assert.deepEqual(commissionFor({ premium: 10000 }).ratePercent, 15, 'exactly at the top of the first band');
  assert.deepEqual(commissionFor({ premium: 10000.01 }).ratePercent, 12.5);
  assert.deepEqual(commissionFor({ premium: 50000 }).ratePercent, 12.5);
  assert.deepEqual(commissionFor({ premium: 50000.01 }).ratePercent, 10);
  assert.deepEqual(commissionFor({ premium: 500000 }).ratePercent, 10);
});

test('commission is computed on the net premium and rounded to paise', () => {
  const result = commissionFor({ premium: 12345.67 });
  assert.equal(result.ratePercent, 12.5);
  assert.equal(result.commission, round2(12345.67 * 0.125));
});

test('GST and commission together: a 11,800 gross policy', () => {
  const gst = gstOnPremium({ amount: 11800 });
  const commission = commissionFor({ premium: gst.net });
  assert.equal(commission.ratePercent, 15, 'net premium lands exactly on 10,000, the top of the first band, which is inclusive');
  assert.equal(commission.commission, 1500);
});
