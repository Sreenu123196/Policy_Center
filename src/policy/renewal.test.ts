import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../platform/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact } from '../contacts/index.js';
import { addDays, createProducerCode, createProducerOrganisation, listAuditEntries, listUnpublishedEvents, ValidationError } from '../platform/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { createAccount } from './account-repository.js';
import type { Account } from './account.js';
import { bindJob, getDocument, issueJob, listDocuments } from './bind.js';
import { loadCancellationRules } from './cancellation-rules.js';
import { startCancellation } from './cancellation.js';
import { changeCoverage, listTransactions, startPolicyChange } from './policy-change.js';
import { addCoverable, addCoverage, getBranch, getBranchAsOf, getJob } from './policy-repository.js';
import { loadProductCatalogue } from './product-catalogue.js';
import { loadRateBooks } from './rate-book.js';
import { createQuoter } from './rating.js';
import { approveNonRenewal, issueNonRenewalNotice, listRenewalDirections, produceRenewalOffer, setRenewalDirection, startRenewal } from './renewal.js';
import { loadRenewalRules } from './renewal-rules.js';
import { markNotTaken, quoteBranch, startSubmission } from './submission.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const catalogue = loadProductCatalogue(`${configFolder}products/`);
const renewal = loadRenewalRules(`${configFolder}renewal/`, catalogue);
const quoteDeps = { catalogue, quoter: createQuoter(loadRateBooks(`${configFolder}ratebooks/`, catalogue)) };
const bindDeps = { catalogue };
const deps = { catalogue, renewal };
const PRODUCT = 'MOTOR_PRIVATE_CAR';
const START = '2026-10-15';
const END = '2027-10-15'; // the old term ends here; the renewal term starts here
const NEW_END = '2028-10-15';
const WINDOW_OPENS = addDays(END, -60); // the product starts renewals 60 days before expiry
const IN_WINDOW = addDays(END, -30);

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
  await loadTestConfiguration(db);
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

