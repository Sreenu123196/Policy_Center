import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assignRole, createRole, createUser, getUserByUsername, listAuditEntries, listEventsAfter, PermissionError, ValidationError } from '../platform/index.js';
import type { Account } from '../policy/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { createCustomer, issueGoldenPolicy } from '../testing/golden-policy.js';
import { loadClaimsConfig } from './config.js';
import { addExposure, moveExposure, type Exposure } from './exposures.js';
import { getClaim, reportLoss } from './fnol.js';
import { approvePayment, getFinancials, listPayments, listReserveHistory, makePayment, recordRecovery, setReserve, type PaymentInput } from './financials.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const config = loadClaimsConfig(`${configFolder}claims/`);
const deps = { config };

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
  for (const [role, username] of [['claims_handler', 'handler.one'], ['claims_manager', 'manager.one'], ['claims_manager', 'manager.two'], ['claims_clerk', 'clerk.one']] as const) {
    if (!(await getUserByUsername(db, username))) await createUser(db, { username, displayName: username }, 'admin');
    await createRole(db, { code: role, name: role, permissions: ['claim.pay'] }, 'admin').catch(() => undefined);
    await assignRole(db, (await getUserByUsername(db, username))!.id, role, 'admin');
  }
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

// An approved own-damage exposure with a limit of Rs 5,00,000 (the insured value) on a claim for a collision.
async function approvedExposure(options: { idv?: number } = {}): Promise<{ claimNumber: string; exposure: Exposure }> {
  await issueGoldenPolicy(db, customer, options.idv === undefined ? {} : { idv: options.idv });
  const claim = await reportLoss(db, deps, {
    policyNumber: 'PL-0000001', lossDate: '2026-12-01', reportedOn: '2026-12-02', cause: 'collision', place: 'Outer Ring Road', description: 'Hit from behind', channel: 'phone',
  }, 'agent.one', { today: '2026-12-02' });
  const exposure = await addExposure(db, deps, claim.id, { coverageCode: 'MOTOR_OD', claimant: { name: 'Asha Rao', kind: 'insured' }, description: 'Damage to the car' }, 'handler.one');
  await moveExposure(db, exposure.id, 'under_review', 'handler.one');
  const approved = await moveExposure(db, exposure.id, 'approved', 'handler.one', 'Estimate checked');
  return { claimNumber: claim.claimNumber, exposure: approved };
}

const reserve = (exposureId: string, outstandingPaise: number, actor = 'handler.one', over: Partial<{ costType: 'claim_cost' | 'expense'; category: string; reason: string }> = {}) =>
  setReserve(db, deps, exposureId, { costType: 'claim_cost', category: 'repair', outstandingPaise, reason: 'Estimate from the garage', ...over }, actor);

const transfer: PaymentInput = {
  costType: 'claim_cost',
  category: 'repair',
  amountPaise: 1000000,
  kind: 'partial',
  payee: { kind: 'claimant', name: 'Asha Rao', bank: { ifsc: 'HDFC0001234', accountNumber: '50100123456789' } },
  method: 'bank_transfer',
  reference: 'PAY-1',
  paidOn: '2026-12-10',
};
const pay = (exposureId: string, over: Partial<PaymentInput> = {}, actor = 'handler.one') => makePayment(db, deps, exposureId, { ...transfer, ...over }, actor);

