'use strict';
// Form inference.
//
// A product does not have one form; it has a family, and the facts choose inside it. A house worth more than the
// comprehensive threshold takes HO-5, an older house may take HO-8, an auto policy with only liability takes PA-1. The
// rules are ordered, the first match wins, and every answer carries the reason it was chosen - a form code without its
// reason cannot be defended to an underwriter.

const RULES = [
  { product: 'Homeowners', form: 'HO-8', when: (facts) => Number(facts.yearBuilt) && Number(facts.yearBuilt) < 1950, reason: 'built before 1950: older-home form' },
  { product: 'Homeowners', form: 'HO-5', when: (facts) => Number(facts.dwellingValue) >= 750000, reason: 'dwelling value at or above 750,000: comprehensive form' },
  { product: 'Homeowners', form: 'HO-3', when: () => true, reason: 'standard homeowners form' },

  { product: 'PersonalAuto', form: 'PA-2', when: (facts) => Boolean(facts.collision) || Boolean(facts.comprehensive), reason: 'physical damage cover included' },
  { product: 'PersonalAuto', form: 'PA-1', when: () => true, reason: 'liability only' },

  { product: 'CommercialProperty', form: 'CP-1', when: () => true, reason: 'commercial property form' },
  { product: 'WorkersComp', form: 'WC-1', when: () => true, reason: 'workers compensation form' },
];

/**
 * @param {{product: string, facts?: object}} input
 * @returns {{form: string, reason: string, considered: Array<{form: string, matched: boolean}>}}
 */
function inferForm({ product, facts = {} }) {
  const rules = RULES.filter((rule) => rule.product === product);
  if (!rules.length) throw new Error('No forms are defined for ' + product);
  const considered = [];
  for (const rule of rules) {
    const matched = Boolean(rule.when(facts));
    considered.push({ form: rule.form, matched });
    if (matched) return { form: rule.form, reason: rule.reason, considered };
  }
  throw new Error('No form matched for ' + product);
}

/** The forms a product can choose between, for a screen. */
function formsFor(product) {
  return RULES.filter((rule) => rule.product === product).map((rule) => rule.form);
}

module.exports = { inferForm, formsFor, RULES };
