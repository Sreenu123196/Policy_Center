#!/usr/bin/env node
'use strict';
// Ask the 20 evaluation questions and report how many were answered with correct citations.
//
//   node scripts/knowledge-cli.js --fake     no network, no cost: keyword retrieval + a scripted answerer
//   node scripts/knowledge-cli.js            real Voyage voyage-4 embeddings and real Claude (COSTS MONEY)
//
// The fake mode exists so the pipeline and the scoring can be checked before spending anything. It does not measure
// answer quality: the scripted answerer simply cites the first passage, so a good score there proves the plumbing,
// not the model.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { openKnowledgeStore } = require('../src/knowledge/store');
const { ingestVersion } = require('../src/knowledge/ingest');
const { answerQuestion } = require('../src/knowledge/answer');
const { hybridSearch } = require('../src/knowledge/retrieve');
const { rerank } = require('../src/knowledge/rerank');

require('../src/loadEnv').loadEnv();

const FIXTURE = path.join(__dirname, '../test/fixtures/knowledge/sample-home-wording.md');
const QUESTIONS = path.join(__dirname, '../test/fixtures/knowledge/eval-questions.json');
const DB_PATH = process.env.KNOWLEDGE_DB || 'D:\\PolicyCenter-Knowledge\\knowledge.db';
const MODEL = 'voyage-4';

