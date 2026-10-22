'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIncidents, TYPES, STATUSES } = require('../src/incidents');

// An incident is a loss reported before it becomes a claim. The tests cover the validation that keeps the register
// honest, and the access rule that stops an incident being filed against someone else's policy.

function fakeStore() {
  const data = { incidents: [], seq: {} };
  return { data, next: (n) => { data.seq[n] = (data.seq[n] || 0) + 1; return data.seq[n]; } };
}

const pc = { policy: (number) => { if (number === 'PA-0000001') return { policyNumber: 'PA-0000001' }; throw new Error('not found'); } };

test('an incident is recorded with a type, a date and its reporter', () => {
  const store = fakeStore();
  const incidents = createIncidents(store, pc);
  const created = incidents.create({ id: 'u1' }, { type: 'water', occurredOn: '2026-10-01', description: 'burst pipe', policy: 'PA-0000001' });
  assert.match(created.id, /^IN-\d{7}$/);
  assert.equal(created.status, 'reported');
  assert.equal(created.policyNumber, 'PA-0000001');
  assert.equal(created.reportedBy, 'u1');
  assert.equal(incidents.list().length, 1);
});

test('a bad type, a missing date and a malformed date are refused', () => {
  const store = fakeStore();
  const incidents = createIncidents(store, pc);
  assert.throws(() => incidents.create({ id: 'u1' }, { type: 'meteor', occurredOn: '2026-10-01' }), /type must be one of/);
  assert.throws(() => incidents.create({ id: 'u1' }, { type: 'fire' }), /occurredOn must be a date/);
  assert.throws(() => incidents.create({ id: 'u1' }, { type: 'fire', occurredOn: '01/10/2026' }), /occurredOn must be a date/);
});

test('an incident cannot be filed against a policy the person cannot see', () => {
  const store = fakeStore();
  const incidents = createIncidents(store, pc);
  assert.throws(() => incidents.create({ id: 'u1' }, { type: 'fire', occurredOn: '2026-10-01', policy: 'PA-9999999' }), /not found/);
});

test('status moves through the allowed values, and closing records when', () => {
  const store = fakeStore();
  const incidents = createIncidents(store, pc);
  const created = incidents.create({ id: 'u1' }, { type: 'theft', occurredOn: '2026-10-02' });
  assert.equal(incidents.setStatus(created.id, 'under-review').status, 'under-review');
  const closed = incidents.setStatus(created.id, 'closed');
  assert.equal(closed.status, 'closed');
  assert.ok(closed.closedAt, 'closing records a timestamp');
  assert.throws(() => incidents.setStatus(created.id, 'forgotten'), /status must be one of/);
  assert.deepEqual(STATUSES, ['reported', 'under-review', 'closed', 'converted']);
  assert.ok(TYPES.includes('injury'));
});
