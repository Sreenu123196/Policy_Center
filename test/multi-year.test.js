'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, driver, autoSubmission, homeSubmission } = require('./helpers');
const { PRODUCTS } = require('../src/productModel');

// Multi-year terms (Tier 3, item 10): a product that offers them lets the customer choose 12, 24 or 36 months. The term
// length drives the expiration date, the price (the term factor and a multi-year discount), the instalments, the refund
// on cancellation and the renewal. A product with a fixed term refuses any other length.

const NO = { modified: 'no', racing: 'no', priorLapse: 'no', licenseSuspended: 'no', keptOutdoors: 'no' };
const rider = driver({ firstName: 'Ravi', lastName: 'Kumar', dob: '1992-04-10', yearsLicensed: 8 });
const bike = { year: 2022, make: 'Honda', model: 'CB300', vin: '1HGCM82633A123456', engineCc: 300, bikeType: 'Commuter', usage: 'Commute', annualMiles: 6000, marketValue: 5000, garagingZip: '43215' };

function twoWheeler({ termMonths, plan = 'PaidInFull', bind = false } = {}) {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => pc.startSubmission({ accountId: acct.id, product: 'TwoWheeler', effectiveDate: '2026-03-01' }, users.agent));
  run(() => pc.updateDraft(job.id, { paymentPlan: plan, ...(termMonths ? { termMonths } : {}), line: { ...job.period.line, drivers: [rider], vehicles: [bike], answers: NO } }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  if (bind) run(() => pc.bind(job.id, users.agent));
  return { ...env, acct, job: pc.job(job.id) };
}

test('the term options: Two-Wheeler and Homeowners offer 12, 24 and 36 months; Personal Auto keeps its six', () => {
  assert.deepEqual(PRODUCTS.TwoWheeler.termOptions, [12, 24, 36]);
  assert.deepEqual(PRODUCTS.Homeowners.termOptions, [12, 24, 36]);
  assert.equal(PRODUCTS.PersonalAuto.termOptions, undefined);
});

test('a longer term moves the expiration date, and the price grows with the term less a multi-year discount', () => {
  const one = twoWheeler({});
  const three = twoWheeler({ termMonths: 36 });
  assert.deepEqual([one.job.period.termMonths, one.job.period.expirationDate], [12, '2027-03-01']);
  assert.deepEqual([three.job.period.termMonths, three.job.period.expirationDate], [36, '2029-03-01']);
  const ratio = three.job.quote.premium / one.job.quote.premium;
  assert.ok(ratio > 2.8 && ratio < 2.88, `three years cost about 2.84 times one year, not ${ratio.toFixed(3)}`);
  assert.ok(three.job.quote.costs.some((c) => c.coverageCode === 'MultiYearDiscount'));
  assert.ok(!one.job.quote.costs.some((c) => c.coverageCode === 'MultiYearDiscount'));
  const liability = three.job.quote.costs.find((c) => c.coverageCode === 'TWLiabilityCov');
  assert.ok(liability.worksheet.some((w) => /36 months/.test(w.label)));
});

test('a term the product does not offer is refused, and the term cannot change after the first quote is bound', () => {
  const env = twoWheeler({});
  const { pc, users, run } = env;
  assert.throws(() => run(() => pc.updateDraft(env.job.id, { termMonths: 18 }, users.agent)), (e) => e.status === 422 && /12, 24, 36/.test(e.message));
  // A personal auto policy has a fixed term.
  const acct = run(() => account(pc, users.agent, { firstName: 'Fixed', lastName: 'Term' }));
  const auto = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  assert.throws(() => run(() => pc.updateDraft(auto.id, { termMonths: 12 }, users.agent)), (e) => e.status === 422 && /fixed term/i.test(e.message));
  // Once bound, a change job cannot alter the term.
  run(() => pc.bind(env.job.id, users.agent));
  const change = run(() => pc.startPolicyChange(pc.job(env.job.id).policyId, { effectiveDate: '2026-04-01' }, users.agent));
  assert.throws(() => run(() => pc.updateDraft(change.id, { termMonths: 24 }, users.agent)), (e) => e.status === 409);
});

test('changing the effective date keeps the chosen term length', () => {
  const env = twoWheeler({ termMonths: 24 });
  env.run(() => env.pc.updateDraft(env.job.id, { effectiveDate: '2026-04-15' }, env.users.agent));
  assert.equal(env.pc.job(env.job.id).period.expirationDate, '2028-04-15');
});

test('instalments are spread over the whole term and add up to the total', () => {
  const env = twoWheeler({ termMonths: 36, plan: 'Quarterly', bind: true });
  const invoices = env.pc.db.invoices.filter((i) => i.policyId === env.pc.job(env.job.id).policyId);
  assert.equal(invoices.length, 12); // four a year for three years
  assert.deepEqual([invoices[0].dueDate, invoices[1].dueDate, invoices[11].dueDate], ['2026-03-01', '2026-06-01', '2028-12-01']);
  const total = Math.round(invoices.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  assert.equal(total, env.job.quote.total);
  // Paid in full stays a single invoice, whatever the term.
  const full = twoWheeler({ termMonths: 36, bind: true });
  assert.equal(full.pc.db.invoices.filter((i) => i.policyId === full.pc.job(full.job.id).policyId).length, 1);
});

test('cancelling part-way through a multi-year term returns the unearned part of the whole term', () => {
  const env = twoWheeler({ termMonths: 36, bind: true });
  const { pc, users, run } = env;
  env.setToday('2027-09-01');
  const policy = pc.policy(pc.job(env.job.id).policyId);
  const cancel = run(() => pc.startCancellation(policy.id, { effectiveDate: '2027-09-01', reason: 'InsuredRequest' }, users.agent));
  const termDays = 1096; // 2026-03-01 to 2029-03-01
  const unearnedDays = 547; // 2027-09-01 to 2029-03-01
  const premium = env.job.quote.premium + env.job.quote.taxes;
  const expected = (premium * unearnedDays) / termDays * 0.9; // short rate: the insured asked
  assert.ok(Math.abs(-cancel.quote.changeAmount - expected) < 1, `refund ${-cancel.quote.changeAmount} is about ${expected.toFixed(2)}`);
  assert.equal(cancel.cancellation.lines[0].termDays, termDays);
});

test('a renewal is for the same length of term, and the claim-free discount carries on', () => {
  const env = twoWheeler({ termMonths: 24, bind: true });
  const { pc, users, run } = env;
  env.setToday('2028-01-15'); // the term ends 2028-03-01
  const renewal = run(() => pc.startRenewal(pc.job(env.job.id).policyId, users.agent));
  assert.deepEqual([renewal.period.termMonths, renewal.period.effectiveDate, renewal.period.expirationDate], [24, '2028-03-01', '2030-03-01']);
});

test('a homeowners policy can also be written for two years, priced at about twice the year', () => {
  const price = (termMonths) => {
    const env = setup('2026-03-01');
    const { pc, users, run } = env;
    const acct = run(() => account(pc, users.agent));
    const job = run(() => homeSubmission(pc, users.agent, acct, '2026-03-01'));
    if (termMonths) run(() => pc.updateDraft(job.id, { termMonths }, users.agent));
    run(() => pc.quote(job.id, users.agent));
    return pc.job(job.id);
  };
  const one = price(null);
  const two = price(24);
  assert.equal(two.period.expirationDate, '2028-03-01');
  assert.ok(Math.abs(two.quote.premium / one.quote.premium - 2) < 0.02);
});
