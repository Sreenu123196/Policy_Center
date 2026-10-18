import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Database } from './platform/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyCredit,
  generateInvoices,
  getBillingAccount,
  listCharges,
  listCredits,
  listInvoices,
  listScheduleItems,
  processPolicyEvents,
  receivePayment,
  runDelinquency,
  setPaymentPlan,
} from './billing/index.js';
import { addExposure, getClaim, getFinancials, loadClaimsConfig, makePayment, moveExposure, recordRecovery, reportLoss, setReserve } from './claims/index.js';
import { assignRole, createRole, createUser, getUserByUsername, listAuditEntries, listEventsAfter } from './platform/index.js';
import {
  addCoverable,
  addCoverage,
  addQuoteOption,
  bindJob,
  changeCoverable,
  changeCoverage,
  compareQuotes,
  getBranch,
  getCoverStatus,
  getDocument,
  getJob,
  getPolicyAsOf,
  issueJob,
  listDocuments,
  listTransactions,
  processBillingEvents,
  quoteBranch,
  startPolicyChange,
  startRenewal,
  startSubmission,
} from './policy/index.js';
import { createTestDatabase, loadTestConfiguration } from './testing/database.js';
import { bindDeps, billingConfig, cancelDeps, catalogue, createCustomer, quoteDeps, renewDeps, START } from './testing/golden-policy.js';

// The whole life of one customer's policy, through all three modules, one step after the other (document section 21,
// the test strategy: scenario tests). Each step says what it proves. At the end, invariants that must hold across the
// modules are checked: the money in Policy, Billing and Claims has to add up.

const configFolder = fileURLToPath(new URL('../config/', import.meta.url));
const claimsDeps = { config: loadClaimsConfig(`${configFolder}claims/`) };

let db: Database;

beforeAll(async () => {
  db = await createTestDatabase();
  await loadTestConfiguration(db);
});

afterAll(async () => {
  await db.close();
});

// Shared between the steps: the story is one long scenario.
const story: {
  accountId: string;
  policyId: string;
  policyNumber: string;
  vehicleFixedId: string;
  coverIds: Record<string, string>;
  billingId: string;
  claimNumber: string;
  exposureId: string;
} = { accountId: '', policyId: '', policyNumber: '', vehicleFixedId: '', coverIds: {}, billingId: '', claimNumber: '', exposureId: '' };

const pay = (amountPaise: number, receivedOn: string, reference: string) =>
  receivePayment(db, { accountId: story.accountId, amountPaise, method: 'upi', reference, receivedOn }, 'cashier');
const eventTypes = async () => (await listEventsAfter(db, 0, 10000)).map((e) => e.type);
const branchOf = async (jobId: string) => (await db.query<{ id: string }>('select id from policy.policy_period where job_id = $1 and status <> $2 order by created_at desc limit 1', [jobId, 'withdrawn'])).rows[0]!.id;

