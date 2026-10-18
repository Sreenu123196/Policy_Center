'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account } = require('./helpers');

const location = (over = {}) => ({
  description: 'Main street shop', address: { line1: '12 Main St', city: 'Columbus', zip: '43215' },
  construction: 'Masonry', occupancy: 'Retail', yearBuilt: 1995, protectionClass: 3,
  buildingValue: 900000, contentsValue: 150000, ...over,
});
const exposure = (over = {}) => ({ classCode: '60010', description: 'Retail sales', amount: 1000000, ...over });

// A businessowners submission: one or more locations (property) and classes of business (liability).
function bopSubmission(pc, user, acct, eff, line = {}) {
  const job = pc.startSubmission({ accountId: acct.id, product: 'Businessowners', effectiveDate: eff }, user);
  pc.updateDraft(job.id, {
    line: { ...job.period.line, businessName: 'Rivera Retail LLC', claimsLast5Years: 0, locations: [location()], exposures: [exposure()], ...line },
  }, user);
  return job;
}

test('businessowners: property and liability are priced together, with a package discount', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => bopSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  const q = pc.job(job.id, users.agent).quote;
  assert.ok(q.total > 0);
  const codes = q.costs.map((c) => c.coverageCode);
  assert.ok(codes.includes('BOPBuildingCov'), 'building is priced');
  assert.ok(codes.includes('BOPBusinessPersonalPropertyCov'), 'contents are priced');
  assert.ok(codes.includes('BOPPremOpsCov'), 'premises and operations is priced');
  const pkg = q.costs.find((c) => c.coverageCode === 'PackageDiscount');
  assert.ok(pkg && pkg.amount < 0, 'the package discount reduces the premium');
});

test('businessowners: at least one location and one class are required', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const noLocation = run(() => bopSubmission(pc, users.agent, acct, '2026-03-01', { locations: [] }));
  assert.throws(() => run(() => pc.quote(noLocation.id, users.agent)));
  const noClass = run(() => bopSubmission(pc, users.agent, acct, '2026-03-01', { exposures: [] }));
  assert.throws(() => run(() => pc.quote(noClass.id, users.agent)));
});

test('businessowners: poor fire protection needs an underwriter, then the policy binds as a businessowners policy', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => bopSubmission(pc, users.agent, acct, '2026-03-01', { locations: [location({ protectionClass: 9 })] }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'BOP_POOR_PROTECTION');
  assert.ok(issue, 'protection class 9 raises an issue');
  assert.equal(issue.requiredRole, 'Underwriter');
  run(() => pc.approveIssue(job.id, issue.key, 'Protection reviewed', users.uw));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  assert.equal(pc.policy(pc.job(job.id, users.agent).policyId).product, 'Businessowners');
});

test('businessowners: a liquor-serving class is referred to an underwriter', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => bopSubmission(pc, users.agent, acct, '2026-03-01', { exposures: [exposure({ classCode: '16501', description: 'Bar', amount: 400000 })] }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'BOP_LIQUOR_SERVICE');
  assert.ok(issue, 'liquor service raises an issue');
  assert.equal(issue.requiredRole, 'Underwriter');
});