describe('loading the claim financial authority (document section 15)', () => {
  it('loads the limits of the claims roles and the reserve categories', () => {
    const current = config.forDate('2026-12-01');
    expect(current.reserve_categories).toEqual(expect.arrayContaining(['repair', 'total_loss', 'medical', 'legal', 'survey']));
    expect(current.authority_profiles.map((p) => [p.code, p.reserve_limit_paise, p.payment_limit_paise])).toEqual([
      ['HANDLER', 5000000, 2500000],
      ['MANAGER', 100000000, 50000000],
    ]);
  });

  describe('checks the file', () => {
    const base = {
      version: '2026.04', effective_from: '2026-04-01', late_report_days: 7, causes: [{ code: 'collision', requires_coverage: ['MOTOR_OD'] }],
      reserve_categories: ['repair'], authority_profiles: [{ code: 'HANDLER', roles: ['claims_handler'], users: [], reserve_limit_paise: 5000000, payment_limit_paise: 2500000 }],
    };
    const load = (file: unknown) => {
      const folder = mkdtempSync(join(tmpdir(), 'claims-'));
      writeFileSync(join(folder, 'claims-2026.04.json'), JSON.stringify(file));
      return () => loadClaimsConfig(folder);
    };
    const problems = (run: () => unknown): string[] => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        return (error as ValidationError).errors;
      }
      throw new Error('expected the configuration to be refused');
    };

    it('refuses a profile nobody can hold, a repeated profile, and a payment limit above the reserve limit', () => {
      expect(load(base)()).toBeDefined();
      expect(problems(load({ ...base, authority_profiles: [{ ...base.authority_profiles[0], roles: [], users: [] }] }))).toEqual([expect.stringMatching(/HANDLER.*no role and no user/)]);
      expect(problems(load({ ...base, authority_profiles: [base.authority_profiles[0], base.authority_profiles[0]] }))).toEqual([expect.stringMatching(/HANDLER.*more than once/)]);
      expect(problems(load({ ...base, authority_profiles: [{ ...base.authority_profiles[0], payment_limit_paise: 9000000 }] }))).toEqual([expect.stringMatching(/payment_limit_paise.*reserve_limit_paise/)]);
    });
  });
});

describe('reserves (document section 15)', () => {
  it('sets the outstanding reserve of a line and keeps the history of every change', async () => {
    const { exposure } = await approvedExposure();
    const line = await reserve(exposure.id, 3000000);
    expect(line).toMatchObject({ costType: 'claim_cost', category: 'repair', outstandingPaise: 3000000 });
    await reserve(exposure.id, 2000000, 'handler.one', { reason: 'Garage revised the estimate' });
    await reserve(exposure.id, 100000, 'handler.one', { costType: 'expense', category: 'survey', reason: 'Surveyor fee' });

    expect((await listReserveHistory(db, exposure.id)).map((h) => [h.costType, h.category, h.oldPaise, h.newPaise, h.changedBy, h.reason])).toEqual([
      ['claim_cost', 'repair', 0, 3000000, 'handler.one', 'Estimate from the garage'],
      ['claim_cost', 'repair', 3000000, 2000000, 'handler.one', 'Garage revised the estimate'],
      ['expense', 'survey', 0, 100000, 'handler.one', 'Surveyor fee'],
    ]);
  });

  it('announces each change with ReserveChanged: the change and the new total, nothing else', async () => {
    const { exposure } = await approvedExposure();
    await reserve(exposure.id, 3000000);
    await reserve(exposure.id, 2000000, 'handler.one', { reason: 'Revised' });
    const events = (await listEventsAfter(db, 0, 100)).filter((e) => e.type === 'ReserveChanged');
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ claimNumber: 'CL-0000001', exposureNumber: 1, costType: 'claim_cost', category: 'repair', deltaPaise: 3000000, outstandingPaise: 3000000 }),
      expect.objectContaining({ deltaPaise: -1000000, outstandingPaise: 2000000 }),
    ]);
  });

  it('is limited by financial authority: a handler up to Rs 50,000 in all, a manager up to Rs 10,00,000', async () => {
    const { exposure } = await approvedExposure();
    await expect(reserve(exposure.id, 6000000)).rejects.toBeInstanceOf(PermissionError); // Rs 60,000 is over the handler's limit
    await expect(reserve(exposure.id, 6000000, 'clerk.one')).rejects.toBeInstanceOf(PermissionError); // a clerk has no authority
    await expect(reserve(exposure.id, 6000000, 'nobody.known')).rejects.toBeInstanceOf(PermissionError);
    await expect(reserve(exposure.id, 6000000, 'manager.one')).resolves.toMatchObject({ outstandingPaise: 6000000 });
    expect((await listReserveHistory(db, exposure.id))).toHaveLength(1); // the refused ones left no trace
  });

  it('counts all lines of the exposure towards the limit', async () => {
    const { exposure } = await approvedExposure();
    await reserve(exposure.id, 4500000);
    await expect(reserve(exposure.id, 1000000, 'handler.one', { costType: 'expense', category: 'legal' })).rejects.toBeInstanceOf(PermissionError); // 4,500,000 + 1,000,000 > 5,000,000
    await expect(reserve(exposure.id, 500000, 'handler.one', { costType: 'expense', category: 'legal' })).resolves.toBeDefined();
  });

  it('refuses a bad amount, an unknown category, a missing reason, and a closed exposure', async () => {
    const { exposure } = await approvedExposure();
    expect(await errorsOf(reserve(exposure.id, -1))).toEqual([expect.stringMatching(/whole number.*not.*negative/i)]);
    expect(await errorsOf(reserve(exposure.id, 1.5))).toEqual([expect.stringMatching(/whole number/i)]);
    expect(await errorsOf(reserve(exposure.id, 100, 'handler.one', { category: 'holiday' }))).toEqual([expect.stringMatching(/category holiday/i)]);
    expect(await errorsOf(reserve(exposure.id, 100, 'handler.one', { reason: ' ' }))).toEqual([expect.stringMatching(/reason/i)]);
    expect(await errorsOf(reserve(exposure.id, 100, 'handler.one', { costType: 'fee' as never }))).toEqual([expect.stringMatching(/cost type/i)]);
    expect(await errorsOf(reserve('00000000-0000-0000-0000-000000000000', 100))).toEqual([expect.stringMatching(/exposure does not exist/i)]);
    await moveExposure(db, exposure.id, 'under_review', 'u');
    await moveExposure(db, exposure.id, 'rejected', 'u', 'Withdrawn');
    expect(await errorsOf(reserve(exposure.id, 100))).toEqual([expect.stringMatching(/rejected exposure cannot have its reserve changed/i)]);
  });
});

