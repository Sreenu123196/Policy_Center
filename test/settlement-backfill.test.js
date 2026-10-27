'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { backfillSettlements } = require('../src/settlementBackfill');

// Running this twice must not pay an invoice twice: the provider payment id is the key.

function world() {
  const store = { data: { settledPayments: [
    { paymentId: 'pay_1', invoiceNumber: 'INV-1', amountRupees: 1 },
    { paymentId: 'pay_2', invoiceNumber: 'INV-2', amountRupees: 5 },
  ] } };
  const pc = { db: { payments: [] } };
  const calls = [];
  const billing = {
    invoiceByNumber: (n) => ({ policyId: 'pol-' + n }),
    receivePayment: (user, input) => { calls.push(input); pc.db.payments.push({ reference: input.reference }); return {}; },
  };
  return { store, pc, billing, calls };
}

test('settlements with no matching payment are applied once each', () => {
  const w = world();
  const result = backfillSettlements(w);
  assert.equal(result.applied.length, 2);
  assert.equal(w.calls[0].method, 'Razorpay');
  assert.equal(w.calls[0].amount, 1);
});

test('a second run changes nothing, because the reference already exists', () => {
  const w = world();
  backfillSettlements(w);
  const again = backfillSettlements(w);
  assert.equal(again.applied.length, 0);
  assert.equal(again.skipped.length, 2);
  assert.equal(w.calls.length, 2);
});

test('an unknown invoice is skipped with a reason rather than guessed at', () => {
  const w = world();
  w.billing.invoiceByNumber = (n) => { if (n === 'INV-2') throw new Error('not found'); return { policyId: 'pol1' }; };
  const result = backfillSettlements(w);
  assert.equal(result.applied.length, 1);
  assert.match(result.skipped[0].reason, /invoice not found/);
});
