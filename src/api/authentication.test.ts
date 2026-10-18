import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../platform/index.js';
import { deactivateUser, getUserByUsername } from '../platform/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { createApp } from './app.js';
import { bearerAuthenticator } from './authentication.js';
import { loadApiConfig } from './config.js';
import { seedDemo } from './seed.js';

// Real sign-in (document sections 13 and 17): the identity provider signs a token, the API checks the signature, the
// issuer, the audience and the expiry, and only then looks up the user. These tests play the identity provider.

const config = loadApiConfig(fileURLToPath(new URL('../../config/', import.meta.url)));
const ISSUER = 'https://login.example.test/';
const AUDIENCE = 'insurance-suite-api';

let db: Database;
let app: FastifyInstance;
let privateKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  db = await createTestDatabase();
  privateKey = (await generateKeyPair('RS256')).privateKey;
  const pair = await generateKeyPair('RS256');
  otherKey = pair.privateKey;
});

afterAll(async () => {
  await app?.close();
  await db.close();
});

beforeEach(async () => {
  await app?.close();
  await resetDatabase(db);
  await loadTestConfiguration(db);
  await seedDemo(db);
  // Publish the public half of the real signing key, as the identity provider's key set would.
  const signer = await generateKeyPair('RS256');
  privateKey = signer.privateKey;
  const jwk: JWK = { ...(await exportJWK(signer.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' };
  app = await createApp(db, config, {
    authenticator: bearerAuthenticator({ issuer: ISSUER, audience: AUDIENCE, keys: createLocalJWKSet({ keys: [jwk] }) }),
  });
});

interface TokenOptions {
  subject?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  key?: CryptoKey;
  claims?: Record<string, unknown>;
}

async function token(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ preferred_username: options.subject ?? 'asha.agent', ...options.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setSubject('idp-subject-1')
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m');
  return jwt.sign(options.key ?? privateKey);
}

const list = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/v1/accounts', headers });

describe('signing in with a token', () => {
  it('lets a user with a good token in, and gives them their own permissions', async () => {
    const response = await list({ authorization: `Bearer ${await token()}` });
    expect(response.statusCode).toBe(200);
    // The agent has no admin permission: the token proves who they are, the database says what they may do.
    const denied = await app.inject({ method: 'POST', url: '/v1/admin/billing/invoices', headers: { authorization: `Bearer ${await token()}`, 'idempotency-key': 'k1' }, payload: { today: '2026-10-16' } });
    expect(denied.statusCode).toBe(403);
  });

  it('refuses a request with no token, and ignores the X-User header (it can be forged)', async () => {
    expect((await list({})).statusCode).toBe(401);
    expect((await list({ 'x-user': 'root.admin' })).statusCode).toBe(401);
  });

  it('refuses a token that is not a bearer token, or is not a token at all', async () => {
    expect((await list({ authorization: await token() })).statusCode).toBe(401); // no "Bearer"
    expect((await list({ authorization: 'Bearer not-a-token' })).statusCode).toBe(401);
    expect((await list({ authorization: 'Bearer ' })).statusCode).toBe(401);
  });

  it('refuses an expired token', async () => {
    const expired = await token({ expiresIn: Math.floor(Date.now() / 1000) - 3600 });
    expect((await list({ authorization: `Bearer ${expired}` })).statusCode).toBe(401);
  });

  it('refuses a token from another issuer or for another audience', async () => {
    expect((await list({ authorization: `Bearer ${await token({ issuer: 'https://evil.example.test/' })}` })).statusCode).toBe(401);
    expect((await list({ authorization: `Bearer ${await token({ audience: 'some-other-api' })}` })).statusCode).toBe(401);
  });

  it('refuses a token signed with a key the identity provider never published', async () => {
    expect((await list({ authorization: `Bearer ${await token({ key: otherKey })}` })).statusCode).toBe(401);
  });

  it('refuses an unsigned token (algorithm "none") and a token using a shared secret', async () => {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'none', typ: 'JWT' })}.${part({ preferred_username: 'root.admin', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    expect((await list({ authorization: `Bearer ${unsigned}` })).statusCode).toBe(401);
    const hmac = await new SignJWT({ preferred_username: 'root.admin' }).setProtectedHeader({ alg: 'HS256', kid: 'key-1' }).setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m').sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough'));
    expect((await list({ authorization: `Bearer ${hmac}` })).statusCode).toBe(401);
  });

  it('refuses a token that has no expiry', async () => {
    const forever = await new SignJWT({ preferred_username: 'asha.agent' }).setProtectedHeader({ alg: 'RS256', kid: 'key-1' }).setIssuer(ISSUER).setAudience(AUDIENCE).sign(privateKey);
    expect((await list({ authorization: `Bearer ${forever}` })).statusCode).toBe(401);
  });

  it('refuses a person the identity provider knows but this system does not, or has switched off', async () => {
    expect((await list({ authorization: `Bearer ${await token({ subject: 'stranger' })}` })).statusCode).toBe(401);
    const asha = (await getUserByUsername(db, 'asha.agent'))!;
    await deactivateUser(db, asha.id, 'root.admin');
    expect((await list({ authorization: `Bearer ${await token()}` })).statusCode).toBe(401);
  });

  it('refuses a token with no user name claim', async () => {
    const noName = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'key-1' }).setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m').sign(privateKey);
    expect((await list({ authorization: `Bearer ${noName}` })).statusCode).toBe(401);
  });

  it('keeps the health check and the description open to everyone', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
  });

  it('says in the OpenAPI description that the API uses bearer tokens', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as { components: { securitySchemes: Record<string, { type: string; scheme?: string }> } };
    expect(spec.components.securitySchemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
  });
});
