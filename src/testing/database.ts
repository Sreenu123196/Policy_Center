// Support for tests only. Starting a database takes seconds, so a test file starts ONE and calls
// resetDatabase before each test, instead of starting a new database for every test.
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { MODULES, createDatabase, runMigrations } from '../platform/index.js';

const migrationsFolder = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

// A new in-memory database with every real migration applied.
export async function createTestDatabase(): Promise<PGlite> {
  const db = await createDatabase();
  await runMigrations(db, migrationsFolder);
  return db;
}

// Empties every table of every module and restarts the counters, but keeps the record of which migrations
// have run. The audit log refuses deletes on purpose, so the reset tells PostgreSQL to skip triggers
// while it runs. This is for tests: nothing in the real application may do this.
export async function resetDatabase(db: PGlite): Promise<void> {
  const schemas = [...MODULES];
  const tables = await db.query<{ name: string }>(
    `select format('%I.%I', table_schema, table_name) as name
       from information_schema.tables
      where table_schema = any($1) and table_type = 'BASE TABLE'
        and not (table_schema = 'platform' and table_name = 'schema_migrations')`,
    [schemas],
  );
  const sequences = await db.query<{ name: string }>(
    `select format('%I.%I', schemaname, sequencename) as name from pg_sequences where schemaname = any($1)`,
    [schemas],
  );

  await db.exec('set session_replication_role = replica');
  try {
    if (tables.rows.length > 0) await db.exec(`truncate ${tables.rows.map((t) => t.name).join(', ')} restart identity cascade`);
    for (const sequence of sequences.rows) await db.query('select setval($1::regclass, 1, false)', [sequence.name]);
  } finally {
    await db.exec('set session_replication_role = origin');
  }
}
