'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract, toIncidentDraft, proposeReserve } = require('../src/callScribe');

// A scribe earns trust by citing its evidence and admitting what it did not hear.

const CALL = 'This is the adjuster. The insured reported water damage on 12 March 2026 at the kitchen. The plumber says 45,000 rupees is needed for repairs. Nobody was injured and no third party is involved.';

test('every extracted field carries the words it came from', () => {
  const result = extract(CALL);
  assert.equal(result.fields.cause.value, 'water damage');
  assert.match(result.fields.incidentDate.value, /12 March 2026/);
  assert.equal(result.fields.reserveAmount.value, 45000);
  assert.equal(result.fields.property.value, 'kitchen');
  for (const key of Object.keys(result.fields)) {
    assert.ok(CALL.includes(result.fields[key].evidence), 'evidence for ' + key + ' appears in the transcript');
  }
});

test('a field that was never stated is reported missing, not guessed', () => {
  const result = extract('The customer called about the roof. No amounts discussed.');
  assert.equal(result.fields.reserveAmount, undefined);
  assert.ok(result.missing.some((m) => m.field === 'reserveAmount'));
  assert.equal(result.complete, false);
});

test('no amount means no reserve proposal, and the reason says so', () => {
  const result = extract('The customer called about the roof.');
  const proposal = proposeReserve(result);
  assert.equal(proposal.proposed, false);
  assert.match(proposal.reason, /No amount was stated/);
});

test('an amount with an Indian format is read as a number', () => {
  const result = extract('Repair estimate is Rs. 1,25,000 for the garage.');
  assert.equal(result.fields.reserveAmount.value, 125000);
});

test('injury and third party are recorded when stated, and missing when not', () => {
  const injured = extract('A pedestrian was injured and taken to hospital after the collision.');
  assert.equal(injured.fields.injuries.value, true);
  assert.equal(injured.fields.thirdParty.value, true);
  assert.equal(injured.fields.injuries.denied, false);
  const quiet = extract('Fire in the godown on 2026-02-01, reserve 90000.');
  assert.equal(quiet.fields.injuries, undefined, 'silence is not a denial of injury');
  assert.ok(quiet.missing.some((m) => m.field === 'injuries'));
});

test('the incident draft contains only what was present', () => {
  const result = extract(CALL);
  const draft = toIncidentDraft(result);
  assert.equal(draft.cause, 'water damage');
  assert.equal(draft.property, 'kitchen');
  assert.equal(draft.injuries, false, 'the call said nobody was injured, which is a denial, not a gap');
  assert.equal(draft.thirdParty, false, 'and no third party was involved');
});

test('an empty transcript produces an empty extraction rather than an error', () => {
  const result = extract('   ');
  assert.deepEqual(result.fields, {});
  assert.equal(result.complete, false);
  assert.ok(result.missing.length >= 3);
});
