'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allocatePayment } = require('../src/paymentAllocation');

// The promise of this module is simple: every rupee ends up either on an invoice or visibly in suspense.

const INVOICES = [
  { invoiceNumber: 'INV-2', outstanding: 5000, issuedOn: '2026-02-01' },
  { invoiceNumber: 'INV-1', outstanding: 1000, issuedOn: '2026-01-01' },
  { invoiceNumber: 'INV-3', outstanding: 0, issuedOn: '2025-12-01' },
];

test('an exact payment settles exactly one invoice', () => {
  const result = allocatePayment({ amount: 1000, invoices: INVOICES, reference: 'INV-1' });
  assert.deepEqual(result.allocations, [{ invoiceNumber: 'INV-1', amount: 1000 }]);
  assert.equal(result.suspense, 0);
  assert.equal(result.reason, 'fully allocated');
});

test('an unnamed payment goes to the oldest open invoice first', () => {
  const result = allocatePayment({ amount: 1500, invoices: INVOICES });
  assert.deepEqual(result.allocations, [
    { invoiceNumber: 'INV-1', amount: 1000 },
    { invoiceNumber: 'INV-2', amount: 500 },
  ]);
  assert.equal(result.suspense, 0);
});

test('an overpayment leaves the remainder in suspense rather than over-settling an invoice', () => {
  const result = allocatePayment({ amount: 10000, invoices: INVOICES });
  assert.equal(result.allocations.reduce((s, a) => s + a.amount, 0), 6000);
  assert.equal(result.suspense, 4000);
  assert.match(result.reason, /remainder is in suspense/);
});

test('a payment with nothing to settle goes entirely to suspense', () => {
  const result = allocatePayment({ amount: 2500, invoices: [] });
  assert.deepEqual(result.allocations, []);
  assert.equal(result.suspense, 2500);
  assert.match(result.reason, /no open invoices/);
});

test('a reference that matches no open invoice is said so, not silently ignored', () => {
  const result = allocatePayment({ amount: 2000, invoices: [], reference: 'INV-999' });
  assert.equal(result.suspense, 2000);
  assert.match(result.reason, /no open invoice matches INV-999/);
});

test('a named invoice is settled first, then the oldest of the rest', () => {
  const result = allocatePayment({ amount: 1500, invoices: INVOICES, reference: 'INV-2' });
  assert.deepEqual(result.allocations, [
    { invoiceNumber: 'INV-2', amount: 1500 },
  ]);
  assert.equal(result.suspense, 0, 'the named invoice had enough outstanding');
});

test('a paid invoice is never allocated to, and zero or negative payments are refused', () => {
  const result = allocatePayment({ amount: 500, invoices: [{ invoiceNumber: 'INV-3', outstanding: 0 }] });
  assert.deepEqual(result.allocations, []);
  assert.equal(result.suspense, 500);
  assert.throws(() => allocatePayment({ amount: 0, invoices: INVOICES }), /positive/);
  assert.throws(() => allocatePayment({ amount: -5, invoices: INVOICES }), /positive/);
});
