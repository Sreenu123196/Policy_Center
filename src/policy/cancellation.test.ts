import { fileURLToPath } from 'node:url';
import type { Database } from '../platform/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact } from '../contacts/index.js';
import { createProducerCode, createProducerOrganisation, listAuditEntries, listUnpublishedEvents, ValidationError } from '../platform/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { createAccount } from './account-repository.js';
import type { Account } from './account.js';
import { bindJob, issueJob, listDocuments } from './bind.js';
import { loadCancellationRules } from './cancellation-rules.js';
import { getAdjustment, getCoverStatus, startCancellation, startReinstatement } from './cancellation.js';
import { changeCoverage, listTransactions, startPolicyChange } from './policy-change.js';
import { addCoverable, addCoverage, getBranch, getJob } from './policy-repository.js';
import { loadProductCatalogue } from './product-catalogue.js';
import { loadRateBooks } from './rate-book.js';
import { createQuoter } from './rating.js';
import { quoteBranch, startSubmission, withdrawJob } from './submission.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const catalogue = loadProductCatalogue(`${configFolder}products/`);
const cancellation = loadCancellationRules(`${configFolder}cancellation/`, catalogue);
const quoteDeps = { catalogue, quoter: createQuoter(loadRateBooks(`${configFolder}ratebooks/`, catalogue)) };
const bindDeps = { catalogue };
const deps = { catalogue, cancellation };
const PRODUCT = 'MOTOR_PRIVATE_CAR';
const START = '2026-10-15';
const END = '2027-10-15';
const TODAY = '2026-10-16';
const JAN1 = '2027-01-01';
const FEB1 = '2027-02-01';

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

// Version 1: the golden risk (premium 1,574,600 + GST 283,428 paise), bound and issued.
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

const cancel = (policyId: string, over: Partial<{ effectiveDate: string; reasonCode: string; method: 'flat' | 'pro_rata' | 'short_rate' }> = {}, today = '2026-12-20') =>
  startCancellation(db, deps, { policyId, effectiveDate: JAN1, reasonCode: 'customer_request', ...over }, 'agent.two', { today });

async function cancelAndBind(policyId: string) {
  const started = await cancel(policyId);
  const bound = await bindJob(db, bindDeps, started.job.id, { branchId: started.branch.id }, 'agent.two', { today: '2026-12-20' });
  return { ...started, bound };
}

const rowEnds = async (branchId: string) =>
  (await db.query<{ end: string | null }>("select to_char(max(eff_to), 'YYYY-MM-DD') as end from policy.coverage where branch_id = $1", [branchId])).rows[0]?.end ?? null;
const coverageSlices = async (branchId: string, code: string) =>
  (
    await db.query<{ eff_from: string; eff_to: string }>(
      "select to_char(eff_from, 'YYYY-MM-DD') as eff_from, to_char(eff_to, 'YYYY-MM-DD') as eff_to from policy.coverage where branch_id = $1 and pattern_code = $2 order by eff_from",
      [branchId, code],
    )
  ).rows.map((r) => [r.eff_from, r.eff_to] as const);

