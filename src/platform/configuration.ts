import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { loadTypelists, type LoadResult } from './typelists.js';

// Loads all the versioned configuration under a folder (document section 18). For now that is the
// typelists in <folder>/typelists. Product models, rate books and the rest will be added here as they are built.
export async function loadConfiguration(db: PGlite, folder: string, actor: string): Promise<LoadResult[]> {
  const typelists = join(folder, 'typelists');
  return existsSync(typelists) ? loadTypelists(db, typelists, actor) : [];
}
