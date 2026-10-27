'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { receiveRazorpayWebhook } = require('../src/razorpayWebhook');

// A captured payment settles its invoice; the same webhook delivered twice settles it once.

const SECRET = 'whsec_settle';
const store = () => ({ data: {} });
const bodyFor = (paymentId, invoiceNumber) => JSON.stringify({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, amount: 118000, notes: { invoiceNumber }, created_at: 1772352000 } } },
});
const deliver = (store, raw) => receiveRazorpayWebhook({
  headers: { 'x-razorpay-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex') },
  body: raw, secret: SECRET, store,
});

test('a captured payment settles the invoice named in the order notes', () => {
  const s = store();
  const result = deliver(s, bodyFor('pay_1', 'INV-1'));
  assert.equal(result.settlement.duplicate, false);
  assert.equal(result.settlement.payment.amountRupees, 1180);
  assert.equal(s.data.settledPayments.length, 1);
});

test('the same webhook twice credits once', () => {
  const s = store();
  deliver(s, bodyFor('pay_1', 'INV-1'));
  const second = deliver(s, bodyFor('pay_1', 'INV-1'));
  assert.equal(second.settlement.duplicate, true);
  assert.equal(s.data.settledPayments.length, 1);
  assert.equal(s.data.webhookEvents.length, 2, 'both deliveries are still recorded as received');
});

test('a payment without an invoice number is recorded and not guessed at', () => {
  const s = store();
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_2', amount: 5000 } } } });
  const result = deliver(s, raw);
  assert.equal(result.settlement, undefined, 'no settlement key at all');
  assert.equal((s.data.settledPayments || []).length, 0);
});
