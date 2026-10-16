'use strict';
// Generates test accounts with bound policies by driving the PolicyCenter service, so every record
// goes through validation, rating, UW rules and binding like real data.
//
//   node scripts/generate-test-data.js [count=100] [seed=42]
//
// Stop the server first: it keeps the data in memory and would overwrite this script's changes.
// The output is deterministic for a given seed.

const path = require('node:path');
const { Store } = require('../src/store');
const { PolicyCenter } = require('../src/policyCenter');
const { PRODUCTS } = require('../src/productModel');
const { seed } = require('../src/seed');
const D = require('../src/dates');

const COUNT = Number(process.argv[2]) || 100;
const SEED = Number(process.argv[3]) || 42;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'policycenter.json');

// Mulberry32: small deterministic PRNG.
let state = SEED >>> 0;
function rand() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const weighted = (pairs) => {
  let r = rand() * pairs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of pairs) if ((r -= w) < 0) return v;
  return pairs[pairs.length - 1][0];
};

const FIRST = ['James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Carlos', 'Karen', 'Daniel', 'Lisa', 'Matthew', 'Nancy', 'Anthony', 'Betty', 'Mark', 'Sandra', 'Wei', 'Ashley', 'Steven', 'Kimberly', 'Andrew', 'Emily', 'Kenji', 'Donna', 'Joshua', 'Michelle', 'Kevin', 'Carol', 'Brian', 'Amanda', 'Luis', 'Melissa', 'Arjun', 'Deborah', 'Omar', 'Stephanie', 'Ryan', 'Aisha'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Patel', 'Okafor'];
const STREETS = ['Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Washington', 'Lake', 'Hill', 'Park', 'Sunset', 'Highland', 'Ridge', 'Willow', 'River', 'Meadow', 'Forest', 'Lincoln', 'Jefferson'];
const SUFFIX = ['St', 'Ave', 'Dr', 'Ln', 'Rd', 'Ct', 'Blvd', 'Way'];
const CITIES = {
  CA: [['Los Angeles', '90024'], ['San Diego', '92103'], ['San Jose', '95126'], ['Sacramento', '95819'], ['Fresno', '93704']],
  FL: [['Miami', '33133'], ['Orlando', '32803'], ['Tampa', '33606'], ['Jacksonville', '32207'], ['Tallahassee', '32303']],
  IL: [['Chicago', '60614'], ['Naperville', '60540'], ['Springfield', '62704'], ['Peoria', '61604'], ['Evanston', '60201']],
  NY: [['Brooklyn', '11215'], ['Buffalo', '14216'], ['Rochester', '14620'], ['Albany', '12203'], ['Yonkers', '10701']],
  OH: [['Columbus', '43214'], ['Cleveland', '44113'], ['Cincinnati', '45208'], ['Dayton', '45419'], ['Toledo', '43615']],
  TX: [['Austin', '78704'], ['Houston', '77006'], ['Dallas', '75214'], ['San Antonio', '78209'], ['Plano', '75093']],
};
const VEHICLES = [
  ['Toyota', 'Camry', 28000], ['Toyota', 'RAV4', 31000], ['Honda', 'Civic', 25000], ['Honda', 'CR-V', 32000],
  ['Ford', 'F-150', 45000], ['Ford', 'Escape', 29000], ['Chevrolet', 'Silverado', 44000], ['Chevrolet', 'Equinox', 28000],
  ['Nissan', 'Altima', 26000], ['Hyundai', 'Tucson', 29000], ['Subaru', 'Outback', 31000], ['Jeep', 'Grand Cherokee', 42000],
  ['Tesla', 'Model Y', 50000], ['BMW', 'X3', 49000], ['Kia', 'Telluride', 39000], ['Mazda', 'CX-5', 30000],
];
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const vin = () => Array.from({ length: 17 }, () => pick([...VIN_CHARS])).join('');
const license = (st) => st + String(int(10000000, 99999999));

function main() {
  const store = new Store(DATA_FILE);
  const realToday = D.todayISO;
  const today = realToday();
  const pc = new PolicyCenter(store);
  if (store.isEmpty()) store.transaction(() => seed(pc));
  const uwm = pc.user('uwm');
  const agents = { 'PC-100': pc.user('agent'), 'PC-200': pc.user('agent2') };
  const asOf = (date, fn) => {
    pc.today = () => date;
    try {
      return fn();
    } finally {
      pc.today = realToday;
    }
  };
  const stats = { accounts: 0, policies: 0, PersonalAuto: 0, Homeowners: 0, approvals: 0, changes: 0, cancellations: 0, failed: [] };
  let tally;

  // Quote, have the UW manager approve anything approvable, and bind. Returns the bound job or null.
  function quoteAndBind(job, user) {
    for (let attempt = 0; attempt < 3; attempt++) {
      pc.quote(job.id, user);
      const pending = job.uwIssues.filter((i) => !i.approved);
      if (pending.some((i) => !i.approvable)) return null;
      for (const i of pending) {
        pc.approveIssue(job.id, i.key, 'Approved during test data load', uwm);
        tally.approvals++;
      }
      if (job.status === 'Quoted') {
        pc.bind(job.id, user);
        if (job.status === 'Bound') return job;
      }
    }
    return null;
  }

  function autoLine(acct, eff) {
    const st = acct.address.state;
    const effYear = D.yearOf(eff);
    const drivers = [{ firstName: acct.firstName, lastName: acct.lastName, dob: acct.dob, licenseNumber: license(st), licenseState: st, yearsLicensed: Math.min(D.ageOn(acct.dob, eff) - 16, int(5, 40)), accidents: weighted([[0, 85], [1, 13], [2, 2]]), violations: weighted([[0, 70], [1, 22], [2, 8]]) }];
    if (chance(0.45)) {
      const dob = `${int(1960, 2000)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
      drivers.push({ firstName: pick(FIRST), lastName: acct.lastName, dob, licenseNumber: license(st), licenseState: st, yearsLicensed: Math.max(0, Math.min(D.ageOn(dob, eff) - 16, int(3, 35))), accidents: weighted([[0, 90], [1, 10]]), violations: weighted([[0, 80], [1, 20]]) });
    }
    if (chance(0.15)) {
      const age = int(16, 19);
      const dob = `${effYear - age - 1}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
      drivers.push({ firstName: pick(FIRST), lastName: acct.lastName, dob, licenseNumber: license(st), licenseState: st, yearsLicensed: Math.max(0, Math.min(D.ageOn(dob, eff) - 16, 2)), accidents: 0, violations: weighted([[0, 85], [1, 15]]), goodStudent: chance(0.5) });
    }
    const nVeh = weighted([[1, 50], [2, 38], [3, 12]]);
    const vehicles = Array.from({ length: nVeh }, () => {
      const [make, model, price] = pick(VEHICLES);
      const year = int(effYear - 14, effYear);
      const value = Math.round((price * Math.pow(0.86, effYear - year)) / 100) * 100;
      const old = effYear - year > 10;
      return {
        year, make, model, vin: vin(),
        usage: weighted([['Commute', 60], ['Pleasure', 37], ['Business', 3]]),
        annualMiles: int(4, 22) * 1000,
        marketValue: value,
        garagingZip: acct.address.zip,
        coverages: {
          PACollisionCov: { selected: !old || chance(0.3), terms: { deductible: pick(['250', '500', '500', '1000', '2000']) } },
          PAComprehensiveCov: { selected: !old || chance(0.5), terms: { deductible: pick(['100', '250', '500', '500', '1000']) } },
          PARentalCov: { selected: chance(0.35), terms: { limit: pick(['30/900', '50/1500']) } },
          PATowingCov: { selected: chance(0.4), terms: { limit: pick(['75', '150']) } },
        },
      };
    });
    // Physical damage dependencies: Collision and Rental both need Comprehensive.
    for (const v of vehicles) {
      if (v.coverages.PACollisionCov.selected || v.coverages.PARentalCov.selected) v.coverages.PAComprehensiveCov.selected = true;
    }
    const bi = weighted([['25/50', 10], ['50/100', 25], ['100/300', 45], ['250/500', 20]]);
    const order = ['25/50', '50/100', '100/300', '250/500'];
    const um = order[Math.min(order.indexOf(bi), int(0, 3))];
    return {
      drivers,
      vehicles,
      lineCoverages: {
        PABodilyInjuryCov: { selected: true, terms: { limit: bi } },
        PAPropertyDamageCov: { selected: true, terms: { limit: pick(['25', '50', '100', '100', '250']) } },
        PAUninsuredMotoristCov: { selected: chance(0.85), terms: { limit: um } },
        PAMedPayCov: { selected: chance(0.7), terms: { limit: pick(['1000', '5000', '10000']) } },
      },
    };
  }

  function homeLine(acct, eff) {
    const effYear = D.yearOf(eff);
    const form = weighted([['HO3', 55], ['HO5', 15], ['HO4', 20], ['HO6', 10]]);
    const owner = form === 'HO3' || form === 'HO5';
    const yearBuilt = form === 'HO5' ? int(effYear - 35, effYear - 1) : int(effYear - 70, effYear - 1);
    const homeAge = effYear - yearBuilt;
    const pool = chance(0.12);
    const coverages = {
      HOLiabilityCov: { selected: true, terms: { limit: weighted([['100000', 20], ['300000', 50], ['500000', 25], ['1000000', 5]]) } },
      HOMedPayCov: { selected: true, terms: { limit: pick(['1000', '2500', '5000']) } },
      HODeductibles: { selected: true, terms: { aop: weighted([['500', 10], ['1000', 50], ['2500', 30], ['5000', 10]]), windHail: pick(['2%', '2%', '5%']) } },
      HOWaterBackupCov: { selected: chance(0.4), terms: { limit: pick(['5000', '10000', '25000']) } },
      HOIdentityTheftCov: { selected: chance(0.25), terms: {} },
      HOReplacementCostContentsCov: { selected: chance(0.45), terms: {} },
      HOScheduledJewelryCov: { selected: chance(0.12), terms: { limit: int(2, 30) * 1000 } },
      HOEarthquakeCov: { selected: acct.address.state === 'CA' ? chance(0.35) : chance(0.03), terms: { deductible: pick(['10%', '15%', '20%']) } },
    };
    if (form === 'HO4') coverages.HOPersonalPropertyCov = { selected: true, terms: { limit: int(15, 80) * 1000 } };
    return {
      form,
      dwelling: {
        line1: acct.address.line1, city: acct.address.city, zip: acct.address.zip,
        yearBuilt,
        construction: weighted([['Frame', 55], ['Masonry', 35], ['Superior', 10]]),
        squareFeet: owner ? int(12, 42) * 100 : int(6, 18) * 100,
        stories: owner ? int(1, 3) : 1,
        roofAge: owner ? Math.min(homeAge, int(0, 24)) : null,
        protectionClass: weighted([[1, 5], [2, 10], [3, 20], [4, 25], [5, 18], [6, 12], [7, 6], [8, 3], [9, 1]]),
        distanceToFireStation: Math.round(rand() * 70) / 10,
        alarm: weighted([['None', 50], ['Local', 30], ['Central', 20]]),
        sprinklers: chance(0.08),
        pool,
        poolFenced: pool && chance(0.85),
        trampoline: chance(0.05),
        aggressiveDog: chance(0.04),
        priorClaims: weighted([[0, 78], [1, 17], [2, 5]]),
      },
      coverages,
    };
  }

  function issue(acct, product, eff) {
    const user = agents[acct.producerCode];
    const job = asOf(eff, () => {
      const j = pc.startSubmission({ accountId: acct.id, product, effectiveDate: eff }, user);
      const line = product === 'PersonalAuto' ? autoLine(acct, eff) : homeLine(acct, eff);
      pc.updateDraft(j.id, { paymentPlan: pick(PRODUCTS[product].paymentPlans.map((p) => p.code)), line }, user);
      return quoteAndBind(j, user);
    });
    if (!job) throw new Error(`${product} submission could not be bound`);
    tally.policies++;
    tally[product]++;
    return job;
  }

  // A later endorsement on some policies, and a cancellation on a few, all dated in the past.
  function lifecycle(acct, job) {
    const user = agents[acct.producerCode];
    const eff = job.period.effectiveDate;
    const latest = D.addDays(today, -1);
    if (eff >= latest) return;
    const changeDate = D.addDays(eff, int(10, Math.max(10, D.daysBetween(eff, latest))));
    if (changeDate > latest || changeDate >= job.period.expirationDate) return;
    if (chance(0.15)) {
      asOf(changeDate, () => {
        const ch = pc.startPolicyChange(job.policyId, { effectiveDate: changeDate }, user);
        const line = JSON.parse(JSON.stringify(ch.period.line));
        if (job.product === 'PersonalAuto') {
          line.lineCoverages.PABodilyInjuryCov.terms.limit = '250/500';
          for (const v of line.vehicles) v.coverages.PATowingCov.selected = true;
        } else {
          line.coverages.HOWaterBackupCov.selected = true;
          line.coverages.HOWaterBackupCov.terms.limit = '25000';
        }
        pc.updateDraft(ch.id, { line }, user);
        if (quoteAndBind(ch, user)) tally.changes++;
      });
    } else if (chance(0.06)) {
      asOf(changeDate, () => {
        const c = pc.startCancellation(job.policyId, { effectiveDate: changeDate, reason: 'InsuredRequest' }, user);
        pc.bind(c.id, user);
        tally.cancellations++;
      });
    }
  }

  for (let n = 0; n < COUNT; n++) {
    const st = pick(Object.keys(CITIES));
    const [city, zip] = pick(CITIES[st]);
    const producerCode = chance(0.6) ? 'PC-100' : 'PC-200';
    const firstName = pick(FIRST);
    const lastName = pick(LAST);
    const input = {
      firstName, lastName,
      dob: `${int(1950, 2000)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
      email: `${firstName}.${lastName}.${n + 1}@example.com`.toLowerCase(),
      phone: `555-${String(int(100, 999))}-${String(int(1000, 9999))}`,
      address: { line1: `${int(10, 9999)} ${pick(STREETS)} ${pick(SUFFIX)}`, city, state: st, zip },
      producerCode,
    };
    const products = weighted([[['PersonalAuto'], 45], [['Homeowners'], 35], [['Homeowners', 'PersonalAuto'], 20]]);
    tally = { policies: 0, PersonalAuto: 0, Homeowners: 0, approvals: 0, changes: 0, cancellations: 0 };
    try {
      store.transaction(() => {
        const acct = pc.createAccount(input, agents[producerCode]);
        for (const product of products) {
          // Homeowners terms are 12 months and auto terms 6, so start dates keep most policies in force.
          const back = product === 'Homeowners' ? int(-20, 330) : int(-20, 170);
          lifecycle(acct, issue(acct, product, D.addDays(today, -back)));
        }
      });
      stats.accounts++;
      for (const k of Object.keys(tally)) stats[k] += tally[k];
    } catch (err) {
      stats.failed.push(`${firstName} ${lastName}: ${err.message}`);
    }
  }

  console.log(JSON.stringify({ dataFile: DATA_FILE, seed: SEED, ...stats, failed: stats.failed.length, failures: stats.failed.slice(0, 10) }, null, 2));
}

main();
