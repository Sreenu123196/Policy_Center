'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectPhotos } = require('../src/photoInspection');

// Before anyone asks a model what it sees, ask whether the picture can be trusted.

const BASE = { incidentDate: '2026-03-01', reportedOn: '2026-03-05', requiredAngles: ['overview', 'close-up'] };

test('a clean set of pictures passes with no findings', () => {
  const result = inspectPhotos({
    ...BASE,
    photos: [
      { name: 'a.jpg', bytes: 'one', capturedAt: '2026-03-02', angle: 'overview' },
      { name: 'b.jpg', bytes: 'two', capturedAt: '2026-03-02', angle: 'close-up' },
    ],
  });
  assert.equal(result.trustworthy, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.missingAngles, []);
  assert.equal(result.verdict, 'inspection complete');
});

test('the same image submitted twice is found by its bytes, not its name', () => {
  const result = inspectPhotos({
    ...BASE,
    photos: [
      { name: 'a.jpg', bytes: 'same', capturedAt: '2026-03-02', angle: 'overview' },
      { name: 'copy.jpg', bytes: 'same', capturedAt: '2026-03-02', angle: 'close-up' },
    ],
  });
  assert.equal(result.findings[0].code, 'duplicate-image');
  assert.match(result.findings[0].detail, /a\.jpg/);
});

test('a timestamp before the loss or after the report is a finding', () => {
  const result = inspectPhotos({
    ...BASE,
    photos: [
      { name: 'early.jpg', bytes: 'x', capturedAt: '2026-02-20', angle: 'overview' },
      { name: 'late.jpg', bytes: 'y', capturedAt: '2026-03-09', angle: 'close-up' },
      { name: 'none.jpg', bytes: 'z' },
    ],
  });
  const codes = result.findings.map((f) => f.code).sort();
  assert.deepEqual(codes, ['after-report', 'before-incident', 'no-capture-time']);
  assert.equal(result.trustworthy, false);
});

test('a file written by an editing tool is flagged, and missing angles are named', () => {
  const result = inspectPhotos({
    ...BASE,
    photos: [{ name: 'edited.jpg', bytes: 'e', capturedAt: '2026-03-02', software: 'Adobe Photoshop 25.0', angle: 'overview' }],
  });
  assert.ok(result.findings.some((f) => f.code === 'edited'));
  assert.deepEqual(result.missingAngles, ['close-up']);
  assert.match(result.verdict, /1 finding\(s\), 1 missing angle/);
});

test('an empty set is not trustworthy, and non-array input is refused', () => {
  const result = inspectPhotos({ ...BASE, photos: [] });
  assert.equal(result.trustworthy, false);
  assert.deepEqual(result.missingAngles, ['overview', 'close-up']);
  assert.throws(() => inspectPhotos({ photos: 'nope' }), /photos must be an array/);
});
