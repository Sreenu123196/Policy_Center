'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { resolveVersion } = require('../src/productVersions');

// A policy records the product version it was sold on. Without it, publishing a new version silently changes the terms of
// every policy written before - the kind of quiet rewrite that shows up as a dispute, not as an error.

test('binding a new submission stamps the product version in force', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(job.policyId, users.agent);
  assert.ok(policy.productVersion, 'the policy carries a version');
  assert.equal(policy.productVersion, resolveVersion({ product: policy.product, asOf: '2026-03-01' }).version);
});

test('the stamp is the version for the bind date, not the newest', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(job.policyId, users.agent);
  // PersonalAuto has version 2 effective 2026-01-01, so a March 2026 bind is version 2 - and that must be true even
  // after any later version is added, because the date decides.
  assert.equal(resolveVersion({ product: policy.product, asOf: '2026-03-01' }).version, policy.productVersion);
});
