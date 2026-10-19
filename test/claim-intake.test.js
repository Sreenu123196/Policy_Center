'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');

// First notice of loss (ported from the Insurance Suite claims module). When a claim is opened it keeps a snapshot of the
// policy as it was ON THE LOSS DATE, so a later change or cancellation never rewrites what the claim was judged against.
// It also records whether the cover could be verified for that date, and whether the loss was reported late.

function policy(today = '2026-03-01') {
  const env = setup(today);
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  return { ...env, policy: pc.policy(job.policyId) };
}

const report = (env, input = {}) => env.run(() => env.pc.openClaim(env.policy.id, { lossDate: '2026-03-01', lossType: 'Collision', ...input }, env.users.agent));

test('a claim keeps the policy as it was on the loss date, and a later change does not alter it', () => {
  const env = policy();
  const { pc, users, run, setToday } = env;
  const claim = report(env);
  assert.equal(claim.verification, 'verified');
  assert.equal(claim.policySnapshot.versionNumber, 1);
  assert.equal(claim.policySnapshot.termNumber, 1);
  assert.equal(claim.policySnapshot.status, 'in_force');
  const before = JSON.stringify(claim.policySnapshot);
  assert.ok(claim.policySnapshot.line.vehicles.length > 0); // the risk as it was

  // The policy is changed afterwards: a new version, effective 2026-04-01.
  setToday('2026-04-02');
  const change = run(() => pc.startPolicyChange(env.policy.id, { effectiveDate: '2026-04-01' }, users.agent));
  run(() => pc.updateDraft(change.id, { line: { ...change.period.line, vehicles: [{ ...change.period.line.vehicles[0], marketValue: 9999 }] } }, users.agent));
  run(() => pc.quote(change.id, users.agent));
  run(() => pc.bind(change.id, users.agent));
  assert.equal(JSON.stringify(pc.claim(claim.id).policySnapshot), before);

  // A claim for a loss after the change sees the new version.
  const later = report(env, { lossDate: '2026-04-01' });
  assert.equal(later.policySnapshot.versionNumber, 2);
});

test('a loss after the policy was cancelled is still recorded, but not verified, with the reason', () => {
  const env = policy();
  const { pc, users, run, setToday } = env;
  run(() => pc.startCancellation(env.policy.id, { effectiveDate: '2026-03-10', reason: 'InsuredRequest' }, users.agent));
  run(() => pc.bind(pc.db.jobs.find((j) => j.type === 'Cancellation').id, users.uw));
  setToday('2026-03-20');
  const claim = report(env, { lossDate: '2026-03-15' });
  assert.equal(claim.verification, 'not_verified');
  assert.match(claim.verificationNote, /cancelled/i);
  assert.equal(claim.policySnapshot.status, 'cancelled');

  // A loss before the cancellation is fine.
  assert.equal(report(env, { lossDate: '2026-03-05' }).verification, 'verified');
});

test('a loss reported more than 30 days after it happened is flagged as a late report', () => {
  const env = policy();
  env.setToday('2026-03-31'); // 30 days after the loss
  assert.equal(report(env).lateReport, false);
  env.setToday('2026-04-01'); // 31 days
  assert.equal(report(env).lateReport, true);
});

test('the claim view shows the flags and a short summary of the snapshot', () => {
  const env = policy();
  env.setToday('2026-05-01');
  const claim = report(env);
  const view = env.pc.claimView(claim, env.users.uw);
  assert.deepEqual({ verification: view.verification, late: view.lateReport }, { verification: 'verified', late: true });
  assert.deepEqual({ term: view.policySnapshot.termNumber, version: view.policySnapshot.versionNumber, status: view.policySnapshot.status }, { term: 1, version: 1, status: 'in_force' });
  assert.equal(view.policySnapshot.line, undefined); // the full risk stays on the claim, the view carries the summary
  assert.ok(view.policySnapshot.vehicles.length > 0);
});

test('a loss outside every term is still refused, as before', () => {
  const env = policy();
  assert.throws(() => report(env, { lossDate: '2025-01-01' }), /No term/);
});
