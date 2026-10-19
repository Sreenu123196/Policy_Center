'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Billing } = require('../src/billing');
const { ClaimMoney } = require('../src/claimMoney');
const { Reports } = require('../src/reports');

// Management reports for the billing, refund and claim-approval features: who is behind on payments, what is owed to
// and by cancelled customers, and which claim payments wait for a second person.

function world() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.updateDraft(job.id, { paymentPlan: 'Monthly' }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(job.policyId);
  return { ...env, acct, policy, billing: new Billing(pc), money: new ClaimMoney(pc), reports: new Reports(pc, new Billing(pc)) };
}

const pay = (env, amount, reference = 'CHQ-1') => env.run(() => env.billing.receivePayment(env.users.uwm, { policyId: env.policy.id, amount, method: 'Cheque', reference, receivedOn: env.pc.today() }));

test('collections report: policies with overdue invoices, how late, how much, and which step was taken', () => {
  const env = world();
  const { reports, users, billing, run, policy } = env;
  assert.deepEqual(reports.collections(users.uwm, { asOf: '2026-03-01' }).policies, []); // nothing is overdue on the due date itself

  let report = reports.collections(users.uwm, { asOf: '2026-03-17' });
  assert.equal(report.policies.length, 1);
  const [row] = report.policies;
  assert.deepEqual([row.policyNumber, row.daysOverdue, row.oldestDueDate, row.overdueInvoices, row.stage], [policy.policyNumber, 16, '2026-03-01', 1, 'none']);
  assert.ok(row.balance > 0);
  assert.deepEqual(report.buckets['1-30'], { policies: 1, balance: row.balance });
  assert.equal(report.total, row.balance);

  run(() => billing.runDelinquency(users.uwm, { asOf: '2026-03-17' }));
  assert.equal(reports.collections(users.uwm, { asOf: '2026-03-17' }).policies[0].stage, 'cancellation_request');

  // Later it falls into an older bucket; once paid it is gone.
  report = reports.collections(users.uwm, { asOf: '2026-05-20' });
  assert.ok(report.buckets['61+'].policies === 1);
  env.setToday('2026-05-20');
  pay(env, 1e6 / 100); // far more than is owed
  assert.deepEqual(reports.collections(users.uwm, { asOf: '2026-05-20' }).policies, []);
});

test('collections report is for UW managers only, and a bad date is refused', () => {
  const { reports, users } = world();
  for (const who of [users.agent, users.uw]) assert.throws(() => reports.collections(who, { asOf: '2026-03-17' }), (e) => e.status === 403);
  assert.throws(() => reports.collections(users.uwm, { asOf: '17/03/2026' }), (e) => e.status === 422);
});

test('refund report: refunds by status, and what cancelled customers still owe', () => {
  const env = world();
  const { pc, users, run, policy, billing, reports } = env;
  env.setToday('2026-04-01');
  const billed = pc.db.invoices.filter((i) => i.policyId === policy.id && i.amount > 0).reduce((s, i) => s + i.amount + i.fee, 0);
  pay(env, Math.round(billed * 100) / 100);
  const cancel = run(() => pc.startCancellation(policy.id, { effectiveDate: '2026-04-15', reason: 'InsuredRequest' }, users.agent));
  run(() => pc.bind(cancel.id, users.uw));

  let report = reports.refunds(users.uwm);
  assert.equal(report.refunds.length, 1);
  assert.deepEqual([report.refunds[0].status, report.refunds[0].policyNumber], ['Due', policy.policyNumber]);
  assert.equal(report.byStatus.Due.count, 1);
  assert.equal(report.byStatus.Due.amount, report.refunds[0].amount);
  assert.deepEqual(report.arrears, []);

  run(() => billing.issueRefund(users.uwm, pc.db.refunds[0].id, { method: 'Bank transfer', reference: 'REF-1', paidOn: '2026-04-20' }));
  report = reports.refunds(users.uwm);
  assert.equal(report.byStatus.Issued.count, 1);
  assert.equal(report.byStatus.Due.count, 0);
});

test('refund report lists a cancelled customer who still owes money, and totals it', () => {
  const env = world();
  const { pc, users, run, policy, reports } = env;
  env.setToday('2026-04-01');
  const cancel = run(() => pc.startCancellation(policy.id, { effectiveDate: '2026-04-15', reason: 'InsuredRequest' }, users.agent));
  run(() => pc.bind(cancel.id, users.uw));
  const report = reports.refunds(users.uwm);
  assert.equal(report.refunds.length, 0);
  assert.equal(report.arrears.length, 1);
  assert.deepEqual([report.arrears[0].policyNumber, report.arrears[0].cancelledOn], [policy.policyNumber, '2026-04-15']);
  assert.equal(report.arrears[0].owed, pc.policy(policy.id).cancellation.settlement.arrears);
  assert.equal(report.totalArrears, report.arrears[0].owed);
  assert.throws(() => reports.refunds(users.uw), (e) => e.status === 403);
});

test('claim approvals report: payments waiting for a second person, oldest first, for underwriters and managers', () => {
  const env = world();
  const { pc, users, run, policy, money, reports } = env;
  env.setToday('2026-03-15');
  const claim = run(() => pc.openClaim(policy.id, { lossDate: '2026-03-10', lossType: 'Collision' }, users.agent));
  run(() => pc.moveClaim(claim.id, { to: 'Under Review' }, users.uw));
  run(() => money.addExposure(users.uw, claim.id, { coverage: 'Collision', claimantName: 'Asha', claimantKind: 'insured' }));
  run(() => money.setExposureReserve(users.uwm, claim.id, 1, 40000));
  run(() => pc.moveClaim(claim.id, { to: 'Approved' }, users.uw));
  assert.deepEqual(reports.claimApprovals(users.uw).pending, []);

  const pending = run(() => money.payExposure(users.uw, claim.id, 1, { amount: 8000, costType: 'claim_cost' }));
  env.setToday('2026-03-18');
  let report = reports.claimApprovals(users.uwm);
  assert.equal(report.pending.length, 1);
  assert.deepEqual([report.pending[0].claimNumber, report.pending[0].amount, report.pending[0].requestedBy, report.pending[0].ageDays], [claim.claimNumber, 8000, users.uw.id, 3]);
  assert.equal(report.pendingTotal, 8000);
  assert.equal(reports.claimApprovals(users.uw).pending.length, 1); // underwriters may see the queue

  run(() => money.approvePayment(users.uwm, claim.id, pending.id));
  report = reports.claimApprovals(users.uwm);
  assert.deepEqual(report.pending, []);
  assert.deepEqual([report.approved.count, report.approved.amount], [1, 8000]);

  for (const who of [users.agent, pc.user('venkatesh')]) assert.throws(() => reports.claimApprovals(who), (e) => e.status === 403);
});
