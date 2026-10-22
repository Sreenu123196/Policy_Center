'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');

// The content-gap report: what people asked that the corpus could not answer, most asked first. This is what a document
// owner acts on, so the grouping and the ordering are the contract.

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-gaps-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  try { return fn(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('unanswered questions are grouped and ordered by how often they were asked', () =>
  withStore((store) => {
    store.logQuery({ id: '1', role: 'Underwriter', question: 'Is flood covered?', status: 'not_found' });
    store.logQuery({ id: '2', role: 'Underwriter', question: 'Is flood covered?', status: 'not_found' });
    store.logQuery({ id: '3', role: 'Underwriter', question: 'What is the flood premium?', status: 'not_found' });
    store.logQuery({ id: '4', role: 'Underwriter', question: 'Is flood covered?', status: 'answered' });

    const gaps = store.contentGaps(10);
    assert.equal(gaps.length, 2, 'answered questions are not gaps');
    assert.equal(gaps[0].question, 'Is flood covered?');
    assert.equal(gaps[0].asked, 2, 'the same question twice is one gap asked twice');
    assert.match(gaps[0].last_asked, /\d{4}-\d{2}-\d{2}/);
  }));

test('a limit is respected, so a long log cannot bury the report', () =>
  withStore((store) => {
    for (const [index, question] of ['a', 'b', 'c', 'd'].entries()) {
      store.logQuery({ id: String(index), question, status: 'not_found' });
    }
    assert.equal(store.contentGaps(2).length, 2);
  }));
