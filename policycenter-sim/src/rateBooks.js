'use strict';
// Rate books: versioned, effective-dated sets of rate tables (PolicyCenter Rating Management).
// The rating engine picks the newest Active book whose effective date is on or before the
// policy period's effective date, so renewals naturally pick up filed rate changes.

const PA_TABLES = {
  // Annual base rates per vehicle, before factors.
  baseRates: {
    PABodilyInjuryCov: 420, PAPropertyDamageCov: 310, PAUninsuredMotoristCov: 95, PAMedPayCov: 60, PAPIPCov: 180,
    PACollisionCov: 520, PAComprehensiveCov: 190,
  },
  flatCharges: {
    PARentalCov: { '30/900': 38, '50/1500': 58 },
    PATowingCov: { 75: 18, 150: 28 },
  },
  stateFactors: {
    CA: { liability: 1.18, physical: 1.12 },
    FL: { liability: 1.35, physical: 1.15 },
    IL: { liability: 1.0, physical: 0.98 },
    NY: { liability: 1.3, physical: 1.2 },
    OH: { liability: 0.82, physical: 0.9 },
    TX: { liability: 1.05, physical: 1.1 },
  },
  territoryFactors: { 1: 0.92, 2: 0.97, 3: 1.0, 4: 1.06, 5: 1.14 },
  limitFactors: {
    PABodilyInjuryCov: { '25/50': 0.8, '50/100': 1.0, '100/300': 1.22, '250/500': 1.45 },
    PAPropertyDamageCov: { 25: 0.88, 50: 1.0, 100: 1.09, 250: 1.2 },
    PAUninsuredMotoristCov: { '25/50': 0.8, '50/100': 1.0, '100/300': 1.2, '250/500': 1.4 },
    PAMedPayCov: { 1000: 0.6, 5000: 1.0, 10000: 1.35 },
    PAPIPCov: { 10000: 1.0, 50000: 1.6 },
  },
  deductibleFactors: {
    PACollisionCov: { 250: 1.15, 500: 1.0, 1000: 0.82, 2000: 0.68 },
    PAComprehensiveCov: { 100: 1.3, 250: 1.12, 500: 1.0, 1000: 0.8 },
  },
  driverAgeFactors: [
    { min: 0, max: 19, f: 2.2 }, { min: 20, max: 24, f: 1.6 }, { min: 25, max: 29, f: 1.15 },
    { min: 30, max: 64, f: 1.0 }, { min: 65, max: 74, f: 1.08 }, { min: 75, max: 200, f: 1.3 },
  ],
  experienceFactors: [{ max: 2, f: 1.25 }, { max: 5, f: 1.08 }, { f: 1.0 }],
  accidentFactors: { 0: 1.0, 1: 1.35, 2: 1.8, 3: 2.4 },
  violationFactor: 1.15,
  goodStudentFactor: 0.9,
  usageFactors: { Pleasure: 0.9, Commute: 1.0, Business: 1.2 },
  mileageFactors: [{ max: 7500, f: 0.9 }, { max: 15000, f: 1.0 }, { max: 25000, f: 1.1 }, { f: 1.25 }],
  vehicleAgeFactors: [{ max: 2, f: 1.25 }, { max: 5, f: 1.1 }, { max: 10, f: 1.0 }, { max: 15, f: 0.82 }, { f: 0.65 }],
  vehicleValueFactors: [
    { max: 10000, f: 0.6 }, { max: 20000, f: 0.85 }, { max: 35000, f: 1.0 },
    { max: 50000, f: 1.25 }, { max: 80000, f: 1.6 }, { f: 2.1 },
  ],
  discounts: { multiCar: 0.1, multiPolicy: 0.12, paidInFull: 0.05 },
  taxRates: { CA: 0.0235, FL: 0.0175, IL: 0.005, NY: 0.02, OH: 0.014, TX: 0.0185 },
  policyFee: 25,
};

