'use strict';
// Settling a Razorpay payment against an invoice, exactly once.
//
// The failure that matters in a billing system is not a missed payment; it is a payment counted twice, because a webhook is retried. So the record of a settled
// payment is written before anything else follows from it, keyed by the provider's payment id, and a repeat returns the first record rather than crediting again.

const { AppError } = require('./appError');

function settlePaidInvoice({ store, paymentId, invoiceNumber, amountPaise, method = 'Razorpay', receivedOn } = {}) {
  if (!paymentId) throw new AppError(422, 'a provider payment id is required');
  if (!invoiceNumber) throw new AppError(422, 'an invoice number is required');
  const paise = Number(amountPaise);
  if (!Number.isFinite(paise) || paise <= 0) throw new AppError(422, 'the amount must be a positive number of paise');

  store.data.settledPayments = store.data.settledPayments || [];
  const existing = store.data.settledPayments.find((p) => p.paymentId === paymentId);
  if (existing) return { settled: true, duplicate: true, payment: existing };

  const record = {
    paymentId,
    invoiceNumber,
    amountPaise: Math.round(paise),
    amountRupees: Math.round(paise) / 100,
    method,
    receivedOn: receivedOn || new Date().toISOString().slice(0, 10),
    settledAt: new Date().toISOString(),
  };
  store.data.settledPayments.push(record);
  return { settled: true, duplicate: false, payment: record };
}

module.exports = { settlePaidInvoice };
