'use strict';
// Usage: DATABASE_URL=... node scripts/pg-import.js [data/policycenter.json]
require('../src/loadEnv').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const { openStoreFromEnv } = require('../src/pg/open');
const { importJson } = require('../src/pg/import');

(async () => {
  const file = process.argv[2] || path.join(__dirname, '../data/policycenter.json');
  // No DATABASE_URL means the default: a PGlite directory beside the JSON file, which is what makes it the runtime afterwards.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'pglite://' + path.join(__dirname, '../data/pgdata');
    console.log('no DATABASE_URL: importing into', process.env.DATABASE_URL);
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const store = await openStoreFromEnv({ dataFile: file });
  const result = await importJson({ store, json });
  await store.close();
  if (result.mismatches.length) process.exit(1);
})().catch((err) => { console.error('import failed:', err.message); process.exit(1); });
