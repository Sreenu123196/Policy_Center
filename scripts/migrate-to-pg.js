'use strict';
// Copy the JSON file into PostgreSQL, once, when moving an existing installation over.
//
//   DATABASE_URL=postgres://user:pass@host:5432/policycenter node scripts/migrate-to-pg.js
//   node scripts/migrate-to-pg.js --from data/policycenter.json --force
//
// It refuses to write into a database that already holds policies unless --force is given, so a second run cannot
// quietly double the book. The JSON file is only read; nothing is deleted from it.

const fs = require('node:fs');
const path = require('node:path');
const { loadEnv } = require('../src/loadEnv');
loadEnv();

const { PgRunner, PgliteRunner } = require('../src/pg/runners');
const { PostgresStore } = require('../src/pg/postgresStore');
const { KINDS } = require('../src/pg/schema');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

async function main() {
  const url = arg('url', process.env.DATABASE_URL);
  if (!url) {
    console.error('Set DATABASE_URL (or pass --url) to the database to copy the book into.');
    process.exit(1);
  }
  const from = path.resolve(arg('from', path.join(__dirname, '..', 'data', 'policycenter.json')));
  if (!fs.existsSync(from)) {
    console.error(`There is no JSON file at ${from}. Nothing to copy.`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(from, 'utf8'));
  const force = process.argv.includes('--force');

  const runner = url === 'memory://' || url.startsWith('pglite://') ? await PgliteRunner.fromUrl(url) : PgRunner.fromUrl(url);
  const store = new PostgresStore(runner, { walFile: `${from}.wal` });
  await store.load();
  if (store.data.policies.length && !force) {
    console.error(`That database already holds ${store.data.policies.length} policies. Use --force if you mean to copy over them.`);
    await store.close();
    process.exit(1);
  }

  const counts = {};
  store.transaction(() => {
    for (const [name, spec] of Object.entries(KINDS)) {
      if (spec.kind === 'rows') {
        for (const record of data[name] || []) store.data[name].push(record);
        counts[name] = (data[name] || []).length;
      } else if (spec.kind === 'kv') {
        for (const [key, value] of Object.entries(data[name] || {})) store.data[name][key] = value;
        counts[name] = Object.keys(data[name] || {}).length;
      } else {
        store.data[name] = data[name];
        counts[name] = Array.isArray(data[name]) ? data[name].length : 1;
      }
    }
    // Anything the JSON file holds that this version of the schema does not know: keep it whole rather than drop it.
    for (const [name, value] of Object.entries(data)) {
      if (KINDS[name]) continue;
      store.data[name] = value;
      counts[name] = Array.isArray(value) ? value.length : 1;
    }
  });
  await store.drain();
  await store.close();

  const copied = Object.entries(counts).filter(([, n]) => n > 0).map(([name, n]) => `${name}: ${n}`).join(', ');
  console.log(`Copied into ${url}: ${copied || 'nothing'}`);
}

main().catch((err) => {
  console.error('The copy failed:', err.message);
  process.exit(1);
});
