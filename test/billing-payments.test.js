'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Billing } = require('../src/billing');

// Payments, allocation and missed payments (ported from the Insurance Suite billing module). A payment is applied to
// the oldest invoice first; what is left over stays as a credit; a missed payment goes through steps (notice, then a
// request to cancel for non-payment) taken from DELINQUENCY_STEPS, never decided by the code of the caller.

// A bound policy on the Monthly plan: six invoices, the first due on the effective date, 2026-03-01.
function monthlyPolicy() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.updateDraft(job.id, { paymentPlan: 'Monthly' }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(job.policyId);
  const billing = new Billing(pc);
  const invoices = () => billing.invoicesFor(policy.id, users.uwm);
  const pay = (amount, extra = {}) => run(() => billing.receivePayment(users.uwm, { policyId: policy.id, amount, method: 'Cheque', reference: `CHQ-${Math.random()}`, receivedOn: env.pc.today(), ...extra }));
  return { ...env, acct, policy, billing, invoices, pay };
}

const total = (i) => Math.round((i.amount + i.fee) * 100) / 100;

test('a payment is applied to the oldest invoice first, and a part payment leaves the rest owing', () => {
  const { invoices, pay } = monthlyPolicy();
  const [first, second] = invoices();
  const result = pay(total(first) + 10);
  assert.deepEqual(result.allocations.map((a) => [a.invoiceNumber, a.amount]), [[first.invoiceNumber, total(first)], [second.invoiceNumber, 10]]);
  assert.equal(result.unapplied, 0);

  const [a, b, c] = invoices();
  assert.equal(a.paymentStatus, 'Paid');
  assert.equal(a.balance, 0);
  assert.equal(b.paymentStatus, 'Part paid');
  assert.equal(b.paid, 10);
  assert.equal(b.balance, Math.round((total(second) - 10) * 100) / 100);
  assert.equal(c.paymentStatus, 'Unpaid');
});

test('what is left after every invoice is paid stays as a credit on the policy, and is never lost', () => {
  const { invoices, pay, billing, policy, users } = monthlyPolicy();
  const owed = invoices().reduce((s, i) => s + total(i), 0);
  const result = pay(Math.round((owed + 50) * 100) / 100);
  assert.equal(result.unapplied, 50);
  assert.ok(invoices().every((i) => i.paymentStatus === 'Paid'));
  assert.equal(billing.creditFor(policy.id, users.uwm), 50);
});

test('an invoice past its due date and not paid is Overdue; paying it clears that', () => {
  const { invoices, pay, setToday } = monthlyPolicy();
  setToday('2026-03-20'); // the first invoice was due 2026-03-01, the second 2026-04-01
  assert.equal(invoices()[0].paymentStatus, 'Overdue');
  assert.equal(invoices()[1].paymentStatus, 'Unpaid');
  pay(total(invoices()[0]));
  assert.equal(invoices()[0].paymentStatus, 'Paid');
});

test('only a UW manager takes payments, and a payment must make sense', () => {
  const { pc, users, policy, billing, run } = monthlyPolicy();
  const input = { policyId: policy.id, amount: 100, method: 'Cheque', reference: 'CHQ-1', receivedOn: '2026-03-01' };
  assert.throws(() => run(() => billing.receivePayment(users.agent, input)), (e) => e.status === 403);
  assert.throws(() => run(() => billing.receivePayment(users.uw, input)), (e) => e.status === 403);
  assert.throws(() => run(() => billing.receivePayment(users.uwm, { ...input, amount: 0 })), (e) => e.status === 422);
  assert.throws(() => run(() => billing.receivePayment(users.uwm, { ...input, amount: 'ten' })), (e) => e.status === 422);
  assert.throws(() => run(() => billing.receivePayment(users.uwm, { ...input, method: 'Bitcoin' })), (e) => e.status === 422);
  assert.throws(() => run(() => billing.receivePayment(users.uwm, { ...input, receivedOn: '03/01/2026' })), (e) => e.status === 422);
  assert.throws(() => run(() => billing.receivePayment(users.uwm, { ...input, policyId: 'nope' })), (e) => e.status === 404);
  assert.equal(pc.db.payments.length, 0); // nothing was saved by a refused payment
});

test('the same reference for the same policy cannot be entered twice (a double click or a repeated request)', () => {
  const { pay, billing, policy, users, pc } = monthlyPolicy();
  pay(100, { reference: 'CHQ-7' });
  assert.throws(() => pay(100, { reference: 'CHQ-7' }), (e) => e.status === 422 && /already/i.test(e.message));
  assert.equal(billing.paymentsFor(policy.id, users.uwm).length, 1);
  assert.equal(pc.db.events.filter((e) => e.type === 'PaymentReceived').length, 1);
});

test('a payment is recorded with who took it, is announced as an event, and is never changed', () => {
  const { pay, pc, users, billing, policy } = monthlyPolicy();
  const result = pay(250, { reference: 'CHQ-9' });
  assert.match(result.paymentNumber, /^PAY-\d{7}$/);
  const [payment] = billing.paymentsFor(policy.id, users.uwm);
  assert.deepEqual({ amount: payment.amount, by: payment.receivedBy, method: payment.method }, { amount: 250, by: users.uwm.id, method: 'Cheque' });
  const event = pc.db.events.find((e) => e.type === 'PaymentReceived');
  assert.deepEqual(event.payload, { policyNumber: pc.policy(policy.id).policyNumber, paymentNumber: result.paymentNumber, amount: 250, receivedOn: pc.today() });
});

