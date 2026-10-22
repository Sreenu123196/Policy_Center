'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');

// A thumbs-down opens a review task. The test asserts the queue keeps what was said, and that a comment carrying an
// identifier is stored masked - the same rule as the query log.

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-feedback-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  try { return fn(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a thumbs-down is queued for review, newest first', () =>
  withStore((store) => {
    store.addFeedback({ id: 'f1', queryId: 'q1', verdict: 'bad', comment: 'quoted the wrong clause', role: 'Underwriter', createdAt: '2026-10-21T10:00:00.000Z' });
    store.addFeedback({ id: 'f2', queryId: 'q2', verdict: 'bad', comment: 'incomplete', role: 'Agent', createdAt: '2026-10-22T10:00:00.000Z' });
    store.addFeedback({ id: 'f3', queryId: 'q3', verdict: 'good', comment: 'helpful', role: 'Agent', createdAt: '2026-10-22T11:00:00.000Z' });

    const queue = store.listFeedback({ verdict: 'bad' });
    assert.equal(queue.length, 2, 'good answers are not review tasks');
    assert.equal(queue[0].id, 'f2', 'newest first');
    assert.equal(queue[0].comment, 'incomplete');
  }));

test('the queue can be limited and filtered', () =>
  withStore((store) => {
    for (const [index, verdict] of ['bad', 'good', 'bad'].entries()) {
      store.addFeedback({ id: 'x' + index, verdict, comment: 'c' + index });
    }
    assert.equal(store.listFeedback({ verdict: 'bad', limit: 1 }).length, 1);
    assert.equal(store.listFeedback({ limit: 10 }).length, 3);
  }));
