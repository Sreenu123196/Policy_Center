import type { Database } from './database.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditEntries, recordAudit } from './audit.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { createProducerCode, createProducerOrganisation, deactivateProducerCode } from './producers.js';
import { createRole } from './roles.js';
import { assignProducerCode, assignRole, createUser } from './users.js';
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
});

describe('the audit log (document sections 5, 13 and 19)', () => {
  it('records who did what to which thing, in the order it happened, and can be searched by thing', async () => {
    await recordAudit(db, { actor: 'asha.agent', action: 'account.create', entityType: 'account', entityId: 'acc-1', details: { producerCode: 'PC-100' } });
    await recordAudit(db, { actor: 'ravi.uw', action: 'uw.approve', entityType: 'job', entityId: 'job-9', reason: 'Within authority' });
    await recordAudit(db, { actor: 'asha.agent', action: 'account.add_contact', entityType: 'account', entityId: 'acc-1' });

    const all = await listAuditEntries(db);
    expect(all.map((e) => e.action)).toEqual(['account.create', 'uw.approve', 'account.add_contact']);
    expect(all[0]).toMatchObject({ actor: 'asha.agent', entityType: 'account', entityId: 'acc-1', reason: null, details: { producerCode: 'PC-100' } });
    expect(all[1]?.reason).toBe('Within authority');
    expect(typeof all[0]?.at).toBe('string');

    const forAccount = await listAuditEntries(db, { entityType: 'account', entityId: 'acc-1' });
    expect(forAccount.map((e) => e.action)).toEqual(['account.create', 'account.add_contact']);
  });

  it('is append-only: the database refuses to change, delete or empty it, even for our own code', async () => {
    await recordAudit(db, { actor: 'asha.agent', action: 'account.create', entityType: 'account', entityId: 'acc-1' });

    await expect(db.query("update platform.audit_log set actor = 'someone.else'")).rejects.toThrow(/append-only/);
    await expect(db.query('delete from platform.audit_log')).rejects.toThrow(/append-only/);
    await expect(db.query('truncate platform.audit_log')).rejects.toThrow(/append-only/);
    expect(await listAuditEntries(db)).toHaveLength(1);
  });

  it('is written by Platform changes: producers, users, roles and the links between them', async () => {
    const org = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
    await createProducerCode(db, { code: 'PC-100', organisationId: org.id }, 'admin');
    await deactivateProducerCode(db, 'PC-100', 'admin');
    await createRole(db, { code: 'agent', name: 'Agent', permissions: ['account.view'] }, 'admin');
    const user = await createUser(db, { username: 'asha.agent', displayName: 'Asha' }, 'admin');
    await assignRole(db, user.id, 'agent', 'admin');
    await createProducerCode(db, { code: 'PC-200', organisationId: org.id }, 'admin');
    await assignProducerCode(db, user.id, 'PC-200', 'admin');

    const entries = await listAuditEntries(db);
    expect(entries.map((e) => e.action)).toEqual([
      'producer_organisation.create',
      'producer_code.create',
      'producer_code.deactivate',
      'role.create',
      'user.create',
      'user.assign_role',
      'producer_code.create',
      'user.assign_producer_code',
    ]);
    expect(entries.every((e) => e.actor === 'admin')).toBe(true);
    expect(entries[5]).toMatchObject({ entityType: 'user', entityId: user.id, details: { role: 'agent' } });
  });

  it('records nothing for a change that was refused', async () => {
    const org = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
    const before = (await listAuditEntries(db)).length;

    const error = await createProducerCode(db, { code: 'bad code', organisationId: org.id }, 'admin').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(await listAuditEntries(db)).toHaveLength(before);
  });
});
