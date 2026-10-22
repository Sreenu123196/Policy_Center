'use strict';
// Score the full evaluation set against all four fictional wordings, with the real embedder and the real model.
//
// Separate from knowledge-cli.js because that script asks a handful of questions against one wording to smoke-test the
// pipeline. This one is the measurement section 13 asks for: ingest every fixture, ask every case, compare the answer
// with what the case says must be true.
//
// Usage: node scripts/knowledge-eval.js [--limit N] [--db path]

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
require('../src/loadEnv').loadEnv();

const { openKnowledgeStore } = require('../src/knowledge/store');
const { ingestVersion } = require('../src/knowledge/ingest');
const { hybridSearch } = require('../src/knowledge/retrieve');
const { answerQuestion, NOT_FOUND } = require('../src/knowledge/answer');
const { embed, MODEL } = require('../src/knowledge/voyage');
const { audiencesFor } = require('../src/knowledge/access');
const { detectProducts } = require('../src/knowledge/product');

const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const FIXTURES = [
  ['sample-home-wording.md', 'Homeowners', 'home'],
  ['sample-personal-auto-wording.md', 'PersonalAuto', 'auto'],
  ['sample-commercial-property-wording.md', 'CommercialProperty', 'commercial'],
  ['sample-workers-comp-wording.md', 'WorkersComp', 'workers'],
];
const QUESTIONS = path.join(__dirname, '../test/fixtures/knowledge/eval-questions.json');

const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : fallback;
};

async function main() {
  const dbFile = argValue('--db', path.join(os.tmpdir(), 'knowledge-eval-' + Date.now() + '.db'));
  const limit = Number(argValue('--limit', '0')) || Infinity;
  const store = openKnowledgeStore(dbFile);
  const client = new Anthropic(process.env.ANTHROPIC_WORKSPACE_ID
    ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } } : {});

  for (const [file, product, tag] of FIXTURES) {
    const text = fs.readFileSync(path.join(__dirname, '../test/fixtures/knowledge', file), 'utf8');
    const result = await ingestVersion({
      store,
      embedder: (texts) => embed(texts, 'document'),
      embedModel: MODEL,
      document: { id: tag, title: product, source: file },
      version: { id: 'v-' + tag, version: 1, validFrom: '2026-01-01' },
      text,
      metadata: { audience: 'underwriting', product, language: 'en', sensitivity: 'internal', validFrom: '2026-01-01' },
    });
    console.log('ingested', product, '-', result.chunks, 'chunks');
  }

  const { questions } = JSON.parse(fs.readFileSync(QUESTIONS, 'utf8'));
  const cases = questions.slice(0, limit === Infinity ? undefined : limit);
  const vectors = await embed(cases.map((c) => c.question), 'query');
  const filters = { audiences: audiencesFor({ role: 'Underwriter' }) };

  let correct = 0;
  let answeredRight = 0;
  let answeredTotal = 0;
  let citationsRight = 0;
  const rows = [];

  for (const [index, item] of cases.entries()) {
    const scoped = { ...filters };
    const products = detectProducts(item.question);
    if (products.length) scoped.products = products;
    const passages = hybridSearch({
      store, embedModel: MODEL, queryVector: vectors[index], queryText: item.question, limit: 8, filters: scoped,
    });
    const result = await answerQuestion({ client, question: item.question, passages, language: 'en' });
    const clauses = passages.map((p) => p.clause);

    const expectFound = item.expected_status === 'answered';
    let ok;
    let note = '';
    if (expectFound) {
      answeredTotal += 1;
      const citedClauses = result.citations.map((n) => clauses[n - 1]).filter(Boolean);
      const hitClause = !item.expected_sources || item.expected_sources.some((c) => citedClauses.includes(c));
      const text = String(result.answer).toLowerCase();
      const hitFacts = (item.must_include || []).every((fact) => text.includes(String(fact).toLowerCase()));
      ok = result.status === 'answered' && hitClause && hitFacts;
      if (result.status === 'answered' && hitClause) answeredRight += 1;
      if (hitClause) citationsRight += 1;
      note = ok ? 'correct' : (result.status === 'answered' ? 'wrong or uncited facts' : 'refused an answerable question');
    } else {
      ok = result.status === 'not_found';
      note = ok ? 'correctly not found' : 'answered what it should not';
    }
    if (ok) correct += 1;
    rows.push([item.id, result.status, ok ? 'yes' : 'no', note]);
    console.log(item.id.padEnd(5), result.status.padEnd(11), ok ? 'yes' : 'no ', note);
  }

  console.log('');
  console.log('cases:', cases.length, '| correctness:', correct + '/' + cases.length,
    '(' + Math.round((correct / cases.length) * 100) + '%)');
  if (answeredTotal) console.log('answerable: cited the right clause', citationsRight + '/' + answeredTotal,
    '(' + Math.round((citationsRight / answeredTotal) * 100) + '%)');
  store.close();
  if (dbFile.includes(os.tmpdir())) fs.rmSync(dbFile, { force: true });
}

main().catch((err) => { console.error('evaluation failed:', err.message); process.exit(1); });
