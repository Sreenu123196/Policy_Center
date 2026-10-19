'use strict';
// Underwriting rules (PolicyCenter UW Issues). Each rule can raise an issue with:
//   blockingPoint  BlocksQuote | BlocksBind
//   approvalLevel  authority needed to approve (1 underwriter, 2 UW manager), or null = cannot be
//                  approved, the risk itself has to change (effectively a decline)
//   value          numeric severity; an approval stays valid on re-quote while value <= approved value

const { replacementCostEstimate } = require('./rating');
const { PRODUCTS } = require('./productModel');
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

function commercialAutoIssues(p) {
  const out = [];
  const { drivers, vehicles, lineCoverages } = p.line;
  const effYear = D.yearOf(p.effectiveDate);
  for (const d of drivers) {
    const who = `${d.firstName} ${d.lastName}`;
    const age = D.ageOn(d.dob, p.effectiveDate);
    if (age < 21) out.push(issue('CA_YOUNG_DRIVER', 'Young driver', `${who} is ${age}; drivers under 21 need underwriter review`, 'BlocksBind', 1, 21 - age, d.id));
    if (d.accidents >= 3) out.push(issue('CA_DRIVER_ACCIDENTS', 'Driver accident history', `${who} has ${d.accidents} at-fault accidents in 3 years`, 'BlocksQuote', 2, d.accidents, d.id));
    else if (d.accidents === 2) out.push(issue('CA_DRIVER_ACCIDENTS', 'Driver accident history', `${who} has 2 at-fault accidents in 3 years`, 'BlocksQuote', 1, 2, d.id));
    if (d.violations >= 4) out.push(issue('CA_MAJOR_VIOLATIONS', 'Excessive violations', `${who} has ${d.violations} violations in 3 years; outside appetite`, 'BlocksQuote', null, d.violations, d.id));
  }
  const perDriver = drivers.length ? drivers.reduce((s, d) => s + (d.accidents || 0), 0) / drivers.length : 0;
  if (perDriver >= 0.5) out.push(issue('CA_FLEET_LOSSES', 'Fleet loss history', `Fleet averages ${perDriver.toFixed(2)} at-fault accidents per driver in 3 years`, 'BlocksQuote', 2, perDriver));
  if (vehicles.length > 25) out.push(issue('CA_LARGE_FLEET', 'Large fleet', `${vehicles.length} vehicles on one commercial auto policy`, 'BlocksQuote', 2, vehicles.length));
  if (lineCoverages.CAAutoLiabilityCov && lineCoverages.CAAutoLiabilityCov.terms.limit === '2000000') {
    out.push(issue('CA_HIGH_LIMIT', 'High liability limit', 'A $2,000,000 liability limit needs UW Manager approval', 'BlocksBind', 2, 2000000));
  }
  vehicles.forEach((v, i) => {
    const what = `Vehicle ${i + 1} (${v.year} ${v.make} ${v.model})`;
    if (v.usage === 'Heavy') out.push(issue('CA_HEAVY_VEHICLE', 'Heavy truck', `${what} is a heavy truck; underwriter review`, 'BlocksBind', 1, 1, v.id));
    if (v.radius === 'Long') out.push(issue('CA_LONG_RADIUS', 'Long-radius operation', `${what} operates more than 200 miles from base`, 'BlocksBind', 1, 1, v.id));
    if (effYear - v.year > 20 && v.coverages.CACollisionCov?.selected) out.push(issue('CA_OLD_VEHICLE_COLLISION', 'Collision on older vehicle', `${what} is over 20 years old with Collision`, 'BlocksBind', 1, effYear - v.year, v.id));
  });
  return out;
}

