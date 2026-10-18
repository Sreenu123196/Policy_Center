import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact } from '../contacts/index.js';
import { createProducerCode, createProducerOrganisation, listAuditEntries, ValidationError } from '../platform/index.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { createAccount } from './account-repository.js';
import type { Account } from './account.js';
import { loadProductCatalogue } from './product-catalogue.js';
import { addCoverable, addCoverage, createBranch, createPolicy, getBranch, getBranchAsOf, getPolicy, startJob } from './policy-repository.js';

const catalogue = loadProductCatalogue(fileURLToPath(new URL('../../config/products/', import.meta.url)));
const PRODUCT = 'MOTOR_PRIVATE_CAR';

let db: PGlite;
let account: Account;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

// Every test starts with one agency (PC-100), one customer and one account. All names are made up.
beforeEach(async () => {
  await resetDatabase(db);
  const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
  await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');
  const asha = await createContact(db, { kind: 'person', name: 'Asha Rao', address: { line1: '12 Test Street', city: 'Hyderabad', state: 'Telangana', pinCode: '500081' } }, 'admin');
  account = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'agent.one');
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

// A policy with one submission job and one branch for the term 1 April 2026 to 1 April 2027 (the end is excluded).
async function newBranch(periodStart = '2026-04-01', periodEnd = '2027-04-01') {
  const policy = await createPolicy(db, catalogue, { accountId: account.id, productCode: PRODUCT }, 'agent.one');
  const job = await startJob(db, { policyId: policy.id, type: 'submission' }, 'agent.one');
  const branch = await createBranch(db, catalogue, { jobId: job.id, periodStart, periodEnd }, 'agent.one');
  return { policy, job, branch };
}

const swift = { make: 'Maruti', model: 'Swift', year: 2022, registrationNumber: 'TS09XX0001' };

describe('policies, jobs and branches (document sections 4, 5 and 8)', () => {
  it('give a policy a number that never changes, tie it to an account, and record its product', async () => {
    const first = await createPolicy(db, catalogue, { accountId: account.id, productCode: PRODUCT }, 'agent.one');
    expect(first).toMatchObject({ policyNumber: 'PL-0000001', accountId: account.id, productCode: PRODUCT, createdBy: 'agent.one' });
    const second = await createPolicy(db, catalogue, { accountId: account.id, productCode: PRODUCT }, 'agent.one');
    expect(second.policyNumber).toBe('PL-0000002');
  });

  it('refuse a policy for an unknown account or an unknown product', async () => {
    expect(await errorsOf(createPolicy(db, catalogue, { accountId: '00000000-0000-0000-0000-000000000000', productCode: PRODUCT }, 'u'))).toEqual([expect.stringMatching(/account.*does not exist/i)]);
    expect(await errorsOf(createPolicy(db, catalogue, { accountId: account.id, productCode: 'FLYING_CARPET' }, 'u'))).toEqual([expect.stringMatching(/product FLYING_CARPET .*not/i)]);
  });

  it('start a job on a policy with a job number, a type and the status draft, and refuse an unknown policy or type', async () => {
    const policy = await createPolicy(db, catalogue, { accountId: account.id, productCode: PRODUCT }, 'u');
    const job = await startJob(db, { policyId: policy.id, type: 'submission' }, 'agent.one');
    expect(job).toMatchObject({ jobNumber: 'J-0000001', policyId: policy.id, type: 'submission', status: 'draft', createdBy: 'agent.one' });

    expect(await errorsOf(startJob(db, { policyId: '00000000-0000-0000-0000-000000000000', type: 'submission' }, 'u'))).toEqual([expect.stringMatching(/policy.*does not exist/i)]);
    expect(await errorsOf(startJob(db, { policyId: policy.id, type: 'magic' as never }, 'u'))).toEqual([expect.stringMatching(/job type/i)]);
  });

  it('create a branch: a working copy of one term inside a job, with no version number until it is bound', async () => {
    const { policy, job, branch } = await newBranch();
    expect(branch).toMatchObject({
      policyId: policy.id,
      jobId: job.id,
      termNumber: 1,
      version: null,
      basedOnId: null,
      status: 'draft',
      periodStart: '2026-04-01',
      periodEnd: '2027-04-01',
    });
    expect(await getBranch(db, branch.id)).toEqual(branch);
    expect(await getBranch(db, 'not-an-id')).toBeNull();
  });

  it('record the product version in force on the start date: the earlier version before 1 October 2026, the later one from then on', async () => {
    expect((await newBranch('2026-05-01', '2027-05-01')).branch.productVersion).toBe('2026.04');
    expect((await newBranch('2026-10-15', '2027-10-15')).branch.productVersion).toBe('2026.10');
  });

  it('refuse a branch with no product version in force, an end before the start, a date that is not real, or an unknown job', async () => {
    const policy = await createPolicy(db, catalogue, { accountId: account.id, productCode: PRODUCT }, 'u');
    const job = await startJob(db, { policyId: policy.id, type: 'submission' }, 'u');
    const make = (periodStart: string, periodEnd: string, jobId = job.id) => createBranch(db, catalogue, { jobId, periodStart, periodEnd }, 'u');

    expect(await errorsOf(make('2026-03-01', '2027-03-01'))).toEqual([expect.stringMatching(/no version of MOTOR_PRIVATE_CAR .*in force on 2026-03-01/i)]);
    expect(await errorsOf(make('2026-05-01', '2026-05-01'))).toEqual([expect.stringMatching(/end .* after .* start/i)]);
    expect(await errorsOf(make('2026-13-45', '2027-04-01'))).toEqual([expect.stringMatching(/start date/i)]);
    expect(await errorsOf(make('2026-05-01', '2027-05-01', '00000000-0000-0000-0000-000000000000'))).toEqual([expect.stringMatching(/job.*does not exist/i)]);
  });

  it('show a policy only to people who may see its account: by producer code', async () => {
    const policy = await createPolicy(db, catalogue, { accountId: account.id, productCode: PRODUCT }, 'u');
    expect((await getPolicy(db, policy.id, { producerCodes: ['PC-100'] }))?.id).toBe(policy.id);
    expect(await getPolicy(db, policy.id, 'all')).not.toBeNull();
    expect(await getPolicy(db, policy.id, { producerCodes: ['PC-200'] })).toBeNull();
    expect(await getPolicy(db, 'not-an-id', 'all')).toBeNull();
  });
});

describe('effective-dated objects (document sections 5 and 6, Appendix A)', () => {
  it('cover the whole period unless told otherwise, and keep one fixed id across their slices', async () => {
    const { branch } = await newBranch();
    const whole = await addCoverable(db, branch.id, { kind: 'Vehicle', attributes: swift }, 'agent.one');
    expect(whole).toMatchObject({ kind: 'Vehicle', effFrom: '2026-04-01', effTo: '2027-04-01', attributes: swift });

    // A second object whose attributes change on 1 October: two slices, one fixed id.
    const first = await addCoverable(db, branch.id, { kind: 'Driver', attributes: { name: 'Asha Rao' }, effTo: '2026-10-01' }, 'agent.one');
    const second = await addCoverable(db, branch.id, { kind: 'Driver', fixedId: first.fixedId, attributes: { name: 'Asha K Rao' }, effFrom: '2026-10-01' }, 'agent.one');
    expect(second.fixedId).toBe(first.fixedId);
    expect(second.fixedId).not.toBe(whole.fixedId);
  });

  it('answer "what was true on this date": the half-open range means the end date belongs to the next slice', async () => {
    const { branch } = await newBranch();
    const first = await addCoverable(db, branch.id, { kind: 'Driver', attributes: { name: 'Asha Rao' }, effTo: '2026-10-01' }, 'u');
    await addCoverable(db, branch.id, { kind: 'Driver', fixedId: first.fixedId, attributes: { name: 'Asha K Rao' }, effFrom: '2026-10-01' }, 'u');

    const nameOn = async (date: string) => (await getBranchAsOf(db, branch.id, date))?.coverables.map((c) => c.attributes.name);
    expect(await nameOn('2026-04-01')).toEqual(['Asha Rao']); // the first day of the period
    expect(await nameOn('2026-09-30')).toEqual(['Asha Rao']);
    expect(await nameOn('2026-10-01')).toEqual(['Asha K Rao']); // the boundary day belongs to the later slice
    expect(await nameOn('2027-03-31')).toEqual(['Asha K Rao']);
    expect(await nameOn('2027-04-01')).toEqual([]); // the end of the period is excluded
    expect(await getBranchAsOf(db, 'not-an-id', '2026-06-01')).toBeNull();
    await expect(getBranchAsOf(db, branch.id, '2026-02-30')).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuse overlapping slices of one object, in the code with a clear message and in the database itself', async () => {
    const { branch } = await newBranch();
    const driver = await addCoverable(db, branch.id, { kind: 'Driver', attributes: { name: 'Asha Rao' }, effTo: '2026-10-01' }, 'u');

    expect(await errorsOf(addCoverable(db, branch.id, { kind: 'Driver', fixedId: driver.fixedId, effFrom: '2026-09-01', effTo: '2026-12-01' }, 'u'))).toEqual([
      expect.stringMatching(/overlaps/i),
    ]);

    // Going around our code, the database still refuses.
    await expect(
      db.query(
        `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, created_by)
         values ($1, $2, 'Driver', '2026-09-01', '2026-12-01', 'sql')`,
        [branch.id, driver.fixedId],
      ),
    ).rejects.toThrow(/exclusion constraint/);
  });

  it('let different objects cover the same dates: only slices of the same object may not overlap', async () => {
    const { branch } = await newBranch();
    await addCoverable(db, branch.id, { kind: 'Vehicle', attributes: swift }, 'u');
    await addCoverable(db, branch.id, { kind: 'Vehicle', attributes: { ...swift, registrationNumber: 'TS09XX0002' } }, 'u');
    expect((await getBranchAsOf(db, branch.id, '2026-06-01'))?.coverables).toHaveLength(2);
  });

  it('keep every row inside the policy period, and a slice of an existing object must be the same kind', async () => {
    const { branch } = await newBranch();
    expect(await errorsOf(addCoverable(db, branch.id, { kind: 'Vehicle', effFrom: '2026-03-01' }, 'u'))).toEqual([expect.stringMatching(/inside the policy period/i)]);
    expect(await errorsOf(addCoverable(db, branch.id, { kind: 'Vehicle', effTo: '2027-04-02' }, 'u'))).toEqual([expect.stringMatching(/inside the policy period/i)]);
    expect(await errorsOf(addCoverable(db, branch.id, { kind: 'Vehicle', effFrom: '2026-08-01', effTo: '2026-08-01' }, 'u'))).toEqual([expect.stringMatching(/from date must be before/i)]);
    expect(await errorsOf(addCoverable(db, branch.id, { kind: 'Spaceship' as never }, 'u'))).toEqual([expect.stringMatching(/kind/i)]);

    const vehicle = await addCoverable(db, branch.id, { kind: 'Vehicle', effTo: '2026-10-01' }, 'u');
    expect(await errorsOf(addCoverable(db, branch.id, { kind: 'Driver', fixedId: vehicle.fixedId, effFrom: '2026-10-01' }, 'u'))).toEqual([expect.stringMatching(/same kind/i)]);

    // The database checks the period too, even for a row written directly.
    await expect(
      db.query(
        `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, created_by)
         values ($1, gen_random_uuid(), 'Vehicle', '2026-01-01', '2026-06-01', 'sql')`,
        [branch.id],
      ),
    ).rejects.toThrow(/inside the policy period/);
  });

  it('attach coverages to a coverable of the same branch, with their term values', async () => {
    const { branch } = await newBranch();
    const vehicle = await addCoverable(db, branch.id, { kind: 'Vehicle', attributes: swift }, 'u');

    const od = await addCoverage(db, branch.id, { coverableFixedId: vehicle.fixedId, patternCode: 'MOTOR_OD', terms: { idv: 50000000, vol_deductible: 0 } }, 'agent.one');
    expect(od).toMatchObject({ coverableFixedId: vehicle.fixedId, patternCode: 'MOTOR_OD', effFrom: '2026-04-01', effTo: '2027-04-01', terms: { idv: 50000000, vol_deductible: 0 } });

    // From 1 October the insured value changes: a second slice of the same coverage.
    const first = await addCoverage(db, branch.id, { coverableFixedId: vehicle.fixedId, patternCode: 'ZERO_DEP', effTo: '2026-10-01' }, 'u');
    await addCoverage(db, branch.id, { coverableFixedId: vehicle.fixedId, patternCode: 'ZERO_DEP', fixedId: first.fixedId, effFrom: '2026-10-01', terms: { note: 'renewed add-on' } }, 'u');

    const june = await getBranchAsOf(db, branch.id, '2026-06-01');
    expect(june?.coverages.map((c) => c.patternCode).sort()).toEqual(['MOTOR_OD', 'ZERO_DEP']);
    const december = await getBranchAsOf(db, branch.id, '2026-12-01');
    expect(december?.coverages.find((c) => c.patternCode === 'ZERO_DEP')?.terms).toEqual({ note: 'renewed add-on' });

    expect(await errorsOf(addCoverage(db, branch.id, { coverableFixedId: '00000000-0000-0000-0000-000000000000', patternCode: 'MOTOR_OD' }, 'u'))).toEqual([
      expect.stringMatching(/coverable.*does not exist/i),
    ]);
    expect(await errorsOf(addCoverage(db, branch.id, { coverableFixedId: vehicle.fixedId, patternCode: 'motor od' }, 'u'))).toEqual([expect.stringMatching(/pattern code/i)]);
  });
});

describe('a bound version is never edited (document section 5)', () => {
  // Binding arrives in step D6. Here we simply mark a branch as bound, the way binding will.
  async function boundBranch() {
    const { branch } = await newBranch();
    const vehicle = await addCoverable(db, branch.id, { kind: 'Vehicle', attributes: swift }, 'u');
    const coverage = await addCoverage(db, branch.id, { coverableFixedId: vehicle.fixedId, patternCode: 'MOTOR_OD', terms: { idv: 50000000 } }, 'u');
    await db.query("update policy.policy_period set status = 'bound', version = 1 where id = $1", [branch.id]);
    return { branch, vehicle, coverage };
  }

  it('is refused by the code: nothing can be added to a bound version', async () => {
    const { branch, vehicle } = await boundBranch();
    expect(await errorsOf(addCoverable(db, branch.id, { kind: 'Vehicle' }, 'u'))).toEqual([expect.stringMatching(/bound policy version cannot be changed/i)]);
    expect(await errorsOf(addCoverage(db, branch.id, { coverableFixedId: vehicle.fixedId, patternCode: 'ZERO_DEP' }, 'u'))).toEqual([
      expect.stringMatching(/bound policy version cannot be changed/i),
    ]);
  });

  it('is refused by the database itself: no insert, update or delete on its rows, and not on the period', async () => {
    const { branch } = await boundBranch();
    const refused = /bound policy version cannot be changed/;

    await expect(db.query("update policy.coverable set kind = 'Driver' where branch_id = $1", [branch.id])).rejects.toThrow(refused);
    await expect(db.query('delete from policy.coverable where branch_id = $1', [branch.id])).rejects.toThrow(refused);
    await expect(db.query("update policy.coverage set pattern_code = 'OTHER' where branch_id = $1", [branch.id])).rejects.toThrow(refused);
    await expect(db.query('delete from policy.coverage where branch_id = $1', [branch.id])).rejects.toThrow(refused);
    await expect(
      db.query(
        `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, created_by)
         values ($1, gen_random_uuid(), 'Vehicle', '2026-04-01', '2027-04-01', 'sql')`,
        [branch.id],
      ),
    ).rejects.toThrow(refused);
    await expect(db.query("update policy.policy_period set period_end = '2027-05-01' where id = $1", [branch.id])).rejects.toThrow(refused);
    await expect(db.query('delete from policy.policy_period where id = $1', [branch.id])).rejects.toThrow(refused);
  });

  it('has a version number if and only if it is bound', async () => {
    const { branch } = await newBranch();
    await expect(db.query("update policy.policy_period set status = 'bound' where id = $1", [branch.id])).rejects.toThrow();
    await expect(db.query('update policy.policy_period set version = 1 where id = $1', [branch.id])).rejects.toThrow();
  });
});

describe('the audit log for policies', () => {
  it('records who created each policy, job, branch, coverable and coverage', async () => {
    const { policy, job, branch } = await newBranch();
    const vehicle = await addCoverable(db, branch.id, { kind: 'Vehicle', attributes: swift }, 'agent.two');
    await addCoverage(db, branch.id, { coverableFixedId: vehicle.fixedId, patternCode: 'MOTOR_OD', terms: { idv: 50000000 } }, 'agent.two');

    const forPolicy = await listAuditEntries(db, { entityType: 'policy', entityId: policy.id });
    expect(forPolicy.map((e) => [e.actor, e.action])).toEqual([['agent.one', 'policy.create']]);
    const forJob = await listAuditEntries(db, { entityType: 'job', entityId: job.id });
    expect(forJob[0]).toMatchObject({ actor: 'agent.one', action: 'job.start', details: { type: 'submission', policyId: policy.id } });
    const forBranch = await listAuditEntries(db, { entityType: 'policy_period', entityId: branch.id });
    expect(forBranch.map((e) => [e.actor, e.action])).toEqual([
      ['agent.one', 'branch.create'],
      ['agent.two', 'coverable.add'],
      ['agent.two', 'coverage.add'],
    ]);
  });
});