test('a missed payment: a notice after the grace days, then a request to cancel for non-payment, each only once', () => {
  const { billing, users, run, pc, policy } = monthlyPolicy();
  // The first invoice (due 2026-03-01) is unpaid. Day 3: still inside the grace days.
  assert.deepEqual(run(() => billing.runDelinquency(users.uwm, { asOf: '2026-03-04' })), []);

  // Day 6: a notice.
  const notice = run(() => billing.runDelinquency(users.uwm, { asOf: '2026-03-07' }));
  assert.deepEqual(notice.map((r) => r.step), ['notice']);
  assert.equal(pc.db.events.filter((e) => e.type === 'PaymentMissed').length, 1);
  // Running it again the same day changes nothing.
  assert.deepEqual(run(() => billing.runDelinquency(users.uwm, { asOf: '2026-03-07' })), []);
  assert.equal(pc.db.events.filter((e) => e.type === 'PaymentMissed').length, 1);

  // Day 16: a cancellation for non-payment is started, with the notice days the reason needs. A person still binds it.
  const cancel = run(() => billing.runDelinquency(users.uwm, { asOf: '2026-03-17' }));
  assert.deepEqual(cancel.map((r) => [r.step, r.outcome]), [['cancellation_request', 'cancellation_started']]);
  const job = pc.db.jobs.find((j) => j.type === 'Cancellation');
  assert.equal(job.status, 'Quoted');
  assert.equal(job.cancellation.reason, 'NonPayment');
  assert.equal(job.cancellation.effectiveDate, '2026-03-27'); // today + 10 notice days
  assert.ok(pc.db.events.some((e) => e.type === 'CancellationRequested' && e.payload.policyNumber === pc.policy(policy.id).policyNumber));
  assert.deepEqual(run(() => billing.runDelinquency(users.uwm, { asOf: '2026-03-17' })), []);
});

test('a policy whose overdue invoice was paid is left alone, and a policy with a job open is skipped with the reason', () => {
  const { billing, users, run, invoices, pay, pc, policy } = monthlyPolicy();
  pay(total(invoices()[0]));
  assert.deepEqual(run(() => billing.runDelinquency(users.uwm, { asOf: '2026-03-17' })), []);

  // Second invoice unpaid and overdue by 16 days, but an agent has a change open on the policy.
  run(() => pc.startPolicyChange(policy.id, { effectiveDate: '2026-04-20' }, users.agent));
  const results = run(() => billing.runDelinquency(users.uwm, { asOf: '2026-04-17' }));
  assert.deepEqual(results.map((r) => [r.step, r.outcome]), [['notice', 'notice_sent'], ['cancellation_request', 'skipped']]);
  assert.match(results[1].reason, /open/i);
});

test('only a UW manager runs the missed-payment check', () => {
  const { billing, users, run } = monthlyPolicy();
  assert.throws(() => run(() => billing.runDelinquency(users.uw, { asOf: '2026-03-17' })), (e) => e.status === 403);
});

// ---- a late payment after a cancellation for non-payment

// The first invoice (due 2026-03-01) is not paid; a cancellation for non-payment is started on 2026-03-17 (effective
// 2026-03-27) and bound by the manager.
function cancelledForNonPayment() {
  const env = monthlyPolicy();
  const { billing, users, run, pc, setToday } = env;
  setToday('2026-03-17');
  run(() => billing.runDelinquency(users.uwm, { asOf: '2026-03-17' }));
  const job = pc.db.jobs.find((j) => j.type === 'Cancellation');
  run(() => pc.bind(job.id, users.uwm));
  assert.equal(pc.policy(env.policy.id).cancellation.reason, 'NonPayment');
  return env;
}

test('a late payment that clears what was owed starts a reinstatement, which a person still binds', () => {
  const { setToday, invoices, pay, pc, policy } = cancelledForNonPayment();
  setToday('2026-04-05');
  const result = pay(total(invoices()[0]));
  assert.equal(result.reinstatement.outcome, 'reinstatement_started');
  const job = pc.db.jobs.find((j) => j.type === 'Reinstatement');
  assert.equal(job.status, 'Quoted');
  assert.equal(job.policyId, policy.id);
  assert.ok(pc.db.events.some((e) => e.type === 'ReinstatementRequested' && e.payload.policyNumber === pc.policy(policy.id).policyNumber));
});

test('no reinstatement for a part payment, a payment after the time limit, a policy cancelled for another reason, or when a job is open', () => {
  // A part payment: what was owed is not cleared.
  let env = cancelledForNonPayment();
  env.setToday('2026-04-05');
  assert.equal(env.pay(10).reinstatement.outcome, 'not_cleared');

  // After the 30 days from the cancellation date (2026-03-27): 2026-04-26 is the last day.
  env = cancelledForNonPayment();
  env.setToday('2026-04-27');
  assert.equal(env.pay(total(env.invoices()[0])).reinstatement.outcome, 'too_late');

  // A cancellation at the insured's request is not undone by a payment.
  env = monthlyPolicy();
  env.run(() => env.pc.startCancellation(env.policy.id, { effectiveDate: '2026-03-20', reason: 'InsuredRequest' }, env.users.uwm));
  env.run(() => env.pc.bind(env.pc.db.jobs.find((j) => j.type === 'Cancellation').id, env.users.uwm));
  assert.equal(env.pay(total(env.invoices()[0])).reinstatement, null);

  // A policy that is in force has nothing to reinstate.
  env = monthlyPolicy();
  assert.equal(env.pay(50).reinstatement, null);

  // A reinstatement job already open: skipped with the reason.
  env = cancelledForNonPayment();
  env.setToday('2026-04-05');
  env.run(() => env.pc.startReinstatement(env.policy.id, env.users.uwm));
  const result = env.pay(total(env.invoices()[0]));
  assert.equal(result.reinstatement.outcome, 'skipped');
  assert.match(result.reinstatement.reason, /open/i);
});