function generalLiabilityIssues(p) {
  const out = [];
  const { exposures, lineCoverages, claimsLast5Years } = p.line;
  if (claimsLast5Years >= 4) out.push(issue('GL_LOSS_HISTORY', 'Liability loss history', `${claimsLast5Years} liability claims in 5 years`, 'BlocksQuote', 2, claimsLast5Years));
  else if (claimsLast5Years >= 2) out.push(issue('GL_LOSS_HISTORY', 'Liability loss history', `${claimsLast5Years} liability claims in 5 years`, 'BlocksQuote', 1, claimsLast5Years));
  exposures.forEach((x, i) => {
    const what = `Class ${i + 1} (${x.classCode})`;
    if (x.amount > 5000000) out.push(issue('GL_LARGE_EXPOSURE', 'Large exposure', `${what} exposure is $${Number(x.amount).toLocaleString('en-US')}; over $5M needs UW Manager`, 'BlocksBind', 2, x.amount, x.id));
    if (x.classCode === '91340' && x.amount > 1000000) out.push(issue('GL_HIGH_RISK_TRADE', 'High-risk trade payroll', `${what} has payroll over $1M in carpentry; underwriter review`, 'BlocksBind', 1, x.amount, x.id));
    if (x.classCode === '16501') out.push(issue('GL_LIQUOR_SERVICE', 'Liquor service', `${what} serves alcohol; underwriter review for liquor liability`, 'BlocksBind', 1, 1, x.id));
  });
  if (lineCoverages.GLPremOpsCov && lineCoverages.GLPremOpsCov.terms.limit === '2000000/4000000') {
    out.push(issue('GL_HIGH_LIMIT', 'High liability limit', 'A $2M / $4M limit needs UW Manager approval', 'BlocksBind', 2, 4000000));
  }
  return out;
}

function commercialPropertyIssues(p) {
  const out = [];
  const { locations, claimsLast5Years } = p.line;
  const effYear = D.yearOf(p.effectiveDate);
  if (claimsLast5Years >= 4) out.push(issue('CP_LOSS_HISTORY', 'Property loss history', `${claimsLast5Years} property claims in 5 years`, 'BlocksQuote', 2, claimsLast5Years));
  else if (claimsLast5Years >= 2) out.push(issue('CP_LOSS_HISTORY', 'Property loss history', `${claimsLast5Years} property claims in 5 years`, 'BlocksQuote', 1, claimsLast5Years));
  let total = 0;
  locations.forEach((loc, i) => {
    const what = `Location ${i + 1} (${loc.description || loc.address.line1})`;
    total += (loc.buildingValue || 0) + (loc.contentsValue || 0);
    if (loc.protectionClass >= 8) out.push(issue('CP_POOR_PROTECTION', 'Poor fire protection', `${what} has protection class ${loc.protectionClass}`, 'BlocksQuote', 1, loc.protectionClass, loc.id));
    if (loc.buildingValue > 5000000) out.push(issue('CP_LARGE_LOCATION', 'Large location', `${what} building value is $${Number(loc.buildingValue).toLocaleString('en-US')}; over $5M needs UW Manager`, 'BlocksBind', 2, loc.buildingValue, loc.id));
    if (loc.construction === 'Frame' && effYear - loc.yearBuilt > 50) out.push(issue('CP_OLD_FRAME', 'Older frame building', `${what} is a frame building over 50 years old`, 'BlocksBind', 1, effYear - loc.yearBuilt, loc.id));
    if (loc.occupancy === 'Restaurant') out.push(issue('CP_RESTAURANT', 'Cooking exposure', `${what} is a restaurant; underwriter review for cooking fire risk`, 'BlocksBind', 1, 1, loc.id));
  });
  if (total > 10000000) out.push(issue('CP_TOTAL_VALUES', 'Large total insured value', `Total insured value is $${Number(total).toLocaleString('en-US')}; over $10M needs UW Manager`, 'BlocksBind', 2, total));
  return out;
}

