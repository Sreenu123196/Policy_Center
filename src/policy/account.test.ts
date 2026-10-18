import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact, type Contact, type NewContact } from '../contacts/index.js';
import {
  assignProducerCode,
  assignRole,
  createProducerCode,
  createProducerOrganisation,
  createRole,
  createUser,
  deactivateProducerCode,
  listAuditEntries,
  ValidationError,
  visibilityFor,
} from '../platform/index.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { addAccountContact, createAccount, getAccount, listAccounts } from './account-repository.js';

let db: PGlite;
let asha: Contact;
let raoMotors: Contact;
let ravi: Contact;
let bank: Contact;

const address = { line1: '12 Test Street', city: 'Hyderabad', state: 'Telangana', pinCode: '500081' };
const person = (name: string): NewContact => ({ kind: 'person', name, address });

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db);

  // Two agencies, each with one producer code. All names are made up.
  const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
  const blueRiver = await createProducerOrganisation(db, { name: 'Blue River Brokers' }, 'admin');
  await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');
  await createProducerCode(db, { code: 'PC-200', organisationId: blueRiver.id }, 'admin');

  asha = await createContact(db, person('Asha Rao'), 'admin');
  ravi = await createContact(db, person('Ravi Kumar'), 'admin');
  raoMotors = await createContact(db, { kind: 'company', name: 'Rao Motors Pvt Ltd', address }, 'admin');
  bank = await createContact(db, { kind: 'company', name: 'Sample Finance Ltd', address }, 'admin');
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

describe('accounts (document section 5)', () => {
  it('get a number, a status, the producer of record and the named insured', async () => {
    const first = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'agent.one');

    expect(first.accountNumber).toBe('AC-0000001');
    expect(first.status).toBe('active');
    expect(first.producerCode).toBe('PC-100');
    expect(first.createdBy).toBe('agent.one');
    expect(first.contacts).toEqual([{ contactId: asha.id, role: 'named_insured' }]);

    const second = await createAccount(db, { namedInsuredContactId: ravi.id, producerCode: 'PC-100' }, 'agent.one');
    expect(second.accountNumber).toBe('AC-0000002');
  });

  it('can have a company as the named insured', async () => {
    const account = await createAccount(db, { namedInsuredContactId: raoMotors.id, producerCode: 'PC-200' }, 'agent.two');
    expect(account.contacts[0]).toEqual({ contactId: raoMotors.id, role: 'named_insured' });
  });

  it('refuse an unknown or inactive producer code, and save nothing', async () => {
    expect(await errorsOf(createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-999' }, 'u'))).toEqual([expect.stringMatching(/producer code PC-999 does not exist/i)]);

    await deactivateProducerCode(db, 'PC-200', 'admin');
    expect(await errorsOf(createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-200' }, 'u'))).toEqual([expect.stringMatching(/not active/i)]);

    expect(await listAccounts(db, 'all')).toEqual([]);
  });

  it('refuse a named insured that is not a contact, whether the id is unknown or malformed', async () => {
    const unknown = '00000000-0000-0000-0000-000000000000';
    expect(await errorsOf(createAccount(db, { namedInsuredContactId: unknown, producerCode: 'PC-100' }, 'u'))).toEqual([expect.stringMatching(/contact/i)]);
    expect(await errorsOf(createAccount(db, { namedInsuredContactId: 'not-an-id', producerCode: 'PC-100' }, 'u'))).toEqual([expect.stringMatching(/contact/i)]);
  });

  it('take extra contacts with roles, but never a second named insured or the same role twice', async () => {
    const account = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'u');
    await addAccountContact(db, account.id, { contactId: ravi.id, role: 'driver' }, 'u');
    await addAccountContact(db, account.id, { contactId: bank.id, role: 'financier' }, 'u');

    const found = await getAccount(db, account.id, 'all');
    expect(found?.contacts.map((c) => c.role).sort()).toEqual(['driver', 'financier', 'named_insured']);

    expect(await errorsOf(addAccountContact(db, account.id, { contactId: ravi.id, role: 'named_insured' }, 'u'))).toEqual([expect.stringMatching(/exactly one named insured/i)]);
    expect(await errorsOf(addAccountContact(db, account.id, { contactId: ravi.id, role: 'driver' }, 'u'))).toEqual([expect.stringMatching(/already has that role/i)]);
  });

  it('refuse extra contacts for an unknown account or contact', async () => {
    const account = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'u');
    const unknown = '00000000-0000-0000-0000-000000000000';
    expect(await errorsOf(addAccountContact(db, unknown, { contactId: ravi.id, role: 'driver' }, 'u'))).toEqual([expect.stringMatching(/account/i)]);
    expect(await errorsOf(addAccountContact(db, account.id, { contactId: unknown, role: 'driver' }, 'u'))).toEqual([expect.stringMatching(/contact/i)]);
  });
});

describe('producer code security on accounts (document section 13)', () => {
  it('lets an agent see only accounts under their own producer code, and hides the others as "not found"', async () => {
    const acmeAccount = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'agent.one');
    const blueAccount = await createAccount(db, { namedInsuredContactId: raoMotors.id, producerCode: 'PC-200' }, 'agent.two');

    expect((await getAccount(db, acmeAccount.id, { producerCodes: ['PC-100'] }))?.id).toBe(acmeAccount.id);
    expect(await getAccount(db, blueAccount.id, { producerCodes: ['PC-100'] })).toBeNull();
    expect(await getAccount(db, blueAccount.id, 'all')).not.toBeNull();
    expect(await getAccount(db, 'not-an-id', 'all')).toBeNull();
  });

  it('filters the list the same way: own codes only, everything for head office, nothing for no codes', async () => {
    const a = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'u');
    const b = await createAccount(db, { namedInsuredContactId: raoMotors.id, producerCode: 'PC-200' }, 'u');
    const c = await createAccount(db, { namedInsuredContactId: ravi.id, producerCode: 'PC-100' }, 'u');

    expect((await listAccounts(db, { producerCodes: ['PC-100'] })).map((x) => x.accountNumber)).toEqual([a.accountNumber, c.accountNumber]);
    expect((await listAccounts(db, { producerCodes: ['PC-100', 'PC-200'] })).map((x) => x.accountNumber)).toEqual([a.accountNumber, b.accountNumber, c.accountNumber]);
    expect((await listAccounts(db, 'all')).length).toBe(3);
    expect(await listAccounts(db, { producerCodes: [] })).toEqual([]);
  });
});

