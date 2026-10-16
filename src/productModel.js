'use strict';
// Product model: the equivalent of PolicyCenter's Product Designer / APD configuration.
// Products -> policy lines -> coverables -> coverages -> coverage terms.
// Prices live in the rate books (rateBooks.js), not here.

const STATES = { CA: 'California', FL: 'Florida', IL: 'Illinois', NY: 'New York', OH: 'Ohio', TX: 'Texas' };

const PRODUCER_CODES = [
  { code: 'PC-100', name: 'Acme Insurance Agency' },
  { code: 'PC-200', name: 'Blue River Brokers' },
];

// Authority: 0 = no underwriting authority, 1 = underwriter, 2 = underwriting manager.
const USERS = [
  { id: 'agent', name: 'Alex Agent', role: 'Agent', authority: 0, producerCode: 'PC-100' },
  { id: 'agent2', name: 'Blair Broker', role: 'Agent', authority: 0, producerCode: 'PC-200' },
  { id: 'uw', name: 'Uma Underwriter', role: 'Underwriter', authority: 1 },
  { id: 'uwm', name: 'Morgan Lee', role: 'UW Manager', authority: 2 },
];

const opt = (value, label) => ({ value, label });
const usd = (n) => '$' + Number(n).toLocaleString('en-US');
const moneyOpts = (values) => values.map((v) => opt(String(v), usd(v)));

const BI_LIMITS = [
  opt('25/50', '$25K / $50K'),
  opt('50/100', '$50K / $100K'),
  opt('100/300', '$100K / $300K'),
  opt('250/500', '$250K / $500K'),
];

const PERSONAL_AUTO = {
  code: 'PersonalAuto',
  name: 'Personal Auto',
  prefix: 'PA',
  termMonths: 6,
  paymentPlans: [
    { code: 'PaidInFull', name: 'Paid in full', installments: 1, installmentFee: 0 },
    { code: 'Monthly', name: 'Monthly (6 installments)', installments: 6, installmentFee: 5 },
  ],
  usages: ['Pleasure', 'Commute', 'Business'],
  lineCoverages: [
    {
      code: 'PABodilyInjuryCov', name: 'Bodily Injury Liability', category: 'Liability', existence: 'Required',
      terms: [{ code: 'limit', name: 'Limit (per person / per accident)', type: 'option', options: BI_LIMITS, default: '100/300' }],
    },
    {
      code: 'PAPropertyDamageCov', name: 'Property Damage Liability', category: 'Liability', existence: 'Required',
      terms: [{ code: 'limit', name: 'Limit', type: 'option', options: [opt('25', '$25,000'), opt('50', '$50,000'), opt('100', '$100,000'), opt('250', '$250,000')], default: '100' }],
    },
    {
      code: 'PAUninsuredMotoristCov', name: 'Uninsured / Underinsured Motorist', category: 'Liability', existence: 'Electable', defaultSelected: true,
      terms: [{ code: 'limit', name: 'Limit', type: 'option', options: BI_LIMITS, default: '100/300' }],
    },
    {
      code: 'PAMedPayCov', name: 'Medical Payments', category: 'Liability', existence: 'Electable', defaultSelected: true,
      terms: [{ code: 'limit', name: 'Limit', type: 'option', options: moneyOpts([1000, 5000, 10000]), default: '5000' }],
    },
    {
      code: 'PAPIPCov', name: 'Personal Injury Protection (No-Fault)', category: 'Liability', existence: 'Required', states: ['FL', 'NY'],
      terms: [{ code: 'limit', name: 'Limit', type: 'option', options: moneyOpts([10000, 50000]), default: '10000' }],
    },
  ],
  vehicleCoverages: [
    {
      code: 'PACollisionCov', name: 'Collision', category: 'Physical Damage', existence: 'Electable', defaultSelected: true,
      terms: [{ code: 'deductible', name: 'Deductible', type: 'option', options: moneyOpts([250, 500, 1000, 2000]), default: '500' }],
    },
    {
      code: 'PAComprehensiveCov', name: 'Comprehensive (Other Than Collision)', category: 'Physical Damage', existence: 'Electable', defaultSelected: true,
      terms: [{ code: 'deductible', name: 'Deductible', type: 'option', options: moneyOpts([100, 250, 500, 1000]), default: '500' }],
    },
    {
      code: 'PARentalCov', name: 'Rental Reimbursement', category: 'Optional', existence: 'Electable',
      terms: [{ code: 'limit', name: 'Limit (per day / max)', type: 'option', options: [opt('30/900', '$30 / $900'), opt('50/1500', '$50 / $1,500')], default: '30/900' }],
    },
    {
      code: 'PATowingCov', name: 'Towing & Labor', category: 'Optional', existence: 'Electable',
      terms: [{ code: 'limit', name: 'Limit per disablement', type: 'option', options: moneyOpts([75, 150]), default: '75' }],
    },
  ],
};

const directLimit = (name = 'Limit') => [{ code: 'limit', name, type: 'direct', default: null }];

