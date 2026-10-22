'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');
const { ingestVersion } = require('../src/knowledge/ingest');
const { checkDrift, hashText } = require('../src/knowledge/drift');

// The nightly question: did a document change and the index not? Tests pass text directly, the same path a content
// repository would take.

// The real fixture, because the splitter's rules are the ones that matter here - a synthetic wording that produces no
// chunks would test nothing.
const TEXT = fs.readFileSync(path.join(__dirname, 'fixtures/knowledge/sample-home-wording.md'), 'utf8');
const META = { audience: 'underwriting', product: 'Homeowners', language: 'en', sensitivity: 'internal', validFrom: '2026-01-01' };
const embedder = async (texts) => texts.map(() => [1, 0, 0]);

async function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-drift-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  try { return await fn(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const ingest = (store, text) => ingestVersion({
  store, embedder, embedModel: 'voyage-4',
  document: { id: 'home', title: 'Homeowners', source: 'fixture' },
  version: { id: 'v1', version: 1, validFrom: '2026-01-01' }, text, metadata: META,
});

test('an unchanged source is current', () =>
  withStore(async (store) => {
    await ingest(store, TEXT);
    const report = checkDrift({ store, sources: [{ documentId: 'home', text: TEXT }] });
    assert.equal(report.checked, 1);
    assert.deepEqual(report.drifted, []);
    assert.equal(report.rows[0].status, 'current');
  }));

test('a changed source is reported', () =>
  withStore(async (store) => {
    await ingest(store, TEXT);
    const amended = TEXT.replace('2,500', '5,000');
    const report = checkDrift({ store, sources: [{ documentId: 'home', text: amended }] });
    assert.deepEqual(report.drifted, ['home']);
    assert.equal(report.rows[0].status, 'changed');
  }));

test('a document that was never indexed is reported as not indexed', () =>
  withStore(async (store) => {
    const report = checkDrift({ store, sources: [{ documentId: 'unknown', text: TEXT }] });
    assert.equal(report.rows[0].status, 'not-indexed');
    assert.deepEqual(report.drifted, ['unknown']);
  }));

test('whitespace and line endings are not drift', () =>
  withStore(async (store) => {
    await ingest(store, TEXT);
    const reformatted = TEXT.replace(/\n/g, '\r\n').replace(/^## /gm, '##   ');
    assert.equal(hashText(TEXT), hashText(reformatted));
    assert.deepEqual(checkDrift({ store, sources: [{ documentId: 'home', text: reformatted }] }).drifted, []);
  }));
