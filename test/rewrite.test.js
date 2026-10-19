'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, driver } = require('./helpers');
const { Billing } = require('../src/billing');

// Rewrite (Tier 3, item 10). A cancelled policy can be replaced by a NEW policy for the same customer and risk, linked to
// the old one. It is priced and underwritten as new business on the date it starts, cannot start before the old policy was
// cancelled, and a gap in cover is remembered (it ends the claim-free discount and, for a two-wheeler, answers the lapse
// question). Where the old policy was cancelled for non-payment, the unpaid premium has to be paid first.

const NO = { modified: 'no', racing: 'no', priorLapse: 'no', licenseSuspended: 'no', keptOutdoors: 'no' };
const rider = driver({ firstName: 'Ravi', lastName: 'Kumar', dob: '1992-04-10', yearsLicensed: 8 });
const bike = { year: 2022, make: 'Honda', model: 'CB300', vin: '1HGCM82633A123456', engineCc: 300, bikeType: 'Commuter', usage: 'Commute', annualMiles: 6000, marketValue: 5000, garagingZip: '43215' };

// A two-wheeler policy from 2026-03-01 on the quarterly plan, cancelled with the given reason on the given date.
function cancelled({ reason = 'InsuredRequest', on = '2026-04-15', plan = 'Quarterly' } = {}) {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => pc.startSubmission({ accountId: acct.id, product: 'TwoWheeler', effectiveDate: '2026-03-01' }, users.agent));
  run(() => pc.updateDraft(job.id, { paymentPlan: plan, line: { ...job.period.line, drivers: [rider], vehicles: [bike], answers: NO } }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(pc.job(job.id).policyId);
  env.setToday('2026-04-01');
  const cancel = run(() => pc.startCancellation(policy.id, { effectiveDate: on, reason }, users.agent));
  run(() => pc.bind(cancel.id, users.uw));
  return { ...env, acct, policy: pc.policy(policy.id) };
}

const rewrite = (env, input = {}, user = env.users.uw) => env.run(() => env.pc.startRewrite(env.policy.id, input, user));

test('only a cancelled policy can be rewritten, by an underwriter, and not while another job is open', () => {
  const env = cancelled();
  const { pc, users, run } = env;
  assert.throws(() => rewrite(env, {}, users.agent), (e) => e.status === 403);
  // A policy in force cannot be rewritten.
  const inForce = setup('2026-03-01');
  const acct = inForce.run(() => account(inForce.pc, inForce.users.agent));
  const j = inForce.run(() => inForce.pc.startSubmission({ accountId: acct.id, product: 'TwoWheeler', effectiveDate: '2026-03-01' }, inForce.users.agent));
  inForce.run(() => inForce.pc.updateDraft(j.id, { line: { ...j.period.line, drivers: [rider], vehicles: [bike], answers: NO } }, inForce.users.agent));
  inForce.run(() => inForce.pc.quote(j.id, inForce.users.agent));
  inForce.run(() => inForce.pc.bind(j.id, inForce.users.agent));
  assert.throws(() => inForce.run(() => inForce.pc.startRewrite(inForce.pc.job(j.id).policyId, {}, inForce.users.uw)), (e) => e.status === 409 && /cancelled/i.test(e.message));
  // One rewrite at a time.
  const first = rewrite(env);
  assert.throws(() => rewrite(env), (e) => e.status === 409);
  assert.equal(first.status, 'Draft');
  void pc; void run;
});

test('the rewrite is a new-business job copied from the old policy, starting when the old one was cancelled', () => {
  const env = cancelled();
  const job = rewrite(env, { effectiveDate: '2026-04-15' });
  assert.equal(job.type, 'Submission');
  assert.deepEqual(job.rewrite, { fromPolicyNumber: env.policy.policyNumber, cancelledOn: '2026-04-15', gapDays: 0 });
  assert.deepEqual([job.period.effectiveDate, job.period.expirationDate, job.period.termNumber, job.policyId], ['2026-04-15', '2027-04-15', 1, null]);
  assert.deepEqual([job.period.line.vehicles[0].vin, job.period.line.drivers[0].lastName], [bike.vin, 'Kumar']);
  // Defaults to the day the old policy was cancelled, or today if that is later.
  const later = cancelled({ on: '2026-04-05' });
  later.setToday('2026-05-01');
  assert.equal(rewrite(later).period.effectiveDate, '2026-05-01');
});

test('binding it makes a new policy, linked both ways, and the old policy stays as it was', () => {
  const env = cancelled();
  const { pc, users, run, policy } = env;
  const job = rewrite(env, { effectiveDate: '2026-04-15' });
  run(() => pc.quote(job.id, users.uw));
  run(() => pc.bind(job.id, users.uw));
  const fresh = pc.policy(pc.job(job.id).policyId);
  assert.notEqual(fresh.policyNumber, policy.policyNumber);
  assert.match(fresh.policyNumber, /^TW-\d{7}$/);
  assert.equal(fresh.rewrittenFrom, policy.policyNumber);
  assert.equal(pc.policy(policy.id).rewrittenTo, fresh.policyNumber);
  assert.ok(pc.policy(policy.id).cancellation, 'the old policy is still cancelled');
  assert.equal(pc.db.invoices.filter((i) => i.policyId === fresh.id && i.amount > 0).length, 4);
  const issued = pc.db.events.filter((e) => e.type === 'PolicyIssued').at(-1);
  assert.equal(issued.payload.rewrittenFrom, policy.policyNumber);
  // A rewritten policy cannot be reinstated, and cannot be rewritten again.
  assert.throws(() => run(() => pc.startReinstatement(policy.id, users.uwm)), (e) => e.status === 409 && /rewritten/i.test(e.message));
  assert.throws(() => rewrite(env), (e) => e.status === 409 && /already/i.test(e.message));
});

test('the start date cannot be before the old policy was cancelled, nor more than 30 days away', () => {
  const env = cancelled();
  assert.throws(() => rewrite(env, { effectiveDate: '2026-04-14' }), (e) => e.status === 422 && /cancelled/i.test(e.message));
  assert.throws(() => rewrite(env, { effectiveDate: '2026-06-15' }), (e) => e.status === 422 && /30 days/.test(e.message));
  assert.throws(() => rewrite(env, { effectiveDate: 'soon' }), (e) => e.status === 422);
  const job = rewrite(env, { effectiveDate: '2026-04-20' });
  assert.throws(() => env.run(() => env.pc.updateDraft(job.id, { effectiveDate: '2026-04-01' }, env.users.uw)), (e) => e.status === 422 && /cancelled/i.test(e.message));
});

test('a policy cancelled for non-payment is rewritten only after the unpaid premium is paid', () => {
  const env = cancelled({ reason: 'NonPayment', on: '2026-04-15' });
  const { pc, users, run, policy } = env;
  assert.throws(() => rewrite(env), (e) => e.status === 422 && /pay/i.test(e.message));
  const billing = new Billing(pc);
  const owed = pc.db.invoices.filter((i) => i.policyId === policy.id && i.amount > 0 && i.dueDate <= '2026-04-15' && !i.voided).reduce((s, i) => s + i.amount + i.fee - (i.paid || 0), 0);
  run(() => billing.receivePayment(users.uwm, { policyId: policy.id, amount: Math.round(owed * 100) / 100, method: 'Cheque', reference: 'ARREARS', receivedOn: '2026-04-20' }));
  // Paying a cancelled-for-non-payment policy in full also offers a reinstatement; the person chooses a rewrite instead.
  const offered = pc.db.jobs.find((j) => j.type === 'Reinstatement' && j.status === 'Quoted');
  assert.ok(offered, 'the payment started a reinstatement');
  run(() => pc.withdraw(offered.id, users.uw));
  assert.equal(rewrite(env, { effectiveDate: '2026-04-20' }).status, 'Draft');
});

test('a gap of more than 30 days ends the claim-free discount and, for a two-wheeler, answers the lapse question', () => {
  const env = cancelled({ on: '2026-04-05' });
  env.setToday('2026-06-01'); // 57 days after the cancellation
  const job = rewrite(env, { effectiveDate: '2026-06-01' });
  assert.equal(job.rewrite.gapDays, 57);
  assert.equal(job.period.line.answers.priorLapse, 'yes');
  assert.equal(job.period.line.claimFreeRenewals, 0);
  env.run(() => env.pc.quote(job.id, env.users.uw));
  assert.ok(env.pc.job(job.id).uwIssues.some((i) => i.code === 'TW_PRIOR_LAPSE'), 'the lapse needs an underwriter');

  // No gap: the answer stays as it was.
  const none = cancelled({ on: '2026-04-05' });
  assert.equal(rewrite(none, { effectiveDate: '2026-04-05' }).period.line.answers.priorLapse, 'no');
});

test('claims stay with the policy they were made on, and the new policy starts with none', () => {
  const env = cancelled();
  const { pc, users, run, policy } = env;
  env.setToday('2026-04-10');
  run(() => pc.openClaim(policy.id, { lossDate: '2026-04-05', lossType: 'Collision' }, users.agent));
  const job = rewrite(env, { effectiveDate: '2026-04-15' });
  run(() => pc.quote(job.id, users.uw));
  run(() => pc.bind(job.id, users.uw));
  const fresh = pc.policy(pc.job(job.id).policyId);
  assert.equal(pc.db.claims.filter((c) => c.policyId === fresh.id).length, 0);
  assert.equal(pc.db.claims.filter((c) => c.policyId === policy.id).length, 1);
});
