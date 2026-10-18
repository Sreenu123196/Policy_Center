'use strict';
// Validation rules: data that must be correct before a job can be quoted.
// Underwriting concerns (risk appetite) live in uwRules.js instead.

const { STATES, PRODUCER_CODES, PRODUCTS } = require('./productModel');
const D = require('./dates');

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const ZIP = /^\d{5}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validateAccount(a) {
  const e = [];
  const add = (path, message) => e.push({ path, message });
  const addr = a.address || {};
  if (blank(a.firstName)) add('firstName', 'First name is required');
  if (blank(a.lastName)) add('lastName', 'Last name is required');
  if (!D.isDate(a.dob)) add('dob', 'Date of birth is required (yyyy-mm-dd)');
  else if (D.ageOn(a.dob, D.todayISO()) < 18) add('dob', 'Primary named insured must be at least 18');
  if (!blank(a.email) && !EMAIL.test(a.email)) add('email', 'Email address is not valid');
  if (blank(addr.line1)) add('address.line1', 'Street address is required');
  if (blank(addr.city)) add('address.city', 'City is required');
  if (!STATES[addr.state]) add('address.state', `State must be one of ${Object.keys(STATES).join(', ')}`);
  if (!ZIP.test(addr.zip || '')) add('address.zip', 'ZIP must be 5 digits');
  if (!PRODUCER_CODES.some((p) => p.code === a.producerCode)) add('producerCode', 'Producer code is required');
  return e;
}

function validatePersonalAuto(p, add) {
  const { drivers, vehicles, lineCoverages } = p.line;
  const effYear = D.yearOf(p.effectiveDate);
  if (!drivers.length) add('line.drivers', 'At least one driver is required');
  if (!vehicles.length) add('line.vehicles', 'At least one vehicle is required');
  if (vehicles.length > 8) add('line.vehicles', 'A personal auto policy can have at most 8 vehicles');

  drivers.forEach((d, i) => {
    const who = `Driver ${i + 1}${d.firstName ? ` (${d.firstName} ${d.lastName || ''})`.trimEnd() : ''}`;
    const at = (f) => `line.drivers.${i}.${f}`;
    if (blank(d.firstName)) add(at('firstName'), `${who}: first name is required`);
    if (blank(d.lastName)) add(at('lastName'), `${who}: last name is required`);
    const age = D.ageOn(d.dob, p.effectiveDate);
    if (age === null) add(at('dob'), `${who}: date of birth is required`);
    else if (age < 16) add(at('dob'), `${who}: must be at least 16 on the effective date`);
    if (blank(d.licenseNumber)) add(at('licenseNumber'), `${who}: license number is required`);
    if (!STATES[d.licenseState] && !/^[A-Z]{2}$/.test(d.licenseState || '')) add(at('licenseState'), `${who}: license state is required`);
    if (!isInt(d.yearsLicensed, 0, 90) || (age !== null && d.yearsLicensed > age - 14)) add(at('yearsLicensed'), `${who}: years licensed is not valid for the driver's age`);
    if (!isInt(d.accidents, 0, 20)) add(at('accidents'), `${who}: at-fault accidents must be a number 0-20`);
    if (!isInt(d.violations, 0, 20)) add(at('violations'), `${who}: violations must be a number 0-20`);
  });

  vehicles.forEach((v, i) => {
    const what = `Vehicle ${i + 1}${v.make ? ` (${v.year || ''} ${v.make} ${v.model || ''})`.replace(/\s+\)/, ')') : ''}`;
    const at = (f) => `line.vehicles.${i}.${f}`;
    if (!isInt(v.year, 1981, effYear + 1)) add(at('year'), `${what}: model year must be between 1981 and ${effYear + 1}`);
    if (blank(v.make)) add(at('make'), `${what}: make is required`);
    if (blank(v.model)) add(at('model'), `${what}: model is required`);
    if (!VIN.test(v.vin || '')) add(at('vin'), `${what}: VIN must be 17 characters (no I, O or Q)`);
    if (!isInt(v.annualMiles, 0, 150000)) add(at('annualMiles'), `${what}: annual mileage must be 0-150,000`);
    if (!ZIP.test(v.garagingZip || '')) add(at('garagingZip'), `${what}: garaging ZIP must be 5 digits`);
    const physical = v.coverages.PACollisionCov?.selected || v.coverages.PAComprehensiveCov?.selected;
    if (physical && !isInt(v.marketValue, 500, 2000000)) add(at('marketValue'), `${what}: market value is required for physical damage coverage`);
    if (v.coverages.PACollisionCov?.selected && !v.coverages.PAComprehensiveCov?.selected) add(at('coverages'), `${what}: Collision requires Comprehensive`);
    if (v.coverages.PARentalCov?.selected && !v.coverages.PAComprehensiveCov?.selected) add(at('coverages'), `${what}: Rental Reimbursement requires Comprehensive`);
  });

  const umLimit = lineCoverages.PAUninsuredMotoristCov?.selected && lineCoverages.PAUninsuredMotoristCov.terms.limit;
  const biLimit = lineCoverages.PABodilyInjuryCov?.terms.limit;
  const order = ['25/50', '50/100', '100/300', '250/500'];
  if (umLimit && order.indexOf(umLimit) > order.indexOf(biLimit)) add('line.lineCoverages', 'Uninsured Motorist limit cannot exceed the Bodily Injury limit');
}

