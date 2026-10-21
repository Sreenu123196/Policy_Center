'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');
const { createKnowledgeService } = require('../src/knowledge/serve');

// Reindexing moves stale chunks to the current model, one version at a time. A version that fails stays entirely on the
// old model: a half-migrated version would answer from two different vector spaces.

const CURRENT = 'voyage-4';

function seed(store, versionId, model, tag) {
  if (!store.getVersion(versionId)) {
    store.addDocument({ id: 'd-' + tag, title: 'Wording ' + tag, source: 'fixture' });
    store.addVersion({ id: versionId, documentId: 'd-' + tag, version: 1, validFrom: '2026-01-01' });
  }
  for (const n of [1, 2]) {
    store.addChunk({
      id: versionId + '-c' + n, versionId, documentId: 'd-' + tag, headingPath: 'S > C', clause: 'CL-' + n, page: 1,
      text: 'Clause text ' + n + ' for ' + tag, audience: 'underwriting', product: 'Homeowners', language: 'en',
      sensitivity: 'internal', embedModel: model, embedding: [0.1, 0.2], validFrom: '2026-01-01', validTo: null,
    });
  }
}

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reindex-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  return Promise.resolve(fn(store)).finally(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
}

const serviceFor = (store, embedder) => createKnowledgeService({
  store, embedModel: CURRENT, embedder: async (t) => t.map(() => [1, 0]), client: null, documentEmbedder: embedder,
});

test('stale versions move to the current model, and the fresh one is left alone', () =>
  withStore(async (store) => {
    seed(store, 'v-old', 'bge-m3', 'old');
    seed(store, 'v-new', CURRENT, 'new');
    const service = serviceFor(store, async (texts) => texts.map(() => [9, 9]));

    const result = await service.reindex();

    assert.equal(result.ok, true);
    assert.equal(result.versions, 1, 'only the stale version is re-embedded');
    assert.equal(result.chunks, 2);
    assert.equal(result.model, CURRENT);
    assert.ok(result.durationMs >= 0);
    for (const row of store.chunksForVersion('v-old')) assert.equal(row.embed_model, CURRENT);
    assert.deepEqual(JSON.parse(store.getChunk('v-old-c1').embedding), [9, 9], 'the vector was rewritten');
  }));

test('a failing embedder leaves the version untouched and records the failure', () =>
  withStore(async (store) => {
    seed(store, 'v-old', 'bge-m3', 'old');
    const service = serviceFor(store, async () => { throw new Error('voyage is down'); });

    const result = await service.reindex();

    assert.equal(result.ok, false);
    assert.match(result.error, /voyage is down/);
    assert.equal(result.chunks, 0);
    for (const row of store.chunksForVersion('v-old')) assert.equal(row.embed_model, 'bge-m3', 'nothing moved');
    const [run] = store.getRuns(1);
    assert.equal(run.ok, 0);
    assert.match(run.error, /voyage is down/);
    assert.equal(run.agent, 'reindex');
  }));

test('a successful run is written to ingestion_runs with its counts', () =>
  withStore(async (store) => {
    seed(store, 'v-old', 'bge-m3', 'old');
    const service = serviceFor(store, async (texts) => texts.map(() => [1, 1]));
    await service.reindex();
    const [run] = store.getRuns(1);
    assert.equal(run.ok, 1);
    assert.equal(run.versions, 1);
    assert.equal(run.chunks, 2);
    assert.equal(run.model, CURRENT);
    assert.ok(run.duration_ms >= 0);
  }));

test('nothing stale means nothing to do', () =>
  withStore(async (store) => {
    seed(store, 'v-new', CURRENT, 'new');
    const service = serviceFor(store, async () => { throw new Error('must not be called'); });
    const result = await service.reindex();
    assert.equal(result.ok, true);
    assert.equal(result.versions, 0);
    assert.equal(result.chunks, 0);
  }));
