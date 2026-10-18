// Support for tests only. Starting a database takes seconds, so a test file starts ONE and calls
// resetDatabase before each test, instead of starting a new database for every test.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Database } from '../platform/index.js';
import { MODULES, connectPostgres, createDatabase, loadConfiguration, runMigrations } from '../platform/index.js';

const migrationsFolder = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));

// A new database with every real migration applied. Normally this is PGlite in memory. When the run is pointed at a real
// PostgreSQL server (see vitest.global-setup.ts), it is a new database on that server (named test_...).
export async function createTestDatabase(): Promise<Database> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (adminUrl === undefined) {
    const db = await createDatabase();
    await runMigrations(db, migrationsFolder);
    return db;
  }

  const admin = await connectPostgres(adminUrl, { maxConnections: 1 });
  const name = `test_${randomBytes(6).toString('hex')}`;
  // UTF8 is needed for Hindi and Telugu names; the C collation makes a Windows server behave like a Linux one.
  await admin.exec(`create database ${name} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = await connectPostgres(url.toString(), { maxConnections: 3 });
  await runMigrations(db, migrationsFolder);
  return {
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (work) => db.transaction(work),
    // Closing waits for the connections to finish, but never for long. The database is left on the server: dropping each
    // one while dozens of test files run at once makes the server stall. The test run drops them all at the end (see
    // vitest.global-setup.ts).
    close: async () => {
      await Promise.race([db.close(), new Promise((resolve) => setTimeout(resolve, 5_000))]).catch(() => undefined);
      await admin.close();
    },
  };
}

// Empties every table of every module and restarts the counters, but keeps the record of which migrations
// have run. The audit log refuses deletes on purpose, so the reset tells PostgreSQL to skip triggers
// while it runs. This is for tests: nothing in the real application may do this.
export async function resetDatabase(db: Database): Promise<void> {
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

  // One transaction, so the setting applies to the connection that runs the truncate (a server has several connections).
  await db.transaction(async (tx) => {
    await tx.exec('set local session_replication_role = replica');
    if (tables.rows.length > 0) await tx.exec(`truncate ${tables.rows.map((t) => t.name).join(', ')} restart identity cascade`);
    for (const sequence of sequences.rows) await tx.query('select setval($1::regclass, 1, false)', [sequence.name]);
  });
}

// Loads the project's real configuration (typelists, and later more). resetDatabase removes it along with
// everything else, so tests that need it call this after the reset.
export async function loadTestConfiguration(db: Database): Promise<void> {
  await loadConfiguration(db, configFolder, 'test');
}