function validateHomeowners(p, add) {
  const { form, dwelling: d, coverages: c } = p.line;
  const effYear = D.yearOf(p.effectiveDate);
  const owner = form === 'HO3' || form === 'HO5';
  const lim = (code) => Number(c[code]?.terms.limit);
  if (blank(d.line1)) add('line.dwelling.line1', 'Dwelling street address is required');
  if (blank(d.city)) add('line.dwelling.city', 'Dwelling city is required');
  if (!ZIP.test(d.zip || '')) add('line.dwelling.zip', 'Dwelling ZIP must be 5 digits');
  if (!isInt(d.yearBuilt, 1800, effYear)) add('line.dwelling.yearBuilt', `Year built must be between 1800 and ${effYear}`);
  if (!isInt(d.squareFeet, 300, 20000)) add('line.dwelling.squareFeet', 'Square footage must be 300-20,000');
  if (owner && !isInt(d.roofAge, 0, 100)) add('line.dwelling.roofAge', 'Roof age is required (0-100)');
  if (owner && Number.isInteger(d.roofAge) && Number.isInteger(d.yearBuilt) && d.roofAge > effYear - d.yearBuilt) add('line.dwelling.roofAge', 'Roof cannot be older than the home');
  if (!isInt(d.protectionClass, 1, 10)) add('line.dwelling.protectionClass', 'Protection class must be 1-10');
  if (!(Number.isFinite(d.distanceToFireStation) && d.distanceToFireStation >= 0 && d.distanceToFireStation <= 100)) add('line.dwelling.distanceToFireStation', 'Distance to fire station must be 0-100 miles');
  if (!isInt(d.priorClaims, 0, 20)) add('line.dwelling.priorClaims', 'Prior claims must be a number 0-20');
  if (owner && !(lim('HODwellingCov') >= 50000)) add('line.coverages.HODwellingCov', 'Coverage A must be at least $50,000');
  if (form === 'HO6' && !(lim('HODwellingCov') >= 5000)) add('line.coverages.HODwellingCov', 'Coverage A (walls-in) must be at least $5,000');
  if (!(lim('HOPersonalPropertyCov') >= (form === 'HO4' ? 10000 : 0))) add('line.coverages.HOPersonalPropertyCov', form === 'HO4' ? 'Coverage C must be at least $10,000 for renters' : 'Coverage C cannot be negative');
  for (const code of ['HOOtherStructuresCov', 'HOLossOfUseCov']) {
    if (c[code] && !(lim(code) >= 0)) add(`line.coverages.${code}`, 'Limit cannot be negative');
  }
  if (owner && lim('HOPersonalPropertyCov') > lim('HODwellingCov')) add('line.coverages.HOPersonalPropertyCov', 'Coverage C cannot exceed Coverage A');
  if (c.HOScheduledJewelryCov?.selected && !(lim('HOScheduledJewelryCov') > 0 && lim('HOScheduledJewelryCov') <= 50000)) {
    add('line.coverages.HOScheduledJewelryCov', 'Scheduled jewelry value must be $1-$50,000; higher values need a separate floater');
  }
}

