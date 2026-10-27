'use strict';
// Bringing a payment into the app when its webhook never arrived.
//
// This is not a second way to credit money: it reuses settlePaidInvoice and billing.receivePayment in the same transaction the webhook uses, keyed on the provider payment id, so running
// it twice changes nothing and a webhook arriving later finds the record already there.

const { AppError } = require('./appError');
const { settlePaidInvoice } = require('./paymentSettlement');

const SYSTEM = { id: 'settlement-reconcile', role: 'UW Manager' };

async function reconcilePayment({ razorpay, store, billing, paymentId, invoiceNumber: manualInvoice, user } = {}) {
  if (!paymentId) throw new AppError(422, 'a payment id is required');
  if (!razorpay || !billing) throw new AppError(500, 'razorpay and billing are required');

  const payment = await razorpay.fetchPayment(paymentId);
  if (!payment || payment.status !== 'captured') throw new AppError(409, 'That payment is not captured, so nothing is applied.');
  const fromNotes = payment.notes && payment.notes.invoiceNumber;
  const invoiceNumber = fromNotes || manualInvoice || null;
  const manual = Boolean(invoiceNumber) && !fromNotes;
  if (manual && (!user || user.role !== 'UW Manager')) throw new AppError(403, 'Only a manager may map a payment to an invoice by hand.');
  if (!invoiceNumber) throw new AppError(422, 'The payment carries no invoice number, so it cannot be matched. Name one with ?invoice=');

  return store.transaction(() => {
    const settlement = settlePaidInvoice({ store, paymentId: payment.id, invoiceNumber, amountPaise: payment.amount });
    if (manual && settlement && settlement.duplicate === false) {
      settlement.payment.mappedManually = true;
      settlement.payment.mappedBy = user.id;
    }
    if (settlement && settlement.duplicate === false && billing) {
      const invoice = billing.invoiceByNumber(invoiceNumber, SYSTEM);
      if (invoice && invoice.outstanding > 0) {
        billing.receivePayment(SYSTEM, {
          policyId: invoice.policyId,
          amount: payment.amount / 100,
          method: 'Razorpay',
          reference: payment.id,
        });
      }
    }
    return settlement;
  });
}

module.exports = { reconcilePayment, SYSTEM };