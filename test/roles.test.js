'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { runTool } = require('../src/chatbot');

// One customer with a bound auto policy and an open claim, sold by the agent (producer PC-100).
function book() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(job.policyId);
  const claim = run(() => pc.openClaim(policy.id, { lossDate: '2026-03-01', lossType: 'Collision' }, users.agent));
  run(() => pc.moveClaim(claim.id, { to: 'Under Review' }, users.uw));
  run(() => pc.setClaimReserve(claim.id, 1500, users.uw));
  return { ...env, acct, policy, claim, executive: pc.user('venkatesh'), manager: pc.user('sudhakar') };
}

test('roles: the four roles are separate people in the user list', () => {
  const { pc } = setup();
  const roles = ['agent', 'uw', 'venkatesh', 'sudhakar'].map((id) => pc.user(id).role);
  assert.deepEqual(roles, ['Agent', 'Underwriter', 'Insurance Executive', 'UW Manager']);
});

test('roles: an insurance executive sees policies and claim status, but no billing, reserves or reports', () => {
  const { pc, users, executive, policy, claim } = book();
  const view = pc.policyDetail(policy.id, executive);
  assert.equal(view.billingHidden, true);
  assert.deepEqual(view.invoices, []);
  assert.deepEqual(view.transactions, []);
  assert.equal(view.writtenPremium, null);
  assert.equal(pc.claimDetail(claim.id, executive).status, 'Under Review');
  assert.equal(pc.claimDetail(claim.id, executive).reserve, undefined);
  assert.throws(() => pc.claimsReport(executive), /underwriters and UW managers/);
  assert.throws(() => pc.billingReport(executive), /UW managers/);
  assert.throws(() => pc.salesAnalytics(executive, {}), /agents and UW managers/);
  assert.throws(() => pc.lapsePolicies(executive), /agents and UW managers/);
  assert.equal(pc.listPolicies('', executive).length >= 1, true, 'policies are visible');
  assert.ok(users);
});

test('roles: a UW manager sees every report: policies, claims and billing', () => {
  const { pc, manager, policy, claim } = book();
  const view = pc.policyDetail(policy.id, manager);
  assert.equal(view.billingHidden, false);
  assert.ok(view.invoices.length > 0);
  assert.ok(view.writtenPremium > 0);
  assert.equal(pc.claimDetail(claim.id, manager).reserve, 1500);
  const claims = pc.claimsReport(manager);
  assert.equal(claims.claims, 1);
  assert.equal(claims.totalReserve, 1500);
  assert.equal(claims.byStage['Under Review'].claims, 1);
  const billing = pc.billingReport(manager);
  assert.ok(billing.invoices > 0);
  assert.ok(billing.totalAmount > 0);
  assert.ok(billing.byStatus.Planned || billing.byStatus.Billed);
  assert.ok(pc.salesAnalytics(manager, { period: 'month' }).buckets.length >= 1);
});

test('roles: an underwriter keeps underwriting detail and claims, but not billing or sales reports', () => {
  const { pc, users, policy, claim } = book();
  assert.equal(pc.policyDetail(policy.id, users.uw).billingHidden, true);
  assert.equal(pc.claimDetail(claim.id, users.uw).reserve, 1500);
  assert.equal(pc.claimsReport(users.uw).claims, 1);
  assert.throws(() => pc.billingReport(users.uw), /UW managers/);
  assert.throws(() => pc.salesAnalytics(users.uw, {}), /agents and UW managers/);
});

test('roles: agents see their own customers only, with no billing, reserves or reports beyond their sales', () => {
  const { pc, users, policy, claim } = book();
  assert.equal(pc.policyDetail(policy.id, users.agent).billingHidden, true);
  assert.equal(pc.claimDetail(claim.id, users.agent).reserve, undefined);
  assert.throws(() => pc.claimsReport(users.agent), /underwriters and UW managers/);
  assert.throws(() => pc.billingReport(users.agent), /UW managers/);
  assert.equal(pc.salesAnalytics(users.agent, { period: 'year' }).scope, 'your sales only');
});

test('roles: the assistant gives the same answers as the rules allow', () => {
  const { pc, users, executive, manager } = book();
  assert.throws(() => runTool(pc, executive, 'portfolio_summary', {}), /underwriters and UW managers/);
  assert.throws(() => runTool(pc, executive, 'billing_report', {}), /UW managers/);
  assert.throws(() => runTool(pc, executive, 'claims_report', {}), /underwriters and UW managers/);
  assert.equal(runTool(pc, manager, 'billing_report', {}).invoices > 0, true);
  assert.equal(runTool(pc, manager, 'claims_report', {}).claims, 1);
  const execPolicy = runTool(pc, executive, 'list_policies', {});
  assert.ok(execPolicy.policies.length >= 1);
  assert.ok(users);
});