describe('starting a cancellation (document section 8)', () => {
  it('works out the refund, ends the cover on the effective date in a new draft version, and leaves version 1 alone', async () => {
    const { policy, branch } = await issuedPolicy();
    const started = await cancel(policy.id);

    expect(started.job).toMatchObject({ type: 'cancellation', status: 'quoted', effectiveDate: JAN1, jobNumber: 'J-0000002' });
    expect(started.branch).toMatchObject({ basedOnId: branch.id, status: 'quoted', cancelledOn: JAN1, version: null, periodStart: START, periodEnd: END });
    expect(started.adjustment).toMatchObject({
      kind: 'cancellation',
      reasonCode: 'customer_request',
      source: 'insured',
      method: 'short_rate',
      effectiveDate: JAN1,
      termPremiumPaise: 1574600,
      termTaxPaise: 283428,
      refundPremiumPaise: 944760,
      refundTaxPaise: 170057,
      retainedPremiumPaise: 629840,
      daysInForce: 78,
      unexpiredDays: 287,
    });
    expect(await rowEnds(started.branch.id)).toBe(JAN1); // cover ends on the effective date
    expect(await rowEnds(branch.id)).toBe(END); // version 1 is untouched
    expect((await getBranch(db, branch.id))?.cancelledOn).toBeNull();
  });

  it('uses the refund method of the reason: vehicle sold gives pro rata, a policy issued in error gives a flat refund', async () => {
    const { policy } = await issuedPolicy();
    const sold = await cancel(policy.id, { reasonCode: 'vehicle_sold' });
    expect(sold.adjustment).toMatchObject({ method: 'pro_rata', refundPremiumPaise: 1238110, refundTaxPaise: 222860 });
    await withdrawJob(db, sold.job.id, 'agent.two');

    const error = await cancel(policy.id, { reasonCode: 'issued_in_error', effectiveDate: START });
    expect(error.adjustment).toMatchObject({ method: 'flat', refundPremiumPaise: 1574600, retainedPremiumPaise: 0, source: 'insurer' });
    expect(await coverageSlices(error.branch.id, 'MOTOR_OD')).toEqual([]); // no cover at all
  });

  it('refuses a method the reason does not allow, a flat cancellation after day one, and an unknown or retired reason', async () => {
    const { policy } = await issuedPolicy();
    expect(await errorsOf(cancel(policy.id, { method: 'flat' }))).toEqual([expect.stringMatching(/customer_request.*short_rate/)]);
    expect(await errorsOf(cancel(policy.id, { reasonCode: 'issued_in_error', effectiveDate: JAN1 }))).toEqual([expect.stringMatching(/flat.*first day/i)]);
    expect(await errorsOf(cancel(policy.id, { reasonCode: 'made_up' }))).toEqual([expect.stringMatching(/made_up.*not.*cancellation reason/i)]);
  });

  it('asks the insurer for notice but not the customer: non-payment needs 15 days', async () => {
    const { policy } = await issuedPolicy();
    expect(await errorsOf(cancel(policy.id, { reasonCode: 'non_payment', effectiveDate: '2026-11-15' }, '2026-11-01'))).toEqual([expect.stringMatching(/15 days.*notice.*16-11-2026/i)]);
    const ok = await cancel(policy.id, { reasonCode: 'non_payment', effectiveDate: '2026-11-16' }, '2026-11-01');
    expect(ok.adjustment.method).toBe('pro_rata');
    await withdrawJob(db, ok.job.id, 'agent.two');
    await expect(cancel(policy.id, { effectiveDate: '2026-12-20' }, '2026-12-20')).resolves.toBeDefined(); // the customer may cancel at once
  });

  it('refuses an unknown policy, a policy with no bound version, and a date outside the period', async () => {
    const draft = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'u');
    expect(await errorsOf(cancel(draft.policy.id))).toEqual([expect.stringMatching(/no bound version/i)]);
    expect(await errorsOf(cancel('00000000-0000-0000-0000-000000000000'))).toEqual([expect.stringMatching(/policy.*does not exist/i)]);
    const { policy } = await issuedPolicy();
    expect(await errorsOf(cancel(policy.id, { effectiveDate: END }))).toEqual([expect.stringMatching(/inside the policy period/i)]);
    expect(await errorsOf(cancel(policy.id, { effectiveDate: '2027-02-30' }))).toEqual([expect.stringMatching(/real date/i)]);
  });

  it('keeps an audit trail of what was calculated and why', async () => {
    const { policy } = await issuedPolicy();
    const started = await cancel(policy.id);
    const entries = await listAuditEntries(db, { entityType: 'job', entityId: started.job.id });
    expect(entries.map((e) => e.action)).toEqual(['job.start', 'cancellation.calculated', 'job.status']);
    expect(entries[1]).toMatchObject({ actor: 'agent.two', details: { reasonCode: 'customer_request', method: 'short_rate', refundPremiumPaise: 944760 } });
  });
});

