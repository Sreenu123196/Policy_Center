import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listEventsAfter, ValidationError } from '../platform/index.js';
import { bindJob, getCoverStatus, getJob, quoteBranch, startCancellation } from '../policy/index.js';
import { processBillingEvents } from '../policy/index.js';
import type { Account } from '../policy/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { generateInvoices, processPolicyEvents, setPaymentPlan } from './billing.js';
import { listDelinquencySteps, receivePayment, runDelinquency } from './payments.js';
import { bindDeps, billingConfig, cancelDeps, createCustomer, issueGoldenPolicy, quoteDeps } from './test-support.js';

let db: PGlite;
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

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

const pay = (amountPaise: number, receivedOn: string, reference: string) =>
  receivePayment(db, { accountId: customer.id, amountPaise, method: 'upi', reference, receivedOn }, 'cashier');
const delinquency = (today: string) => runDelinquency(db, billingConfig, { today }, 'batch');
const eventsOf = async (type: string) => (await listEventsAfter(db, 0, 1000)).filter((e) => e.type === type);

// The golden policy on the quarterly plan, first invoice (464,507) made and left unpaid. It falls due on 15 October;
// the plan gives 10 grace days, so a missed payment is late from 25 October. The product steps: reminder on day 0,
// final notice after 10 days, cancellation request after 20 days.
async function unpaidFirstInvoice() {
  await setPaymentPlan(db, billingConfig, customer.id, 'QUARTERLY', 'agent.one', { today: '2026-10-01' });
  const policy = await issueGoldenPolicy(db, customer);
  await processPolicyEvents(db, billingConfig);
  const [invoice] = await generateInvoices(db, billingConfig, { today: '2026-09-30' }, 'batch');
  return { ...policy, invoice: invoice! };
}

describe('missed payments: timed steps (document section 14)', () => {
  it('does nothing before the grace days are over, and a payment on time starts nothing', async () => {
    await unpaidFirstInvoice();
    expect(await delinquency('2026-10-15')).toEqual([]); // due today
    expect(await delinquency('2026-10-24')).toEqual([]); // still inside the 10 grace days
    expect(await eventsOf('DelinquencyStarted')).toEqual([]);
  });

  it('sends a reminder when the grace days are over, once, and announces DelinquencyStarted', async () => {
    const { invoice } = await unpaidFirstInvoice();
    const first = await delinquency('2026-10-25');
    expect(first).toEqual([expect.objectContaining({ invoiceNumber: invoice.number, action: 'reminder', doneOn: '2026-10-25' })]);
    expect(await delinquency('2026-10-25')).toEqual([]); // the same step is never done twice
    expect(await eventsOf('DelinquencyStarted')).toEqual([
      expect.objectContaining({ aggregateType: 'billing_account', payload: expect.objectContaining({ accountId: customer.id, invoiceNumber: invoice.number, action: 'reminder', outstandingPaise: 464507, overdueDays: 10, policyNumbers: ['PL-0000001'] }) }),
    ]);
  });

  it('goes on to a final notice after 10 more days and a cancellation request after 20, each once, even if the batch runs late', async () => {
    await unpaidFirstInvoice();
    await delinquency('2026-10-25');
    expect((await delinquency('2026-11-04')).map((s) => s.action)).toEqual(['final_notice']);
    expect((await delinquency('2026-11-14')).map((s) => s.action)).toEqual(['cancellation_request']);
    expect(await delinquency('2026-11-30')).toEqual([]);
    const requested = await eventsOf('CancellationRequested');
    expect(requested).toHaveLength(1);
    expect(requested[0]?.payload).toMatchObject({ accountId: customer.id, policyNumbers: ['PL-0000001'], outstandingPaise: 464507, overdueDays: 30 });
  });

  it('runs every missed step in order when the batch has not run for a long time', async () => {
    await unpaidFirstInvoice();
    expect((await delinquency('2026-12-01')).map((s) => s.action)).toEqual(['reminder', 'final_notice', 'cancellation_request']);
  });

  it('stops for an invoice that is paid, and a part payment still leaves it delinquent', async () => {
    const { invoice } = await unpaidFirstInvoice();
    await pay(100000, '2026-10-20', 'U-1');
    expect((await delinquency('2026-10-25'))[0]).toMatchObject({ action: 'reminder' });
    expect((await eventsOf('DelinquencyStarted'))[0]?.payload).toMatchObject({ outstandingPaise: 364507 });
    await pay(364507, '2026-10-26', 'U-2');
    expect(await delinquency('2026-11-14')).toEqual([]);
    expect((await listDelinquencySteps(db, invoice.id)).map((s) => s.action)).toEqual(['reminder']);
  });

  it('asks for a reinstatement when an invoice that led to a cancellation request is paid later, once', async () => {
    await unpaidFirstInvoice();
    await delinquency('2026-11-14'); // all three steps
    await pay(464507, '2026-11-20', 'U-3');
    const requested = await eventsOf('ReinstatementRequested');
    expect(requested).toHaveLength(1);
    expect(requested[0]?.payload).toMatchObject({ accountId: customer.id, policyNumbers: ['PL-0000001'] });
    await pay(1, '2026-11-21', 'U-4'); // a further payment does not ask again
    expect(await eventsOf('ReinstatementRequested')).toHaveLength(1);
  });

  it('does not ask for a reinstatement when nothing was ever requested for cancellation', async () => {
    await unpaidFirstInvoice();
    await delinquency('2026-10-25'); // only a reminder
    await pay(464507, '2026-10-27', 'U-5');
    expect(await eventsOf('ReinstatementRequested')).toEqual([]);
  });

  it('checks the date it is given', async () => {
    expect(await errorsOf(delinquency('2026-02-30'))).toEqual([expect.stringMatching(/real date/i)]);
  });
});

