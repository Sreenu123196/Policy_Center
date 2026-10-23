'use strict';
// Caps and preemption.
//
// A product has coverages, each with a requested limit. A cap narrows that limit - a jewellery sub-limit inside a contents
// limit, a per-claim cap on a per-policy cover. When two caps could apply, the more specific one wins ("sub-limit for
// jewellery" beats "contents limit") and, between equally specific caps, the tighter one wins. That is what preemption
// means here: the specific rule displaces the general one rather than stacking on it.
//
// Every resolution returns the trail - which caps applied and which were displaced - because an answer of "2,500" is not
// auditable without it.

const SPECIFICITY = { specific: 2, general: 1 };

/**
 * @param {object} input
 * @param {string} input.product e.g. 'Homeowners'
 * @param {string} input.coverage e.g. 'jewellery'
 * @param {number} input.requested the limit asked for
 * @param {Array<{product: string, coverage?: string, appliesTo?: string, limit: number, kind?: 'specific'|'general'}>} input.caps
 * @returns {{limit: number, capped: boolean, applied: string|null, displaced: string[], reason: string}}
 */
function resolveLimit({ product, coverage, requested, caps = [] }) {
  const amount = Number(requested);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('requested must be a non-negative number');

  const candidates = caps.filter((cap) => {
    const sameProduct = !cap.product || cap.product === product;
    if (!sameProduct) return false;
    if (cap.appliesTo) return cap.appliesTo === coverage || cap.appliesTo === 'all-coverages';
    return cap.coverage === coverage || cap.coverage === 'all';
  });
  if (!candidates.length) {
    return { limit: amount, capped: false, applied: null, displaced: [], reason: 'no cap applies' };
  }

  const ranked = candidates.slice().sort((a, b) => {
    const byKind = (SPECIFICITY[b.kind || 'general'] || 0) - (SPECIFICITY[a.kind || 'general'] || 0);
    if (byKind !== 0) return byKind;
    return a.limit - b.limit;
  });
  const winner = ranked[0];
  const label = (cap) => (cap.coverage || cap.appliesTo || 'all') + ' @ ' + cap.limit;
  const limit = Math.min(amount, winner.limit);
  return {
    limit,
    capped: limit < amount,
    applied: label(winner),
    displaced: ranked.slice(1).map(label),
    reason: limit < amount ? 'reduced to the ' + (winner.kind || 'general') + ' cap' : 'within the cap',
  };
}

/** The caps that could apply to a product, for a screen or a debug answer. */
function capsFor(product, caps = []) {
  return caps.filter((cap) => !cap.product || cap.product === product);
}

module.exports = { resolveLimit, capsFor, SPECIFICITY };
