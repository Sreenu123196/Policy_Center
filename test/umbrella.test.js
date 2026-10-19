'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account } = require('./helpers');

// An umbrella submission: business name, the underlying policies it sits above, and the risk profile.
function umbSubmission(pc, user, acct, eff, line = {}) {
  const job = pc.startSubmission({ accountId: acct.id, product: 'Umbrella', effectiveDate: eff }, user);
  pc.updateDraft(job.id, {
    line: {
      ...job.period.line,
      businessName: 'Rivera Holdings LLC', numberOfVehicles: 4, numberOfLocations: 2, claimsLast5Years: 0,
      underlyingAutoLimit: '1000000', underlyingGLLimit: '1000000', underlyingEmployersLimit: '500000',
      lineCoverages: { UMBExcessCov: { selected: true, terms: { limit: '1000000' } } },
      ...line,
    },
  }, user);
  return job;
}

test('umbrella: the premium rises with the umbrella limit', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const oneM = run(() => umbSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(oneM.id, users.agent));
  const fiveM = run(() => umbSubmission(pc, users.agent, acct, '2026-03-01', { lineCoverages: { UMBExcessCov: { selected: true, terms: { limit: '5000000' } } } }));
  run(() => pc.quote(fiveM.id, users.agent));
  const limitCost = (id) => pc.job(id, users.agent).quote.costs.find((c) => c.coverageCode === 'UMBExcessCov').amount;
  assert.ok(limitCost(oneM.id) > 0);
  assert.ok(limitCost(fiveM.id) > limitCost(oneM.id));
});

test('umbrella: underlying limits are the listed ones, and an unlisted value falls back to the minimum', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const odd = run(() => umbSubmission(pc, users.agent, acct, '2026-03-01', { underlyingAutoLimit: '250000' }));
  run(() => pc.quote(odd.id, users.agent));
  assert.equal(pc.job(odd.id, users.agent).period.line.underlyingAutoLimit, '500000');
  assert.ok(pc.job(odd.id, users.agent).quote.total > 0);
});

test('umbrella: a business name is required before quoting', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => umbSubmission(pc, users.agent, acct, '2026-03-01', { businessName: '' }));
  assert.throws(() => run(() => pc.quote(job.id, users.agent)));
});

test('umbrella: a fleet over 20 vehicles needs the UW Manager, and the policy binds once approved', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => umbSubmission(pc, users.agent, acct, '2026-03-01', { numberOfVehicles: 25 }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'UMB_FLEET');
  assert.ok(issue, 'a 25-vehicle fleet raises an issue');
  assert.equal(issue.requiredRole, 'UW Manager');
  run(() => pc.approveIssue(job.id, issue.key, 'Fleet reviewed', users.uwm));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  assert.equal(pc.policy(pc.job(job.id, users.agent).policyId).product, 'Umbrella');
});