describe('one customer, one policy, from the first quote to the renewal', () => {
  it('1. sells a policy: two quote options are compared, one is bound, and the schedule is issued', async () => {
    const customer = await createCustomer(db);
    story.accountId = customer.id;
    await setPaymentPlan(db, billingConfig, customer.id, 'QUARTERLY', 'agent.one', { today: '2026-10-01' });

    const started = await startSubmission(db, catalogue, { accountId: customer.id, productCode: 'MOTOR_PRIVATE_CAR', periodStart: START }, 'agent.one');
    story.policyId = started.policy.id;
    story.policyNumber = started.policy.policyNumber;
    const car = await addCoverable(db, started.branch.id, { kind: 'Vehicle', attributes: { make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001', engineCc: 1197, claimFreeYears: 2 } }, 'agent.one');
    story.vehicleFixedId = car.fixedId;
    for (const [code, terms] of [['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: 50000000 }]] as const) {
      story.coverIds[code] = (await addCoverage(db, started.branch.id, { coverableFixedId: car.fixedId, patternCode: code, terms }, 'agent.one')).fixedId;
    }
    const optionB = await addQuoteOption(db, started.job.id, { copyFrom: started.branch.id }, 'agent.one');
    await addCoverage(db, optionB.id, { coverableFixedId: car.fixedId, patternCode: 'ZERO_DEP' }, 'agent.one');
    await quoteBranch(db, quoteDeps, started.branch.id, 'agent.one', { today: '2026-10-16' });
    await quoteBranch(db, quoteDeps, optionB.id, 'agent.one', { today: '2026-10-16' });

    const options = await compareQuotes(db, started.job.id);
    expect(options.map((o) => [o.branch.label, o.quote?.totalPaise])).toEqual([['Option A', 1858028], ['Option B', 2141228]]);

    const bound = await bindJob(db, bindDeps, started.job.id, { branchId: started.branch.id }, 'uw.one', { today: '2026-10-16' });
    expect(bound.branch).toMatchObject({ status: 'bound', version: 1 });
    expect((await getBranch(db, optionB.id))?.status).toBe('withdrawn');
    const issued = await issueJob(db, bindDeps, started.job.id, 'uw.one', { today: '2026-10-16' });
    expect(issued.document.kind).toBe('policy_schedule');
    expect(await getCoverStatus(db, story.policyId)).toEqual({ status: 'in_force', version: 1, cancelledOn: null });
  });

  it('2. bills it in four instalments: Billing learns of the sale only through the event, and the first instalment is paid', async () => {
    expect((await processPolicyEvents(db, billingConfig)).chargesCreated).toBe(1);
    story.billingId = (await getBillingAccount(db, story.accountId))!.id;
    expect((await listScheduleItems(db, story.billingId)).map((i) => [i.sequence, i.dueDate, i.amountPaise])).toEqual([
      [1, '2026-10-15', 464507], [2, '2027-01-13', 469507], [3, '2027-04-13', 469507], [4, '2027-07-12', 469507],
    ]);
    const [invoice] = await generateInvoices(db, billingConfig, { today: '2026-10-16' }, 'batch');
    expect(invoice).toMatchObject({ number: 'INV-0000001', totalPaise: 464507 });
    expect(await pay(464507, '2026-10-16', 'UPI-1')).toMatchObject({ allocatedPaise: 464507, unappliedPaise: 0 });
  });

  it('3. changes the policy mid-term: the insured value goes up from 1 January, and only the difference is billed', async () => {
    const change = await startPolicyChange(db, { policyId: story.policyId, effectiveDate: '2027-01-01' }, 'agent.two');
    await changeCoverage(db, change.branch.id, { coverageFixedId: story.coverIds.MOTOR_OD!, terms: { idv: 70000000 } }, 'agent.two');
    const quote = await quoteBranch(db, quoteDeps, change.branch.id, 'agent.two', { today: '2027-01-01' });
    expect(quote).toMatchObject({ premiumPaise: 1952024, taxPaise: 351364 }); // 78 days at the old value, 287 at the new
    const bound = await bindJob(db, bindDeps, change.job.id, { branchId: change.branch.id }, 'uw.one', { today: '2027-01-01' });
    expect(bound.branch).toMatchObject({ version: 2 });
    expect((await issueJob(db, bindDeps, change.job.id, 'uw.one', { today: '2027-01-01' })).document.kind).toBe('endorsement_schedule');

    expect((await listTransactions(db, story.policyId)).at(-1)).toMatchObject({ version: 2, kind: 'change', premiumPaise: 377424, taxPaise: 67936, totalPaise: 445360 });
    await processPolicyEvents(db, billingConfig);
    const invoices = await generateInvoices(db, billingConfig, { today: '2027-01-01' }, 'batch'); // the change, and the instalment due on 13 January
    expect(invoices.map((i) => [i.dueDate, i.totalPaise])).toEqual([['2027-01-01', 445360], ['2027-01-13', 469507]]);
    await pay(445360, '2027-01-02', 'UPI-2');
    await pay(469507, '2027-01-10', 'UPI-3');
    expect((await listInvoices(db, story.billingId)).map((i) => i.status)).toEqual(['paid', 'paid', 'paid']);
  });

  it('4. settles a claim on the policy as it was on the loss date, within the financial authority of the handler', async () => {
    for (const role of ['claims_handler']) await createRole(db, { code: role, name: role, permissions: ['claim.pay', 'claim.handle', 'claim.report'] }, 'admin');
    await createUser(db, { username: 'claims.handler', displayName: 'Claims handler' }, 'admin');
    await assignRole(db, (await getUserByUsername(db, 'claims.handler'))!.id, 'claims_handler', 'admin');

    const claim = await reportLoss(db, claimsDeps, {
      policyNumber: story.policyNumber, lossDate: '2027-02-10', lossTime: '18:30', reportedOn: '2027-02-11', cause: 'collision', place: 'Outer Ring Road, Hyderabad',
      description: 'Hit from behind at a signal', channel: 'phone', reporter: { name: 'Asha Rao', phone: '9000000001' },
    }, 'claims.handler', { today: '2027-02-11' });
    story.claimNumber = claim.claimNumber;
    expect(claim.verification).toMatchObject({ status: 'verified', policy: { version: 2 } });
    expect(claim.verification.policy.coverages.find((c) => c.patternCode === 'MOTOR_OD')?.terms).toEqual({ idv: 70000000 }); // the value after the change

    const exposure = await addExposure(db, claimsDeps, claim.id, { coverageCode: 'MOTOR_OD', claimant: { name: 'Asha Rao', kind: 'insured' }, description: 'Damage to the car' }, 'claims.handler');
    story.exposureId = exposure.id;
    expect(exposure.limitPaise).toBe(70000000);
    await moveExposure(db, exposure.id, 'under_review', 'claims.handler');
    await moveExposure(db, exposure.id, 'approved', 'claims.handler', 'Estimate checked');
    await setReserve(db, claimsDeps, exposure.id, { costType: 'claim_cost', category: 'repair', outstandingPaise: 3000000, reason: 'Garage estimate' }, 'claims.handler');
    const bank = { ifsc: 'HDFC0001234', accountNumber: '50100123456789' };
    const part = { costType: 'claim_cost' as const, category: 'repair', method: 'bank_transfer' as const, payee: { kind: 'claimant' as const, name: 'Asha Rao', bank }, paidOn: '2027-02-20' };
    await makePayment(db, claimsDeps, exposure.id, { ...part, amountPaise: 1000000, kind: 'partial', reference: 'CPAY-1' }, 'claims.handler');
    await makePayment(db, claimsDeps, exposure.id, { ...part, amountPaise: 2000000, kind: 'final', reference: 'CPAY-2' }, 'claims.handler');
    await recordRecovery(db, exposure.id, { kind: 'salvage', amountPaise: 200000, source: 'Scrap dealer', reference: 'SAL-1', receivedOn: '2027-03-01' }, 'claims.handler');

    expect((await getClaim(db, claim.claimNumber))?.status).toBe('settled');
    expect((await getFinancials(db, claim.claimNumber)).claim).toEqual({ paidPaise: 3000000, outstandingPaise: 0, recoveredPaise: 200000, incurredPaise: 2800000 });
  });

  it('5. misses a payment: reminder, final notice and a cancellation request, which Policy turns into a cancellation for non-payment', async () => {
    const [invoice] = await generateInvoices(db, billingConfig, { today: '2027-04-01' }, 'batch'); // the third instalment, due 13 April
    expect(invoice).toMatchObject({ dueDate: '2027-04-13', totalPaise: 469507 });
    expect((await runDelinquency(db, billingConfig, { today: '2027-04-23' }, 'batch')).map((s) => s.action)).toEqual(['reminder']);
    expect((await runDelinquency(db, billingConfig, { today: '2027-05-03' }, 'batch')).map((s) => s.action)).toEqual(['final_notice']);
    expect((await runDelinquency(db, billingConfig, { today: '2027-05-13' }, 'batch')).map((s) => s.action)).toEqual(['cancellation_request']);

    const [request] = await processBillingEvents(db, cancelDeps, 'billing.system', { today: '2027-05-13' });
    expect(request).toMatchObject({ policyNumber: story.policyNumber, outcome: 'cancellation_started' });
    const job = await getJob(db, request!.jobId!);
    expect(job).toMatchObject({ type: 'cancellation', status: 'quoted', effectiveDate: '2027-05-28' }); // 15 days of notice
    await bindJob(db, bindDeps, job!.id, { branchId: await branchOf(job!.id) }, 'uw.one', { today: '2027-05-13' });
    expect(await getCoverStatus(db, story.policyId)).toEqual({ status: 'cancelled', version: 3, cancelledOn: '2027-05-28' });

    // Billing: the refund is a credit, and the instalment due on 12 July is cancelled.
    await processPolicyEvents(db, billingConfig);
    expect((await listCredits(db, story.billingId))[0]).toMatchObject({ premiumPaise: 748722, taxPaise: 134770, totalPaise: 883492, status: 'open' });
    expect((await listScheduleItems(db, story.billingId)).find((i) => i.sequence === 4 && i.kind === 'new_business')?.status).toBe('void');
    // A loss after the cancellation date would not be covered.
    expect((await getPolicyAsOf(db, story.policyNumber, '2027-06-01'))).toMatchObject({ status: 'not_in_force', reason: 'cancelled' });
    expect((await getPolicyAsOf(db, story.policyNumber, '2027-02-10'))?.status).toBe('in_force'); // the days before the cancellation were covered, so the earlier claim stands
  });

  it('6. is paid late: Billing asks for a reinstatement, Policy starts one, and the refund is set against what is owed', async () => {
    await pay(469507, '2027-06-05', 'UPI-4');
    const [request] = await processBillingEvents(db, cancelDeps, 'billing.system', { today: '2027-06-05' });
    expect(request).toMatchObject({ policyNumber: story.policyNumber, outcome: 'reinstatement_started' });
    const jobId = request!.jobId!;
    const branchId = await branchOf(jobId);
    await quoteBranch(db, quoteDeps, branchId, 'agent.two', { today: '2027-06-05' });
    await bindJob(db, bindDeps, jobId, { branchId }, 'uw.one', { today: '2027-06-05' });
    expect(await getCoverStatus(db, story.policyId)).toEqual({ status: 'in_force', version: 4, cancelledOn: null });
    expect((await listTransactions(db, story.policyId)).at(-1)).toMatchObject({ kind: 'reinstatement', premiumPaise: 748722, taxPaise: 134770, totalPaise: 883492 }); // exactly what was refunded

    await processPolicyEvents(db, billingConfig);
    const [invoice] = await generateInvoices(db, billingConfig, { today: '2027-06-05' }, 'batch');
    expect(invoice).toMatchObject({ dueDate: '2027-05-28', totalPaise: 883492 });
    const [credit] = await listCredits(db, story.billingId);
    expect(await applyCredit(db, credit!.id, 'cashier')).toMatchObject({ appliedPaise: 883492, remainingPaise: 0 });
    expect((await listInvoices(db, story.billingId)).every((i) => i.status === 'paid')).toBe(true);
  });

  it('7. renews: the next term uses the same vehicle, is rated for the new term, and is billed again by the plan', async () => {
    const renewal = await startRenewal(db, renewDeps, { policyId: story.policyId }, 'agent.two', { today: '2027-09-15' });
    expect(renewal.branch).toMatchObject({ termNumber: 2, periodStart: '2027-10-15', periodEnd: '2028-10-15' });
    // The claim made in the term must stop the no-claim bonus. Claims history is not connected to renewal yet, so the
    // person renewing sets it by hand (see PROGRESS.md, deferred from E4 and G2).
    await changeCoverable(db, renewal.branch.id, { coverableFixedId: story.vehicleFixedId, attributes: { claimFreeYears: 0 } }, 'agent.two');
    const quote = await quoteBranch(db, quoteDeps, renewal.branch.id, 'agent.two', { today: '2027-09-15' });
    expect(quote).toMatchObject({ premiumPaise: 2614600, taxPaise: 470628, totalPaise: 3085228, rateBook: 'MPC-2026.10' });

    await bindJob(db, bindDeps, renewal.job.id, { branchId: renewal.branch.id }, 'uw.one', { today: '2027-09-15' });
    expect((await issueJob(db, bindDeps, renewal.job.id, 'uw.one', { today: '2027-10-15' })).document.kind).toBe('renewal_schedule');
    expect(await getPolicyAsOf(db, story.policyNumber, '2027-10-15')).toMatchObject({ termNumber: 2, version: 1, status: 'in_force' });

    await processPolicyEvents(db, billingConfig);
    expect((await listScheduleItems(db, story.billingId)).filter((i) => i.kind === 'renewal').map((i) => [i.sequence, i.dueDate, i.amountPaise])).toEqual([
      [1, '2027-10-15', 771307], [2, '2028-01-13', 776307], [3, '2028-04-12', 776307], [4, '2028-07-11', 776307],
    ]);
  });

  describe('what must be true across the modules at the end', () => {
    it('every premium Policy recorded is a charge in Billing, to the paisa (Policy and Billing agree on the money)', async () => {
      const transactions = await listTransactions(db, story.policyId);
      expect(transactions.map((t) => [t.version, t.kind])).toEqual([[1, 'new_business'], [2, 'change'], [3, 'cancellation'], [4, 'reinstatement'], [1, 'renewal']]);
      const charges = await listCharges(db, story.billingId);
      const sum = (type: 'premium' | 'tax') => charges.filter((c) => c.type === type).reduce((total, c) => total + c.amountPaise, 0);
      expect(sum('premium')).toBe(transactions.reduce((total, t) => total + t.premiumPaise, 0));
      expect(sum('tax')).toBe(transactions.reduce((total, t) => total + t.taxPaise, 0));
    });

    it('Billing asks the customer for exactly what Policy charged: the items still to be paid, less the credits, equal all the charges (a reinstated policy is billed again for what was cancelled)', async () => {
      const charges = await listCharges(db, story.billingId);
      const charged = charges.reduce((total, c) => total + c.amountPaise, 0);
      const items = (await listScheduleItems(db, story.billingId)).filter((i) => i.status !== 'void');
      const billed = items.reduce((total, i) => total + i.premiumPaise + i.taxPaise, 0);
      const credits = (await listCredits(db, story.billingId)).reduce((total, c) => total + c.totalPaise, 0);
      expect(billed - credits).toBe(charged);
    });

    it('every payment item that was billed is either paid or still waiting; nothing was invoiced twice or paid beyond its amount', async () => {
      const items = await listScheduleItems(db, story.billingId);
      const invoiced = await db.query<{ n: number }>('select count(*)::int as n from billing.invoice_line group by schedule_item_id having count(*) > 1');
      expect(invoiced.rows).toEqual([]);
      const overpaid = await db.query('select 1 from billing.invoice_line where paid_paise > amount_paise');
      expect(overpaid.rows).toEqual([]);
      for (const item of items) expect(['scheduled', 'invoiced', 'paid', 'void']).toContain(item.status);
      expect(items.filter((i) => i.kind === 'renewal').every((i) => i.status === 'scheduled')).toBe(true);
    });

    it('the claim figures add up, and the claim keeps the policy as it was on the loss date', async () => {
      const fin = await getFinancials(db, story.claimNumber);
      expect(fin.claim.incurredPaise).toBe(fin.claim.paidPaise + fin.claim.outstandingPaise - fin.claim.recoveredPaise);
      expect((await getClaim(db, story.claimNumber))?.verification.policy.version).toBe(2); // the later cancellation and reinstatement did not rewrite it
    });

    it('the vehicle is the same object in every version and term: its fixed id never changed', async () => {
      const ids = await db.query<{ fixed_id: string }>('select distinct c.fixed_id from policy.coverable c join policy.policy_period b on b.id = c.branch_id where c.kind = $1 and b.status = $2', ['Vehicle', 'bound']);
      expect(ids.rows.map((r) => r.fixed_id)).toEqual([story.vehicleFixedId]);
    });

    it('bound versions and every record of money cannot be changed, even by someone with database access', async () => {
      await expect(db.query("update policy.policy_period set period_end = period_end + 1 where status = 'bound'")).rejects.toThrow(/bound policy version/i);
      await expect(db.query('update policy.premium_transaction set premium_paise = 1, total_paise = 1 + tax_paise')).rejects.toThrow(/cannot be changed/i);
      await expect(db.query('delete from policy.quote')).rejects.toThrow(/cannot be changed/i);
      await expect(db.query('delete from billing.allocation')).rejects.toThrow(/cannot be changed/i);
      await expect(db.query('delete from claims.reserve_change')).rejects.toThrow(/cannot be changed/i);
      await expect(db.query('delete from platform.audit_log')).rejects.toThrow();
    });

    it('stored documents are exactly what was made: each checksum matches its content', async () => {
      const documents = await listDocuments(db, story.policyId);
      expect(documents.map((d) => d.kind)).toEqual(['policy_schedule', 'endorsement_schedule', 'renewal_schedule']);
      for (const summary of documents) {
        const stored = await getDocument(db, summary.id);
        expect(createHash('sha256').update(stored!.content).digest('hex')).toBe(stored!.sha256);
      }
    });

    it('every step left the events the other modules rely on, in order, and the audit log names who did what', async () => {
      const types = await eventTypes();
      for (const type of ['PolicyBound', 'PolicyIssued', 'ChargesCreated', 'PaymentReceived', 'ClaimOpened', 'ReserveChanged', 'ClaimPaymentIssued', 'DelinquencyStarted', 'CancellationRequested', 'PolicyCancelled', 'ReinstatementRequested', 'PolicyReinstated', 'PolicyRenewed']) {
        expect(types, type).toContain(type);
      }
      const actions = (await listAuditEntries(db)).map((e) => `${e.actor}:${e.action}`);
      expect(actions).toEqual(expect.arrayContaining(['agent.one:branch.quote', 'uw.one:branch.bind', 'agent.two:coverage.change', 'claims.handler:claim.fnol', 'claims.handler:payment.issue', 'billing.system:cancellation.calculated', 'cashier:payment.receive']));
    });

    it('no personal number reached the audit log or the events: not the phone number, nor the bank account', async () => {
      const everything = JSON.stringify([await listAuditEntries(db), await listEventsAfter(db, 0, 10000)]);
      expect(everything).not.toContain('9000000001');
      expect(everything).not.toContain('50100123456789');
      expect(everything).not.toContain('HDFC0001234');
    });
  });
});
