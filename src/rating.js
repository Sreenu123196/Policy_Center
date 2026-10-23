'use strict';
// Rating engine. Produces Cost records (one per coverage / discount / tax / fee), each with a
// worksheet that shows every factor applied, the same way PolicyCenter rating worksheets do.

const { RATE_BOOKS } = require('./rateBooks');
const { PRODUCTS } = require('./productModel');
const D = require('./dates');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

function selectRateBook(product, effectiveDate) {
  const book = RATE_BOOKS
    .filter((b) => b.product === product && b.status === 'Active' && b.effectiveDate <= effectiveDate)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
  if (!book) throw new Error(`No active ${product} rate book for effective date ${effectiveDate}`);
  return book;
}

const band = (rows, value) => rows.find((r) => r.max === undefined || value <= r.max).f;
const ageBand = (rows, age) => (rows.find((r) => age >= r.min && age <= r.max) || rows[rows.length - 1]).f;

// Simulated territory lookup: a real implementation reads a ZIP-to-territory rate table.
const { resolveLimit } = require('./policyCaps');
const { CAPS } = require('./policyCapsData');

function territoryOf(zip) {
  const n = parseInt(String(zip || '').slice(0, 3), 10);
  return Number.isFinite(n) ? (n % 5) + 1 : 3;
}

class Worksheet {
  constructor(label, value) {
    this.value = value;
    this.steps = [{ label, factor: round4(value), running: round4(value) }];
  }
  x(label, factor) {
    if (factor === undefined || factor === null || Number.isNaN(factor)) throw new Error(`Missing rate factor: ${label}`);
    this.value *= factor;
    this.steps.push({ label, factor: round4(factor), running: round4(this.value) });
    return this;
  }
}

const cost = (fields, ws) => ({ ...fields, amount: round2(ws.value), worksheet: ws.steps });

function finish(book, costs, state, ctx) {
  const t = book.tables;
  const premium = round2(costs.reduce((s, c) => s + c.amount, 0));
  const all = [...costs];
  const taxWs = new Worksheet('Written premium', premium).x(`Premium tax (${state})`, t.taxRates[state]);
  const taxes = round2(taxWs.value);
  all.push(cost({ type: 'Tax', coverable: 'Policy', coverageCode: 'PremiumTax', coverageName: `${state} premium tax` }, taxWs));
  let fees = 0;
  if (ctx.includeFees && t.policyFee) {
    fees = t.policyFee;
    all.push(cost({ type: 'Fee', coverable: 'Policy', coverageCode: 'PolicyFee', coverageName: 'Policy fee' }, new Worksheet('Flat policy fee', t.policyFee)));
  }
  return {
    rateBook: { code: book.code, version: book.version, effectiveDate: book.effectiveDate, rateLevel: book.rateLevel },
    costs: all,
    premium,
    taxes,
    fees,
    total: round2(premium + taxes + fees),
  };
}

// ---------------------------------------------------------------- Personal Auto

function ratedDriver(drivers, effectiveDate, t) {
  let best = null;
  for (const d of drivers) {
    const age = D.ageOn(d.dob, effectiveDate);
    let f = ageBand(t.driverAgeFactors, age)
      * band(t.experienceFactors, d.yearsLicensed || 0)
      * t.accidentFactors[Math.min(d.accidents || 0, 3)]
      * Math.pow(t.violationFactor, d.violations || 0);
    if (d.goodStudent && age < 25) f *= t.goodStudentFactor;
    f = round4(f);
    if (!best || f > best.factor) best = { id: d.id, label: `${d.firstName} ${d.lastName}, age ${age}`, factor: f };
  }
  return best || { id: null, label: 'none', factor: 1 };
}

