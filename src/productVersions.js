'use strict';
// Product versions.
//
// A product is not a single definition; it is a sequence of versions, each effective from a date. A policy written on
// version 2 of the wording must keep reading version 2 after version 3 is published - otherwise a rate or form change
// silently rewrites policies that were sold under different terms.
//
// Resolution is by date: the version in force on the date asked for. That is the same rule the knowledge module applies to
// wordings, and for the same reason.

const VERSIONS = [
  { product: 'Homeowners', version: 1, effectiveFrom: '2024-01-01', forms: ['HO-3'], note: 'initial' },
  { product: 'Homeowners', version: 2, effectiveFrom: '2025-04-01', forms: ['HO-3', 'HO-5'], note: 'comprehensive form added' },
  { product: 'Homeowners', version: 3, effectiveFrom: '2026-07-01', forms: ['HO-3', 'HO-5', 'HO-8'], note: 'older-home form added' },

  { product: 'PersonalAuto', version: 1, effectiveFrom: '2024-01-01', forms: ['PA-1', 'PA-2'], note: 'initial' },
  { product: 'PersonalAuto', version: 2, effectiveFrom: '2026-01-01', forms: ['PA-1', 'PA-2'], note: 'rating factors revised' },

  { product: 'CommercialProperty', version: 1, effectiveFrom: '2024-01-01', forms: ['CP-1'], note: 'initial' },
  { product: 'WorkersComp', version: 1, effectiveFrom: '2024-01-01', forms: ['WC-1'], note: 'initial' },
];

/**
 * @param {{product: string, asOf: string}} input
 * @returns {{product: string, version: number, effectiveFrom: string, forms: string[], note: string, current: boolean}}
 */
function resolveVersion({ product, asOf }) {
  const date = String(asOf || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('asOf must be a date, YYYY-MM-DD');
  const all = VERSIONS.filter((v) => v.product === product).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (!all.length) throw new Error('No versions are defined for ' + product);
  const applicable = all.filter((v) => v.effectiveFrom <= date);
  if (!applicable.length) throw new Error('No version of ' + product + ' was in force on ' + date);
  const chosen = applicable[applicable.length - 1];
  const latest = all[all.length - 1];
  return { ...chosen, current: chosen.version === latest.version };
}

/** The whole history, for a screen that has to show what changed and when. */
function versionsFor(product) {
  return VERSIONS.filter((v) => v.product === product).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

module.exports = { resolveVersion, versionsFor, VERSIONS };
