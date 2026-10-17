'use strict';
// Demo data. Each step runs "as of" a business date so the history looks like it happened over
// time (no backdating referrals). Dates are relative to the real today.

const D = require('./dates');

function seed(pc) {
  const realToday = pc.today;
  const today = realToday();
  const day = (n) => D.addDays(today, n);
  const user = (id) => pc.user(id);
  const asOf = (date, fn) => {
    pc.today = () => date;
    try {
      return fn();
    } finally {
      pc.today = realToday;
    }
  };

  const submit = ({ account, product, eff, by, plan, line, bind = true }) =>
    asOf(eff, () => {
      const u = user(by);
      const job = pc.startSubmission({ accountId: account.id, product, effectiveDate: eff }, u);
      const merged = { ...job.period.line, ...line };
      if (line.dwelling) merged.dwelling = { ...job.period.line.dwelling, ...line.dwelling };
      pc.updateDraft(job.id, { paymentPlan: plan || 'PaidInFull', line: merged }, u);
      pc.quote(job.id, u);
      if (bind && job.status === 'Quoted') pc.bind(job.id, u);
      return job;
    });

  const acct = (by, a) => pc.createAccount(a, user(by));

  // 1. Jordan Rivera (TX): Homeowners + Personal Auto with multi-policy discount, plus an endorsement.
  const rivera = acct('agent', {
    firstName: 'Jordan', lastName: 'Rivera', dob: '1984-05-12', email: 'jordan.rivera@example.com', phone: '512-555-0142',
    address: { line1: '1400 Lavaca St', city: 'Austin', state: 'TX', zip: '78701' }, producerCode: 'PC-100',
  });
  submit({
    account: rivera, product: 'Homeowners', eff: day(-300), by: 'agent',
    line: {
      form: 'HO3',
      dwelling: { yearBuilt: 2012, construction: 'Masonry', squareFeet: 2400, roofAge: 6, protectionClass: 3, distanceToFireStation: 1.5, alarm: 'Central' },
      coverages: { HOWaterBackupCov: { selected: true, terms: { limit: '10000' } } },
    },
  });
  const riveraAuto = submit({
    account: rivera, product: 'PersonalAuto', eff: day(-120), by: 'agent', plan: 'Monthly',
    line: {
      drivers: [
        { firstName: 'Jordan', lastName: 'Rivera', dob: '1984-05-12', licenseNumber: 'TX40211873', licenseState: 'TX', yearsLicensed: 24, accidents: 0, violations: 1 },
        { firstName: 'Sam', lastName: 'Rivera', dob: '2008-03-10', licenseNumber: 'TX40877120', licenseState: 'TX', yearsLicensed: 1, accidents: 0, violations: 0, goodStudent: true },
      ],
      vehicles: [
        { year: 2022, make: 'Toyota', model: 'Camry SE', vin: 'JTDBF1FK3NU123456', usage: 'Commute', annualMiles: 12000, marketValue: 26000, garagingZip: '78701' },
        { year: 2017, make: 'Honda', model: 'CR-V EX', vin: '2HKRW2H85HH654321', usage: 'Pleasure', annualMiles: 6500, marketValue: 17500, garagingZip: '78701' },
      ],
    },
  });
  asOf(day(-30), () => {
    const u = user('agent');
    const change = pc.startPolicyChange(riveraAuto.policyId, { effectiveDate: day(-30) }, u);
    const line = JSON.parse(JSON.stringify(change.period.line));
    line.vehicles[0].coverages.PARentalCov.selected = true;
    line.vehicles[0].coverages.PATowingCov.selected = true;
    pc.updateDraft(change.id, { line }, u);
    pc.quote(change.id, u);
    pc.bind(change.id, u);
  });

  // 2. Priya Shah (IL): HO-5 with scheduled jewelry.
  const shah = acct('agent', {
    firstName: 'Priya', lastName: 'Shah', dob: '1979-11-02', email: 'priya.shah@example.com', phone: '312-555-0199',
    address: { line1: '2240 N Lincoln Ave', city: 'Chicago', state: 'IL', zip: '60614' }, producerCode: 'PC-100',
  });
  submit({
    account: shah, product: 'Homeowners', eff: day(-45), by: 'agent', plan: 'Quarterly',
    line: {
      form: 'HO5',
      dwelling: { yearBuilt: 2018, construction: 'Superior', squareFeet: 3200, roofAge: 7, protectionClass: 2, distanceToFireStation: 0.8, alarm: 'Central', sprinklers: true },
      coverages: { HOScheduledJewelryCov: { selected: true, terms: { limit: 12000 } }, HOIdentityTheftCov: { selected: true, terms: {} }, HOLiabilityCov: { selected: true, terms: { limit: '500000' } } },
    },
  });

  // 3. Marcus Chen (FL): HO-3 quoted, but the 22-year-old roof blocks bind -> referral to underwriter.
  const chen = acct('agent2', {
    firstName: 'Marcus', lastName: 'Chen', dob: '1970-02-17', email: 'marcus.chen@example.com', phone: '305-555-0110',
    address: { line1: '3301 Main Hwy', city: 'Miami', state: 'FL', zip: '33133' }, producerCode: 'PC-200',
  });
  submit({
    account: chen, product: 'Homeowners', eff: day(10), by: 'agent2', bind: false,
    line: {
      form: 'HO3',
      dwelling: { yearBuilt: 1998, construction: 'Frame', squareFeet: 2100, roofAge: 22, protectionClass: 4, distanceToFireStation: 2.5, pool: true, poolFenced: true },
    },
  });

  // 4. Emily Carter (OH): Personal Auto blocked at quote (2 at-fault accidents) -> referral.
  const carter = acct('agent2', {
    firstName: 'Emily', lastName: 'Carter', dob: '1996-08-21', email: 'emily.carter@example.com', phone: '614-555-0175',
    address: { line1: '88 E Broad St', city: 'Columbus', state: 'OH', zip: '43215' }, producerCode: 'PC-200',
  });
  submit({
    account: carter, product: 'PersonalAuto', eff: day(5), by: 'agent2', bind: false,
    line: {
      drivers: [{ firstName: 'Emily', lastName: 'Carter', dob: '1996-08-21', licenseNumber: 'OH77120394', licenseState: 'OH', yearsLicensed: 12, accidents: 2, violations: 1 }],
      vehicles: [{ year: 2020, make: 'Mazda', model: 'CX-5 Touring', vin: 'JM3KFBCM5L0112233', usage: 'Commute', annualMiles: 14000, marketValue: 21000, garagingZip: '43215' }],
    },
  });

  // 5. Ava Thompson (CA): renters policy, later cancelled at the insured's request.
  const thompson = acct('agent', {
    firstName: 'Ava', lastName: 'Thompson', dob: '1993-04-30', email: 'ava.thompson@example.com', phone: '619-555-0133',
    address: { line1: '700 W Harbor Dr', city: 'San Diego', state: 'CA', zip: '92101' }, producerCode: 'PC-100',
  });
  const renters = submit({
    account: thompson, product: 'Homeowners', eff: day(-200), by: 'agent',
    line: {
      form: 'HO4',
      dwelling: { yearBuilt: 2015, construction: 'Masonry', squareFeet: 950, roofAge: null, protectionClass: 2, distanceToFireStation: 1 },
      coverages: { HOPersonalPropertyCov: { selected: true, terms: { limit: 40000 } }, HOReplacementCostContentsCov: { selected: true, terms: {} }, HOLiabilityCov: { selected: true, terms: { limit: '100000' } } },
    },
  });
  asOf(day(-20), () => {
    const u = user('agent');
    const cancel = pc.startCancellation(renters.policyId, { effectiveDate: day(-20), reason: 'InsuredRequest' }, u);
    pc.bind(cancel.id, u);
  });

  // 6. Daniel Kim (NY): Personal Auto expiring soon -> renewal batch candidate.
  const kim = acct('agent', {
    firstName: 'Daniel', lastName: 'Kim', dob: '1988-09-14', email: 'daniel.kim@example.com', phone: '718-555-0167',
    address: { line1: '55 Water St', city: 'Brooklyn', state: 'NY', zip: '11201' }, producerCode: 'PC-100',
  });
  submit({
    account: kim, product: 'PersonalAuto', eff: day(-170), by: 'agent',
    line: {
      drivers: [{ firstName: 'Daniel', lastName: 'Kim', dob: '1988-09-14', licenseNumber: 'NY551203988', licenseState: 'NY', yearsLicensed: 15, accidents: 0, violations: 0 }],
      vehicles: [{ year: 2023, make: 'Tesla', model: 'Model 3', vin: '5YJ3E1EA7PF317001', usage: 'Commute', annualMiles: 9000, marketValue: 38000, garagingZip: '11201' }],
    },
  });

  // 7. Claims: one open auto claim with a partial payment, and one closed claim on Daniel Kim's auto policy.
  const policyOf = (acct, product) => pc.db.policies.find((p) => p.accountId === acct.id && p.product === product);
  const uw = user('uwm');
  asOf(day(-55), () => {
    const claim = pc.openClaim(policyOf(rivera, 'PersonalAuto').id, { lossDate: day(-60), lossType: 'Collision', description: 'Rear-ended at a red light; rear bumper and tail light damaged' }, user('agent'));
    pc.setClaimReserve(claim.id, 3200, uw);
    pc.payClaim(claim.id, { amount: 1100, note: 'Body shop estimate, first part' }, uw);
  });
  asOf(day(-30), () => {
    const claim = pc.openClaim(policyOf(kim, 'PersonalAuto').id, { lossDate: day(-95), lossType: 'Wind or hail', description: 'Hail damage to the hood and roof' }, user('agent'));
    pc.setClaimReserve(claim.id, 1200, uw);
    pc.payClaim(claim.id, { amount: 1200, note: 'Paid in full' }, uw);
    pc.closeClaim(claim.id, { reason: 'Settled in full' }, uw);
  });
}

module.exports = { seed };
