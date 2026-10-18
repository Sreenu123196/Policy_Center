import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditEntries, listEventsAfter, ValidationError } from '../platform/index.js';
import { bindJob, startCancellation } from '../policy/index.js';
import type { Account } from '../policy/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { generateInvoices, getBillingAccount, getInvoice, listCredits, listScheduleItems, processPolicyEvents, setPaymentPlan } from './billing.js';
import { applyCredit, getPayment, listSuspense, matchSuspense, receivePayment, receiveUnmatchedPayment, refundCredit } from './payments.js';
import { bindDeps, billingConfig, cancelDeps, createCustomer, issueGoldenPolicy } from './test-support.js';

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

const pay = (amountPaise: number, over: Partial<{ reference: string; method: 'upi' | 'enach' | 'card' | 'bank_transfer'; receivedOn: string; policyNumber: string }> = {}) =>
  receivePayment(db, { accountId: customer.id, amountPaise, method: 'upi', reference: `UPI-${amountPaise}`, receivedOn: '2026-10-10', ...over }, 'cashier');
const invoices = (today: string) => generateInvoices(db, billingConfig, { today }, 'batch');
const billingId = async () => (await getBillingAccount(db, customer.id))!.id;

// The golden policy on the quarterly plan: payments of 464,507 (15 Oct), 469,507 (13 Jan), 469,507 (13 Apr), 469,507 (12 Jul).
async function quarterly() {
  await setPaymentPlan(db, billingConfig, customer.id, 'QUARTERLY', 'agent.one', { today: '2026-10-01' });
  const policy = await issueGoldenPolicy(db, customer);
  await processPolicyEvents(db, billingConfig);
  return policy;
}

