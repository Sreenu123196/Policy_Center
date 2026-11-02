'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { triage } = require('../src/claimsTriage');

// A sequence with a clock: every step named, every refusal stopping the run.

const CLAIM = { claimNumber: 'CL-1', policyNumber: 'HO-1', incidentDate: '2026-03-01', cause: 'water', amount: 60000 };

test('a clean claim runs every step in order and is triaged', () => {
  const result = triage({ claim: CLAIM, sumInsured: 500000 });
  assert.deepEqual(result.steps.map((s) => s.name), ['validate', 'duplicate', 'coverage', 'severity', 'assign', 'reserve']);
  assert.equal(result.outcome, 'triaged');
  assert.equal(result.severity, 'medium');
  assert.equal(result.assignee, 'adjuster');
  assert.equal(result.reserve, 60000);
  assert.equal(result.withinThreeMinutes, true);
});

test('a missing field stops the run at validation, and later steps are skipped', () => {
  const result = triage({ claim: { claimNumber: 'CL-2', policyNumber: 'HO-1', incidentDate: '2026-03-01', cause: 'fire' } });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.blockedBy, 'validate');
  assert.equal(result.steps[0].status, 'refused');
  assert.ok(result.steps.slice(1).every((s) => s.status === 'skipped'));
});

test('a duplicate loss is refused before coverage and severity are considered', () => {
  const other = { claimNumber: 'CL-9', incidentDate: CLAIM.incidentDate, cause: 'water', amount: 60000 };
  const result = triage({ claim: CLAIM, openClaims: [other], sumInsured: 500000 });
  assert.equal(result.blockedBy, 'duplicate');
  assert.equal(result.severity, null);
});

test('a reserve above the sum insured is refused at coverage', () => {
  const result = triage({ claim: CLAIM, sumInsured: 10000 });
  assert.equal(result.blockedBy, 'coverage');
  assert.match(result.steps[2].detail, /exceeds the sum insured/);
});

test('injuries or a large loss route to a senior adjuster, and a small one to the general queue', () => {
  assert.equal(triage({ claim: { ...CLAIM, injuries: true } }).assignee, 'senior-adjuster');
  assert.equal(triage({ claim: { ...CLAIM, amount: 300000 } }).assignee, 'senior-adjuster');
  assert.equal(triage({ claim: { ...CLAIM, amount: 1000 } }).assignee, 'general-queue');
});

test('every step carries a duration, and the whole run is measured', () => {
  let clock = 0;
  const result = triage({ claim: CLAIM, now: () => (clock += 40) });
  assert.ok(result.steps.every((s) => typeof s.ms === 'number'));
  assert.ok(result.totalMs > 0);
  assert.equal(result.withinThreeMinutes, true);
});
