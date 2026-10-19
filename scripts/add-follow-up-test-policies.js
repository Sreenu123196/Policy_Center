'use strict';
// Adds test customers whose policies are lapsing or lapsed, so the renewal follow-up list, the
// WhatsApp and Email buttons and the follow-up log can be tried out.
//
//   node scripts/add-follow-up-test-policies.js
//
// Each policy is bound through the real service (validation, rating, underwriting, binding), with the
// business date set to the policy's effective date. Every test customer has the last name FollowUpTest.
// Run it once: a second run refuses, so the list does not fill up with duplicates.
// Stop the server first: it keeps the data in memory and would overwrite these changes.
//
// Lapsing: the term ends within the next 60 days. Lapsed: the term ended in the last 90 days.

const path = require('node:path');
const { Store } = require('../src/store');
const { PolicyCenter } = require('../src/policyCenter');
const { PRODUCTS } = require('../src/productModel');
const { seed } = require('../src/seed');
const D = require('../src/dates');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'policycenter.json');
const TAG = 'FollowUpTest';

// Expiry offsets from today, in days. Positive = still running (lapsing), negative = already ended (lapsed).
const CASES = [
  { days: 10, status: 'Lapsing' }, { days: 25, status: 'Lapsing' }, { days: 40, status: 'Lapsing' }, { days: 55, status: 'Lapsing' },
  { days: -5, status: 'Lapsed' }, { days: -20, status: 'Lapsed' }, { days: -45, status: 'Lapsed' },
];
const FIRST = ['Ravi', 'Anita', 'Suresh', 'Lakshmi', 'Kiran', 'Meena', 'Arjun'];
const STREETS = ['Oak St', 'Cedar Ave', 'Pine Dr', 'Elm Ln', 'Lake Rd', 'Hill Ct', 'Park Blvd'];

function main() {
  const store = new Store(DATA_FILE);
  const realToday = D.todayISO;
  const pc = new PolicyCenter(store);
  if (store.isEmpty()) store.transaction(() => seed(pc));
  if (store.data.accounts.some((a) => a.lastName === TAG)) {
    console.error(`Follow-up test customers (last name ${TAG}) already exist. Nothing was added.`);
    process.exit(1);
  }

  const uwm = pc.user('uwm');
  const sellers = [pc.user('agent'), pc.user('agent2')];
  const termMonths = PRODUCTS.PersonalAuto.termMonths;
  const today = realToday();
  const asOf = (date, fn) => {
    pc.today = () => date;
    try { return fn(); } finally { pc.today = realToday; }
  };

  const created = [];
  store.transaction(() => {
    CASES.forEach((c, i) => {
      const seller = sellers[i % sellers.length];
      const expiry = D.addDays(today, c.days);
      const effective = D.addMonths(expiry, -termMonths);
      const state = 'TX';
      const account = pc.createAccount({
        firstName: FIRST[i], lastName: TAG, dob: '1982-06-1' + (i % 9), email: `followup${i + 1}@example.com`,
        phone: `415555${String(1000 + i).padStart(4, '0')}`,
        address: { line1: `${100 + i} ${STREETS[i]}`, city: 'Austin', state, zip: '78704' },
        producerCode: seller.producerCode,
      }, seller);
      const job = pc.startSubmission({ accountId: account.id, product: 'PersonalAuto', effectiveDate: effective }, seller);
      pc.updateDraft(job.id, {
        line: {
          ...job.period.line,
          drivers: [{ firstName: FIRST[i], lastName: TAG, dob: '1982-06-1' + (i % 9), licenseNumber: `${state}${String(20000000 + i)}`, licenseState: state, yearsLicensed: 20, accidents: 0, violations: 0 }],
          vehicles: [{ year: 2021, make: 'Toyota', model: 'Camry', vin: `1HGCM82633A${String(100000 + i)}`, usage: 'Commute', annualMiles: 12000, marketValue: 24000, garagingZip: '78704' }],
        },
      }, seller);
      asOf(effective, () => {
        pc.quote(job.id, seller);
        for (const issue of job.uwIssues.filter((x) => !x.approved)) pc.approveIssue(job.id, issue.key, 'Approved for follow-up test data', uwm);
        pc.quote(job.id, seller);
        pc.bind(job.id, seller);
      });
      const policy = pc.policy(job.policyId);
      created.push({ name: `${FIRST[i]} ${TAG}`, seller: seller.name, status: c.status, expires: pc.lastTerm(policy).expirationDate, policy: policy.policyNumber });
    });
  });

  console.log('------------------------------------------------------------');
  console.log(`Added ${created.length} follow-up test policies (last name ${TAG}):`);
  for (const r of created) console.log(`  ${r.policy}  ${r.name.padEnd(22)} ${r.status.padEnd(9)} expires ${r.expires}  sold by ${r.seller}`);
  const listed = pc.lapsePolicies(uwm).filter((r) => r.insured && r.insured.includes(TAG));
  console.log(`The Sales > Lapsing & lapsed list shows ${listed.length} of them today (${today}).`);
  console.log('------------------------------------------------------------');
}

main();
