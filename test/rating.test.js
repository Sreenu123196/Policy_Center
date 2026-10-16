'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rate, selectRateBook, replacementCostEstimate } = require('../src/rating');
const { setup, account, driver, vehicle, autoSubmission, homeSubmission } = require('./helpers');

const sum = (costs) => Math.round(costs.reduce((s, c) => s + c.amount, 0) * 100) / 100;

test('rate book selection is effective-dated and ignores draft books', () => {
  assert.equal(selectRateBook('PersonalAuto', '2026-06-01').version, '2026.1');
  assert.equal(selectRateBook('PersonalAuto', '2027-01-01').version, '2027.1');
  assert.equal(selectRateBook('Homeowners', '2027-08-01').version, '2027.1'); // 2027.2 is Draft
  assert.throws(() => selectRateBook('Homeowners', '2020-01-01'), /No active/);
});

test('personal auto: worksheet factors multiply to each cost and totals reconcile', () => {
  const { pc, users } = setup();
  const acct = account(pc, users.agent);
  const job = autoSubmission(pc, users.agent, acct, '2026-03-01');
  const r = rate('PersonalAuto', job.period, { includeFees: true });
  for (const c of r.costs) {
    const product = c.worksheet.reduce((p, s, i) => (i === 0 ? s.factor : p * s.factor), 0);
    assert.ok(Math.abs(product - c.amount) < 0.02, `${c.coverageName}: ${product} vs ${c.amount}`);
  }
  const premium = sum(r.costs.filter((c) => c.type === 'Coverage' || c.type === 'Discount'));
  assert.equal(r.premium, premium);
  assert.equal(r.total, Math.round((r.premium + r.taxes + r.fees) * 100) / 100);
  assert.equal(r.fees, 25);
  assert.ok(r.costs.some((c) => c.coverageCode === 'PaidInFullDiscount'));
});

test('personal auto: youthful driver, accidents and deductibles move premium the right way', () => {
  const { pc, users } = setup();
  const acct = account(pc, users.agent);
  const base = rate('PersonalAuto', autoSubmission(pc, users.agent, acct, '2026-03-01').period, {}).premium;
  const teen = rate('PersonalAuto', autoSubmission(pc, users.agent, acct, '2026-03-01', { drivers: [driver(), driver({ firstName: 'Teen', dob: '2009-01-01', yearsLicensed: 1 })] }).period, {}).premium;
  const accident = rate('PersonalAuto', autoSubmission(pc, users.agent, acct, '2026-03-01', { drivers: [driver({ accidents: 1 })] }).period, {}).premium;
  assert.ok(teen > base * 1.8, 'teen driver should roughly double the premium');
  assert.ok(accident > base * 1.2, 'an at-fault accident should surcharge');

  const job = autoSubmission(pc, users.agent, acct, '2026-03-01');
  const line = JSON.parse(JSON.stringify(job.period.line));
  line.vehicles[0].coverages.PACollisionCov.terms.deductible = '2000';
  pc.updateDraft(job.id, { line }, users.agent);
  assert.ok(rate('PersonalAuto', job.period, {}).premium < base, 'higher deductible should lower premium');
});

test('personal auto: multi-car and multi-policy discounts apply', () => {
  const { pc, users } = setup();
  const acct = account(pc, users.agent);
  const job = autoSubmission(pc, users.agent, acct, '2026-03-01', { vehicles: [vehicle(), vehicle({ vin: '1FMCU9G60MUA12346' })] });
  const r = rate('PersonalAuto', job.period, { multiPolicy: true });
  const codes = r.costs.filter((c) => c.type === 'Discount').map((c) => c.coverageCode);
  assert.deepEqual(codes.sort(), ['MultiCarDiscount', 'MultiPolicyDiscount', 'PaidInFullDiscount']);
});

test('PIP is required only in no-fault states', () => {
  const { pc, users } = setup();
  const oh = autoSubmission(pc, users.agent, account(pc, users.agent), '2026-03-01');
  const fl = autoSubmission(pc, users.agent, account(pc, users.agent, { address: { line1: '1 Ocean Dr', city: 'Miami', state: 'FL', zip: '33139' } }), '2026-03-01');
  assert.equal(oh.period.line.lineCoverages.PAPIPCov, undefined);
  assert.equal(fl.period.line.lineCoverages.PAPIPCov.selected, true);
});

test('homeowners: Cov A defaults to replacement cost and B/C/D derive from it', () => {
  const { pc, users } = setup();
  const acct = account(pc, users.agent);
  const job = homeSubmission(pc, users.agent, acct, '2026-03-01', { dwelling: { squareFeet: 2000, construction: 'Frame' } });
  const c = job.period.line.coverages;
  const rce = replacementCostEstimate('OH', 'Frame', 2000, '2026-03-01');
  assert.equal(c.HODwellingCov.terms.limit, rce);
  assert.equal(c.HOOtherStructuresCov.terms.limit, Math.round((rce * 0.1) / 100) * 100);
  assert.equal(c.HOPersonalPropertyCov.terms.limit, Math.round((rce * 0.5) / 100) * 100);

  // Raising Cov A re-derives untouched B/C/D, but keeps an explicitly entered C.
  const line = JSON.parse(JSON.stringify(job.period.line));
  line.coverages.HODwellingCov.terms.limit = 500000;
  line.coverages.HOPersonalPropertyCov.terms.limit = 123400;
  pc.updateDraft(job.id, { line }, users.agent);
  const c2 = job.period.line.coverages;
  assert.equal(c2.HOOtherStructuresCov.terms.limit, 50000);
  assert.equal(c2.HOPersonalPropertyCov.terms.limit, 123400);
  assert.equal(c2.HOLossOfUseCov.terms.limit, 100000);
});

test('homeowners: coastal wind load, renters form and minimum premium', () => {
  const { pc, users } = setup();
  const fl = account(pc, users.agent, { address: { line1: '1 Ocean Dr', city: 'Miami', state: 'FL', zip: '33139' } });
  const home = homeSubmission(pc, users.agent, fl, '2026-03-01');
  const r = rate('Homeowners', home.period, {});
  assert.ok(r.costs.some((c) => c.coverageCode === 'HOWindHail'));

  const oh = account(pc, users.agent);
  const renters = homeSubmission(pc, users.agent, oh, '2026-03-01', { form: 'HO4' });
  assert.equal(renters.period.line.coverages.HODwellingCov, undefined);
  const rr = rate('Homeowners', renters.period, {});
  assert.ok(rr.premium >= 250, 'renters premium respects the minimum premium');
});
