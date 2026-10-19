'use strict';
// Adds sample customers for the commercial lines: a bound policy that is renewed, one that is lapsing
// and one that has lapsed, with follow-up notes on the last two. Every record goes through the real
// service (validation, rating, underwriting, binding, renewal), with the business date set to the
// date each step happened.
//
//   node scripts/add-lob-sample-data.js
//
// Stop the server first: it keeps the data in memory and would overwrite these changes.
// A second run refuses, so the lists do not fill up with duplicates. Every customer has the last name LOBSample.

const path = require('node:path');
const { Store } = require('../src/store');
const { PolicyCenter } = require('../src/policyCenter');
const { seed } = require('../src/seed');
const D = require('../src/dates');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'policycenter.json');
const TAG = 'LOBSample';

const STREET = ['Harbor Rd', 'Mill St', 'Cedar Ave', 'Ridge Dr', 'Park Ln', 'Lake Blvd'];
const location = (i, over = {}) => ({
  description: `Site ${i + 1}`, address: { line1: `${200 + i} ${STREET[i % STREET.length]}`, city: 'Austin', zip: '78704' },
  construction: 'Masonry', occupancy: 'Retail', yearBuilt: 1994, protectionClass: 3, buildingValue: 850000, contentsValue: 140000, ...over,
});
const exposure = (classCode, amount, description) => ({ classCode, description, amount });
const vin = (n) => `1FTBW2CM0MKA${String(10000 + n).padStart(5, '0')}`;

// The six commercial lines and the customer details each one needs.
function linesFor(product, n) {
  switch (product) {
    case 'CommercialAuto':
      return {
        businessName: `Sample Fleet ${n} LLC`,
        drivers: [{ firstName: 'Ravi', lastName: TAG, dob: '1984-03-12', licenseNumber: `TX${40000000 + n}`, licenseState: 'TX', yearsLicensed: 18, accidents: 0, violations: 0 }],
        vehicles: [{ year: 2021, make: 'Ford', model: 'Transit', vin: vin(n), usage: 'Service', radius: 'Local', marketValue: 42000, garagingZip: '78704' }],
      };
    case 'GeneralLiability':
      return { businessName: `Sample Retail ${n} LLC`, claimsLast5Years: 0, exposures: [exposure('60010', 1200000, 'Retail sales')] };
    case 'CommercialProperty':
      return { businessName: `Sample Property ${n} LLC`, claimsLast5Years: 0, locations: [location(n)] };
    case 'WorkersComp':
      return {
        businessName: `Sample Services ${n} LLC`, experienceMod: 1,
        classes: [
          { classCode: '8810', description: 'Office staff', payroll: 600000, employees: 8 },
          { classCode: '8742', description: 'Sales', payroll: 250000, employees: 4 },
        ],
      };
    case 'Businessowners':
      return {
        businessName: `Sample Shop ${n} LLC`, claimsLast5Years: 0,
        locations: [location(n)], exposures: [exposure('60010', 900000, 'Shop sales')],
      };
    case 'Umbrella':
      return {
        businessName: `Sample Holdings ${n} LLC`, claimsLast5Years: 0, numberOfVehicles: 4, numberOfLocations: 2,
        underlyingAutoLimit: '1000000', underlyingGLLimit: '1000000', underlyingEmployersLimit: '500000',
        lineCoverages: { UMBExcessCov: { selected: true, terms: { limit: '2000000' } } },
      };
    default:
      throw new Error(`No sample data for ${product}`);
  }
}

const PRODUCTS = ['CommercialAuto', 'GeneralLiability', 'CommercialProperty', 'WorkersComp', 'Businessowners', 'Umbrella'];
const SHORT = { CommercialAuto: 'CA', GeneralLiability: 'GL', CommercialProperty: 'CP', WorkersComp: 'WC', Businessowners: 'BOP', Umbrella: 'UMB' };

