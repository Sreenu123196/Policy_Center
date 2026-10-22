'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');

// The dashboard reports what the query log knows: volume, failure rate, latency and who asked. No second source, no
// numbers that are not recorded.

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dash-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  try { return fn(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('volume, failure rate and latency come from the log', () =>
  withStore((store) => {
    store.logQuery({ id: '1', role: 'Underwriter', question: 'a', status: 'answered', latencyMs: 100 });
    store.logQuery({ id: '2', role: 'Underwriter', question: 'b', status: 'not_found', latencyMs: 300 });
    store.logQuery({ id: '3', role: 'Agent', question: 'c', status: 'not_found', latencyMs: 500 });

    const dash = store.dashboard({ days: 7 });
    assert.equal(dash.asked, 3);
    assert.equal(dash.answered, 1);
    assert.equal(dash.notFound, 2);
    assert.equal(dash.notFoundRate, 0.667);
    assert.equal(dash.latencyMs.p50, 300);
    assert.equal(dash.latencyMs.samples, 3);
    assert.equal(dash.byRole.length, 2);
    assert.equal(dash.byRole[0].asked, 2);
  }));

test('an empty log reports zeroes rather than nulls', () =>
  withStore((store) => {
    const dash = store.dashboard({ days: 7 });
    assert.equal(dash.asked, 0);
    assert.equal(dash.notFoundRate, 0);
    assert.equal(dash.latencyMs.p95, null);
    assert.deepEqual(dash.byDay, []);
  }));

test('older questions fall outside the window', () =>
  withStore((store) => {
    store.logQuery({ id: 'old', question: 'a', status: 'answered', latencyMs: 10, createdAt: '2020-01-01T00:00:00.000Z' });
    store.logQuery({ id: 'new', question: 'b', status: 'answered', latencyMs: 20 });
    assert.equal(store.dashboard({ days: 7 }).asked, 1);
  }));
