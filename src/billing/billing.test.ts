import { fileURLToPath } from 'node:url';
import type { Database } from '../platform/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact } from '../contacts/index.js';
import { createProducerCode, createProducerOrganisation, listAuditEntries, listEventsAfter, recordEvent, ValidationError } from '../platform/index.js';
import {
  addCoverable,
  addCoverage,
  bindJob,
  changeCoverage,
  createAccount,
  createQuoter,
  issueJob,
  loadCancellationRules,
  loadProductCatalogue,
  loadRateBooks,
  loadRenewalRules,
  quoteBranch,
  startCancellation,
  startPolicyChange,
  startRenewal,
  startSubmission,
} from '../policy/index.js';
import type { Account } from '../policy/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { loadBillingConfig } from './config.js';
import {
  generateInvoices,
  getBillingAccount,
  getInvoice,
  listCharges,
  listCredits,
  listInvoices,
  listScheduleItems,
  processPolicyEvents,
  setPaymentPlan,
} from './billing.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const catalogue = loadProductCatalogue(`${configFolder}products/`);
const billingConfig = loadBillingConfig(`${configFolder}billing/`);
const quoteDeps = { catalogue, quoter: createQuoter(loadRateBooks(`${configFolder}ratebooks/`, catalogue)) };
const bindDeps = { catalogue };
const cancelDeps = { catalogue, cancellation: loadCancellationRules(`${configFolder}cancellation/`, catalogue) };
const renewDeps = { catalogue, renewal: loadRenewalRules(`${configFolder}renewal/`, catalogue) };
const PRODUCT = 'MOTOR_PRIVATE_CAR';
const START = '2026-10-15';

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

// Version 1: the golden policy (premium 1,574,600 + GST 283,428 = 1,858,028 paise), bound and issued.
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
  await quoteBranch(db, quoteDeps, started.branch.id, 'agent.one', { today: '2026-10-16' });
  await bindJob(db, bindDeps, started.job.id, { branchId: started.branch.id }, 'agent.one', { today: '2026-10-16' });
  await issueJob(db, bindDeps, started.job.id, 'agent.one', { today: '2026-10-16' });
  return { ...started, car, covers };
}

const process = (limit?: number) => processPolicyEvents(db, billingConfig, limit === undefined ? {} : { limit });
async function billingAccount() {
  const account = await getBillingAccount(db, person.id);
  if (account === null) throw new Error('test setup: no billing account');
  return account;
}

describe('charges from policy events (document sections 14 and 17)', () => {
  it('turns a bound policy into a billing account, charges for premium and tax, and one payment item on the start date', async () => {
    const { policy } = await issuedPolicy();
    const result = await process();
    expect(result.eventsRead).toBe(2); // PolicyBound and PolicyIssued; the second one needs no charge
    expect(result.chargesCreated).toBe(1);

    const account = await billingAccount();
    expect(account).toMatchObject({ accountId: person.id, planCode: 'FULL_PAY', status: 'active' });
    expect((await listCharges(db, account.id)).map((c) => [c.type, c.amountPaise, c.kind, c.policyNumber, c.version, c.termNumber, c.effectiveDate])).toEqual([
      ['premium', 1574600, 'new_business', 'PL-0000001', 1, 1, START],
      ['tax', 283428, 'new_business', 'PL-0000001', 1, 1, START],
    ]);
    expect(await listScheduleItems(db, account.id)).toEqual([
      expect.objectContaining({ sequence: 1, dueDate: START, premiumPaise: 1574600, taxPaise: 283428, feePaise: 0, amountPaise: 1858028, status: 'scheduled', policyNumber: 'PL-0000001' }),
    ]);
    expect(policy.policyNumber).toBe('PL-0000001');
  });

  it('tells the others with a ChargesCreated event, written with the charges', async () => {
    await issuedPolicy();
    await process();
    const events = await listEventsAfter(db, 0, 100);
    const created = events.find((e) => e.type === 'ChargesCreated');
    expect(created).toMatchObject({ aggregateType: 'billing_account', payload: { accountId: person.id, policyNumber: 'PL-0000001', kind: 'new_business', totalPaise: 1858028, items: 1 } });
  });

  it('is idempotent: running again, or being given the same event twice, changes nothing', async () => {
    await issuedPolicy();
    await process();
    const account = await billingAccount();
    expect((await process()).eventsRead).toBe(1); // only its own ChargesCreated event is new, and it is ignored
    expect((await process()).eventsRead).toBe(0);

    await db.query("update billing.consumer_offset set last_event_id = 0"); // as if the offset was lost and every event came again
    const again = await process();
    expect(again.chargesCreated).toBe(0);
    expect(await listCharges(db, account.id)).toHaveLength(2);
    expect(await listScheduleItems(db, account.id)).toHaveLength(1);
  });

  it('works through the events in batches', async () => {
    await issuedPolicy();
    const first = await process(1);
    expect(first.eventsRead).toBe(1);
    expect((await process(100)).eventsRead).toBeGreaterThanOrEqual(1);
    expect(await listCharges(db, (await billingAccount()).id)).toHaveLength(2);
  });

  it('keeps nothing from a batch that fails: a bad event stops the consumer and the offset does not move', async () => {
    await issuedPolicy();
    await recordEvent(db, { type: 'PolicyBound', aggregateType: 'policy', aggregateId: '11111111-1111-4111-8111-111111111111', payload: { oops: true } });
    expect(await errorsOf(process())).toEqual([expect.stringMatching(/PolicyBound.*payload/i)]);
    expect(await getBillingAccount(db, person.id)).toBeNull(); // the good event before it was rolled back too
    const offset = await db.query<{ last_event_id: number }>('select last_event_id::float8 as last_event_id from billing.consumer_offset');
    expect(offset.rows).toEqual([]);
  });
});