// Term 1: the golden risk (Rs 5,00,000 insured value, 1197 cc, 2 claim-free years), bound and issued.
async function issuedPolicy(options: { start?: string; idv?: number } = {}) {
  const start = options.start ?? START;
  const started = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: start }, 'agent.one');
  const car = await addCoverable(
    db,
    started.branch.id,
    { kind: 'Vehicle', attributes: { make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001', engineCc: 1197, claimFreeYears: 2 } },
    'agent.one',
  );
  const covers: Record<string, string> = {};
  for (const [code, terms] of [['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: options.idv ?? 50000000 }]] as const) {
    covers[code] = (await addCoverage(db, started.branch.id, { coverableFixedId: car.fixedId, patternCode: code, terms }, 'agent.one')).fixedId;
  }
  await quoteBranch(db, quoteDeps, started.branch.id, 'agent.one', { today: addDays(start, 1) });
  await bindJob(db, bindDeps, started.job.id, { branchId: started.branch.id }, 'agent.one', { today: addDays(start, 1) });
  await issueJob(db, bindDeps, started.job.id, 'agent.one', { today: addDays(start, 1) });
  return { ...started, car, covers };
}

const renew = (policyId: string, today = IN_WINDOW) => startRenewal(db, deps, { policyId }, 'agent.two', { today });

describe('loading renewal rules (document section 8)', () => {
  it('loads the rules of each product version', () => {
    expect(renewal.forVersion(PRODUCT, '2026.10')).toMatchObject({ lead_days: 60, non_renewal_notice_days: 45 });
    expect(renewal.forVersion(PRODUCT, '2099.01')).toBeNull();
  });

  describe('checks the file and reports every problem together', () => {
    const base = { product: PRODUCT, version: '2026.10', lead_days: 60, non_renewal_notice_days: 45 };
    const load = (file: unknown, name = 'motor_private_car-2026.10.json') => {
      const folder = mkdtempSync(join(tmpdir(), 'renewal-'));
      writeFileSync(join(folder, name), JSON.stringify(file));
      return () => loadRenewalRules(folder, catalogue);
    };
    const problems = (run: () => unknown): string[] => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        return (error as ValidationError).errors;
      }
      throw new Error('expected the rules to be refused');
    };

    it('accepts a small valid file, and refuses a notice longer than the renewal window, a wrong version and a wrong file name', () => {
      expect(load(base)()).toBeDefined();
      expect(problems(load({ ...base, non_renewal_notice_days: 90 }))).toEqual([expect.stringMatching(/non_renewal_notice_days.*lead_days/)]);
      expect(problems(load({ ...base, version: '2099.01' }, 'motor_private_car-2099.01.json'))).toEqual([expect.stringMatching(/2099.01.*not a version/)]);
      expect(problems(load(base, 'renewal.json'))).toEqual([expect.stringMatching(/should be named motor_private_car-2026.10.json/)]);
    });
  });
});

describe('starting a renewal (document section 8)', () => {
  it('starts only inside the window before expiry: the product says 60 days', async () => {
    const { policy } = await issuedPolicy();
    expect(await errorsOf(renew(policy.id, addDays(WINDOW_OPENS, -1)))).toEqual([expect.stringMatching(/60 days before.*from 16-08-2027/i)]);
    await expect(renew(policy.id, WINDOW_OPENS)).resolves.toBeDefined(); // the first day of the window
  });

  it('refuses once the term has ended, and for an unknown policy or one with no bound version', async () => {
    const { policy } = await issuedPolicy();
    expect(await errorsOf(renew(policy.id, END))).toEqual([expect.stringMatching(/term has ended/i)]);
    const draft = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'u');
    expect(await errorsOf(renew(draft.policy.id))).toEqual([expect.stringMatching(/no bound version/i)]);
    expect(await errorsOf(renew('00000000-0000-0000-0000-000000000000'))).toEqual([expect.stringMatching(/policy.*does not exist/i)]);
  });

  it('creates term 2 for the next year as a draft, taking the cover as it stands on the last day of the old term', async () => {
    const { policy, branch, car, covers } = await issuedPolicy();
    // A change in the old term must be carried into the renewal: the insured value goes up from 1 July 2027.
    const change = await startPolicyChange(db, { policyId: policy.id, effectiveDate: '2027-07-01' }, 'agent.two');
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-07-01' });
    await bindJob(db, bindDeps, change.job.id, { branchId: change.branch.id }, 'agent.two', { today: '2027-07-01' });

    const r = await renew(policy.id);
    expect(r.job).toMatchObject({ type: 'renewal', status: 'draft', effectiveDate: END, policyId: policy.id });
    expect(r.branch).toMatchObject({ jobId: r.job.id, termNumber: 2, version: null, status: 'draft', periodStart: END, periodEnd: NEW_END, productVersion: '2026.10', cancelledOn: null });
    expect(r.branch.basedOnId).not.toBeNull();
    expect(r.branch.basedOnId).not.toBe(branch.id); // it follows the newest version of term 1

    const snapshot = await getBranchAsOf(db, r.branch.id, END);
    expect(snapshot?.coverables.map((c) => [c.fixedId, c.effFrom, c.effTo])).toEqual([[car.fixedId, END, NEW_END]]); // the same vehicle keeps its fixed id
    expect(snapshot?.coverages.find((c) => c.patternCode === 'MOTOR_OD')).toMatchObject({ fixedId: covers.MOTOR_OD, terms: { idv: 60000000 }, effFrom: END, effTo: NEW_END });
  });

  it('adds a year of no-claim history to the vehicle when no claim was made', async () => {
    const { policy, car } = await issuedPolicy();
    const r = await renew(policy.id);
    const snapshot = await getBranchAsOf(db, r.branch.id, END);
    expect(snapshot?.coverables.find((c) => c.fixedId === car.fixedId)?.attributes.claimFreeYears).toBe(3);
  });

  it('refuses a second renewal while one is open or done, but allows a new one after "not taken"', async () => {
    const { policy } = await issuedPolicy();
    const first = await renew(policy.id);
    expect(await errorsOf(renew(policy.id))).toEqual([expect.stringMatching(/renewal.*already/i)]);
    await quoteBranch(db, quoteDeps, first.branch.id, 'agent.two', { today: IN_WINDOW });
    await markNotTaken(db, first.job.id, 'agent.two', 'The customer did not reply');
    expect((await getJob(db, first.job.id))?.status).toBe('not_taken');
    expect((await getBranch(db, first.branch.id))?.status).toBe('withdrawn');
    await expect(renew(policy.id)).resolves.toBeDefined();
  });

  it('refuses a cancelled policy', async () => {
    const { policy } = await issuedPolicy();
    const cancelRules = loadCancellationRules(`${configFolder}cancellation/`, catalogue);
    const cancelled = await startCancellation(db, { catalogue, cancellation: cancelRules }, { policyId: policy.id, effectiveDate: '2027-01-01', reasonCode: 'vehicle_sold' }, 'u', { today: '2026-12-20' });
    await bindJob(db, bindDeps, cancelled.job.id, { branchId: cancelled.branch.id }, 'u', { today: '2026-12-20' });
    expect(await errorsOf(renew(policy.id))).toEqual([expect.stringMatching(/cancelled/i)]);
  });
});

