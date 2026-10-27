'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('./helpers');
const { createApi } = require('../src/api');
const { EventBus } = require('../src/eventBus');

// The Razorpay webhook drives the real route through a real server, because that route is where a live bug lived: the handler was never imported, so every request
// threw, and nothing noticed because the unit tests call the module directly and the permission matrix never signed a payload.

async function serve() {
  const env = setup('2026-03-01');
  const api = createApi(env.pc, env.store, { backupDir: path.join(os.tmpdir(), 'pc-rzp'), bus: new EventBus(env.pc) });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    api(req, res, url.pathname, url.searchParams);
  });
  await new Promise((ok) => server.listen(0, ok));
  return { server, base: 'http://127.0.0.1:' + server.address().port + '/api' };
}

const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', amount: 1000 } } } });

test('a signed webhook is accepted and an unsigned one is refused, through the server', async () => {
  const secret = 'whsec_test_route';
  process.env.RAZORPAY_WEBHOOK_SECRET = secret;
  const { server, base } = await serve();
  try {
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const good = await fetch(base + '/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature }, body });
    assert.equal(good.status, 200, 'a correctly signed webhook is accepted');

    const unsigned = await fetch(base + '/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(unsigned.status, 400, 'an unsigned webhook is refused: ' + unsigned.status);

    const wrong = await fetch(base + '/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' }, body });
    assert.equal(wrong.status, 400, 'a wrong signature is refused');
  } finally {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    server.close();
  }
});

test('with no secret configured the route refuses rather than pretending', async () => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  const { server, base } = await serve();
  try {
    const response = await fetch(base + '/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 503, 'the route says it is not configured: ' + response.status);
  } finally { server.close(); }
});
