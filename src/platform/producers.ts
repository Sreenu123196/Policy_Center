import type { PGlite } from '@electric-sql/pglite';
import { recordAudit } from './audit.js';
import { isUuid } from './ids.js';
import { ValidationError } from './validation-error.js';

export interface ProducerOrganisation {
  id: string;
  name: string;
}

export interface ProducerCode {
  code: string;
  organisationName: string;
  status: 'active' | 'inactive';
}

// For example PC-100: capital letters, digits and hyphens, 3 to 20 characters.
const CODE_FORMAT = /^[A-Z0-9-]{3,20}$/;

// An organisation is an agency or brokerage. It can hold several producer codes.
export async function createProducerOrganisation(db: PGlite, input: { name: string }, actor: string): Promise<ProducerOrganisation> {
  const name = input.name.trim();
  if (name === '') throw new ValidationError(['Organisation name is required']);

  const taken = await db.query('select 1 from platform.producer_organisation where lower(name) = lower($1)', [name]);
  if (taken.rows.length > 0) throw new ValidationError([`Organisation ${name} already exists`]);

  // The change and its audit entry are saved together or not at all.
  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      'insert into platform.producer_organisation (name, created_by) values ($1, $2) returning id',
      [name, actor],
    );
    const newId = inserted.rows[0]?.id;
    if (newId === undefined) throw new Error('The organisation was not saved');
    await recordAudit(tx, { actor, action: 'producer_organisation.create', entityType: 'producer_organisation', entityId: newId, details: { name } });
    return newId;
  });
  return { id, name };
}

export async function createProducerCode(db: PGlite, input: { code: string; organisationId: string }, actor: string): Promise<ProducerCode> {
  const { code, organisationId } = input;
  if (!CODE_FORMAT.test(code)) throw new ValidationError(['Producer code must be 3 to 20 capital letters, digits or hyphens']);
  if (await getProducerCode(db, code)) throw new ValidationError([`Producer code ${code} already exists`]);

  const organisation = isUuid(organisationId)
    ? await db.query('select 1 from platform.producer_organisation where id = $1', [organisationId])
    : { rows: [] };
  if (organisation.rows.length === 0) throw new ValidationError(['The producer organisation does not exist']);

  await db.transaction(async (tx) => {
    await tx.query('insert into platform.producer_code (code, organisation_id, created_by) values ($1, $2, $3)', [code, organisationId, actor]);
    await recordAudit(tx, { actor, action: 'producer_code.create', entityType: 'producer_code', entityId: code, details: { organisationId } });
  });
  const saved = await getProducerCode(db, code);
  if (saved === null) throw new Error('The producer code was saved but could not be read back');
  return saved;
}

// Returns null if the code does not exist.
export async function getProducerCode(db: PGlite, code: string): Promise<ProducerCode | null> {
  const result = await db.query<{ code: string; organisation_name: string; status: 'active' | 'inactive' }>(
    `select c.code, o.name as organisation_name, c.status
       from platform.producer_code c
       join platform.producer_organisation o on o.id = c.organisation_id
      where c.code = $1`,
    [code],
  );
  const row = result.rows[0];
  return row ? { code: row.code, organisationName: row.organisation_name, status: row.status } : null;
}

// The record stays (old accounts still refer to it), but new accounts can no longer use the code.
export async function deactivateProducerCode(db: PGlite, code: string, actor: string): Promise<ProducerCode> {
  if ((await getProducerCode(db, code)) === null) throw new ValidationError([`Producer code ${code} does not exist`]);

  await db.transaction(async (tx) => {
    await tx.query("update platform.producer_code set status = 'inactive' where code = $1", [code]);
    await recordAudit(tx, { actor, action: 'producer_code.deactivate', entityType: 'producer_code', entityId: code });
  });
  const saved = await getProducerCode(db, code);
  if (saved === null) throw new Error('The producer code could not be read back');
  return saved;
}
