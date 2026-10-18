import type { PGlite } from '@electric-sql/pglite';
import { getContact } from '../contacts/index.js';
import { canSeeProducerCode, getProducerCode, isUuid, ValidationError, type Visibility } from '../platform/index.js';
import { ACCOUNT_CONTACT_ROLES, type Account, type AccountContact, type AccountContactRole, type NewAccount } from './account.js';

interface AccountRow {
  id: string;
  account_number: string;
  status: 'active' | 'closed';
  producer_code: string;
  created_by: string;
  created_at: Date;
}

interface AccountContactRow {
  account_id: string;
  contact_id: string;
  role: AccountContactRole;
}

const SELECT_ACCOUNT = 'select id, account_number, status, producer_code, created_by, created_at from policy.account';

// The named insured comes first, then the others in the order they were added.
const SELECT_CONTACTS = `
  select account_id, contact_id, role
    from policy.account_contact
   where account_id = any($1::uuid[])
   order by (role = 'named_insured') desc, created_at, contact_id`;

const toAccount = (row: AccountRow, contacts: AccountContact[]): Account => ({
  id: row.id,
  accountNumber: row.account_number,
  status: row.status,
  producerCode: row.producer_code,
  contacts,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

// Loads the contacts of several accounts in one query and groups them by account.
async function contactsByAccount(db: PGlite, accountIds: string[]): Promise<Map<string, AccountContact[]>> {
  const grouped = new Map<string, AccountContact[]>();
  if (accountIds.length === 0) return grouped;
  const result = await db.query<AccountContactRow>(SELECT_CONTACTS, [accountIds]);
  for (const row of result.rows) {
    const list = grouped.get(row.account_id) ?? [];
    list.push({ contactId: row.contact_id, role: row.role });
    grouped.set(row.account_id, list);
  }
  return grouped;
}

// Opens an account for an existing contact. The producer code and the contact belong to other modules,
// so they are checked through those modules' public APIs rather than by reading their tables.
export async function createAccount(db: PGlite, input: NewAccount, actor: string): Promise<Account> {
  const errors: string[] = [];

  const producer = await getProducerCode(db, input.producerCode);
  if (producer === null) errors.push(`Producer code ${input.producerCode} does not exist`);
  else if (producer.status !== 'active') errors.push(`Producer code ${input.producerCode} is not active`);

  if ((await getContact(db, input.namedInsuredContactId)) === null) errors.push('The named insured must be an existing contact');
  if (errors.length > 0) throw new ValidationError(errors);

  // The account and its named insured are saved together or not at all.
  const accountId = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>('insert into policy.account (producer_code, created_by) values ($1, $2) returning id', [
      input.producerCode,
      actor,
    ]);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('The account was not saved');
    await tx.query('insert into policy.account_contact (account_id, contact_id, role, created_by) values ($1, $2, $3, $4)', [
      id,
      input.namedInsuredContactId,
      'named_insured',
      actor,
    ]);
    return id;
  });

  const saved = await getAccount(db, accountId, 'all');
  if (saved === null) throw new Error('The account was saved but could not be read back');
  return saved;
}

// Adds a driver, financier or billing contact. An account has exactly one named insured, fixed when it is opened.
export async function addAccountContact(db: PGlite, accountId: string, contact: AccountContact, actor: string): Promise<Account> {
  const errors: string[] = [];

  const exists = isUuid(accountId) ? await db.query('select 1 from policy.account where id = $1', [accountId]) : { rows: [] };
  if (exists.rows.length === 0) errors.push('The account does not exist');
  if ((await getContact(db, contact.contactId)) === null) errors.push('The contact does not exist');
  if (!ACCOUNT_CONTACT_ROLES.includes(contact.role)) errors.push(`Role must be one of ${ACCOUNT_CONTACT_ROLES.join(', ')}`);
  if (errors.length > 0) throw new ValidationError(errors);

  if (contact.role === 'named_insured') throw new ValidationError(['An account has exactly one named insured']);

  const already = await db.query('select 1 from policy.account_contact where account_id = $1 and contact_id = $2 and role = $3', [
    accountId,
    contact.contactId,
    contact.role,
  ]);
  if (already.rows.length > 0) throw new ValidationError(['This contact already has that role on the account']);

  await db.query('insert into policy.account_contact (account_id, contact_id, role, created_by) values ($1, $2, $3, $4)', [
    accountId,
    contact.contactId,
    contact.role,
    actor,
  ]);
  const saved = await getAccount(db, accountId, 'all');
  if (saved === null) throw new Error('The account could not be read back');
  return saved;
}

// Producer code security (document section 13): an account the viewer may not see is reported as "not found",
// so its existence is not revealed.
export async function getAccount(db: PGlite, id: string, visibility: Visibility): Promise<Account | null> {
  if (!isUuid(id)) return null;
  const result = await db.query<AccountRow>(`${SELECT_ACCOUNT} where id = $1`, [id]);
  const row = result.rows[0];
  if (!row || !canSeeProducerCode(visibility, row.producer_code)) return null;
  const contacts = await contactsByAccount(db, [row.id]);
  return toAccount(row, contacts.get(row.id) ?? []);
}

// The accounts the viewer may see, in account-number order. The filter is part of the query itself.
export async function listAccounts(db: PGlite, visibility: Visibility): Promise<Account[]> {
  const result =
    visibility === 'all'
      ? await db.query<AccountRow>(`${SELECT_ACCOUNT} order by account_number`)
      : await db.query<AccountRow>(`${SELECT_ACCOUNT} where producer_code = any($1) order by account_number`, [[...visibility.producerCodes]]);
  const contacts = await contactsByAccount(db, result.rows.map((row) => row.id));
  return result.rows.map((row) => toAccount(row, contacts.get(row.id) ?? []));
}
