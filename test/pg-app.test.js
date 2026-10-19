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
const { account, autoSubmission } = require('./helpers');

// The whole app on PostgreSQL: the services, the units of work and the proxy that watches them, working together. These
// tests exist because the store change is invisible to the services — a mistake would show up here, not in a unit test.

async function open() {
  const db = new PGlite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-app-'));
  const store = new PostgresStore(new PgliteRunner(db), { walFile: path.join(dir, 'wal.log') });
  await store.load();
  return { db, dir, store };
}

test('the app runs on the database store: an account, a quote and a bound policy survive a restart', async () => {
  const { db, store } = await open();
  const pc = new PolicyCenter(store, { today: () => '2026-03-01' });
  const agent = pc.user('agent');

  const acct = store.transaction(() => account(pc, agent));
  const job = store.transaction(() => autoSubmission(pc, agent, acct, '2026-03-01'));
  store.transaction(() => pc.quote(job.id, agent));
  store.transaction(() => pc.bind(job.id, agent));
  await store.drain();
  await store.close();

  // A new process, same database: everything is where it was.
  const reopened = new PostgresStore(new PgliteRunner(db), { walFile: null });
  await reopened.load();
  const pc2 = new PolicyCenter(reopened);

  assert.equal(pc2.db.accounts.length, 1);
  assert.ok(pc2.db.staff.some((person) => person.id === 'agent'), 'the built-in team is saved too');
  const policy = pc2.db.policies[0];
  assert.match(policy.policyNumber, /^PA-/, 'the policy was saved with its number');
  assert.equal(policy.versions.length, 1);
  assert.equal(pc2.db.jobs[0].status, 'Bound');
  assert.ok(pc2.db.jobs.length >= 1);
  await reopened.close();
});

test('a unit of work is all or nothing, across every collection it touched', async () => {
  const { store } = await open();
  const pc = new PolicyCenter(store);
  const agent = pc.user('agent');
  store.transaction(() => account(pc, agent));
  const before = store.data.accounts.length;

  assert.throws(() => store.transaction(() => {
    account(pc, agent, { lastName: 'Second' });
    pc.createAccount({ firstName: 'No', dob: '1980-01-01' }, agent); // invalid: no address
  }));

  assert.equal(store.data.accounts.length, before, 'the account made in the failed unit of work is gone');
  await store.drain();
  const { rows } = await store.runner.query('select count(*)::int as n from pc_accounts');
  assert.equal(rows[0].n, before);
  await store.close();
});

test('the numbering the app depends on keeps counting after a restart', async () => {
  const { db, store } = await open();
  const pc = new PolicyCenter(store);
  const agent = pc.user('agent');
  store.transaction(() => account(pc, agent));
  const first = store.data.accounts[0].accountNumber;
  await store.drain();
  await store.close();

  const reopened = new PostgresStore(new PgliteRunner(db), { walFile: null });
  await reopened.load();
  const pc2 = new PolicyCenter(reopened);
  const second = reopened.transaction(() => account(pc2, agent)).accountNumber;
  assert.notEqual(second, first, 'a second account must not get the first one’s number');
  await reopened.close();
});
