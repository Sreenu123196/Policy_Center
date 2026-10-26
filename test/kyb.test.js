'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { enrich } = require('../src/kyb');

// Enrichment must be attributable. A fact without a source is a rumour, and a conflict is a finding.

const GSTIN = '27AAPFU0939F1ZV';
const MCA = { name: 'mca', provides: { legalName: 'Apex Logistics Pvt Ltd', sector: 'transport', incorporatedOn: '2025-09-01', directors: ['A Rao', 'B Rao'], registeredAddress: 'Pune' } };

test('every field keeps the source that said it, and a complete file is ready', () => {
  const result = enrich({ gstin: GSTIN, sources: [MCA] });
  assert.equal(result.facts.legalName.value, 'Apex Logistics Pvt Ltd');
  assert.equal(result.facts.legalName.source, 'mca');
  assert.deepEqual(result.missing, []);
  assert.equal(result.ready, true);
  assert.equal(result.verdict, 'complete');
});

test('two sources disagreeing is recorded, not resolved silently', () => {
  const other = { name: 'credit-bureau', provides: { legalName: 'Apex Logistics Limited' } };
  const result = enrich({ gstin: GSTIN, sources: [MCA, other] });
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].field, 'legalName');
  assert.deepEqual(result.conflicts[0].sources, ['mca', 'credit-bureau']);
  assert.equal(result.ready, false);
  assert.match(result.verdict, /1 conflict/);
});

test('missing fields are named, and the file is not ready', () => {
  const result = enrich({ gstin: GSTIN, sources: [{ name: 'gst', provides: { legalName: 'Apex Logistics Pvt Ltd' } }] });
  assert.ok(result.missing.includes('directors'));
  assert.equal(result.ready, false);
  assert.match(result.verdict, /gap/);
});

test('risk flags come from readable rules: recent incorporation, hazardous sector, inactive GST', () => {
  const result = enrich({
    gstin: GSTIN, asOf: '2026-03-01',
    sources: [{ name: 'gst', provides: { ...MCA.provides, gstStatus: 'cancelled' } }],
  });
  const codes = result.flags.map((f) => f.code).sort();
  assert.deepEqual(codes, ['gst-not-active', 'hazardous-sector', 'recently-incorporated']);
});

test('a source without a name, or an invalid GSTIN, is refused', () => {
  assert.throws(() => enrich({ gstin: GSTIN, sources: [{ provides: { legalName: 'x' } }] }), /needs a name/);
  assert.throws(() => enrich({ gstin: '27AAPFU0939F1ZX', sources: [MCA] }), /check digit/);
  assert.throws(() => enrich({ sources: [MCA] }), /GSTIN is required/);
});
