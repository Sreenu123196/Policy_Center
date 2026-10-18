import { fileURLToPath } from 'node:url';
import type { Database } from '../platform/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact } from '../contacts/index.js';
import { createProducerCode, createProducerOrganisation, listAuditEntries, ValidationError } from '../platform/index.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { createAccount } from './account-repository.js';
import type { Account } from './account.js';
import { bindJob, issueJob } from './bind.js';
import { listConflicts, rebaseJob, resolveConflict } from './merge.js';
import { changeCoverage, listTransactions, removeCoverage, startPolicyChange } from './policy-change.js';
import { addCoverable, addCoverage, getBranch, getBranchAsOf, getJob } from './policy-repository.js';
import { loadProductCatalogue } from './product-catalogue.js';
import { loadRateBooks } from './rate-book.js';
import { createQuoter } from './rating.js';
import { quoteBranch, startSubmission } from './submission.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const catalogue = loadProductCatalogue(`${configFolder}products/`);
const quoteDeps = { catalogue, quoter: createQuoter(loadRateBooks(`${configFolder}ratebooks/`, catalogue)) };
const bindDeps = { catalogue };
const PRODUCT = 'MOTOR_PRIVATE_CAR';
const START = '2026-10-15';
const END = '2027-10-15';
const TODAY = '2026-10-16';
const JAN1 = '2027-01-01';
const DEC1 = '2026-12-01';
const MAR1 = '2027-03-01';

let db: Database;
let person: Account;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db);
  const acme = await createProducerOrganisation(db, { name: 'Acme Insurance Agency' }, 'admin');
  await createProducerCode(db, { code: 'PC-100', organisationId: acme.id }, 'admin');
  const address = { line1: '12 Test Street', city: 'Hyderabad', state: 'Telangana', pinCode: '500081' };
  const asha = await createContact(db, { kind: 'person', name: 'Asha Rao', address }, 'admin');
  person = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'agent.one');
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

