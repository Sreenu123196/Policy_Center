'use strict';
// The caps each product actually carries.
//
// Kept as data, not as code in each coverage, so the rule in policyCaps.js stays pure and a change of limit is a change of
// one line that a test can pin. The values mirror the sample wordings used elsewhere in the project.

const CAPS = [
  // Homeowners: a contents limit with a much smaller jewellery sub-limit inside it.
  { product: 'Homeowners', coverage: 'contents', limit: 250000, kind: 'general' },
  { product: 'Homeowners', coverage: 'jewellery', limit: 2500, kind: 'specific' },
  { product: 'Homeowners', coverage: 'dwelling', limit: 500000, kind: 'general' },
  { product: 'Homeowners', appliesTo: 'all-coverages', limit: 1000000, kind: 'general' },

  // Personal auto: liability, collision and the rental reimbursement cap.
  { product: 'PersonalAuto', coverage: 'liability', limit: 300000, kind: 'general' },
  { product: 'PersonalAuto', coverage: 'collision', limit: 50000, kind: 'general' },
  { product: 'PersonalAuto', coverage: 'rental', limit: 1500, kind: 'specific' },

  // Commercial property: business interruption sits inside the building limit.
  { product: 'CommercialProperty', coverage: 'buildings', limit: 2000000, kind: 'general' },
  { product: 'CommercialProperty', coverage: 'business-interruption', limit: 750000, kind: 'specific' },

  // Workers compensation: medical has no dollar cap by statute; wage replacement is capped.
  { product: 'WorkersComp', coverage: 'medical', limit: 0, kind: 'general', note: 'statutory: no dollar limit' },
  { product: 'WorkersComp', coverage: 'wage-replacement', limit: 120000, kind: 'specific' },
];

module.exports = { CAPS };
