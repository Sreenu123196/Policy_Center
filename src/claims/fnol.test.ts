import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditEntries, listEventsAfter, ValidationError } from '../platform/index.js';
import { bindJob, startCancellation } from '../policy/index.js';
import type { Account } from '../policy/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { bindDeps, cancelDeps, createCustomer, issueGoldenPolicy } from '../testing/golden-policy.js';
import { loadClaimsConfig } from './config.js';
import { getClaim, listClaims, reportLoss, type LossReport } from './fnol.js';

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
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

// A collision on 1 December 2026, reported the next day, by phone.
const report = (over: Partial<LossReport> = {}): LossReport => ({
  policyNumber: 'PL-0000001',
  lossDate: '2026-12-01',
  lossTime: '18:30',
  reportedOn: '2026-12-02',
  cause: 'collision',
  place: 'Outer Ring Road, Hyderabad',
  description: 'Hit from behind at a traffic signal; rear bumper and boot damaged',
  channel: 'phone',
  reporter: { name: 'Asha Rao', phone: '9000000001' },
  incidents: [{ kind: 'damage', description: 'Rear bumper and boot lid' }],
  attachments: [{ reference: 'IMG-0001.jpg', caption: 'Rear of the car' }],
  ...over,
});
const fnol = (input: LossReport, today = '2026-12-02') => reportLoss(db, deps, input, 'agent.one', { today });

