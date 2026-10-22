'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSurveyors, RECOMMENDATIONS } = require('../src/surveyors');

function fakePc({ allowed = true } = {}) {
  return {
    db: { claims: [{ claimNumber: 'CL-1', policyId: 'p1', status: 'Open' }] },
    policy: () => { if (!allowed) throw new Error('not found'); return { policyNumber: 'PA-1' }; },
  };
}

test('a surveyor is appointed against the claim with a firm and an optional recommendation', () => {
  const pc = fakePc();
  const surveyors = createSurveyors(pc);
  const survey = surveyors.appoint({ id: 'u1' }, 'CL-1', { firm: 'Rao Loss Assessors', surveyor: 'R. Rao', visitedOn: '2026-10-20', recommendation: 'repair' });
  assert.equal(survey.firm, 'Rao Loss Assessors');
  assert.equal(survey.recommendation, 'repair');
  assert.match(survey.id, /^SV-CL-1-1$/);
  assert.equal(surveyors.list({ id: 'u1' }, 'CL-1').surveys.length, 1);
});

test('the recommendation is advice, so it is a closed set and never a stage change', () => {
  const pc = fakePc();
  const surveyors = createSurveyors(pc);
  const claim = pc.db.claims[0];
  surveyors.appoint({ id: 'u1' }, 'CL-1', { firm: 'X', recommendation: 'total-loss' });
  assert.equal(claim.status, 'Open', 'the claim stage is untouched by a recommendation');
  assert.throws(() => surveyors.appoint({ id: 'u1' }, 'CL-1', { firm: 'X', recommendation: 'pay-nothing' }), /recommendation must be one of/);
  assert.deepEqual(RECOMMENDATIONS, ['pay', 'repair', 'total-loss', 'decline', 'further-investigation']);
});

test('a missing firm is refused, and a claim the person may not see looks missing', () => {
  const pc = fakePc();
  const surveyors = createSurveyors(pc);
  assert.throws(() => surveyors.appoint({ id: 'u1' }, 'CL-1', {}), /surveyor firm is required/);
  const hidden = createSurveyors(fakePc({ allowed: false }));
  assert.throws(() => hidden.list({ id: 'u1' }, 'CL-1'), /Claim not found/);
});
