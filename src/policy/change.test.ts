import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact } from '../contacts/index.js';
import { createProducerCode, createProducerOrganisation, listAuditEntries, listUnpublishedEvents, ValidationError } from '../platform/index.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { createAccount } from './account-repository.js';
import type { Account } from './account.js';
import { bindSubmission, issueSubmission, listDocuments } from './bind.js';
import { changeCoverable, changeCoverage, listTransactions, removeCoverage, startPolicyChange } from './policy-change.js';
import { addCoverable, addCoverage, getBranch, getBranchAsOf, getJob } from './policy-repository.js';
import { loadProductCatalogue } from './product-catalogue.js';
import { loadRateBooks } from './rate-book.js';
import { createQuoter } from './rating.js';
import { quoteBranch, startSubmission } from './submission.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const catalogue = loadProductCatalogue(`${configFolder}products/`);
const quoter = createQuoter(loadRateBooks(`${configFolder}ratebooks/`, catalogue));
const quoteDeps = { catalogue, quoter };
const bindDeps = { catalogue };
const PRODUCT = 'MOTOR_PRIVATE_CAR';
const START = '2026-10-15';
const END = '2027-10-15';
const TODAY = '2026-10-16';
const CHANGE_DAY = '2027-01-01'; // 78 days into the 365-day term

let db: PGlite;
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

// Version 1: the golden risk of D4 (Rs 5,00,000 insured value, 1197 cc, 2 claim-free years), bound and issued.
// Premium 1,574,600 + GST 283,428 = 1,858,028 paise for the whole year.
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
  await bindSubmission(db, bindDeps, started.job.id, { branchId: started.branch.id }, 'agent.one', { today: TODAY });
  await issueSubmission(db, bindDeps, started.job.id, 'agent.one', { today: TODAY });
  return { ...started, car, covers };
}

// Starts a change from the issued version, as of the change day.
async function startChange(policyId: string, effectiveDate = CHANGE_DAY) {
  return startPolicyChange(db, { policyId, effectiveDate }, 'agent.two');
}

const slicesOf = async (branchId: string, table: 'coverage' | 'coverable', fixedId: string) =>
  (
    await db.query<{ eff_from: string; eff_to: string; data: Record<string, unknown> }>(
      `select to_char(eff_from, 'YYYY-MM-DD') as eff_from, to_char(eff_to, 'YYYY-MM-DD') as eff_to, ${table === 'coverage' ? 'terms' : 'attributes'} as data
         from policy.${table} where branch_id = $1 and fixed_id = $2 order by eff_from`,
      [branchId, fixedId],
    )
  ).rows.map((r) => [r.eff_from, r.eff_to, r.data] as const);

describe('starting a policy change (document sections 5, 6 and 8)', () => {
  it('copies the latest bound version into a new branch of a new job, keeping the fixed ids', async () => {
    const { policy, branch, car, covers } = await issuedPolicy();
    const change = await startChange(policy.id);

    expect(change.job).toMatchObject({ type: 'policy_change', status: 'draft', policyId: policy.id, jobNumber: 'J-0000002' });
    expect(change.branch).toMatchObject({ jobId: change.job.id, basedOnId: branch.id, status: 'draft', version: null, periodStart: START, periodEnd: END, termNumber: 1, productVersion: '2026.10' });

    const original = await getBranchAsOf(db, branch.id, START);
    const copy = await getBranchAsOf(db, change.branch.id, START);
    expect(copy?.coverables.map((c) => c.fixedId)).toEqual([car.fixedId]);
    expect(copy?.coverages.map((c) => [c.fixedId, c.patternCode, c.terms])).toEqual(original?.coverages.map((c) => [c.fixedId, c.patternCode, c.terms]));
    expect(copy?.coverages.map((c) => c.fixedId).sort()).toEqual(Object.values(covers).sort());
  });

  it('refuses a policy with no bound version, an effective date outside the period, and an unknown policy', async () => {
    const draft = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'u');
    expect(await errorsOf(startChange(draft.policy.id))).toEqual([expect.stringMatching(/no bound version/i)]);

    const { policy } = await issuedPolicy();
    expect(await errorsOf(startChange(policy.id, '2026-10-14'))).toEqual([expect.stringMatching(/inside the policy period/i)]);
    expect(await errorsOf(startChange(policy.id, END))).toEqual([expect.stringMatching(/inside the policy period/i)]); // the end day is not covered
    expect(await errorsOf(startChange(policy.id, '2027-13-01'))).toEqual([expect.stringMatching(/effective date.*real date/i)]);
    expect(await errorsOf(startChange('00000000-0000-0000-0000-000000000000'))).toEqual([expect.stringMatching(/policy.*does not exist/i)]);
  });

  it('leaves version 1 exactly as it was while the change is edited', async () => {
    const { policy, branch, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    expect((await slicesOf(branch.id, 'coverage', covers.MOTOR_OD!)).map((s) => s[2])).toEqual([{ idv: 50000000 }]);
    expect((await getBranch(db, branch.id))?.status).toBe('bound');
  });
});

