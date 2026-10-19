'use strict';
// How an invoice looks to a person once payments are counted. Pure functions, shared by the policy read model and the
// Billing class (src/billing.js). The older Billed / Planned / Credit status in policyCenter.js is about the schedule
// and is kept as it was.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const owed = (invoice) => round2(invoice.amount + (invoice.fee || 0));
const paidOn = (invoice) => round2(invoice.paid || 0);
const balanceOf = (invoice) => round2(owed(invoice) - paidOn(invoice));

// Paid, Part paid, Overdue (past its due date and not paid), Unpaid; a return of premium is a Credit.
function paymentStatus(invoice, today) {
  if (invoice.amount < 0) return 'Credit';
  if (balanceOf(invoice) <= 0) return 'Paid';
  if (invoice.dueDate < today) return 'Overdue';
  return paidOn(invoice) > 0 ? 'Part paid' : 'Unpaid';
}

function invoiceView(invoice, today) {
  return { ...invoice, paid: paidOn(invoice), balance: invoice.amount < 0 ? 0 : balanceOf(invoice), paymentStatus: paymentStatus(invoice, today) };
}

module.exports = { owed, paidOn, balanceOf, paymentStatus, invoiceView };
