'use strict';
// Payments, allocation and missed payments for policies. Ported from the Insurance Suite billing module.
//
//   - A payment (a cheque, a card, a transfer) is applied to the oldest invoice first. Whatever is left after every
//     invoice is paid stays as a credit on the policy. Payments are never edited or deleted.
//   - An invoice is Paid, Part paid, Overdue (past its due date, not paid) or Unpaid. The older Billed / Planned /
//     Credit status in policyCenter.js is about the schedule and stays as it was.
//   - A missed payment goes through DELINQUENCY_STEPS. The check runs on a date the caller gives, so a test or a
//     nightly batch decides "today"; each step is taken once per invoice. The last step starts a cancellation for
//     non-payment, which a person still quotes and binds: nothing is cancelled in the dark.

const D = require('./dates');
const { AppError } = require('./policyCenter');
const { canSeeBilling } = require('./permissions');
const { round2 } = require('./rating');
const { balanceOf, paidOn, invoiceView, paymentStatus } = require('./invoiceView');
const { ledgerEntries } = require('./ledger');

// A policy cancelled for non-payment can be reinstated by a payment that clears what was owed, within this many days
// of the cancellation date.
const REINSTATEMENT_WINDOW_DAYS = 30;

// eNACH and UPI are how a mandate and a collect arrive; without them every debit the mandate rules allowed was refused here.
const PAYMENT_METHODS = ['Cheque', 'Card', 'Bank transfer', 'Cash', 'eNACH', 'UPI'];
const REFUND_METHODS = ['Cheque', 'Bank transfer', 'Cash'];

// Days after the due date. Change the steps here, not in the code that runs them.
const DELINQUENCY_STEPS = [
  { name: 'notice', afterDays: 5 },
  { name: 'cancellation_request', afterDays: 15 },
];

class Billing {
  constructor(pc) {
    this.pc = pc;
  }

  requireBilling(user, what) {
    if (!canSeeBilling(user)) throw new AppError(403, `${user.role} does not have authority to ${what}`);
  }

  invoicesFor(policyId, user) {
    this.requireBilling(user, 'see billing');
    const policy = this.pc.policy(policyId, user);
    const today = this.pc.today();
    return this.pc.db.invoices
      .filter((i) => i.policyId === policy.id)
      .map((i) => invoiceView(i, today))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
  }

  paymentsFor(policyId, user) {
    this.requireBilling(user, 'see billing');
    const policy = this.pc.policy(policyId, user);
    return this.pc.db.payments.filter((p) => p.policyId === policy.id);
  }

  // The policy's ledger: charges, payments, credits, the return premium and refunds paid out, with a running balance.
  // Positive balance: the customer owes. Negative: the customer is owed.
  ledgerFor(policyId, user) {
    this.requireBilling(user, 'see billing');
    const policy = this.pc.policy(policyId, user);
    return ledgerEntries({
      invoices: this.pc.db.invoices.filter((i) => i.policyId === policy.id),
      payments: this.pc.db.payments.filter((p) => p.policyId === policy.id),
      refunds: this.pc.db.refunds.filter((r) => r.policyId === policy.id),
    });
  }

  refundsFor(policyId, user) {
    this.requireBilling(user, 'see billing');
    const policy = this.pc.policy(policyId, user);
    return this.pc.db.refunds.filter((r) => r.policyId === policy.id);
  }

