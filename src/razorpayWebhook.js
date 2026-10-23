'use strict';
// Receiving a Razorpay webhook.
//
// The order matters and is the whole point: bytes, then signature, then parse, then record. Anything that parses first has
// already trusted a body it has not verified.

const { AppError } = require('./appError');
const { verifyWebhookSignature } = require('./razorpay');

/**
 * @param {{headers: object, body: Buffer|string, secret: string|undefined, store: object}} input
 * @returns {{received: true, event: string|null}}
 */
function receiveRazorpayWebhook({ headers, body, secret, store }) {
  if (!secret) throw new AppError(503, 'RAZORPAY_WEBHOOK_SECRET is not configured');
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  const signature = String((headers && (headers['x-razorpay-signature'] || headers['X-Razorpay-Signature'])) || '');
  if (!verifyWebhookSignature({ rawBody: raw, signature, secret })) throw new AppError(400, 'Invalid signature');

  let event = null;
  try {
    event = JSON.parse(raw);
  } catch {
    // A verified body that is not JSON is still a bug on the sender's side: say so rather than recording nothing.
    throw new AppError(400, 'Webhook body is not JSON');
  }
  store.data.webhookEvents = store.data.webhookEvents || [];
  store.data.webhookEvents.push({ source: 'razorpay', event: event.event || null, at: new Date().toISOString() });
  return { received: true, event: event.event || null };
}

module.exports = { receiveRazorpayWebhook };
