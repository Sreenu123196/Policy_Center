'use strict';
// Litigation: a claim that is heading to court, or threatening to.
//
// Recorded as one object on the claim - the stage, the note, who authorised it and when - rather than as a set of events,
// because the useful question is "where is this now", not "what happened first". The stage is a closed set and the
// authorisation is required: nobody should be able to put a claim into litigation without saying who decided that.
//
// Access is the application's: pc.policy decides whether the person may see the claim at all.

const { AppError } = require('./appError');

const STAGES = ['notified', 'defended', 'settled', 'withdrawn'];

function claimFor(pc, user, claimNumber) {
  const claim = (pc.db.claims || []).find((c) => c.claimNumber === claimNumber);
  let allowed = false;
  if (claim) { try { pc.policy(claim.policyId, user); allowed = true; } catch { allowed = false; } }
  if (!claim || !allowed) throw new AppError(404, 'Claim not found');
  return claim;
}

function createLitigation(pc) {
  function get(user, claimNumber) {
    const claim = claimFor(pc, user, claimNumber);
    return { claimNumber: claim.claimNumber, litigation: claim.litigation || null };
  }

  function record(user, claimNumber, input = {}) {
    const claim = claimFor(pc, user, claimNumber);
    const stage = String(input.stage || '').toLowerCase();
    if (!STAGES.includes(stage)) throw new AppError(422, 'stage must be one of ' + STAGES.join(', '));
    const authorisedBy = String(input.authorisedBy || '').trim();
    if (!claim.litigation && !authorisedBy) throw new AppError(422, 'authorisedBy is required when litigation is first recorded');
    claim.litigation = {
      stage,
      note: input.note ? String(input.note) : (claim.litigation ? claim.litigation.note : null),
      authorisedBy: authorisedBy || claim.litigation.authorisedBy,
      openedAt: claim.litigation ? claim.litigation.openedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: user && user.id,
    };
    return { claimNumber: claim.claimNumber, litigation: claim.litigation };
  }

  return { get, record, STAGES };
}

module.exports = { createLitigation, STAGES };