// Version 1: Rs 5,00,000 insured value, 1197 cc, 2 claim-free years; bound and issued.
async function issuedPolicy() {
  const started = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'agent.one');
  const car = await addCoverable(
    db,
    started.branch.id,
    { kind: 'Vehicle', attributes: { make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001', engineCc: 1197, claimFreeYears: 2 } },
    'agent.one',
  );
  const covers: Record<string, string> = {};
  for (const [code, terms] of [['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: 50000000 }]] as const) {
    covers[code] = (await addCoverage(db, started.branch.id, { coverableFixedId: car.fixedId, patternCode: code, terms }, 'agent.one')).fixedId;
  }
  await quoteBranch(db, quoteDeps, started.branch.id, 'agent.one', { today: TODAY });
  await bindJob(db, bindDeps, started.job.id, { branchId: started.branch.id }, 'agent.one', { today: TODAY });
  await issueJob(db, bindDeps, started.job.id, 'agent.one', { today: TODAY });
  return { ...started, car, covers };
}

type Change = Awaited<ReturnType<typeof startPolicyChange>>;

const quote = (change: Change) => quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: JAN1 });
const bind = (change: Change) => bindJob(db, bindDeps, change.job.id, { branchId: change.branch.id }, 'agent.two', { today: JAN1 });
const start = (policyId: string, effectiveDate: string) => startPolicyChange(db, { policyId, effectiveDate }, 'agent.two');
const quoteAndBind = async (change: Change) => {
  await quote(change);
  return bind(change);
};

// The values of one field of one object over time: [from, to, value] for each slice.
async function timeline(branchId: string, kind: 'coverage' | 'coverable', fixedId: string, field: string) {
  const column = kind === 'coverage' ? 'terms' : 'attributes';
  const rows = await db.query<{ eff_from: string; eff_to: string; value: unknown }>(
    `select to_char(eff_from, 'YYYY-MM-DD') as eff_from, to_char(eff_to, 'YYYY-MM-DD') as eff_to, ${column} -> $3 as value
       from policy.${kind} where branch_id = $1 and fixed_id = $2 order by eff_from`,
    [branchId, fixedId, field],
  );
  return rows.rows.map((r) => [r.eff_from, r.eff_to, r.value] as const);
}

describe('out-of-sequence changes: the scenario matrix (document section 6, Appendix B)', () => {
  it('S1 carries an earlier change forward, keeping a later change to another thing (the document example)', async () => {
    // Version 2 adds zero depreciation from 1 January. Version 3 is entered later but takes effect from 1 December.
    const { policy, covers } = await issuedPolicy();
    const v2 = await start(policy.id, JAN1);
    const { coverables } = (await getBranchAsOf(db, v2.branch.id, START))!;
    const zd = await addCoverage(db, v2.branch.id, { coverableFixedId: coverables[0]!.fixedId, patternCode: 'ZERO_DEP', effFrom: JAN1 }, 'agent.two');
    await quoteAndBind(v2);

    const v3 = await start(policy.id, DEC1);
    await changeCoverage(db, v3.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');

    expect(await listConflicts(db, v3.branch.id)).toEqual([]);
    expect(await timeline(v3.branch.id, 'coverage', covers.MOTOR_OD!, 'idv')).toEqual([
      [START, DEC1, 50000000],
      [DEC1, END, 70000000],
    ]);
    expect((await getBranchAsOf(db, v3.branch.id, '2027-02-01'))!.coverages.map((c) => c.patternCode)).toContain('ZERO_DEP'); // the later change is kept
    expect(zd.fixedId).toBeDefined();

    // Re-rated slice by slice and compared with version 2: premium +493,678 and tax +88,862, effective from 1 December.
    expect(await quote(v3)).toMatchObject({ premiumPaise: 2256990, taxPaise: 406258 });
    await bind(v3);
    const last = (await listTransactions(db, policy.id)).at(-1)!;
    expect(last).toMatchObject({ version: 3, kind: 'change', effectiveDate: DEC1, premiumPaise: 493678, taxPaise: 88862, totalPaise: 582540 });
  });

  it('S2 finds a conflict when the later change set the same field: the later change wins by default, and the user decides', async () => {
    const { policy, covers } = await issuedPolicy();
    const v2 = await start(policy.id, JAN1);
    await changeCoverage(db, v2.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await quoteAndBind(v2);

    const v3 = await start(policy.id, DEC1);
    await changeCoverage(db, v3.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');

    expect(await timeline(v3.branch.id, 'coverage', covers.MOTOR_OD!, 'idv')).toEqual([
      [START, DEC1, 50000000],
      [DEC1, JAN1, 70000000],
      [JAN1, END, 60000000], // the later change wins from its own date
    ]);
    const conflicts = await listConflicts(db, v3.branch.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ objectKind: 'coverage', fixedId: covers.MOTOR_OD, field: 'idv', editDate: DEC1, laterVersion: 2, laterDate: JAN1, ourValue: 70000000, laterValue: 60000000, resolution: null });
  });

  it('S2a lets the user confirm the later change ("keep later"): the price can then be made', async () => {
    const { policy, covers } = await issuedPolicy();
    const v2 = await start(policy.id, JAN1);
    await changeCoverage(db, v2.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await quoteAndBind(v2);
    const v3 = await start(policy.id, DEC1);
    await changeCoverage(db, v3.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');

    expect(await errorsOf(quote(v3))).toEqual([expect.stringMatching(/resolve.*conflict.*idv/i)]);
    const [conflict] = await listConflicts(db, v3.branch.id);
    const resolved = await resolveConflict(db, conflict!.id, { resolution: 'keep_later', reason: 'The customer confirmed the January value' }, 'uw.one');
    expect(resolved).toMatchObject({ resolution: 'keep_later', resolvedBy: 'uw.one', reason: 'The customer confirmed the January value' });
    expect(await timeline(v3.branch.id, 'coverage', covers.MOTOR_OD!, 'idv')).toEqual([
      [START, DEC1, 50000000],
      [DEC1, JAN1, 70000000],
      [JAN1, END, 60000000],
    ]);
    await expect(quote(v3)).resolves.toBeDefined();
  });

  it('S2b lets the user override the later change: the new value runs to the end of the period', async () => {
    const { policy, covers } = await issuedPolicy();
    const v2 = await start(policy.id, JAN1);
    await changeCoverage(db, v2.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await quoteAndBind(v2);
    const v3 = await start(policy.id, DEC1);
    await changeCoverage(db, v3.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');

    const [conflict] = await listConflicts(db, v3.branch.id);
    await resolveConflict(db, conflict!.id, { resolution: 'override', reason: 'The January request was a mistake' }, 'uw.one');
    expect(await timeline(v3.branch.id, 'coverage', covers.MOTOR_OD!, 'idv')).toEqual([
      [START, DEC1, 50000000],
      [DEC1, JAN1, 70000000],
      [JAN1, END, 70000000],
    ]);
    await expect(quote(v3)).resolves.toBeDefined();
    const entries = await listAuditEntries(db, { entityType: 'policy_period', entityId: v3.branch.id });
    expect(entries.find((e) => e.action === 'merge.resolve')).toMatchObject({ actor: 'uw.one', reason: 'The January request was a mistake', details: { resolution: 'override', field: 'idv' } });
  });

  it('S2c needs a reason, accepts only a known resolution, and cannot be resolved twice', async () => {
    const { policy, covers } = await issuedPolicy();
    const v2 = await start(policy.id, JAN1);
    await changeCoverage(db, v2.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await quoteAndBind(v2);
    const v3 = await start(policy.id, DEC1);
    await changeCoverage(db, v3.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');
    const [conflict] = await listConflicts(db, v3.branch.id);

    expect(await errorsOf(resolveConflict(db, conflict!.id, { resolution: 'keep_later', reason: ' ' }, 'u'))).toEqual([expect.stringMatching(/reason/i)]);
    expect(await errorsOf(resolveConflict(db, conflict!.id, { resolution: 'toss_a_coin' as never, reason: 'x' }, 'u'))).toEqual([expect.stringMatching(/resolution/i)]);
    expect(await errorsOf(resolveConflict(db, '00000000-0000-0000-0000-000000000000', { resolution: 'keep_later', reason: 'x' }, 'u'))).toEqual([expect.stringMatching(/conflict does not exist/i)]);
    await resolveConflict(db, conflict!.id, { resolution: 'keep_later', reason: 'ok' }, 'u');
    expect(await errorsOf(resolveConflict(db, conflict!.id, { resolution: 'override', reason: 'again' }, 'u'))).toEqual([expect.stringMatching(/already resolved/i)]);
  });

  it('S3 has no conflict when the later change touched a different field of the same cover', async () => {
    const { policy, covers } = await issuedPolicy();
    const v2 = await start(policy.id, JAN1);
    await changeCoverage(db, v2.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { vol_deductible: 250000 } }, 'agent.two');
    await quoteAndBind(v2);

    const v3 = await start(policy.id, DEC1);
    await changeCoverage(db, v3.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');
    expect(await listConflicts(db, v3.branch.id)).toEqual([]);
    expect(await timeline(v3.branch.id, 'coverage', covers.MOTOR_OD!, 'idv')).toEqual([[START, DEC1, 50000000], [DEC1, JAN1, 70000000], [JAN1, END, 70000000]]);
    expect(await timeline(v3.branch.id, 'coverage', covers.MOTOR_OD!, 'vol_deductible')).toEqual([[START, DEC1, null], [DEC1, JAN1, null], [JAN1, END, 250000]]);
  });

  it('S4 is not a conflict when the change is in sequence: an edit dated on or after the latest change simply follows it', async () => {
    const { policy, covers } = await issuedPolicy();
    const v2 = await start(policy.id, JAN1);
    await changeCoverage(db, v2.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await quoteAndBind(v2);

    const sameDay = await start(policy.id, JAN1);
    await changeCoverage(db, sameDay.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 65000000 } }, 'agent.two');
    expect(await listConflicts(db, sameDay.branch.id)).toEqual([]);

    const later = await start(policy.id, MAR1);
    await changeCoverage(db, later.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');
    expect(await listConflicts(db, later.branch.id)).toEqual([]);
    expect(await timeline(later.branch.id, 'coverage', covers.MOTOR_OD!, 'idv')).toEqual([[START, JAN1, 50000000], [JAN1, MAR1, 60000000], [MAR1, END, 70000000]]);
  });

  it('S5 respects a later removal: nothing is left after the removal date, so there is nothing to conflict with', async () => {
    const { policy } = await issuedPolicy();
    const v2 = await start(policy.id, JAN1);
    const { coverables } = (await getBranchAsOf(db, v2.branch.id, START))!;
    const zd = await addCoverage(db, v2.branch.id, { coverableFixedId: coverables[0]!.fixedId, patternCode: 'ZERO_DEP', effFrom: START }, 'agent.two');
    await quoteAndBind(v2);

    // Version 3 removes zero depreciation from 1 April. Version 4 is dated 1 February and edits a term of it.
    const v3 = await start(policy.id, '2027-04-01');
    await removeCoverage(db, v3.branch.id, { coverageFixedId: zd.fixedId }, 'agent.two');
    await quoteAndBind(v3);
    const v4 = await start(policy.id, '2027-02-01');
    await changeCoverage(db, v4.branch.id, { coverageFixedId: zd.fixedId, terms: { note: 'x' } }, 'agent.two');

    expect(await listConflicts(db, v4.branch.id)).toEqual([]);
    expect(await timeline(v4.branch.id, 'coverage', zd.fixedId, 'note')).toEqual([[START, '2027-02-01', null], ['2027-02-01', '2027-04-01', 'x']]);
  });

  it('S6 ignores jobs that are not bound: another open job never causes a conflict', async () => {
    const { policy, covers } = await issuedPolicy();
    const open = await start(policy.id, JAN1);
    await changeCoverage(db, open.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two'); // stays a draft
    const other = await start(policy.id, DEC1);
    await changeCoverage(db, other.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');
    expect(await listConflicts(db, other.branch.id)).toEqual([]);
  });
});

describe('preemption and rebase (document section 6)', () => {
  it('preempts the other open change jobs of the policy when one binds, and records why', async () => {
    const { policy, covers } = await issuedPolicy();
    const first = await start(policy.id, JAN1);
    const drafting = await start(policy.id, DEC1);
    const quoted = await start(policy.id, MAR1);
    for (const [change, idv] of [[first, 60000000], [drafting, 62000000], [quoted, 65000000]] as const) {
      await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv } }, 'agent.two');
    }
    await quote(first);
    await quote(quoted);
    await bind(first);

    expect((await getJob(db, drafting.job.id))?.status).toBe('preempted');
    expect((await getJob(db, quoted.job.id))?.status).toBe('preempted');
    expect((await getJob(db, first.job.id))?.status).toBe('bound');
    const entry = (await listAuditEntries(db, { entityType: 'job', entityId: quoted.job.id })).at(-1)!;
    expect(entry).toMatchObject({ action: 'job.status', details: { from: 'quoted', to: 'preempted' }, reason: expect.stringMatching(/version 2.*J-0000002/i) });
  });

  it('refuses to edit, quote or bind a preempted job until it is rebased', async () => {
    const { policy, covers } = await issuedPolicy();
    const first = await start(policy.id, JAN1);
    const second = await start(policy.id, MAR1);
    await changeCoverage(db, first.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await changeCoverage(db, second.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 65000000 } }, 'agent.two');
    await quoteAndBind(first);

    expect(await errorsOf(changeCoverage(db, second.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 66000000 } }, 'u'))).toEqual([expect.stringMatching(/preempted.*rebase/i)]);
    expect(await errorsOf(quote(second))).toEqual([expect.stringMatching(/preempted.*rebase/i)]);
    expect(await errorsOf(bind(second))).toEqual([expect.stringMatching(/only a quoted job can be bound \(this one is preempted\)/i)]);
  });

  it('rebases onto the new version, reapplying the edits of the old working copy, and withdraws the old copy', async () => {
    const { policy, covers } = await issuedPolicy();
    const first = await start(policy.id, JAN1);
    const second = await start(policy.id, MAR1);
    const { coverables } = (await getBranchAsOf(db, second.branch.id, START))!;
    const zd = await addCoverage(db, second.branch.id, { coverableFixedId: coverables[0]!.fixedId, patternCode: 'ZERO_DEP', effFrom: MAR1 }, 'agent.two');
    await changeCoverage(db, second.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { vol_deductible: 250000 } }, 'agent.two'); // from 1 March
    await changeCoverage(db, first.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await quoteAndBind(first); // version 2; the second job is preempted

    const rebased = await rebaseJob(db, second.job.id, 'agent.two');
    expect(rebased.job.status).toBe('draft');
    expect(rebased.branch).toMatchObject({ jobId: second.job.id, status: 'draft', basedOnId: first.branch.id, label: 'Option B' });
    expect((await getBranch(db, second.branch.id))?.status).toBe('withdrawn');

    // The new copy has version 2's idv change AND the second job's own edits.
    expect(await timeline(rebased.branch.id, 'coverage', covers.MOTOR_OD!, 'idv')).toEqual([[START, JAN1, 50000000], [JAN1, MAR1, 60000000], [MAR1, END, 60000000]]);
    expect(await timeline(rebased.branch.id, 'coverage', covers.MOTOR_OD!, 'vol_deductible')).toEqual([[START, JAN1, null], [JAN1, MAR1, null], [MAR1, END, 250000]]);
    expect((await getBranchAsOf(db, rebased.branch.id, '2027-06-01'))!.coverages.map((c) => c.patternCode)).toContain('ZERO_DEP');
    expect(await listConflicts(db, rebased.branch.id)).toEqual([]);
    expect(zd.fixedId).toBeDefined();

    // It can be priced and bound as version 3, with a transaction against version 2.
    await quoteAndBind({ job: rebased.job, branch: rebased.branch });
    expect((await listTransactions(db, policy.id)).map((t) => t.version)).toEqual([1, 2, 3]);
    expect((await getBranch(db, rebased.branch.id))?.version).toBe(3);
  });

  it('shows a conflict after a rebase when the new version changed the same thing earlier than the old edit', async () => {
    const { policy, covers } = await issuedPolicy();
    const first = await start(policy.id, MAR1);
    const second = await start(policy.id, DEC1);
    await changeCoverage(db, first.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two'); // from 1 March
    await changeCoverage(db, second.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two'); // from 1 December
    await quoteAndBind(first);

    const rebased = await rebaseJob(db, second.job.id, 'agent.two');
    const conflicts = await listConflicts(db, rebased.branch.id);
    expect(conflicts.map((c) => [c.field, c.editDate, c.laterVersion, c.laterDate, c.ourValue, c.laterValue])).toEqual([['idv', DEC1, 2, MAR1, 70000000, 60000000]]);
    expect(await errorsOf(quote({ job: rebased.job, branch: rebased.branch }))).toEqual([expect.stringMatching(/resolve.*conflict/i)]);
  });

  it('refuses to rebase a job that was not preempted, and one whose edits no longer fit (the cover was removed)', async () => {
    const { policy, covers } = await issuedPolicy();
    const first = await start(policy.id, JAN1);
    const second = await start(policy.id, MAR1);
    expect(await errorsOf(rebaseJob(db, second.job.id, 'u'))).toEqual([expect.stringMatching(/only a preempted job can be rebased/i)]);

    const { coverables } = (await getBranchAsOf(db, first.branch.id, START))!;
    const zd = await addCoverage(db, first.branch.id, { coverableFixedId: coverables[0]!.fixedId, patternCode: 'ZERO_DEP', effFrom: START }, 'agent.two');
    await quoteAndBind(first);
    const third = await start(policy.id, JAN1);
    const fourth = await start(policy.id, MAR1);
    await changeCoverage(db, fourth.branch.id, { coverageFixedId: zd.fixedId, terms: { note: 'x' } }, 'agent.two');
    await removeCoverage(db, third.branch.id, { coverageFixedId: zd.fixedId }, 'agent.two');
    await quoteAndBind(third); // removes zero depreciation; the fourth job is preempted

    expect(await errorsOf(rebaseJob(db, fourth.job.id, 'agent.two'))).toEqual([expect.stringMatching(/cannot be reapplied.*coverage does not exist/i)]);
    expect((await getJob(db, fourth.job.id))?.status).toBe('preempted'); // nothing was changed
    expect(covers).toBeDefined();
  });
});
