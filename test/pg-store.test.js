'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { PgliteRunner } = require('../src/pg/runners');
const { PostgresStore } = require('../src/pg/postgresStore');
const { ROW_COLLECTIONS, KV_COLLECTIONS, DOC_COLLECTIONS, INDEXES, tableFor, kvTableFor } = require('../src/pg/schema');
const { empty } = require('../src/store');

// The database back end (docs/PERFORMANCE.md). PGlite is the real PostgreSQL engine compiled to WebAssembly, so these
// tests run the actual SQL — no server, no Docker, nothing to install on the machine. Production uses the `pg` driver
// against a real server; the store talks to both through the same small runner interface (src/pg/runners.js).

function world(options = {}) {
  const db = new PGlite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pg-'));
  const store = new PostgresStore(new PgliteRunner(db), { walFile: path.join(dir, 'wal.log'), ...options });
  return { db, dir, store };
}

// A store is synchronous on purpose: the services call store.transaction() and use the result at once. The rows are
// written right after, and tests wait for that with drain().
async function rows(db, sql) {
  return (await db.query(sql)).rows;
}

test('a record becomes one row, not part of one large document', async () => {
  const { db, store } = world();
  await store.load();
  store.transaction(() => store.data.accounts.push({ id: 'acc1', accountNumber: 'A0000001', lastName: 'Rivera' }));
  await store.drain();

  const accountRows = await rows(db, 'select id, doc from pc_accounts');
  assert.equal(accountRows.length, 1);
  assert.equal(accountRows[0].id, 'acc1');
  assert.equal(accountRows[0].doc.lastName, 'Rivera');
  assert.equal(store.stats.saves, 1);
  await store.close();
});

test('only the rows that changed are written', async () => {
  const { store } = world();
  await store.load();
  store.transaction(() => store.data.policies.push({ id: 'pol1', status: 'Active' }, { id: 'pol2', status: 'Active' }));
  const first = store.stats.rowsWritten;
  store.transaction(() => { store.data.policies.find((p) => p.id === 'pol2').status = 'Cancelled'; });
  store.transaction(() => { store.data.policies.find((p) => p.id === 'pol2').status = 'Expired'; });
  await store.drain();

  assert.equal(first, 2, 'two new records, two rows');
  assert.equal(store.stats.rowsWritten - first, 2, 'one row per change, not the whole collection again');
  assert.equal(store.stats.saves, 3);
  await store.close();
});

test('a change deep inside a record is saved', async () => {
  const { db, store } = world();
  await store.load();
  store.transaction(() => store.data.policies.push({ id: 'pol1', versions: [], history: [] }));
  store.transaction(() => { store.data.policies[0].versions.push({ versionId: 'ver2' }); });
  store.transaction(() => { store.data.policies[0].history.push({ activity: 'Renewed', by: 'agent' }); });
  await store.drain();

  const [row] = await rows(db, "select doc from pc_policies where id = 'pol1'");
  assert.equal(row.doc.versions.length, 1);
  assert.equal(row.doc.history[0].activity, 'Renewed');
  await store.close();
});

test('a commit writes the value it committed, even if the record changes before the write runs', async () => {
  // The pending frame holds the records it committed. If it held live references, a change made after the commit (and
  // outside any unit of work, so nothing is watching) would be written as if it belonged to that commit. That aliasing
  // once made a broken password change look saved, which is how it was found.
  const { db, store } = world();
  await store.load();
  store.transaction(() => store.data.accounts.push({ id: 'acc1', lastName: 'First' }));
  store.raw.accounts[0].lastName = 'Second'; // after the commit, before the flush, invisible to the watcher
  await store.drain();

  const [row] = await rows(db, "select doc from pc_accounts where id = 'acc1'");
  assert.equal(row.doc.lastName, 'First', 'the frame must carry the value that was committed');
  await store.close();
});

test('a removed record is deleted from the database, not just from memory', async () => {
  const { db, store } = world();
  await store.load();
  store.transaction(() => store.data.accounts.push({ id: 'acc1' }, { id: 'acc2' }));
  store.transaction(() => { store.data.accounts.splice(0, 1); });
  await store.drain();

  assert.deepEqual((await rows(db, 'select id from pc_accounts')).map((r) => r.id), ['acc2']);
  await store.close();
});

test('a failed unit of work leaves neither memory nor the database changed', async () => {
  const { db, store } = world();
  await store.load();
  store.transaction(() => store.data.accounts.push({ id: 'acc1', balance: 10 }));

  assert.throws(() => store.transaction(() => {
    store.data.accounts[0].balance = 999;
    store.data.accounts.push({ id: 'acc2' });
    throw new Error('something went wrong later in the unit of work');
  }), /something went wrong/);

  assert.equal(store.data.accounts.length, 1, 'memory is rolled back');
  assert.equal(store.data.accounts[0].balance, 10);
  await store.drain();
  const stored = await rows(db, 'select id, doc from pc_accounts');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].doc.balance, 10);
  await store.close();
});

test('a second process (a restart) finds the book in the database', async () => {
  const { db, store } = world();
  await store.load();
  store.transaction(() => {
    store.data.accounts.push({ id: 'acc1', lastName: 'Rivera' });
    store.data.policies.push({ id: 'pol1', accountId: 'acc1', status: 'Active' });
  });
  await store.drain();
  await store.close();

  const reopened = new PostgresStore(new PgliteRunner(db), { walFile: null });
  await reopened.load();
  assert.equal(reopened.data.accounts.length, 1);
  assert.equal(reopened.data.policies.length, 1);
  assert.equal(reopened.data.accounts[0].lastName, 'Rivera');
  assert.equal(reopened.isEmpty(), false);
  await reopened.close();
});

