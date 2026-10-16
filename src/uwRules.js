'use strict';
// Underwriting rules (PolicyCenter UW Issues). Each rule can raise an issue with:
//   blockingPoint  BlocksQuote | BlocksBind
//   approvalLevel  authority needed to approve (1 underwriter, 2 UW manager), or null = cannot be
//                  approved, the risk itself has to change (effectively a decline)
//   value          numeric severity; an approval stays valid on re-quote while value <= approved value

const { replacementCostEstimate } = require('./rating');
const D = require('./dates');

const LEVEL_NAMES = { 1: 'Underwriter', 2: 'UW Manager' };

function issue(code, name, description, blockingPoint, approvalLevel, value, coverableId) {
  return {
    key: coverableId ? `${code}:${coverableId}` : code,
    code, name, description, blockingPoint,
    approvalLevel,
    approvable: approvalLevel !== null,
    requiredRole: approvalLevel ? LEVEL_NAMES[approvalLevel] : null,
    value,
  };
}

function personalAutoIssues(p) {
  const out = [];
  const { drivers, vehicles } = p.line;
  const effYear = D.yearOf(p.effectiveDate);
  for (const d of drivers) {
    const who = `${d.firstName} ${d.lastName}`;
    const age = D.ageOn(d.dob, p.effectiveDate);
    if (age < 18) out.push(issue('PA_YOUTHFUL_DRIVER', 'Youthful driver', `${who} is ${age}; drivers under 18 need underwriter review`, 'BlocksBind', 1, 18 - age, d.id));
    if (age >= 80) out.push(issue('PA_SENIOR_DRIVER', 'Senior driver', `${who} is ${age}; drivers 80+ need underwriter review`, 'BlocksBind', 1, age, d.id));
    if (d.accidents >= 3) out.push(issue('PA_ACCIDENT_HISTORY', 'Accident history', `${who} has ${d.accidents} at-fault accidents in 3 years`, 'BlocksQuote', 2, d.accidents, d.id));
    else if (d.accidents === 2) out.push(issue('PA_ACCIDENT_HISTORY', 'Accident history', `${who} has 2 at-fault accidents in 3 years`, 'BlocksQuote', 1, 2, d.id));
    if (d.violations >= 4) out.push(issue('PA_MAJOR_VIOLATIONS', 'Excessive violations', `${who} has ${d.violations} violations in 3 years; outside appetite`, 'BlocksQuote', null, d.violations, d.id));
  }
  if (vehicles.length > 4) out.push(issue('PA_VEHICLE_COUNT', 'Large household fleet', `${vehicles.length} vehicles on one personal auto policy`, 'BlocksQuote', 2, vehicles.length));
  vehicles.forEach((v, i) => {
    const what = `Vehicle ${i + 1} (${v.year} ${v.make} ${v.model})`;
    if (v.usage === 'Business') out.push(issue('PA_BUSINESS_USE', 'Business use', `${what} is used for business`, 'BlocksBind', 1, 1, v.id));
    if (v.annualMiles > 30000) out.push(issue('PA_HIGH_MILEAGE', 'High annual mileage', `${what} drives ${v.annualMiles.toLocaleString('en-US')} miles a year`, 'BlocksBind', 1, v.annualMiles, v.id));
    if (v.marketValue > 100000) out.push(issue('PA_HIGH_VALUE_VEHICLE', 'High-value vehicle', `${what} is valued at $${v.marketValue.toLocaleString('en-US')}`, 'BlocksBind', 2, v.marketValue, v.id));
    if (effYear - v.year > 20 && v.coverages.PACollisionCov?.selected) out.push(issue('PA_OLD_VEHICLE_COLLISION', 'Collision on older vehicle', `${what} is over 20 years old with Collision`, 'BlocksBind', 1, effYear - v.year, v.id));
  });
  return out;
}

