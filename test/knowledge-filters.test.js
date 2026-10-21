'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKnowledgeStore } = require('../src/knowledge/store');
const { hybridSearch } = require('../src/knowledge/retrieve');

// R2: the access filter and the date filter, applied before ranking. The leak tests must score zero - a passage the
// person may not see must never appear, and must never influence what does appear.

const embed = (seed) => [seed, 1 - seed, 0.5];

function seedStore(store) {
  store.addDocument({ id: 'home', title: 'Homeowners v1', source: 'fixture' });
  store.addVersion({ id: 'home-v1', documentId: 'home', version: 1, validFrom: '2026-01-01', validTo: '2027-01-01' });
  store.addVersion({ id: 'home-v2', documentId: 'home', version: 2, validFrom: '2027-01-01' });
  store.addDocument({ id: 'internal', title: 'Claims guidance', source: 'fixture' });
  store.addVersion({ id: 'internal-v1', documentId: 'internal', version: 1, validFrom: '2026-01-01' });

  store.addChunk({
    id: 'c-public-1', versionId: 'home-v1', documentId: 'home', headingPath: 'Section 1 > HO-1.1', clause: 'HO-1.1',
    page: 1, text: 'We cover the dwelling and attached structures.', audience: 'underwriting', product: 'Homeowners',
    language: 'en', sensitivity: 'internal', embedModel: 'voyage-4', embedding: embed(0.9),
    validFrom: '2026-01-01', validTo: '2027-01-01',
  });
  store.addChunk({
    id: 'c-public-2', versionId: 'home-v2', documentId: 'home', headingPath: 'Section 1 > HO-1.1', clause: 'HO-1.1',
    page: 1, text: 'We cover the dwelling, attached structures and permanently installed fixtures.', audience: 'underwriting',
    product: 'Homeowners', language: 'en', sensitivity: 'internal', embedModel: 'voyage-4', embedding: embed(0.9),
    validFrom: '2027-01-01', validTo: null,
  });
  store.addChunk({
    id: 'c-claims-hidden', versionId: 'internal-v1', documentId: 'internal', headingPath: 'Claims > CL-1', clause: 'CL-1',
    page: 1, text: 'Dwelling claim payout guidance: approve up to 50,000 without referral.', audience: 'claims',
    product: 'Homeowners', language: 'en', sensitivity: 'restricted', embedModel: 'voyage-4', embedding: embed(0.95),
    validFrom: '2026-01-01', validTo: null,
  });
}

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-filters-'));
  const store = openKnowledgeStore(path.join(dir, 'knowledge.db'));
  seedStore(store);
  try { return fn(store); } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const UNDERWRITING = { audiences: ['underwriting'] };

test('a passage for another audience is never returned, even though it ranks highest', () =>
  withStore((store) => {
    const visible = hybridSearch({
      store, embedModel: 'voyage-4', queryVector: embed(1), queryText: 'dwelling claim payout guidance',
      limit: 10, filters: UNDERWRITING,
    });
    assert.equal(visible.some((row) => row.audience === 'claims'), false, 'the claims passage leaked');
    assert.ok(visible.every((row) => row.audience === 'underwriting'));
  }));

test('the leak count is zero across many questions', () =>
  withStore((store) => {
    const questions = ['dwelling cover', 'claim payout guidance', 'fixtures', 'limits', 'approve without referral'];
    let leaks = 0;
    for (const question of questions) {
      for (const filters of [UNDERWRITING, { audiences: ['claims'] }]) {
        const rows = hybridSearch({ store, embedModel: 'voyage-4', queryVector: embed(1), queryText: question, limit: 10, filters });
        leaks += rows.filter((row) => !filters.audiences.includes(row.audience)).length;
      }
    }
    assert.equal(leaks, 0, 'filters must apply before ranking, for every audience');
  }));

test('the date filter returns the edition in force on the asked date', () =>
  withStore((store) => {
    const before = hybridSearch({ store, embedModel: 'voyage-4', queryVector: embed(1), queryText: 'dwelling cover', limit: 10, filters: { ...UNDERWRITING, asOf: '2026-06-01' } });
    assert.deepEqual(before.map((row) => row.id), ['c-public-1']);

    const after = hybridSearch({ store, embedModel: 'voyage-4', queryVector: embed(1), queryText: 'dwelling cover', limit: 10, filters: { ...UNDERWRITING, asOf: '2027-06-01' } });
    assert.deepEqual(after.map((row) => row.id), ['c-public-2'], 'the new edition replaces the old one, it is not added to it');
  }));

test('the keyword half respects the same filters', () =>
  withStore((store) => {
    const rows = store.searchKeyword('guidance', { limit: 10, filters: UNDERWRITING });
    assert.equal(rows.length, 0, 'the claims word does not exist for underwriting');
  }));

test('no filters means everything, which is what the tests above are contrasted against', () =>
  withStore((store) => {
    const rows = hybridSearch({ store, embedModel: 'voyage-4', queryVector: embed(1), queryText: 'dwelling claim payout guidance', limit: 10 });
    assert.ok(rows.some((row) => row.audience === 'claims'), 'unfiltered retrieval can see both audiences');
  }));
