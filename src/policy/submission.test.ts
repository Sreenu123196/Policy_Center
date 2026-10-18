import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact } from '../contacts/index.js';
import { createProducerCode, createProducerOrganisation, listAuditEntries, ValidationError } from '../platform/index.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { createAccount } from './account-repository.js';
import type { Account } from './account.js';
import { addCoverable, addCoverage, getBranch, getBranchAsOf, getJob } from './policy-repository.js';
import { loadProductCatalogue } from './product-catalogue.js';
import type { Quoter } from './quote.js';
import { loadRateBooks } from './rate-book.js';
import { createQuoter } from './rating.js';
import { addQuoteOption, compareQuotes, declineJob, markNotTaken, quoteBranch, startSubmission, withdrawJob } from './submission.js';

const catalogue = loadProductCatalogue(fileURLToPath(new URL('../../config/products/', import.meta.url)));
const PRODUCT = 'MOTOR_PRIVATE_CAR';
const START = '2026-10-15';
const TODAY = '2026-10-16';

// A stand-in price, only to test the quote process. The real rating engine arrives in step D4.
const testQuoter: Quoter = (request) => {
  const idv = Number(request.selection.MOTOR_OD?.idv ?? 0);
  const premiumPaise = 250000 + Math.round(idv * 0.03) + (request.selection.ZERO_DEP ? 150000 : 0);
  return { premiumPaise, taxPaise: Math.round(premiumPaise * 0.18), rateBook: 'TEST-PRICE', worksheet: [{ step: 'test price', note: 'not a real rate' }] };
};
const deps = { catalogue, quoter: testQuoter };

let db: PGlite;
let person: Account; // the named insured is a person: owner-driver cover applies
let company: Account; // the named insured is a company: it does not

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
  const raoMotors = await createContact(db, { kind: 'company', name: 'Rao Motors Pvt Ltd', address }, 'admin');
  person = await createAccount(db, { namedInsuredContactId: asha.id, producerCode: 'PC-100' }, 'agent.one');
  company = await createAccount(db, { namedInsuredContactId: raoMotors.id, producerCode: 'PC-100' }, 'agent.one');
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

const NOBODY = '00000000-0000-0000-0000-000000000000';
const swift = { make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001' }; // three years old at the start date

// A submission whose first branch has a vehicle and the required coverages, ready to be quoted.
async function readyBranch(account: Account = person, options: { personalAccident?: boolean; year?: number } = {}) {
  const started = await startSubmission(db, catalogue, { accountId: account.id, productCode: PRODUCT, periodStart: START }, 'agent.one');
  const car = await addCoverable(db, started.branch.id, { kind: 'Vehicle', attributes: { ...swift, year: options.year ?? swift.year } }, 'agent.one');
  const cover = (patternCode: string, terms: Record<string, number | string> = {}, branchId = started.branch.id) =>
    addCoverage(db, branchId, { coverableFixedId: car.fixedId, patternCode, terms }, 'agent.one');
  await cover('MOTOR_TP');
  if (options.personalAccident ?? account === person) await cover('PA_OWNER_DRIVER');
  await cover('MOTOR_OD', { idv: 50000000 });
  return { ...started, car, cover };
}

const quoteCount = async (): Promise<number> => (await db.query<{ n: number }>('select count(*)::int as n from policy.quote')).rows[0]?.n ?? -1;

describe('starting a submission (document section 8)', () => {
  it('creates the policy, a submission job and a first branch for one year, in one call', async () => {
    const { policy, job, branch } = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'agent.one');
    expect(policy.policyNumber).toBe('PL-0000001');
    expect(job).toMatchObject({ jobNumber: 'J-0000001', type: 'submission', status: 'draft', policyId: policy.id });
    expect(branch).toMatchObject({
      jobId: job.id,
      policyId: policy.id,
      label: 'Option A',
      status: 'draft',
      periodStart: '2026-10-15',
      periodEnd: '2027-10-15',
      productVersion: '2026.10',
    });
  });

  it('ends a policy that starts on 29 February on 1 March of the next year', async () => {
    const { branch } = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: '2028-02-29' }, 'agent.one');
    expect(branch.periodEnd).toBe('2029-03-01');
  });

  it('refuses an unknown account, an unknown product, a start date with no product version or not real, and creates nothing', async () => {
    const start = (over: Record<string, string>) => startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START, ...over }, 'u');
    expect(await errorsOf(start({ accountId: NOBODY }))).toEqual([expect.stringMatching(/account.*does not exist/i)]);
    expect(await errorsOf(start({ productCode: 'FLYING_CARPET' }))).toEqual([expect.stringMatching(/product FLYING_CARPET/i)]);
    expect(await errorsOf(start({ periodStart: '2026-03-01' }))).toEqual([expect.stringMatching(/no version of MOTOR_PRIVATE_CAR/i)]);
    expect(await errorsOf(start({ periodStart: '2026-13-45' }))).toEqual([expect.stringMatching(/start date/i)]);

    const policies = await db.query<{ n: number }>('select count(*)::int as n from policy.policy');
    expect(policies.rows[0]?.n).toBe(0);
  });
});