function homeownersIssues(p) {
  const out = [];
  const { form, dwelling: d, coverages: c } = p.line;
  const owner = form === 'HO3' || form === 'HO5';
  const homeAge = D.yearOf(p.effectiveDate) - d.yearBuilt;
  const A = Number(c.HODwellingCov?.terms.limit || 0);
  if (owner && d.roofAge > 25) out.push(issue('HO_ROOF_AGE', 'Roof age', `Roof is ${d.roofAge} years old`, 'BlocksBind', 2, d.roofAge));
  else if (owner && d.roofAge > 20) out.push(issue('HO_ROOF_AGE', 'Roof age', `Roof is ${d.roofAge} years old`, 'BlocksBind', 1, d.roofAge));
  if (A > 1000000) out.push(issue('HO_HIGH_VALUE', 'High-value dwelling', `Coverage A of $${A.toLocaleString('en-US')} exceeds $1M`, 'BlocksBind', 2, A));
  if (d.protectionClass === 10) out.push(issue('HO_PROTECTION_CLASS', 'Unprotected property', 'Protection class 10 is outside appetite', 'BlocksQuote', null, 10));
  else if (d.protectionClass === 9) out.push(issue('HO_PROTECTION_CLASS', 'Poor fire protection', 'Protection class 9 needs underwriter review', 'BlocksQuote', 1, 9));
  if (d.distanceToFireStation > 5) out.push(issue('HO_FIRE_STATION_DISTANCE', 'Distance to fire station', `${d.distanceToFireStation} miles to the nearest fire station`, 'BlocksBind', 1, d.distanceToFireStation));
  if (d.priorClaims >= 3) out.push(issue('HO_PRIOR_CLAIMS', 'Loss history', `${d.priorClaims} claims in 5 years; outside appetite`, 'BlocksQuote', null, d.priorClaims));
  else if (d.priorClaims === 2) out.push(issue('HO_PRIOR_CLAIMS', 'Loss history', '2 claims in 5 years', 'BlocksQuote', 1, 2));
  if (d.aggressiveDog) out.push(issue('HO_ANIMAL_LIABILITY', 'Animal liability exposure', 'Household has a dog with a bite history or a restricted breed', 'BlocksBind', 1, 1));
  if (d.trampoline) out.push(issue('HO_TRAMPOLINE', 'Trampoline on premises', 'Trampoline liability exposure', 'BlocksBind', 1, 1));
  if (d.pool && !d.poolFenced) out.push(issue('HO_UNFENCED_POOL', 'Unfenced swimming pool', 'Pool without a locking fence', 'BlocksBind', 1, 1));
  if (form === 'HO5' && homeAge > 40) out.push(issue('HO_HO5_ELIGIBILITY', 'HO-5 eligibility', `Home is ${homeAge} years old; HO-5 is limited to homes 40 years or newer. Use HO-3.`, 'BlocksQuote', null, homeAge));
  if (owner) {
    const rce = replacementCostEstimate(p.state, d.construction, d.squareFeet, p.effectiveDate);
    if (rce && A < rce * 0.8) {
      const itv = Math.round((A / rce) * 100);
      out.push(issue('HO_UNDERINSURED', 'Insurance to value', `Coverage A is ${itv}% of the $${rce.toLocaleString('en-US')} replacement cost estimate (minimum 80%)`, 'BlocksBind', 1, 100 - itv));
    }
  }
  if (p.state === 'FL' && c.HODeductibles?.terms.windHail === '1%') out.push(issue('HO_COASTAL_WIND_DEDUCTIBLE', 'Low wind deductible', '1% hurricane deductible in Florida needs manager approval', 'BlocksBind', 2, 1));
  return out;
}

function evaluateUW(product, period, { jobType, today }) {
  const issues = product === 'PersonalAuto' ? personalAutoIssues(period) : homeownersIssues(period);
  if (jobType === 'Submission') {
    const back = D.daysBetween(period.effectiveDate, today);
    if (back > 5) issues.push(issue('BACKDATED_EFFECTIVE_DATE', 'Backdated coverage', `Effective date is ${back} days in the past`, 'BlocksBind', 1, back));
  }
  return issues;
}

function applyApprovals(issues, approvals = {}) {
  return issues.map((i) => {
    const a = approvals[i.key];
    const ok = a && i.approvable && Number(i.value) <= Number(a.value);
    return ok ? { ...i, approved: true, approval: a } : { ...i, approved: false, approval: null };
  });
}

module.exports = { evaluateUW, applyApprovals, LEVEL_NAMES };
