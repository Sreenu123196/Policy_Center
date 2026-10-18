import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPermission, getUserByUsername, visibilityFor } from '../platform/index.js';
import { createTestDatabase } from '../testing/database.js';
import { DEMO_USERS, seedDemo } from './seed.js';

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe('the demo users for a local run', () => {
  it('creates a user for each kind of work, with the permissions of their role, and can be run again', async () => {
    await seedDemo(db);
    await seedDemo(db); // nothing changes the second time
    expect((await db.query('select 1 from platform.app_user')).rows).toHaveLength(DEMO_USERS.length);

    const agent = (await getUserByUsername(db, 'asha.agent'))!;
    expect(await hasPermission(db, agent.id, 'submission.create')).toBe(true);
    expect(await hasPermission(db, agent.id, 'policy.bind')).toBe(false); // an agent cannot bind
    expect(await visibilityFor(db, agent.id)).toEqual({ producerCodes: ['PC-100'] });

    const underwriter = (await getUserByUsername(db, 'uma.underwriter'))!;
    expect(await hasPermission(db, underwriter.id, 'policy.bind')).toBe(true);
    expect(await visibilityFor(db, underwriter.id)).toBe('all');
    expect(await hasPermission(db, (await getUserByUsername(db, 'carl.claims'))!.id, 'claim.pay')).toBe(true);
    expect(await hasPermission(db, (await getUserByUsername(db, 'bina.billing'))!.id, 'billing.pay')).toBe(true);
  });
});