describe('quote options: several branches in one submission', () => {
  it('add another branch to the same job, optionally as a copy that keeps the fixed ids, and the options then change independently', async () => {
    const { job, branch, car } = await readyBranch();
    const optionB = await addQuoteOption(db, job.id, { copyFrom: branch.id }, 'agent.two');
    expect(optionB).toMatchObject({ label: 'Option B', jobId: job.id, basedOnId: null, status: 'draft', periodStart: branch.periodStart, periodEnd: branch.periodEnd, productVersion: branch.productVersion });

    const a = await getBranchAsOf(db, branch.id, START);
    const b = await getBranchAsOf(db, optionB.id, START);
    expect(b?.coverables.map((c) => c.fixedId)).toEqual(a?.coverables.map((c) => c.fixedId));
    expect(b?.coverages.map((c) => [c.fixedId, c.patternCode, c.terms])).toEqual(a?.coverages.map((c) => [c.fixedId, c.patternCode, c.terms]));

    await addCoverage(db, optionB.id, { coverableFixedId: car.fixedId, patternCode: 'ZERO_DEP' }, 'agent.two');
    expect((await getBranchAsOf(db, branch.id, START))?.coverages.map((c) => c.patternCode)).not.toContain('ZERO_DEP');
    expect((await getBranchAsOf(db, optionB.id, START))?.coverages.map((c) => c.patternCode)).toContain('ZERO_DEP');

    const optionC = await addQuoteOption(db, job.id, {}, 'agent.two'); // no copy: an empty option
    expect(optionC.label).toBe('Option C');
    expect((await getBranchAsOf(db, optionC.id, START))?.coverables).toEqual([]);
  });

  it('refuse to copy from a branch of another job, or to add an option to a job that does not exist', async () => {
    const first = await readyBranch();
    const second = await readyBranch();
    expect(await errorsOf(addQuoteOption(db, first.job.id, { copyFrom: second.branch.id }, 'u'))).toEqual([expect.stringMatching(/same job/i)]);
    expect(await errorsOf(addQuoteOption(db, NOBODY, {}, 'u'))).toEqual([expect.stringMatching(/job.*does not exist/i)]);
  });
});