function postJson(host, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host, path: urlPath, method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
    (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, body: raw })); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function voyageEmbed(texts, inputType, attempt = 1) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is not set');
  const res = await postJson('api.voyageai.com', '/v1/embeddings', { authorization: 'Bearer ' + key },
    { model: MODEL, input: texts, input_type: inputType });
  if (res.status === 429 && attempt <= 3) {
    const wait = 21000; // the free tier allows 3 requests a minute; one batch per window
    console.log(`  voyage rate limit hit; waiting ${Math.round(wait / 1000)}s (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, wait));
    return voyageEmbed(texts, inputType, attempt + 1);
  }
  if (res.status !== 200) throw new Error('voyage ' + res.status + ': ' + res.body.slice(0, 200));
  return JSON.parse(res.body).data.map((d) => d.embedding);
}

function anthropicClient() {
  const AnthropicSDK = require('@anthropic-ai/sdk');
  const Anthropic = AnthropicSDK.default || AnthropicSDK;
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
  return { messages: { create: (req) => client.messages.create(req) } };
}

// Fake mode: deterministic vectors (so ingest works) and a scripted answerer that always cites passage 1.
const fakeEmbedder = async (texts) => texts.map((text) => {
  const v = new Array(64).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 64;
    v[h] += 1;
  }
  return v;
});
const fakeClaude = {
  messages: {
    create: async (request) => {
      const first = request.messages[0].content.find((b) => b.type === 'search_result');
      const text = first ? first.content[0].text.split(/(?<=[.!?])\s+/)[0] : 'I could not find that in the documents.';
      return { content: [{ type: 'text', text: text + ' [1]' }] };
    },
  },
};

function score(question, result, passages) {
  const clauses = passages.map((p) => p.clause).filter(Boolean);
  const answered = result.status === 'answered';
  if (question.expected_status === 'not_found') {
    return { correct: !answered, why: answered ? 'answered a question the wording cannot answer' : 'correctly not found' };
  }
  if (!answered) return { correct: false, why: 'not answered' };
  const cited = result.citations.map((n) => passages[n - 1]).filter(Boolean);
  const citedClauses = cited.map((p) => p.clause).filter(Boolean);
  const sourcesOk = question.expected_sources.every((c) => citedClauses.includes(c));
  const text = result.answer.toLowerCase();
  const includeOk = question.must_include.every((word) => text.includes(word.toLowerCase()));
  const why = !sourcesOk ? 'wrong source cited' : !includeOk ? 'required wording missing' : 'correct';
  return { correct: sourcesOk && includeOk, why };
}

// --recall: ingest the four fictional wordings with the REAL embedder and report recall@3 and recall@8, with and
// without the reranker. No Claude calls, so it costs only the embedding tokens.
async function measureRecall() {
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, 'knowledge-recall.db');
  if (fs.existsSync(dbFile)) fs.rmSync(dbFile);
  const store = openKnowledgeStore(dbFile);
  const files = [
    ['sample-home-wording.md', 'Homeowners', 'home'],
    ['sample-personal-auto-wording.md', 'PersonalAuto', 'auto'],
    ['sample-commercial-property-wording.md', 'CommercialProperty', 'commercial'],
    ['sample-workers-comp-wording.md', 'WorkersComp', 'workers'],
  ];
  for (const [file, product, tag] of files) {
    const text = fs.readFileSync(path.join(__dirname, '../test/fixtures/knowledge', file), 'utf8');
    await ingestVersion({
      store, embedder: (texts) => voyageEmbed(texts, 'document'), embedModel: MODEL,
      document: { id: tag, title: file, source: file },
      version: { id: 'v-' + tag, version: 1, validFrom: '2026-01-01' },
      text,
      metadata: { audience: 'underwriting', product, language: 'en', sensitivity: 'internal', validFrom: '2026-01-01' },
    });
    console.log('ingested', product);
  }

  const { questions } = JSON.parse(fs.readFileSync(QUESTIONS, 'utf8'));
  const answerable = questions.filter((q) => q.expected_status === 'answered');
  const vectors = await voyageEmbed(answerable.map((q) => q.question), 'query');

  const overlap = (query, candidates) => {
    const words = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    return candidates.map((c) => [...words].filter((w) => c.text.toLowerCase().includes(w)).length);
  };

  for (const k of [3, 8]) {
    let plain = 0;
    let reranked = 0;
    for (const [index, question] of answerable.entries()) {
      const fused = hybridSearch({ store, embedModel: MODEL, queryVector: vectors[index], queryText: question.question, limit: 30 });
      const topPlain = fused.slice(0, k);
      const topReranked = await rerank({ query: question.question, candidates: fused, reranker: overlap, topN: k });
      const hit = (rows) => question.expected_sources.some((clause) => rows.map((r) => r.clause).includes(clause));
      if (hit(topPlain)) plain += 1;
      if (hit(topReranked)) reranked += 1;
    }
    console.log('recall@' + k + ' fused: ' + (plain / answerable.length).toFixed(2) + ' | reranked: ' + (reranked / answerable.length).toFixed(2));
  }
  store.close();
}

async function main() {
  if (process.argv.includes('--recall')) {
    await measureRecall();
    return 20;
  }
  const fake = process.argv.includes('--fake');
  const { questions } = JSON.parse(fs.readFileSync(QUESTIONS, 'utf8'));
  const text = fs.readFileSync(FIXTURE, 'utf8');

  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = fake ? path.join(dir, 'knowledge-cli-fake.db') : DB_PATH;
  if (fake && fs.existsSync(dbFile)) fs.rmSync(dbFile);
  const store = openKnowledgeStore(dbFile);

  const embedder = fake ? fakeEmbedder : (texts) => voyageEmbed(texts, 'document');
  const client = fake ? fakeClaude : anthropicClient();
  const stamp = Date.now();
  await ingestVersion({
    store, embedder, embedModel: fake ? 'fake-64' : MODEL,
    document: { id: 'sample-home', title: 'Sample Homeowners Wording', source: 'test/fixtures/knowledge/sample-home-wording.md' },
    version: { id: 'v-' + stamp, version: 1, validFrom: '2026-01-01' },
    text,
    metadata: { audience: 'underwriting', product: 'Homeowners', language: 'en', sensitivity: 'internal', validFrom: '2026-01-01' },
  });

  // One batch for every question: the free tier allows 3 requests a minute, so per-question calls would 429.
  const queryVectors = fake ? null : await voyageEmbed(questions.map((q) => q.question), 'query');

  let correct = 0;
  const rows = [];
  for (const [index, question] of questions.entries()) {
    let passages;
    if (fake) {
      const keyword = question.question.split(/\s+/).filter((w) => w.length > 6)[0] || question.question.split(/\s+/)[0];
      passages = store.searchKeyword(keyword, { limit: 3 });
      if (!passages.length) passages = store.searchKeyword('cover', { limit: 3 });
    } else {
      passages = store.searchVector(queryVectors[index], { embedModel: MODEL, limit: 3 });
    }
    const result = await answerQuestion({ client, question: question.question, passages });
    const judged = score(question, result, passages);
    if (judged.correct) correct += 1;
    rows.push({ id: question.id, status: result.status, correct: judged.correct ? 'yes' : 'no', why: judged.why });
  }

  store.close();
  console.log('mode:', fake ? 'FAKE (no network, no cost)' : 'REAL (Voyage + Claude)');
  console.log('questions:', questions.length, '| correct:', correct, '(' + Math.round((correct / questions.length) * 100) + '%)');
  console.log('');
  console.log('id    status       correct  note');
  for (const row of rows) console.log(row.id.padEnd(5), row.status.padEnd(12), row.correct.padEnd(8), row.why);
  return correct;
}

if (require.main === module) {
  main().then((correct) => { process.exitCode = correct > 0 ? 0 : 1; }).catch((err) => { console.error('failed:', err.message); process.exitCode = 1; });
}

module.exports = { score, fakeEmbedder };