describe('payments (document section 15)', () => {
  it('pays part of a line within the handler\'s authority: it reduces the outstanding reserve and is announced without bank details', async () => {
    const { exposure, claimNumber } = await approvedExposure();
    await reserve(exposure.id, 3000000);
    const payment = await pay(exposure.id);

    expect(payment).toMatchObject({ amountPaise: 1000000, kind: 'partial', status: 'issued', method: 'bank_transfer', reference: 'PAY-1', requestedBy: 'handler.one', approvedBy: null, payee: { kind: 'claimant', name: 'Asha Rao', instrument: 'XXXXXXXXXX6789' } });
    const fin = await getFinancials(db, claimNumber);
    expect(fin.claim).toMatchObject({ paidPaise: 1000000, outstandingPaise: 2000000, recoveredPaise: 0, incurredPaise: 3000000 });

    const event = (await listEventsAfter(db, 0, 100)).find((e) => e.type === 'ClaimPaymentIssued');
    expect(event?.payload).toMatchObject({ claimNumber, exposureNumber: 1, amountPaise: 1000000, method: 'bank_transfer', payeeKind: 'claimant', kind: 'partial' });
    const everything = JSON.stringify([event?.payload, await listAuditEntries(db, { entityType: 'claim' }), payment]);
    expect(everything).not.toContain('50100123456789');
    expect(everything).not.toContain('HDFC0001234');
  });

  it('needs an approved exposure, a reserve to pay from, and no more than the line has left', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await reportLoss(db, deps, { policyNumber: 'PL-0000001', lossDate: '2026-12-01', reportedOn: '2026-12-02', cause: 'collision', place: 'x', description: 'y', channel: 'phone' }, 'agent.one', { today: '2026-12-02' });
    const early = await addExposure(db, deps, claim.id, { coverageCode: 'MOTOR_OD', claimant: { name: 'Asha Rao', kind: 'insured' }, description: 'd' }, 'handler.one');
    expect(await errorsOf(pay(early.id))).toEqual([expect.stringMatching(/only an approved exposure can be paid/i)]);

    const { exposure } = await (async () => {
      await moveExposure(db, early.id, 'under_review', 'u');
      return { exposure: await moveExposure(db, early.id, 'approved', 'u', 'ok') };
    })();
    expect(await errorsOf(pay(exposure.id))).toEqual([expect.stringMatching(/raise the reserve first/i)]);
    await reserve(exposure.id, 500000);
    expect(await errorsOf(pay(exposure.id, { amountPaise: 600000 }))).toEqual([expect.stringMatching(/only 500000.*outstanding.*raise the reserve/i)]);
  });

  it('sends a payment above the handler\'s limit to a manager for approval, who must be someone else with enough authority', async () => {
    const { exposure } = await approvedExposure();
    await reserve(exposure.id, 6000000, 'manager.one');
    const pending = await pay(exposure.id, { amountPaise: 3000000 }); // Rs 30,000; the handler's limit is Rs 25,000
    expect(pending).toMatchObject({ status: 'pending_approval', approvedBy: null });
    expect((await getFinancials(db, 'CL-0000001')).claim).toMatchObject({ paidPaise: 0, outstandingPaise: 6000000 }); // nothing has moved yet
    expect((await listEventsAfter(db, 0, 100)).filter((e) => e.type === 'ClaimPaymentIssued')).toEqual([]);

    await expect(approvePayment(db, deps, pending.id, 'handler.one', 'I approve my own')).rejects.toBeInstanceOf(ValidationError);
    await expect(approvePayment(db, deps, pending.id, 'clerk.one', 'ok')).rejects.toBeInstanceOf(PermissionError);
    expect(await errorsOf(approvePayment(db, deps, pending.id, 'manager.one', ' '))).toEqual([expect.stringMatching(/reason/i)]);
    const issued = await approvePayment(db, deps, pending.id, 'manager.one', 'Within the estimate');
    expect(issued).toMatchObject({ status: 'issued', approvedBy: 'manager.one', requestedBy: 'handler.one' });
    expect((await getFinancials(db, 'CL-0000001')).claim).toMatchObject({ paidPaise: 3000000, outstandingPaise: 3000000 });
    expect((await listEventsAfter(db, 0, 100)).filter((e) => e.type === 'ClaimPaymentIssued')).toHaveLength(1);
    expect(await errorsOf(approvePayment(db, deps, pending.id, 'manager.two', 'again'))).toEqual([expect.stringMatching(/not waiting for approval/i)]);
  });

  it('does not let a person approve a payment above their own limit', async () => {
    const { exposure } = await approvedExposure({ idv: 200000000 }); // insured value Rs 20,00,000
    await reserve(exposure.id, 90000000, 'manager.one');
    const pending = await pay(exposure.id, { amountPaise: 60000000 }, 'manager.one'); // above even a manager's Rs 5,00,000
    expect(pending.status).toBe('pending_approval');
    await expect(approvePayment(db, deps, pending.id, 'manager.two', 'ok')).rejects.toBeInstanceOf(PermissionError);
  });

  it('checks the payee and the payment details: the claimant\'s name, the bank account or the UPI address', async () => {
    const { exposure } = await approvedExposure();
    await reserve(exposure.id, 3000000);
    expect(await errorsOf(pay(exposure.id, { payee: { kind: 'claimant', name: 'Someone Else', bank: transfer.payee.bank } }))).toEqual([expect.stringMatching(/claimant.*Asha Rao/)]);
    expect(await errorsOf(pay(exposure.id, { payee: { kind: 'claimant', name: 'Asha Rao' } }))).toEqual([expect.stringMatching(/bank transfer.*bank details/i)]);
    expect(await errorsOf(pay(exposure.id, { payee: { kind: 'claimant', name: 'Asha Rao', bank: { ifsc: 'BAD', accountNumber: '50100123456789' } } }))).toEqual([expect.stringMatching(/IFSC/)]);
    expect(await errorsOf(pay(exposure.id, { payee: { kind: 'claimant', name: 'Asha Rao', bank: { ifsc: 'HDFC0001234', accountNumber: '12' } } }))).toEqual([expect.stringMatching(/account number/i)]);
    expect(await errorsOf(pay(exposure.id, { method: 'upi', payee: { kind: 'claimant', name: 'Asha Rao' } }))).toEqual([expect.stringMatching(/UPI.*address/i)]);
    expect(await errorsOf(pay(exposure.id, { method: 'upi', payee: { kind: 'claimant', name: 'Asha Rao', upi: 'not-an-address' } }))).toEqual([expect.stringMatching(/UPI address/i)]);
    expect(await errorsOf(pay(exposure.id, { method: 'cash' as never }))).toEqual([expect.stringMatching(/method/i)]);
    expect(await errorsOf(pay(exposure.id, { payee: { kind: 'garage', name: 'Sri Motors', bank: transfer.payee.bank } }))).toEqual([expect.stringMatching(/invoice reference/i)]);

    const upi = await pay(exposure.id, { method: 'upi', reference: 'PAY-U', payee: { kind: 'claimant', name: 'Asha Rao', upi: 'asha.rao@okbank' } });
    expect(upi.payee.instrument).toBe('as***@okbank');
    const garage = await pay(exposure.id, { reference: 'PAY-G', note: 'Invoice SM-2210', payee: { kind: 'garage', name: 'Sri Motors', bank: transfer.payee.bank } });
    expect(garage.payee).toMatchObject({ kind: 'garage', name: 'Sri Motors' });
  });

  it('is idempotent on the reference: the same payment twice is one, but a different amount with the same reference is refused', async () => {
    const { exposure } = await approvedExposure();
    await reserve(exposure.id, 3000000);
    const first = await pay(exposure.id);
    expect((await pay(exposure.id)).id).toBe(first.id);
    expect((await getFinancials(db, 'CL-0000001')).claim.paidPaise).toBe(1000000);
    expect(await errorsOf(pay(exposure.id, { amountPaise: 900000 }))).toEqual([expect.stringMatching(/reference PAY-1 was already used/i)]);
    expect((await listPayments(db, exposure.id)).map((p) => p.reference)).toEqual(['PAY-1']);
  });

  it('refuses payments beyond the limit of the cover: the insured value for own damage', async () => {
    const { exposure } = await approvedExposure({ idv: 5000000 }); // insured value Rs 50,000
    await reserve(exposure.id, 6000000, 'manager.one'); // a reserve may be above the limit; a payment may not
    await pay(exposure.id, { amountPaise: 2000000, reference: 'P-A' });
    await pay(exposure.id, { amountPaise: 2500000, reference: 'P-B' }, 'manager.one');
    expect(await errorsOf(pay(exposure.id, { amountPaise: 600000, reference: 'P-C' }, 'manager.one'))).toEqual([expect.stringMatching(/limit of the cover.*5000000.*500000 paise left/i)]);
  });

  it('with a final payment settles the exposure, releases what is left of its reserve and settles the claim; nothing more can be paid', async () => {
    const { exposure, claimNumber } = await approvedExposure();
    await reserve(exposure.id, 2500000);
    await reserve(exposure.id, 200000, 'handler.one', { costType: 'expense', category: 'survey', reason: 'Surveyor' });
    const final = await pay(exposure.id, { amountPaise: 2000000, kind: 'final' });
    expect(final.kind).toBe('final');

    const fin = await getFinancials(db, claimNumber);
    expect(fin.claim).toMatchObject({ paidPaise: 2000000, outstandingPaise: 0, incurredPaise: 2000000 }); // the 500,000 and 200,000 left are released
    expect(fin.exposures[0]).toMatchObject({ status: 'settled', paidPaise: 2000000, outstandingPaise: 0 });
    expect((await getClaim(db, claimNumber))?.status).toBe('settled');
    const history = await listReserveHistory(db, exposure.id);
    expect(history.filter((h) => h.reason?.match(/final payment/i)).map((h) => h.newPaise)).toEqual([0, 0]);
    expect(await errorsOf(pay(exposure.id, { reference: 'PAY-2' }))).toEqual([expect.stringMatching(/only an approved exposure can be paid/i)]);
  });
});

