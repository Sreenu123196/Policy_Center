'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Billing } = require('../src/billing');
const { settleCancellation } = require('../src/ledger');

// Cancellation settlement as a small ledger (ported from the Insurance Suite): what the customer is owed on cancelling is
// NOT simply the return premium. The earned premium is the premium billed less the return premium; the customer has paid
// some amount; the refund is only what they paid beyond the earned premium (in cash, never more than they paid), and what
// is short is arrears that they still owe. Future invoices that were never paid are voided.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// A monthly-plan policy from 2026-03-01 (six invoices, due the first of each month), cancelled at the insured's request
// effective 2026-04-15, after the customer has paid `paid` dollars.
function cancelled(paid) {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.updateDraft(job.id, { paymentPlan: 'Monthly' }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(job.policyId);
  const billing = new Billing(pc);
  env.setToday('2026-04-01');
  if (paid > 0) run(() => billing.receivePayment(users.uwm, { policyId: policy.id, amount: paid, method: 'Cheque', reference: 'CHQ-1', receivedOn: '2026-04-01' }));
  const billed = round2(pc.db.invoices.filter((i) => i.policyId === policy.id && i.amount > 0).reduce((s, i) => s + i.amount + i.fee, 0));
  const cancel = run(() => pc.startCancellation(policy.id, { effectiveDate: '2026-04-15', reason: 'InsuredRequest' }, users.agent));
  const returnPremium = -cancel.quote.changeAmount;
  run(() => pc.bind(cancel.id, users.uw));
  return { ...env, policy, billing, billed, returnPremium, settlement: pc.policy(policy.id).cancellation.settlement };
}

test('the settlement is a pure sum: refund is what was paid beyond the earned premium, arrears is what is still short', () => {
  assert.deepEqual(settleCancellation({ billed: 1000, paid: 1000, returnPremium: 400 }), { billed: 1000, paid: 1000, returnPremium: 400, earned: 600, refundDue: 400, arrears: 0 });
  assert.deepEqual(settleCancellation({ billed: 1000, paid: 0, returnPremium: 400 }), { billed: 1000, paid: 0, returnPremium: 400, earned: 600, refundDue: 0, arrears: 600 });
  assert.deepEqual(settleCancellation({ billed: 1000, paid: 700, returnPremium: 400 }), { billed: 1000, paid: 700, returnPremium: 400, earned: 600, refundDue: 100, arrears: 0 });
  assert.deepEqual(settleCancellation({ billed: 1000, paid: 500, returnPremium: 400 }), { billed: 1000, paid: 500, returnPremium: 400, earned: 600, refundDue: 0, arrears: 100 });
});

test('paid in full: the refund equals the return premium', () => {
  const probe = cancelled(0);
  const env = cancelled(probe.billed);
  assert.equal(env.settlement.paid, env.billed);
  assert.equal(env.settlement.refundDue, env.returnPremium);
  assert.equal(env.settlement.arrears, 0);
  const refunds = env.pc.db.refunds;
  assert.equal(refunds.length, 1);
  assert.deepEqual([refunds[0].amount, refunds[0].status, refunds[0].policyId], [env.returnPremium, 'Due', env.policy.id]);
});

test('paid nothing: no refund at all, and the customer still owes the earned premium', () => {
  const env = cancelled(0);
  assert.equal(env.settlement.refundDue, 0);
  assert.equal(env.pc.db.refunds.length, 0);
  assert.equal(env.settlement.arrears, round2(env.billed - env.returnPremium));
});

test('part paid: only what was paid beyond the earned premium is refunded; the rest is arrears', () => {
  const probe = cancelled(0);
  const earned = round2(probe.billed - probe.returnPremium);
  // Paid a little more than the earned premium: a small refund.
  const more = cancelled(round2(earned + 50));
  assert.equal(more.settlement.refundDue, 50);
  assert.equal(more.settlement.arrears, 0);
  // Paid a little less: no refund, and the shortfall is owed.
  const less = cancelled(round2(earned - 50));
  assert.equal(less.settlement.refundDue, 0);
  assert.equal(less.settlement.arrears, 50);
});

test('invoices that were never paid and fall due after the cancellation date are voided; paid ones are left', () => {
  const env = cancelled(100);
  const invoices = env.billing.invoicesFor(env.policy.id, env.users.uwm).filter((i) => i.amount > 0);
  const after = invoices.filter((i) => i.dueDate >= '2026-04-15');
  assert.ok(after.length > 0);
  assert.ok(after.every((i) => i.paymentStatus === 'Void' && i.balance === 0));
  assert.ok(invoices.filter((i) => i.dueDate < '2026-04-15').every((i) => i.paymentStatus !== 'Void'));
});

test('the ledger lists charges, payments, the return premium and the refund with a running balance that ends at zero', () => {
  const probe = cancelled(0);
  const env = cancelled(probe.billed);
  const manager = env.users.uwm;
  const before = env.billing.ledgerFor(env.policy.id, manager);
  assert.ok(before.entries.some((e) => e.type === 'return_premium'));
  assert.equal(before.balance, -env.returnPremium); // the customer is owed the refund that has not been issued yet

  const refund = env.pc.db.refunds[0];
  env.run(() => env.billing.issueRefund(manager, refund.id, { method: 'Bank transfer', reference: 'REF-1', paidOn: '2026-04-20' }));
  const after = env.billing.ledgerFor(env.policy.id, manager);
  assert.ok(after.entries.some((e) => e.type === 'refund'));
  assert.equal(after.balance, 0);
  assert.deepEqual([...new Set(after.entries.map((e) => e.type))].sort(), ['charge', 'payment', 'refund', 'return_premium']);
});

test('a refund is issued by a UW manager, once, for the amount due, and is announced as an event', () => {
  const probe = cancelled(0);
  const env = cancelled(probe.billed);
  const [refund] = env.pc.db.refunds;
  const input = { method: 'Bank transfer', reference: 'REF-2', paidOn: '2026-04-20' };
  assert.throws(() => env.run(() => env.billing.issueRefund(env.users.uw, refund.id, input)), (e) => e.status === 403);
  assert.throws(() => env.run(() => env.billing.issueRefund(env.users.uwm, refund.id, { ...input, method: 'Barter' })), (e) => e.status === 422);
  const issued = env.run(() => env.billing.issueRefund(env.users.uwm, refund.id, input));
  assert.deepEqual([issued.status, issued.issuedBy, issued.reference], ['Issued', env.users.uwm.id, 'REF-2']);
  assert.throws(() => env.run(() => env.billing.issueRefund(env.users.uwm, refund.id, { ...input, reference: 'REF-3' })), (e) => e.status === 409);
  assert.ok(env.pc.db.events.some((e) => e.type === 'RefundIssued' && e.payload.amount === refund.amount));
});

test('reinstating the policy withdraws a refund that has not been issued and brings the voided invoices back', () => {
  const probe = cancelled(0);
  const env = cancelled(probe.billed);
  const { pc, users, run, policy, billing } = env;
  assert.equal(pc.db.refunds[0].status, 'Due');
  env.setToday('2026-04-20');
  const job = run(() => pc.startReinstatement(policy.id, users.uwm));
  run(() => pc.bind(job.id, users.uwm));
  assert.equal(pc.db.refunds[0].status, 'Withdrawn');
  assert.ok(billing.invoicesFor(policy.id, users.uwm).filter((i) => i.amount > 0).every((i) => i.paymentStatus !== 'Void'));
});