function ratePersonalAuto(period, ctx) {
  const book = selectRateBook('PersonalAuto', period.effectiveDate);
  const t = book.tables;
  const product = PRODUCTS.PersonalAuto;
  const state = period.state;
  const sf = t.stateFactors[state];
  const termMonths = period.termMonths || product.termMonths;
  const termF = round4(termMonths / 12);
  const effYear = D.yearOf(period.effectiveDate);
  const rd = ratedDriver(period.line.drivers, period.effectiveDate, t);
  const costs = [];

  period.line.vehicles.forEach((v, i) => {
    const coverable = `Vehicle ${i + 1}: ${v.year} ${v.make} ${v.model}`;
    const terr = territoryOf(v.garagingZip);
    const vehAge = Math.max(0, effYear - v.year);
    const base = { type: 'Coverage', coverableId: v.id, coverable };

    for (const def of product.lineCoverages) {
      const cov = period.line.lineCoverages[def.code];
      if (!cov || !cov.selected) continue;
      const limit = cov.terms.limit;
      const ws = new Worksheet('Annual base rate', t.baseRates[def.code])
        .x(`State factor, liability (${state})`, sf.liability)
        .x(`Territory ${terr} (ZIP ${v.garagingZip})`, t.territoryFactors[terr])
        .x(`Limit ${limit}`, t.limitFactors[def.code][limit])
        .x(`Rated driver (${rd.label})`, rd.factor)
        .x(`Usage: ${v.usage}`, t.usageFactors[v.usage])
        .x(`Annual mileage ${Number(v.annualMiles).toLocaleString('en-US')}`, band(t.mileageFactors, v.annualMiles || 0))
        .x(`Rate level (book ${book.version})`, book.rateLevel)
        .x(`Term factor (${termMonths} months)`, termF);
      costs.push(cost({ ...base, coverageCode: def.code, coverageName: def.name, termValue: limit }, ws));
    }

    for (const def of product.vehicleCoverages) {
      const cov = v.coverages[def.code];
      if (!cov || !cov.selected) continue;
      let ws;
      let termValue;
      if (def.code === 'PACollisionCov' || def.code === 'PAComprehensiveCov') {
        termValue = cov.terms.deductible;
        ws = new Worksheet('Annual base rate', t.baseRates[def.code])
          .x(`State factor, physical damage (${state})`, sf.physical)
          .x(`Territory ${terr} (ZIP ${v.garagingZip})`, t.territoryFactors[terr])
          .x(`Deductible $${termValue}`, t.deductibleFactors[def.code][termValue])
          .x(`Vehicle age ${vehAge} yrs`, band(t.vehicleAgeFactors, vehAge))
          .x(`Market value ${usd(v.marketValue)}`, band(t.vehicleValueFactors, v.marketValue || 0));
        if (def.code === 'PACollisionCov') {
          ws.x(`Rated driver (${rd.label})`, rd.factor)
            .x(`Usage: ${v.usage}`, t.usageFactors[v.usage])
            .x(`Annual mileage ${Number(v.annualMiles).toLocaleString('en-US')}`, band(t.mileageFactors, v.annualMiles || 0));
        }
      } else {
        termValue = cov.terms.limit;
        ws = new Worksheet(`Flat annual charge (${termValue})`, t.flatCharges[def.code][termValue]);
      }
      ws.x(`Rate level (book ${book.version})`, book.rateLevel).x(`Term factor (${termMonths} months)`, termF);
      costs.push(cost({ ...base, coverageCode: def.code, coverageName: def.name, termValue }, ws));
    }
  });

  const subtotal = round2(costs.reduce((s, c) => s + c.amount, 0));
  const discounts = [];
  if (period.line.vehicles.length >= 2) discounts.push(['MultiCarDiscount', 'Multi-car discount', t.discounts.multiCar]);
  if (ctx.multiPolicy) discounts.push(['MultiPolicyDiscount', 'Multi-policy discount (Homeowners in force)', t.discounts.multiPolicy]);
  if (period.paymentPlan === 'PaidInFull') discounts.push(['PaidInFullDiscount', 'Paid-in-full discount', t.discounts.paidInFull]);
  // Earned at renewal from the policy's own claims record: the count is set by the renewal, never typed in.
  const claimFree = period.line.claimFreeRenewals || 0;
  if (claimFree >= 1) discounts.push(['ClaimFreeDiscount', `Claim-free renewal discount (${claimFree} claim-free renewal${claimFree > 1 ? 's' : ''})`, t.claimFreeDiscounts[Math.min(claimFree, t.claimFreeDiscounts.length) - 1]]);
  for (const [code, name, pct] of discounts) {
    const ws = new Worksheet('Coverage premium subtotal', subtotal).x(`${name} (${Math.round(pct * 10000) / 100}%)`, -pct);
    costs.push(cost({ type: 'Discount', coverable: 'Policy', coverageCode: code, coverageName: name }, ws));
  }

  const result = finish(book, costs, state, ctx);
  result.ratedDriver = rd;
  return result;
}

// ---------------------------------------------------------------- Homeowners

function replacementCostEstimate(state, construction, squareFeet, effectiveDate) {
  const t = selectRateBook('Homeowners', effectiveDate).tables;
  if (!squareFeet || !t.costPerSqft[construction] || !t.stateCostFactors[state]) return 0;
  return Math.round((squareFeet * t.costPerSqft[construction] * t.stateCostFactors[state]) / 1000) * 1000;
}

