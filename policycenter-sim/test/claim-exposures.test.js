'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { ClaimMoney, RESERVE_LIMITS, PAYMENT_LIMITS } = require('../src/claimMoney');

// Claim exposures, reserves and payments with financial authority (ported from the Insurance Suite claims module).
// An exposure is one claimant against one cover (own damage, a third party's motorcycle). Reserves and payments belong to
// an exposure. A person can set a reserve or make a payment only up to their limit; a payment above the limit waits for a
// different person whose limit is high enough. The claim-level reserve and payments stay as the totals, so the older
// screens, reports and messages keep working.

function claim() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(job.policyId);
  const c = run(() => pc.openClaim(policy.id, { lossDate: '2026-03-01', lossType: 'Collision' }, users.agent));
  run(() => pc.moveClaim(c.id, { to: 'Under Review' }, users.uw));
  const money = new ClaimMoney(pc);
  const exposure = (input = {}) => run(() => money.addExposure(users.uw, c.id, { coverage: 'Collision', claimantName: 'Asha Rao', claimantKind: 'insured', description: 'Own car', ...input }));
  const approve = () => run(() => pc.moveClaim(c.id, { to: 'Approved' }, users.uw));
  return { ...env, claim: c, money, exposure, approve };
}

test('an exposure is added by staff to a claim under review, with a number, a claimant and a cover', () => {
  const { money, exposure, users, run, claim: c, pc } = claim();
  const first = exposure();
  const second = exposure({ coverage: 'Liability', claimantName: 'Ravi Kumar', claimantKind: 'third_party', description: 'A motorcycle' });
  assert.deepEqual([first.number, second.number], [1, 2]);
  assert.equal(pc.claim(c.id).exposures.length, 2);
  assert.ok(pc.db.events.some((e) => e.type === 'ClaimExposureAdded' && e.payload.claimNumber === c.claimNumber));

  assert.throws(() => run(() => money.addExposure(users.agent, c.id, { coverage: 'Collision', claimantName: 'X', claimantKind: 'insured' })), (e) => e.status === 403);
  for (const bad of [{ coverage: '' }, { claimantName: ' ' }, { claimantKind: 'neighbour' }]) {
    assert.throws(() => exposure(bad), (e) => e.status === 422);
  }
  // A claim that has only been submitted cannot take exposures yet.
  const submitted = run(() => pc.openClaim(c.policyId, { lossDate: '2026-03-01', lossType: 'Theft' }, users.agent));
  assert.throws(() => run(() => money.addExposure(users.uw, submitted.id, { coverage: 'Theft', claimantName: 'X', claimantKind: 'insured' })), (e) => e.status === 409);
});

test('a reserve belongs to an exposure; the claim reserve is their total and every change is kept', () => {
  const { money, exposure, users, run, claim: c, pc } = claim();
  exposure();
  exposure({ coverage: 'Liability', claimantName: 'Ravi Kumar', claimantKind: 'third_party' });
  run(() => money.setExposureReserve(users.uw, c.id, 1, 4000));
  run(() => money.setExposureReserve(users.uw, c.id, 2, 1500));
  run(() => money.setExposureReserve(users.uw, c.id, 1, 5000));
  assert.equal(pc.claim(c.id).reserve, 6500);
  assert.deepEqual(pc.claim(c.id).reserveChanges.map((r) => [r.exposure, r.from, r.to]), [[1, 0, 4000], [2, 0, 1500], [1, 4000, 5000]]);

  // The old claim-level reserve is not used once there are exposures.
  assert.throws(() => run(() => pc.setClaimReserve(c.id, 100, users.uw)), (e) => e.status === 409 && /exposure/i.test(e.message));
  assert.throws(() => run(() => money.setExposureReserve(users.uw, c.id, 9, 100)), (e) => e.status === 404);
  assert.throws(() => run(() => money.setExposureReserve(users.uw, c.id, 1, -5)), (e) => e.status === 422);
});

test('a reserve above your authority is refused; a manager can set it', () => {
  const { money, exposure, users, run, claim: c } = claim();
  exposure();
  const tooBig = RESERVE_LIMITS[1] + 1;
  assert.throws(() => run(() => money.setExposureReserve(users.uw, c.id, 1, tooBig)), (e) => e.status === 403 && /authority/i.test(e.message));
  assert.doesNotThrow(() => run(() => money.setExposureReserve(users.uwm, c.id, 1, tooBig)));
  assert.throws(() => run(() => money.setExposureReserve(users.uwm, c.id, 1, RESERVE_LIMITS[2] + 1)), (e) => e.status === 403);
});

