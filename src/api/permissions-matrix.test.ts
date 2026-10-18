import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../platform/index.js';
import { PERMISSIONS } from '../platform/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { createApp } from './app.js';
import { loadApiConfig } from './config.js';
import { allRoutes } from './routes.js';
import { DEMO_ROLES, DEMO_USERS, seedDemo } from './seed.js';

// The permissions matrix (document section 13): for EVERY route and EVERY role, who is let in and who is refused. The
// matrix is computed from the route list, so a new route is covered the day it is added, and a role that gains or
// loses a permission changes the matrix by itself. Permission is checked before the request body, so a request with
// dummy parameters is enough: a refusal is 403, anything else (400, 404, 422...) means the door opened.

const config = loadApiConfig(fileURLToPath(new URL('../../config/', import.meta.url)));
let db: Database;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDatabase();
  await resetDatabase(db);
  await loadTestConfiguration(db);
  await seedDemo(db);
  app = await createApp(db, config);
});

afterAll(async () => {
  await app?.close();
  await db.close();
});

const dummy = '00000000-0000-4000-8000-000000000000';
const url = (path: string): string => path.replace(/\{(\w+)\}/g, dummy);

async function statusOf(route: (typeof allRoutes)[number], user: string | null): Promise<number> {
  const headers: Record<string, string> = {};
  if (user !== null) headers['x-user'] = user;
  if (route.method !== 'GET') headers['idempotency-key'] = randomUUID();
  const response = await app.inject({ method: route.method, url: url(route.path), headers, ...(route.method === 'GET' ? {} : { payload: {} }) });
  return response.statusCode;
}

const protectedRoutes = allRoutes.filter((r) => !r.public);
const guarded = protectedRoutes.filter((r) => r.permission !== undefined);

describe('permissions matrix', () => {
  it('turns every anonymous caller away from every route except the public ones', async () => {
    for (const route of protectedRoutes) expect(await statusOf(route, null), `${route.method} ${route.path}`).toBe(401);
    expect(allRoutes.filter((r) => r.public).map((r) => r.path)).toEqual(['/v1/health']);
  });

  it('lets each demo role through exactly the routes whose permission it holds', async () => {
    const matrix: string[] = [];
    for (const demo of DEMO_USERS) {
      const granted = new Set<string>(DEMO_ROLES[demo.role]!.permissions);
      for (const route of guarded) {
        const status = await statusOf(route, demo.username);
        const allowed = granted.has(route.permission!);
        expect(status === 403, `${demo.role} on ${route.method} ${route.path} (needs ${route.permission}) gave ${status}`).toBe(!allowed);
        expect(status, `${demo.role} on ${route.method} ${route.path}`).not.toBe(401);
        expect(status, `${demo.role} on ${route.method} ${route.path}`).toBeLessThan(500);
        matrix.push(`${demo.role} ${route.method} ${route.path} ${allowed ? 'allow' : 'deny'}`);
      }
    }
    expect(matrix.length).toBe(DEMO_USERS.length * guarded.length);
  });

  it('lets every signed-in role reach the read routes that have no permission (producer code security limits what they return)', async () => {
    const reads = protectedRoutes.filter((r) => r.permission === undefined);
    expect(reads.length).toBeGreaterThan(0);
    for (const demo of DEMO_USERS) {
      for (const route of reads) {
        const status = await statusOf(route, demo.username);
        expect(status, `${demo.role} on ${route.method} ${route.path}`).not.toBe(401);
        expect(status, `${demo.role} on ${route.method} ${route.path}`).not.toBe(403);
        expect(status, `${demo.role} on ${route.method} ${route.path}`).toBeLessThan(500);
      }
    }
  });

  it('keeps the dangerous doors narrow: only the right roles can bind, pay, handle claims or run admin jobs', () => {
    const rolesWith = (permission: string): string[] =>
      Object.entries(DEMO_ROLES)
        .filter(([, role]) => role.permissions.includes(permission as never))
        .map(([code]) => code)
        .sort();
    expect(rolesWith('policy.bind')).toEqual(['underwriter']);
    expect(rolesWith('billing.pay')).toEqual(['cashier']);
    expect(rolesWith('claim.pay')).toEqual(['claims_handler']);
    expect(rolesWith('claim.handle')).toEqual(['claims_handler']);
    expect(rolesWith('admin.manage_users')).toEqual(['api_admin']);
  });

  it('knows every permission: one that no route uses has to be named here on purpose', () => {
    const used = new Set(guarded.map((r) => r.permission));
    const unused = PERMISSIONS.filter((p) => !used.has(p)).sort();
    // account.view / account.view_all work through producer code security (visibilityFor) rather than a route check;
    // audit.view and uw.approve have no API route yet (a gap found by this test: an underwriter cannot approve a referred
    // issue through the API). Adding a route for one of these, or a new permission, means updating this list.
    expect(unused).toEqual(['account.view', 'account.view_all', 'audit.view', 'uw.approve']);
  });
});
