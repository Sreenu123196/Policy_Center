'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Billing } = require('../src/billing');

// One place finds an invoice by number and computes what is left, so a payment route cannot invent a second arithmetic.

function billing() {
  const pc = {
    db: {
      invoices: [{ invoiceNumber: 'INV-1', amount: 1180, policyId: 'p1' }, { invoiceNumber: 'INV-2', amount: 500, policyId: 'p1' }],
      payments: [{ allocations: [{ invoiceNumber: 'INV-1', amount: 1000 }] }],
    },
  };
  const instance = new Billing(pc);
  instance.requireBilling = () => {}; // the access rule has its own tests; this one is about arithmetic
  return instance;
}

test('a part-paid invoice reports what is paid and what is outstanding', () => {
  const invoice = billing().invoiceByNumber('INV-1');
  assert.equal(invoice.paid, 1000);
  assert.equal(invoice.outstanding, 180);
});

test('an invoice with no payments owes its full amount, and a settled one owes nothing', () => {
  assert.equal(billing().invoiceByNumber('INV-2').outstanding, 500);
  const settled = billing();
  settled.pc.db.payments.push({ allocations: [{ invoiceNumber: 'INV-2', amount: 500 }] });
  assert.equal(settled.invoiceByNumber('INV-2').outstanding, 0);
});

test('an unknown number is null, not an error, so a route can answer 404 cleanly', () => {
  assert.equal(billing().invoiceByNumber('NOPE'), null);
});