const HO_TABLES = {
  baseRatePer1000: { HO3: 3.1, HO5: 3.65, HO6: 2.2 },
  contentsRatePer1000: { HO4: 6.5, HO6: 4.0 },
  stateFactors: { CA: 1.1, FL: 1.6, IL: 0.95, NY: 1.15, OH: 0.85, TX: 1.45 },
  territoryFactors: { 1: 0.9, 2: 0.96, 3: 1.0, 4: 1.08, 5: 1.18 },
  constructionFactors: { Frame: 1.1, Masonry: 0.95, Superior: 0.85 },
  protectionClassFactors: { 1: 0.85, 2: 0.88, 3: 0.92, 4: 0.96, 5: 1.0, 6: 1.05, 7: 1.12, 8: 1.25, 9: 1.6, 10: 2.2 },
  homeAgeFactors: [{ max: 5, f: 0.85 }, { max: 15, f: 0.92 }, { max: 30, f: 1.0 }, { max: 50, f: 1.12 }, { f: 1.25 }],
  roofAgeFactors: [{ max: 5, f: 0.9 }, { max: 10, f: 1.0 }, { max: 15, f: 1.1 }, { max: 20, f: 1.25 }, { f: 1.5 }],
  aopDeductibleFactors: { 500: 1.08, 1000: 1.0, 2500: 0.88, 5000: 0.78 },
  claimsFactors: { 0: 0.95, 1: 1.1, 2: 1.3, 3: 1.6 },
  alarmFactors: { None: 1.0, Local: 0.97, Central: 0.92 },
  sprinklerFactor: 0.95,
  // Included limits as a share of Cov A (owner forms) or Cov C (HO4/HO6); excess is charged per $1,000.
  includedContentsPct: { HO3: 0.5, HO5: 0.7 },
  includedLossOfUsePct: { HO3: 0.2, HO5: 0.2, HO4: 0.3, HO6: 0.4 },
  increasedLimitRates: { B: 1.5, C: 1.8, D: 1.0 },
  liabilityCharges: { 100000: 28, 300000: 42, 500000: 55, 1000000: 85 },
  liabilityHazardFactors: { pool: 1.05, trampoline: 1.15, aggressiveDog: 1.2 },
  medPayCharges: { 1000: 8, 2500: 12, 5000: 18 },
  windHail: { stateFactors: { FL: 0.55, TX: 0.4 }, deductibleFactors: { '1%': 1.0, '2%': 0.85, '5%': 0.65 } },
  endorsements: {
    waterBackup: { 5000: 45, 10000: 75, 25000: 140 },
    replacementCostContentsLoad: 0.12,
    jewelryRatePer100: 1.25,
    identityTheft: 25,
    earthquakeRatePer1000: { CA: 2.8, default: 0.35 },
    earthquakeDeductibleFactors: { '10%': 1.0, '15%': 0.85, '20%': 0.72 },
  },
  discounts: { multiPolicy: 0.1 },
  minimumPremium: 250,
  // Replacement cost estimator (used for Cov A defaults and insurance-to-value checks).
  costPerSqft: { Frame: 210, Masonry: 235, Superior: 280 },
  stateCostFactors: { CA: 1.35, FL: 1.05, IL: 1.0, NY: 1.3, OH: 0.9, TX: 0.95 },
  taxRates: { CA: 0.0235, FL: 0.0175, IL: 0.005, NY: 0.02, OH: 0.014, TX: 0.0185 },
  policyFee: 15,
};

// Commercial auto: annual base rates per vehicle, then factors for state, use, radius, deductible,
// value and the fleet's driving record. Demonstration values, not filed rates.
const CA_TABLES = {
  baseRates: { CAAutoLiabilityCov: 1450, CAUninsuredMotoristCov: 160, CACollisionCov: 1150, CAComprehensiveCov: 360 },
  stateFactors: {
    CA: { liability: 1.2, physical: 1.12 },
    FL: { liability: 1.35, physical: 1.15 },
    IL: { liability: 1.0, physical: 0.98 },
    NY: { liability: 1.3, physical: 1.2 },
    OH: { liability: 0.85, physical: 0.9 },
    TX: { liability: 1.08, physical: 1.1 },
  },
  territoryFactors: { 1: 0.92, 2: 0.97, 3: 1.0, 4: 1.06, 5: 1.14 },
  limitFactors: {
    CAAutoLiabilityCov: { 500000: 1.0, 1000000: 1.32, 2000000: 1.65 },
    CAUninsuredMotoristCov: { 500000: 1.0, 1000000: 1.25 },
  },
  deductibleFactors: {
    CACollisionCov: { 500: 1.0, 1000: 0.85, 2500: 0.7 },
    CAComprehensiveCov: { 250: 1.12, 500: 1.0, 1000: 0.85 },
  },
  usageFactors: { Light: 1.0, Service: 1.15, Delivery: 1.3, Heavy: 1.6 },
  radiusFactors: { Local: 1.0, Intermediate: 1.25, Long: 1.55 },
  // Fleet average of at-fault accidents per driver over 3 years.
  fleetRiskBands: [{ max: 0.1, f: 1.0 }, { max: 0.3, f: 1.2 }, { f: 1.45 }],
  vehicleAgeFactors: [{ max: 2, f: 1.25 }, { max: 5, f: 1.1 }, { max: 10, f: 1.0 }, { max: 15, f: 0.82 }, { f: 0.65 }],
  vehicleValueFactors: [
    { max: 10000, f: 0.6 }, { max: 20000, f: 0.85 }, { max: 35000, f: 1.0 },
    { max: 50000, f: 1.25 }, { max: 80000, f: 1.6 }, { f: 2.1 },
  ],
  discounts: { fleet5: 0.08, fleet10: 0.12, paidInFull: 0.05 },
  taxRates: { CA: 0.0235, FL: 0.0175, IL: 0.005, NY: 0.02, OH: 0.014, TX: 0.0185 },
  policyFee: 50,
};

