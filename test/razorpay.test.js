'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRazorpay, verifyWebhookSignature, toPaise } = require('../src/razorpay');

// No network: the transport is a fake that records what the adapter asked for and returns a Razorpay-shaped answer.

function fakeTransport(reply) {
  const calls = [];
  return {
    calls,
    transport: async (options) => { calls.push(options); return reply || { status: 200, body: '{}' }; },
  };
}

const keys = { keyId: 'rzp_test_x', keySecret: 'secret' };
const signatureFor = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('hex');

test('amounts go to the wire in paise', () => {
  assert.equal(toPaise(1200), 120000);
  assert.equal(toPaise(1200.5), 120050);
  assert.throws(() => toPaise(0), /positive/);
  assert.throws(() => toPaise(-5), /positive/);
});

test('creating an order sends basic auth and the amount in paise', async () => {
  const fake = fakeTransport({ status: 200, body: JSON.stringify({ id: 'order_1', amount: 120000, status: 'created' }) });
  const razorpay = createRazorpay({ ...keys, transport: fake.transport });
  const order = await razorpay.createOrder({ amount: 1200, receipt: 'POL-1' });
  assert.equal(order.id, 'order_1');
  assert.equal(fake.calls[0].path, '/v1/orders');
  assert.equal(fake.calls[0].headers.authorization, 'Basic ' + Buffer.from('rzp_test_x:secret').toString('base64'));
  assert.match(fake.calls[0].body, /"amount":120000/);
});

test('an error from Razorpay is surfaced with its description, not swallowed', async () => {
  const fake = fakeTransport({ status: 400, body: JSON.stringify({ error: { description: 'amount is invalid' } }) });
  const razorpay = createRazorpay({ ...keys, transport: fake.transport });
  await assert.rejects(() => razorpay.createOrder({ amount: 10 }), /razorpay 400: amount is invalid/);
});

test('a refund goes to the payment path with the amount in paise', async () => {
  const fake = fakeTransport({ status: 200, body: JSON.stringify({ id: 'rfnd_1', amount: 50000 }) });
  const razorpay = createRazorpay({ ...keys, transport: fake.transport });
  await razorpay.refund({ paymentId: 'pay_1', amount: 500 });
  assert.equal(fake.calls[0].path, '/v1/payments/pay_1/refund');
  assert.match(fake.calls[0].body, /"amount":50000/);
});

test('a UPI collect needs a vpa before it touches the wire', async () => {
  const fake = fakeTransport();
  const razorpay = createRazorpay({ ...keys, transport: fake.transport });
  // The validation is synchronous, so it throws rather than rejecting: nothing reaches the transport either way.
  assert.throws(() => razorpay.createUpiCollect({ amount: 100 }), /vpa is required/);
  assert.equal(fake.calls.length, 0);
});

test('a webhook signature is accepted only when it matches the exact bytes', () => {
  const body = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1"}}}}';
  const good = signatureFor(body, 'whsec');
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: good, secret: 'whsec' }), true);
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: good, secret: 'other' }), false);
  assert.equal(verifyWebhookSignature({ rawBody: body + ' ', signature: good, secret: 'whsec' }), false);
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: '', secret: 'whsec' }), false);
});
