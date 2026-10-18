import type { Database } from '../platform/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { bindDeps, cancelDeps, createCustomer, issueGoldenPolicy, quoteDeps, renewDeps } from '../testing/golden-policy.js';
import type { Account } from './account.js';
import { bindJob } from './bind.js';
import { startCancellation, startReinstatement } from './cancellation.js';
import { findPolicyNumbersByRegistration, getPolicyAsOf } from './as-of.js';
import { changeCoverage, startPolicyChange } from './policy-change.js';
import { startRenewal } from './renewal.js';
import { quoteBranch } from './submission.js';

let db: Database;
let customer: Account;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db);
  await loadTestConfiguration(db);
  customer = await createCustomer(db);
});

// The golden policy runs 15-10-2026 to 15-10-2027 (the last day of cover is 14-10-2027).
describe('the policy as it was on a date (document section 15: "Policy as of the loss date")', () => {
  it('describes the cover on a day inside the term: the vehicle, the covers and their terms', async () => {
    const { policy } = await issueGoldenPolicy(db, customer);
    const onDate = await getPolicyAsOf(db, policy.policyNumber, '2026-12-01');
    expect(onDate).toMatchObject({
      policyNumber: 'PL-0000001',
      accountId: customer.id,
      date: '2026-12-01',
      status: 'in_force',
      termNumber: 1,
      version: 1,
      productCode: 'MOTOR_PRIVATE_CAR',
      productVersion: '2026.10',
    });
    expect(onDate?.vehicles).toEqual([expect.objectContaining({ make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001' })]);
    expect(onDate?.coverages.map((c) => [c.patternCode, c.terms])).toEqual([['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: 50000000 }]]);
    expect(onDate?.namedInsuredContactId).toEqual(expect.any(String));
  });

  it('is in force on the first day and the last day of the term, and not before or after', async () => {
    await issueGoldenPolicy(db, customer);
    const status = async (date: string) => (await getPolicyAsOf(db, 'PL-0000001', date))?.status;
    expect(await status('2026-10-14')).toBe('not_in_force');
    expect(await status('2026-10-15')).toBe('in_force');
    expect(await status('2027-10-14')).toBe('in_force');
    expect(await status('2027-10-15')).toBe('not_in_force');
    expect((await getPolicyAsOf(db, 'PL-0000001', '2026-10-14'))).toMatchObject({ reason: 'outside_term', message: expect.stringMatching(/no policy term covers 14-10-2026/i) });
  });

  it('shows the values that were true on that day: a change takes effect from its date, not before', async () => {
    const { policy, covers } = await issueGoldenPolicy(db, customer);
    const change = await startPolicyChange(db, { policyId: policy.id, effectiveDate: '2027-01-01' }, 'agent.two');
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });
    await bindJob(db, bindDeps, change.job.id, { branchId: change.branch.id }, 'agent.two', { today: '2027-01-01' });

    const idv = async (date: string) => (await getPolicyAsOf(db, 'PL-0000001', date))?.coverages.find((c) => c.patternCode === 'MOTOR_OD')?.terms.idv;
    expect(await idv('2026-12-31')).toBe(50000000);
    expect(await idv('2027-01-01')).toBe(60000000);
    expect((await getPolicyAsOf(db, 'PL-0000001', '2027-01-01'))?.version).toBe(2);
  });

  it('says a cancelled policy was in force until the day before the cancellation, and cancelled after', async () => {
    const { policy } = await issueGoldenPolicy(db, customer);
    const cancel = await startCancellation(db, cancelDeps, { policyId: policy.id, effectiveDate: '2027-01-01', reasonCode: 'customer_request' }, 'agent.two', { today: '2026-12-20' });
    await bindJob(db, bindDeps, cancel.job.id, { branchId: cancel.branch.id }, 'agent.two', { today: '2026-12-20' });
    expect((await getPolicyAsOf(db, 'PL-0000001', '2026-12-31'))?.status).toBe('in_force');
    expect(await getPolicyAsOf(db, 'PL-0000001', '2027-01-01')).toMatchObject({ status: 'not_in_force', reason: 'cancelled', message: expect.stringMatching(/cancelled from 01-01-2027/i), vehicles: [], coverages: [] });
  });

  it('reports a gap in cover after a reinstatement with a gap, and cover again after it', async () => {
    const { policy } = await issueGoldenPolicy(db, customer);
    const cancel = await startCancellation(db, cancelDeps, { policyId: policy.id, effectiveDate: '2027-01-01', reasonCode: 'customer_request' }, 'agent.two', { today: '2026-12-20' });
    await bindJob(db, bindDeps, cancel.job.id, { branchId: cancel.branch.id }, 'agent.two', { today: '2026-12-20' });
    const back = await startReinstatement(db, cancelDeps, { policyId: policy.id, withGap: true, reinstatementDate: '2027-02-01' }, 'agent.two', { today: '2027-01-05' });
    await quoteBranch(db, quoteDeps, back.branch.id, 'agent.two', { today: '2027-01-05' });
    await bindJob(db, bindDeps, back.job.id, { branchId: back.branch.id }, 'agent.two', { today: '2027-01-05' });

    expect((await getPolicyAsOf(db, 'PL-0000001', '2026-12-31'))?.status).toBe('in_force');
    expect(await getPolicyAsOf(db, 'PL-0000001', '2027-01-15')).toMatchObject({ status: 'not_in_force', reason: 'gap_in_cover' });
    expect((await getPolicyAsOf(db, 'PL-0000001', '2027-02-01'))?.status).toBe('in_force');
  });

  it('uses the term that contains the date when the policy has been renewed', async () => {
    const { policy } = await issueGoldenPolicy(db, customer);
    const renewal = await startRenewal(db, renewDeps, { policyId: policy.id }, 'agent.two', { today: '2027-09-15' });
    await quoteBranch(db, quoteDeps, renewal.branch.id, 'agent.two', { today: '2027-09-15' });
    await bindJob(db, bindDeps, renewal.job.id, { branchId: renewal.branch.id }, 'agent.two', { today: '2027-09-15' });
    expect(await getPolicyAsOf(db, 'PL-0000001', '2027-10-14')).toMatchObject({ termNumber: 1, status: 'in_force' });
    expect(await getPolicyAsOf(db, 'PL-0000001', '2027-10-15')).toMatchObject({ termNumber: 2, version: 1, status: 'in_force' });
  });

  it('ignores a version that is not bound yet, and knows nothing of an unknown policy or a bad date', async () => {
    const { policy } = await issueGoldenPolicy(db, customer);
    const draft = await startPolicyChange(db, { policyId: policy.id, effectiveDate: '2027-01-01' }, 'agent.two');
    await changeCoverage(db, draft.branch.id, { coverageFixedId: (await getPolicyAsOf(db, 'PL-0000001', '2027-02-01'))!.coverages[2]!.fixedId, terms: { idv: 70000000 } }, 'agent.two');
    expect((await getPolicyAsOf(db, 'PL-0000001', '2027-02-01'))?.coverages[2]?.terms.idv).toBe(50000000); // the open job does not count
    expect(await getPolicyAsOf(db, 'PL-9999999', '2027-02-01')).toBeNull();
    await expect(getPolicyAsOf(db, 'PL-0000001', '2027-02-30')).rejects.toThrow(/real date/i);
  });
});

describe('finding the policy of a vehicle', () => {
  it('finds the policies in force on a date for a registration number, ignoring case and spaces', async () => {
    await issueGoldenPolicy(db, customer);
    expect(await findPolicyNumbersByRegistration(db, 'ts09 xx0001', '2026-12-01')).toEqual(['PL-0000001']);
    expect(await findPolicyNumbersByRegistration(db, 'TS09XX0001', '2025-01-01')).toEqual([]);
    expect(await findPolicyNumbersByRegistration(db, 'KA01AA0001', '2026-12-01')).toEqual([]);
  });
});
