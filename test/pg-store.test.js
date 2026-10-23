'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStoreFromEnv } = require('../src/pg/open');

// The Postgres runtime, exercised against a real PostgreSQL that runs in this process (PGlite via DATABASE_URL=memory://).
// No server, no network, and the same code path production uses.

const quiet = { error: () => {} };

async function withEnv(url, fn) {
  const previous = process.env.DATABASE_URL;
  if (url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = url;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pg-'));
  try {
    return await fn(path.join(dir, 'policycenter.json'), dir);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('with no DATABASE_URL the runtime keeps the JSON store', async () => {
  await withEnv(undefined, async (dataFile) => {
    const store = await openStoreFromEnv({ dataFile, log: quiet });
    assert.equal(store, null, 'the caller keeps its JSON store');
  });
});

test('with DATABASE_URL=memory:// an empty database loads the same shape as a fresh JSON store', async () => {
  await withEnv('memory://', async (dataFile) => {
    const store = await openStoreFromEnv({ dataFile, log: quiet });
    assert.ok(store, 'a store was opened');
    assert.ok(Array.isArray(store.data.accounts), 'accounts collection exists');
    assert.ok(Array.isArray(store.data.policies));
    assert.equal(store.data.accounts.length, 0, 'a new database starts empty');
  });
});

test('the Postgres store exposes the write-ahead path the runtime uses, and reopens', async () => {
  await withEnv('memory://', async (dataFile) => {
    const first = await openStoreFromEnv({ dataFile, log: quiet });
    // No save(): this store persists through a write-ahead log drained by the runtime, so the test asserts the surface the
    // runtime actually calls rather than an API the JSON store happens to have.
    assert.equal(typeof first.drain, 'function', 'drain is how pending writes reach the database');
    assert.equal(typeof first.close, 'function');
    await first.drain();
    await first.close();

    const second = await openStoreFromEnv({ dataFile, log: quiet });
    assert.ok(Array.isArray(second.data.accounts), 'the reopened store has its collections');
    await second.close();
  });
});