describe('payment plans (document section 14)', () => {
  it('splits the charge by the plan chosen for the account: quarterly gives four items with a fee on the last three', async () => {
    await setPaymentPlan(db, billingConfig, person.id, 'QUARTERLY', 'agent.one', { today: '2026-10-01' });
    await issuedPolicy();
    await process();
    const items = await listScheduleItems(db, (await billingAccount()).id);
    expect(items.map((i) => [i.sequence, i.dueDate, i.feePaise, i.amountPaise])).toEqual([
      [1, '2026-10-15', 0, 464507],
      [2, '2027-01-13', 5000, 469507],
      [3, '2027-04-13', 5000, 469507],
      [4, '2027-07-12', 5000, 469507],
    ]);
  });

  it('can be changed only before the first charge, and only to a plan that exists', async () => {
    await setPaymentPlan(db, billingConfig, person.id, 'MONTHLY', 'agent.one', { today: '2026-10-01' });
    expect(await errorsOf(setPaymentPlan(db, billingConfig, person.id, 'NOPE', 'agent.one', { today: '2026-10-01' }))).toEqual([expect.stringMatching(/plan NOPE/)]);
    await setPaymentPlan(db, billingConfig, person.id, 'TWO_PAY', 'agent.one', { today: '2026-10-01' }); // still no charges: fine
    expect((await billingAccount()).planCode).toBe('TWO_PAY');
    await issuedPolicy();
    await process();
    expect(await errorsOf(setPaymentPlan(db, billingConfig, person.id, 'FULL_PAY', 'agent.one', { today: '2026-10-20' }))).toEqual([expect.stringMatching(/before the first charge/i)]);
    const entries = await listAuditEntries(db, { entityType: 'billing_account', entityId: (await billingAccount()).id });
    expect(entries.map((e) => e.action)).toContain('billing.plan');
  });

  it('bills a policy change in one payment on its effective date, whatever the plan', async () => {
    await setPaymentPlan(db, billingConfig, person.id, 'QUARTERLY', 'agent.one', { today: '2026-10-01' });
    const { policy, car } = await issuedPolicy();
    const change = await startPolicyChange(db, { policyId: policy.id, effectiveDate: '2027-01-01' }, 'agent.two');
    await addCoverage(db, change.branch.id, { coverableFixedId: car.fixedId, patternCode: 'ZERO_DEP', effFrom: '2027-01-01' }, 'agent.two');
    await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });
    await bindJob(db, bindDeps, change.job.id, { branchId: change.branch.id }, 'agent.two', { today: '2027-01-01' });
    await process();

    const items = await listScheduleItems(db, (await billingAccount()).id);
    expect(items).toHaveLength(5); // four for the policy and one for the change
    expect(items.at(-1)).toMatchObject({ kind: 'change', sequence: 1, dueDate: '2027-01-01', premiumPaise: 188712, taxPaise: 33968, feePaise: 0, amountPaise: 222680 });
    const charges = await listCharges(db, (await billingAccount()).id);
    expect(charges.filter((c) => c.kind === 'change').map((c) => [c.type, c.amountPaise, c.version])).toEqual([['premium', 188712, 2], ['tax', 33968, 2]]);
  });

  it('bills a renewal by the plan, as a new term', async () => {
    await setPaymentPlan(db, billingConfig, person.id, 'TWO_PAY', 'agent.one', { today: '2026-10-01' });
    const { policy } = await issuedPolicy();
    const renewal = await startRenewal(db, renewDeps, { policyId: policy.id }, 'agent.two', { today: '2027-09-15' });
    await quoteBranch(db, quoteDeps, renewal.branch.id, 'agent.two', { today: '2027-09-15' });
    await bindJob(db, bindDeps, renewal.job.id, { branchId: renewal.branch.id }, 'agent.two', { today: '2027-09-15' });
    await process();

    const items = (await listScheduleItems(db, (await billingAccount()).id)).filter((i) => i.kind === 'renewal');
    expect(items.map((i) => [i.sequence, i.dueDate, i.amountPaise])).toEqual([[1, '2027-10-15', 834614], [2, '2028-04-12', 834614]]);
  });
});

