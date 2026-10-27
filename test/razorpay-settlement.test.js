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
test('a first settlement applies the money to the invoice, and a replay does not', () => {
  const s = store();
  const applied = [];
  const billing = {
    invoiceByNumber: () => ({ policyId: 'pol1', outstanding: 500 }),
    receivePayment: (user, input) => { applied.push({ user, input }); return { paymentNumber: 'PM-1' }; },
  };
  const pc = {};
  const raw = bodyFor('pay_apply_1', 'INV-1');
  const headers = { 'x-razorpay-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex') };
  const deliver = () => receiveRazorpayWebhook({ headers, body: raw, secret: SECRET, store: s, pc, billing });

  deliver();
  assert.equal(applied.length, 1, 'the payment is applied once');
  assert.equal(applied[0].input.amount, 1180, 'paise converted to rupees');
  assert.equal(applied[0].input.method, 'Razorpay');
  assert.equal(applied[0].user.id, 'razorpay-webhook', 'a named system actor, not an anonymous one');

  deliver();
  assert.equal(applied.length, 1, 'a replayed webhook applies nothing');
});