describe('quoting a branch (document section 8)', () => {
  it('stores the price in paise with tax, valid for 30 days, and moves the branch and the job to quoted', async () => {
    const { job, branch } = await readyBranch();
    const quote = await quoteBranch(db, deps, branch.id, 'agent.one', { today: TODAY });

    expect(quote).toMatchObject({
      branchId: branch.id,
      premiumPaise: 250000 + 1500000,
      taxPaise: Math.round(1750000 * 0.18),
      currency: 'INR',
      validUntil: '2026-11-15',
      rateBook: 'TEST-PRICE',
      createdBy: 'agent.one',
    });
    expect(quote.totalPaise).toBe(quote.premiumPaise + quote.taxPaise);
    expect(quote.worksheet).toEqual([{ step: 'test price', note: 'not a real rate' }]);
    expect((await getBranch(db, branch.id))?.status).toBe('quoted');
    expect((await getJob(db, job.id))?.status).toBe('quoted');
  });

  it('judges availability from the facts of the risk: a company does not get owner-driver cover', async () => {
    const ok = await readyBranch(company, { personalAccident: false });
    await expect(quoteBranch(db, deps, ok.branch.id, 'u', { today: TODAY })).resolves.toBeDefined();

    const bad = await readyBranch(company, { personalAccident: true });
    expect(await errorsOf(quoteBranch(db, deps, bad.branch.id, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/PA_OWNER_DRIVER is not available for this risk/)]);
  });

  it('refuses an incomplete or invalid branch and lists every problem, saving nothing', async () => {
    const { branch } = await readyBranch(person, { personalAccident: false, year: 2018 }); // an eight-year-old car, no owner-driver cover
    await addCoverage(db, branch.id, { coverableFixedId: (await getBranchAsOf(db, branch.id, START))!.coverables[0]!.fixedId, patternCode: 'ZERO_DEP' }, 'u');

    const errors = await errorsOf(quoteBranch(db, deps, branch.id, 'u', { today: TODAY }));
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/PA_OWNER_DRIVER is required/), expect.stringMatching(/ZERO_DEP is not available for this risk/)]),
    );
    expect((await getBranch(db, branch.id))?.status).toBe('draft');
    expect(await quoteCount()).toBe(0);
  });

  it('needs exactly one vehicle and a model year', async () => {
    const started = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'u');
    expect(await errorsOf(quoteBranch(db, deps, started.branch.id, 'u', { today: TODAY }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/exactly one vehicle/i)]),
    );

    await addCoverable(db, started.branch.id, { kind: 'Vehicle', attributes: { make: 'Maruti' } }, 'u');
    expect(await errorsOf(quoteBranch(db, deps, started.branch.id, 'u', { today: TODAY }))).toEqual(expect.arrayContaining([expect.stringMatching(/model year/i)]));
  });

  it('checks values against the product version of the branch: an insured value of Rs 100 is below the minimum', async () => {
    const { branch, car } = await readyBranch();
    await addCoverage(db, branch.id, { coverableFixedId: car.fixedId, patternCode: 'ZERO_DEP' }, 'u');
    const lowIdv = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'u');
    const lowCar = await addCoverable(db, lowIdv.branch.id, { kind: 'Vehicle', attributes: swift }, 'u');
    for (const [code, terms] of [['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: 10000 }]] as const) {
      await addCoverage(db, lowIdv.branch.id, { coverableFixedId: lowCar.fixedId, patternCode: code, terms }, 'u');
    }
    expect(await errorsOf(quoteBranch(db, deps, lowIdv.branch.id, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/MOTOR_OD: idv must be between 5000000/)]);
  });

  it('makes a quote a permanent record: it cannot be changed or deleted, even by raw SQL', async () => {
    const { branch } = await readyBranch();
    await quoteBranch(db, deps, branch.id, 'agent.one', { today: TODAY });
    await expect(db.query('update policy.quote set premium_paise = 1, tax_paise = 0, total_paise = 1')).rejects.toThrow(/quote cannot be changed/i);
    await expect(db.query('delete from policy.quote')).rejects.toThrow(/quote cannot be changed/i);
  });

  it('only quotes a draft branch, and refuses an invalid price from the rating', async () => {
    const { branch } = await readyBranch();
    await quoteBranch(db, deps, branch.id, 'u', { today: TODAY });
    expect(await errorsOf(quoteBranch(db, deps, branch.id, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/only a draft branch can be quoted/i)]);

    const other = await readyBranch();
    const broken: Quoter = () => ({ premiumPaise: -5, taxPaise: 0.5, rateBook: 'x', worksheet: [] });
    expect(await errorsOf(quoteBranch(db, { catalogue, quoter: broken }, other.branch.id, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/invalid price/i)]);
    expect((await getBranch(db, other.branch.id))?.status).toBe('draft');
  });

  it('sends a quoted branch and its job back to draft when it is edited, and a new quote keeps the old one as history', async () => {
    const { job, branch, cover } = await readyBranch();
    const first = await quoteBranch(db, deps, branch.id, 'u', { today: TODAY });

    await cover('ZERO_DEP'); // editing a quoted branch
    expect((await getBranch(db, branch.id))?.status).toBe('draft');
    expect((await getJob(db, job.id))?.status).toBe('draft');

    const second = await quoteBranch(db, deps, branch.id, 'u', { today: TODAY });
    expect(second.id).not.toBe(first.id);
    expect(second.premiumPaise).toBe(first.premiumPaise + 150000);
    expect(await quoteCount()).toBe(2);
  });

  it('makes the job quoted only when every open option is quoted, and draft again if any is edited', async () => {
    const { job, branch, car } = await readyBranch();
    const optionB = await addQuoteOption(db, job.id, { copyFrom: branch.id }, 'u');
    const jobStatus = async () => (await getJob(db, job.id))?.status;

    await quoteBranch(db, deps, branch.id, 'u', { today: TODAY });
    expect(await jobStatus()).toBe('draft'); // option B is still a draft
    await quoteBranch(db, deps, optionB.id, 'u', { today: TODAY });
    expect(await jobStatus()).toBe('quoted');

    await addCoverage(db, branch.id, { coverableFixedId: car.fixedId, patternCode: 'ZERO_DEP' }, 'u');
    expect(await jobStatus()).toBe('draft');
    expect((await getBranch(db, optionB.id))?.status).toBe('quoted'); // option B keeps its quote
  });

  it('shows the options side by side: each branch with its current quote, or none yet', async () => {
    const { job, branch, car } = await readyBranch();
    const optionB = await addQuoteOption(db, job.id, { copyFrom: branch.id }, 'u');
    await addCoverage(db, optionB.id, { coverableFixedId: car.fixedId, patternCode: 'ZERO_DEP' }, 'u');

    await quoteBranch(db, deps, branch.id, 'u', { today: TODAY });
    let options = await compareQuotes(db, job.id);
    expect(options.map((o) => [o.branch.label, o.branch.status, o.quote?.totalPaise ?? null])).toEqual([
      ['Option A', 'quoted', 2065000],
      ['Option B', 'draft', null],
    ]);

    await quoteBranch(db, deps, optionB.id, 'u', { today: TODAY });
    options = await compareQuotes(db, job.id);
    expect(options[1]?.quote?.totalPaise).toBeGreaterThan(options[0]?.quote?.totalPaise ?? Infinity);
  });
});