function validateCommercialAuto(p, add) {
  const pm = PRODUCTS.CommercialAuto;
  const { businessName, drivers, vehicles } = p.line;
  const effYear = D.yearOf(p.effectiveDate);
  if (blank(businessName)) add('line.businessName', 'Business name is required');
  if (!drivers.length) add('line.drivers', 'At least one driver is required');
  if (!vehicles.length) add('line.vehicles', 'At least one vehicle is required');
  if (vehicles.length > 50) add('line.vehicles', 'A commercial auto policy can have at most 50 vehicles');

  drivers.forEach((d, i) => {
    const at = (f) => `line.drivers.${i}.${f}`;
    const who = `Driver ${i + 1}`;
    if (blank(d.firstName)) add(at('firstName'), `${who}: first name is required`);
    if (blank(d.lastName)) add(at('lastName'), `${who}: last name is required`);
    if (!D.isDate(d.dob)) add(at('dob'), `${who}: date of birth is required`);
    else if (D.ageOn(d.dob, p.effectiveDate) < 18) add(at('dob'), `${who}: drivers must be at least 18`);
    if (blank(d.licenseNumber)) add(at('licenseNumber'), `${who}: license number is required`);
    if (!STATES[d.licenseState]) add(at('licenseState'), `${who}: license state is required`);
    if (!isInt(d.yearsLicensed, 0, 70)) add(at('yearsLicensed'), `${who}: years licensed must be 0 to 70`);
    if (!isInt(d.accidents, 0, 20)) add(at('accidents'), `${who}: accidents must be 0 to 20`);
    if (!isInt(d.violations, 0, 20)) add(at('violations'), `${who}: violations must be 0 to 20`);
  });

  vehicles.forEach((v, i) => {
    const at = (f) => `line.vehicles.${i}.${f}`;
    const what = `Vehicle ${i + 1}`;
    if (!isInt(v.year, effYear - 30, effYear + 1)) add(at('year'), `${what}: model year must be within 30 years of the effective date`);
    if (blank(v.make)) add(at('make'), `${what}: make is required`);
    if (blank(v.model)) add(at('model'), `${what}: model is required`);
    if (!VIN.test(v.vin || '')) add(at('vin'), `${what}: VIN must be 17 characters (no I, O or Q)`);
    if (!pm.usages.includes(v.usage)) add(at('usage'), `${what}: choose a use`);
    if (!pm.radiusClasses.includes(v.radius)) add(at('radius'), `${what}: choose a radius of operation`);
    if (!isInt(v.marketValue, 1, 5000000)) add(at('marketValue'), `${what}: stated value is required`);
    if (!ZIP.test(v.garagingZip || '')) add(at('garagingZip'), `${what}: garaging ZIP must be 5 digits`);
  });
}

function validateGeneralLiability(p, add) {
  const pm = PRODUCTS.GeneralLiability;
  const { businessName, exposures, claimsLast5Years } = p.line;
  if (blank(businessName)) add('line.businessName', 'Business name is required');
  if (!exposures.length) add('line.exposures', 'At least one class of business is required');
  if (exposures.length > 30) add('line.exposures', 'A general liability policy can have at most 30 classes of business');
  exposures.forEach((x, i) => {
    const at = (f) => `line.exposures.${i}.${f}`;
    const what = `Class ${i + 1}`;
    const cls = pm.classes.find((c) => c.code === x.classCode);
    if (!cls) add(at('classCode'), `${what}: choose a class of business`);
    if (!isInt(x.amount, 1, 1000000000)) add(at('amount'), `${what}: enter the annual ${cls ? cls.base.toLowerCase() : 'exposure'} amount`);
  });
  if (!isInt(claimsLast5Years, 0, 50)) add('line.claimsLast5Years', 'Liability claims in the last 5 years must be 0 to 50');
}

