'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission, homeSubmission } = require('./helpers');

// Claims history at renewal (ported from the Insurance Suite): when a policy renews, its own claims in the term that is
// ending are counted. A claim-free term earns a claim-free renewal discount that grows with each claim-free renewal
// (5%, 10%, 15%) and is lost, with the count back to zero, when there is a claim. For homeowners and the business lines
// the claims are added to the loss history that rating and underwriting already use. A rejected claim does not count.

function autoPolicy() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  return { ...env, acct, policy: pc.policy(job.policyId) };
}

const claim = (env, lossDate = '2026-03-10') => env.setToday('2026-03-15') || env.run(() => env.pc.openClaim(env.policy.id, { lossDate, lossType: 'Collision' }, env.users.agent));
const renew = (env) => env.run(() => env.pc.startRenewal(env.policy.id, env.users.agent));
const discount = (job) => job.quote.costs.find((c) => c.coverageCode === 'ClaimFreeDiscount');

test('a claim-free term earns a claim-free renewal discount, 5% at the first renewal', () => {
  const env = autoPolicy();
  env.setToday('2026-08-01');
  const job = renew(env);
  assert.deepEqual(job.claimExperience, { termNumber: 1, claims: 0, claimNumbers: [], incurred: 0 });
  assert.equal(job.period.line.claimFreeRenewals, 1);
  const d = discount(job);
  assert.ok(d, 'the quote has a claim-free discount');
  assert.ok(d.amount < 0);
  assert.match(d.worksheet.map((w) => w.label).join(' '), /1 claim-free renewal.*5%/i);
  const subtotal = d.worksheet[0].running;
  assert.equal(Math.round(d.amount * 100) / 100, -Math.round(subtotal * 0.05 * 100) / 100);
});

test('the discount grows with each claim-free renewal: 10% at the second', () => {
  const env = autoPolicy();
  env.setToday('2026-08-01');
  const first = renew(env);
  env.run(() => env.pc.bind(first.id, env.users.agent));
  env.setToday('2027-02-01'); // the second term ends 2027-03-01
  const second = renew(env);
  assert.equal(second.period.line.claimFreeRenewals, 2);
  assert.match(discount(second).worksheet.map((w) => w.label).join(' '), /2 claim-free renewals.*10%/i);
});

test('a claim in the term takes the discount away and starts the count again', () => {
  const env = autoPolicy();
  claim(env);
  env.setToday('2026-08-01');
  const job = renew(env);
  assert.equal(job.claimExperience.claims, 1);
  assert.deepEqual(job.claimExperience.claimNumbers, [env.pc.db.claims[0].claimNumber]);
  assert.equal(job.period.line.claimFreeRenewals, 0);
  assert.equal(discount(job), undefined);
});

test('a rejected claim does not count; a claim from another policy does not count', () => {
  const env = autoPolicy();
  const c = claim(env);
  env.run(() => env.pc.moveClaim(c.id, { to: 'Rejected', reason: 'Not covered' }, env.users.uw));
  env.setToday('2026-08-01');
  assert.equal(renew(env).claimExperience.claims, 0);
});

test('the discount is not given when the premium was never rated with one: new business has none', () => {
  const env = autoPolicy();
  const first = env.pc.db.jobs[0];
  assert.equal(first.period.line.claimFreeRenewals ?? 0, 0);
  assert.equal(discount(first), undefined);
});

test('a homeowners renewal adds the claims of the ending term to the loss history that rating and underwriting use', () => {
  const env = setup('2026-03-01');
  const { pc, users, run, setToday } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => homeSubmission(pc, users.agent, acct, '2026-03-01', { dwelling: { priorClaims: 0 } }));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(job.policyId);
  setToday('2026-03-15');
  run(() => pc.openClaim(policy.id, { lossDate: '2026-03-10', lossType: 'Water' }, users.agent));
  setToday('2026-12-15'); // a homeowners term is 12 months
  const renewal = run(() => pc.startRenewal(policy.id, users.agent));
  assert.equal(renewal.claimExperience.claims, 1);
  assert.equal(renewal.period.line.dwelling.priorClaims, 1);
});
