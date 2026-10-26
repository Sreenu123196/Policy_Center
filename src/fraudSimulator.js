'use strict';
// B19: synthetic fraud, run against the controls that exist.
//
// The simulator builds the patterns a ring actually uses - the same loss reported twice, several policyholders sharing a phone, a reserve above the
// sum insured, work done by a garage that is not on the panel - and then asks the controls to catch them. The score is the point: a control nobody
// has attacked is an assumption, and this turns it into a number that can go down as well as up.

const { AppError } = require('./appError');

function detectDuplicates(claims = []) {
  const bySignature = new Map();
  for (const claim of claims) {
    if (!claim.incidentDate || claim.amount === undefined) continue;
    const key = claim.incidentDate + '|' + Number(claim.amount).toFixed(2) + '|' + (claim.cause || '').toLowerCase();
    if (!bySignature.has(key)) bySignature.set(key, []);
    bySignature.get(key).push(claim.id || claim.claimNumber);
  }
  return [...bySignature.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ signal: 'duplicate-loss', key, claims: ids }));
}

function detectRings(claims = [], { minShared = 2 } = {}) {
  const byContact = new Map();
  for (const claim of claims) {
    for (const contact of claim.contacts || []) {
      const key = String(contact).toLowerCase();
      if (!byContact.has(key)) byContact.set(key, new Set());
      byContact.get(key).add(claim.policyNumber || claim.id || claim.claimNumber);
    }
  }
  return [...byContact.entries()]
    .filter(([, policies]) => policies.size >= minShared)
    .map(([contact, policies]) => ({ signal: 'shared-contact', contact, policies: [...policies] }));
}

function detectInflation(claims = []) {
  return claims
    .filter((claim) => claim.amount !== undefined && claim.sumInsured !== undefined && Number(claim.amount) > Number(claim.sumInsured))
    .map((claim) => ({ signal: 'reserve-above-sum-insured', claim: claim.id || claim.claimNumber, amount: Number(claim.amount), sumInsured: Number(claim.sumInsured) }));
}

function detectUnpaneled(claims = [], { panel = [] } = {}) {
  const known = new Set(panel);
  return claims
    .filter((claim) => claim.garage && !known.has(claim.garage))
    .map((claim) => ({ signal: 'garage-not-on-panel', claim: claim.id || claim.claimNumber, garage: claim.garage }));
}

/** @returns {{signals: Array, score: {scenarios: number, detected: number, ratio: number}}} */
function runSimulation({ claims = [], panel = [] } = {}) {
  if (!Array.isArray(claims)) throw new AppError(422, 'claims must be an array');
  const signals = [
    ...detectDuplicates(claims),
    ...detectRings(claims),
    ...detectInflation(claims),
    ...detectUnpaneled(claims, { panel }),
  ];
  // Every planted pattern counts as one scenario; a scenario is detected when any signal names it.
  const planted = new Set();
  for (const claim of claims) {
    for (const pattern of claim.plants || []) planted.add(pattern);
  }
  const detectedPatterns = new Set();
  for (const signal of signals) {
    for (const claim of claims) {
      if (!(claim.plants || []).length) continue;
      const touched = signal.claims ? signal.claims.includes(claim.id || claim.claimNumber)
        : signal.claim === (claim.id || claim.claimNumber);
      if (touched) for (const pattern of claim.plants) detectedPatterns.add(pattern);
    }
  }
  const detected = [...planted].filter((p) => detectedPatterns.has(p)).length;
  return {
    signals,
    score: { scenarios: planted.size, detected, ratio: planted.size === 0 ? 1 : Math.round((detected / planted.size) * 100) / 100 },
  };
}

module.exports = { runSimulation, detectDuplicates, detectRings, detectInflation, detectUnpaneled };
