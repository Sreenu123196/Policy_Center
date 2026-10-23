'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { receiveRazorpayWebhook } = require('../src/razorpayWebhook');

// The route's logic, tested without a server: a correct signature is accepted, everything else is refused before parsing.

const SECRET = 'whsec_test';
const BODY = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', amount: 120000 } } } });
const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const freshStore = () => ({ data: {} });

test('a correctly signed body is accepted and recorded', () => {
  const store = freshStore();
  const result = receiveRazorpayWebhook({ headers: { 'x-razorpay-signature': sign(BODY) }, body: Buffer.from(BODY), secret: SECRET, store });
  assert.deepEqual(result, { received: true, event: 'payment.captured' });
  assert.equal(store.data.webhookEvents.length, 1);
  assert.equal(store.data.webhookEvents[0].event, 'payment.captured');
  assert.equal(store.data.webhookEvents[0].source, 'razorpay');
});

test('a tampered body is refused, and nothing is recorded', () => {
  const store = freshStore();
  const tampered = BODY.replace('120000', '999999');
  assert.throws(() => receiveRazorpayWebhook({ headers: { 'x-razorpay-signature': sign(BODY) }, body: Buffer.from(tampered), secret: SECRET, store }), /Invalid signature/);
  assert.equal(store.data.webhookEvents, undefined);
});

test('a signature made with the wrong secret is refused', () => {
  const store = freshStore();
  assert.throws(() => receiveRazorpayWebhook({ headers: { 'x-razorpay-signature': sign(BODY, 'other') }, body: Buffer.from(BODY), secret: SECRET, store }), /Invalid signature/);
});

test('a missing header or missing secret is refused with a reason', () => {
  assert.throws(() => receiveRazorpayWebhook({ headers: {}, body: Buffer.from(BODY), secret: SECRET, store: freshStore() }), /Invalid signature/);
  assert.throws(() => receiveRazorpayWebhook({ headers: { 'x-razorpay-signature': sign(BODY) }, body: Buffer.from(BODY), secret: undefined, store: freshStore() }), /not configured/);
});

test('a verified body that is not JSON is refused rather than recorded', () => {
  const store = freshStore();
  const notJson = 'not json at all';
  assert.throws(() => receiveRazorpayWebhook({ headers: { 'x-razorpay-signature': sign(notJson) }, body: Buffer.from(notJson), secret: SECRET, store }), /not JSON/);
  assert.equal(store.data.webhookEvents, undefined);
});