function workersCompIssues(p) {
  const out = [];
  const { classes, experienceMod } = p.line;
  if (experienceMod > 1.5) out.push(issue('WC_HIGH_MOD', 'High experience modification', `Experience modification ${experienceMod} is above 1.5`, 'BlocksQuote', 2, experienceMod));
  else if (experienceMod > 1.25) out.push(issue('WC_HIGH_MOD', 'High experience modification', `Experience modification ${experienceMod} is above 1.25`, 'BlocksQuote', 1, experienceMod));
  const hazardPayroll = classes.filter((c) => c.classCode === '5403' || c.classCode === '5183').reduce((s, c) => s + c.payroll, 0);
  if (hazardPayroll > 1000000) out.push(issue('WC_HAZARD_PAYROLL', 'Hazardous payroll', `Carpentry and plumbing payroll is $${Number(hazardPayroll).toLocaleString('en-US')}; underwriter review`, 'BlocksBind', 1, hazardPayroll));
  const employees = classes.reduce((s, c) => s + (c.employees || 0), 0);
  if (employees > 200) out.push(issue('WC_LARGE_EMPLOYER', 'Large employer', `${employees} employees; over 200 needs UW Manager approval`, 'BlocksBind', 2, employees));
  return out;
}

function businessownersIssues(p) {
  const out = [];
  const { locations, exposures, claimsLast5Years, lineCoverages } = p.line;
  if (claimsLast5Years >= 4) out.push(issue('BOP_LOSS_HISTORY', 'Loss history', `${claimsLast5Years} claims in 5 years`, 'BlocksQuote', 2, claimsLast5Years));
  else if (claimsLast5Years >= 2) out.push(issue('BOP_LOSS_HISTORY', 'Loss history', `${claimsLast5Years} claims in 5 years`, 'BlocksQuote', 1, claimsLast5Years));
  let total = 0;
  locations.forEach((loc, i) => {
    const what = `Location ${i + 1} (${loc.description || loc.address.line1})`;
    total += (loc.buildingValue || 0) + (loc.contentsValue || 0);
    if (loc.protectionClass >= 8) out.push(issue('BOP_POOR_PROTECTION', 'Poor fire protection', `${what} has protection class ${loc.protectionClass}`, 'BlocksQuote', 1, loc.protectionClass, loc.id));
    if (loc.buildingValue > 5000000) out.push(issue('BOP_LARGE_LOCATION', 'Large location', `${what} building value is over $5M; UW Manager approval`, 'BlocksBind', 2, loc.buildingValue, loc.id));
  });
  if (total > 10000000) out.push(issue('BOP_TOTAL_VALUES', 'Large total insured value', 'Total insured property value is over $10M; UW Manager approval', 'BlocksBind', 2, total));
  exposures.forEach((x, i) => {
    const what = `Class ${i + 1} (${x.classCode})`;
    if (x.classCode === '16501') out.push(issue('BOP_LIQUOR_SERVICE', 'Liquor service', `${what} serves alcohol; underwriter review`, 'BlocksBind', 1, 1, x.id));
    if (x.amount > 5000000) out.push(issue('BOP_LARGE_EXPOSURE', 'Large exposure', `${what} exposure is over $5M; UW Manager approval`, 'BlocksBind', 2, x.amount, x.id));
  });
  if (lineCoverages.BOPPremOpsCov && lineCoverages.BOPPremOpsCov.terms.limit === '2000000/4000000') {
    out.push(issue('BOP_HIGH_LIMIT', 'High liability limit', 'A $2M / $4M liability limit needs UW Manager approval', 'BlocksBind', 2, 4000000));
  }
  return out;
}

function umbrellaIssues(p) {
  const out = [];
  const { claimsLast5Years, numberOfVehicles, lineCoverages } = p.line;
  if (claimsLast5Years >= 4) out.push(issue('UMB_LOSS_HISTORY', 'Liability loss history', `${claimsLast5Years} liability claims in 5 years`, 'BlocksQuote', 2, claimsLast5Years));
  else if (claimsLast5Years >= 2) out.push(issue('UMB_LOSS_HISTORY', 'Liability loss history', `${claimsLast5Years} liability claims in 5 years`, 'BlocksQuote', 1, claimsLast5Years));
  if (numberOfVehicles > 20) out.push(issue('UMB_FLEET', 'Large fleet', `${numberOfVehicles} vehicles on the underlying auto policy; UW Manager approval`, 'BlocksBind', 2, numberOfVehicles));
  if (lineCoverages.UMBExcessCov && lineCoverages.UMBExcessCov.terms.limit === '10000000') {
    out.push(issue('UMB_HIGH_LIMIT', 'High umbrella limit', 'A $10,000,000 umbrella limit needs UW Manager approval', 'BlocksBind', 2, 10000000));
  }
  return out;
}

