'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { score } = require('../scripts/knowledge-cli');

// The scoring the CLI reports, tested without running the CLI or any network call.

const passages = [
  { clause: 'HO-1.2', text: 'Jewellery is covered up to 2,500 dollars.' },
  { clause: 'HO-3.1', text: 'The insured must tell us within 30 days.' },
];

test('a correct answer names the expected clause and the required wording', () => {
  const verdict = score(
    { expected_status: 'answered', expected_sources: ['HO-1.2'], must_include: ['2,500'] },
    { status: 'answered', answer: 'Jewellery is covered up to 2,500 dollars [1].', citations: [1] },
    passages,
  );
  assert.equal(verdict.correct, true);
});

test('citing the wrong passage is not correct, even when the wording matches', () => {
  const verdict = score(
    { expected_status: 'answered', expected_sources: ['HO-1.2'], must_include: ['2,500'] },
    { status: 'answered', answer: 'Jewellery is covered up to 2,500 dollars [2].', citations: [2] },
    passages,
  );
  assert.equal(verdict.correct, false);
  assert.match(verdict.why, /wrong source/);
});

test('answering a question the wording cannot answer counts against it', () => {
  const verdict = score(
    { expected_status: 'not_found', expected_sources: [], must_include: [] },
    { status: 'answered', answer: 'It is covered [1].', citations: [1] },
    passages,
  );
  assert.equal(verdict.correct, false);
});

test('an honest not found counts as correct for an unanswerable question', () => {
  const verdict = score(
    { expected_status: 'not_found', expected_sources: [], must_include: [] },
    { status: 'not_found', answer: 'I could not find that in the documents.', citations: [] },
    passages,
  );
  assert.equal(verdict.correct, true);
});
