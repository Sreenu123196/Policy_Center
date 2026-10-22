'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Section 13 asks for about fifty cases per use case. This is one use case's worth, and the shape is enforced so the
// set cannot quietly rot: unique ids, a status on every case, sources only where an answer is expected.

const file = path.join(__dirname, 'fixtures/knowledge/eval-questions.json');
const { questions } = JSON.parse(fs.readFileSync(file, 'utf8'));

test('the evaluation set has fifty cases', () => {
  assert.ok(questions.length >= 50, 'cases: ' + questions.length);
});

test('every case has a unique id and a status', () => {
  const ids = new Set();
  for (const question of questions) {
    assert.ok(question.id, 'a case has no id');
    assert.equal(ids.has(question.id), false, 'duplicate id ' + question.id);
    ids.add(question.id);
    assert.ok(['answered', 'unanswerable', 'not_found'].includes(question.expected_status), question.id + ' has status ' + question.expected_status);
    assert.ok(question.question && question.question.length > 10, question.id + ' has no question text');
  }
});

test('answerable cases name the clause they expect, unanswerable ones name none', () => {
  for (const question of questions) {
    if (question.expected_status === 'answered') {
      assert.ok(Array.isArray(question.expected_sources) && question.expected_sources.length, question.id + ' expects an answer but no clause');
      assert.ok(Array.isArray(question.must_include) && question.must_include.length, question.id + ' expects an answer but no facts');
    } else {
      assert.ok(!question.expected_sources || question.expected_sources.length === 0, question.id + ' expects not-found but names a clause');
    }
  }
});

test('each of the four wordings is represented', () => {
  const prefixes = new Set(questions.flatMap((q) => (q.expected_sources || []).map((clause) => clause.slice(0, 2))));
  for (const prefix of ['HO', 'PA', 'CP', 'WC']) assert.ok(prefixes.has(prefix), 'no case expects a ' + prefix + ' clause');
});
