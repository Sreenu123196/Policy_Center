'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecoveries, SOURCES } = require('../src/claimRecoveries');

// Recoveries are money: subrogation and salvage, recorded against a claim, never netted off a payment silently.

function fakePc({ allowed = true } = {}) {
  return {
    db: { claims: [{ claimNumber: 'CL-1', policyId: 'p1', status: 'Paid' }] },
    policy: () => {
      if (!allowed) throw new Error('not found');
      return { policyNumber: 'PA-0000001' };
    },
  };
}

test('a subrogation recovery is recorded against the claim', () => {
  const pc = fakePc();
  const recoveries = createRecoveries(pc);
  const added = recoveries.add({ id: 'u1' }, 'CL-1', { source: 'subrogation', amount: 5000, reference: 'REF-9' });
  assert.equal(added.source, 'subrogation');
  assert.equal(added.amount, 5000);
  assert.match(added.id, /^RC-CL-1-1$/);
  assert.equal(recoveries.list({ id: 'u1' }, 'CL-1').recoveries.length, 1);
  assert.equal(recoveries.total('CL-1'), 5000);
});

test('salvage adds to the total rather than replacing it', () => {
  const pc = fakePc();
  const recoveries = createRecoveries(pc);
  recoveries.add({ id: 'u1' }, 'CL-1', { source: 'subrogation', amount: 5000 });
  recoveries.add({ id: 'u1' }, 'CL-1', { source: 'salvage', amount: 1200 });
  assert.equal(recoveries.total('CL-1'), 6200);
  assert.equal(recoveries.list({ id: 'u1' }, 'CL-1').recoveries.length, 2);
});

test('a bad source, a missing amount and a negative amount are refused', () => {
  const pc = fakePc();
  const recoveries = createRecoveries(pc);
  assert.throws(() => recoveries.add({ id: 'u1' }, 'CL-1', { source: 'gift', amount: 10 }), /source must be one of/);
  assert.throws(() => recoveries.add({ id: 'u1' }, 'CL-1', { source: 'salvage' }), /positive amount/);
  assert.throws(() => recoveries.add({ id: 'u1' }, 'CL-1', { source: 'salvage', amount: -5 }), /positive amount/);
});

test('a claim the person may not see looks like one that does not exist', () => {
  const pc = fakePc({ allowed: false });
  const recoveries = createRecoveries(pc);
  assert.throws(() => recoveries.list({ id: 'u1' }, 'CL-1'), /Claim not found/);
  assert.deepEqual(SOURCES, ['subrogation', 'salvage']);
});
