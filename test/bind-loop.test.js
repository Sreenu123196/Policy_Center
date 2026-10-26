'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Chatbot } = require('../src/chatbot');
const { createBindGate } = require('../src/bindGate');
const { AppError } = require('../src/appError');

// The whole chain through the chat loop: the model asks for an approval, a person decides, the model binds with the id it
// was given, and the policy number comes back. The gate is real; only the model is fake, and the stream shape is the one
// chat() actually consumes.

const PC = { today: () => '2026-10-23', nowMs: () => Date.parse('2026-10-23T00:00:00Z') };
const USER = { id: 'uwm', name: 'Manager', role: 'UW Manager', username: 'uwm' };

function streamOf(response) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const block of response.content) {
        if (block.type === 'text') yield { type: 'content_block_delta', delta: { type: 'text_delta', text: block.text } };
      }
    },
    finalMessage: async () => response,
  };
}

function fakeClient(responses) {
  let index = 0;
  return { beta: { messages: { stream: () => streamOf(responses[index++] || responses[responses.length - 1]) } } };
}

function world() {
  const store = {
    data: {
      jobs: [{ id: 'job1', status: 'Quoted', premium: 12000, uwIssues: [] }],
      staff: [{ id: 'uwm', username: 'uwm', role: 'UW Manager' }, { id: 'uwm2', username: 'uwm2', role: 'UW Manager' }],
      seq: {},
    },
    next(n) { store.data.seq[n] = (store.data.seq[n] || 0) + 1; return store.data.seq[n]; },
  };
  let bound = 0;
  const pc = { bind: () => { bound += 1; return { policyNumber: 'PA-0000100' }; } };
  return { store, pc, gate: createBindGate(pc, store), bound: () => bound };
}

test('the assistant asks, a person approves, the assistant binds and reports the policy', async () => {
  const { gate, bound } = world();
  // The model stops after asking - that is the behaviour the prompt demands - so the bind happens on the next turn,
  // after a person has decided. A fake that bound in the same turn would prove the opposite of the rule.
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'request_bind_approval', input: { job: 'job1' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I have asked a manager to approve binding this job.' }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'bind_policy', input: { job: 'job1', approvalId: 'BA-0000001' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Bound: PA-0000100.' }] },
  ]);
  const chatbot = new Chatbot(PC, { client, bindGate: gate });

  // the first turn asks for the approval; the person decides between turns, as the screen does
  const first = await chatbot.chat({ message: 'bind job1, please' }, USER);
  assert.deepEqual(first.toolsUsed, ['request_bind_approval']);
  assert.equal(bound(), 0, 'asking never binds');
  const approval = gate.list().find((a) => a.status === 'pending');
  assert.ok(approval, 'a request exists for the person to answer');
  // A second manager decides - the same rule the gate now enforces for everyone.
  gate.decide({ id: 'uwm2', role: 'UW Manager' }, approval.id, 'approved');

  const second = await chatbot.chat({ message: 'approved, go ahead' }, USER);
  // Each chat call is its own turn, so toolsUsed lists what this turn used.
  assert.ok(second.toolsUsed.includes('bind_policy'), second.toolsUsed.join(','));
  assert.equal(bound(), 1, 'the bind happened once');
  assert.match(second.reply, /PA-0000100/);
});

test('a bind without an approval is refused and nothing is bound', async () => {
  const { gate, bound } = world();
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'bind_policy', input: { job: 'job1', approvalId: 'BA-9999999' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I need an approval before binding.' }] },
  ]);
  const chatbot = new Chatbot(PC, { client, bindGate: gate });
  const result = await chatbot.chat({ message: 'bind it' }, USER);
  assert.equal(bound(), 0);
  assert.match(JSON.stringify(result), /I need an approval|bind approval/i);
});
