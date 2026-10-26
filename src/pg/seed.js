'use strict';
// Seeding a host's database from the book that ships with the repository.
//
// A deployed service has no shell on the free plan and no external database connection, so the only place an import can run is inside the service - and it
// must run once, deliberately. SEED_FROM_JSON=1 turns it on; it does nothing unless the database is empty, so a restart never overwrites live data.

const { importJson } = require('./import');

/**
 * @param {{store: object, json: object, enabled?: boolean, log?: object}} input
 * @returns {Promise<{seeded: boolean, reason: string, rows?: number}>}
 */
async function seedIfEmpty({ store, json, enabled = false, log = console } = {}) {
  if (!enabled) return { seeded: false, reason: 'SEED_FROM_JSON is not set' };
  if (typeof store.isEmpty !== 'function') return { seeded: false, reason: 'this store cannot report emptiness' };
  if (!store.isEmpty()) return { seeded: false, reason: 'the database already holds data' };
  const rows = Object.values(json || {}).filter(Array.isArray).reduce((sum, list) => sum + list.length, 0);
  if (rows === 0) return { seeded: false, reason: 'the bundled book is empty' };
  const result = await importJson({ store, json, log });
  log.log('Seeded the database from the bundled book:', result.rows, 'rows, mismatches:', result.mismatches.length);
  return { seeded: true, reason: 'the database was empty', rows: result.rows };
}

module.exports = { seedIfEmpty };
