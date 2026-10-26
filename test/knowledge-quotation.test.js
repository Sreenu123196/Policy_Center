'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { answerQuestion, quotationFallback, NOT_FOUND } = require('../src/knowledge/answer');

// A refusal is acceptable; a refusal with the answer in hand is not. The fallback quotes, so it cannot invent.

const PASSAGES = [
  { clause: 'PA-1.2', text: 'We cover two vehicles. Special limits apply to jewellery and to cash.' },
  { clause: 'HO-2.2', text: 'We do not cover liability arising from the business.' },
];
const refusing = { messages: { create: async () => ({ content: [{ type: 'text', text: NOT_FOUND }], usage: {} }) } };

test('a refusal is replaced by a quotation when a passage answers the question', async () => {
  const result = await answerQuestion({ client: refusing, question: 'What special limits apply?', passages: PASSAGES, quoteOnRefusal: true });
  assert.equal(result.status, 'answered');
  assert.match(result.answer, /^The documents say: "/);
  assert.ok(PASSAGES[0].text.includes(result.answer.match(/"(.+?)"/)[1].replace(/\[1\].*$/, '').trim()) || result.answer.includes('Special limits apply'));
  assert.deepEqual(result.citations, [1]);
  assert.match(result.issues[0], /answered by quotation/);
});

test('the quoted sentence is copied from the passage, never composed', () => {
  const quoted = quotationFallback({ question: 'Do we cover business liability?', passages: PASSAGES });
  assert.ok(quoted);
  assert.ok(PASSAGES[1].text.includes(quoted.answer.match(/"(.+?)"/)[1]), 'the quotation appears verbatim in the passage');
  assert.ok(quoted.answer.includes('HO-2.2'), 'and the clause is named');
});

test('a question with no real overlap is still refused', async () => {
  const result = await answerQuestion({ client: refusing, question: 'What is the capital of France?', passages: PASSAGES, quoteOnRefusal: true });
  assert.equal(result.status, 'not_found');
  assert.equal(result.answer, NOT_FOUND);
});

test('no passages means no fallback, because there is nothing to quote', async () => {
  const result = await answerQuestion({ client: refusing, question: 'What special limits apply?', passages: [] });
  assert.equal(result.status, 'not_found');
  assert.equal(quotationFallback({ question: 'What special limits apply?', passages: [] }), null);
});

test('one distinctive word is enough, because wording rarely matches the question exactly', () => {
  const passages = [{ clause: 'HO-1.2', text: 'Jewellery is covered up to two thousand five hundred dollars.' }];
  const quoted = quotationFallback({ question: 'How much is covered for rings and bracelets?', passages });
  assert.ok(quoted, 'covered is shared and distinctive');
  assert.match(quoted.answer, /Jewellery is covered/);
});

test('a question whose only overlap is a common word is still refused', () => {
  const passages = [{ clause: 'PA-1.1', text: 'The policy period is twelve months from inception.' }];
  assert.equal(quotationFallback({ question: 'What is the policy on refunds?', passages }), null);
});
