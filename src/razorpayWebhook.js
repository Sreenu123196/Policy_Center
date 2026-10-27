'use strict';
// Receiving a Razorpay webhook.
//
// The order matters and is the whole point: bytes, then signature, then parse, then record. Anything that parses first has
// already trusted a body it has not verified.

const { AppError } = require('./appError');
const { verifyWebhookSignature } = require('./razorpay');
const { settlePaidInvoice } = require('./paymentSettlement');

/**
 * @param {{headers: object, body: Buffer|string, secret: string|undefined, store: object}} input
 * @returns {{received: true, event: string|null}}
 */
function receiveRazorpayWebhook({ headers, body, secret, store, pc, billing }) {
  if (!secret) throw new AppError(503, 'RAZORPAY_WEBHOOK_SECRET is not configured');
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  const signature = String((headers && (headers['x-razorpay-signature'] || headers['X-Razorpay-Signature'])) || '');
  if (!verifyWebhookSignature({ rawBody: raw, signature, secret })) throw new AppError(400, 'Invalid signature');

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    // A verified body that is not JSON is still a bug on the sender's side: say so rather than recording nothing.
    throw new AppError(400, 'Webhook body is not JSON');
  }
  store.data.webhookEvents = store.data.webhookEvents || [];
  store.data.webhookEvents.push({ source: 'razorpay', event: event.event || null, at: new Date().toISOString() });

  // A captured payment settles its invoice, once. The invoice number travels in the order's notes, so a webhook without one is recorded and not guessed at.
  let settlement = null;
  const payment = event && event.payload && event.payload.payment && event.payload.payment.entity;
  if (event.event === 'payment.captured' && payment && payment.id) {
    const invoiceNumber = (payment.notes && payment.notes.invoiceNumber) || null;
    if (invoiceNumber) settlement = settlePaidInvoice({ store, paymentId: payment.id, invoiceNumber, amountPaise: payment.amount, receivedOn: payment.created_at ? new Date(payment.created_at * 1000).toISOString().slice(0, 10) : undefined });
      // Money moves only on the first settlement; the duplicate flag gates the application, not just the record.
      if (settlement && settlement.duplicate === false && pc && billing) {
        const SYSTEM = { id: 'razorpay-webhook', role: 'UW Manager' };
        const invoice = billing.invoiceByNumber(invoiceNumber, SYSTEM);
        if (invoice && invoice.outstanding > 0) {
          billing.receivePayment(SYSTEM, {
            policyId: invoice.policyId,
            amount: payment.amount / 100,
            method: 'Razorpay',
            reference: payment.id,
            receivedOn: new Date().toISOString().slice(0, 10),
          });
        }
      }
  }
  // The settlement key appears only when there is one, so the reply keeps its documented shape for every other event.
  return settlement ? { received: true, event: event.event || null, settlement } : { received: true, event: event.event || null };
}

module.exports = { receiveRazorpayWebhook };