describe('editing from an effective date: slices (document section 6)', () => {
  it('splits the slice that spans the date and changes only the part from that date to the end of the period', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');

    expect(await slicesOf(change.branch.id, 'coverage', covers.MOTOR_OD!)).toEqual([
      [START, CHANGE_DAY, { idv: 50000000 }],
      [CHANGE_DAY, END, { idv: 70000000 }],
    ]);
  });

  it('keeps one fixed id across slices, so the as-of view shows the right value on each day (the boundary day belongs to the later slice)', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');
    const idvOn = async (date: string) => (await getBranchAsOf(db, change.branch.id, date))?.coverages.find((c) => c.patternCode === 'MOTOR_OD')?.terms.idv;
    expect(await idvOn('2026-12-31')).toBe(50000000);
    expect(await idvOn('2027-01-01')).toBe(70000000);
    expect(await idvOn('2027-10-14')).toBe(70000000);
  });

  it('applies a second change to every slice from its date: a slice that starts later is changed whole, a spanning one is split', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two'); // from 1 Jan
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, effectiveDate: '2026-12-01', terms: { vol_deductible: 250000 } }, 'agent.two');

    expect(await slicesOf(change.branch.id, 'coverage', covers.MOTOR_OD!)).toEqual([
      [START, '2026-12-01', { idv: 50000000 }],
      ['2026-12-01', CHANGE_DAY, { idv: 50000000, vol_deductible: 250000 }],
      [CHANGE_DAY, END, { idv: 70000000, vol_deductible: 250000 }],
    ]);
  });

  it('adds a cover from a date, and removes one from a date', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    const { coverables } = (await getBranchAsOf(db, change.branch.id, START))!;
    const zd = await addCoverage(db, change.branch.id, { coverableFixedId: coverables[0]!.fixedId, patternCode: 'ZERO_DEP', effFrom: CHANGE_DAY }, 'agent.two');
    expect(await slicesOf(change.branch.id, 'coverage', zd.fixedId)).toEqual([[CHANGE_DAY, END, {}]]);

    await removeCoverage(db, change.branch.id, { coverageFixedId: zd.fixedId, effectiveDate: '2027-07-01' }, 'agent.two');
    expect(await slicesOf(change.branch.id, 'coverage', zd.fixedId)).toEqual([[CHANGE_DAY, '2027-07-01', {}]]);

    await removeCoverage(db, change.branch.id, { coverageFixedId: covers.PA_OWNER_DRIVER!, effectiveDate: START }, 'agent.two'); // from day one: nothing is left
    expect(await slicesOf(change.branch.id, 'coverage', covers.PA_OWNER_DRIVER!)).toEqual([]);
  });

  it('changes the attributes of a vehicle from a date, for example a new registration after a transfer', async () => {
    const { policy, car } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverable(db, change.branch.id, { coverableFixedId: car.fixedId, effectiveDate: CHANGE_DAY, attributes: { registrationNumber: 'TS10YY0002' } }, 'agent.two');
    const regs = (await slicesOf(change.branch.id, 'coverable', car.fixedId)).map((s) => [s[0], s[1], s[2].registrationNumber]);
    expect(regs).toEqual([[START, CHANGE_DAY, 'TS09XX0001'], [CHANGE_DAY, END, 'TS10YY0002']]);
  });

  it('refuses a bad date, an unknown object, an empty change, and a date after the object ended', async () => {
    const { policy, covers, car } = await issuedPolicy();
    const change = await startChange(policy.id);
    const od = covers.MOTOR_OD!;
    expect(await errorsOf(changeCoverage(db, change.branch.id, { coverageFixedId: od, effectiveDate: END, terms: { idv: 1 } }, 'u'))).toEqual([expect.stringMatching(/inside the policy period/i)]);
    expect(await errorsOf(changeCoverage(db, change.branch.id, { coverageFixedId: od, effectiveDate: '2027-02-30', terms: { idv: 1 } }, 'u'))).toEqual([expect.stringMatching(/real date/i)]);
    expect(await errorsOf(changeCoverage(db, change.branch.id, { coverageFixedId: '00000000-0000-0000-0000-000000000000', terms: { idv: 1 } }, 'u'))).toEqual([expect.stringMatching(/coverage does not exist/i)]);
    expect(await errorsOf(changeCoverage(db, change.branch.id, { coverageFixedId: od, terms: {} }, 'u'))).toEqual([expect.stringMatching(/nothing to change/i)]);
    expect(await errorsOf(changeCoverable(db, change.branch.id, { coverableFixedId: car.fixedId, attributes: {} }, 'u'))).toEqual([expect.stringMatching(/nothing to change/i)]);

    await removeCoverage(db, change.branch.id, { coverageFixedId: od, effectiveDate: '2027-03-01' }, 'u');
    expect(await errorsOf(changeCoverage(db, change.branch.id, { coverageFixedId: od, effectiveDate: '2027-06-01', terms: { idv: 1 } }, 'u'))).toEqual([expect.stringMatching(/does not exist from that date/i)]);
  });

  it('uses the effective date of the job when none is given, and refuses to edit a bound version', async () => {
    const { policy, branch, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'u'); // job date: 1 Jan
    expect((await slicesOf(change.branch.id, 'coverage', covers.MOTOR_OD!)).map((s) => s[0])).toEqual([START, CHANGE_DAY]);
    expect(await errorsOf(changeCoverage(db, branch.id, { coverageFixedId: covers.MOTOR_OD!, effectiveDate: CHANGE_DAY, terms: { idv: 1 } }, 'u'))).toEqual([expect.stringMatching(/bound policy version cannot be changed/i)]);
  });

  it('writes every edit to the audit log with who made it', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.three');
    const entries = await listAuditEntries(db, { entityType: 'policy_period', entityId: change.branch.id });
    expect(entries.map((e) => e.action)).toEqual(['branch.create', 'coverage.change']);
    expect(entries[1]).toMatchObject({ actor: 'agent.three', details: { fixedId: covers.MOTOR_OD, effectiveDate: CHANGE_DAY, terms: { idv: 70000000 } } });
  });
});

