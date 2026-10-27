'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { settlePaidInvoice } = require('../src/paymentSettlement');

const store = () => ({ data: {} });

test('a payment is recorded against its invoice, in paise and in rupees', () => {
  const s = store();
  const result = settlePaidInvoice({ store: s, paymentId: 'pay_1', invoiceNumber: 'INV-1', amountPaise: 118000 });
  assert.equal(result.duplicate, false);
  assert.equal(result.payment.amountRupees, 1180);
  assert.equal(s.data.settledPayments.length, 1);
});

test('a replayed webhook does not credit the invoice twice', () => {
  const s = store();
  const first = settlePaidInvoice({ store: s, paymentId: 'pay_1', invoiceNumber: 'INV-1', amountPaise: 5000 });
  const again = settlePaidInvoice({ store: s, paymentId: 'pay_1', invoiceNumber: 'INV-1', amountPaise: 5000 });
  assert.equal(again.duplicate, true);
  assert.equal(again.payment.settledAt, first.payment.settledAt, 'the first record is returned');
  assert.equal(s.data.settledPayments.length, 1);
});

test('a missing id, invoice or a non-positive amount is refused', () => {
  const s = store();
  assert.throws(() => settlePaidInvoice({ store: s, invoiceNumber: 'INV-1', amountPaise: 100 }), /payment id is required/);
  assert.throws(() => settlePaidInvoice({ store: s, paymentId: 'p', amountPaise: 100 }), /invoice number is required/);
  assert.throws(() => settlePaidInvoice({ store: s, paymentId: 'p', invoiceNumber: 'I', amountPaise: 0 }), /positive number of paise/);
  assert.equal((s.data.settledPayments || []).length, 0);
});