describe('receiving a payment and allocating it (document section 14)', () => {
  it('pays an invoice in full: the line, the payment item and the invoice become paid, and PaymentReceived is announced', async () => {
    await quarterly();
    const [invoice] = await invoices('2026-09-30');
    const payment = await pay(464507);
    expect(payment).toMatchObject({ amountPaise: 464507, allocatedPaise: 464507, unappliedPaise: 0, method: 'upi', reference: 'UPI-464507', receivedOn: '2026-10-10' });

    expect((await getInvoice(db, invoice!.id))).toMatchObject({ status: 'paid', lines: [expect.objectContaining({ paidPaise: 464507 })] });
    expect((await listScheduleItems(db, await billingId())).map((i) => i.status)).toEqual(['paid', 'scheduled', 'scheduled', 'scheduled']);
    const received = (await listEventsAfter(db, 0, 100)).find((e) => e.type === 'PaymentReceived');
    expect(received).toMatchObject({ aggregateType: 'billing_account', payload: { accountId: customer.id, amountPaise: 464507, allocatedPaise: 464507, unappliedPaise: 0, reference: 'UPI-464507' } });
  });

  it('takes a part payment: the invoice stays open with the line part paid, and a second payment finishes it', async () => {
    await quarterly();
    const [invoice] = await invoices('2026-09-30');
    await pay(200000);
    let current = await getInvoice(db, invoice!.id);
    expect(current).toMatchObject({ status: 'open', paidPaise: 200000, outstandingPaise: 264507 });
    expect((await listScheduleItems(db, await billingId()))[0]?.status).toBe('invoiced');

    await pay(264507, { reference: 'UPI-2' });
    current = await getInvoice(db, invoice!.id);
    expect(current).toMatchObject({ status: 'paid', paidPaise: 464507, outstandingPaise: 0 });
  });

  it('keeps an overpayment as unapplied cash, and puts it against the next invoice when that is made', async () => {
    await quarterly();
    await invoices('2026-09-30');
    const payment = await pay(500000);
    expect(payment).toMatchObject({ allocatedPaise: 464507, unappliedPaise: 35493 });

    const [second] = await invoices('2026-12-29'); // the instalment due 13 January
    expect(second).toMatchObject({ number: 'INV-0000002', totalPaise: 469507 });
    expect(await getInvoice(db, second!.id)).toMatchObject({ status: 'open', paidPaise: 35493, outstandingPaise: 434014 });
    expect((await getPayment(db, payment.id))?.unappliedPaise).toBe(0);
  });

  it('pays the oldest invoice first', async () => {
    await quarterly();
    const [first] = await invoices('2026-09-30');
    const [second] = await invoices('2026-12-29');
    await pay(600000);
    expect(await getInvoice(db, first!.id)).toMatchObject({ status: 'paid', paidPaise: 464507 });
    expect(await getInvoice(db, second!.id)).toMatchObject({ status: 'open', paidPaise: 135493 });
  });

  it('can be meant for one policy: it pays that policy only, and the rest waits as unapplied cash', async () => {
    await issueGoldenPolicy(db, customer);
    await issueGoldenPolicy(db, customer); // PL-0000002
    await processPolicyEvents(db, billingConfig);
    const [invoice] = await invoices('2026-10-15'); // both policies fall due on the same day: one invoice, two lines
    expect(invoice?.totalPaise).toBe(2 * 1858028);

    const payment = await pay(2000000, { policyNumber: 'PL-0000002' });
    expect(payment).toMatchObject({ allocatedPaise: 1858028, unappliedPaise: 141972 });
    const full = await getInvoice(db, invoice!.id);
    expect(full?.lines.map((l) => [l.policyNumber, l.paidPaise])).toEqual([['PL-0000001', 0], ['PL-0000002', 1858028]]);
    expect(full?.status).toBe('open');
  });

  it('is idempotent on the payment reference: the same payment twice counts once, but a different amount with the same reference is refused', async () => {
    await quarterly();
    await invoices('2026-09-30');
    const first = await pay(464507);
    const again = await pay(464507);
    expect(again.id).toBe(first.id);
    expect((await listEventsAfter(db, 0, 100)).filter((e) => e.type === 'PaymentReceived')).toHaveLength(1);
    expect(await errorsOf(pay(100, { reference: 'UPI-464507' }))).toEqual([expect.stringMatching(/reference.*already used/i)]);
  });

  it('refuses a payment that is not valid, or for an account billing does not know', async () => {
    await quarterly();
    expect(await errorsOf(pay(0))).toEqual([expect.stringMatching(/positive whole amount/i)]);
    expect(await errorsOf(pay(1.5))).toEqual([expect.stringMatching(/positive whole amount/i)]);
    expect(await errorsOf(pay(100, { method: 'cheque' as never }))).toEqual([expect.stringMatching(/method/i)]);
    expect(await errorsOf(pay(100, { reference: ' ' }))).toEqual([expect.stringMatching(/reference/i)]);
    expect(await errorsOf(pay(100, { receivedOn: '2026-02-30' }))).toEqual([expect.stringMatching(/real date/i)]);
    expect(await errorsOf(receivePayment(db, { accountId: '00000000-0000-0000-0000-000000000000', amountPaise: 100, method: 'upi', reference: 'X-1', receivedOn: '2026-10-10' }, 'u'))).toEqual([
      expect.stringMatching(/no billing account.*unmatched/i),
    ]);
  });

  it('records who took the payment in the audit log', async () => {
    await quarterly();
    await invoices('2026-09-30');
    const payment = await pay(464507);
    const entries = await listAuditEntries(db, { entityType: 'payment', entityId: payment.id });
    expect(entries).toEqual([expect.objectContaining({ actor: 'cashier', action: 'payment.receive', details: expect.objectContaining({ amountPaise: 464507, method: 'upi' }) })]);
  });
});

describe('suspense: money that cannot be matched yet (document section 14)', () => {
  it('holds an unmatched payment in suspense until someone matches it to an account, and then allocates it', async () => {
    await quarterly();
    await invoices('2026-09-30');
    const held = await receiveUnmatchedPayment(db, { amountPaise: 464507, method: 'bank_transfer', reference: 'NEFT-9', receivedOn: '2026-10-11', note: 'Name on the transfer: A Rao' }, 'cashier');
    expect(held).toMatchObject({ billingAccountId: null, unappliedPaise: 464507, allocatedPaise: 0 });
    expect((await listSuspense(db)).map((p) => [p.reference, p.unappliedPaise])).toEqual([['NEFT-9', 464507]]);

    const matched = await matchSuspense(db, held.id, customer.id, 'cashier');
    expect(matched).toMatchObject({ allocatedPaise: 464507, unappliedPaise: 0 });
    expect(await listSuspense(db)).toEqual([]);
    expect((await listScheduleItems(db, await billingId()))[0]?.status).toBe('paid');
  });

  it('refuses to match a payment twice, to an unknown account, or one that is not in suspense', async () => {
    await quarterly();
    const held = await receiveUnmatchedPayment(db, { amountPaise: 1000, method: 'upi', reference: 'U-1', receivedOn: '2026-10-11' }, 'u');
    expect(await errorsOf(matchSuspense(db, held.id, '00000000-0000-0000-0000-000000000000', 'u'))).toEqual([expect.stringMatching(/no billing account/i)]);
    await matchSuspense(db, held.id, customer.id, 'u');
    expect(await errorsOf(matchSuspense(db, held.id, customer.id, 'u'))).toEqual([expect.stringMatching(/not in suspense/i)]);
    expect(await errorsOf(matchSuspense(db, '00000000-0000-0000-0000-000000000000', customer.id, 'u'))).toEqual([expect.stringMatching(/payment does not exist/i)]);
  });
});