function rateHomeowners(period, ctx) {
  const book = selectRateBook('Homeowners', period.effectiveDate);
  const t = book.tables;
  const state = period.state;
  const { form, dwelling: d, coverages: c } = period.line;
  const owner = form === 'HO3' || form === 'HO5';
  // A homeowners term of 12 months is the base; a longer term multiplies every cost by its length in years.
  const termMonths = period.termMonths || 12;
  const rl = round4(book.rateLevel * (termMonths / 12));
  const rlLabel = termMonths === 12 ? `Rate level (book ${book.version})` : `Rate level (book ${book.version}) x term ${termMonths} months`;
  // The cap that applies is the limit that is priced. A contents limit above the cap is written at the cap, so the premium
  // follows the cover actually granted rather than the number someone asked for.
  const lim = (code) => {
    const requested = c[code] && c[code].selected ? Number(c[code].terms.limit) : 0;
    if (!requested) return 0;
    return resolveLimit({ product: 'Homeowners', coverage: code, requested, caps: CAPS }).limit;
  };
  const A = lim('HODwellingCov');
  const B = lim('HOOtherStructuresCov');
  const C = lim('HOPersonalPropertyCov');
  const DL = lim('HOLossOfUseCov');
  const homeAge = Math.max(0, D.yearOf(period.effectiveDate) - d.yearBuilt);
  const terr = territoryOf(d.zip);
  const aop = c.HODeductibles.terms.aop;
  const costs = [];
  const base = { type: 'Coverage', coverable: 'Dwelling', coverableId: 'dwelling' };

  // Section I base premium.
  let ws;
  if (form === 'HO4') {
    ws = new Worksheet(`Contents rate $${t.contentsRatePer1000.HO4}/1,000 x Cov C ${usd(C)}`, (t.contentsRatePer1000.HO4 * C) / 1000);
  } else if (form === 'HO6') {
    ws = new Worksheet(
      `Cov A ${usd(A)} @ $${t.baseRatePer1000.HO6} + Cov C ${usd(C)} @ $${t.contentsRatePer1000.HO6} per 1,000`,
      (t.baseRatePer1000.HO6 * A + t.contentsRatePer1000.HO6 * C) / 1000,
    );
  } else {
    ws = new Worksheet(`${form} base rate $${t.baseRatePer1000[form]}/1,000 x Cov A ${usd(A)}`, (t.baseRatePer1000[form] * A) / 1000);
  }
  ws.x(`State factor (${state})`, t.stateFactors[state])
    .x(`Territory ${terr} (ZIP ${d.zip})`, t.territoryFactors[terr])
    .x(`Construction: ${d.construction}`, t.constructionFactors[d.construction])
    .x(`Protection class ${d.protectionClass}`, t.protectionClassFactors[d.protectionClass])
    .x(`Age of home ${homeAge} yrs`, band(t.homeAgeFactors, homeAge));
  if (owner) ws.x(`Roof age ${d.roofAge} yrs`, band(t.roofAgeFactors, d.roofAge));
  ws.x(`AOP deductible $${aop}`, t.aopDeductibleFactors[aop])
    .x(`Prior claims (5 yrs): ${d.priorClaims}`, t.claimsFactors[Math.min(d.priorClaims || 0, 3)])
    .x(`Protective device: ${d.alarm} alarm`, t.alarmFactors[d.alarm]);
  if (d.sprinklers) ws.x('Sprinkler system credit', t.sprinklerFactor);
  ws.x(rlLabel, rl);
  const sectionIBase = ws.value;
  costs.push(cost({
    ...base,
    coverageCode: form === 'HO4' ? 'HOPersonalPropertyCov' : 'HODwellingCov',
    coverageName: form === 'HO4' ? 'Section I base premium (Coverage C)' : 'Section I base premium (Coverage A)',
    termValue: usd(form === 'HO4' ? C : A),
  }, ws));

  // Coverages B, C, D: an included amount is in the base premium; the excess is charged per $1,000.
  const increased = (code, name, limit, included, ratePer1000) => {
    const excess = Math.max(0, limit - included);
    const w = new Worksheet(`Included ${usd(included)}; excess ${usd(excess)} x $${ratePer1000}/1,000`, (excess / 1000) * ratePer1000)
      .x(`State factor (${state})`, t.stateFactors[state])
      .x(rlLabel, rl);
    costs.push(cost({ ...base, coverageCode: code, coverageName: name, termValue: usd(limit) }, w));
  };
  if (owner) {
    increased('HOOtherStructuresCov', 'Coverage B - Other Structures', B, A * 0.1, t.increasedLimitRates.B);
    increased('HOPersonalPropertyCov', 'Coverage C - Personal Property', C, A * t.includedContentsPct[form], t.increasedLimitRates.C);
    increased('HOLossOfUseCov', 'Coverage D - Loss of Use', DL, A * t.includedLossOfUsePct[form], t.increasedLimitRates.D);
  } else {
    if (form === 'HO6') costs.push(cost({ ...base, coverageCode: 'HOPersonalPropertyCov', coverageName: 'Coverage C - Personal Property', termValue: usd(C) }, new Worksheet('Included in Section I base premium', 0)));
    increased('HOLossOfUseCov', 'Coverage D - Loss of Use', DL, C * t.includedLossOfUsePct[form], t.increasedLimitRates.D);
  }

  // Section II.
  const E = c.HOLiabilityCov.terms.limit;
  const liab = new Worksheet(`Personal liability charge (${usd(E)})`, t.liabilityCharges[E]).x(`State factor (${state})`, t.stateFactors[state]);
  if (d.pool) liab.x('Swimming pool hazard', t.liabilityHazardFactors.pool);
  if (d.trampoline) liab.x('Trampoline hazard', t.liabilityHazardFactors.trampoline);
  if (d.aggressiveDog) liab.x('Animal liability hazard', t.liabilityHazardFactors.aggressiveDog);
  liab.x(rlLabel, rl);
  costs.push(cost({ ...base, coverageCode: 'HOLiabilityCov', coverageName: 'Coverage E - Personal Liability', termValue: usd(E) }, liab));
  const F = c.HOMedPayCov.terms.limit;
  costs.push(cost({ ...base, coverageCode: 'HOMedPayCov', coverageName: 'Coverage F - Medical Payments', termValue: usd(F) },
    new Worksheet(`Medical payments charge (${usd(F)})`, t.medPayCharges[F]).x(rlLabel, rl)));

  // Windstorm / hail load for coastal states.
  const wh = c.HODeductibles.terms.windHail;
  if (wh && t.windHail.stateFactors[state]) {
    const w = new Worksheet('Section I base premium', sectionIBase)
      .x(`Wind/hail load (${state})`, t.windHail.stateFactors[state])
      .x(`Wind/hail deductible ${wh}`, t.windHail.deductibleFactors[wh]);
    costs.push(cost({ ...base, coverageCode: 'HOWindHail', coverageName: 'Windstorm & Hail', termValue: `${wh} deductible` }, w));
  }

  // Endorsements.
  const e = t.endorsements;
  const end = { ...base, coverable: 'Endorsements' };
  if (c.HOWaterBackupCov && c.HOWaterBackupCov.selected) {
    const l = c.HOWaterBackupCov.terms.limit;
    costs.push(cost({ ...end, coverageCode: 'HOWaterBackupCov', coverageName: 'Water Backup & Sump Overflow', termValue: usd(l) },
      new Worksheet(`Flat charge (${usd(l)})`, e.waterBackup[l]).x(rlLabel, rl)));
  }
  if (c.HOReplacementCostContentsCov && c.HOReplacementCostContentsCov.selected) {
    costs.push(cost({ ...end, coverageCode: 'HOReplacementCostContentsCov', coverageName: 'Replacement Cost - Personal Property' },
      new Worksheet('Section I base premium', sectionIBase).x('Replacement cost contents load', e.replacementCostContentsLoad)));
  }
  if (c.HOScheduledJewelryCov && c.HOScheduledJewelryCov.selected) {
    const v = Number(c.HOScheduledJewelryCov.terms.limit);
    costs.push(cost({ ...end, coverageCode: 'HOScheduledJewelryCov', coverageName: 'Scheduled Jewelry', termValue: usd(v) },
      new Worksheet(`${usd(v)} scheduled x $${e.jewelryRatePer100}/100`, (v / 100) * e.jewelryRatePer100).x(rlLabel, rl)));
  }
  if (c.HOIdentityTheftCov && c.HOIdentityTheftCov.selected) {
    costs.push(cost({ ...end, coverageCode: 'HOIdentityTheftCov', coverageName: 'Identity Fraud Expense' },
      new Worksheet('Flat charge', e.identityTheft).x(rlLabel, rl)));
  }
  if (c.HOEarthquakeCov && c.HOEarthquakeCov.selected) {
    const ded = c.HOEarthquakeCov.terms.deductible;
    const r = e.earthquakeRatePer1000[state] ?? e.earthquakeRatePer1000.default;
    costs.push(cost({ ...end, coverageCode: 'HOEarthquakeCov', coverageName: 'Earthquake', termValue: `${ded} deductible` },
      new Worksheet(`Cov A ${usd(A)} x $${r}/1,000 (${state})`, (A / 1000) * r).x(`Deductible ${ded}`, e.earthquakeDeductibleFactors[ded]).x(rlLabel, rl)));
  }

  if (ctx.multiPolicy) {
    const subtotal = round2(costs.reduce((s, x) => s + x.amount, 0));
    costs.push(cost({ type: 'Discount', coverable: 'Policy', coverageCode: 'MultiPolicyDiscount', coverageName: 'Multi-policy discount (Personal Auto in force)' },
      new Worksheet('Premium subtotal', subtotal).x(`Multi-policy discount (${t.discounts.multiPolicy * 100}%)`, -t.discounts.multiPolicy)));
  }

  const beforeMin = round2(costs.reduce((s, x) => s + x.amount, 0));
  if (beforeMin < t.minimumPremium) {
    costs.push(cost({ type: 'Adjustment', coverable: 'Policy', coverageCode: 'MinimumPremium', coverageName: 'Minimum premium adjustment' },
      new Worksheet(`Minimum premium $${t.minimumPremium} less calculated ${usd(beforeMin)}`, t.minimumPremium - beforeMin)));
  }

  const result = finish(book, costs, state, ctx);
  result.replacementCost = owner ? replacementCostEstimate(state, d.construction, d.squareFeet, period.effectiveDate) : null;
  return result;
}

