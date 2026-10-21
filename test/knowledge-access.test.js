'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');
const { hybridSearch } = require('../src/knowledge/retrieve');
const { audiencesFor, filtersForUser, LEVELS } = require('../src/knowledge/access');
const { safeQuery } = require('../src/knowledge/mask');

// R2's exit test: no role may retrieve a passage above its level, measured through the same entry point the API uses.

const USERS = [
  { role: 'Agent', username: 'agent' },
  { role: 'Underwriter', username: 'uw' },
  { role: 'UW Manager', username: 'uwm' },
  { role: 'Insurance Executive', username: 'exec' },
  { role: 'Something New', username: 'unknown' },
];

test('each role reads its level and below, never above', () => {
  assert.deepEqual(audiencesFor({ role: 'Agent' }), ['public', 'agent']);
  assert.deepEqual(audiencesFor({ role: 'Underwriter' }), ['public', 'agent', 'underwriting']);
  assert.deepEqual(audiencesFor({ role: 'UW Manager' }), ['public', 'agent', 'underwriting', 'manager']);
  assert.equal(audiencesFor({ role: 'Insurance Executive' }).includes('restricted'), false);
  assert.deepEqual(audiencesFor({ role: 'Something New' }), ['public'], 'an unknown role gets the narrowest level');
});

function seed(store) {
  store.addDocument({ id: 'd', title: 'Wording', source: 'fixture' });
  store.addVersion({ id: 'v', documentId: 'd', version: 1, validFrom: '2026-01-01' });
  const base = { versionId: 'v', documentId: 'd', headingPath: 'S > C', page: 1, product: 'Homeowners', language: 'en', embedModel: 'voyage-4', validFrom: '2026-01-01' };
  LEVELS.forEach((audience, index) => {
    store.addChunk({ ...base, id: 'c-' + audience, clause: 'CL-' + index, text: audience + ' content about dwelling cover', audience, embedding: [1, 0, 0] });
  });
}

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-access-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  seed(store);
  try { return fn(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('no role retrieves a passage above its level', () =>
  withStore((store) => {
    let leaks = 0;
    for (const user of USERS) {
      const allowed = audiencesFor(user);
      for (const question of ['dwelling cover', 'restricted content', 'manager content', 'public content']) {
        const rows = hybridSearch({
          store, embedModel: 'voyage-4', queryVector: [1, 0, 0], queryText: question,
          limit: 10, filters: filtersForUser(user),
        });
        leaks += rows.filter((row) => !allowed.includes(row.audience)).length;
      }
    }
    assert.equal(leaks, 0, 'leak count must be zero');
  }));

test('the executive reads at the underwriting level, as the read-only design intends', () =>
  withStore((store) => {
    const rows = hybridSearch({ store, embedModel: 'voyage-4', queryVector: [1, 0, 0], queryText: 'content', limit: 10, filters: filtersForUser({ role: 'Insurance Executive' }) });
    const audiences = new Set(rows.map((row) => row.audience));
    assert.equal(audiences.has('restricted'), false);
    assert.equal(audiences.has('manager'), false);
    assert.equal(audiences.has('underwriting'), true);
  }));

test('the query log stores the masked question and the outcome, not the raw text', () =>
  withStore((store) => {
    const record = safeQuery('My Aadhaar is 1234 5678 9012, is PA-0000001 covered?');
    store.logQuery({
      id: 'q1', userId: 'u1', role: 'Underwriter', audience: 'underwriting',
      question: record.masked, status: 'answered', citations: [1], latencyMs: 812,
    });
    const [row] = store.getQueryLog(5);
    assert.equal(row.question.includes('1234'), false, 'the identifier was masked');
    assert.match(row.question, /\[AADHAAR\]/);
    assert.match(row.question, /PA-0000001/);
    assert.equal(row.status, 'answered');
    assert.equal(row.latency_ms, 812);
    assert.deepEqual(JSON.parse(row.citations), [1]);
  }));