describe('refunds: return premium becomes a credit (document section 14)', () => {
  it('keeps a cancellation refund as a credit to pay out or apply, with no payment items', async () => {
    const { policy } = await issuedPolicy();
    const cancel = await startCancellation(db, cancelDeps, { policyId: policy.id, effectiveDate: '2027-01-01', reasonCode: 'customer_request' }, 'agent.two', { today: '2026-12-20' });
    await bindJob(db, bindDeps, cancel.job.id, { branchId: cancel.branch.id }, 'agent.two', { today: '2026-12-20' });
    await process();

    const account = await billingAccount();
    expect(await listCredits(db, account.id)).toEqual([
      expect.objectContaining({ kind: 'cancellation', policyNumber: 'PL-0000001', premiumPaise: 944760, taxPaise: 170057, totalPaise: 1114817, status: 'open', effectiveDate: '2027-01-01' }),
    ]);
    expect(await listScheduleItems(db, account.id)).toHaveLength(1); // only the original item
    expect((await listCharges(db, account.id)).filter((c) => c.kind === 'cancellation').map((c) => [c.type, c.amountPaise])).toEqual([['premium', -944760], ['tax', -170057]]);
  });
});

describe('invoices (document section 14)', () => {
  it('are made by a batch on the invoice date: the lead days before each due date, once, in number order', async () => {
    await setPaymentPlan(db, billingConfig, person.id, 'QUARTERLY', 'agent.one', { today: '2026-10-01' });
    await issuedPolicy();
    await process();
    const account = await billingAccount();

    expect(await generateInvoices(db, billingConfig, { today: '2026-09-29' }, 'batch')).toEqual([]); // 15 days lead: the first is due on 15 October
    const first = await generateInvoices(db, billingConfig, { today: '2026-09-30' }, 'batch');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ number: 'INV-0000001', invoiceDate: '2026-09-30', dueDate: '2026-10-15', premiumPaise: 393650, taxPaise: 70857, feePaise: 0, totalPaise: 464507, status: 'open' });
    expect(await generateInvoices(db, billingConfig, { today: '2026-09-30' }, 'batch')).toEqual([]); // the same item is never invoiced twice

    expect(await generateInvoices(db, billingConfig, { today: '2026-12-28' }, 'batch')).toEqual([]);
    const second = await generateInvoices(db, billingConfig, { today: '2026-12-29' }, 'batch');
    expect(second[0]).toMatchObject({ number: 'INV-0000002', dueDate: '2027-01-13', feePaise: 5000, totalPaise: 469507 });

    const items = await listScheduleItems(db, account.id);
    expect(items.map((i) => i.status)).toEqual(['invoiced', 'invoiced', 'scheduled', 'scheduled']);
    expect((await listInvoices(db, account.id)).map((i) => i.number)).toEqual(['INV-0000001', 'INV-0000002']);
  });

  it('show the tax separately on each line, as a GST invoice must, and the lines add up to the invoice', async () => {
    await issuedPolicy();
    await process();
    const [invoice] = await generateInvoices(db, billingConfig, { today: '2026-10-15' }, 'batch');
    const full = await getInvoice(db, invoice!.id);
    expect(full?.lines).toEqual([expect.objectContaining({ policyNumber: 'PL-0000001', premiumPaise: 1574600, taxPaise: 283428, feePaise: 0, amountPaise: 1858028 })]);
    expect(full?.lines.reduce((sum, l) => sum + l.amountPaise, 0)).toBe(full?.totalPaise);
  });

  it('put charges that fall due on the same day into one invoice', async () => {
    // A change that starts on 13 January falls due on the same day as the second quarterly instalment.
    await setPaymentPlan(db, billingConfig, person.id, 'QUARTERLY', 'agent.one', { today: '2026-10-01' });
    const { policy, covers } = await issuedPolicy();
    const change = await startPolicyChange(db, { policyId: policy.id, effectiveDate: '2027-01-13' }, 'agent.two');
    await changeCoverage(db, change.branch.id, { coverageFixedId: covers.MOTOR_OD!, terms: { idv: 60000000 } }, 'agent.two');
    await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });
    await bindJob(db, bindDeps, change.job.id, { branchId: change.branch.id }, 'agent.two', { today: '2027-01-01' });
    await process();

    const made = await generateInvoices(db, billingConfig, { today: '2027-01-02' }, 'batch'); // the first instalment is overdue too
    expect(made.map((i) => i.dueDate)).toEqual(['2026-10-15', '2027-01-13']);
    const second = await getInvoice(db, made[1]!.id);
    expect(second?.lines).toHaveLength(2);
    expect(second?.totalPaise).toBe(second?.lines.reduce((s, l) => s + l.amountPaise, 0));
  });

  it('are numbered in order across all billing accounts, and an unknown invoice is not found', async () => {
    await issuedPolicy();
    await process();
    await generateInvoices(db, billingConfig, { today: '2026-10-15' }, 'batch');
    expect(await getInvoice(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await getInvoice(db, 'not-an-id')).toBeNull();
  });
});
