'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');
const { ingestVersion } = require('../src/knowledge/ingest');
const { hybridSearch } = require('../src/knowledge/retrieve');
const { rerank } = require('../src/knowledge/rerank');

// A corpus big enough for recall to mean something: four fictional wordings, about 25 clauses.
const DIR = path.join(__dirname, 'fixtures/knowledge');
const SOURCES = [
  ['sample-home-wording.md', 'Homeowners', 'home'],
  ['sample-personal-auto-wording.md', 'PersonalAuto', 'auto'],
  ['sample-commercial-property-wording.md', 'CommercialProperty', 'commercial'],
  ['sample-workers-comp-wording.md', 'WorkersComp', 'workers'],
];
const { questions } = JSON.parse(fs.readFileSync(path.join(DIR, 'eval-questions.json'), 'utf8'));

const fakeEmbedder = async (texts) => texts.map((text) => {
  const vector = new Array(64).fill(0);
  for (const word of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) % 64;
    vector[hash] += 1;
  }
  return vector;
});

// A deterministic reranker for the test: how many of the question's meaningful words appear in the chunk.
function overlapReranker(query, candidates) {
  const words = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  return candidates.map((candidate) => {
    const text = candidate.text.toLowerCase();
    let score = 0;
    for (const word of words) if (text.includes(word)) score += 1;
    return score;
  });
}

async function buildStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-rerank-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  for (const [file, product, tag] of SOURCES) {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');
    await ingestVersion({
      store, embedder: fakeEmbedder, embedModel: 'fake-64',
      document: { id: tag, title: file, source: file },
      version: { id: 'v-' + tag, version: 1, validFrom: '2026-01-01' },
      text,
      metadata: { audience: 'underwriting', product, language: 'en', sensitivity: 'internal', validFrom: '2026-01-01' },
    });
  }
  return { store, dir };
}

async function recall(store, limit, { useRerank }) {
  let hit = 0;
  let asked = 0;
  for (const question of questions.filter((q) => q.expected_status === 'answered')) {
    asked += 1;
    const [vector] = await fakeEmbedder([question.question]);
    const fused = hybridSearch({ store, embedModel: 'fake-64', queryVector: vector, queryText: question.question, limit: 30 });
    const results = useRerank
      ? await rerank({ query: question.question, candidates: fused, reranker: overlapReranker, topN: limit })
      : fused.slice(0, limit);
    if (question.expected_sources.some((clause) => results.map((r) => r.clause).includes(clause))) hit += 1;
  }
  return hit / asked;
}

test('the corpus is big enough for recall to be meaningful', async () => {
  const { store, dir } = await buildStore();
  try {
    const chunks = store.searchVector(await fakeEmbedder(['cover']).then((v) => v[0]), { embedModel: 'fake-64', limit: 100 });
    console.log('corpus chunks:', chunks.length);
    assert.ok(chunks.length >= 20, `expected a corpus of 20+ chunks, got ${chunks.length}`);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recall@8 over four wordings: mechanics only, because the offline embedder has no semantics', async () => {
  // The design's target is recall@8 >= 0.90 measured with the real embedder. This harness uses a word-hash vector, so it
  // cannot know that "report a loss" means "tell us within 30 days": it measures the ranking machinery, not semantics.
  // The floor below catches regressions; the real number comes from scripts/knowledge-cli.js against Voyage.
  const { store, dir } = await buildStore();
  try {
    const value = await recall(store, 8, { useRerank: true });
    console.log('recall@8 four wordings (word-hash embedder):', value.toFixed(2));
    assert.ok(value >= 0.7, 'recall@8 regressed to ' + value);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the reranker does not make top-3 worse and usually lifts it', async () => {
  const { store, dir } = await buildStore();
  try {
    const plain = await recall(store, 3, { useRerank: false });
    const reranked = await recall(store, 3, { useRerank: true });
    console.log('recall@3 fused vs reranked:', plain.toFixed(2), reranked.toFixed(2));
    assert.ok(reranked >= plain, 'reranking must not regress');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a reranker that returns the wrong number of scores is refused', async () => {
  await assert.rejects(
    () => rerank({ query: 'q', candidates: [{ id: 'a', text: 'x', hybridScore: 1 }], reranker: () => [1, 2] }),
    /reranker returned 2 scores for 1 candidates/,
  );
});
