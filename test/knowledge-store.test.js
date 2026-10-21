'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');

// The store adapter, exercised against a throwaway SQLite file. R0 keeps the full schema (audience, dates,
// embedding model) even though retrieval only uses the filters from R2.

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-knowledge-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  try { return fn(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const chunk = (over = {}) => ({
  id: 'c1', versionId: 'v1', documentId: 'd1', headingPath: 'Section 1 > HO-1.2', clause: 'HO-1.2', page: 2,
  text: 'Jewellery, watches and furs are covered up to 2,500 dollars.', audience: 'underwriting',
  product: 'Homeowners', language: 'en', sensitivity: 'internal', embedModel: 'voyage-4',
  embedding: [1, 0, 0], validFrom: '2026-01-01', validTo: null, ...over,
});

function seed(store) {
  store.addDocument({ id: 'd1', title: 'Sample Homeowners Wording', source: 'test/fixtures/knowledge/sample-home-wording.md' });
  store.addVersion({ id: 'v1', documentId: 'd1', version: 1, validFrom: '2026-01-01' });
  store.addChunk(chunk({ id: 'c1', embedding: [1, 0, 0] }));
  store.addChunk(chunk({ id: 'c2', embedding: [0.8, 0.2, 0], text: 'We cover the dwelling and attached structures.', clause: 'HO-1.1', headingPath: 'Section 1 > HO-1.1' }));
  store.addChunk(chunk({ id: 'c3', embedding: [0, 1, 0], text: 'The insured must tell us within 30 days.', clause: 'HO-3.1', headingPath: 'Section 3 > HO-3.1' }));
}

test('a chunk keeps its filters and its embedding model', () => {
  withStore((store) => {
    seed(store);
    const stored = store.getChunk('c1');
    assert.equal(stored.audience, 'underwriting');
    assert.equal(stored.product, 'Homeowners');
    assert.equal(stored.embed_model, 'voyage-4');
    assert.equal(stored.valid_from, '2026-01-01');
    assert.equal(stored.valid_to, null);
    assert.equal(stored.clause, 'HO-1.2');
    assert.equal(stored.page, 2);
  });
});

test('publishing a new version retires the previous one', () => {
  withStore((store) => {
    seed(store);
    store.addVersion({ id: 'v2', documentId: 'd1', version: 2, validFrom: '2027-01-01' });
    store.publishVersion('d1', 'v2', '2026-12-31');
    assert.equal(store.getVersion('v1').valid_to, '2026-12-31');
    assert.equal(store.getVersion('v2').valid_to, null, 'the new version stays current');
  });
});

test('vector search returns the nearest chunks first', () => {
  withStore((store) => {
    seed(store);
    const results = store.searchVector([1, 0, 0], { embedModel: 'voyage-4', limit: 2 });
    assert.deepEqual(results.map((r) => r.id), ['c1', 'c2']);
    assert.ok(results[0].score > results[1].score);
  });
});

test('keyword search finds an exact clause phrase', () => {
  withStore((store) => {
    seed(store);
    const hits = store.searchKeyword('within 30 days');
    assert.deepEqual(hits.map((r) => r.id), ['c3']);
  });
});

test('search refuses to compare vectors from two different models', () => {
  withStore((store) => {
    seed(store);
    assert.throws(
      () => store.searchVector([1, 0, 0], { embedModel: 'bge-m3' }),
      /refusing to compare embeddings: index has voyage-4, query is bge-m3/,
    );
  });
});
