'use strict';
// Razorpay, behind an adapter.
//
// The HTTP call is injected so the tests never touch the network: a fake transport returns the shapes the real API returns,
// and the same code runs against test-mode keys in the app. That is how Voyage and Claude are already wired in this project.
//
// Two things are easy to get wrong and are therefore explicit here: amounts are sent in paise (multiply by 100, round), and
// a webhook is untrusted until its HMAC matches the signature header computed over the exact bytes received.

const crypto = require('node:crypto');

const API = 'api.razorpay.com';

function toPaise(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error('amount must be a positive number');
  return Math.round(value * 100);
}

function verifyWebhookSignature({ rawBody, signature, secret }) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * @param {{keyId: string, keySecret: string, transport: (options: object) => Promise<{status: number, body: string}>}} deps
 */
function createRazorpay({ keyId, keySecret, transport }) {
  if (!keyId || !keySecret) throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required');
  const auth = 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64');

  async function call(method, path, payload) {
    const response = await transport({
      host: API, path, method, headers: { authorization: auth, 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    let parsed;
    try { parsed = response.body ? JSON.parse(response.body) : null; } catch { parsed = null; }
    if (response.status < 200 || response.status >= 300) {
      throw new Error('razorpay ' + response.status + ': ' + ((parsed && parsed.error && parsed.error.description) || String(response.body).slice(0, 200)));
    }
    return parsed;
  }

  /** An order is what a payment is made against. Amount in rupees in, paise on the wire. */
  function createOrder({ amount, currency = 'INR', receipt, notes }) {
    return call('POST', '/v1/orders', { amount: toPaise(amount), currency, receipt, notes });
  }

  /** A UPI collect request asks the payer to approve in their app. */
  function createUpiCollect({ amount, currency = 'INR', vpa, reference }) {
    if (!vpa) throw new Error('vpa is required for a UPI collect');
    return call('POST', '/v1/payments/create/upi', { amount: toPaise(amount), currency, vpa, reference });
  }

  function fetchPayment(paymentId) {
    if (!paymentId) throw new Error('paymentId is required');
    return call('GET', '/v1/payments/' + encodeURIComponent(paymentId));
  }

  function refund({ paymentId, amount, notes }) {
    if (!paymentId) throw new Error('paymentId is required');
    return call('POST', '/v1/payments/' + encodeURIComponent(paymentId) + '/refund', { amount: toPaise(amount), notes });
  }

  return { createOrder, createUpiCollect, fetchPayment, refund, verifyWebhookSignature: (args) => verifyWebhookSignature(args) };
}

module.exports = { createRazorpay, verifyWebhookSignature, toPaise, API };