// ---------------------------------------------------------------- Commercial Auto

function rateCommercialAuto(period, ctx) {
  const book = selectRateBook('CommercialAuto', period.effectiveDate);
  const t = book.tables;
  const product = PRODUCTS.CommercialAuto;
  const state = period.state;
  const sf = t.stateFactors[state];
  const termMonths = period.termMonths || product.termMonths;
  const termF = round4(termMonths / 12);
  const effYear = D.yearOf(period.effectiveDate);
  const drivers = period.line.drivers;
  const accidents = drivers.reduce((s, d) => s + (d.accidents || 0), 0);
  const perDriver = drivers.length ? accidents / drivers.length : 0;
  const fleetF = band(t.fleetRiskBands, perDriver);
  const costs = [];

  period.line.vehicles.forEach((v, i) => {
    const coverable = `Vehicle ${i + 1}: ${v.year} ${v.make} ${v.model}`;
    const terr = territoryOf(v.garagingZip);
    const vehAge = Math.max(0, effYear - v.year);
    const base = { type: 'Coverage', coverableId: v.id, coverable };

    for (const def of product.lineCoverages) {
      const cov = period.line.lineCoverages[def.code];
      if (!cov || !cov.selected) continue;
      const limit = cov.terms.limit;
      const ws = new Worksheet('Annual base rate', t.baseRates[def.code])
        .x(`State factor, liability (${state})`, sf.liability)
        .x(`Territory ${terr} (ZIP ${v.garagingZip})`, t.territoryFactors[terr])
        .x(`Limit ${usd(limit)}`, t.limitFactors[def.code][limit])
        .x(`Use: ${v.usage}`, t.usageFactors[v.usage])
        .x(`Radius: ${v.radius}`, t.radiusFactors[v.radius])
        .x(`Fleet driving record (${perDriver.toFixed(2)} accidents per driver)`, fleetF)
        .x(`Rate level (book ${book.version})`, book.rateLevel)
        .x(`Term factor (${termMonths} months)`, termF);
      costs.push(cost({ ...base, coverageCode: def.code, coverageName: def.name, termValue: limit }, ws));
    }

    for (const def of product.vehicleCoverages) {
      const cov = v.coverages[def.code];
      if (!cov || !cov.selected) continue;
      const deductible = cov.terms.deductible;
      const ws = new Worksheet('Annual base rate', t.baseRates[def.code])
        .x(`State factor, physical damage (${state})`, sf.physical)
        .x(`Territory ${terr} (ZIP ${v.garagingZip})`, t.territoryFactors[terr])
        .x(`Deductible ${usd(deductible)}`, t.deductibleFactors[def.code][deductible])
        .x(`Vehicle age ${vehAge} yrs`, band(t.vehicleAgeFactors, vehAge))
        .x(`Stated value ${usd(v.marketValue)}`, band(t.vehicleValueFactors, v.marketValue || 0))
        .x(`Use: ${v.usage}`, t.usageFactors[v.usage])
        .x(`Radius: ${v.radius}`, t.radiusFactors[v.radius])
        .x(`Fleet driving record (${perDriver.toFixed(2)} accidents per driver)`, fleetF)
        .x(`Rate level (book ${book.version})`, book.rateLevel)
        .x(`Term factor (${termMonths} months)`, termF);
      costs.push(cost({ ...base, coverageCode: def.code, coverageName: def.name, termValue: deductible }, ws));
    }
  });

  const subtotal = round2(costs.reduce((s, c) => s + c.amount, 0));
  const discounts = [];
  if (period.line.vehicles.length >= 10) discounts.push(['FleetDiscount10', 'Fleet discount (10+ vehicles)', t.discounts.fleet10]);
  else if (period.line.vehicles.length >= 5) discounts.push(['FleetDiscount5', 'Fleet discount (5+ vehicles)', t.discounts.fleet5]);
  if (period.paymentPlan === 'PaidInFull') discounts.push(['PaidInFullDiscount', 'Paid-in-full discount', t.discounts.paidInFull]);
  for (const [code, name, pct] of discounts) {
    const ws = new Worksheet('Coverage premium subtotal', subtotal).x(`${name} (${pct * 100}%)`, -pct);
    costs.push(cost({ type: 'Discount', coverable: 'Policy', coverageCode: code, coverageName: name }, ws));
  }

  const result = finish(book, costs, state, ctx);
  result.fleetExperience = { accidentsPerDriver: round2(perDriver), factor: fleetF };
  return result;
}

