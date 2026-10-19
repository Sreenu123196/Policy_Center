'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, driver } = require('./helpers');
const { PRODUCTS } = require('../src/productModel');

// Two-Wheeler (motorcycle and scooter), Tier 3 item 10: a product with riders and bikes, engine size and bike type in the
// price, a question set the customer answers, and underwriting that follows from the answers.

const rider = (over = {}) => driver({ firstName: 'Ravi', lastName: 'Kumar', dob: '1992-04-10', yearsLicensed: 8, riderTraining: false, ...over });
const bike = (over = {}) => ({ year: 2022, make: 'Honda', model: 'CB300', vin: '1HGCM82633A123456', engineCc: 300, bikeType: 'Commuter', usage: 'Commute', annualMiles: 6000, marketValue: 5000, garagingZip: '43215', ...over });
const NO = { modified: 'no', racing: 'no', priorLapse: 'no', licenseSuspended: 'no', keptOutdoors: 'no' };

function submission({ riders = [rider()], bikes = [bike()], answers = NO, plan = 'PaidInFull', eff = '2026-03-01' } = {}) {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => pc.startSubmission({ accountId: acct.id, product: 'TwoWheeler', effectiveDate: eff }, users.agent));
  run(() => pc.updateDraft(job.id, { paymentPlan: plan, line: { ...job.period.line, drivers: riders, vehicles: bikes, answers } }, users.agent));
  return { ...env, acct, job };
}

const quote = (env) => { env.run(() => env.pc.quote(env.job.id, env.users.agent)); return env.pc.job(env.job.id); };
const issues = (env) => Object.fromEntries(env.pc.job(env.job.id).uwIssues.map((i) => [i.code, i]));

test('the product is in the catalogue with riders, bikes, a question set and its own policy number prefix', () => {
  const pm = PRODUCTS.TwoWheeler;
  assert.deepEqual([pm.prefix, pm.termMonths], ['TW', 12]);
  assert.ok(pm.questions.length >= 4);
  assert.ok(pm.vehicleCoverages.some((c) => c.code === 'TWCollisionCov'));
});

test('a standard rider on a commuter bike is quoted, bound and issued with a TW policy number', () => {
  const env = submission();
  const job = quote(env);
  assert.equal(job.status, 'Quoted');
  assert.ok(job.quote.total > 0);
  const codes = job.quote.costs.map((c) => c.coverageCode);
  for (const code of ['TWLiabilityCov', 'TWCollisionCov', 'TWComprehensiveCov', 'PaidInFullDiscount']) assert.ok(codes.includes(code), code);
  const liability = job.quote.costs.find((c) => c.coverageCode === 'TWLiabilityCov');
  assert.ok(liability.worksheet.some((w) => /Engine/.test(w.label)), 'the worksheet shows the engine factor');
  env.run(() => env.pc.bind(job.id, env.users.agent));
  const policy = env.pc.policyDetail(job.policyId, env.users.uwm);
  assert.match(policy.policyNumber, /^TW-\d{7}$/);
  assert.equal(policy.status, 'In Force');
  assert.ok(policy.documents.some((d) => d.name === 'Declarations Page'));
});

test('a bigger engine and a sport bike cost more; rider training, a second bike and paying in full cost less', () => {
  const total = (over) => quote(submission(over)).quote.total;
  const base = total({});
  assert.ok(total({ bikes: [bike({ engineCc: 900, bikeType: 'Commuter' })] }) > base, 'a 900cc bike costs more than a 300cc bike');
  assert.ok(total({ bikes: [bike({ bikeType: 'Sport' })] }) > base, 'a sport bike costs more than a commuter bike');
  assert.ok(total({ riders: [rider({ riderTraining: true })] }) < base, 'rider training earns a discount');
  assert.ok(total({ plan: 'Quarterly' }) > base, 'the paid-in-full discount is lost on instalments');
  const two = quote(submission({ bikes: [bike(), bike({ vin: '1HGCM82633A654321' })] }));
  assert.ok(two.quote.costs.some((c) => c.coverageCode === 'MultiBikeDiscount'));
});

test('the answers to the questions are kept, and an unknown answer counts as not answered', () => {
  const env = submission({ answers: { ...NO, modified: 'yes', racing: 'maybe' } });
  const { answers } = env.pc.job(env.job.id).period.line;
  assert.deepEqual([answers.modified, answers.racing, answers.priorLapse], ['yes', '', 'no']);
});

