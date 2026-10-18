import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

// Opens the local PostgreSQL (PGlite). With no folder the database lives in memory, which is what
// the tests use. With a folder it keeps its files there. Real PostgreSQL in Docker can replace this
// later: the SQL files do not change, only the connection does.
export async function createDatabase(dataDir?: string): Promise<PGlite> {
  const db = new PGlite({ ...(dataDir ? { dataDir } : {}), extensions: { btree_gist } });
  await db.waitReady;
  return db;
}
