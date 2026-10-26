'use strict';
// Allocating a payment to invoices.
//
// A receipt arrives with an amount and, often, a reference. The reference may identify an invoice, or nothing, or an
// invoice that is already paid. Whatever cannot be matched does not vanish and is never guessed at: it sits in suspense
// until a person allocates it. That is the whole discipline - every rupee is either on an invoice or visibly unallocated.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * @param {object} input
 * @param {number} input.amount the money received
 * @param {Array<{invoiceNumber: string, outstanding: number, issuedOn?: string}>} input.invoices candidates, oldest first
 * @param {string} [input.reference] an invoice number the payer quoted
 * @returns {{allocations: Array<{invoiceNumber: string, amount: number}>, suspense: number, reason: string}}
 */
function allocatePayment({ amount, invoices = [], reference = null }) {
  const total = round2(amount);
  if (!Number.isFinite(total) || total <= 0) throw new Error('amount must be a positive number');

  const candidates = invoices
    .filter((invoice) => Number(invoice.outstanding) > 0)
    .slice()
    .sort((a, b) => String(a.issuedOn || '').localeCompare(String(b.issuedOn || '')));

  let remaining = total;
  const allocations = [];

  // If the payer named an invoice, pay that one first - but never more than it owes.
  if (reference) {
    const named = candidates.find((invoice) => invoice.invoiceNumber === reference);
    if (named) {
      const paid = round2(Math.min(remaining, Number(named.outstanding)));
      allocations.push({ invoiceNumber: named.invoiceNumber, amount: paid });
      remaining = round2(remaining - paid);
    }
  }

  // Then the oldest outstanding invoices in turn.
  for (const invoice of candidates) {
    if (remaining <= 0) break;
    if (allocations.some((a) => a.invoiceNumber === invoice.invoiceNumber)) continue;
    const paid = round2(Math.min(remaining, Number(invoice.outstanding)));
    allocations.push({ invoiceNumber: invoice.invoiceNumber, amount: paid });
    remaining = round2(remaining - paid);
  }

  const suspense = round2(remaining);
  const reason = allocations.length === 0
    ? (reference ? 'no open invoice matches ' + reference + ': all to suspense' : 'no open invoices: all to suspense')
    : (suspense > 0 ? 'allocated to the oldest open invoices; the remainder is in suspense' : 'fully allocated');
  return { allocations, suspense, reason };
}

module.exports = { allocatePayment, round2 };
