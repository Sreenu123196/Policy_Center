'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBindGate } = require('../src/bindGate');

// The nine cases from docs/BIND-GATE.md, written before the module was wired to a route. Each refuses in its own way,
// because "refused" is not enough: the reason tells the assistant what to do next.

function world({ premium = 12000, status = 'Quoted', referred = false } = {}) {
  const store = {
    data: {
      jobs: [{ id: 'job1', jobNumber: 'J-1', status, premium, referred, uwIssues: [] }],
      staff: [
        { id: 'uwm', username: 'uwm', role: 'UW Manager' },
        { id: 'agent1', username: 'agent1', role: 'Agent' },
        { id: 'uwm2', username: 'uwm2', role: 'UW Manager' },
      ],
      seq: {},
    },
    next(n) { store.data.seq[n] = (store.data.seq[n] || 0) + 1; return store.data.seq[n]; },
  };
  const bound = [];
  const pc = { bind: (jobId, user) => { bound.push({ jobId, user }); return { policyNumber: 'PA-0000100' }; } };
  return { store, pc, bound, gate: createBindGate(pc, store) };
}

const manager = { id: 'uwm', role: 'UW Manager' };
// A second manager approves what the first requested - separation of duties means one person cannot do both.
const approver = { id: 'uwm2', role: 'UW Manager' };

test('1. an approved approval for this job, within authority, binds and names the approval', () => {
  const { store, gate, bound } = world();
  const approval = gate.requestApproval(manager, 'job1');
  gate.decide(approver, approval.id, 'approved');
  const result = gate.bind(manager, 'job1', approval.id);
  assert.equal(result.bound, true);
  assert.equal(result.approvalId, approval.id);
  assert.equal(bound.length, 1);
  assert.ok(store.data.bindApprovals[0].usedAt, 'the approval is marked used');
});

test('2. a declined approval refuses and nothing binds', () => {
  const { gate, bound } = world();
  const approval = gate.requestApproval(manager, 'job1');
  gate.decide(approver, approval.id, 'declined');
  assert.throws(() => gate.bind(manager, 'job1', approval.id), /has not been given/);
  assert.equal(bound.length, 0);
});

test('3. a missing or unknown approval refuses', () => {
  const { gate } = world();
  assert.throws(() => gate.bind(manager, 'job1', 'BA-9999999'), /approval is required/);
  assert.throws(() => gate.bind(manager, 'job1', undefined), /approval is required/);
});

test('4. an approval for another job refuses', () => {
  const { store, gate } = world();
  store.data.jobs.push({ id: 'job2', status: 'Quoted', premium: 1000, uwIssues: [] });
  const approval = gate.requestApproval(manager, 'job2');
  gate.decide(approver, approval.id, 'approved');
  assert.throws(() => gate.bind(manager, 'job1', approval.id), /different job/);
});

test('5. a premium above the approver’s authority refuses', () => {
  const { store, gate } = world({ premium: 900000 });
  const approval = gate.requestApproval(manager, 'job1');
  // approved by an agent, whose authority is 50,000
  gate.decide({ id: 'agent1', role: 'Agent' }, approval.id, 'approved');
  assert.throws(() => gate.bind(manager, 'job1', approval.id), /authority does not cover/);
});

test('6. an approval older than the window refuses', () => {
  const { store, gate } = world();
  const approval = gate.requestApproval(manager, 'job1');
  gate.decide(approver, approval.id, 'approved');
  store.data.bindApprovals[0].decidedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  assert.throws(() => gate.bind(manager, 'job1', approval.id), /expired/);
});

test('7. the same approval used twice refuses the second time', () => {
  const { gate } = world();
  const approval = gate.requestApproval(manager, 'job1');
  gate.decide(approver, approval.id, 'approved');
  gate.bind(manager, 'job1', approval.id);
  assert.throws(() => gate.bind(manager, 'job1', approval.id), /already been used/);
});

test('8. a job with open underwriting issues refuses', () => {
  const { store, gate } = world();
  store.data.jobs[0].uwIssues = ['driver under 25 without telematics'];
  const approval = gate.requestApproval(manager, 'job1');
  gate.decide(approver, approval.id, 'approved');
  assert.throws(() => gate.bind(manager, 'job1', approval.id), /open underwriting issues/);
});

test('9. an approval id echoed from a previous call refuses, because it is for another job or already used', () => {
  const { store, gate } = world();
  store.data.jobs.push({ id: 'job3', status: 'Quoted', premium: 12000, uwIssues: [] });
  const old = gate.requestApproval(manager, 'job3');
  gate.decide(approver, old.id, 'approved');
  gate.bind(manager, 'job3', old.id);
  assert.throws(() => gate.bind(manager, 'job1', old.id), /different job/);
});

test('only a quoted job can be sent for approval', () => {
  const { gate } = world({ status: 'Draft' });
  assert.throws(() => gate.requestApproval(manager, 'job1'), /Only a quoted job/);
});

test('a manager cannot decide an approval they requested', () => {
  const { gate } = world();
  const approval = gate.requestApproval(manager, 'job1');
  assert.throws(() => gate.decide(manager, approval.id, 'approved'), /cannot decide an approval you requested/);
  assert.equal(approval.status, 'pending', 'the request stays pending for someone else');
  gate.decide(approver, approval.id, 'approved');
  assert.equal(approval.status, 'approved');
});
