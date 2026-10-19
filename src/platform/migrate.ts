import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.js';

// Applies the numbered SQL files in a folder, in name order, each exactly once.
// Returns the names of the files applied by this call.
export async function runMigrations(db: Database, directory: string): Promise<string[]> {
  // The tracking table lives in the platform schema. It is created here so the first migration can run.
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS platform;
    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );`);

  const done = await db.query<{ name: string; checksum: string }>('select name, checksum from platform.schema_migrations');
  const checksums = new Map(done.rows.map((row) => [row.name, row.checksum]));

  const applied: string[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    // Line endings are normalised first: Git on Windows may turn LF into CRLF, which must not look like an edit.
    const sql = readFileSync(join(directory, file), 'utf8').replace(/\r\n/g, '\n');
    const checksum = createHash('sha256').update(sql).digest('hex');

    const previous = checksums.get(file);
    if (previous !== undefined) {
      // A migration that has run is history. To change the database again, add a new file.
      if (previous !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
      continue;
    }

    // One transaction per file: either all of it and its record are saved, or none of it.
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('insert into platform.schema_migrations (name, checksum) values ($1, $2)', [file, checksum]);
    });
    applied.push(file);
  }
  return applied;
}