describe('recoveries and the financial view (document section 15)', () => {
  it('shows incurred = paid + outstanding reserves - recoveries, by exposure, claim and cost type', async () => {
    const { exposure, claimNumber } = await approvedExposure();
    await reserve(exposure.id, 3000000);
    await reserve(exposure.id, 100000, 'handler.one', { costType: 'expense', category: 'survey', reason: 'Surveyor fee' });
    await pay(exposure.id); // 1,000,000 of the repair
    const recovery = await recordRecovery(db, exposure.id, { kind: 'salvage', amountPaise: 200000, source: 'Scrap dealer', reference: 'SAL-1', receivedOn: '2026-12-20' }, 'handler.one');
    expect(recovery).toMatchObject({ kind: 'salvage', amountPaise: 200000, source: 'Scrap dealer', reference: 'SAL-1' });

    const fin = await getFinancials(db, claimNumber);
    // paid 1,000,000 + outstanding (2,000,000 repair + 100,000 survey) - recovered 200,000 = 2,900,000
    expect(fin.claim).toMatchObject({ paidPaise: 1000000, outstandingPaise: 2100000, recoveredPaise: 200000, incurredPaise: 2900000 });
    expect(fin.exposures).toEqual([expect.objectContaining({ number: 1, status: 'approved', paidPaise: 1000000, outstandingPaise: 2100000, recoveredPaise: 200000, incurredPaise: 2900000 })]);
    expect(fin.byCostType).toEqual({
      claim_cost: { paidPaise: 1000000, outstandingPaise: 2000000, recoveredPaise: 200000, incurredPaise: 2800000 },
      expense: { paidPaise: 0, outstandingPaise: 100000, recoveredPaise: 0, incurredPaise: 100000 },
    });
  });

  it('refuses a recovery that is bigger than what was paid, a bad kind or amount, or a repeated reference', async () => {
    const { exposure } = await approvedExposure();
    await reserve(exposure.id, 3000000);
    const input = { kind: 'subrogation' as const, amountPaise: 100, source: 'Other insurer', reference: 'SUB-1', receivedOn: '2026-12-20' };
    expect(await errorsOf(recordRecovery(db, exposure.id, input, 'u'))).toEqual([expect.stringMatching(/more than was paid.*0/i)]);
    await pay(exposure.id);
    expect(await errorsOf(recordRecovery(db, exposure.id, { ...input, amountPaise: 1000001 }, 'u'))).toEqual([expect.stringMatching(/more than was paid/i)]);
    expect(await errorsOf(recordRecovery(db, exposure.id, { ...input, kind: 'gift' as never }, 'u'))).toEqual([expect.stringMatching(/recovery kind/i)]);
    expect(await errorsOf(recordRecovery(db, exposure.id, { ...input, amountPaise: 0 }, 'u'))).toEqual([expect.stringMatching(/positive whole/i)]);
    await recordRecovery(db, exposure.id, input, 'u');
    expect(await errorsOf(recordRecovery(db, exposure.id, { ...input, amountPaise: 50 }, 'u'))).toEqual([expect.stringMatching(/reference SUB-1 was already used/i)]);
    expect((await recordRecovery(db, exposure.id, input, 'u')).amountPaise).toBe(100); // the same recovery again is the same one
  });

  it('is zero for a claim with no exposures, and refuses an unknown claim', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await reportLoss(db, deps, { policyNumber: 'PL-0000001', lossDate: '2026-12-01', reportedOn: '2026-12-02', cause: 'collision', place: 'x', description: 'y', channel: 'phone' }, 'agent.one', { today: '2026-12-02' });
    expect((await getFinancials(db, claim.claimNumber)).claim).toEqual({ paidPaise: 0, outstandingPaise: 0, recoveredPaise: 0, incurredPaise: 0 });
    expect(await errorsOf(getFinancials(db, 'CL-9999999'))).toEqual([expect.stringMatching(/claim does not exist/i)]);
  });
});