describe('rating by slices: premium prorated by days (document section 9)', () => {
  it('prices a change as the sum of its slices: the days before the change at the old cover, the rest at the new', async () => {
    // 78 days at the old cover and 287 days with zero depreciation added; each cost is prorated by days / 365.
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    const { coverables } = (await getBranchAsOf(db, change.branch.id, START))!;
    await addCoverage(db, change.branch.id, { coverableFixedId: coverables[0]!.fixedId, patternCode: 'ZERO_DEP', effFrom: CHANGE_DAY }, 'agent.two');
    const quote = await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });

    expect(quote).toMatchObject({ premiumPaise: 1763312, taxPaise: 317396, totalPaise: 2080708 });
    const costs = Object.fromEntries(quote.worksheet.filter((l) => l.step.startsWith('cost ')).map((l) => [l.step, l.amountPaise]));
    expect(costs).toEqual({ 'cost MOTOR_TP': 341600, 'cost PA_OWNER_DRIVER': 33000, 'cost MOTOR_OD': 1200000, 'cost ZERO_DEP': 188712 });
    expect(quote.worksheet.filter((l) => l.step.startsWith('slice '))).toEqual([
      expect.objectContaining({ step: 'slice 2026-10-15 to 2027-01-01', amountPaise: expect.any(Number) }),
      expect.objectContaining({ step: 'slice 2027-01-01 to 2027-10-15', amountPaise: expect.any(Number) }),
    ]);
    expect(covers).toBeDefined();
  });

  it('prices a change of insured value from a date the same way', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');
    const quote = await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });
    expect(quote).toMatchObject({ premiumPaise: 1952024, taxPaise: 351364 });
  });

  it('checks every slice against the product: an insured value below the minimum from a date is refused with that date', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 100 } }, 'agent.two');
    expect(await errorsOf(quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' }))).toEqual([expect.stringMatching(/01-01-2027.*MOTOR_OD: idv must be between/)]);
  });

  it('a change that leaves everything as it was prices to exactly the old premium (nothing is lost to rounding)', async () => {
    const { policy } = await issuedPolicy();
    const change = await startChange(policy.id);
    const quote = await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });
    expect(quote).toMatchObject({ premiumPaise: 1574600, taxPaise: 283428 });
  });
});