// ---------------------------------------------------------------- General Liability

function rateGeneralLiability(period, ctx) {
  const book = selectRateBook('GeneralLiability', period.effectiveDate);
  const t = book.tables;
  const product = PRODUCTS.GeneralLiability;
  const state = period.state;
  const sf = t.stateFactors[state];
  const terr = territoryOf(period.insured.address.zip);
  const termMonths = period.termMonths || product.termMonths;
  const termF = round4(termMonths / 12);
  const claims = period.line.claimsLast5Years || 0;
  const expF = band(t.experienceFactors, claims);
  const costs = [];

  period.line.exposures.forEach((x, i) => {
    const cls = product.classes.find((c) => c.code === x.classCode);
    const rate = t.classRates[x.classCode];
    const coverable = `Class ${i + 1}: ${cls.name}`;
    const limit = period.line.lineCoverages.GLPremOpsCov.terms.limit;
    const ws = new Worksheet(`Exposure $${Number(x.amount).toLocaleString('en-US')} ${x.base.toLowerCase()} at $${rate} per $1,000`, (x.amount / 1000) * rate)
      .x(`State factor, liability (${state})`, sf)
      .x(`Territory ${terr} (ZIP ${period.insured.address.zip})`, t.territoryFactors[terr])
      .x(`Limit ${limit}`, t.limitFactors.GLPremOpsCov[limit])
      .x(`Liability claims in 5 years: ${claims}`, expF)
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);
    costs.push(cost({ type: 'Coverage', coverableId: x.id, coverable, coverageCode: 'GLPremOpsCov', coverageName: 'Premises and operations', termValue: limit }, ws));
  });

  for (const def of product.lineCoverages) {
    if (def.code !== 'GLMedPayCov') continue;
    const cov = period.line.lineCoverages[def.code];
    if (!cov || !cov.selected) continue;
    const limit = cov.terms.limit;
    const ws = new Worksheet(`Flat charge (medical expense ${usd(limit)})`, t.medPayCharges.GLMedPayCov[limit])
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);
    costs.push(cost({ type: 'Coverage', coverable: 'Policy', coverageCode: def.code, coverageName: def.name, termValue: limit }, ws));
  }

  const subtotal = round2(costs.reduce((s, c) => s + c.amount, 0));
  const discounts = [];
  if (period.paymentPlan === 'PaidInFull') discounts.push(['PaidInFullDiscount', 'Paid-in-full discount', t.discounts.paidInFull]);
  for (const [code, name, pct] of discounts) {
    const ws = new Worksheet('Coverage premium subtotal', subtotal).x(`${name} (${pct * 100}%)`, -pct);
    costs.push(cost({ type: 'Discount', coverable: 'Policy', coverageCode: code, coverageName: name }, ws));
  }

  const result = finish(book, costs, state, ctx);
  result.claimExperience = { claimsLast5Years: claims, factor: expF };
  return result;
}

// ---------------------------------------------------------------- Commercial Property

function rateCommercialProperty(period, ctx) {
  const book = selectRateBook('CommercialProperty', period.effectiveDate);
  const t = book.tables;
  const product = PRODUCTS.CommercialProperty;
  const state = period.state;
  const sf = t.stateFactors[state];
  const termMonths = period.termMonths || product.termMonths;
  const termF = round4(termMonths / 12);
  const costs = [];

  period.line.locations.forEach((loc, i) => {
    const terr = territoryOf(loc.address.zip);
    const coverable = `Location ${i + 1}: ${loc.description || loc.address.line1}`;
    const protF = band(t.protectionFactors, loc.protectionClass);
    const occF = t.occupancyFactors[loc.occupancy];
    const base = { type: 'Coverage', coverableId: loc.id, coverable };
    const common = (ws, code) => ws
      .x(`State factor (${state})`, sf)
      .x(`Territory ${terr} (ZIP ${loc.address.zip})`, t.territoryFactors[terr])
      .x(`Protection class ${loc.protectionClass}`, protF)
      .x(`Occupancy: ${loc.occupancy}`, occF)
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);

    const bld = period.line.lineCoverages.CPBuildingCov;
    if (bld && bld.selected) {
      const d = bld.terms.deductible;
      const ws = new Worksheet(`Building $${Number(loc.buildingValue).toLocaleString('en-US')} at $${t.buildingRates[loc.construction]} per $100 (${loc.construction})`, (loc.buildingValue / 100) * t.buildingRates[loc.construction])
        .x(`Deductible ${usd(d)}`, t.deductibleFactors.CPBuildingCov[d]);
      common(ws);
      costs.push(cost({ ...base, coverageCode: 'CPBuildingCov', coverageName: 'Building', termValue: d }, ws));
    }
    const bpp = period.line.lineCoverages.CPBusinessPersonalPropertyCov;
    if (bpp && bpp.selected && loc.contentsValue > 0) {
      const d = bpp.terms.deductible;
      const ws = new Worksheet(`Contents $${Number(loc.contentsValue).toLocaleString('en-US')} at $${(t.buildingRates[loc.construction] * t.contentsMultiplier).toFixed(3)} per $100`, (loc.contentsValue / 100) * t.buildingRates[loc.construction] * t.contentsMultiplier)
        .x(`Deductible ${usd(d)}`, t.deductibleFactors.CPBusinessPersonalPropertyCov[d]);
      common(ws);
      costs.push(cost({ ...base, coverageCode: 'CPBusinessPersonalPropertyCov', coverageName: 'Business personal property', termValue: d }, ws));
    }
  });

  const bi = period.line.lineCoverages.CPBusinessIncomeCov;
  if (bi && bi.selected) {
    const limit = bi.terms.limit;
    const ws = new Worksheet(`Business income limit ${usd(limit)}`, (limit / 100) * t.businessIncomeRate)
      .x(`State factor (${state})`, sf)
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);
    costs.push(cost({ type: 'Coverage', coverable: 'Policy', coverageCode: 'CPBusinessIncomeCov', coverageName: 'Business income', termValue: limit }, ws));
  }

  const subtotal = round2(costs.reduce((s, c) => s + c.amount, 0));
  if (period.paymentPlan === 'PaidInFull') {
    const pct = t.discounts.paidInFull;
    const ws = new Worksheet('Coverage premium subtotal', subtotal).x(`Paid-in-full discount (${pct * 100}%)`, -pct);
    costs.push(cost({ type: 'Discount', coverable: 'Policy', coverageCode: 'PaidInFullDiscount', coverageName: 'Paid-in-full discount' }, ws));
  }
  return finish(book, costs, state, ctx);
}

