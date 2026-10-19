'use strict';
// A small ledger for a policy, and the settlement when a policy is cancelled. Ported from the Insurance Suite.
//
// The customer's position is one sum: what was billed, less what they paid, less any premium returned, plus refunds
// that were paid out. Positive means the customer owes; negative means the customer is owed.
//
// When a policy is cancelled the return premium is NOT simply what the customer is owed. The earned premium is the
// premium billed less the return premium. The customer has paid some amount. The refund is only what they paid beyond the
// earned premium (cash, never more than they paid); a shortfall is arrears they still owe.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function settleCancellation({ billed, paid, returnPremium }) {
  const earned = round2(billed - returnPremium);
  return { billed: round2(billed), paid: round2(paid), returnPremium: round2(returnPremium), earned, refundDue: Math.max(0, round2(paid - earned)), arrears: Math.max(0, round2(earned - paid)) };
}

const TYPE_ORDER = { charge: 0, credit: 1, return_premium: 2, payment: 3, refund: 4 };

// The entries of a policy in date order, each with the running balance. Invoices that were voided at cancellation stay as
// charges: the return premium credit is what takes them off the customer's bill.
function ledgerEntries({ invoices, payments, refunds }) {
  const entries = [];
  for (const i of invoices) {
    const when = i.createdOn || i.dueDate;
    if (i.amount >= 0) entries.push({ date: i.dueDate, type: 'charge', ref: i.invoiceNumber, description: `${i.description}${i.voided ? ' (cancelled)' : ''}`, amount: round2(i.amount + (i.fee || 0)) });
    else entries.push({ date: when, type: /^Cancellation/.test(i.description) ? 'return_premium' : 'credit', ref: i.invoiceNumber, description: i.description, amount: round2(i.amount) });
  }
  for (const p of payments) entries.push({ date: p.receivedOn, type: 'payment', ref: p.paymentNumber, description: `Payment by ${p.method.toLowerCase()} (${p.reference})`, amount: -round2(p.amount) });
  for (const r of refunds.filter((x) => x.status === 'Issued')) entries.push({ date: r.paidOn, type: 'refund', ref: r.refundNumber, description: `Refund by ${r.method.toLowerCase()} (${r.reference})`, amount: round2(r.amount) });
  entries.sort((a, b) => a.date.localeCompare(b.date) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
  let running = 0;
  for (const e of entries) {
    running = round2(running + e.amount);
    e.balance = running;
  }
  return { entries, balance: running };
}

module.exports = { settleCancellation, ledgerEntries };
