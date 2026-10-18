import type { Database } from '../platform/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditEntries, ValidationError } from '../platform/index.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import type { NewContact } from './contact.js';
import { createContact, getContact } from './repository.js';

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

// Made-up people and companies only.
const asha: NewContact = {
  kind: 'person',
  name: 'Asha Rao',
  dateOfBirth: '1990-05-14',
  phone: '9876543210',
  email: 'asha.rao@example.com',
  address: { line1: '12 Test Street', city: 'Hyderabad', state: 'Telangana', pinCode: '500081' },
  pan: 'ABCPK1234D',
  aadhaar: '234567890123',
};

const raoMotors: NewContact = {
  kind: 'company',
  name: 'Rao Motors Pvt Ltd',
  address: { line1: '5 Sample Road', city: 'Hyderabad', state: 'Telangana', pinCode: '500081' },
  pan: 'ABCCK1234D',
  gstin: '36ABCCK1234D1Z5',
};

describe('contacts (document section 16)', () => {
  it('stores a person once and gives back the same record by id, with identifiers masked', async () => {
    const created = await createContact(db, asha, 'test.user');
    const found = await getContact(db, created.id);

    expect(found).toEqual(created);
    expect(found?.kind).toBe('person');
    expect(found?.phone).toBe('+919876543210');
    expect(found?.dateOfBirth).toBe('1990-05-14');
    expect(found?.panMasked).toBe('ABCPK****D');
    expect(found?.aadhaarMasked).toBe('XXXX XXXX 0123');
    expect(found?.createdBy).toBe('test.user');
  });

  it('never keeps the full Aadhaar number anywhere in the stored row', async () => {
    await createContact(db, asha, 'test.user');
    const stored = await db.query<{ row: string }>('select to_jsonb(c)::text as row from contacts.contact c');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.row).not.toContain('234567890123');
    expect(stored.rows[0]?.row).not.toContain('2345 6789 0123');
  });

  it('keeps the PAN in full in the database for tax use, but shows it masked', async () => {
    await createContact(db, asha, 'test.user');
    const stored = await db.query<{ pan: string }>('select pan from contacts.contact');
    expect(stored.rows[0]?.pan).toBe('ABCPK1234D');
  });

  it('stores a company with a GSTIN, and tidies spaces and lower-case letters in identifiers', async () => {
    const created = await createContact(db, { ...raoMotors, name: '  Rao Motors Pvt Ltd ', pan: 'abcck1234d', gstin: ' 36abcck1234d1z5 ' }, 'test.user');
    expect(created.kind).toBe('company');
    expect(created.name).toBe('Rao Motors Pvt Ltd');
    expect(created.gstin).toBe('36ABCCK1234D1Z5');
    expect(created.aadhaarMasked).toBeNull();
  });

  it('returns null for an id that does not exist, or that is not even shaped like an id', async () => {
    expect(await getContact(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await getContact(db, 'not-an-id')).toBeNull();
  });

  it('refuses bad input and says what is wrong in plain words', async () => {
    const bad: NewContact = {
      ...asha,
      address: { line1: '12 Test Street', city: 'Hyderabad', state: 'Telangana', pinCode: '012345' },
      pan: 'ABCCK1234D', // a company PAN on a person
      phone: '12345',
    };
    const error = await createContact(db, bad, 'test.user').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/PIN code/),
        expect.stringMatching(/PAN/),
        expect.stringMatching(/phone/i),
      ]),
    );
    const count = await db.query<{ n: number }>('select count(*)::int as n from contacts.contact');
    expect(count.rows[0]?.n).toBe(0);
  });

  it('refuses things that do not belong to the kind: a company with an Aadhaar or a birth date, a person with a GSTIN', async () => {
    const company = await createContact(db, { ...raoMotors, aadhaar: '234567890123', dateOfBirth: '1990-05-14' }, 'u').catch((e: unknown) => e);
    expect((company as ValidationError).errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/Aadhaar/), expect.stringMatching(/date of birth/i)]),
    );

    const person = await createContact(db, { ...asha, gstin: '36ABCCK1234D1Z5' }, 'u').catch((e: unknown) => e);
    expect((person as ValidationError).errors).toEqual(expect.arrayContaining([expect.stringMatching(/GSTIN/)]));
  });

  it('refuses a birth date in the future or one that is not a real date', async () => {
    const future = await createContact(db, { ...asha, dateOfBirth: '2999-01-01' }, 'u').catch((e: unknown) => e);
    expect((future as ValidationError).errors).toEqual(expect.arrayContaining([expect.stringMatching(/future/)]));

    const notReal = await createContact(db, { ...asha, dateOfBirth: '1990-02-30' }, 'u').catch((e: unknown) => e);
    expect((notReal as ValidationError).errors).toEqual(expect.arrayContaining([expect.stringMatching(/date of birth/i)]));

    // A month that does not exist must give a clear message, not crash.
    const noSuchMonth = await createContact(db, { ...asha, dateOfBirth: '1990-13-45' }, 'u').catch((e: unknown) => e);
    expect(noSuchMonth).toBeInstanceOf(ValidationError);
    expect((noSuchMonth as ValidationError).errors).toEqual(expect.arrayContaining([expect.stringMatching(/date of birth/i)]));
  });

  it('is protected twice: the database itself refuses an unmasked Aadhaar even if our code is bypassed', async () => {
    await expect(
      db.query(
        `insert into contacts.contact (kind, name, address_line1, city, state, pin_code, aadhaar_masked, created_by)
         values ('person', 'Test Person', '1 Test Street', 'Hyderabad', 'Telangana', '500081', '234567890123', 'test.user')`,
      ),
    ).rejects.toThrow();
  });

  it('records who created the contact in the audit log, without any personal numbers', async () => {
    const created = await createContact(db, asha, 'test.user');
    const entries = await listAuditEntries(db, { entityType: 'contact', entityId: created.id });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'test.user', action: 'contact.create', details: { kind: 'person' } });
    const text = JSON.stringify(entries);
    expect(text).not.toContain('234567890123');
    expect(text).not.toContain('ABCPK1234D');
  });
});
