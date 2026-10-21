'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');
const { createKnowledgeService } = require('../src/knowledge/serve');

// The service the API and the chatbot call: retrieval, answer, and the log, with the audience applied before ranking.

const embed = () => [[1, 0, 0]];

function fakeClaude(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push(request);
        return { content: [{ type: 'text', text: reply }] };
      },
    },
  };
}

function seed(store) {
  store.addDocument({ id: 'd', title: 'Wording', source: 'fixture' });
  store.addVersion({ id: 'v', documentId: 'd', version: 1, validFrom: '2026-01-01' });
  const base = { versionId: 'v', documentId: 'd', headingPath: 'Section 1 > HO-1.1', page: 1, product: 'Homeowners', language: 'en', embedModel: 'voyage-4', validFrom: '2026-01-01', embedding: [1, 0, 0] };
  store.addChunk({ ...base, id: 'c1', clause: 'HO-1.1', text: 'We cover the dwelling and attached structures.', audience: 'underwriting' });
  store.addChunk({ ...base, id: 'c2', clause: 'HO-9.9', text: 'Manager-only claims guidance about dwelling payouts.', audience: 'manager' });
}

function withService(fn, reply = 'We cover the dwelling [1].') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-serve-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  seed(store);
  const client = fakeClaude(reply);
  const service = createKnowledgeService({ store, embedModel: 'voyage-4', embedder: embed, client });
  return Promise.resolve(fn({ service, store, client }))
    .finally(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
}

test('an answer carries its citations with the clause a reader can look up', () =>
  withService(async ({ service }) => {
    const result = await service.ask({ id: 'u1', role: 'Underwriter' }, 'What does the policy cover?');
    assert.equal(result.status, 'answered');
    assert.deepEqual(result.citations, [{ number: 1, clause: 'HO-1.1', headingPath: 'Section 1 > HO-1.1', page: 1 }]);
    assert.ok(result.answer.length > 0);
  }));

test('a manager-level passage is never sent to the model for an underwriter', () =>
  withService(async ({ service, client }) => {
    await service.ask({ id: 'u1', role: 'Underwriter' }, 'dwelling cover');
    const sent = JSON.stringify(client.calls[0]);
    assert.equal(sent.includes('Manager-only claims guidance'), false, 'the manager clause reached the model');
    assert.equal(sent.includes('HO-9.9'), false);
  }));

test('the manager does see it, which proves the filter is the difference', () =>
  withService(async ({ service, client }) => {
    await service.ask({ id: 'u2', role: 'UW Manager' }, 'dwelling cover');
    assert.match(JSON.stringify(client.calls[0]), /HO-9\.9/);
  }));

test('the query log stores the masked question, the role and the outcome', () =>
  withService(async ({ service, store }) => {
    await service.ask({ id: 'u1', role: 'Underwriter' }, 'My Aadhaar is 1234 5678 9012, is the dwelling covered?');
    const [row] = store.getQueryLog(1);
    assert.equal(row.question.includes('1234'), false);
    assert.match(row.question, /\[AADHAAR\]/);
    assert.equal(row.role, 'Underwriter');
    assert.equal(row.audience, 'public,agent,underwriting');
    assert.equal(row.status, 'answered');
    assert.ok(row.latency_ms >= 0);
  }));

test('search returns numbered passages without asking the model', () =>
  withService(async ({ service, client }) => {
    const rows = await service.search({ id: 'u1', role: 'Underwriter' }, 'dwelling cover');
    assert.equal(client.calls.length, 0, 'search does not call Claude');
    assert.equal(rows[0].number, 1);
    assert.equal(rows[0].clause, 'HO-1.1');
  }));