test('the counters that make ids and numbers survive a restart', async () => {
  const { db, store } = world();
  await store.load();
  const first = store.transaction(() => store.id('pol'));
  const second = store.transaction(() => store.number('INV-', 7));
  await store.drain();
  await store.close();

  const reopened = new PostgresStore(new PgliteRunner(db), { walFile: null });
  await reopened.load();
  assert.equal(reopened.transaction(() => reopened.id('pol')), 'pol2', `was ${first} then ${second}`);
  assert.equal(reopened.transaction(() => reopened.number('INV-', 7)), 'INV-0000002');
  await reopened.close();
});

test('settings held as objects survive, and a removed key stays removed', async () => {
  const { db, store } = world();
  await store.load();
  store.transaction(() => { store.data.agentConfig.renewal = { mode: 'suggest', maxDaysBeforeEnd: 90 }; });
  store.transaction(() => { store.data.idempotency['u|key:/tickets'] = { status: 200, at: 1 }; });
  store.transaction(() => { delete store.data.idempotency['u|key:/tickets']; });
  await store.drain();

  assert.deepEqual(await rows(db, "select key from pc_kv_idempotency where key = 'u|key:/tickets'"), []);
  const [cfg] = await rows(db, "select doc from pc_kv_agent_config where key = 'renewal'");
  assert.equal(cfg.doc.maxDaysBeforeEnd, 90);
  await store.close();
});

test('a commit is on disk before the database write: the write-ahead log replays it after a crash', async () => {
  const { db, dir } = world();
  const crashed = new PostgresStore(new PgliteRunner(db), { walFile: path.join(dir, 'wal.log'), autoFlush: false });
  await crashed.load();
  crashed.transaction(() => crashed.data.accounts.push({ id: 'acc1', lastName: 'Rivera' }));
  crashed.transaction(() => crashed.data.accounts[0].lastName = 'Riviera');
  // The process dies here: the rows never reached the database.
  assert.equal((await rows(db, 'select count(*)::int as n from pc_accounts'))[0].n, 0);
  await crashed.close();

  const restarted = new PostgresStore(new PgliteRunner(db), { walFile: path.join(dir, 'wal.log') });
  await restarted.load(); // replays what the log holds
  const stored = await rows(db, 'select doc from pc_accounts');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].doc.lastName, 'Riviera');
  await restarted.close();
});

test('after a normal flush the log is empty, so it cannot grow for ever', async () => {
  const { dir, store } = world();
  await store.load();
  store.transaction(() => store.data.accounts.push({ id: 'acc1' }));
  await store.drain();
  assert.equal(fs.readFileSync(path.join(dir, 'wal.log'), 'utf8'), '');
  await store.close();
});

test('the searches the app makes have indexes, and collections with a fixed shape have tables', async () => {
  const { db, store } = world();
  await store.load();
  const names = new Set((await rows(db, 'select indexname from pg_indexes')).map((r) => r.indexname));
  for (const index of INDEXES) assert.ok(names.has(index.name), `${index.name} is missing`);

  const tables = new Set((await rows(db, "select tablename from pg_tables where schemaname = 'public'")).map((r) => r.tablename));
  for (const collection of Object.keys(ROW_COLLECTIONS)) assert.ok(tables.has(tableFor(collection)), `${tableFor(collection)} is missing`);
  for (const collection of KV_COLLECTIONS) assert.ok(tables.has(kvTableFor(collection)), `${kvTableFor(collection)} is missing`);
  assert.ok(tables.has('pc_docs'), 'pc_docs is missing');
  await store.close();
});

test('every collection the JSON store knows about has a place in the database', () => {
  const known = new Set([...Object.keys(ROW_COLLECTIONS), ...KV_COLLECTIONS, ...DOC_COLLECTIONS]);
  for (const key of Object.keys(empty())) assert.ok(known.has(key), `${key} was added to src/store.js but not to src/pg/schema.js`);
});

test('a database that is gone makes the store report itself degraded instead of crashing the server', async () => {
  const { db, store } = world();
  await store.load();
  await db.close();

  store.transaction(() => store.data.accounts.push({ id: 'acc1' }));
  await store.drain();
  assert.ok(store.degraded, 'the store must say it is degraded');
  assert.equal(store.data.accounts.length, 1, 'the request that was already served still holds its data in memory');
  await store.close();
});

test('the change watcher is only in place during a unit of work, so reads pay nothing extra', async () => {
  const { store } = world();
  await store.load();
  store.transaction(() => store.data.accounts.push({ id: 'acc1', lastName: 'Rivera' }));

  const outside = store.data;
  let inside = null;
  store.transaction(() => {
    inside = store.data;
    inside.accounts[0].lastName = 'Riviera';
  });

  assert.notEqual(inside, outside, 'inside a unit of work the data is watched');
  assert.equal(store.data, outside, 'outside it is the plain data');
  await store.drain();
  const { rows } = await store.runner.query("select doc from pc_accounts where id = 'acc1'");
  assert.equal(rows[0].doc.lastName, 'Riviera', 'a change made inside is still saved');
  await store.close();
});