function main() {
  const store = new Store(DATA_FILE);
  const realToday = D.todayISO;
  const pc = new PolicyCenter(store);
  if (store.isEmpty()) store.transaction(() => seed(pc));
  if (store.data.accounts.some((a) => a.lastName === TAG)) {
    console.error(`Sample commercial customers (last name ${TAG}) already exist. Nothing was added.`);
    process.exit(1);
  }

  const today = realToday();
  const uwm = pc.user('uwm');
  const sellers = [pc.user('agent'), pc.user('agent2')];
  const asOf = (date, fn) => {
    pc.today = () => date;
    try { return fn(); } finally { pc.today = realToday; }
  };
  // Quote, approve the underwriting issues the manager can approve, then bind.
  function quoteAndBind(jobId, user) {
    for (let attempt = 0; attempt < 3; attempt++) {
      pc.quote(jobId, user);
      const job = pc.job(jobId, user);
      const pending = (job.uwIssues || []).filter((i) => !i.approved);
      if (pending.some((i) => !i.approvable)) throw new Error(`${job.jobNumber} has an issue that cannot be approved`);
      for (const i of pending) pc.approveIssue(jobId, i.key, 'Approved in sample data load', uwm);
      if (pc.job(jobId, user).status === 'Quoted') pc.bind(jobId, user);
      if (pc.job(jobId, user).policyId || pc.job(jobId, user).status === 'Bound') return pc.job(jobId, user);
    }
    throw new Error(`${jobId} could not be bound`);
  }
  const bindNew = (acct, product, eff, line, seller) => asOf(eff, () => {
    const job = pc.startSubmission({ accountId: acct.id, product, effectiveDate: eff }, seller);
    pc.updateDraft(job.id, { line: { ...job.period.line, ...line } }, seller);
    return quoteAndBind(job.id, seller);
  });

  const report = [];
  let n = 0;
  for (const product of PRODUCTS) {
    for (const [slot, label] of [['renewed', 'renewed'], ['lapsing', 'lapsing, follow-up'], ['lapsed', 'lapsed, follow-up']]) {
      n += 1;
      const seller = sellers[n % sellers.length];
      const first = `${SHORT[product]} ${label.split(',')[0]}`.replace(/\s+/g, '');
      try {
        store.transaction(() => {
          const acct = pc.createAccount({
            firstName: first, lastName: TAG, dob: '1980-06-15', email: `${SHORT[product].toLowerCase()}.${slot}@example.com`,
            phone: `415555${String(2000 + n).padStart(4, '0')}`,
            address: { line1: `${100 + n} Sample St`, city: 'Austin', state: 'TX', zip: '78704' },
            producerCode: seller.producerCode,
          }, seller);
          // Effective dates chosen so the policy is renewed now, still running and about to lapse, or already lapsed.
          const eff = slot === 'renewed' ? D.addMonths(today, -11)
            : slot === 'lapsing' ? D.addDays(D.addMonths(today, -12), 15)
              : D.addDays(D.addMonths(today, -12), -20);
          const bound = bindNew(acct, product, eff, linesFor(product, n), seller);
          let note;
          if (slot === 'renewed') {
            const policy = pc.policy(bound.policyId);
            const expiry = pc.lastTerm(policy).expirationDate;
            const renewal = asOf(D.addDays(expiry, -30), () => pc.startRenewal(policy.id, seller));
            asOf(D.addDays(expiry, -30), () => quoteAndBind(renewal.id, seller));
            note = 'renewed for a second term';
          } else {
            const policy = pc.policy(bound.policyId);
            const contacts = [
              { channel: 'Phone', result: 'No answer', notes: 'Left a voicemail about renewal options' },
              { channel: 'Email', result: 'Callback requested', notes: 'Asked for a renewal quote next week' },
            ];
            for (const f of contacts) pc.logFollowUp(policy.id, f, seller);
            note = `${contacts.length} follow-up notes logged`;
          }
          report.push({ product: SHORT[product], account: `${first} ${TAG}`, policy: pc.policy(bound.policyId).policyNumber, seller: seller.name, status: label, note });
        });
      } catch (err) {
        report.push({ product: SHORT[product], account: `${first} ${TAG}`, error: err.message });
      }
    }
  }

  console.log('------------------------------------------------------------');
  for (const r of report) {
    if (r.error) console.log(`  ${r.product.padEnd(4)} ${r.account.padEnd(26)} FAILED: ${r.error}`);
    else console.log(`  ${r.product.padEnd(4)} ${r.account.padEnd(26)} ${r.policy}  ${r.status.padEnd(20)} sold by ${r.seller} · ${r.note}`);
  }
  const failed = report.filter((r) => r.error).length;
  console.log(`Added ${report.length - failed} customers with policies; ${failed} failed.`);
  console.log('------------------------------------------------------------');
}

main();