// ---------------------------------------------------------------- Workers' Compensation

function rateWorkersComp(period, ctx) {
  const book = selectRateBook('WorkersComp', period.effectiveDate);
  const t = book.tables;
  const product = PRODUCTS.WorkersComp;
  const state = period.state;
  const sf = t.stateFactors[state];
  const mod = period.line.experienceMod;
  const termMonths = period.termMonths || product.termMonths;
  const termF = round4(termMonths / 12);
  const costs = [];

  period.line.classes.forEach((c, i) => {
    const cls = product.classes.find((x) => x.code === c.classCode);
    const rate = t.classRates[c.classCode];
    const ws = new Worksheet(`Payroll $${Number(c.payroll).toLocaleString('en-US')} at $${rate} per $100`, (c.payroll / 100) * rate)
      .x(`State factor (${state})`, sf)
      .x(`Experience modification ${mod}`, mod)
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);
    costs.push(cost({ type: 'Coverage', coverableId: c.id, coverable: `Class ${i + 1}: ${cls.name} (${c.classCode})`, coverageCode: 'WCStatutoryCov', coverageName: 'Workers compensation (class premium)' }, ws));
  });

  const el = period.line.lineCoverages.WCEmployersLiabilityCov;
  if (el && el.selected) {
    const limit = el.terms.limit;
    const ws = new Worksheet(`Employers' liability limit ${usd(limit)}`, t.employersLiabilityCharges[limit])
      .x(`State factor (${state})`, sf)
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);
    costs.push(cost({ type: 'Coverage', coverable: 'Policy', coverageCode: 'WCEmployersLiabilityCov', coverageName: "Employers' liability", termValue: limit }, ws));
  }

  const subtotal = round2(costs.reduce((s, c) => s + c.amount, 0));
  if (period.paymentPlan === 'PaidInFull') {
    const pct = t.discounts.paidInFull;
    const ws = new Worksheet('Coverage premium subtotal', subtotal).x(`Paid-in-full discount (${pct * 100}%)`, -pct);
    costs.push(cost({ type: 'Discount', coverable: 'Policy', coverageCode: 'PaidInFullDiscount', coverageName: 'Paid-in-full discount' }, ws));
  }
  const result = finish(book, costs, state, ctx);
  result.experienceMod = mod;
  return result;
}

// ---------------------------------------------------------------- Businessowners