  // Pays out a refund that is due, once, for exactly the amount due. Never more than the customer paid (the settlement
  // already capped it), and never twice.
  issueRefund(user, refundId, input) {
    this.requireBilling(user, 'issue refunds');
    const refund = this.pc.db.refunds.find((r) => r.id === refundId);
    if (!refund) throw new AppError(404, 'Refund not found');
    this.pc.policy(refund.policyId, user);
    const errors = [];
    if (!REFUND_METHODS.includes(input.method)) errors.push(`The refund method must be one of ${REFUND_METHODS.join(', ')}`);
    if (!D.isDate(input.paidOn)) errors.push('The date paid must be yyyy-mm-dd');
    if (!String(input.reference || '').trim()) errors.push('A reference is required');
    if (errors.length > 0) throw new AppError(422, errors.join('; '), { errors: errors.map((message) => ({ message })) });
    if (refund.status !== 'Due') throw new AppError(409, `Refund ${refund.refundNumber} is ${refund.status}, not due`);
    Object.assign(refund, { status: 'Issued', method: input.method, reference: String(input.reference).trim(), paidOn: input.paidOn, issuedBy: user.id, issuedAt: this.pc.now() });
    const policy = this.pc.policy(refund.policyId);
    this.pc.publish('RefundIssued', { policyNumber: policy.policyNumber, refundNumber: refund.refundNumber, amount: refund.amount, paidOn: refund.paidOn });
    return refund;
  }

  // The money received for the policy that is not on any invoice yet.
  creditFor(policyId, user) {
    return round2(this.paymentsFor(policyId, user).reduce((sum, p) => sum + p.unapplied, 0));
  }

  receivePayment(user, input) {
    this.requireBilling(user, 'take payments');
    const errors = [];
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0) errors.push('The amount must be a number greater than zero');
    if (!PAYMENT_METHODS.includes(input.method)) errors.push(`The payment method must be one of ${PAYMENT_METHODS.join(', ')}`);
    if (!D.isDate(input.receivedOn)) errors.push('The date received must be yyyy-mm-dd');
    const reference = String(input.reference || '').trim();
    if (reference === '') errors.push('A reference (cheque number, transaction id) is required');
    const policy = this.pc.policy(input.policyId, user); // 404 if there is no such policy, or the user may not see it
    if (errors.length > 0) throw new AppError(422, errors.join('; '), { errors: errors.map((message) => ({ message })) });
    const amount = round2(input.amount);
    if (this.pc.db.payments.some((p) => p.policyId === policy.id && p.reference === reference)) {
      throw new AppError(422, `A payment with reference ${reference} was already recorded for this policy`);
    }

    // Oldest due first. A credit invoice (a return premium) is not something the customer pays.
    const open = this.pc.db.invoices
      .filter((i) => i.policyId === policy.id && i.amount >= 0 && balanceOf(i) > 0)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
    let remaining = amount;
    const allocations = [];
    for (const invoice of open) {
      if (remaining <= 0) break;
      const applied = round2(Math.min(remaining, balanceOf(invoice)));
      invoice.paid = round2(paidOn(invoice) + applied);
      allocations.push({ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, amount: applied });
      remaining = round2(remaining - applied);
    }

