'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { PgliteRunner } = require('../src/pg/runners');
const { PostgresStore } = require('../src/pg/postgresStore');
const { PolicyCenter } = require('../src/policyCenter');
const { seed } = require('../src/seed');
const { account } = require('./helpers');
const { Store } = require('../src/store');
const { resetManagerPassword } = require('../src/resetManager');

// The reset-demo-data button (POST /api/admin/reset). It used to leave the app with no staff, so reseeding failed with
// "Unknown user 'agent'" and the book stayed empty. These tests pin the repair on both stores.

test('reset puts the built-in team back before the demo data is seeded (JSON store)', () => {
  // The seed lays the demo history out around the real today, so this test uses the real clock like the server does.
  const store = new Store();
  const pc = new PolicyCenter(store);
  store.transaction(() => account(pc, pc.user('agent')));
  assert.equal(store.data.staff.length, 7);

  store.transaction(() => {
    store.reset();
    pc.seedStaff();
    seed(pc);
  });

  assert.equal(store.data.staff.length, 7, 'the app can be signed in to again');
  assert.ok(store.data.accounts.length > 0, 'the demo data came back');
  assert.equal(store.isEmpty(), false);
});

test('reset clears the database and seeds the demo book into it (PostgreSQL store)', async () => {
  const db = new PGlite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reset-'));
  const store = new PostgresStore(new PgliteRunner(db), { walFile: path.join(dir, 'wal.log') });
  await store.load();
  const pc = new PolicyCenter(store);
  store.transaction(() => account(pc, pc.user('agent')));
  await store.drain();

  store.transaction(() => {
    store.reset();
    pc.seedStaff();
    seed(pc);
  });
  await store.drain();

  const count = async (table) => (await store.runner.query(`select count(*)::int as n from ${table}`)).rows[0].n;
  assert.equal(await count('pc_staff'), 7);
  assert.ok(await count('pc_accounts') > 0);
  assert.equal(await count('pc_policies') > 0, true);
  await store.close();
});

test('a reset that fails afterwards leaves the old book as it was', async () => {
  const db = new PGlite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reset-'));
  const store = new PostgresStore(new PgliteRunner(db), { walFile: path.join(dir, 'wal.log') });
  await store.load();
  const pc = new PolicyCenter(store);
  store.transaction(() => account(pc, pc.user('agent')));
  const before = store.data.accounts.length;

  assert.throws(() => store.transaction(() => {
    store.reset();
    pc.seedStaff();
    throw new Error('the seed failed');
  }), /the seed failed/);

  assert.equal(store.data.accounts.length, before, 'memory is back');
  await store.drain();
  const { rows } = await store.runner.query('select count(*)::int as n from pc_accounts');
  assert.equal(rows[0].n, before, 'and nothing was truncated in the database');
  await store.close();
});

test('a lost manager password can be reset on either store', async () => {
  // The JSON store.
  const plain = new Store();
  const pc = new PolicyCenter(plain);
  const before = pc.db.staff.find((person) => person.role === 'UW Manager').passwordHash;
  const one = await resetManagerPassword(plain);
  assert.ok(one.password.length >= 8);
  assert.notEqual(plain.data.staff.find((person) => person.username === one.username).passwordHash, before);
  assert.equal(plain.data.staff.find((person) => person.username === one.username).mustChangePassword, true);

  // The database store: the new hash must actually reach the database, or a lost password stays lost.
  const db = new PGlite();
  const store = new PostgresStore(new PgliteRunner(db), { walFile: null });
  await store.load();
  const two = await resetManagerPassword(store);
  await store.drain();
  const { rows } = await store.runner.query('select doc from pc_staff where doc->>\'username\' = $1', [two.username]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].doc.passwordHash, 'a password hash is stored');
  assert.equal(rows[0].doc.mustChangePassword, true);
  assert.equal(rows[0].doc.username, two.username);
  await store.close();
});