describe('binding a change: version 2 and its transactions (document sections 5 and 8)', () => {
  it('binds as version 2, based on version 1, with a transaction for the difference (billing gets only the difference)', async () => {
    const { policy, branch, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');
    await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });
    const bound = await bindSubmission(db, bindDeps, change.job.id, { branchId: change.branch.id }, 'agent.two', { today: '2027-01-01' });

    expect(bound.branch).toMatchObject({ status: 'bound', version: 2, basedOnId: branch.id });
    expect(await listTransactions(db, policy.id)).toEqual([
      expect.objectContaining({ version: 1, kind: 'new_business', effectiveDate: START, premiumPaise: 1574600, taxPaise: 283428, totalPaise: 1858028 }),
      expect.objectContaining({ version: 2, kind: 'change', effectiveDate: CHANGE_DAY, premiumPaise: 377424, taxPaise: 67936, totalPaise: 445360 }),
    ]);

    const events = await listUnpublishedEvents(db);
    expect(events.map((e) => e.type)).toEqual(['PolicyBound', 'PolicyIssued', 'PolicyBound']);
    expect(events[2]).toMatchObject({ payload: { version: 2, transaction: { kind: 'change', effectiveDate: CHANGE_DAY, premiumPaise: 377424, taxPaise: 67936, totalPaise: 445360 } } });
  });

  it('records a refund as a negative transaction when cover is removed', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await removeCoverage(db, change.branch.id, { coverageFixedId: covers.PA_OWNER_DRIVER! }, 'agent.two');
    // The owner-driver cover is required, so quoting is refused until a replacement is chosen.
    expect(await errorsOf(quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' }))).toEqual([expect.stringMatching(/PA_OWNER_DRIVER is required/)]);

    // Remove an optional add-on instead: add it in version 2, then remove it in version 3, which gives a refund.
    const second = await startChange(policy.id);
    const { coverables } = (await getBranchAsOf(db, second.branch.id, START))!;
    const zd = await addCoverage(db, second.branch.id, { coverableFixedId: coverables[0]!.fixedId, patternCode: 'ZERO_DEP', effFrom: START }, 'agent.two');
    await quoteBranch(db, quoteDeps, second.branch.id, 'agent.two', { today: '2027-01-01' });
    await bindSubmission(db, bindDeps, second.job.id, { branchId: second.branch.id }, 'agent.two', { today: '2027-01-01' });

    const third = await startChange(policy.id, '2027-07-01');
    await removeCoverage(db, third.branch.id, { coverageFixedId: zd.fixedId }, 'agent.two');
    await quoteBranch(db, quoteDeps, third.branch.id, 'agent.two', { today: '2027-07-01' });
    await bindSubmission(db, bindDeps, third.job.id, { branchId: third.branch.id }, 'agent.two', { today: '2027-07-01' });

    const transactions = await listTransactions(db, policy.id);
    expect(transactions.map((t) => t.version)).toEqual([1, 2, 3]);
    expect(transactions[1]!.premiumPaise).toBe(240000); // zero depreciation for the whole year
    expect(transactions[2]!.premiumPaise).toBeLessThan(0); // the unused part of it comes back
    expect(transactions[2]!.totalPaise).toBe(transactions[2]!.premiumPaise + transactions[2]!.taxPaise);
  });

  it('refuses to bind a change that started from an older version (another job bound first); rebasing is step E2', async () => {
    const { policy, covers } = await issuedPolicy();
    const first = await startChange(policy.id);
    const second = await startChange(policy.id, '2027-02-01');
    for (const [change, idv] of [[first, 60000000], [second, 55000000]] as const) {
      await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv } }, 'agent.two');
      await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });
    }
    await bindSubmission(db, bindDeps, first.job.id, { branchId: first.branch.id }, 'agent.two', { today: '2027-01-01' });
    expect(await errorsOf(bindSubmission(db, bindDeps, second.job.id, { branchId: second.branch.id }, 'agent.two', { today: '2027-01-01' }))).toEqual([
      expect.stringMatching(/version 2 was bound after this job started.*rebase/i),
    ]);
    expect((await getJob(db, second.job.id))?.status).toBe('quoted');
  });

  it('issues the change with an endorsement schedule that shows the premium change', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startChange(policy.id);
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');
    await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });
    await bindSubmission(db, bindDeps, change.job.id, { branchId: change.branch.id }, 'agent.two', { today: '2027-01-01' });
    const issued = await issueSubmission(db, bindDeps, change.job.id, 'agent.two', { today: '2027-01-02' });

    expect(issued.job.status).toBe('issued');
    expect(issued.document).toMatchObject({ kind: 'endorsement_schedule', metadata: { policyNumber: 'PL-0000001', version: 2 } });
    expect((await listDocuments(db, policy.id)).map((d) => [d.kind, d.metadata.version])).toEqual([['policy_schedule', 1], ['endorsement_schedule', 2]]);
  });

  it('makes a transaction permanent: it cannot be changed or deleted', async () => {
    await issuedPolicy();
    await expect(db.query('update policy.premium_transaction set premium_paise = 1, total_paise = 1 + tax_paise')).rejects.toThrow(/transaction cannot be changed/i);
    await expect(db.query('delete from policy.premium_transaction')).rejects.toThrow(/transaction cannot be changed/i);
  });
});