describe('binding a cancellation (document section 8)', () => {
  it('binds as version 2 with a refund transaction (negative), and the policy is cancelled', async () => {
    const { policy } = await issuedPolicy();
    const { bound, branch } = await cancelAndBind(policy.id);

    expect(bound.branch).toMatchObject({ id: branch.id, status: 'bound', version: 2, cancelledOn: JAN1 });
    expect(bound.job.status).toBe('bound');
    expect(await listTransactions(db, policy.id)).toEqual([
      expect.objectContaining({ version: 1, kind: 'new_business', premiumPaise: 1574600 }),
      expect.objectContaining({ version: 2, kind: 'cancellation', effectiveDate: JAN1, premiumPaise: -944760, taxPaise: -170057, totalPaise: -1114817 }),
    ]);
    expect(await getCoverStatus(db, policy.id)).toEqual({ status: 'cancelled', version: 2, cancelledOn: JAN1 });

    const events = await listUnpublishedEvents(db);
    expect(events.at(-1)).toMatchObject({
      type: 'PolicyCancelled',
      aggregateId: policy.id,
      payload: { policyNumber: 'PL-0000001', version: 2, effectiveDate: JAN1, reasonCode: 'customer_request', method: 'short_rate', transaction: { kind: 'cancellation', premiumPaise: -944760, taxPaise: -170057, totalPaise: -1114817 } },
    });
  });

  it('shows a policy in force before it is cancelled', async () => {
    const { policy } = await issuedPolicy();
    expect(await getCoverStatus(db, policy.id)).toEqual({ status: 'in_force', version: 1, cancelledOn: null });
  });

  it('refuses a second cancellation and a change to a cancelled policy', async () => {
    const { policy } = await issuedPolicy();
    await cancelAndBind(policy.id);
    expect(await errorsOf(cancel(policy.id))).toEqual([expect.stringMatching(/already cancelled/i)]);
    expect(await errorsOf(startPolicyChange(db, { policyId: policy.id, effectiveDate: START }, 'u'))).toEqual([expect.stringMatching(/cancelled.*reinstate/i)]);
  });

  it('preempts other open change jobs of the policy, as any bind does', async () => {
    const { policy, covers } = await issuedPolicy();
    const change = await startPolicyChange(db, { policyId: policy.id, effectiveDate: '2027-03-01' }, 'agent.two');
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await cancelAndBind(policy.id);
    expect((await getJob(db, change.job.id))?.status).toBe('preempted');
  });

  it('refuses to bind a cancellation that was started from an older version, and one that was withdrawn', async () => {
    const { policy } = await issuedPolicy();
    const started = await cancel(policy.id);
    await withdrawJob(db, started.job.id, 'agent.two');
    expect(await errorsOf(bindJob(db, bindDeps, started.job.id, { branchId: started.branch.id }, 'u', { today: '2026-12-20' }))).toEqual([expect.stringMatching(/only a quoted job can be bound \(this one is withdrawn\)/i)]);
  });

  it('issues a cancellation notice document with the refund', async () => {
    const { policy } = await issuedPolicy();
    const { job } = await cancelAndBind(policy.id);
    const issued = await issueJob(db, bindDeps, job.id, 'agent.two', { today: '2026-12-21' });
    expect(issued.job.status).toBe('issued');
    expect(issued.document).toMatchObject({ kind: 'cancellation_notice', contentType: 'application/pdf', metadata: { policyNumber: 'PL-0000001', version: 2 } });
    expect((await listDocuments(db, policy.id)).map((d) => d.kind)).toEqual(['policy_schedule', 'cancellation_notice']);
    expect((await getAdjustment(db, job.id))?.refundPremiumPaise).toBe(944760);
  });
});

