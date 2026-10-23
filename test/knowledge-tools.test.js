'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeRunTool, TOOLS } = require('../src/chatbot');

// The orchestration proof: the async runner really calls the service it is given, shapes a tool result the model can
// read, and refuses honestly when the service is absent or fails. No network, no model.

const KNOWLEDGE = { search: async (user, question) => ([{ clause: 'HO-1.2', headingPath: 'S1 > HO-1.2', page: 2, text: question }]) };

test('search_knowledge calls the service as the signed-in user', async () => {
  let seen = null;
  const knowledge = { search: async (user, question) => { seen = { user, question }; return [{ clause: 'HO-1.2' }]; } };
  const result = await safeRunTool({}, { id: 'u1', role: 'Underwriter' }, 'search_knowledge', { question: 'jewellery limit?' }, { knowledge });
  assert.equal(result.ok, true);
  assert.deepEqual(seen.user, { id: 'u1', role: 'Underwriter' }, 'the tool runs as the person, so the audience filter applies');
  assert.equal(seen.question, 'jewellery limit?');
  assert.equal(result.result.passages[0].clause, 'HO-1.2');
});

test('search_knowledge says so when the assistant is not configured', async () => {
  const result = await safeRunTool({}, { role: 'Underwriter' }, 'search_knowledge', { question: 'x' }, {});
  assert.equal(result.result.available, false);
  assert.match(result.result.message, /not configured/);
});

test('a failing service becomes an error tool result, not an exception', async () => {
  const knowledge = { search: async () => { throw new Error('voyage 429'); } };
  const result = await safeRunTool({}, { role: 'Underwriter' }, 'search_knowledge', { question: 'x' }, { knowledge });
  assert.equal(result.ok, false);
  assert.match(result.error, /voyage 429/);
});

test('get_policy_as_of answers from the system of record through the access rule', async () => {
  const pc = {
    policy: () => ({ policyNumber: 'PA-0000001', product: 'PersonalAuto', form: 'PA-1' }),
    policyAsOf: () => ({ status: 'in_force', termNumber: 1, effectiveDate: '2026-01-01', expirationDate: '2027-01-01' }),
  };
  const result = await safeRunTool(pc, { role: 'Underwriter' }, 'get_policy_as_of', { policy: 'PA-0000001', asOf: '2026-06-01' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.result.found, true);
  assert.equal(result.result.status, 'in_force');
  assert.equal(result.result.asOf, '2026-06-01');
});

test('get_policy_as_of tells a stranger nothing about the policy', async () => {
  const pc = { policy: () => { throw new Error('not found'); }, policyAsOf: () => ({}) };
  const result = await safeRunTool(pc, { role: 'Underwriter' }, 'get_policy_as_of', { policy: 'PA-0000002' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.result.found, false);
  assert.equal(result.result.insuredName, undefined);
});

test('every tool in the list is one the model can actually reach', async () => {
  for (const tool of TOOLS) {
    assert.ok(tool.name && tool.description && tool.input_schema, tool.name + ' is incomplete');
  }
  const names = TOOLS.map((t) => t.name);
  for (const name of ['search_knowledge', 'get_policy_as_of']) assert.ok(names.includes(name));
});

test('get_claim returns the claim a person may see, without the reserve for an agent', async () => {
  const pc = {
    db: { claims: [{ claimNumber: 'CL-1', policyId: 'p1', status: 'Open', dateOfLoss: '2026-02-01', reserve: 50000 }] },
    policy: () => ({ policyNumber: 'PA-0000001' }),
  };
  const staff = await safeRunTool(pc, { role: 'Underwriter' }, 'get_claim', { claim: 'CL-1' }, {});
  assert.equal(staff.result.found, true);
  assert.equal(staff.result.status, 'Open');
  assert.equal(staff.result.reserve, 50000, 'a person who may see reserves gets one');

  const agent = await safeRunTool(pc, { role: 'Agent' }, 'get_claim', { claim: 'CL-1' }, {});
  assert.equal(agent.result.found, true);
  assert.equal(agent.result.reserve, undefined, 'an agent does not see the reserve');
});

test('a claim the person may not see looks like a claim that does not exist', async () => {
  const pc = {
    db: { claims: [{ claimNumber: 'CL-2', policyId: 'p2', status: 'Open' }] },
    policy: () => { throw new Error('not found'); },
  };
  const result = await safeRunTool(pc, { role: 'Agent' }, 'get_claim', { claim: 'CL-2' }, {});
  assert.equal(result.result.found, false);
  assert.equal(result.result.status, undefined);
});

test('the assistant asks for an approval rather than binding', async () => {
  const calls = [];
  const bindGate = {
    requestApproval: (user, job) => { calls.push(['request', job]); return { id: 'BA-0000001', jobId: job, status: 'pending' }; },
    bind: (user, job, approvalId) => { calls.push(['bind', job, approvalId]); return { bound: true, policyNumber: 'PA-0000100', approvalId }; },
  };
  const asked = await safeRunTool({}, { id: 'uwm', role: 'UW Manager' }, 'request_bind_approval', { job: 'job1' }, { bindGate });
  assert.equal(asked.result.id, 'BA-0000001');
  assert.equal(asked.result.status, 'pending');
  const bound = await safeRunTool({}, { id: 'uwm', role: 'UW Manager' }, 'bind_policy', { job: 'job1', approvalId: 'BA-0000001' }, { bindGate });
  assert.equal(bound.result.bound, true);
  assert.deepEqual(calls, [['request', 'job1'], ['bind', 'job1', 'BA-0000001']]);
});

test('a gate refusal comes back as an error result, not an exception', async () => {
  const bindGate = { requestApproval: () => ({}), bind: () => { throw new Error('The approval has expired; ask again'); } };
  const result = await safeRunTool({}, { role: 'UW Manager' }, 'bind_policy', { job: 'job1', approvalId: 'X' }, { bindGate });
  assert.equal(result.ok, false);
  assert.match(result.error, /expired/);
});

test('without a gate the tools say so instead of pretending', async () => {
  const result = await safeRunTool({}, { role: 'UW Manager' }, 'request_bind_approval', { job: 'job1' }, {});
  assert.equal(result.result.available, false);
});