describe('ending a submission (document section 8)', () => {
  it('can be withdrawn, which withdraws its branches, and then nothing more can be done to it', async () => {
    const { job, branch, car } = await readyBranch();
    const optionB = await addQuoteOption(db, job.id, { copyFrom: branch.id }, 'u');
    await quoteBranch(db, deps, branch.id, 'u', { today: TODAY });

    const withdrawn = await withdrawJob(db, job.id, 'agent.one', 'Customer changed their mind');
    expect(withdrawn.status).toBe('withdrawn');
    expect((await getBranch(db, branch.id))?.status).toBe('withdrawn');
    expect((await getBranch(db, optionB.id))?.status).toBe('withdrawn');

    expect(await errorsOf(addCoverage(db, branch.id, { coverableFixedId: car.fixedId, patternCode: 'ZERO_DEP' }, 'u'))).toEqual([expect.stringMatching(/withdrawn branch cannot be changed/i)]);
    expect(await errorsOf(addQuoteOption(db, job.id, {}, 'u'))).toEqual([expect.stringMatching(/cannot add an option/i)]);
    expect(await errorsOf(withdrawJob(db, job.id, 'u'))).toEqual([expect.stringMatching(/submission job cannot move from withdrawn to withdrawn/i)]);
  });

  it('can be declined only with a reason, which is kept in the audit log', async () => {
    const { job, branch } = await readyBranch();
    expect(await errorsOf(declineJob(db, job.id, 'uw.one', '  '))).toEqual([expect.stringMatching(/reason/i)]);

    const declined = await declineJob(db, job.id, 'uw.one', 'Outside appetite');
    expect(declined.status).toBe('declined');
    expect((await getBranch(db, branch.id))?.status).toBe('withdrawn');

    const entries = await listAuditEntries(db, { entityType: 'job', entityId: job.id });
    expect(entries.at(-1)).toMatchObject({ actor: 'uw.one', action: 'job.status', reason: 'Outside appetite', details: { from: 'draft', to: 'declined' } });
  });

  it('can end as "not taken" only after it was quoted', async () => {
    const { job, branch } = await readyBranch();
    expect(await errorsOf(markNotTaken(db, job.id, 'u'))).toEqual([expect.stringMatching(/submission job cannot move from draft to not_taken/i)]);

    await quoteBranch(db, deps, branch.id, 'u', { today: TODAY });
    expect((await markNotTaken(db, job.id, 'u', 'The quote expired')).status).toBe('not_taken');
    expect((await getBranch(db, branch.id))?.status).toBe('withdrawn');
  });
});

