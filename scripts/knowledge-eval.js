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
  const passagesPerQuestion = Number(argValue('--passages', '8'));
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
  let citedRight = 0;
  let refusedTotal = 0;
  const missReasons = [];
  const rows = [];

  for (const [index, item] of cases.entries()) {
    const scoped = { ...filters };
    const products = detectProducts(item.question);
    if (products.length) scoped.products = products;
    const passages = hybridSearch({
      store, embedModel: MODEL, queryVector: vectors[index], queryText: item.question, limit: passagesPerQuestion, filters: scoped,
    });
    const result = await answerQuestion({ client, question: item.question, passages, language: 'en' });
    const clauses = passages.map((p) => p.clause);

    const expectFound = item.expected_status === 'answered';
    let ok;
    let note = '';
    if (expectFound) {
      // Citation accuracy is a question about answers. A refusal has no citation to be right or wrong about, so it is
      // counted separately instead of being scored as a miss.
      const citedClauses = result.citations.map((n) => clauses[n - 1]).filter(Boolean);
      const hitClause = !item.expected_sources || item.expected_sources.some((c) => citedClauses.includes(c));
      const answered = result.status === 'answered';
      if (answered) {
        answeredTotal += 1;
        if (hitClause) citedRight += 1;
        else {
          const reason = citedClauses.length === 0 ? 'missing (no clause cited)'
            : (citedClauses.length > 1 ? 'too broad (' + citedClauses.join(',') + ')' : 'wrong clause (' + citedClauses.join(',') + ')');
          missReasons.push(item.id + ': ' + reason);
        }
      } else {
        refusedTotal += 1;
      }
      // Compare on the words, not the punctuation or spacing: '2,500' and '2500 dollars' are the same fact.
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u0900-\u097F\u0C00-\u0C7F]+/g, ' ').replace(/\s+/g, ' ').trim();
      const text = norm(result.answer);
      const hitFacts = (item.must_include || []).every((fact) => text.includes(norm(fact)));
      ok = result.status === 'answered' && hitClause && hitFacts;
      if (result.status === 'answered' && hitClause && hitFacts) answeredRight += 1;
      note = ok ? 'correct' : (result.status === 'answered' ? 'wrong or uncited facts' : 'refused an answerable question');
    } else {
      ok = result.status === 'not_found';
      note = ok ? 'correctly not found' : 'answered what it should not';
    }
    if (ok) correct += 1;
    rows.push([item.id, result.status, ok ? 'yes' : 'no', note]);
    console.log(item.id.padEnd(5), result.status.padEnd(11), ok ? 'yes' : 'no ', note);
    if (!ok && note.includes('refused')) console.log('      clauses sent:', clauses.join(','), '| expected', (item.expected_sources || []).join(','));
  }

  console.log('');
  console.log('cases:', cases.length, '| correctness:', correct + '/' + cases.length,
    '(' + Math.round((correct / cases.length) * 100) + '%)');
  if (answeredTotal) console.log('citation accuracy on answered:', citedRight + '/' + answeredTotal,
    '(' + Math.round((citedRight / answeredTotal) * 100) + '%)');
  console.log('answered:', answeredTotal, '| refused:', refusedTotal, '| of', cases.filter((c) => c.expected_status === 'answered').length, 'answerable');
  if (missReasons.length) { console.log('citation misses:'); for (const reason of missReasons) console.log(' ', reason); }
  store.close();
  if (dbFile.includes(os.tmpdir())) fs.rmSync(dbFile, { force: true });
}

main().catch((err) => { console.error('evaluation failed:', err.message); process.exit(1); });
