'use strict';
// Applying settlements that arrived before the webhook moved money.
//
// The first payments were recorded and never credited, because application was added after they landed. This walks the recorded settlements and applies the ones with no matching
// billing payment, once each - keyed on the provider payment id, so running it twice changes nothing.

const { AppError } = require('./appError');

const SYSTEM = { id: 'settlement-backfill', role: 'UW Manager' };

function backfillSettlements({ store, billing, pc } = {}) {
  if (!billing || !pc) throw new AppError(500, 'billing and pc are required');
  const settlements = store.data.settledPayments || [];
  const payments = pc.db.payments || [];
  const applied = [];
  const skipped = [];
  for (const settlement of settlements) {
    const already = payments.some((p) => String(p.reference || '').trim() === String(settlement.paymentId).trim());
    if (already) { skipped.push({ paymentId: settlement.paymentId, reason: 'already applied' }); continue; }
    let invoice;
    try { invoice = billing.invoiceByNumber(settlement.invoiceNumber, SYSTEM); } catch { invoice = null; }
    if (!invoice || !invoice.policyId) { skipped.push({ paymentId: settlement.paymentId, reason: 'invoice not found for ' + settlement.invoiceNumber }); continue; }
    billing.receivePayment(SYSTEM, { policyId: invoice.policyId, amount: settlement.amountRupees, method: 'Razorpay', reference: settlement.paymentId, receivedOn: settlement.receivedOn });
    applied.push({ paymentId: settlement.paymentId, invoiceNumber: settlement.invoiceNumber, amount: settlement.amountRupees });
  }
  return { applied, skipped };
}

module.exports = { backfillSettlements };
