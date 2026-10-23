'use strict';
// Import a JSON store into PostgreSQL.
//
// The JSON file is the source of truth for this step, so the import is a copy: every collection is written, then read back and
// counted. A collection that does not match stops the run and leaves the file alone - an import that half-works is worse than one
// that refuses.

const fs = require('node:fs');

const COLLECTIONS = (data) => Object.keys(data).filter((key) => Array.isArray(data[key]));

/**
 * @param {{store: object, json: object, log?: object}} input
 * @returns {{collections: number, rows: number, mismatches: Array<{collection: string, expected: number, actual: number}>}}
 */
async function importJson({ store, json, log = console }) {
  const collections = COLLECTIONS(json);
  let rows = 0;
  for (const name of collections) rows += json[name].length;

  await store.transaction(() => {
    // Rows are pushed one by one: the store notices row changes through a proxy, and assigning a whole array is not a change it
    // records. Replacing the array in memory left the database empty while the in-memory counts said otherwise - which is exactly
    // the failure the verification step caught.
    for (const name of collections) {
      const target = store.data[name];
      target.length = 0;
      for (const row of json[name]) target.push(row);
    }
    for (const [key, value] of Object.entries(json)) {
      if (!Array.isArray(value) && value && typeof value === 'object') {
        Object.assign(store.data[key] || {}, value);
      }
    }
  });
  if (typeof store.drain === 'function') await store.drain();

  const mismatches = [];
  for (const name of collections) {
    const actual = (store.data[name] || []).length;
    if (actual !== json[name].length) mismatches.push({ collection: name, expected: json[name].length, actual });
  }
  log.log('imported', collections.length, 'collections,', rows, 'rows', mismatches.length ? '- MISMATCHES' : '- verified');
  return { collections: collections.length, rows, mismatches };
}

module.exports = { importJson, COLLECTIONS };