describe('credits: return premium paid out or applied (document section 14)', () => {
  // Cancel from 1 January for a customer request: 944,760 premium and 170,057 tax come back, 1,114,817 in all.
  async function cancelled(plan: 'FULL_PAY' | 'QUARTERLY') {
    await setPaymentPlan(db, billingConfig, customer.id, plan, 'agent.one', { today: '2026-10-01' });
    const policy = await issueGoldenPolicy(db, customer);
    const cancel = await startCancellation(db, cancelDeps, { policyId: policy.policy.id, effectiveDate: '2027-01-01', reasonCode: 'customer_request' }, 'agent.two', { today: '2026-12-20' });
    await bindJob(db, bindDeps, cancel.job.id, { branchId: cancel.branch.id }, 'agent.two', { today: '2026-12-20' });
    await processPolicyEvents(db, billingConfig);
  }

  it('voids the payment items that fall due after the cancellation, so nobody is billed for cover that has ended', async () => {
    await cancelled('QUARTERLY');
    const items = await listScheduleItems(db, await billingId());
    expect(items.map((i) => [i.sequence, i.status])).toEqual([[1, 'scheduled'], [2, 'void'], [3, 'void'], [4, 'void']]);
  });

  it('pays the refund out when the customer has paid in full', async () => {
    await cancelled('FULL_PAY');
    await invoices('2026-10-01');
    await pay(1858028);
    const [credit] = await listCredits(db, await billingId());
    expect(credit).toMatchObject({ totalPaise: 1114817, remainingPaise: 1114817, status: 'open' });

    const payout = await refundCredit(db, credit!.id, { method: 'bank_transfer', reference: 'REF-1', paidOn: '2027-01-05' }, 'cashier');
    expect(payout).toMatchObject({ amountPaise: 1114817, method: 'bank_transfer', reference: 'REF-1' });
    expect((await listCredits(db, await billingId()))[0]).toMatchObject({ status: 'refunded', remainingPaise: 0 });
    expect(await errorsOf(refundCredit(db, credit!.id, { method: 'bank_transfer', reference: 'REF-2', paidOn: '2027-01-05' }, 'cashier'))).toEqual([expect.stringMatching(/nothing left to refund/i)]);
  });

  it('never pays out more than the customer actually paid beyond what the insurer keeps', async () => {
    // Quarterly: only the 464,507 down payment was paid, but the insurer keeps 743,211 of the term, so nothing can be refunded.
    await cancelled('QUARTERLY');
    await invoices('2026-09-30');
    await pay(464507);
    const [credit] = await listCredits(db, await billingId());
    expect(await errorsOf(refundCredit(db, credit!.id, { method: 'upi', reference: 'REF-1', paidOn: '2027-01-05' }, 'cashier'))).toEqual([expect.stringMatching(/paid.*insurer keeps.*apply/i)]);
  });

  it('can instead be applied to what the customer owes', async () => {
    await cancelled('QUARTERLY');
    await invoices('2026-09-30'); // the down payment, 464,507, is still unpaid
    const [credit] = await listCredits(db, await billingId());
    const applied = await applyCredit(db, credit!.id, 'cashier');
    expect(applied).toMatchObject({ appliedPaise: 464507, remainingPaise: 650310 });
    expect((await listScheduleItems(db, await billingId()))[0]?.status).toBe('paid');
    expect((await listCredits(db, await billingId()))[0]).toMatchObject({ status: 'open', remainingPaise: 650310 });
  });

  it('refuses an unknown credit', async () => {
    expect(await errorsOf(applyCredit(db, '00000000-0000-0000-0000-000000000000', 'u'))).toEqual([expect.stringMatching(/credit does not exist/i)]);
    expect(await errorsOf(refundCredit(db, '00000000-0000-0000-0000-000000000000', { method: 'upi', reference: 'R', paidOn: '2027-01-05' }, 'u'))).toEqual([expect.stringMatching(/credit does not exist/i)]);
  });
});
