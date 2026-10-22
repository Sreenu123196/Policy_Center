'use strict';
// Which product a question is about, when it says so. Four wordings share the vocabulary of insurance ("we cover",
// "deductible", "the schedule"), so without this the top-8 fills with the wrong product's clauses and the model either
// answers from them or refuses.
//
// A question that names no product is not narrowed: guessing would hide the right clause.

const SIGNALS = {
  Homeowners: ['home', 'house', 'dwelling', 'jewellery', 'jewelry', 'garage', 'homeowners', 'household', 'furs', 'watches'],
  PersonalAuto: ['car', 'auto', 'vehicle', 'collision', 'comprehensive', 'motor', 'accident', 'uninsured', 'driver'],
  CommercialProperty: ['commercial', 'building', 'buildings', 'business interruption', 'warehouse', 'premises', 'office', 'stock'],
  WorkersComp: ['worker', 'workers', 'employee', 'work-related', 'workplace', 'injury', 'wage', 'light duties', 'occupational'],
};

/** @returns {string[]} product names mentioned by the question, possibly empty. */
function detectProducts(question) {
  const text = String(question || '').toLowerCase();
  const found = [];
  for (const [product, words] of Object.entries(SIGNALS)) {
    if (words.some((word) => text.includes(word))) found.push(product);
  }
  return found;
}

module.exports = { detectProducts, SIGNALS };