describe('loading the claims configuration (document section 15)', () => {
  it('loads the late-report limit and which cover each cause needs', () => {
    const current = config.forDate('2026-12-01');
    expect(current.late_report_days).toBe(7);
    expect(current.causes.find((c) => c.code === 'collision')?.requires_coverage).toEqual(['MOTOR_OD']);
    expect(current.causes.find((c) => c.code === 'third_party_injury')?.requires_coverage).toEqual(['MOTOR_TP']);
    expect(() => config.forDate('2026-03-31')).toThrow(/no claims configuration/i);
  });

  describe('checks the file and reports every problem together', () => {
    const base = { version: '2026.04', effective_from: '2026-04-01', late_report_days: 7, causes: [{ code: 'collision', requires_coverage: ['MOTOR_OD'] }] };
    const load = (file: unknown, name = 'claims-2026.04.json') => {
      const folder = mkdtempSync(join(tmpdir(), 'claims-'));
      writeFileSync(join(folder, name), JSON.stringify(file));
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

    it('accepts a small valid file, and refuses a repeated cause, a cause needing no cover and a wrong file name', () => {
      expect(load(base)()).toBeDefined();
      expect(problems(load({ ...base, causes: [...base.causes, ...base.causes] }))).toEqual([expect.stringMatching(/collision.*more than once/)]);
      expect(problems(load({ ...base, causes: [{ code: 'collision', requires_coverage: [] }] }))).toEqual([expect.stringMatching(/requires_coverage/)]);
      expect(problems(load(base, 'claims.json'))).toEqual([expect.stringMatching(/should be named claims-2026.04.json/)]);
    });
  });
});

describe('first notice of loss (document section 15)', () => {
  it('records the loss against the policy as it was on the loss date and checks the cover', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await fnol(report());

    expect(claim).toMatchObject({
      claimNumber: 'CL-0000001',
      policyNumber: 'PL-0000001',
      accountId: customer.id,
      lossDate: '2026-12-01',
      lossTime: '18:30',
      reportedOn: '2026-12-02',
      cause: 'collision',
      channel: 'phone',
      status: 'submitted',
      lateReport: false,
      createdBy: 'agent.one',
    });
    expect(claim.verification).toMatchObject({ status: 'verified', reasons: [], duplicates: [] });
    expect(claim.verification.policy).toMatchObject({ status: 'in_force', version: 1, termNumber: 1, productVersion: '2026.10' });
    expect(claim.verification.policy.coverages.find((c) => c.patternCode === 'MOTOR_OD')?.terms).toEqual({ idv: 50000000 });
    expect(claim.verification.policy.vehicles[0]).toMatchObject({ make: 'Maruti', registrationNumber: 'TS09XX0001' });
    expect(claim.incidents).toEqual([expect.objectContaining({ kind: 'damage', description: 'Rear bumper and boot lid' })]);
    expect(claim.attachments).toEqual([expect.objectContaining({ reference: 'IMG-0001.jpg', caption: 'Rear of the car' })]);
    expect(claim.reporter).toEqual({ name: 'Asha Rao', phone: '9000000001' });
  });

  it('keeps the policy as it was on the loss date, not as it is now: the claim is not changed by what happens to the policy later', async () => {
    const { policy } = await issueGoldenPolicy(db, customer);
    const claim = await fnol(report());
    const cancel = await startCancellation(db, cancelDeps, { policyId: policy.id, effectiveDate: '2027-01-01', reasonCode: 'customer_request' }, 'agent.two', { today: '2026-12-20' });
    await bindJob(db, bindDeps, cancel.job.id, { branchId: cancel.branch.id }, 'agent.two', { today: '2026-12-20' });
    const again = await getClaim(db, claim.id);
    expect(again?.verification.status).toBe('verified');
    expect(again?.verification.policy.status).toBe('in_force');
  });

  it('is announced with ClaimOpened, and audited, without personal numbers', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await fnol(report());
    const opened = (await listEventsAfter(db, 0, 100)).find((e) => e.type === 'ClaimOpened');
    expect(opened).toMatchObject({ aggregateType: 'claim', aggregateId: claim.id, payload: { claimNumber: 'CL-0000001', policyNumber: 'PL-0000001', lossDate: '2026-12-01', cause: 'collision', verification: 'verified' } });
    expect(JSON.stringify(opened?.payload)).not.toContain('9000000001');
    const entries = await listAuditEntries(db, { entityType: 'claim', entityId: claim.id });
    expect(entries).toEqual([expect.objectContaining({ actor: 'agent.one', action: 'claim.fnol', details: expect.objectContaining({ policyNumber: 'PL-0000001', verification: 'verified' }) })]);
    expect(JSON.stringify(entries)).not.toContain('9000000001');
  });

  it('is still recorded when the policy was not in force on the loss date, but cannot be verified', async () => {
    await issueGoldenPolicy(db, customer);
    const before = await fnol(report({ lossDate: '2026-10-10', reportedOn: '2026-10-12' }), '2026-10-12');
    expect(before.verification).toMatchObject({ status: 'not_verified', reasons: [expect.stringMatching(/no policy term covers 10-10-2026/i)] });
    const after = await fnol(report({ lossDate: '2027-10-15', reportedOn: '2027-10-16' }), '2027-10-16');
    expect(after.verification.status).toBe('not_verified');
  });

  it('cannot be verified for a cancelled policy after the cancellation date, but can before it', async () => {
    const { policy } = await issueGoldenPolicy(db, customer);
    const cancel = await startCancellation(db, cancelDeps, { policyId: policy.id, effectiveDate: '2027-01-01', reasonCode: 'customer_request' }, 'agent.two', { today: '2026-12-20' });
    await bindJob(db, bindDeps, cancel.job.id, { branchId: cancel.branch.id }, 'agent.two', { today: '2026-12-20' });
    const late = await fnol(report({ lossDate: '2027-01-05', reportedOn: '2027-01-06' }), '2027-01-06');
    expect(late.verification).toMatchObject({ status: 'not_verified', reasons: [expect.stringMatching(/cancelled from 01-01-2027/i)] });
    expect((await fnol(report({ lossDate: '2026-12-31', reportedOn: '2027-01-06' }), '2027-01-06')).verification.status).toBe('verified');
  });

  it('cannot be verified when the cover the loss needs was not on the policy: no own damage, a collision', async () => {
    await issueGoldenPolicy(db, customer, { ownDamage: false });
    const collision = await fnol(report());
    expect(collision.verification).toMatchObject({ status: 'not_verified', reasons: [expect.stringMatching(/MOTOR_OD.*not on the policy/i)] });
    const injury = await fnol(report({ cause: 'third_party_injury', lossDate: '2026-12-03', reportedOn: '2026-12-03' }), '2026-12-03');
    expect(injury.verification.status).toBe('verified'); // third-party cover is always there
  });

  it('flags a late report and a possible duplicate, but accepts them', async () => {
    await issueGoldenPolicy(db, customer);
    const first = await fnol(report());
    const duplicate = await fnol(report({ channel: 'whatsapp' }));
    expect(duplicate.verification.duplicates).toEqual([first.claimNumber]);
    expect(duplicate.verification.status).toBe('verified');

    const late = await fnol(report({ lossDate: '2026-11-01', reportedOn: '2026-11-20', cause: 'theft' }), '2026-11-20');
    expect(late.lateReport).toBe(true); // 19 days, over the limit of 7
    expect((await fnol(report({ lossDate: '2026-11-10', reportedOn: '2026-11-17', cause: 'fire' }), '2026-11-17')).lateReport).toBe(false); // exactly 7 days
  });

  it('finds the policy from the registration number when the policy number is not known', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await fnol(report({ policyNumber: undefined, registrationNumber: 'ts09 xx0001' }));
    expect(claim.policyNumber).toBe('PL-0000001');
    expect(await errorsOf(fnol(report({ policyNumber: undefined, registrationNumber: 'KA01AA0001' })))).toEqual([expect.stringMatching(/no policy.*in force.*KA01AA0001/i)]);
    expect(await errorsOf(fnol(report({ policyNumber: undefined })))).toEqual([expect.stringMatching(/policy number or the registration number/i)]);
  });

  it('refuses a report that cannot be understood, and lists every problem', async () => {
    await issueGoldenPolicy(db, customer);
    expect(await errorsOf(fnol(report({ policyNumber: 'PL-9999999' })))).toEqual([expect.stringMatching(/policy PL-9999999 does not exist/i)]);
    expect(await errorsOf(fnol(report({ lossDate: '2026-12-03', reportedOn: '2026-12-02' })))).toEqual([expect.stringMatching(/not be before the loss date/i)]);
    expect(await errorsOf(fnol(report({ reportedOn: '2026-12-09' })))).toEqual([expect.stringMatching(/in the future/i)]);
    expect(await errorsOf(fnol(report({ lossDate: '2026-02-30' })))).toEqual([expect.stringMatching(/loss date.*real date/i)]);
    expect(await errorsOf(fnol(report({ lossTime: '25:00' })))).toEqual([expect.stringMatching(/hh:mm/i)]);
    expect(await errorsOf(fnol(report({ cause: 'meteor' })))).toEqual([expect.stringMatching(/meteor.*not.*cause/i)]);
    expect(await errorsOf(fnol(report({ channel: 'carrier_pigeon' as never })))).toEqual([expect.stringMatching(/channel/i)]);
    expect(await errorsOf(fnol(report({ place: ' ', description: '' })))).toEqual([expect.stringMatching(/place/i), expect.stringMatching(/description/i)]);
    expect(await errorsOf(fnol(report({ incidents: [{ kind: 'dent' as never, description: 'x' }] })))).toEqual([expect.stringMatching(/incident kind/i)]);
    expect(await errorsOf(fnol(report({ attachments: [{ reference: ' ' }] })))).toEqual([expect.stringMatching(/attachment.*reference/i)]);
    expect(await listClaims(db, {})).toEqual([]); // nothing was saved
  });

  it('can be found again by number and listed by policy', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await fnol(report());
    expect((await getClaim(db, 'CL-0000001'))?.id).toBe(claim.id);
    expect(await getClaim(db, 'CL-9999999')).toBeNull();
    expect(await getClaim(db, 'not-an-id')).toBeNull();
    expect((await listClaims(db, { policyNumber: 'PL-0000001' })).map((c) => c.claimNumber)).toEqual(['CL-0000001']);
    expect(await listClaims(db, { policyNumber: 'PL-0000002' })).toEqual([]);
  });
});
