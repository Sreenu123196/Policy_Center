import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { runMigrations } from './migrate.js';
import { createProducerCode, createProducerOrganisation, deactivateProducerCode, getProducerCode } from './producers.js';
import { ValidationError } from './validation-error.js';
import { canSeeProducerCode } from './visibility.js';

const realMigrations = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

let db: PGlite;

beforeEach(async () => {
  db = await createDatabase();
  await runMigrations(db, realMigrations);
});

afterEach(async () => {
  await db.close();
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

describe('producer organisations and codes (document sections 5 and 13)', () => {
  it('give an organisation several producer codes, each found by its code', async () => {
    const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
    await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');
    await createProducerCode(db, { code: 'PC-101', organisationId: acme.id }, 'admin');

    expect(await getProducerCode(db, 'PC-100')).toEqual({ code: 'PC-100', organisationName: 'Acme Insurance Agency', status: 'active' });
    expect((await getProducerCode(db, 'PC-101'))?.organisationName).toBe('Acme Insurance Agency');
    expect(await getProducerCode(db, 'PC-999')).toBeNull();
  });

  it('refuse a badly formed code, a code already taken, a code for an unknown organisation, and a second organisation with the same name', async () => {
    const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
    await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');

    expect(await errorsOf(createProducerCode(db, { code: 'pc-100', organisationId: acme.id }, 'admin'))).toEqual([expect.stringMatching(/code must be/i)]);
    expect(await errorsOf(createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin'))).toEqual([expect.stringMatching(/already exists/)]);
    expect(await errorsOf(createProducerCode(db, { code: 'PC-200', organisationId: '00000000-0000-0000-0000-000000000000' }, 'admin'))).toEqual([expect.stringMatching(/organisation/i)]);
    expect(await errorsOf(createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin'))).toEqual([expect.stringMatching(/already exists/)]);
  });

  it('can be deactivated: the record stays, but it is marked inactive', async () => {
    const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
    await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');

    const result = await deactivateProducerCode(db, 'PC-100', 'admin');
    expect(result.status).toBe('inactive');
    expect((await getProducerCode(db, 'PC-100'))?.status).toBe('inactive');
    expect(await errorsOf(deactivateProducerCode(db, 'PC-999', 'admin'))).toEqual([expect.stringMatching(/does not exist/)]);
  });
});

describe('producer code security (document section 13)', () => {
  it('lets head office see every producer code', () => {
    expect(canSeeProducerCode('all', 'PC-100')).toBe(true);
    expect(canSeeProducerCode('all', 'PC-200')).toBe(true);
  });

  it('lets an agent see only the codes they hold, and a person with none see nothing', () => {
    expect(canSeeProducerCode({ producerCodes: ['PC-100'] }, 'PC-100')).toBe(true);
    expect(canSeeProducerCode({ producerCodes: ['PC-100'] }, 'PC-200')).toBe(false);
    expect(canSeeProducerCode({ producerCodes: [] }, 'PC-100')).toBe(false);
  });
});
