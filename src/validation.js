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
  else validateHomeowners(p, add);
  return e;
}

module.exports = { validateAccount, validatePeriod };
