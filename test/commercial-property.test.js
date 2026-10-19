'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account } = require('./helpers');

const location = (over = {}) => ({
  description: 'Main street shop', address: { line1: '12 Main St', city: 'Columbus', zip: '43215' },
  construction: 'Masonry', occupancy: 'Retail', yearBuilt: 1995, protectionClass: 3,
  buildingValue: 900000, contentsValue: 150000, ...over,
});

// A commercial property submission for a business with its locations and coverages.
function cpSubmission(pc, user, acct, eff, line = {}) {
  const job = pc.startSubmission({ accountId: acct.id, product: 'CommercialProperty', effectiveDate: eff }, user);
  pc.updateDraft(job.id, {
    line: { ...job.period.line, businessName: 'Rivera Retail LLC', claimsLast5Years: 0, locations: [location()], ...line },
  }, user);
  return job;
}

test('commercial property: each location is priced for building and contents', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => cpSubmission(pc, users.agent, acct, '2026-03-01', {
    locations: [location(), location({ description: 'Warehouse', occupancy: 'Warehouse', address: { line1: '90 Dock Rd', city: 'Columbus', zip: '43214' } })],
  }));
  run(() => pc.quote(job.id, users.agent));
  const q = pc.job(job.id, users.agent).quote;
  assert.ok(q.total > 0);
  assert.equal(q.costs.filter((c) => c.coverageCode === 'CPBuildingCov').length, 2, 'building priced per location');
  assert.equal(q.costs.filter((c) => c.coverageCode === 'CPBusinessPersonalPropertyCov').length, 2, 'contents priced per location');
});

test('commercial property: a warehouse costs more than an office with the same values', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const office = run(() => cpSubmission(pc, users.agent, acct, '2026-03-01', { locations: [location({ occupancy: 'Office' })] }));
  run(() => pc.quote(office.id, users.agent));
  const warehouse = run(() => cpSubmission(pc, users.agent, acct, '2026-03-01', { locations: [location({ occupancy: 'Warehouse' })] }));
  run(() => pc.quote(warehouse.id, users.agent));
  const building = (id) => pc.job(id, users.agent).quote.costs.find((c) => c.coverageCode === 'CPBuildingCov').amount;
  assert.ok(building(warehouse.id) > building(office.id));
});

test('commercial property: a location needs a ZIP, a construction type and a building value before quoting', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const badZip = run(() => cpSubmission(pc, users.agent, acct, '2026-03-01', { locations: [location({ address: { line1: '1 Oak', city: 'X', zip: '123' } })] }));
  assert.throws(() => run(() => pc.quote(badZip.id, users.agent)));
  const noValue = run(() => cpSubmission(pc, users.agent, acct, '2026-03-01', { locations: [location({ buildingValue: 0 })] }));
  assert.throws(() => run(() => pc.quote(noValue.id, users.agent)));
});

test('commercial property: poor fire protection needs an underwriter before the quote', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => cpSubmission(pc, users.agent, acct, '2026-03-01', { locations: [location({ protectionClass: 9 })] }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'CP_POOR_PROTECTION');
  assert.ok(issue, 'protection class 9 raises an issue');
  assert.equal(issue.requiredRole, 'Underwriter');
});

test('commercial property: a building over $5M needs the UW Manager, and binding waits for it', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => cpSubmission(pc, users.agent, acct, '2026-03-01', { locations: [location({ buildingValue: 6000000 })] }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'CP_LARGE_LOCATION');
  assert.ok(issue, 'a large building raises an issue');
  assert.equal(issue.requiredRole, 'UW Manager');
  run(() => pc.approveIssue(job.id, issue.key, 'Large building reviewed', users.uwm));
  run(() => pc.bind(job.id, users.agent));
  assert.equal(pc.policy(pc.job(job.id, users.agent).policyId).product, 'CommercialProperty');
});
