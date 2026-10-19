'use strict';
// Choosing where the data lives, from the environment:
//   DATABASE_URL=postgres://user:pass@host:5432/policycenter   a real server (production)
//   DATABASE_URL=memory://                                     PGlite, PostgreSQL in this process (a demo or a test)
//   no DATABASE_URL                                            the JSON file, as before
// The JSON file stays the default so nothing that works today stops working; it is still the right choice for a single
// person learning the app, and the wrong one once there are many policies (docs/PERFORMANCE.md).

const path = require('node:path');
const { PostgresStore } = require('./postgresStore');
const { PgRunner, PgliteRunner } = require('./runners');

function walPathFor(dataFile) {
  return process.env.WAL_FILE || `${dataFile}.wal`;
}

// Returns null when no database is configured, so the caller keeps its JSON store.
async function openStoreFromEnv({ dataFile, log = console } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  const runner = url === 'memory://' || url.startsWith('pglite://') ? await PgliteRunner.fromUrl(url) : PgRunner.fromUrl(url);
  const store = new PostgresStore(runner, {
    walFile: walPathFor(dataFile || path.join(__dirname, '..', '..', 'data', 'policycenter.json')),
    onError: (err) => log.error(`Saving to the database failed (the change is held in the log and retried): ${err.message}`),
  });
  await store.load();
  return store;
}

module.exports = { openStoreFromEnv, walPathFor };