function rateBusinessowners(period, ctx) {
  const book = selectRateBook('Businessowners', period.effectiveDate);
  const t = book.tables;
  const product = PRODUCTS.Businessowners;
  const state = period.state;
  const sf = t.stateFactors[state];
  const termMonths = period.termMonths || product.termMonths;
  const termF = round4(termMonths / 12);
  const claims = period.line.claimsLast5Years || 0;
  const expF = band(t.experienceFactors, claims);
  const limitOf = (code) => period.line.lineCoverages[code] && period.line.lineCoverages[code].terms.limit;
  const costs = [];

  period.line.locations.forEach((loc, i) => {
    const terr = territoryOf(loc.address.zip);
    const protF = band(t.protectionFactors, loc.protectionClass);
    const occF = t.occupancyFactors[loc.occupancy];
    const base = { type: 'Coverage', coverableId: loc.id, coverable: `Location ${i + 1}: ${loc.description || loc.address.line1}` };
    const common = (ws) => ws
      .x(`State factor (${state})`, sf)
      .x(`Territory ${terr} (ZIP ${loc.address.zip})`, t.territoryFactors[terr])
      .x(`Protection class ${loc.protectionClass}`, protF)
      .x(`Occupancy: ${loc.occupancy}`, occF)
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);
    const bld = period.line.lineCoverages.BOPBuildingCov;
    if (bld && bld.selected) {
      const d = bld.terms.deductible;
      const ws = new Worksheet(`Building $${Number(loc.buildingValue).toLocaleString('en-US')} at $${t.buildingRates[loc.construction]} per $100 (${loc.construction})`, (loc.buildingValue / 100) * t.buildingRates[loc.construction])
        .x(`Deductible ${usd(d)}`, t.deductibleFactors.BOPBuildingCov[d]);
      common(ws);
      costs.push(cost({ ...base, coverageCode: 'BOPBuildingCov', coverageName: 'Building', termValue: d }, ws));
    }
    const bpp = period.line.lineCoverages.BOPBusinessPersonalPropertyCov;
    if (bpp && bpp.selected && loc.contentsValue > 0) {
      const d = bpp.terms.deductible;
      const rate = t.buildingRates[loc.construction] * t.contentsMultiplier;
      const ws = new Worksheet(`Contents $${Number(loc.contentsValue).toLocaleString('en-US')} at $${rate.toFixed(3)} per $100`, (loc.contentsValue / 100) * rate)
        .x(`Deductible ${usd(d)}`, t.deductibleFactors.BOPBusinessPersonalPropertyCov[d]);
      common(ws);
      costs.push(cost({ ...base, coverageCode: 'BOPBusinessPersonalPropertyCov', coverageName: 'Business personal property', termValue: d }, ws));
    }
  });

  const bi = period.line.lineCoverages.BOPBusinessIncomeCov;
  if (bi && bi.selected) {
    const limit = bi.terms.limit;
    const ws = new Worksheet(`Business income limit ${usd(limit)}`, (limit / 100) * t.businessIncomeRate)
      .x(`State factor (${state})`, sf)
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);
    costs.push(cost({ type: 'Coverage', coverable: 'Policy', coverageCode: 'BOPBusinessIncomeCov', coverageName: 'Business income', termValue: limit }, ws));
  }

  const liabLimit = limitOf('BOPPremOpsCov');
  period.line.exposures.forEach((x, i) => {
    const cls = product.classes.find((c) => c.code === x.classCode);
    const rate = t.classRates[x.classCode];
    const ws = new Worksheet(`Exposure $${Number(x.amount).toLocaleString('en-US')} ${x.base.toLowerCase()} at $${rate} per $1,000`, (x.amount / 1000) * rate)
      .x(`State factor, liability (${state})`, sf)
      .x(`Territory ${territoryOf(period.insured.address.zip)} (ZIP ${period.insured.address.zip})`, t.territoryFactors[territoryOf(period.insured.address.zip)])
      .x(`Limit ${liabLimit}`, t.limitFactors.BOPPremOpsCov[liabLimit])
      .x(`Liability claims in 5 years: ${claims}`, expF)
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);
    costs.push(cost({ type: 'Coverage', coverableId: x.id, coverable: `Class ${i + 1}: ${cls.name}`, coverageCode: 'BOPPremOpsCov', coverageName: 'Premises and operations', termValue: liabLimit }, ws));
  });

  const med = period.line.lineCoverages.BOPMedPayCov;
  if (med && med.selected) {
    const limit = med.terms.limit;
    const ws = new Worksheet(`Flat charge (medical expense ${usd(limit)})`, t.medPayCharges.BOPMedPayCov[limit])
      .x(`Rate level (book ${book.version})`, book.rateLevel)
      .x(`Term factor (${termMonths} months)`, termF);
    costs.push(cost({ type: 'Coverage', coverable: 'Policy', coverageCode: 'BOPMedPayCov', coverageName: 'Medical expense', termValue: limit }, ws));
  }

  const subtotal = round2(costs.reduce((s, c) => s + c.amount, 0));
  const discounts = [['PackageDiscount', 'Package discount (property and liability)', t.packageDiscount]];
  if (period.paymentPlan === 'PaidInFull') discounts.push(['PaidInFullDiscount', 'Paid-in-full discount', t.discounts.paidInFull]);
  for (const [code, name, pct] of discounts) {
    const ws = new Worksheet('Coverage premium subtotal', subtotal).x(`${name} (${pct * 100}%)`, -pct);
    costs.push(cost({ type: 'Discount', coverable: 'Policy', coverageCode: code, coverageName: name }, ws));
  }

  const result = finish(book, costs, state, ctx);
  result.claimExperience = { claimsLast5Years: claims, factor: expF };
  return result;
}

// ---------------------------------------------------------------- Umbrella

function rateUmbrella(period, ctx) {
  const book = selectRateBook('Umbrella', period.effectiveDate);
  const t = book.tables;
  const product = PRODUCTS.Umbrella;
  const state = period.state;
  const sf = t.stateFactors[state];
  const termMonths = period.termMonths || product.termMonths;
  const termF = round4(termMonths / 12);
  const line = period.line;
  const limit = line.lineCoverages.UMBExcessCov.terms.limit;
  const costs = [];
  const ws = new Worksheet(`Umbrella limit ${usd(limit)}`, t.limitRates[limit])
    .x(`State factor (${state})`, sf)
    .x(`Vehicles: ${line.numberOfVehicles}`, band(t.vehicleFactors, line.numberOfVehicles))
    .x(`Locations: ${line.numberOfLocations}`, band(t.locationFactors, line.numberOfLocations))
    .x(`Liability claims in 5 years: ${line.claimsLast5Years}`, band(t.experienceFactors, line.claimsLast5Years))
    .x(`Rate level (book ${book.version})`, book.rateLevel)
    .x(`Term factor (${termMonths} months)`, termF);
  costs.push(cost({ type: 'Coverage', coverable: 'Policy', coverageCode: 'UMBExcessCov', coverageName: 'Umbrella liability', termValue: limit }, ws));

  const subtotal = round2(costs.reduce((s, c) => s + c.amount, 0));
  if (period.paymentPlan === 'PaidInFull') {
    const pct = t.discounts.paidInFull;
    const d = new Worksheet('Coverage premium subtotal', subtotal).x(`Paid-in-full discount (${pct * 100}%)`, -pct);
    costs.push(cost({ type: 'Discount', coverable: 'Policy', coverageCode: 'PaidInFullDiscount', coverageName: 'Paid-in-full discount' }, d));
  }
  return finish(book, costs, state, ctx);
}

// ---------------------------------------------------------------- Two-Wheeler

function ratedRider(riders, effectiveDate, t) {
  let best = null;
  for (const d of riders) {
    const age = D.ageOn(d.dob, effectiveDate);
    let f = ageBand(t.driverAgeFactors, age)
      * band(t.experienceFactors, d.yearsLicensed || 0)
      * t.accidentFactors[Math.min(d.accidents || 0, 3)]
      * Math.pow(t.violationFactor, d.violations || 0);
    if (d.riderTraining) f *= t.trainingFactor;
    f = round4(f);
    if (!best || f > best.factor) best = { id: d.id, label: `${d.firstName} ${d.lastName}, age ${age}${d.riderTraining ? ', rider course' : ''}`, factor: f };
  }
  return best || { id: null, label: 'none', factor: 1 };
}