test('a payment within your limit is issued at once, and never exceeds the exposure reserve or goes below zero', () => {
  const { money, exposure, users, run, claim: c, approve, pc } = claim();
  exposure();
  run(() => money.setExposureReserve(users.uw, c.id, 1, 3000));
  // Not approved yet: nothing can be paid.
  assert.throws(() => run(() => money.payExposure(users.uw, c.id, 1, { amount: 100, costType: 'claim_cost' })), (e) => e.status === 409);
  approve();
  const result = run(() => money.payExposure(users.uw, c.id, 1, { amount: 1200, costType: 'claim_cost', note: 'Repair' }));
  assert.equal(result.status, 'issued');
  assert.equal(pc.claimView(pc.claim(c.id), users.uw).paid, 1200);
  assert.deepEqual(pc.claim(c.id).payments.map((p) => [p.exposureNumber, p.costType, p.amount]), [[1, 'claim_cost', 1200]]);

  assert.throws(() => run(() => money.payExposure(users.uw, c.id, 1, { amount: 1801, costType: 'claim_cost' })), (e) => e.status === 422 && /reserve/i.test(e.message));
  assert.throws(() => run(() => money.payExposure(users.uw, c.id, 1, { amount: 0, costType: 'claim_cost' })), (e) => e.status === 422);
  assert.throws(() => run(() => money.payExposure(users.uw, c.id, 1, { amount: 10, costType: 'gift' })), (e) => e.status === 422);
  assert.throws(() => run(() => money.payExposure(users.agent, c.id, 1, { amount: 10, costType: 'claim_cost' })), (e) => e.status === 403);
});

test('a payment above your limit waits for a different person whose limit is high enough', () => {
  const { money, exposure, users, run, claim: c, approve, pc } = claim();
  exposure();
  run(() => money.setExposureReserve(users.uwm, c.id, 1, 40000));
  approve();
  const amount = PAYMENT_LIMITS[1] + 1000; // more than the underwriter may pay alone
  const pending = run(() => money.payExposure(users.uw, c.id, 1, { amount, costType: 'claim_cost' }));
  assert.equal(pending.status, 'pending_approval');
  assert.equal(pc.claimView(pc.claim(c.id), users.uw).paid, 0); // not paid yet
  assert.equal(pc.claim(c.id).pendingPayments.length, 1);

  // The requester cannot approve their own payment, and the money counts against the reserve while it waits.
  assert.throws(() => run(() => money.approvePayment(users.uw, c.id, pending.id)), (e) => e.status === 409 && /different person/i.test(e.message));
  assert.throws(() => run(() => money.payExposure(users.uwm, c.id, 1, { amount: 40000 - amount + 1, costType: 'claim_cost' })), (e) => e.status === 422);

  // Someone whose own limit is below the amount cannot approve it either.
  const other = pc.user('naagarjuna'); // authority 1: the same limit as the underwriter
  assert.throws(() => run(() => money.approvePayment(other, c.id, pending.id)), (e) => e.status === 403);

  const done = run(() => money.approvePayment(users.uwm, c.id, pending.id));
  assert.equal(done.status, 'issued');
  assert.equal(pc.claimView(pc.claim(c.id), users.uw).paid, amount);
  assert.equal(pc.claim(c.id).payments[0].approvedBy, users.uwm.id);
  assert.equal(pc.claim(c.id).pendingPayments.length, 0);
  assert.ok(pc.db.events.some((e) => e.type === 'ClaimPaid' && e.payload.amount === amount));
  assert.throws(() => run(() => money.approvePayment(users.uwm, c.id, pending.id)), (e) => e.status === 404 || e.status === 409);
});

test('a payment above every limit is refused outright', () => {
  const { money, exposure, users, run, claim: c, approve } = claim();
  exposure();
  run(() => money.setExposureReserve(users.uwm, c.id, 1, RESERVE_LIMITS[2]));
  approve();
  assert.throws(() => run(() => money.payExposure(users.uwm, c.id, 1, { amount: PAYMENT_LIMITS[2] + 1, costType: 'claim_cost' })), (e) => e.status === 422 && /every limit|no one/i.test(e.message));
});

test('the claim shows its exposures with paid, outstanding and incurred; reserves stay hidden from an agent', () => {
  const { money, exposure, users, run, claim: c, approve, pc } = claim();
  exposure();
  exposure({ coverage: 'Liability', claimantName: 'Ravi Kumar', claimantKind: 'third_party' });
  run(() => money.setExposureReserve(users.uw, c.id, 1, 3000));
  run(() => money.setExposureReserve(users.uw, c.id, 2, 1000));
  approve();
  run(() => money.payExposure(users.uw, c.id, 1, { amount: 1000, costType: 'claim_cost' }));
  run(() => money.payExposure(users.uw, c.id, 1, { amount: 100, costType: 'expense' }));

  const view = pc.claimView(pc.claim(c.id), users.uw);
  assert.deepEqual(view.exposures.map((e) => [e.number, e.reserve, e.paid, e.outstanding, e.incurred]), [[1, 3000, 1100, 1900, 3000], [2, 1000, 0, 1000, 1000]]);
  assert.equal(view.exposures[0].paidByCostType.expense, 100);

  const agentView = pc.claimView(pc.claim(c.id), users.agent);
  assert.deepEqual(agentView.exposures.map((e) => [e.number, e.paid]), [[1, 1100], [2, 0]]);
  assert.ok(agentView.exposures.every((e) => !('reserve' in e) && !('outstanding' in e)));
});
