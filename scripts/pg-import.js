'use strict';
// Usage: DATABASE_URL=... node scripts/pg-import.js [data/policycenter.json]
require('../src/loadEnv').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const { openStoreFromEnv } = require('../src/pg/open');
const { importJson } = require('../src/pg/import');

(async () => {
  const file = process.argv[2] || path.join(__dirname, '../data/policycenter.json');
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL first (a postgres:// URL, or pglite://<dir> for an in-process database).');
    process.exit(1);
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const store = await openStoreFromEnv({ dataFile: file });
  const result = await importJson({ store, json });
  await store.close();
  if (result.mismatches.length) process.exit(1);
})().catch((err) => { console.error('import failed:', err.message); process.exit(1); });