describe('the audit log for submissions', () => {
  it('records copies, quotes and every change of job status', async () => {
    const { job, branch } = await readyBranch();
    const optionB = await addQuoteOption(db, job.id, { copyFrom: branch.id }, 'agent.two');
    const quote = await quoteBranch(db, deps, branch.id, 'agent.one', { today: TODAY });
    await quoteBranch(db, deps, optionB.id, 'agent.one', { today: TODAY }); // the job is quoted once every option is

    const forJob = await listAuditEntries(db, { entityType: 'job', entityId: job.id });
    expect(forJob.map((e) => e.action)).toEqual(['job.start', 'job.status']);
    expect(forJob[1]).toMatchObject({ actor: 'agent.one', details: { from: 'draft', to: 'quoted' } });

    const forA = await listAuditEntries(db, { entityType: 'policy_period', entityId: branch.id });
    expect(forA.at(-1)).toMatchObject({ actor: 'agent.one', action: 'branch.quote', details: { quoteId: quote.id, totalPaise: quote.totalPaise } });
    const forB = await listAuditEntries(db, { entityType: 'policy_period', entityId: optionB.id });
    expect(forB[0]).toMatchObject({ actor: 'agent.two', action: 'branch.copy', details: { copiedFrom: branch.id } });
  });
});

describe('quoting with the real rating engine (step D4)', () => {
  const realDeps = { catalogue, quoter: createQuoter(loadRateBooks(fileURLToPath(new URL('../../config/ratebooks/', import.meta.url)), catalogue)) };

  it('prices a branch from the rate book and stores the worksheet with the quote', async () => {
    const started = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'agent.one');
    const car = await addCoverable(db, started.branch.id, { kind: 'Vehicle', attributes: { ...swift, engineCc: 1197, claimFreeYears: 2 } }, 'agent.one');
    for (const [code, terms] of [['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: 50000000 }]] as const) {
      await addCoverage(db, started.branch.id, { coverableFixedId: car.fixedId, patternCode: code, terms }, 'agent.one');
    }
    const quote = await quoteBranch(db, realDeps, started.branch.id, 'agent.one', { today: TODAY });
    expect(quote).toMatchObject({ premiumPaise: 1574600, taxPaise: 283428, totalPaise: 1858028, rateBook: 'MPC-2026.10' });
    expect(quote.worksheet.length).toBeGreaterThan(10);
  });

  it('refuses to quote a vehicle with no engine size, and saves nothing', async () => {
    const { branch } = await readyBranch(); // this vehicle has no engineCc
    expect(await errorsOf(quoteBranch(db, realDeps, branch.id, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/engine size/i)]);
    expect((await getBranch(db, branch.id))?.status).toBe('draft');
    expect(await quoteCount()).toBe(0);
  });
});