describe('accounts with the audit log and real users (document sections 5 and 13)', () => {
  it('record who opened an account and who added a contact to it', async () => {
    const account = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'agent.one');
    await addAccountContact(db, account.id, { contactId: ravi.id, role: 'driver' }, 'agent.two');

    const entries = await listAuditEntries(db, { entityType: 'account', entityId: account.id });
    expect(entries.map((e) => [e.actor, e.action])).toEqual([
      ['agent.one', 'account.create'],
      ['agent.two', 'account.add_contact'],
    ]);
    expect(entries[1]?.details).toEqual({ contactId: ravi.id, role: 'driver' });
  });

  it('show each signed-in user only the accounts their producer codes allow', async () => {
    await createRole(db, { code: 'agent', name: 'Agent', permissions: ['account.view'] }, 'admin');
    await createRole(db, { code: 'head_office', name: 'Head office', permissions: ['account.view_all'] }, 'admin');
    const agent = await createUser(db, { username: 'asha.agent', displayName: 'Asha' }, 'admin');
    await assignRole(db, agent.id, 'agent', 'admin');
    await assignProducerCode(db, agent.id, 'PC-100', 'admin');
    const boss = await createUser(db, { username: 'head.office', displayName: 'Head office' }, 'admin');
    await assignRole(db, boss.id, 'head_office', 'admin');

    const own = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'u');
    await createAccount(db, { namedInsuredContactId: raoMotors.id, producerCode: 'PC-200' }, 'u');

    expect((await listAccounts(db, await visibilityFor(db, agent.id))).map((a) => a.id)).toEqual([own.id]);
    expect(await listAccounts(db, await visibilityFor(db, boss.id))).toHaveLength(2);
  });
});