describe('Policy acts on billing events (document section 14: "Billing sends back ...")', () => {
  const act = (today: string) => processBillingEvents(db, { ...cancelDeps }, 'billing.system', { today });

  it('turns a cancellation request into a non-payment cancellation job with the notice the product requires', async () => {
    const { policy } = await unpaidFirstInvoice();
    await delinquency('2026-11-14');
    const results = await act('2026-11-14');
    expect(results).toEqual([expect.objectContaining({ policyNumber: 'PL-0000001', outcome: 'cancellation_started' })]);

    const job = await getJob(db, results[0]!.jobId!);
    expect(job).toMatchObject({ type: 'cancellation', status: 'quoted', effectiveDate: '2026-11-29' }); // 15 days of notice
    expect(policy.policyNumber).toBe('PL-0000001');
  });

  it('is idempotent: the same request twice starts one job, and a policy that is already cancelled is left alone', async () => {
    await unpaidFirstInvoice();
    await delinquency('2026-11-14');
    expect(await act('2026-11-14')).toHaveLength(1);
    expect(await act('2026-11-14')).toEqual([]); // nothing new to read
    await db.query('delete from policy.consumer_offset'); // as if the offset was lost and the event came again
    expect(await act('2026-11-14')).toEqual([expect.objectContaining({ outcome: 'skipped', reason: expect.stringMatching(/already.*cancellation/i) })]);
  });

  it('ignores events that are not for Policy', async () => {
    await unpaidFirstInvoice();
    await delinquency('2026-10-25'); // a reminder only
    expect(await act('2026-10-25')).toEqual([]);
  });

  it('closes the loop: pay late, and Policy starts a reinstatement of the policy it cancelled for non-payment', async () => {
    const { policy } = await unpaidFirstInvoice();
    await delinquency('2026-11-14');
    const [started] = await act('2026-11-14');
    await bindJob(db, bindDeps, started!.jobId!, { branchId: (await db.query<{ id: string }>('select id from policy.policy_period where job_id = $1', [started!.jobId])).rows[0]!.id }, 'uw.one', { today: '2026-11-14' });
    expect(await getCoverStatus(db, policy.id)).toMatchObject({ status: 'cancelled', cancelledOn: '2026-11-29' });

    await pay(464507, '2026-12-01', 'U-6'); // the customer pays after the cover ended
    const results = await act('2026-12-01');
    expect(results).toEqual([expect.objectContaining({ policyNumber: 'PL-0000001', outcome: 'reinstatement_started' })]);
    const reinstatement = await getJob(db, results[0]!.jobId!);
    expect(reinstatement).toMatchObject({ type: 'reinstatement', status: 'draft' });

    const branchId = (await db.query<{ id: string }>('select id from policy.policy_period where job_id = $1', [reinstatement!.id])).rows[0]!.id;
    await quoteBranch(db, quoteDeps, branchId, 'uw.one', { today: '2026-12-01' });
    await bindJob(db, bindDeps, reinstatement!.id, { branchId }, 'uw.one', { today: '2026-12-01' });
    expect(await getCoverStatus(db, policy.id)).toMatchObject({ status: 'in_force' });
  });

  it('does not reinstate a policy that was cancelled for another reason, or after the time limit', async () => {
    const { policy } = await unpaidFirstInvoice();
    const cancel = await startCancellation(db, cancelDeps, { policyId: policy.id, effectiveDate: '2027-01-01', reasonCode: 'customer_request' }, 'agent.two', { today: '2026-12-20' });
    await bindJob(db, bindDeps, cancel.job.id, { branchId: cancel.branch.id }, 'agent.two', { today: '2026-12-20' });
    await delinquency('2026-11-14');
    await act('2026-11-14'); // the cancellation request finds the policy already cancelled
    await pay(464507, '2026-11-20', 'U-7');
    const results = await act('2026-11-20');
    expect(results).toEqual([expect.objectContaining({ policyNumber: 'PL-0000001', outcome: 'skipped', reason: expect.stringMatching(/not cancelled for non-payment/i) })]);
  });
});