    const payment = {
      id: this.pc.store.id('pay'),
      paymentNumber: this.pc.store.number('PAY-', 7),
      policyId: policy.id,
      amount,
      method: input.method,
      reference,
      receivedOn: input.receivedOn,
      receivedBy: user.id,
      recordedAt: this.pc.now(),
      allocations,
      unapplied: remaining,
    };
    this.pc.db.payments.push(payment);
    this.pc.publish('PaymentReceived', { policyNumber: policy.policyNumber, paymentNumber: payment.paymentNumber, amount, receivedOn: payment.receivedOn });
    return { ...payment, reinstatement: this.reinstateIfCleared(policy, payment, user) };
  }

  // After a payment on a policy cancelled for non-payment: if everything that fell due up to the cancellation date is
  // now paid, and the time limit has not passed, a reinstatement is started. A person still quotes and binds it.
  // Returns null when the policy is not in that situation at all.
  reinstateIfCleared(policy, payment, user) {
    const cancellation = policy.cancellation;
    if (!cancellation || cancellation.reason !== 'NonPayment') return null;
    const base = { policyNumber: policy.policyNumber };
    const stillOwed = this.pc.db.invoices.some((i) => i.policyId === policy.id && i.amount >= 0 && i.dueDate <= cancellation.effectiveDate && balanceOf(i) > 0);
    if (stillOwed) return { ...base, outcome: 'not_cleared' };
    if (payment.receivedOn > D.addDays(cancellation.effectiveDate, REINSTATEMENT_WINDOW_DAYS)) return { ...base, outcome: 'too_late' };
    const open = this.pc.db.jobs.find((j) => j.policyId === policy.id && ['Draft', 'Quoted'].includes(j.status));
    if (open) return { ...base, outcome: 'skipped', reason: `The policy has an open ${open.type} (${open.jobNumber})` };
    this.pc.publish('ReinstatementRequested', { policyNumber: policy.policyNumber, paymentNumber: payment.paymentNumber });
    try {
      const job = this.pc.startReinstatement(policy.id, user);
      return { ...base, outcome: 'reinstatement_started', jobNumber: job.jobNumber };
    } catch (error) {
      if (error instanceof AppError && error.status >= 400 && error.status < 500) return { ...base, outcome: 'skipped', reason: error.message };
      throw error;
    }
  }

  // The missed-payment check for a date. For each policy in force it looks at its oldest overdue invoice and takes the
  // steps that are due and not taken yet. Returns what it did (nothing is returned for a step already taken).
  runDelinquency(user, { asOf } = {}) {
    this.requireBilling(user, 'run the missed-payment check');
    const date = asOf || this.pc.today();
    if (!D.isDate(date)) throw new AppError(422, 'The date must be yyyy-mm-dd');
    const results = [];
    for (const policy of this.pc.db.policies) {
      if (policy.cancellation) continue;
      const overdue = this.pc.db.invoices
        .filter((i) => i.policyId === policy.id && i.amount >= 0 && balanceOf(i) > 0 && i.dueDate < date)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const oldest = overdue[0];
      if (!oldest) continue;
      const days = D.daysBetween(oldest.dueDate, date);
      oldest.stepsTaken = oldest.stepsTaken || [];
      for (const step of DELINQUENCY_STEPS) {
        if (days < step.afterDays || oldest.stepsTaken.includes(step.name)) continue;
        oldest.stepsTaken.push(step.name);
        results.push(this.takeStep(step, policy, oldest, date, user));
      }
    }
    return results;
  }

  takeStep(step, policy, invoice, date, user) {
    const base = { step: step.name, policyNumber: policy.policyNumber, invoiceNumber: invoice.invoiceNumber };
    if (step.name === 'notice') {
      this.pc.publish('PaymentMissed', { policyNumber: policy.policyNumber, invoiceNumber: invoice.invoiceNumber, dueDate: invoice.dueDate, balance: balanceOf(invoice) });
      return { ...base, outcome: 'notice_sent' };
    }
    this.pc.publish('CancellationRequested', { policyNumber: policy.policyNumber, invoiceNumber: invoice.invoiceNumber, reason: 'NonPayment' });
    const open = this.pc.db.jobs.find((j) => j.policyId === policy.id && ['Draft', 'Quoted'].includes(j.status));
    if (open) return { ...base, outcome: 'skipped', reason: `The policy has an open ${open.type} (${open.jobNumber})` };
    const effectiveDate = D.addDays(date, 10); // the notice days of the NonPayment reason
    try {
      const job = this.pc.startCancellation(policy.id, { effectiveDate, reason: 'NonPayment' }, user);
      return { ...base, outcome: 'cancellation_started', jobNumber: job.jobNumber };
    } catch (error) {
      if (error instanceof AppError && error.status >= 400 && error.status < 500) return { ...base, outcome: 'skipped', reason: error.message };
      throw error;
    }
  }
}

module.exports = { Billing, PAYMENT_METHODS, REFUND_METHODS, DELINQUENCY_STEPS, REINSTATEMENT_WINDOW_DAYS, invoiceView, paymentStatus };