describe('quoting, offering and binding a renewal', () => {
  it('re-rates the new term: the vehicle is a year older and has one more claim-free year', async () => {
    // Own damage: 50,000,000 x 3.20% = 1,600,000 less 35% for 3 claim-free years = 1,040,000.
    // Premium 1,040,000 + 341,600 + 33,000 = 1,414,600 ; GST 254,628.
    const { policy } = await issuedPolicy();
    const r = await renew(policy.id);
    const quote = await quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today: IN_WINDOW });
    expect(quote).toMatchObject({ premiumPaise: 1414600, taxPaise: 254628, totalPaise: 1669228, rateBook: 'MPC-2026.10' });
    expect((await getJob(db, r.job.id))?.status).toBe('quoted');
  });

  it('moves to the newest product version in force on the new start date, and checks the old choices against it', async () => {
    // Sold on 1 May 2026 under version 2026.04 (insured value Rs 40,000 was allowed). The renewal starts on 1 May 2027,
    // when 2026.10 is in force, and its minimum insured value is Rs 50,000.
    const { policy, covers } = await issuedPolicy({ start: '2026-05-01', idv: 4000000 });
    expect((await getBranch(db, (await db.query<{ id: string }>("select id from policy.policy_period where policy_id = $1", [policy.id])).rows[0]!.id))?.productVersion).toBe('2026.04');
    const r = await renew(policy.id, '2027-04-10');
    expect(r.branch).toMatchObject({ productVersion: '2026.10', periodStart: '2027-05-01', periodEnd: '2028-05-01' });

    expect(await errorsOf(quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today: '2027-04-10' }))).toEqual([expect.stringMatching(/MOTOR_OD: idv must be between 5000000/)]);
    await changeCoverage(db, r.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 5000000 } }, 'agent.two');
    const quote = await quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today: '2027-04-10' });
    expect(quote.rateBook).toBe('MPC-2026.10'); // rated with the rate book of the new term
  });

  it('produces a renewal offer document without changing the job, and only for a quoted job', async () => {
    const { policy } = await issuedPolicy();
    const r = await renew(policy.id);
    expect(await errorsOf(produceRenewalOffer(db, deps, r.job.id, 'agent.two', { today: IN_WINDOW }))).toEqual([expect.stringMatching(/only a quoted renewal/i)]);

    const quote = await quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today: IN_WINDOW });
    const offer = await produceRenewalOffer(db, deps, r.job.id, 'agent.two', { today: IN_WINDOW });
    expect(offer).toMatchObject({ kind: 'renewal_notice', contentType: 'application/pdf', metadata: { policyNumber: 'PL-0000001', version: 0 } });
    expect((await getJob(db, r.job.id))?.status).toBe('quoted');
    const stored = await getDocument(db, offer.id);
    expect(new TextDecoder().decode(stored!.content.slice(0, 5))).toBe('%PDF-');
    expect(quote.validUntil).toBe(addDays(IN_WINDOW, 30));
  });

  it('is accepted by binding: term 2 version 1, a renewal transaction for the whole new premium, and a PolicyRenewed event', async () => {
    const { policy, branch } = await issuedPolicy();
    const r = await renew(policy.id);
    await quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today: IN_WINDOW });
    const bound = await bindJob(db, bindDeps, r.job.id, { branchId: r.branch.id }, 'agent.two', { today: IN_WINDOW });

    expect(bound.branch).toMatchObject({ status: 'bound', termNumber: 2, version: 1 });
    expect((await getBranch(db, branch.id))?.status).toBe('bound'); // the old term is untouched
    expect(await listTransactions(db, policy.id)).toEqual([
      expect.objectContaining({ version: 1, kind: 'new_business', premiumPaise: 1574600 }),
      expect.objectContaining({ version: 1, kind: 'renewal', effectiveDate: END, premiumPaise: 1414600, taxPaise: 254628, totalPaise: 1669228 }),
    ]);
    const event = (await listUnpublishedEvents(db)).at(-1);
    expect(event).toMatchObject({ type: 'PolicyRenewed', payload: { termNumber: 2, version: 1, periodStart: END, periodEnd: NEW_END, transaction: { kind: 'renewal', premiumPaise: 1414600 } } });
  });

  it('does not preempt changes to the old term, which can still be made after the renewal is bound', async () => {
    const { policy, covers } = await issuedPolicy();
    const open = await startPolicyChange(db, { policyId: policy.id, effectiveDate: '2027-03-01' }, 'agent.two');
    await changeCoverage(db, open.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    const r = await renew(policy.id);
    await quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today: IN_WINDOW });
    await bindJob(db, bindDeps, r.job.id, { branchId: r.branch.id }, 'agent.two', { today: IN_WINDOW });

    expect((await getJob(db, open.job.id))?.status).toBe('draft'); // a different term, so no clash
    await quoteBranch(db, quoteDeps, open.branch.id, 'agent.two', { today: IN_WINDOW });
    await expect(bindJob(db, bindDeps, open.job.id, { branchId: open.branch.id }, 'agent.two', { today: IN_WINDOW })).resolves.toBeDefined();
    const late = await startPolicyChange(db, { policyId: policy.id, effectiveDate: '2027-09-01' }, 'u'); // still in term 1
    expect(late.branch.termNumber).toBe(1);
  });

  it('issues the renewal with a schedule for the new term, and an offer that is not accepted ends as "not taken"', async () => {
    const { policy } = await issuedPolicy();
    const r = await renew(policy.id);
    await quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today: IN_WINDOW });
    await bindJob(db, bindDeps, r.job.id, { branchId: r.branch.id }, 'agent.two', { today: IN_WINDOW });
    const issued = await issueJob(db, bindDeps, r.job.id, 'agent.two', { today: END });
    expect(issued.document).toMatchObject({ kind: 'renewal_schedule', metadata: { policyNumber: 'PL-0000001', version: 1 } });
    expect((await listDocuments(db, policy.id)).map((d) => d.kind)).toEqual(['policy_schedule', 'renewal_schedule']);
    const stored = await getDocument(db, issued.document.id);
    expect(stored).not.toBeNull();
  });

  it('refuses to accept an expired renewal offer', async () => {
    const { policy } = await issuedPolicy();
    const r = await renew(policy.id);
    await quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today: IN_WINDOW });
    expect(await errorsOf(bindJob(db, bindDeps, r.job.id, { branchId: r.branch.id }, 'u', { today: addDays(IN_WINDOW, 31) }))).toEqual([expect.stringMatching(/quote has expired/i)]);
  });
});

