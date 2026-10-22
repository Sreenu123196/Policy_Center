'use strict';
// Claim recoveries: money coming back after a claim has been paid - subrogation (recovered from a third party) and
// salvage (disposal of the damaged property). Both reduce the net cost of a claim, and both must be recorded against it
// rather than netted silently off a payment.
//
// Access is the application's: pc.policy() decides whether the person may see the claim at all.

const { AppError } = require('./appError');

const SOURCES = ['subrogation', 'salvage'];

function claimFor(pc, user, claimNumber) {
  const claim = (pc.db.claims || []).find((c) => c.claimNumber === claimNumber);
  let policy = null;
  if (claim) {
    try { policy = pc.policy(claim.policyId, user); } catch { policy = null; }
  }
  // A claim someone may not see looks like a claim that does not exist - the same rule the assistant's tools follow.
  if (!claim || !policy) throw new AppError(404, 'Claim not found');
  return claim;
}

function createRecoveries(pc) {
  function list(user, claimNumber) {
    const claim = claimFor(pc, user, claimNumber);
    return { claimNumber: claim.claimNumber, recoveries: claim.recoveries || [] };
  }

  function add(user, claimNumber, input = {}) {
    const claim = claimFor(pc, user, claimNumber);
    const source = String(input.source || '').toLowerCase();
    if (!SOURCES.includes(source)) throw new AppError(422, 'source must be one of ' + SOURCES.join(', '));
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new AppError(422, 'A positive amount is required');
    claim.recoveries = claim.recoveries || [];
    const recovery = {
      id: 'RC-' + (claim.claimNumber + '-' + (claim.recoveries.length + 1)),
      source,
      amount,
      receivedOn: input.receivedOn || new Date().toISOString().slice(0, 10),
      reference: input.reference ? String(input.reference) : null,
      recordedBy: user && user.id,
      recordedAt: new Date().toISOString(),
    };
    claim.recoveries.push(recovery);
    return recovery;
  }

  function total(claimNumber) {
    const claim = (pc.db.claims || []).find((c) => c.claimNumber === claimNumber);
    return (claim && claim.recoveries ? claim.recoveries : []).reduce((sum, r) => sum + r.amount, 0);
  }

  return { list, add, total, SOURCES };
}

module.exports = { createRecoveries, SOURCES };
