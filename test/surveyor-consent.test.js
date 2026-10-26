'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireDualConsent } = require('../src/surveyorConsent');

// One consent is not consent. This gate exists so that a field recording cannot enter the system on the strength of one signature.

const BASE = { recordingId: 'REC-1', recordedAt: '2026-03-01T09:00:00Z', uploadedAt: '2026-03-01T12:00:00Z' };

test('two different parties consenting before upload is accepted', () => {
  const result = requireDualConsent({ ...BASE, consents: [
    { partyId: 'surveyor-1', role: 'surveyor', consentedAt: '2026-03-01T09:05:00Z' },
    { partyId: 'insured-1', role: 'insured', consentedAt: '2026-03-01T09:06:00Z' },
  ] });
  assert.equal(result.accepted, true);
  assert.equal(result.consented, true);
  assert.deepEqual(result.parties.sort(), ['insured-1', 'surveyor-1']);
  assert.match(result.reason, /Both parties consented/);
});

test('one party is not enough, and the reason says how many consented', () => {
  const result = requireDualConsent({ ...BASE, consents: [{ partyId: 'surveyor-1', consentedAt: '2026-03-01T09:05:00Z' }] });
  assert.equal(result.accepted, false);
  assert.equal(result.consented, false);
  assert.ok(result.findings.some((f) => f.code === 'missing-consent'));
  assert.match(result.reason, /1 consented/);
});

test('the same person consenting twice is one consent, not two', () => {
  const result = requireDualConsent({ ...BASE, consents: [
    { partyId: 'surveyor-1', consentedAt: '2026-03-01T09:05:00Z' },
    { partyId: 'surveyor-1', consentedAt: '2026-03-01T09:07:00Z' },
  ] });
  assert.equal(result.accepted, false);
  assert.ok(result.findings.some((f) => f.code === 'duplicate-consent'));
  assert.ok(result.findings.some((f) => f.code === 'missing-consent'));
});

test('a consent given after the upload does not rescue the recording', () => {
  const result = requireDualConsent({ ...BASE, consents: [
    { partyId: 'surveyor-1', consentedAt: '2026-03-01T09:05:00Z' },
    { partyId: 'insured-1', consentedAt: '2026-03-01T15:00:00Z' },
  ] });
  assert.equal(result.accepted, false);
  assert.equal(result.consented, false);
  assert.ok(result.findings.some((f) => f.code === 'consent-after-upload'));
});

test('an undated or unidentified consent is a finding, and a recording id is required', () => {
  const undated = requireDualConsent({ ...BASE, consents: [{ partyId: 'a' }, { partyId: 'b', consentedAt: '2026-03-01T09:00:00Z' }] });
  assert.ok(undated.findings.some((f) => f.code === 'undated-consent'));
  const anonymous = requireDualConsent({ ...BASE, consents: [{ consentedAt: '2026-03-01T09:00:00Z' }] });
  assert.ok(anonymous.findings.some((f) => f.code === 'unidentified-consent'));
  assert.throws(() => requireDualConsent({}), /recording id is required/);
});
