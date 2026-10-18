import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { runMigrations } from './migrate.js';
import { MODULES } from './modules.js';

// The project's real migration files: db/migrations/
const realMigrations = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

let db: PGlite;
let dir: string;

beforeEach(async () => {
  db = await createDatabase(); // in memory: every test starts with an empty database
  dir = mkdtempSync(join(tmpdir(), 'suite-migrations-'));
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tableExists = async (schema: string, table: string): Promise<boolean> => {
  const result = await db.query<{ n: number }>(
    'select count(*)::int as n from information_schema.tables where table_schema = $1 and table_name = $2',
    [schema, table],
  );
  return result.rows[0]?.n === 1;
};

describe('migrations (document sections 3 and 17)', () => {
  it('create one database schema for each module, so modules cannot read each other by accident', async () => {
    await runMigrations(db, realMigrations);
    const result = await db.query<{ schema_name: string }>(
      'select schema_name from information_schema.schemata where schema_name = any($1) order by schema_name',
      [[...MODULES]],
    );
    expect(result.rows.map((r) => r.schema_name)).toEqual([...MODULES].sort());
  });

  it('run in file-name order, and each file runs only once', async () => {
    writeFileSync(join(dir, '0002_second.sql'), 'create table platform.second_table (id int);');
    writeFileSync(join(dir, '0001_first.sql'), 'create table platform.first_table (id int);');

    const firstRun = await runMigrations(db, dir);
    expect(firstRun).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(await tableExists('platform', 'first_table')).toBe(true);
    expect(await tableExists('platform', 'second_table')).toBe(true);

    const secondRun = await runMigrations(db, dir);
    expect(secondRun).toEqual([]);
  });

  it('refuse a file that was changed after it was applied', async () => {
    const file = join(dir, '0001_first.sql');
    writeFileSync(file, 'create table platform.first_table (id int);');
    await runMigrations(db, dir);

    writeFileSync(file, 'create table platform.first_table (id int, extra text);');
    await expect(runMigrations(db, dir)).rejects.toThrow(/0001_first\.sql was changed after it was applied/);
  });

  it('roll a failing file back completely and record nothing for it', async () => {
    writeFileSync(join(dir, '0001_broken.sql'), 'create table platform.half_done (id int); select * from no_such_table;');

    await expect(runMigrations(db, dir)).rejects.toThrow();
    expect(await tableExists('platform', 'half_done')).toBe(false);
    const recorded = await db.query<{ n: number }>('select count(*)::int as n from platform.schema_migrations');
    expect(recorded.rows[0]?.n).toBe(0);
  });
});
