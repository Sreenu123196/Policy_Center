'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStoreFromEnv } = require('../src/pg/open');
const { importJson } = require('../src/pg/import');
const { tableFor } = require('../src/pg/schema');

// A persistent PGlite directory allows one instance at a time, so these tests verify against the database itself rather than
// reopening a second store on the same directory - reopening blocked, and that is what hung the first version of this file.

const quiet = { error: () => {}, log: () => {} };

async function withPersistentDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-import-'));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'pglite://' + path.join(dir, 'pgdata');
  try { return await fn(dir); }
  finally {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('every collection is written, verified, and present in the database', async () => {
  await withPersistentDb(async (dir) => {
    const json = {
      seq: { account: 1, policy: 1, claim: 1 },
      accounts: [{ id: 'acc1', name: 'Imported' }],
      policies: [{ id: 'pol1', policyNumber: 'PA-0000001' }],
      claims: [{ claimNumber: 'CL-0000001' }],
    };
    const store = await openStoreFromEnv({ dataFile: path.join(dir, 'policycenter.json'), log: quiet });
    const result = await importJson({ store, json, log: quiet });
    assert.deepEqual(result.mismatches, [], 'counts match in memory');
    assert.equal(result.rows, 3);
    // Ask the database directly: the rows are not merely in the process.
    const accounts = await store.runner.query(`SELECT COUNT(*)::int AS n FROM ${tableFor('accounts')}`);
    const policies = await store.runner.query(`SELECT COUNT(*)::int AS n FROM ${tableFor('policies')}`);
    assert.equal(accounts.rows[0].n, 1);
    assert.equal(policies.rows[0].n, 1);
    await store.close();
  });
});

test('running the import twice replaces rather than appends', async () => {
  await withPersistentDb(async (dir) => {
    const json = { accounts: [{ id: 'acc1' }] };
    const store = await openStoreFromEnv({ dataFile: path.join(dir, 'policycenter.json'), log: quiet });
    await importJson({ store, json, log: quiet });
    await importJson({ store, json, log: quiet });
    const count = await store.runner.query(`SELECT COUNT(*)::int AS n FROM ${tableFor('accounts')}`);
    assert.equal(count.rows[0].n, 1, 'a second import does not duplicate');
    await store.close();
  });
});
