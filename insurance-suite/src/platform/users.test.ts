import type { Database } from './database.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasPermission, requirePermission, visibilityFor } from './authorization.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { PermissionError } from './permission-error.js';
import { createProducerCode, createProducerOrganisation } from './producers.js';
import { createRole, getRole } from './roles.js';
import { assignProducerCode, assignRole, createUser, deactivateUser, getUserByUsername } from './users.js';
import { ValidationError } from './validation-error.js';

let db: Database;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db);
  const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
  const blueRiver = await createProducerOrganisation(db, { name: 'Blue River Brokers' }, 'admin');
  await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');
  await createProducerCode(db, { code: 'PC-200', organisationId: blueRiver.id }, 'admin');
  await createRole(db, { code: 'agent', name: 'Agent', permissions: ['account.view', 'account.create', 'submission.create'] }, 'admin');
  await createRole(db, { code: 'head_office', name: 'Head office', permissions: ['account.view_all', 'audit.view'] }, 'admin');
  await createRole(db, { code: 'underwriter', name: 'Underwriter', permissions: ['uw.approve', 'policy.bind'] }, 'admin');
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

describe('users (document section 13)', () => {
  it('are people or agents with a username, and start with no roles and no producer codes', async () => {
    const asha = await createUser(db, { username: 'asha.agent', displayName: 'Asha (agent)' }, 'admin');
    expect(asha).toMatchObject({ username: 'asha.agent', displayName: 'Asha (agent)', kind: 'person', status: 'active', roles: [], producerCodes: [] });

    const bot = await createUser(db, { username: 'underwriting.bot', displayName: 'Underwriting agent', kind: 'agent' }, 'admin');
    expect(bot.kind).toBe('agent');

    expect((await getUserByUsername(db, 'asha.agent'))?.id).toBe(asha.id);
    expect(await getUserByUsername(db, 'nobody')).toBeNull();
  });

  it('refuse a badly formed or duplicate username', async () => {
    await createUser(db, { username: 'asha.agent', displayName: 'Asha' }, 'admin');
    expect(await errorsOf(createUser(db, { username: 'asha.agent', displayName: 'Another Asha' }, 'admin'))).toEqual([expect.stringMatching(/already exists/)]);
    expect(await errorsOf(createUser(db, { username: 'Asha.Agent', displayName: 'Asha' }, 'admin'))).toEqual([expect.stringMatching(/username must be/i)]);
    expect(await errorsOf(createUser(db, { username: 'a', displayName: 'Asha' }, 'admin'))).toEqual([expect.stringMatching(/username must be/i)]);
  });
});

describe('roles and permissions (document section 13)', () => {
  it('bundle permissions, and refuse a permission the system does not know, or a role code already used', async () => {
    expect(await getRole(db, 'underwriter')).toEqual({ code: 'underwriter', name: 'Underwriter', permissions: ['policy.bind', 'uw.approve'] });
    expect(await getRole(db, 'nope')).toBeNull();
    expect(await errorsOf(createRole(db, { code: 'broken', name: 'Broken', permissions: ['account.view', 'fly.rocket' as never] }, 'admin'))).toEqual([expect.stringMatching(/unknown permission fly\.rocket/i)]);
    expect(await errorsOf(createRole(db, { code: 'agent', name: 'Agent again', permissions: [] }, 'admin'))).toEqual([expect.stringMatching(/already exists/)]);
  });

  it('are given to users, who then hold every permission of every role they have', async () => {
    const asha = await createUser(db, { username: 'asha.agent', displayName: 'Asha' }, 'admin');
    expect(await hasPermission(db, asha.id, 'account.view')).toBe(false); // no role yet

    await assignRole(db, asha.id, 'agent', 'admin');
    expect(await hasPermission(db, asha.id, 'account.view')).toBe(true);
    expect(await hasPermission(db, asha.id, 'policy.bind')).toBe(false);

    await assignRole(db, asha.id, 'underwriter', 'admin');
    expect(await hasPermission(db, asha.id, 'policy.bind')).toBe(true);
    expect((await getUserByUsername(db, 'asha.agent'))?.roles).toEqual(['agent', 'underwriter']);
  });

  it('refuse a role for an unknown user or role, and the same role twice', async () => {
    const asha = await createUser(db, { username: 'asha.agent', displayName: 'Asha' }, 'admin');
    await assignRole(db, asha.id, 'agent', 'admin');
    expect(await errorsOf(assignRole(db, asha.id, 'agent', 'admin'))).toEqual([expect.stringMatching(/already has that role/)]);
    expect(await errorsOf(assignRole(db, asha.id, 'nope', 'admin'))).toEqual([expect.stringMatching(/role.*does not exist/i)]);
    expect(await errorsOf(assignRole(db, '00000000-0000-0000-0000-000000000000', 'agent', 'admin'))).toEqual([expect.stringMatching(/user.*does not exist/i)]);
  });

  it('are ignored for a user who has been deactivated', async () => {
    const asha = await createUser(db, { username: 'asha.agent', displayName: 'Asha' }, 'admin');
    await assignRole(db, asha.id, 'agent', 'admin');
    await deactivateUser(db, asha.id, 'admin');
    expect(await hasPermission(db, asha.id, 'account.view')).toBe(false);
  });

  it('can be required: allowed users pass, others get a PermissionError', async () => {
    const asha = await createUser(db, { username: 'asha.agent', displayName: 'Asha' }, 'admin');
    await assignRole(db, asha.id, 'agent', 'admin');
    await expect(requirePermission(db, asha.id, 'account.view')).resolves.toBeUndefined();

    const error = await requirePermission(db, asha.id, 'policy.bind').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermissionError);
    expect((error as PermissionError).permission).toBe('policy.bind');
  });
});

describe('who can see which accounts (document section 13)', () => {
  it('gives a user the producer codes they hold, and refuses a code that does not exist', async () => {
    const asha = await createUser(db, { username: 'asha.agent', displayName: 'Asha' }, 'admin');
    await assignProducerCode(db, asha.id, 'PC-200', 'admin');
    await assignProducerCode(db, asha.id, 'PC-100', 'admin');
    expect((await getUserByUsername(db, 'asha.agent'))?.producerCodes).toEqual(['PC-100', 'PC-200']);

    expect(await errorsOf(assignProducerCode(db, asha.id, 'PC-999', 'admin'))).toEqual([expect.stringMatching(/does not exist/)]);
    expect(await errorsOf(assignProducerCode(db, asha.id, 'PC-100', 'admin'))).toEqual([expect.stringMatching(/already holds/)]);
  });

  it('works out the visibility from the user: head office sees all, an agent sees own codes, others see nothing', async () => {
    const agent = await createUser(db, { username: 'asha.agent', displayName: 'Asha' }, 'admin');
    await assignRole(db, agent.id, 'agent', 'admin');
    await assignProducerCode(db, agent.id, 'PC-100', 'admin');

    const boss = await createUser(db, { username: 'head.office', displayName: 'Head office' }, 'admin');
    await assignRole(db, boss.id, 'head_office', 'admin');

    const noRole = await createUser(db, { username: 'new.joiner', displayName: 'New joiner' }, 'admin');
    await assignProducerCode(db, noRole.id, 'PC-100', 'admin'); // holds a code but no permission to view accounts

    expect(await visibilityFor(db, agent.id)).toEqual({ producerCodes: ['PC-100'] });
    expect(await visibilityFor(db, boss.id)).toBe('all');
    expect(await visibilityFor(db, noRole.id)).toEqual({ producerCodes: [] });
    expect(await visibilityFor(db, 'not-an-id')).toEqual({ producerCodes: [] });
  });
});
