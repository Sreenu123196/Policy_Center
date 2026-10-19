'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChangeTracker } = require('../src/pg/changeTracker');

// The move to PostgreSQL (docs/PERFORMANCE.md) needs to know what changed without serializing the whole book on every
// write. The services do not announce their changes, so the tracker watches the data: these tests pin what it notices,
// and — just as important — that it can undo a unit of work exactly.

const shape = { accounts: 'rows', policies: 'rows', seq: 'kv', agentConfig: 'kv', finance: 'kv' };

function world() {
  const raw = { accounts: [], policies: [], seq: {}, agentConfig: {}, finance: {} };
  const tracker = new ChangeTracker(shape);
  return { raw, tracker, data: tracker.track(raw) };
}

test('reading the data does not count as a change', () => {
  const { tracker, data } = world();
  tracker.begin();
  data.accounts.push({ id: 'acc1', lastName: 'Rivera' });
  tracker.end();

  tracker.begin();
  const found = data.accounts.find((a) => a.id === 'acc1');
  found.lastName.toUpperCase();
  JSON.stringify(data);
  const changes = tracker.end();

  assert.equal(changes.rows.size, 0, 'reads must not mark anything dirty');
  assert.equal(changes.kv.size, 0);
});

test('a field written on a row marks that row and no other', () => {
  const { tracker, data } = world();
  data.accounts.push({ id: 'acc1', balance: 0 }, { id: 'acc2', balance: 0 });

  tracker.begin();
  data.accounts[0].balance = 25.5;
  const changes = tracker.end();

  assert.deepEqual([...changes.rows.get('accounts').keys()], ['acc1']);
  assert.equal(changes.rows.get('accounts').get('acc1').balance, 25.5);
});

test('a change deep inside a row (a nested list) marks the row it belongs to', () => {
  const { tracker, data } = world();
  data.policies.push({ id: 'pol1', versions: [], rating: { factors: [] } });

  tracker.begin();
  data.policies[0].versions.push({ versionId: 'ver2' });
  data.policies[0].rating.factors.push({ code: 'AGE' });
  const changes = tracker.end();

  assert.deepEqual([...changes.rows.get('policies').keys()], ['pol1']);
  assert.equal(changes.rows.get('policies').get('pol1').versions.length, 1);
  assert.equal(changes.rows.get('policies').get('pol1').rating.factors.length, 1);
});

test('a pushed row is marked as new, and the collection counts as restructured', () => {
  const { tracker, data } = world();
  tracker.begin();
  data.accounts.push({ id: 'acc1' });
  const changes = tracker.end();

  assert.ok(changes.rows.get('accounts').has('acc1'));
  assert.ok(changes.structural.has('accounts'));
});

test('the tracker is invisible to the code: same identity, same JSON', () => {
  const { raw, data } = world();
  data.accounts.push({ id: 'acc1', lastName: 'Rivera', tags: ['vip'] });

  assert.equal(data.accounts[0], data.accounts[0], 'the same object must come back every time (code compares with ===)');
  assert.ok(Array.isArray(data.accounts), 'Array.isArray must still hold');
  assert.equal(JSON.stringify(data.accounts), JSON.stringify(raw.accounts));
  assert.equal(raw.accounts[0].lastName, 'Rivera', 'writes must land on the raw data, not on a copy');
});

test('rollback puts back a changed field and a nested list', () => {
  const { raw, tracker, data } = world();
  data.accounts.push({ id: 'acc1', balance: 0, tags: ['a'] });

  tracker.begin();
  data.accounts[0].balance = 99;
  data.accounts[0].tags.push('b');
  data.accounts[0].newField = true;
  tracker.rollback();

  assert.equal(raw.accounts[0].balance, 0);
  assert.deepEqual(raw.accounts[0].tags, ['a']);
  assert.equal('newField' in raw.accounts[0], false, 'a field added in the failed unit of work must be gone');
});

test('rollback removes an inserted row and brings back a removed one', () => {
  const { raw, tracker, data } = world();
  raw.accounts.push({ id: 'acc1' }, { id: 'acc2' });

  tracker.begin();
  data.accounts.push({ id: 'acc3' });
  data.accounts.splice(0, 1);
  tracker.rollback();

  assert.deepEqual(raw.accounts.map((a) => a.id), ['acc1', 'acc2']);
});

test('a key/value collection marks the key that was written or removed', () => {
  const { raw, tracker, data } = world();
  data.seq['id:acc'] = 5;

  tracker.begin();
  data.seq['id:acc'] = 6;
  data.agentConfig.renewal = { mode: 'suggest' };
  delete data.finance.commissionRate;
  const changes = tracker.end();

  assert.equal(changes.kv.get('seq').get('id:acc'), 6);
  assert.equal(changes.kv.get('agentConfig').get('renewal').mode, 'suggest');
  assert.ok(changes.kv.get('finance').has('commissionRate'), 'a removed key must still be reported');
  assert.equal(raw.finance.commissionRate, undefined);
});

test('a write made outside a unit of work is not recorded, and does not leak into the next one', () => {
  const { tracker, data } = world();
  data.seq.outside = 1; // no begin(): nothing is watching

  tracker.begin();
  data.seq.inside = 2;
  const changes = tracker.end();

  assert.deepEqual([...changes.kv.get('seq').keys()], ['inside']);
});
