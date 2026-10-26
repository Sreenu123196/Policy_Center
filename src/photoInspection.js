'use strict';
// B14 (deterministic core): inspecting claim photographs without a model.
//
// A model that describes damage is useful; what an assessor needs first is whether the photograph can be trusted at all. These checks need no vendor:
// the same picture submitted twice, a capture date that precedes the incident or postdates the report, a file stamped by an editing tool, metadata
// stripped, or required angles missing.

const crypto = require('node:crypto');
const { AppError } = require('./appError');

const EDITORS = /photoshop|gimp|lightroom|snapseed|picsart|canva|affinity/i;

function hashOf(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {{photos?: Array<{name: string, bytes?: any, capturedAt?: string, software?: string, angle?: string}>, incidentDate?: string, reportedOn?: string, requiredAngles?: string[]}} input
 */
function inspectPhotos({ photos = [], incidentDate, reportedOn, requiredAngles = [] } = {}) {
  if (!Array.isArray(photos)) throw new AppError(422, 'photos must be an array');
  const incident = incidentDate ? Date.parse(incidentDate) : null;
  const reported = reportedOn ? Date.parse(reportedOn) : null;
  const seen = new Map();
  const findings = [];

  for (const [index, photo] of photos.entries()) {
    const label = photo.name || 'photo ' + (index + 1);
    if (photo.bytes) {
      const hash = hashOf(photo.bytes);
      if (seen.has(hash)) findings.push({ photo: label, code: 'duplicate-image', detail: 'The same image as ' + seen.get(hash) + '.' });
      else seen.set(hash, label);
    }
    if (!photo.capturedAt) {
      findings.push({ photo: label, code: 'no-capture-time', detail: 'No capture time; the picture cannot be tied to the loss.' });
    } else {
      const captured = Date.parse(photo.capturedAt);
      if (!Number.isFinite(captured)) findings.push({ photo: label, code: 'unreadable-capture-time', detail: 'The capture time is not a date.' });
      else {
        if (incident !== null && captured < incident) findings.push({ photo: label, code: 'before-incident', detail: 'Captured ' + photo.capturedAt + ', before the loss on ' + incidentDate + '.' });
        if (reported !== null && captured > reported) findings.push({ photo: label, code: 'after-report', detail: 'Captured ' + photo.capturedAt + ', after the claim was reported on ' + reportedOn + '.' });
      }
    }
    if (photo.software && EDITORS.test(photo.software)) {
      findings.push({ photo: label, code: 'edited', detail: 'Written by ' + photo.software + '; the original may differ.' });
    }
  }

  const angles = new Set(photos.map((p) => (p.angle || '').toLowerCase()).filter(Boolean));
  const missingAngles = requiredAngles.filter((a) => !angles.has(a.toLowerCase()));

  return {
    photos: photos.length,
    findings,
    missingAngles,
    trustworthy: findings.length === 0 && missingAngles.length === 0,
    verdict: findings.length === 0 && missingAngles.length === 0 ? 'inspection complete' : 'review: ' + findings.length + ' finding(s), ' + missingAngles.length + ' missing angle(s)',
  };
}

module.exports = { inspectPhotos, hashOf, EDITORS };
