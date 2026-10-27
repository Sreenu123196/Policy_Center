'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFetchTransport } = require('../src/razorpayTransport');

// Offline: fetch is a function, and what matters is that the adapter's request shape survives the trip.

test('the host and path are joined, and method, headers and body pass through untouched', async () => {
  const seen = [];
  const transport = createFetchTransport({ fetchImpl: async (url, options) => { seen.push({ url, options }); return { status: 201, text: async () => '{"id":"order_1"}' }; } });
  const result = await transport({ host: 'https://api.razorpay.com', path: '/v1/orders', method: 'POST', headers: { authorization: 'Basic x' }, body: '{"amount":100}' });
  assert.equal(result.status, 201);
  assert.equal(result.body, '{"id":"order_1"}');
  assert.equal(seen[0].url, 'https://api.razorpay.com/v1/orders');
  assert.equal(seen[0].options.method, 'POST');
  assert.equal(seen[0].options.headers.authorization, 'Basic x');
  assert.equal(seen[0].options.body, '{"amount":100}');
});

test('a non-2xx answer is reported, not thrown, so the adapter produces the error message', async () => {
  const transport = createFetchTransport({ fetchImpl: async () => ({ status: 400, text: async () => '{"error":{"description":"bad amount"}}' }) });
  const result = await transport({ host: 'https://x', path: '/v1/orders', method: 'POST' });
  assert.equal(result.status, 400);
  assert.match(result.body, /bad amount/);
});

test('a transport needs a fetch implementation', () => {
  assert.throws(() => createFetchTransport({ fetchImpl: null }), /fetch implementation is required/);
});

test('a host without a scheme is given https, because the adapter names it that way', async () => {
  const seen = [];
  const transport = createFetchTransport({ fetchImpl: async (url) => { seen.push(url); return { status: 200, text: async () => '{}' }; } });
  await transport({ host: 'api.razorpay.com', path: '/v1/orders', method: 'POST' });
  assert.equal(seen[0], 'https://api.razorpay.com/v1/orders');
});