describe('pre-renewal direction and non-renewal (document section 8)', () => {
  it('defaults to renew, and "review" holds the renewal until the direction is changed', async () => {
    const { policy } = await issuedPolicy();
    expect(await listRenewalDirections(db, policy.id)).toEqual([]);
    await setRenewalDirection(db, { policyId: policy.id, direction: 'review', reason: 'Two claims last year' }, 'uw.one');
    expect(await errorsOf(renew(policy.id))).toEqual([expect.stringMatching(/under review/i)]);
    await setRenewalDirection(db, { policyId: policy.id, direction: 'renew', reason: 'Reviewed, accepted' }, 'uw.one');
    await expect(renew(policy.id)).resolves.toBeDefined();
    const history = await listRenewalDirections(db, policy.id);
    expect(history.map((d) => [d.direction, d.setBy, d.reason])).toEqual([['review', 'uw.one', 'Two claims last year'], ['renew', 'uw.one', 'Reviewed, accepted']]);
  });

  it('needs a reason for every direction', async () => {
    const { policy } = await issuedPolicy();
    expect(await errorsOf(setRenewalDirection(db, { policyId: policy.id, direction: 'review', reason: ' ' }, 'u'))).toEqual([expect.stringMatching(/reason/i)]);
    expect(await errorsOf(setRenewalDirection(db, { policyId: policy.id, direction: 'sell' as never, reason: 'x' }, 'u'))).toEqual([expect.stringMatching(/direction/i)]);
  });

  it('non-renewal needs a second person to approve it, then a notice in time', async () => {
    const { policy } = await issuedPolicy();
    const pending = await setRenewalDirection(db, { policyId: policy.id, direction: 'non_renew', reason: 'Too many claims' }, 'uw.one');
    expect(pending).toMatchObject({ direction: 'non_renew', approvedBy: null });
    expect(await errorsOf(renew(policy.id))).toEqual([expect.stringMatching(/non-renew/i)]);

    expect(await errorsOf(issueNonRenewalNotice(db, deps, policy.id, 'uw.one', { today: addDays(END, -50) }))).toEqual([expect.stringMatching(/needs approval/i)]);
    expect(await errorsOf(approveNonRenewal(db, policy.id, 'uw.one', 'I agree with myself'))).toEqual([expect.stringMatching(/different person/i)]);
    expect(await errorsOf(approveNonRenewal(db, policy.id, 'uw.two', ' '))).toEqual([expect.stringMatching(/reason/i)]);
    const approved = await approveNonRenewal(db, policy.id, 'uw.two', 'Agreed after review');
    expect(approved).toMatchObject({ approvedBy: 'uw.two', approvalReason: 'Agreed after review' });

    // 45 days of notice before 15-10-2027: the last day to send it is 31-08-2027.
    expect(await errorsOf(issueNonRenewalNotice(db, deps, policy.id, 'uw.one', { today: '2027-09-01' }))).toEqual([expect.stringMatching(/45 days.*31-08-2027/i)]);
    const notice = await issueNonRenewalNotice(db, deps, policy.id, 'uw.one', { today: '2027-08-31' });
    expect(notice).toMatchObject({ kind: 'non_renewal_notice', contentType: 'application/pdf', metadata: { policyNumber: 'PL-0000001' } });

    expect(await errorsOf(issueNonRenewalNotice(db, deps, policy.id, 'uw.one', { today: '2027-08-31' }))).toEqual([expect.stringMatching(/already.*issued/i)]);
    const entries = await listAuditEntries(db, { entityType: 'policy', entityId: policy.id });
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(['renewal.direction', 'renewal.non_renewal_approved', 'document.create']));
  });

  it('refuses to approve or issue a non-renewal when the direction is not non_renew', async () => {
    const { policy } = await issuedPolicy();
    expect(await errorsOf(approveNonRenewal(db, policy.id, 'uw.two', 'x'))).toEqual([expect.stringMatching(/no non-renewal/i)]);
    expect(await errorsOf(issueNonRenewalNotice(db, deps, policy.id, 'uw.two', { today: '2027-08-01' }))).toEqual([expect.stringMatching(/no non-renewal/i)]);
  });
});