const HOMEOWNERS = {
  code: 'Homeowners',
  name: 'Homeowners',
  prefix: 'HO',
  termMonths: 12,
  paymentPlans: [
    { code: 'PaidInFull', name: 'Paid in full', installments: 1, installmentFee: 0 },
    { code: 'Quarterly', name: 'Quarterly (4 installments)', installments: 4, installmentFee: 3 },
    { code: 'Monthly', name: 'Monthly (12 installments)', installments: 12, installmentFee: 4 },
  ],
  forms: [
    { code: 'HO3', name: 'HO-3 Special Form (owner occupied)' },
    { code: 'HO5', name: 'HO-5 Comprehensive Form (owner occupied)' },
    { code: 'HO4', name: 'HO-4 Contents Broad Form (renters)' },
    { code: 'HO6', name: 'HO-6 Unit Owners Form (condominium)' },
  ],
  constructionTypes: ['Frame', 'Masonry', 'Superior'],
  alarmTypes: ['None', 'Local', 'Central'],
  coverages: [
    { code: 'HODwellingCov', name: 'Coverage A - Dwelling', category: 'Section I - Property', existence: 'Required', forms: ['HO3', 'HO5', 'HO6'], terms: directLimit() },
    { code: 'HOOtherStructuresCov', name: 'Coverage B - Other Structures', category: 'Section I - Property', existence: 'Required', forms: ['HO3', 'HO5'], terms: directLimit() },
    { code: 'HOPersonalPropertyCov', name: 'Coverage C - Personal Property', category: 'Section I - Property', existence: 'Required', terms: directLimit() },
    { code: 'HOLossOfUseCov', name: 'Coverage D - Loss of Use', category: 'Section I - Property', existence: 'Required', terms: directLimit() },
    {
      code: 'HOLiabilityCov', name: 'Coverage E - Personal Liability', category: 'Section II - Liability', existence: 'Required',
      terms: [{ code: 'limit', name: 'Limit', type: 'option', options: moneyOpts([100000, 300000, 500000, 1000000]), default: '300000' }],
    },
    {
      code: 'HOMedPayCov', name: 'Coverage F - Medical Payments to Others', category: 'Section II - Liability', existence: 'Required',
      terms: [{ code: 'limit', name: 'Limit', type: 'option', options: moneyOpts([1000, 2500, 5000]), default: '5000' }],
    },
    {
      code: 'HODeductibles', name: 'Section I Deductibles', category: 'Deductibles', existence: 'Required',
      terms: [
        { code: 'aop', name: 'All other perils', type: 'option', options: moneyOpts([500, 1000, 2500, 5000]), default: '1000' },
        { code: 'windHail', name: 'Windstorm / hail', type: 'option', options: [opt('1%', '1% of Cov A'), opt('2%', '2% of Cov A'), opt('5%', '5% of Cov A')], default: '2%', states: ['FL', 'TX'] },
      ],
    },
    {
      code: 'HOWaterBackupCov', name: 'Water Backup & Sump Overflow', category: 'Endorsements', existence: 'Electable',
      terms: [{ code: 'limit', name: 'Limit', type: 'option', options: moneyOpts([5000, 10000, 25000]), default: '10000' }],
    },
    { code: 'HOReplacementCostContentsCov', name: 'Replacement Cost - Personal Property', category: 'Endorsements', existence: 'Electable', forms: ['HO3', 'HO4', 'HO6'], terms: [] },
    { code: 'HOScheduledJewelryCov', name: 'Scheduled Jewelry', category: 'Endorsements', existence: 'Electable', terms: [{ code: 'limit', name: 'Total scheduled value', type: 'direct', default: 5000 }] },
    { code: 'HOIdentityTheftCov', name: 'Identity Fraud Expense', category: 'Endorsements', existence: 'Electable', terms: [] },
    {
      code: 'HOEarthquakeCov', name: 'Earthquake', category: 'Endorsements', existence: 'Electable', forms: ['HO3', 'HO5', 'HO6'],
      terms: [{ code: 'deductible', name: 'Deductible', type: 'option', options: [opt('10%', '10%'), opt('15%', '15%'), opt('20%', '20%')], default: '15%' }],
    },
  ],
};

const PRODUCTS = { PersonalAuto: PERSONAL_AUTO, Homeowners: HOMEOWNERS };

const isAvailable = (def, ctx) =>
  (!def.states || def.states.includes(ctx.state)) && (!def.forms || def.forms.includes(ctx.form));

// Brings a coverage map in line with the product model: drops unavailable coverages,
// adds missing ones with defaults, forces required ones on, and repairs bad term values.
function normalizeCoverages(defs, current, ctx, directDefaults = {}) {
  const out = {};
  for (const def of defs) {
    if (!isAvailable(def, ctx)) continue;
    const cur = current && current[def.code];
    const selected = def.existence === 'Required' ? true : cur ? !!cur.selected : !!def.defaultSelected;
    const terms = {};
    for (const term of def.terms) {
      if (term.states && !term.states.includes(ctx.state)) continue;
      let v = cur && cur.terms ? cur.terms[term.code] : undefined;
      if (term.type === 'option') {
        v = v == null ? undefined : String(v);
        if (!term.options.some((o) => o.value === v)) v = term.default;
      } else {
        const n = Number(v);
        v = v === '' || v == null || !Number.isFinite(n) ? directDefaults[def.code] ?? term.default : Math.round(n);
      }
      terms[term.code] = v;
    }
    out[def.code] = { selected, terms };
  }
  return out;
}

module.exports = { STATES, PRODUCER_CODES, USERS, PRODUCTS, isAvailable, normalizeCoverages };
