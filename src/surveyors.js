'use strict';
// Surveyors: the independent inspection of a loss.
//
// A surveyor is appointed when the damage needs eyes on it - a large fire, a disputed cause, a vehicle written off. The
// appointment, the visit, the findings and the recommendation are recorded against the claim; the recommendation is advice,
// never a decision, and the claim stage stays where the claims team puts it.
//
// Access is the application's: pc.policy decides whether the person may see the claim at all.

const { AppError } = require('./appError');

const RECOMMENDATIONS = ['pay', 'repair', 'total-loss', 'decline', 'further-investigation'];

function claimFor(pc, user, claimNumber) {
  const claim = (pc.db.claims || []).find((c) => c.claimNumber === claimNumber);
  let allowed = false;
  if (claim) { try { pc.policy(claim.policyId, user); allowed = true; } catch { allowed = false; } }
  if (!claim || !allowed) throw new AppError(404, 'Claim not found');
  return claim;
}

function createSurveyors(pc) {
  function list(user, claimNumber) {
    const claim = claimFor(pc, user, claimNumber);
    return { claimNumber: claim.claimNumber, surveys: claim.surveys || [] };
  }

  function appoint(user, claimNumber, input = {}) {
    const claim = claimFor(pc, user, claimNumber);
    const firm = String(input.firm || '').trim();
    if (!firm) throw new AppError(422, 'A surveyor firm is required');
    const recommendation = input.recommendation ? String(input.recommendation).toLowerCase() : null;
    if (recommendation && !RECOMMENDATIONS.includes(recommendation)) {
      throw new AppError(422, 'recommendation must be one of ' + RECOMMENDATIONS.join(', '));
    }
    claim.surveys = claim.surveys || [];
    const survey = {
      id: 'SV-' + claim.claimNumber + '-' + (claim.surveys.length + 1),
      firm,
      surveyor: input.surveyor ? String(input.surveyor) : null,
      visitedOn: input.visitedOn || null,
      findings: input.findings ? String(input.findings) : null,
      recommendation,
      appointedBy: user && user.id,
      appointedAt: new Date().toISOString(),
    };
    claim.surveys.push(survey);
    return survey;
  }

  return { list, appoint, RECOMMENDATIONS };
}

module.exports = { createSurveyors, RECOMMENDATIONS };