describe('reinstatement (document section 8)', () => {
  const reinstate = (policyId: string, over: Partial<{ withGap: boolean; reinstatementDate: string }> = {}, today = '2027-01-05') =>
    startReinstatement(db, deps, { policyId, withGap: false, ...over }, 'agent.two', { today });
  const quoteAndBind = async (r: Awaited<ReturnType<typeof reinstate>>, today = '2027-01-05') => {
    await quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today });
    return bindJob(db, bindDeps, r.job.id, { branchId: r.branch.id }, 'agent.two', { today });
  };

  it('without a gap restores the cover as it was and charges back exactly what was refunded', async () => {
    const { policy } = await issuedPolicy();
    await cancelAndBind(policy.id);
    const r = await reinstate(policy.id);

    expect(r.job).toMatchObject({ type: 'reinstatement', status: 'draft', effectiveDate: JAN1 });
    expect(r.branch).toMatchObject({ status: 'draft', cancelledOn: null, basedOnId: expect.any(String) });
    expect(await rowEnds(r.branch.id)).toBe(END);

    const bound = await quoteAndBind(r);
    expect(bound.branch.version).toBe(3);
    expect((await listTransactions(db, policy.id)).at(-1)).toMatchObject({ version: 3, kind: 'reinstatement', effectiveDate: JAN1, premiumPaise: 944760, taxPaise: 170057, totalPaise: 1114817 });
    expect(await getCoverStatus(db, policy.id)).toEqual({ status: 'in_force', version: 3, cancelledOn: null });
    expect((await listUnpublishedEvents(db)).at(-1)).toMatchObject({ type: 'PolicyReinstated', payload: { version: 3, withGap: false } });
  });

  it('with a gap leaves the days between cancellation and reinstatement uncovered, and charges only for the days covered', async () => {
    const { policy } = await issuedPolicy();
    await cancelAndBind(policy.id);
    const r = await reinstate(policy.id, { withGap: true, reinstatementDate: FEB1 });
    expect(await coverageSlices(r.branch.id, 'MOTOR_OD')).toEqual([[START, JAN1], [FEB1, END]]);

    // Covered 78 + 256 days; the part of the premium the insurer kept after the cancellation is credited.
    const bound = await quoteAndBind(r);
    expect(bound.quote).toMatchObject({ premiumPaise: 1440866, taxPaise: 259356 });
    expect((await listTransactions(db, policy.id)).at(-1)).toMatchObject({ version: 3, kind: 'reinstatement', effectiveDate: JAN1, premiumPaise: 811026, taxPaise: 145985, totalPaise: 957011 });
    expect((await listUnpublishedEvents(db)).at(-1)).toMatchObject({ payload: { withGap: true, reinstatementDate: FEB1 } });
  });

  it('refuses a policy that is not cancelled, a date that makes no sense, and a request after the time limit', async () => {
    const { policy } = await issuedPolicy();
    expect(await errorsOf(reinstate(policy.id))).toEqual([expect.stringMatching(/not cancelled/i)]);

    await cancelAndBind(policy.id);
    expect(await errorsOf(reinstate(policy.id, { withGap: true }))).toEqual([expect.stringMatching(/reinstatement date is needed/i)]);
    expect(await errorsOf(reinstate(policy.id, { withGap: true, reinstatementDate: JAN1 }))).toEqual([expect.stringMatching(/after the cancellation date/i)]);
    expect(await errorsOf(reinstate(policy.id, { withGap: true, reinstatementDate: END }))).toEqual([expect.stringMatching(/before the end of the policy period/i)]);
    expect(await errorsOf(reinstate(policy.id, { withGap: false, reinstatementDate: FEB1 }))).toEqual([expect.stringMatching(/only with a gap/i)]);
    expect(await errorsOf(reinstate(policy.id, {}, '2027-02-01'))).toEqual([expect.stringMatching(/30 days.*cancellation/i)]); // 1 Jan + 30 days = 31 Jan
    await expect(reinstate(policy.id, {}, '2027-01-31')).resolves.toBeDefined(); // the last day of the window
  });

  it('issues a reinstatement schedule, and the policy can be changed again afterwards, priced from the reinstated premium', async () => {
    const { policy, covers } = await issuedPolicy();
    await cancelAndBind(policy.id);
    const r = await reinstate(policy.id);
    await quoteAndBind(r);
    const issued = await issueJob(db, bindDeps, r.job.id, 'agent.two', { today: '2027-01-06' });
    expect(issued.document).toMatchObject({ kind: 'reinstatement_schedule', metadata: { version: 3 } });

    const change = await startPolicyChange(db, { policyId: policy.id, effectiveDate: '2027-03-01' }, 'agent.two');
    await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-06' }); // nothing edited
    await bindJob(db, bindDeps, change.job.id, { branchId: change.branch.id }, 'agent.two', { today: '2027-01-06' });
    expect((await listTransactions(db, policy.id)).at(-1)).toMatchObject({ version: 4, kind: 'change', premiumPaise: 0, taxPaise: 0 });
    expect(covers).toBeDefined();
  });

  it('is checked by underwriting like any quote: the reinstated version is quoted by the normal process', async () => {
    const { policy } = await issuedPolicy();
    await cancelAndBind(policy.id);
    const r = await reinstate(policy.id);
    expect(await listAuditEntries(db, { entityType: 'job', entityId: r.job.id })).toEqual([expect.objectContaining({ action: 'job.start', details: expect.objectContaining({ type: 'reinstatement' }) })]);
    await quoteBranch(db, quoteDeps, r.branch.id, 'agent.two', { today: '2027-01-05' });
    expect((await getJob(db, r.job.id))?.status).toBe('quoted');
  });
});
