import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, loadConfiguration, runMigrations } from '../platform/index.js';
import { createApp } from './app.js';
import { loadApiConfig } from './config.js';
import { seedDemo } from './seed.js';

// Starts the API for a local run: opens the database (kept in a folder, so data survives a restart), applies the
// migrations, loads the configuration and the typelists, adds the demo users, and listens on a port.
//   npm run api            (builds, then starts)
// The folder holding db/ and config/ is the current folder, or ROOT_DIR.

export async function startServer(options: { root: string; dataDir: string; port: number; host: string }): Promise<{ close: () => Promise<void>; address: string }> {
  const db = await createDatabase(options.dataDir);
  await runMigrations(db, join(options.root, 'db', 'migrations'));
  await loadConfiguration(db, join(options.root, 'config'), 'server');
  await seedDemo(db);
  const app = await createApp(db, loadApiConfig(join(options.root, 'config')), { logger: true });
  const address = await app.listen({ port: options.port, host: options.host });
  return {
    address,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

// Run directly (node dist/api/server.js): read the settings from the environment.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.env.ROOT_DIR ?? process.cwd();
  startServer({
    root,
    dataDir: process.env.DATA_DIR ?? join(root, '.data', 'insurance-suite'),
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '127.0.0.1',
  }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
