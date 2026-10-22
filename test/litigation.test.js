'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLitigation, STAGES } = require('../src/litigation');

function fakePc({ allowed = true } = {}) {
  return {
    db: { claims: [{ claimNumber: 'CL-1', policyId: 'p1', status: 'Open' }] },
    policy: () => { if (!allowed) throw new Error('not found'); return { policyNumber: 'PA-1' }; },
  };
}

test('litigation needs an authoriser the first time, and records the stage and note', () => {
  const pc = fakePc();
  const litigation = createLitigation(pc);
  assert.throws(() => litigation.record({ id: 'u1' }, 'CL-1', { stage: 'notified' }), /authorisedBy is required/);
  const recorded = litigation.record({ id: 'u1' }, 'CL-1', { stage: 'notified', authorisedBy: 'Head of Claims', note: 'solicitor instructed' });
  assert.equal(recorded.litigation.stage, 'notified');
  assert.equal(recorded.litigation.authorisedBy, 'Head of Claims');
  assert.ok(recorded.litigation.openedAt);
  assert.equal(litigation.get({ id: 'u1' }, 'CL-1').litigation.note, 'solicitor instructed');
});

test('the stage moves and the original authoriser and opening time are kept', () => {
  const pc = fakePc();
  const litigation = createLitigation(pc);
  const first = litigation.record({ id: 'u1' }, 'CL-1', { stage: 'notified', authorisedBy: 'Head of Claims' });
  const opened = first.litigation.openedAt;
  const second = litigation.record({ id: 'u2' }, 'CL-1', { stage: 'settled' });
  assert.equal(second.litigation.stage, 'settled');
  assert.equal(second.litigation.authorisedBy, 'Head of Claims', 'the authoriser is not lost on update');
  assert.equal(second.litigation.openedAt, opened, 'the opening time is not reset');
  assert.equal(second.litigation.updatedBy, 'u2');
});

test('an unknown stage is refused, and a claim the person may not see looks missing', () => {
  const pc = fakePc();
  const litigation = createLitigation(pc);
  assert.throws(() => litigation.record({ id: 'u1' }, 'CL-1', { stage: 'appealed', authorisedBy: 'X' }), /stage must be one of/);
  assert.deepEqual(STAGES, ['notified', 'defended', 'settled', 'withdrawn']);
  const hidden = createLitigation(fakePc({ allowed: false }));
  assert.throws(() => hidden.get({ id: 'u1' }, 'CL-1'), /Claim not found/);
});