test('validation: a rider, a bike, a valid VIN and engine size, physical damage rules, and every question answered', () => {
  const messages = (over) => {
    const env = submission(over);
    try { env.run(() => env.pc.quote(env.job.id, env.users.agent)); } catch (e) { return e.details.errors.map((x) => x.message); }
    return [];
  };
  assert.deepEqual(messages({}), []);
  assert.ok(messages({ riders: [] }).some((m) => /rider is required/i.test(m)));
  assert.ok(messages({ bikes: [] }).some((m) => /bike is required/i.test(m)));
  assert.ok(messages({ bikes: [bike({ vin: 'SHORT' })] }).some((m) => /VIN/.test(m)));
  assert.ok(messages({ bikes: [bike({ engineCc: 20 })] }).some((m) => /engine/i.test(m)));
  assert.ok(messages({ riders: [rider({ dob: '2015-01-01', yearsLicensed: 0 })] }).some((m) => /at least 16/i.test(m)));
  assert.ok(messages({ answers: { modified: 'no' } }).some((m) => /answer/i.test(m)));
  assert.equal(messages({ answers: {} }).filter((m) => /answer/i.test(m)).length, PRODUCTS.TwoWheeler.questions.length);
});

test('underwriting from the rider and the bike: young rider on a big bike, sport bike, delivery use, a very big engine, high value', () => {
  const young = rider({ dob: '2007-01-01', yearsLicensed: 1 }); // 19 on the effective date
  const check = (over, code, level, blocks = 'BlocksBind') => {
    const env = submission(over);
    quote(env);
    const i = issues(env)[code];
    assert.ok(i, `${code} is raised`);
    assert.deepEqual([i.approvalLevel, i.blockingPoint], [level, blocks]);
  };
  check({ riders: [young], bikes: [bike({ engineCc: 400 })] }, 'TW_YOUNG_BIG_BIKE', 1);
  check({ riders: [young], bikes: [bike({ bikeType: 'Sport', engineCc: 150 })] }, 'TW_YOUNG_SPORT', 1);
  check({ bikes: [bike({ usage: 'Delivery' })] }, 'TW_DELIVERY_USE', 1);
  check({ bikes: [bike({ engineCc: 1300, bikeType: 'Cruiser' })] }, 'TW_LARGE_ENGINE', 2);
  check({ bikes: [bike({ marketValue: 30000 })] }, 'TW_HIGH_VALUE', 1);
  check({ riders: [rider({ accidents: 2 })] }, 'TW_ACCIDENT_HISTORY', 1, 'BlocksQuote');
});

test('underwriting from the answers: a modified bike needs an underwriter; racing and stunts cannot be approved', () => {
  const env = submission({ answers: { ...NO, modified: 'yes', priorLapse: 'yes', licenseSuspended: 'yes' } });
  quote(env);
  const found = issues(env);
  assert.equal(found.TW_MODIFIED.approvalLevel, 1);
  assert.equal(found.TW_PRIOR_LAPSE.approvalLevel, 1);
  assert.equal(found.TW_LICENSE_SUSPENDED.approvalLevel, 2);
  assert.ok(found.TW_MODIFIED.description.length > 10);

  const racing = submission({ answers: { ...NO, racing: 'yes' } });
  quote(racing);
  const decline = issues(racing).TW_RACING;
  assert.deepEqual([decline.approvable, decline.blockingPoint], [false, 'BlocksQuote']);
  assert.equal(racing.pc.job(racing.job.id).quote, null, 'a racing bike is not quoted');
});

test('a claim-free term earns the claim-free renewal discount on a two-wheeler, as on a personal auto', () => {
  const env = submission();
  env.run(() => env.pc.quote(env.job.id, env.users.agent));
  env.run(() => env.pc.bind(env.job.id, env.users.agent));
  env.setToday('2026-12-15');
  const renewal = env.run(() => env.pc.startRenewal(env.pc.job(env.job.id).policyId, env.users.agent));
  assert.equal(renewal.period.line.claimFreeRenewals, 1);
  assert.ok(renewal.quote.costs.some((c) => c.coverageCode === 'ClaimFreeDiscount'));
});
