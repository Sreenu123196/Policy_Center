'use strict';
// B23 (repository side): the consent gate in front of a field surveyor's recording.
//
// The recorder is hardware and lives with the surveyor; what the application can enforce is that no recording is accepted for processing unless both
// parties consented, each separately, before the recording was uploaded. The same person consenting twice is one consent, and a recording that arrives
// before its consents is refused rather than back-filled.

const { AppError } = require('./appError');

const REQUIRED_PARTIES = 2;

/**
 * @param {{recordingId: string, recordedAt?: string, uploadedAt?: string, consents?: Array<{partyId: string, role?: string, consentedAt: string}>}} input
 */
function requireDualConsent({ recordingId, recordedAt, uploadedAt, consents = [] } = {}) {
  if (!recordingId) throw new AppError(422, 'a recording id is required');
  if (!Array.isArray(consents)) throw new AppError(422, 'consents must be a list');

  const findings = [];
  const seen = new Map();
  for (const consent of consents) {
    if (!consent || !consent.partyId) { findings.push({ code: 'unidentified-consent', detail: 'A consent arrived without saying who gave it.' }); continue; }
    if (!consent.consentedAt || !Number.isFinite(Date.parse(consent.consentedAt))) {
      findings.push({ code: 'undated-consent', detail: 'The consent from ' + consent.partyId + ' has no usable time.' });
      continue;
    }
    if (seen.has(consent.partyId)) {
      findings.push({ code: 'duplicate-consent', detail: consent.partyId + ' consented twice; that is one party, not two.' });
      continue;
    }
    seen.set(consent.partyId, consent);
  }

  if (seen.size < REQUIRED_PARTIES) {
    findings.push({ code: 'missing-consent', detail: 'A recording needs both parties; ' + seen.size + ' consented.' });
  }

  // Consent after the upload is not consent to the recording - it is paperwork completed afterwards.
  const upload = uploadedAt ? Date.parse(uploadedAt) : null;
  if (upload !== null) {
    for (const [partyId, consent] of seen) {
      if (Date.parse(consent.consentedAt) > upload) {
        findings.push({ code: 'consent-after-upload', detail: partyId + ' consented after the recording was uploaded.' });
      }
    }
  }
  if (recordedAt && Number.isFinite(Date.parse(recordedAt))) {
    for (const [partyId, consent] of seen) {
      if (Date.parse(consent.consentedAt) < Date.parse(recordedAt)) {
        findings.push({ code: 'consent-before-recording', detail: partyId + ' consented before the event was recorded, which needs checking.' });
      }
    }
  }

  return {
    recordingId,
    parties: [...seen.keys()],
    consented: seen.size >= REQUIRED_PARTIES && !findings.some((f) => f.code === 'missing-consent' || f.code === 'consent-after-upload' || f.code === 'duplicate-consent'),
    findings,
    accepted: findings.length === 0,
    reason: findings.length === 0 ? 'Both parties consented before upload; the recording may be processed.' : findings.map((f) => f.detail).join(' '),
  };
}

module.exports = { requireDualConsent, REQUIRED_PARTIES };
