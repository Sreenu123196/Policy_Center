'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Chatbot } = require('../src/chatbot');

// The loop, not just the runner. chat() consumes client.beta.messages.stream, so the fake is a stream: async-iterable
// for deltas and a finalMessage() for the assembled response. First round asks for search_knowledge, second answers.

const PASSAGES = [{ clause: 'HO-1.2', headingPath: 'Section 1 > HO-1.2', page: 2, text: 'Jewellery is covered up to 2,500 dollars.' }];
const PC = { today: () => '2026-03-01', nowMs: () => Date.parse('2026-03-01T00:00:00Z') };
const USER = { id: 'u1', name: 'Arundhati', role: 'Underwriter', username: 'uw' };

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
  const requests = [];
  let index = 0;
  return {
    requests,
    beta: { messages: { stream: (request) => { requests.push(request); const r = responses[index] || responses[responses.length - 1]; index += 1; return streamOf(r); } } },
  };
}

test('the assistant calls search_knowledge and answers from what came back', async () => {
  const seen = [];
  const knowledge = { search: async (user, question) => { seen.push({ user, question }); return PASSAGES; } };
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'search_knowledge', input: { question: 'jewellery limit?' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Jewellery is covered up to 2,500 dollars [1].' }] },
  ]);
  const chatbot = new Chatbot(PC, { client, knowledge });

  const result = await chatbot.chat({ message: 'How much cover is there for jewellery?' }, USER);

  assert.equal(result.mode, 'claude');
  assert.deepEqual(result.toolsUsed, ['search_knowledge'], 'the model used the knowledge tool');
  assert.match(result.reply, /2,500/, 'the reply carries the fact from the passage');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].user.role, 'Underwriter', 'the tool ran as the person');
  assert.match(JSON.stringify(client.requests[1]), /HO-1\.2/, 'the passage was fed back to the model');
});

test('an unconfigured service is reported to the model, not hidden', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'search_knowledge', input: { question: 'jewellery limit?' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I could not search the documents.' }] },
  ]);
  const chatbot = new Chatbot(PC, { client, knowledge: null });
  const result = await chatbot.chat({ message: 'How much cover is there for jewellery?' }, USER);
  assert.equal(result.mode, 'claude');
  assert.match(JSON.stringify(client.requests[1]), /not configured/);
});
