'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');
const { ingestVersion, splitByStructure, estimateTokens } = require('../src/knowledge/ingest');

// Ingest behaviour, with a fake embedder so nothing here touches the network.

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/knowledge/sample-home-wording.md'), 'utf8');
const META = { audience: 'underwriting', product: 'Homeowners', language: 'en', sensitivity: 'internal', validFrom: '2026-01-01' };

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ingest-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  return Promise.resolve(fn(store)).finally(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const fakeEmbedder = async (texts) => texts.map(() => [1, 0, 0]);
const document = { id: 'd1', title: 'Sample Homeowners Wording', source: 'test/fixtures/knowledge/sample-home-wording.md' };

test('the wording splits on its structure, keeping heading path, clause and page', () => {
  const chunks = splitByStructure(FIXTURE);
  assert.ok(chunks.length >= 6, `expected several clauses, got ${chunks.length}`);
  const clause = chunks.find((c) => c.clause === 'HO-1.2');
  assert.ok(clause, 'HO-1.2 is a chunk of its own');
  assert.match(clause.headingPath, /^Section 1\. Property cover > HO-1\.2$/);
  assert.equal(clause.page, 1);
  assert.match(clause.text, /2,500 dollars/);
  assert.ok(chunks.every((c) => c.text.trim().length > 0));
});

test('every chunk stays inside the token limit', () => {
  const chunks = splitByStructure(FIXTURE);
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk.text) <= 800, `chunk too large: ${estimateTokens(chunk.text)} tokens`);
  }
});

test('a long clause is cut on paragraph boundaries, not in the middle of a sentence', () => {
  const paragraph = 'This paragraph is about flood cover and repeats itself to make the clause long enough. '.repeat(20);
  const long = `## Section 9. Long clause\n\n### HO-9.1 Very long\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
  const chunks = splitByStructure(long);
  assert.ok(chunks.length > 1, 'the clause was split');
  for (const chunk of chunks) {
    assert.equal(chunk.clause, 'HO-9.1');
    assert.ok(estimateTokens(chunk.text) <= 800);
    assert.ok(chunk.text.trim().endsWith('.'), 'a split still ends on a sentence boundary');
  }
});

test('ingest stores metadata and the embedding model on every chunk', () =>
  withStore(async (store) => {
    const result = await ingestVersion({
      store, embedder: fakeEmbedder, embedModel: 'voyage-4', document,
      version: { id: 'v1', version: 1, validFrom: '2026-01-01' }, text: FIXTURE, metadata: META,
    });

    assert.equal(result.event, 'KnowledgeIndexed');
    assert.equal(result.embedModel, 'voyage-4');
    assert.ok(result.chunks >= 6);
    const rows = store.searchVector([1, 0, 0], { embedModel: 'voyage-4', limit: 50 });
    assert.equal(rows.length, result.chunks);
    for (const row of rows) {
      assert.equal(row.audience, 'underwriting');
      assert.equal(row.product, 'Homeowners');
      assert.equal(row.language, 'en');
      assert.equal(row.sensitivity, 'internal');
      assert.equal(row.embed_model, 'voyage-4');
      assert.equal(row.valid_from, '2026-01-01');
      assert.ok(row.clause, 'each chunk knows its clause');
      assert.ok(row.page >= 1);
    }
  }));

test('publishing a second version retires the first', () =>
  withStore(async (store) => {
    await ingestVersion({ store, embedder: fakeEmbedder, embedModel: 'voyage-4', document,
      version: { id: 'v1', version: 1, validFrom: '2026-01-01' }, text: FIXTURE, metadata: META });
    await ingestVersion({ store, embedder: fakeEmbedder, embedModel: 'voyage-4', document,
      version: { id: 'v2', version: 2, validFrom: '2027-01-01' }, text: FIXTURE, metadata: META });

    assert.equal(store.getVersion('v1').valid_to !== null, true);
    assert.equal(store.getVersion('v2').valid_to, null);
  }));

test('a failed embedding stores nothing and leaves the old version current', () =>
  withStore(async (store) => {
    await ingestVersion({ store, embedder: fakeEmbedder, embedModel: 'voyage-4', document,
      version: { id: 'v1', version: 1, validFrom: '2026-01-01' }, text: FIXTURE, metadata: META });

    // Ingest embeds the whole version in one call, so the fake fails that call outright.
    const failing = async () => {
      throw new Error('voyage is down');
    };

    await assert.rejects(
      () => ingestVersion({ store, embedder: failing, embedModel: 'voyage-4', document,
        version: { id: 'v2', version: 2, validFrom: '2027-01-01' }, text: FIXTURE, metadata: META }),
      /voyage is down/,
    );

    assert.equal(store.getVersion('v2'), undefined, 'the failed version was never written');
    assert.equal(store.countChunks('v2'), 0);
    assert.equal(store.getVersion('v1').valid_to, null, 'version 1 is still current');
  }));

test('an ingest without an audience is refused, because the access filter depends on it', () =>
  withStore(async (store) => {
    await assert.rejects(
      () => ingestVersion({ store, embedder: fakeEmbedder, embedModel: 'voyage-4', document,
        version: { id: 'v1', version: 1, validFrom: '2026-01-01' }, text: FIXTURE, metadata: {} }),
      /audience is required/,
    );
    assert.equal(store.getVersion('v1'), undefined);
  }));
