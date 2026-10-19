import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfiguration, openDatabase, runMigrations } from '../platform/index.js';
import { createApp } from './app.js';
import { bearerAuthenticator, headerAuthenticator, remoteKeys, type Authenticator } from './authentication.js';
import { loadApiConfig } from './config.js';
import { seedDemo } from './seed.js';

// Starts the API: opens the database, applies the migrations, loads the configuration and the typelists, optionally adds
// the demo users, and listens on a port.
//   npm run api            (builds, then starts)
// Settings come from the environment (see .env.example):
//   DATABASE_URL   a PostgreSQL server (Docker, a hosted service). Without it, PGlite keeps its files in DATA_DIR.
//   SEED_DEMO      true or false: add the demo users. The default is true without DATABASE_URL and false with it.
//   AUTH_MODE      oidc (signed tokens from an identity provider) or header (X-User, development only). The default is
//                  header without DATABASE_URL and oidc with it, so a real database never trusts a forgeable header by accident.
//   OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URL   the identity provider, this API's name there, and its public key set
//   OIDC_USERNAME_CLAIM   which claim holds our user name (default preferred_username)
//   PORT, HOST     where to listen
//   ROOT_DIR       the folder holding db/ and config/ (default: the current folder)

export async function startServer(options: { root: string; dataDir?: string; databaseUrl?: string; seedDemo: boolean; port: number; host: string; authenticator?: Authenticator }): Promise<{ close: () => Promise<void>; address: string }> {
  const db = await openDatabase({ url: options.databaseUrl, dataDir: options.dataDir });
  await runMigrations(db, join(options.root, 'db', 'migrations'));
  await loadConfiguration(db, join(options.root, 'config'), 'server');
  if (options.seedDemo) await seedDemo(db);
  const app = await createApp(db, loadApiConfig(join(options.root, 'config')), { logger: process.env.LOG_REQUESTS !== 'false', ...(options.authenticator ? { authenticator: options.authenticator } : {}) });
  const address = await app.listen({ port: options.port, host: options.host });
  return {
    address,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

// Chooses how requests prove who they are, from the environment. Refuses to start on a mistake.
export function authenticatorFromEnvironment(env: NodeJS.ProcessEnv): Authenticator {
  const mode = env.AUTH_MODE ?? (env.DATABASE_URL === undefined ? 'header' : 'oidc');
  if (mode === 'header') return headerAuthenticator;
  if (mode !== 'oidc') throw new Error(`AUTH_MODE must be oidc or header, not ${mode}`);
  const missing = ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL'].filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`AUTH_MODE=oidc needs ${missing.join(', ')}`);
  return bearerAuthenticator({
    issuer: env.OIDC_ISSUER!,
    audience: env.OIDC_AUDIENCE!,
    keys: remoteKeys(env.OIDC_JWKS_URL!),
    ...(env.OIDC_USERNAME_CLAIM ? { usernameClaim: env.OIDC_USERNAME_CLAIM } : {}),
  });
}

// Run directly (node dist/api/server.js): read the settings from the environment.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.env.ROOT_DIR ?? process.cwd();
  const databaseUrl = process.env.DATABASE_URL;
  startServer({
    root,
    ...(databaseUrl ? { databaseUrl } : { dataDir: process.env.DATA_DIR ?? join(root, '.data', 'insurance-suite') }),
    seedDemo: process.env.SEED_DEMO === undefined ? databaseUrl === undefined : process.env.SEED_DEMO === 'true',
    authenticator: authenticatorFromEnvironment(process.env),
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '127.0.0.1',
  }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
