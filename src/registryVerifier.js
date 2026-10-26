'use strict';
// B18: verifying who you are dealing with.
//
// A GSTIN is not checked by looking plausible: the fifteenth character is a checksum over the first fourteen, and a number that fails it is not a
// typo to fix later. A hospital or garage is not verified by being in a list either - it must be in the list, active, and unexpired on the date of
// the claim, because a lapsed registration is exactly the case that hurts.

const { AppError } = require('./appError');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const STATE_CODES = new Set(['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','26','27','29','30','31','32','33','34','35','36','37','38']);

function gstinCheckDigit(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = ALPHABET.indexOf(first14[i]);
    if (value < 0) throw new AppError(422, 'GSTIN contains an invalid character: ' + first14[i]);
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36];
}

/** @returns {{valid: boolean, gstin: string|null, reason: string, stateCode?: string, pan?: string}} */
function validateGstin(input) {
  const gstin = String(input || '').trim().toUpperCase();
  if (!gstin) return { valid: false, gstin: null, reason: 'No GSTIN was given.' };
  if (gstin.length !== 15) return { valid: false, gstin, reason: 'A GSTIN is fifteen characters; this one has ' + gstin.length + '.' };
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    return { valid: false, gstin, reason: 'The GSTIN does not have the expected shape (state, PAN, entity, Z, check digit).' };
  }
  const stateCode = gstin.slice(0, 2);
  if (!STATE_CODES.has(stateCode)) return { valid: false, gstin, reason: 'State code ' + stateCode + ' is not one that issues GSTINs.' };
  const expected = gstinCheckDigit(gstin.slice(0, 14));
  if (expected !== gstin[14]) return { valid: false, gstin, reason: 'The check digit does not match: expected ' + expected + ', found ' + gstin[14] + '.' };
  return { valid: true, gstin, stateCode, pan: gstin.slice(2, 12), reason: 'The GSTIN is well formed and its check digit matches.' };
}

/**
 * @param {{type: 'hospital'|'garage', id: string, registry?: Array, asOf?: string}} input
 */
function verifyRegistration({ type, id, registry = [], asOf } = {}) {
  if (!['hospital', 'garage'].includes(type)) throw new AppError(422, 'type must be hospital or garage');
  if (!id) throw new AppError(422, 'a registration id is required');
  const onDate = asOf ? new Date(asOf) : new Date();
  if (!Number.isFinite(onDate.getTime())) throw new AppError(422, 'asOf is not a date');
  const entry = registry.find((r) => r.id === id && r.type === type);
  if (!entry) return { verified: false, id, type, reason: 'No ' + type + ' with that registration is on the panel.' };
  if (entry.status !== 'active') return { verified: false, id, type, source: entry.source || null, reason: 'The registration is ' + entry.status + '.' };
  const expiry = entry.expiresOn ? new Date(entry.expiresOn) : null;
  if (expiry && expiry < onDate) return { verified: false, id, type, source: entry.source || null, expiresOn: entry.expiresOn, reason: 'The registration expired on ' + entry.expiresOn + '.' };
  return { verified: true, id, type, name: entry.name || null, source: entry.source || null, expiresOn: entry.expiresOn || null, reason: 'The registration is active and unexpired on ' + onDate.toISOString().slice(0, 10) + '.' };
}

module.exports = { validateGstin, verifyRegistration, gstinCheckDigit, STATE_CODES };