function twoWheelerIssues(p) {
  const out = [];
  const { drivers, vehicles, answers } = p.line;
  const biggest = vehicles.reduce((m, v) => Math.max(m, v.engineCc || 0), 0);
  const sport = vehicles.some((v) => v.bikeType === 'Sport');
  for (const d of drivers) {
    const who = `${d.firstName} ${d.lastName}`;
    const age = D.ageOn(d.dob, p.effectiveDate);
    if (age < 21 && biggest > 250) out.push(issue('TW_YOUNG_BIG_BIKE', 'Young rider on a larger bike', `${who} is ${age} and the policy has a bike over 250 cc (${biggest} cc)`, 'BlocksBind', 1, biggest, d.id));
    if (age < 25 && sport) out.push(issue('TW_YOUNG_SPORT', 'Young rider on a sport bike', `${who} is ${age} and the policy has a sport bike`, 'BlocksBind', 1, 25 - age, d.id));
    if (d.accidents >= 3) out.push(issue('TW_ACCIDENT_HISTORY', 'Accident history', `${who} has ${d.accidents} at-fault accidents in 3 years`, 'BlocksQuote', 2, d.accidents, d.id));
    else if (d.accidents === 2) out.push(issue('TW_ACCIDENT_HISTORY', 'Accident history', `${who} has 2 at-fault accidents in 3 years`, 'BlocksQuote', 1, 2, d.id));
    if (d.violations >= 4) out.push(issue('TW_MAJOR_VIOLATIONS', 'Excessive violations', `${who} has ${d.violations} violations in 3 years; outside appetite`, 'BlocksQuote', null, d.violations, d.id));
  }
  vehicles.forEach((v, i) => {
    const what = `Bike ${i + 1} (${v.year} ${v.make} ${v.model})`;
    if (v.usage === 'Delivery') out.push(issue('TW_DELIVERY_USE', 'Delivery use', `${what} is used for deliveries`, 'BlocksBind', 1, 1, v.id));
    if (v.engineCc > 1000) out.push(issue('TW_LARGE_ENGINE', 'Very large engine', `${what} has a ${v.engineCc} cc engine; UW Manager approval`, 'BlocksBind', 2, v.engineCc, v.id));
    if (v.marketValue > 25000) out.push(issue('TW_HIGH_VALUE', 'High-value bike', `${what} is valued at $${v.marketValue.toLocaleString('en-US')}`, 'BlocksBind', 1, v.marketValue, v.id));
  });
  // The question set: an answer that matches a question's trigger raises that question's issue.
  for (const q of PRODUCTS.TwoWheeler.questions) {
    if (q.trigger && (answers || {})[q.code] === q.trigger) out.push(issue(q.issue.code, q.issue.name, q.issue.description, q.issue.blockingPoint, q.issue.level, 1));
  }
  return out;
}

function evaluateUW(product, period, { jobType, today }) {
  const issues = product === 'PersonalAuto' ? personalAutoIssues(period)
    : product === 'CommercialAuto' ? commercialAutoIssues(period)
    : product === 'GeneralLiability' ? generalLiabilityIssues(period)
    : product === 'CommercialProperty' ? commercialPropertyIssues(period)
    : product === 'WorkersComp' ? workersCompIssues(period)
    : product === 'Businessowners' ? businessownersIssues(period)
    : product === 'Umbrella' ? umbrellaIssues(period)
    : product === 'TwoWheeler' ? twoWheelerIssues(period) : homeownersIssues(period);
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
