'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSimulation } = require('../src/fraudSimulator');

// Planted patterns that the controls must find. A control nobody attacks is an assumption.

const RING = [
  { id: 'CL-1', policyNumber: 'PA-1', incidentDate: '2026-02-01', amount: 45000, cause: 'accident', contacts: ['9990001111'], plants: ['duplicate'] },
  { id: 'CL-2', policyNumber: 'PA-2', incidentDate: '2026-02-01', amount: 45000, cause: 'accident', contacts: ['9990001111'], plants: ['ring'] },
  { id: 'CL-3', policyNumber: 'PA-3', incidentDate: '2026-03-01', amount: 900000, sumInsured: 500000, garage: 'Backstreet Motors', plants: ['inflation', 'unpaneled'] },
];

test('every planted pattern is caught, and the score says so', () => {
  const result = runSimulation({ claims: RING, panel: ['Rao Motors'] });
  const signals = result.signals.map((s) => s.signal);
  assert.ok(signals.includes('duplicate-loss'));
  assert.ok(signals.includes('shared-contact'));
  assert.ok(signals.includes('reserve-above-sum-insured'));
  assert.ok(signals.includes('garage-not-on-panel'));
  assert.equal(result.score.scenarios >= 3, true);
  assert.equal(result.score.ratio >= 0.99, true, 'all planted patterns detected: ' + JSON.stringify(result.score));
});

test('the ring signal names the shared contact and the policies behind it', () => {
  const result = runSimulation({ claims: RING, panel: ['Rao Motors'] });
  const ring = result.signals.find((s) => s.signal === 'shared-contact');
  assert.equal(ring.contact, '9990001111');
  assert.deepEqual(ring.policies.sort(), ['PA-1', 'PA-2']);
});

test('a clean book raises no signals and scores 1', () => {
  const clean = [{ id: 'CL-9', policyNumber: 'PA-9', incidentDate: '2026-02-02', amount: 1000, cause: 'fire', contacts: ['888'], garage: 'Rao Motors' }];
  const result = runSimulation({ claims: clean, panel: ['Rao Motors'] });
  assert.deepEqual(result.signals, []);
  assert.equal(result.score.ratio, 1);
  assert.equal(result.score.scenarios, 0);
});

test('a single claim with a shared contact is not a ring', () => {
  const single = [{ id: 'CL-1', policyNumber: 'PA-1', contacts: ['1234'] }];
  const result = runSimulation({ claims: single, panel: [] });
  assert.equal(result.signals.some((s) => s.signal === 'shared-contact'), false);
});
