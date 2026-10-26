'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seedIfEmpty } = require('../src/pg/seed');

// The seeding rule has two hard requirements: it must be switched on, and it must never touch a database that already holds data.

function fakeStore({ empty }) {
  const data = { accounts: [], policies: [] };
  const store = {
    data,
    next: () => 1,
    isEmpty: () => empty,
    transaction: (fn) => { fn(); return { frames: [] }; },
    drain: async () => {},
  };
  return store;
}

const json = { accounts: [{ id: 'a1' }], policies: [{ id: 'p1' }] };
const quiet = { log: () => {} };

test('nothing happens unless the flag is set', async () => {
  const result = await seedIfEmpty({ store: fakeStore({ empty: true }), json, log: quiet });
  assert.equal(result.seeded, false);
  assert.match(result.reason, /not set/);
});

test('an empty database is seeded when the flag is on', async () => {
  const store = fakeStore({ empty: true });
  const result = await seedIfEmpty({ store, json, enabled: true, log: quiet });
  assert.equal(result.seeded, true);
  assert.equal(result.rows, 2);
  assert.equal(store.data.accounts.length, 1);
  assert.equal(store.data.policies.length, 1);
});

test('a database with data is left alone, whatever the flag says', async () => {
  const store = fakeStore({ empty: false });
  const result = await seedIfEmpty({ store, json, enabled: true, log: quiet });
  assert.equal(result.seeded, false);
  assert.match(result.reason, /already holds data/);
  assert.equal(store.data.accounts.length, 0);
});

test('an empty bundled book seeds nothing, and a store without isEmpty is refused', async () => {
  const emptyBook = await seedIfEmpty({ store: fakeStore({ empty: true }), json: {}, enabled: true, log: quiet });
  assert.equal(emptyBook.seeded, false);
  assert.match(emptyBook.reason, /bundled book is empty/);
  const noStore = await seedIfEmpty({ store: { data: {} }, json, enabled: true, log: quiet });
  assert.match(noStore.reason, /cannot report emptiness/);
});