// General liability: rate per $1,000 of each class's exposure, then factors for limit, state,
// territory and the account's liability claims in 5 years. Demonstration values, not filed rates.
const GL_TABLES = {
  classRates: { '91340': 9.5, '98482': 7.2, '46820': 0.6, '60010': 0.9, '16500': 2.4, '16501': 4.6 },
  limitFactors: { GLPremOpsCov: { '1000000/2000000': 1.0, '2000000/4000000': 1.35 } },
  medPayCharges: { GLMedPayCov: { 1000: 40, 5000: 70, 10000: 110 } },
  stateFactors: { CA: 1.25, FL: 1.4, IL: 1.05, NY: 1.45, OH: 0.9, TX: 1.1 },
  territoryFactors: { 1: 0.92, 2: 0.97, 3: 1.0, 4: 1.06, 5: 1.14 },
  experienceFactors: [{ max: 0, f: 1.0 }, { max: 1, f: 1.2 }, { max: 2, f: 1.5 }, { f: 1.9 }],
  discounts: { paidInFull: 0.05 },
  taxRates: { CA: 0.0235, FL: 0.0175, IL: 0.005, NY: 0.02, OH: 0.014, TX: 0.0185 },
  policyFee: 50,
};

// Commercial property: rate per $100 of value by construction, then factors for protection class,
// occupancy, state, territory and deductible. Demonstration values, not filed rates.
const CP_TABLES = {
  buildingRates: { Frame: 0.42, Masonry: 0.24, Superior: 0.14 },
  contentsMultiplier: 1.1,
  protectionFactors: [{ max: 3, f: 0.85 }, { max: 5, f: 1.0 }, { max: 7, f: 1.2 }, { f: 1.5 }],
  occupancyFactors: { Office: 0.9, Retail: 1.0, Warehouse: 1.15, Restaurant: 1.35 },
  stateFactors: { CA: 1.2, FL: 1.4, IL: 1.0, NY: 1.3, OH: 0.9, TX: 1.1 },
  territoryFactors: { 1: 0.92, 2: 0.97, 3: 1.0, 4: 1.06, 5: 1.14 },
  deductibleFactors: {
    CPBuildingCov: { 1000: 1.12, 2500: 1.0, 5000: 0.9, 10000: 0.8 },
    CPBusinessPersonalPropertyCov: { 1000: 1.12, 2500: 1.0, 5000: 0.9, 10000: 0.8 },
  },
  businessIncomeRate: 0.15,
  discounts: { paidInFull: 0.05 },
  taxRates: { CA: 0.0235, FL: 0.0175, IL: 0.005, NY: 0.02, OH: 0.014, TX: 0.0185 },
  policyFee: 50,
};

// Workers' compensation: rate per $100 of payroll for each classification, then the state factor and
// the business's experience modification. Demonstration values, not filed rates.
const WC_TABLES = {
  classRates: { '8810': 0.12, '8742': 0.45, '9079': 2.6, '5183': 3.9, '5403': 6.8 },
  employersLiabilityCharges: { 100000: 85, 500000: 130, 1000000: 165 },
  stateFactors: { CA: 1.3, FL: 1.1, IL: 1.0, NY: 1.25, OH: 0.95, TX: 0.9 },
  discounts: { paidInFull: 0.05 },
  taxRates: { CA: 0.0235, FL: 0.0175, IL: 0.005, NY: 0.02, OH: 0.014, TX: 0.0185 },
  policyFee: 50,
};

// Businessowners: property per location (as Commercial Property) plus liability per class (as General
// Liability), with a package discount. Demonstration values, not filed rates.
const BOP_TABLES = {
  buildingRates: { Frame: 0.42, Masonry: 0.24, Superior: 0.14 },
  contentsMultiplier: 1.1,
  protectionFactors: [{ max: 3, f: 0.85 }, { max: 5, f: 1.0 }, { max: 7, f: 1.2 }, { f: 1.5 }],
  occupancyFactors: { Office: 0.9, Retail: 1.0, Warehouse: 1.15, Restaurant: 1.35 },
  deductibleFactors: {
    BOPBuildingCov: { 1000: 1.12, 2500: 1.0, 5000: 0.9, 10000: 0.8 },
    BOPBusinessPersonalPropertyCov: { 1000: 1.12, 2500: 1.0, 5000: 0.9, 10000: 0.8 },
  },
  businessIncomeRate: 0.15,
  classRates: { '91340': 9.5, '98482': 7.2, '46820': 0.6, '60010': 0.9, '16500': 2.4, '16501': 4.6 },
  limitFactors: { BOPPremOpsCov: { '1000000/2000000': 1.0, '2000000/4000000': 1.35 } },
  medPayCharges: { BOPMedPayCov: { 1000: 40, 5000: 70, 10000: 110 } },
  experienceFactors: [{ max: 0, f: 1.0 }, { max: 1, f: 1.2 }, { max: 2, f: 1.5 }, { f: 1.9 }],
  stateFactors: { CA: 1.22, FL: 1.4, IL: 1.02, NY: 1.35, OH: 0.9, TX: 1.1 },
  territoryFactors: { 1: 0.92, 2: 0.97, 3: 1.0, 4: 1.06, 5: 1.14 },
  packageDiscount: 0.1,
  discounts: { paidInFull: 0.05 },
  taxRates: { CA: 0.0235, FL: 0.0175, IL: 0.005, NY: 0.02, OH: 0.014, TX: 0.0185 },
  policyFee: 50,
};

