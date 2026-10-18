import type { Database } from '../platform/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTypelist, listAuditEntries, recordAudit } from '../platform/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from './database.js';

let db: Database;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe('test database support', () => {
  it('resetDatabase empties every module table, including the append-only audit log, and restarts the account numbers', async () => {
    await recordAudit(db, { actor: 'test', action: 'x.y', entityType: 'x', entityId: '1' });
    await db.query("insert into platform.producer_organisation (name, created_by) values ('Acme', 'test')");
    await db.query("insert into policy.account (producer_code, created_by) values ('PC-100', 'test')");
    expect(await listAuditEntries(db)).toHaveLength(1);

    await resetDatabase(db);

    expect(await listAuditEntries(db)).toHaveLength(0);
    const organisations = await db.query<{ n: number }>('select count(*)::int as n from platform.producer_organisation');
    expect(organisations.rows[0]?.n).toBe(0);

    await db.query("insert into policy.account (producer_code, created_by) values ('PC-100', 'test')");
    const account = await db.query<{ account_number: string }>('select account_number from policy.account');
    expect(account.rows[0]?.account_number).toBe('AC-0000001');
  });

  it('keeps the record of applied migrations, and puts the audit log protection back afterwards', async () => {
    await resetDatabase(db);

    const applied = await db.query<{ n: number }>('select count(*)::int as n from platform.schema_migrations');
    expect(applied.rows[0]?.n).toBeGreaterThanOrEqual(6);

    await recordAudit(db, { actor: 'test', action: 'x.y', entityType: 'x', entityId: '1' });
    await expect(db.query('delete from platform.audit_log')).rejects.toThrow(/append-only/);
  });

  it('loadTestConfiguration puts the real typelists back after a reset', async () => {
    await resetDatabase(db);
    expect(await getTypelist(db, 'account_contact_role')).toBeNull();

    await loadTestConfiguration(db);
    expect((await getTypelist(db, 'account_contact_role'))?.length).toBeGreaterThan(0);
  });
});
