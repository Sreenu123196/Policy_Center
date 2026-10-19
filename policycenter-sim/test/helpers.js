'use strict';
const { Store } = require('../src/store');
const { PolicyCenter } = require('../src/policyCenter');

// Fresh in-memory PolicyCenter whose business date can be moved with setToday().
function setup(today = '2026-03-01') {
  const store = new Store();
  let current = today;
  const pc = new PolicyCenter(store, { today: () => current });
  const users = { agent: pc.user('agent'), uw: pc.user('uw'), uwm: pc.user('uwm') };
  const run = (fn) => store.transaction(fn);
  return { store, pc, users, run, setToday: (d) => { current = d; } };
}

function account(pc, user, overrides = {}) {
  return pc.createAccount({
    firstName: 'Test', lastName: 'Insured', dob: '1980-01-15', email: 't@example.com',
    address: { line1: '1 Main St', city: 'Columbus', state: 'OH', zip: '43215' }, producerCode: 'PC-100',
    ...overrides,
  }, user);
}

const driver = (over = {}) => ({ firstName: 'Test', lastName: 'Insured', dob: '1980-01-15', licenseNumber: 'OH1234567', licenseState: 'OH', yearsLicensed: 20, accidents: 0, violations: 0, ...over });
const vehicle = (over = {}) => ({ year: 2021, make: 'Ford', model: 'Escape', vin: '1FMCU9G60MUA12345', usage: 'Commute', annualMiles: 12000, marketValue: 22000, garagingZip: '43215', ...over });

function autoSubmission(pc, user, acct, eff, line = {}) {
  const job = pc.startSubmission({ accountId: acct.id, product: 'PersonalAuto', effectiveDate: eff }, user);
  pc.updateDraft(job.id, { line: { ...job.period.line, drivers: [driver()], vehicles: [vehicle()], ...line } }, user);
  return job;
}

function homeSubmission(pc, user, acct, eff, { form = 'HO3', dwelling = {}, coverages } = {}) {
  const job = pc.startSubmission({ accountId: acct.id, product: 'Homeowners', effectiveDate: eff }, user);
  const line = { ...job.period.line, form, dwelling: { ...job.period.line.dwelling, ...dwelling } };
  if (coverages) line.coverages = coverages;
  pc.updateDraft(job.id, { line }, user);
  return job;
}

module.exports = { setup, account, driver, vehicle, autoSubmission, homeSubmission };