function rateTwoWheeler(period, ctx) {
  const book = selectRateBook('TwoWheeler', period.effectiveDate);
  const t = book.tables;
  const product = PRODUCTS.TwoWheeler;
  const state = period.state;
  const sf = t.stateFactors[state];
  const termMonths = period.termMonths || product.termMonths;
  const termF = round4(termMonths / 12);
  const effYear = D.yearOf(period.effectiveDate);
  const rd = ratedRider(period.line.drivers, period.effectiveDate, t);
  const outdoors = (period.line.answers || {}).keptOutdoors === 'yes';
  const costs = [];

  period.line.vehicles.forEach((v, i) => {
    const coverable = `Bike ${i + 1}: ${v.year} ${v.make} ${v.model}`;
    const terr = territoryOf(v.garagingZip);
    const bikeAge = Math.max(0, effYear - v.year);
    const base = { type: 'Coverage', coverableId: v.id, coverable };
    const bike = (ws) => ws
      .x(`Engine ${v.engineCc} cc`, band(t.engineFactors, v.engineCc || 0))
      .x(`Bike type: ${v.bikeType}`, t.bikeTypeFactors[v.bikeType]);

    for (const def of product.lineCoverages) {
      const cov = period.line.lineCoverages[def.code];
      if (!cov || !cov.selected) continue;
      const limit = cov.terms.limit;
      const ws = bike(new Worksheet('Annual base rate', t.baseRates[def.code])
        .x(`State factor, liability (${state})`, sf.liability)
        .x(`Territory ${terr} (ZIP ${v.garagingZip})`, t.territoryFactors[terr])
        .x(`Limit ${limit}`, t.limitFactors[def.code][limit])
        .x(`Rider (${rd.label})`, rd.factor))
        .x(`Use: ${v.usage}`, t.usageFactors[v.usage])
        .x(`Annual mileage ${Number(v.annualMiles || 0).toLocaleString('en-US')}`, band(t.mileageFactors, v.annualMiles || 0))
        .x(`Rate level (book ${book.version})`, book.rateLevel)
        .x(`Term factor (${termMonths} months)`, termF);
      costs.push(cost({ ...base, coverageCode: def.code, coverageName: def.name, termValue: limit }, ws));
    }

    for (const def of product.vehicleCoverages) {
      const cov = v.coverages[def.code];
      if (!cov || !cov.selected) continue;
      let ws;
      let termValue;
      if (def.code === 'TWAccessoriesCov') {
        termValue = cov.terms.limit;
        ws = new Worksheet(`Flat annual charge (${termValue})`, t.flatCharges[def.code][termValue]);
      } else {
        termValue = cov.terms.deductible;
        ws = new Worksheet('Annual base rate', t.baseRates[def.code])
          .x(`State factor, physical damage (${state})`, sf.physical)
          .x(`Territory ${terr} (ZIP ${v.garagingZip})`, t.territoryFactors[terr])
          .x(`Deductible $${termValue}`, t.deductibleFactors[def.code][termValue])
          .x(`Bike age ${bikeAge} yrs`, band(t.vehicleAgeFactors, bikeAge))
          .x(`Market value ${usd(v.marketValue)}`, band(t.vehicleValueFactors, v.marketValue || 0));
        bike(ws);
        if (def.code === 'TWCollisionCov') ws.x(`Rider (${rd.label})`, rd.factor).x(`Use: ${v.usage}`, t.usageFactors[v.usage]);
        if (def.code === 'TWComprehensiveCov' && outdoors) ws.x('Kept outdoors overnight', t.outdoorFactor);
      }
      ws.x(`Rate level (book ${book.version})`, book.rateLevel).x(`Term factor (${termMonths} months)`, termF);
      costs.push(cost({ ...base, coverageCode: def.code, coverageName: def.name, termValue }, ws));
    }
  });

  const subtotal = round2(costs.reduce((s, c) => s + c.amount, 0));
  const discounts = [];
  if (period.line.vehicles.length >= 2) discounts.push(['MultiBikeDiscount', 'Multi-bike discount', t.discounts.multiBike]);
  if (period.paymentPlan === 'PaidInFull') discounts.push(['PaidInFullDiscount', 'Paid-in-full discount', t.discounts.paidInFull]);
  if (t.multiYearDiscounts[termMonths]) discounts.push(['MultiYearDiscount', `Multi-year discount (${termMonths / 12} years)`, t.multiYearDiscounts[termMonths]]);
  const claimFree = period.line.claimFreeRenewals || 0;
  if (claimFree >= 1) discounts.push(['ClaimFreeDiscount', `Claim-free renewal discount (${claimFree} claim-free renewal${claimFree > 1 ? 's' : ''})`, t.claimFreeDiscounts[Math.min(claimFree, t.claimFreeDiscounts.length) - 1]]);
  for (const [code, name, pct] of discounts) {
    const ws = new Worksheet('Coverage premium subtotal', subtotal).x(`${name} (${Math.round(pct * 10000) / 100}%)`, -pct);
    costs.push(cost({ type: 'Discount', coverable: 'Policy', coverageCode: code, coverageName: name }, ws));
  }
  const result = finish(book, costs, state, ctx);
  result.ratedDriver = rd;
  return result;
}

function rate(product, period, ctx) {
  if (product === 'PersonalAuto') return ratePersonalAuto(period, ctx);
  if (product === 'Homeowners') return rateHomeowners(period, ctx);
  if (product === 'CommercialAuto') return rateCommercialAuto(period, ctx);
  if (product === 'GeneralLiability') return rateGeneralLiability(period, ctx);
  if (product === 'CommercialProperty') return rateCommercialProperty(period, ctx);
  if (product === 'WorkersComp') return rateWorkersComp(period, ctx);
  if (product === 'Businessowners') return rateBusinessowners(period, ctx);
  if (product === 'Umbrella') return rateUmbrella(period, ctx);
  if (product === 'TwoWheeler') return rateTwoWheeler(period, ctx);
  throw new Error(`Unknown product ${product}`);
}

module.exports = { rate, selectRateBook, replacementCostEstimate, territoryOf, round2 };
