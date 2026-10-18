'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, driver } = require('./helpers');

const caVehicle = (over = {}) => ({
  year: 2021, make: 'Ford', model: 'Transit', vin: '1FTBW2CM0MKA12345', usage: 'Service', radius: 'Local',
  marketValue: 42000, garagingZip: '43215', ...over,
});

// A commercial auto submission for a business: named insured, drivers and a fleet of vehicles.
function caSubmission(pc, user, acct, eff, line = {}) {
  const job = pc.startSubmission({ accountId: acct.id, product: 'CommercialAuto', effectiveDate: eff }, user);
  pc.updateDraft(job.id, {
    line: { ...job.period.line, businessName: 'Rivera Plumbing LLC', drivers: [driver()], vehicles: [caVehicle()], ...line },
  }, user);
  return job;
}

test('commercial auto: a fleet is quoted with liability, physical damage and a business name on the policy', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => caSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  const q = pc.job(job.id, users.agent).quote;
  assert.ok(q.total > 0, 'a premium is quoted');
  const codes = q.costs.map((c) => c.coverageCode);
  assert.ok(codes.includes('CAAutoLiabilityCov'), 'liability is priced');
  assert.ok(codes.includes('CACollisionCov'), 'collision is priced');
  assert.ok(codes.includes('CAComprehensiveCov'), 'comprehensive is priced');
  assert.ok(q.costs.filter((c) => c.type !== 'Fee').every((c) => c.worksheet && c.worksheet.length > 1), 'every priced charge has a factor worksheet');
});

test('commercial auto: five or more vehicles earn a fleet discount', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const fleet = Array.from({ length: 5 }, (_, i) => caVehicle({ vin: `1FTBW2CM0MKA1${String(2340 + i)}` }));
  const job = run(() => caSubmission(pc, users.agent, acct, '2026-03-01', { vehicles: fleet }));
  run(() => pc.quote(job.id, users.agent));
  const codes = pc.job(job.id, users.agent).quote.costs.map((c) => c.coverageCode);
  assert.ok(codes.includes('FleetDiscount5'));
  assert.ok(!codes.includes('FleetDiscount10'));
});

test('commercial auto: a business name and a valid VIN are required before quoting', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const noName = run(() => caSubmission(pc, users.agent, acct, '2026-03-01', { businessName: '' }));
  assert.throws(() => run(() => pc.quote(noName.id, users.agent)));
  const badVin = run(() => caSubmission(pc, users.agent, acct, '2026-03-01', { vehicles: [caVehicle({ vin: 'SHORT' })] }));
  assert.throws(() => run(() => pc.quote(badVin.id, users.agent)));
});

test('commercial auto: a heavy truck needs underwriter approval before it can be bound', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => caSubmission(pc, users.agent, acct, '2026-03-01', { vehicles: [caVehicle({ usage: 'Heavy', model: 'Box truck' })] }));
  run(() => pc.quote(job.id, users.agent));
  const heavy = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'CA_HEAVY_VEHICLE');
  assert.ok(heavy, 'the heavy truck raises an issue');
  assert.equal(heavy.requiredRole, 'Underwriter');
  run(() => pc.bind(job.id, users.agent));
  assert.equal(pc.job(job.id, users.agent).policyId, null, 'not bound while the heavy truck needs approval');
  assert.match(pc.job(job.id, users.agent).notice.text, /underwriting issue/);
  run(() => pc.approveIssue(job.id, heavy.key, 'Heavy truck reviewed', users.uw));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(pc.job(job.id, users.agent).policyId);
  assert.equal(policy.product, 'CommercialAuto');
});

test('commercial auto: driver accident history beyond three needs the UW Manager', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => caSubmission(pc, users.agent, acct, '2026-03-01', { drivers: [driver({ accidents: 3 })] }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'CA_DRIVER_ACCIDENTS');
  assert.ok(issue, 'the accident history raises an issue');
  assert.equal(issue.requiredRole, 'UW Manager');
});
