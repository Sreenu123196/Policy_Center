'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseCodeMixed, auditCall, RETENTION_DAYS } = require('../src/voiceAudit');

// Tenglish is not broken English; it is how the call actually sounds. And a recording without consent is not a record, it is a liability.

test('a Tenglish sentence is mapped to English and reported as mixed', () => {
  const result = normaliseCodeMixed('claim details cheppandi, agni jarigindi, gayam kaavalani');
  assert.match(result.normalised, /tell/);
  assert.match(result.normalised, /fire/);
  assert.match(result.normalised, /injury/);
  assert.equal(result.mixed, true);
  assert.equal(result.mappedWords >= 3, true);
  assert.equal(result.mixedRatio > 0, true);
});

test('a monolingual sentence is not reported as mixed', () => {
  const english = normaliseCodeMixed('the claim happened last night');
  assert.equal(english.mixed, false);
  const telugu = normaliseCodeMixed('నీరు చేరింది');
  assert.equal(telugu.mixed, false);
  assert.deepEqual(telugu.languages, ['indic']);
});

test('a compliant outbound call keeps a retention date and masks the caller', () => {
  const record = auditCall({
    callId: 'C1', direction: 'outbound', to: '9990001111', from: '1600123456', startedAt: '2026-03-01T10:00:00Z', endedAt: '2026-03-01T10:04:00Z',
    consent: true, language: 'te', recordingUrl: 'https://example/rec.mp3',
  });
  assert.equal(record.compliant, true);
  assert.equal(record.durationSeconds, 240);
  assert.equal(record.to, '******1111');
  assert.match(record.retentionUntil, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(record.recordingUrl, 'https://example/rec.mp3');
});

test('no consent means no recording kept and no retention date', () => {
  const record = auditCall({ callId: 'C2', startedAt: '2026-03-01T10:00:00Z', consent: false, recordingUrl: 'https://example/rec.mp3' });
  assert.equal(record.compliant, false);
  assert.equal(record.recordingUrl, null, 'the recording is not retained');
  assert.equal(record.retentionUntil, null);
  assert.ok(record.findings.some((f) => f.code === 'no-consent'));
});

test('an outbound call not from the 1600 series is flagged, an inbound one is not', () => {
  const outbound = auditCall({ callId: 'C3', direction: 'outbound', from: '9876543210', startedAt: '2026-03-01T10:00:00Z', consent: true });
  assert.ok(outbound.findings.some((f) => f.code === 'not-1600-series'));
  const inbound = auditCall({ callId: 'C4', direction: 'inbound', from: '9876543210', startedAt: '2026-03-01T10:00:00Z', consent: true });
  assert.equal(inbound.compliant, true, 'a customer may call from any number');
  assert.equal(RETENTION_DAYS, 180);
});

test('a call id and a readable start time are required', () => {
  assert.throws(() => auditCall({}), /call id is required/);
  assert.throws(() => auditCall({ callId: 'C5' }), /started time is required/);
  assert.throws(() => auditCall({ callId: 'C6', startedAt: 'yesterday' }), /not a date/);
});