function validateCommercialProperty(p, add) {
  const pm = PRODUCTS.CommercialProperty;
  const { businessName, locations, claimsLast5Years } = p.line;
  const effYear = D.yearOf(p.effectiveDate);
  if (blank(businessName)) add('line.businessName', 'Business name is required');
  if (!locations.length) add('line.locations', 'At least one location is required');
  if (locations.length > 50) add('line.locations', 'A commercial property policy can have at most 50 locations');
  locations.forEach((loc, i) => {
    const at = (f) => `line.locations.${i}.${f}`;
    const what = `Location ${i + 1}`;
    if (blank(loc.address.line1)) add(at('address.line1'), `${what}: street address is required`);
    if (!ZIP.test(loc.address.zip || '')) add(at('address.zip'), `${what}: ZIP must be 5 digits`);
    if (!pm.constructionTypes.includes(loc.construction)) add(at('construction'), `${what}: choose a construction type`);
    if (!pm.occupancies.includes(loc.occupancy)) add(at('occupancy'), `${what}: choose an occupancy`);
    if (!isInt(loc.yearBuilt, 1800, effYear)) add(at('yearBuilt'), `${what}: year built must be between 1800 and the effective year`);
    if (!isInt(loc.protectionClass, 1, 10)) add(at('protectionClass'), `${what}: protection class must be 1 to 10`);
    if (!isInt(loc.buildingValue, 1, 500000000)) add(at('buildingValue'), `${what}: building value is required`);
    if (!isInt(loc.contentsValue, 0, 500000000)) add(at('contentsValue'), `${what}: contents value must be 0 or more`);
  });
  if (!isInt(claimsLast5Years, 0, 50)) add('line.claimsLast5Years', 'Property claims in the last 5 years must be 0 to 50');
}

function validateWorkersComp(p, add) {
  const pm = PRODUCTS.WorkersComp;
  const { businessName, classes, experienceMod } = p.line;
  if (blank(businessName)) add('line.businessName', 'Business name is required');
  if (!classes.length) add('line.classes', 'At least one classification is required');
  if (classes.length > 30) add('line.classes', 'A workers compensation policy can have at most 30 classifications');
  classes.forEach((c, i) => {
    const at = (f) => `line.classes.${i}.${f}`;
    const what = `Classification ${i + 1}`;
    if (!pm.classes.some((x) => x.code === c.classCode)) add(at('classCode'), `${what}: choose a classification`);
    if (!isInt(c.payroll, 1, 1000000000)) add(at('payroll'), `${what}: enter the annual payroll`);
    if (!isInt(c.employees, 1, 10000)) add(at('employees'), `${what}: enter the number of employees`);
  });
  if (!(Number.isFinite(experienceMod) && experienceMod >= 0.5 && experienceMod <= 2)) add('line.experienceMod', 'Experience modification must be between 0.50 and 2.00');
}

function validatePeriod(product, p, { jobType, today }) {
  const e = [];
  const add = (path, message) => e.push({ path, message });
  if (!D.isDate(p.effectiveDate)) {
    add('effectiveDate', 'Effective date is required');
    return e;
  }
  if (jobType === 'Submission' && p.effectiveDate > D.addDays(today, 120)) add('effectiveDate', 'Effective date cannot be more than 120 days in the future');
  if (!PRODUCTS[product].paymentPlans.some((pl) => pl.code === p.paymentPlan)) add('paymentPlan', 'Payment plan is required');
  if (product === 'PersonalAuto') validatePersonalAuto(p, add);
  else if (product === 'CommercialAuto') validateCommercialAuto(p, add);
  else if (product === 'GeneralLiability') validateGeneralLiability(p, add);
  else if (product === 'CommercialProperty') validateCommercialProperty(p, add);
  else if (product === 'WorkersComp') validateWorkersComp(p, add);
  else if (product === 'Businessowners') {
    validateCommercialProperty(p, add);
    validateGeneralLiability(p, add);
  } else validateHomeowners(p, add);
  return e.filter((x, i) => e.findIndex((y) => y.path === x.path && y.message === x.message) === i);
}

module.exports = { validateAccount, validatePeriod };
