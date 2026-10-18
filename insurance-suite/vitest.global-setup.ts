import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

// Tests normally run on PGlite (PostgreSQL inside Node), which needs nothing installed. To run them on a real
// PostgreSQL server instead:
//   TEST_DATABASE=postgres npm test                 starts a PostgreSQL server just for the run (no Docker needed)
//   TEST_DATABASE_URL=postgres://... npm test       uses a server you already have (a Docker container, a CI service)
// Each test file then creates its own database on that server and drops it when it finishes.

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.TEST_DATABASE_URL) {
    const adminUrl = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_ADMIN_URL = adminUrl;
    return async () => {
      // A server you own keeps running, so the databases the run made are dropped one by one, now that nothing uses them.
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      const found = await admin.query<{ datname: string }>("select datname from pg_database where datname like 'test\\_%'");
      for (const { datname } of found.rows) await admin.query(`drop database "${datname}" with (force)`);
      await admin.end();
    };
  }
  if (process.env.TEST_DATABASE !== 'postgres') return undefined;

  const dir = mkdtempSync(join(tmpdir(), 'insurance-suite-pg-'));
  const port = await freePort();
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'max_connections=500', '-c', 'fsync=off', '-c', 'synchronous_commit=off'], onLog: () => undefined, onError: () => undefined });
  await server.initialise();
  await server.start();
  process.env.TEST_DATABASE_ADMIN_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