// Umbrella: a premium per umbrella limit, adjusted for fleet size, locations, claims and state.
// Demonstration values, not filed rates.
const UMB_TABLES = {
  limitRates: { 1000000: 320, 2000000: 480, 5000000: 820, 10000000: 1200 },
  vehicleFactors: [{ max: 0, f: 1.0 }, { max: 5, f: 1.25 }, { max: 20, f: 1.6 }, { f: 2.2 }],
  locationFactors: [{ max: 1, f: 1.0 }, { max: 5, f: 1.15 }, { f: 1.35 }],
  experienceFactors: [{ max: 0, f: 1.0 }, { max: 1, f: 1.2 }, { max: 2, f: 1.5 }, { f: 1.9 }],
  stateFactors: { CA: 1.25, FL: 1.4, IL: 1.05, NY: 1.35, OH: 0.9, TX: 1.1 },
  discounts: { paidInFull: 0.05 },
  taxRates: { CA: 0.0235, FL: 0.0175, IL: 0.005, NY: 0.02, OH: 0.014, TX: 0.0185 },
  policyFee: 50,
};

const RATE_BOOKS = [
  { code: 'PA-STD', product: 'PersonalAuto', version: '2026.1', effectiveDate: '2025-01-01', status: 'Active', rateLevel: 1.0, description: 'Personal Auto standard rate book', tables: PA_TABLES },
  { code: 'PA-STD', product: 'PersonalAuto', version: '2027.1', effectiveDate: '2027-01-01', status: 'Active', rateLevel: 1.045, description: '+4.5% overall rate level change (filed 2026-09)', tables: PA_TABLES },
  { code: 'HO-STD', product: 'Homeowners', version: '2026.1', effectiveDate: '2025-01-01', status: 'Active', rateLevel: 1.0, description: 'Homeowners standard rate book', tables: HO_TABLES },
  { code: 'HO-STD', product: 'Homeowners', version: '2027.1', effectiveDate: '2027-01-01', status: 'Active', rateLevel: 1.06, description: '+6.0% overall rate level change (reinsurance cost increase)', tables: HO_TABLES },
  { code: 'HO-STD', product: 'Homeowners', version: '2027.2', effectiveDate: '2027-07-01', status: 'Draft', rateLevel: 1.08, description: 'Proposed +8% (pending regulatory approval, not used for rating)', tables: HO_TABLES },
  { code: 'CA-STD', product: 'CommercialAuto', version: '2026.1', effectiveDate: '2025-01-01', status: 'Active', rateLevel: 1.0, description: 'Commercial auto standard rate book', tables: CA_TABLES },
  { code: 'GL-STD', product: 'GeneralLiability', version: '2026.1', effectiveDate: '2025-01-01', status: 'Active', rateLevel: 1.0, description: 'General liability standard rate book', tables: GL_TABLES },
  { code: 'CP-STD', product: 'CommercialProperty', version: '2026.1', effectiveDate: '2025-01-01', status: 'Active', rateLevel: 1.0, description: 'Commercial property standard rate book', tables: CP_TABLES },
  { code: 'WC-STD', product: 'WorkersComp', version: '2026.1', effectiveDate: '2025-01-01', status: 'Active', rateLevel: 1.0, description: "Workers' compensation standard rate book", tables: WC_TABLES },
  { code: 'BP-STD', product: 'Businessowners', version: '2026.1', effectiveDate: '2025-01-01', status: 'Active', rateLevel: 1.0, description: 'Businessowners standard rate book', tables: BOP_TABLES },
  { code: 'UM-STD', product: 'Umbrella', version: '2026.1', effectiveDate: '2025-01-01', status: 'Active', rateLevel: 1.0, description: 'Umbrella standard rate book', tables: UMB_TABLES },
];

module.exports = { RATE_BOOKS };
