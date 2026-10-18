import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './server.js';

// The server as a program: it opens a database, migrates it, loads the configuration and listens.

const root = fileURLToPath(new URL('../../', import.meta.url));
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  process.env.LOG_REQUESTS = 'false';
  server = await startServer({ root, seedDemo: true, port: 0, host: '127.0.0.1' }); // an in-memory PGlite database
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe('starting the server', () => {
  it('answers the health check, serves the description, and knows the demo users it added', async () => {
    expect(await (await fetch(`${server.address}/v1/health`)).json()).toEqual({ status: 'ok' });
    const spec = (await (await fetch(`${server.address}/openapi.json`)).json()) as { openapi: string };
    expect(spec.openapi).toBe('3.1.0');
    const accounts = await fetch(`${server.address}/v1/accounts`, { headers: { 'X-User': 'asha.agent' } });
    expect(accounts.status).toBe(200); // the demo agent exists
    expect((await fetch(`${server.address}/v1/accounts`, { headers: { 'X-User': 'nobody' } })).status).toBe(401);
  });
});
