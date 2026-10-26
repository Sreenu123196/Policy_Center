'use strict';
// Posting a premium at bind.
//
// The plan is built before anything is written, and it must balance to zero:
//
//   Dr Premium receivable     gross      what the customer owes
//   Dr Commission expense     commission what the producer earns, a cost to us
//   Cr Written premium        gross      our income, at the gross the customer was charged
//   Cr Commission payable     commission what we owe the producer
//
// Written premium is the gross, not the net: the premium written is the price of the policy, and commission is an expense
// against it. Netting commission into written premium would understate the book and break the balance - which is exactly how
// the first version of this module failed its own test.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * @param {{grossPremium: number, commission: number}} input
 * @returns {{entries: Array<{account: string, debit: number, credit: number}>, debits: number, credits: number, balanced: boolean}}
 */
function buildPremiumPosting({ grossPremium, commission = 0 }) {
  const gross = round2(grossPremium);
  if (!Number.isFinite(gross) || gross < 0) throw new Error('grossPremium must be a non-negative number');
  const commissionAmount = round2(commission);
  if (!Number.isFinite(commissionAmount) || commissionAmount < 0) throw new Error('commission must be a non-negative number');
  if (commissionAmount > gross) throw new Error('commission cannot exceed the gross premium');

  const entries = [
    { account: 'premium_receivable', debit: gross, credit: 0 },
    { account: 'commission_expense', debit: commissionAmount, credit: 0 },
    { account: 'written_premium', debit: 0, credit: gross },
    { account: 'commission_payable', debit: 0, credit: commissionAmount },
  ].filter((entry) => entry.debit !== 0 || entry.credit !== 0);

  const debits = round2(entries.reduce((sum, e) => sum + e.debit, 0));
  const credits = round2(entries.reduce((sum, e) => sum + e.credit, 0));
  return { entries, debits, credits, balanced: debits === credits };
}

module.exports = { buildPremiumPosting, round2 };
