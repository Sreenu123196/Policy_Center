import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContact } from '../contacts/index.js';
import {
  assignRole,
  createProducerCode,
  createProducerOrganisation,
  createRole,
  createUser,
  getUserByUsername,
  listAuditEntries,
  listUnpublishedEvents,
  ValidationError,
} from '../platform/index.js';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { createAccount } from './account-repository.js';
import type { Account } from './account.js';
import { bindSubmission, getDocument, issueSubmission, listDocuments } from './bind.js';
import { addCoverable, addCoverage, getBranch, getJob } from './policy-repository.js';
import { loadProductCatalogue } from './product-catalogue.js';
import { loadRateBooks } from './rate-book.js';
import { createQuoter } from './rating.js';
import { addQuoteOption, quoteBranch, startSubmission } from './submission.js';
import { decideIssue, evaluateRules } from './underwriting.js';
import { loadUnderwritingRules } from './uw-rules.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const catalogue = loadProductCatalogue(`${configFolder}products/`);
const rules = loadUnderwritingRules(`${configFolder}underwriting/`, catalogue);
const quoter = createQuoter(loadRateBooks(`${configFolder}ratebooks/`, catalogue));
const quoteDeps = { catalogue, quoter, underwriting: { rules } };
const bindDeps = { catalogue, underwriting: { rules } };
const PRODUCT = 'MOTOR_PRIVATE_CAR';
const START = '2026-10-15';
const TODAY = '2026-10-16'; // valid until 2026-11-15

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

  await createRole(db, { code: 'senior_uw', name: 'Senior underwriter', permissions: ['uw.approve'] }, 'admin');
  await createUser(db, { username: 'senior.uw', displayName: 'Senior UW' }, 'admin');
  await assignRole(db, (await getUserByUsername(db, 'senior.uw'))!.id, 'senior_uw', 'admin');
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

// A submission whose first option is quoted: Rs 5,00,000 insured value, 1197 cc, 2 claim-free years (the golden risk of D4).
async function quotedSubmission(options: { driverBirth?: string } = {}) {
  const started = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'agent.one');
  const car = await addCoverable(
    db,
    started.branch.id,
    { kind: 'Vehicle', attributes: { make: 'Maruti', model: 'Swift', year: 2023, registrationNumber: 'TS09XX0001', engineCc: 1197, claimFreeYears: 2 } },
    'agent.one',
  );
  for (const [code, terms] of [['MOTOR_TP', {}], ['PA_OWNER_DRIVER', {}], ['MOTOR_OD', { idv: 50000000 }]] as const) {
    await addCoverage(db, started.branch.id, { coverableFixedId: car.fixedId, patternCode: code, terms }, 'agent.one');
  }
  if (options.driverBirth !== undefined) {
    await addCoverable(db, started.branch.id, { kind: 'Driver', attributes: { name: 'Test Driver', dateOfBirth: options.driverBirth } }, 'agent.one');
  }
  const quote = await quoteBranch(db, quoteDeps, started.branch.id, 'agent.one', { today: TODAY });
  return { ...started, car, quote };
}

describe('binding a submission (document section 8)', () => {
  it('turns the chosen quoted option into policy version 1, and withdraws the other options', async () => {
    const { job, branch, car } = await quotedSubmission();
    const other = await addQuoteOption(db, job.id, { copyFrom: branch.id }, 'agent.one');
    await addCoverage(db, other.id, { coverableFixedId: car.fixedId, patternCode: 'ZERO_DEP' }, 'agent.one');
    await quoteBranch(db, quoteDeps, other.id, 'agent.one', { today: TODAY });

    const bound = await bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'agent.one', { today: TODAY });
    expect(bound.job.status).toBe('bound');
    expect(bound.branch).toMatchObject({ id: branch.id, status: 'bound', version: 1 });
    expect(bound.quote.totalPaise).toBe(1858028);
    expect((await getBranch(db, other.id))?.status).toBe('withdrawn');
    expect((await getJob(db, job.id))?.status).toBe('bound');
  });

  it('walks the job through binding and records each step in the audit log, with an event for billing', async () => {
    const { policy, job, branch } = await quotedSubmission();
    await bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'agent.one', { today: TODAY });

    const forJob = await listAuditEntries(db, { entityType: 'job', entityId: job.id });
    expect(forJob.filter((e) => e.action === 'job.status').map((e) => (e.details as { to: string }).to)).toEqual(['quoted', 'binding', 'bound']);
    const forBranch = await listAuditEntries(db, { entityType: 'policy_period', entityId: branch.id });
    expect(forBranch.at(-1)).toMatchObject({ actor: 'agent.one', action: 'branch.bind', details: { version: 1 } });

    const [event] = await listUnpublishedEvents(db);
    expect(event).toMatchObject({
      type: 'PolicyBound',
      aggregateType: 'policy',
      aggregateId: policy.id,
      payload: { policyNumber: 'PL-0000001', version: 1, branchId: branch.id, premiumPaise: 1574600, taxPaise: 283428, totalPaise: 1858028 },
    });
  });

  it('makes the bound version permanent: it cannot be edited, even by raw SQL', async () => {
    const { job, branch, car } = await quotedSubmission();
    await bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'agent.one', { today: TODAY });
    expect(await errorsOf(addCoverage(db, branch.id, { coverableFixedId: car.fixedId, patternCode: 'ZERO_DEP' }, 'u'))).toEqual([expect.stringMatching(/bound policy version cannot be changed/i)]);
    await expect(db.query("update policy.coverage set terms = '{}' where branch_id = $1", [branch.id])).rejects.toThrow(/bound policy version/i);
    await expect(db.query("update policy.policy_period set status = 'draft' where id = $1", [branch.id])).rejects.toThrow(/bound policy version/i);
  });

  it('refuses a job that is not quoted, an option of another job, and an option that is not quoted', async () => {
    const draft = await startSubmission(db, catalogue, { accountId: person.id, productCode: PRODUCT, periodStart: START }, 'u');
    expect(await errorsOf(bindSubmission(db, bindDeps, draft.job.id, { branchId: draft.branch.id }, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/only a quoted job can be bound/i)]);

    const one = await quotedSubmission();
    const two = await quotedSubmission();
    expect(await errorsOf(bindSubmission(db, bindDeps, one.job.id, { branchId: two.branch.id }, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/option of this job/i)]);

    const spare = await addQuoteOption(db, one.job.id, {}, 'u'); // a new draft option sends the job back to draft
    expect(await errorsOf(bindSubmission(db, bindDeps, one.job.id, { branchId: spare.id }, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/only a quoted job can be bound/i)]);
  });

  it('refuses a quote that has expired, and accepts it on its last valid day', async () => {
    const { job, branch } = await quotedSubmission();
    expect(await errorsOf(bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'u', { today: '2026-11-16' }))).toEqual([expect.stringMatching(/quote.*expired.*15-11-2026/i)]);
    expect((await getJob(db, job.id))?.status).toBe('quoted');
    await expect(bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'u', { today: '2026-11-15' })).resolves.toBeDefined();
  });

  it('stops at an underwriting issue that blocks the bind, and binds once it is approved', async () => {
    const { job, branch } = await quotedSubmission({ driverBirth: '2007-03-01' }); // a 19-year-old driver
    expect(await errorsOf(bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'agent.one', { today: TODAY }))).toEqual([expect.stringMatching(/DRIVER_AGE.*approval/i)]);
    expect((await getJob(db, job.id))?.status).toBe('quoted');
    expect((await getBranch(db, branch.id))?.status).toBe('quoted');

    const [issue] = await evaluateRules(db, bindDeps.underwriting, branch.id, 'bind', 'agent.one', { today: TODAY });
    await decideIssue(db, bindDeps.underwriting, issue!.id, { decision: 'approved_with_conditions', reason: 'Parent named as the main driver', conditions: 'Policyholder drives the car' }, 'senior.uw', { today: TODAY });
    await expect(bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'agent.one', { today: TODAY })).resolves.toBeDefined();
  });
});

describe('issuing a policy and its schedule (document sections 8 and 11)', () => {
  it('issues a bound submission: the job is issued and a policy schedule PDF is stored with its metadata', async () => {
    const { policy, job, branch } = await quotedSubmission();
    await bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'agent.one', { today: TODAY });
    const issued = await issueSubmission(db, bindDeps, job.id, 'agent.one', { today: '2026-10-17' });

    expect(issued.job.status).toBe('issued');
    expect(issued.document).toMatchObject({
      kind: 'policy_schedule',
      contentType: 'application/pdf',
      policyId: policy.id,
      jobId: job.id,
      branchId: branch.id,
      createdBy: 'agent.one',
      metadata: { policyNumber: 'PL-0000001', jobNumber: 'J-0000001', version: 1, formCodes: [] },
    });

    const stored = await getDocument(db, issued.document.id);
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored!.content.slice(0, 5))).toBe('%PDF-');
    expect(stored!.sha256).toBe(createHash('sha256').update(stored!.content).digest('hex'));
    const pdf = await PDFDocument.load(stored!.content);
    expect(pdf.getTitle()).toBe('Policy schedule PL-0000001');

    expect((await listDocuments(db, policy.id)).map((d) => d.id)).toEqual([issued.document.id]);
  });

  it('records the issue in the audit log and sends an event', async () => {
    const { policy, job, branch } = await quotedSubmission();
    await bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'agent.one', { today: TODAY });
    const issued = await issueSubmission(db, bindDeps, job.id, 'agent.two', { today: '2026-10-17' });

    const forJob = await listAuditEntries(db, { entityType: 'job', entityId: job.id });
    expect(forJob.at(-1)).toMatchObject({ actor: 'agent.two', action: 'job.status', details: { from: 'bound', to: 'issued' } });
    const events = await listUnpublishedEvents(db);
    expect(events.map((e) => e.type)).toEqual(['PolicyBound', 'PolicyIssued']);
    expect(events[1]).toMatchObject({ aggregateId: policy.id, payload: { documentId: issued.document.id, version: 1 } });
  });

  it('refuses to issue a job that is not bound, or twice', async () => {
    const { job, branch } = await quotedSubmission();
    expect(await errorsOf(issueSubmission(db, bindDeps, job.id, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/submission job cannot move from quoted to issued/i)]);
    await bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'u', { today: TODAY });
    await issueSubmission(db, bindDeps, job.id, 'u', { today: TODAY });
    expect(await errorsOf(issueSubmission(db, bindDeps, job.id, 'u', { today: TODAY }))).toEqual([expect.stringMatching(/cannot move from issued to issued/i)]);
    expect(await db.query('select 1 from policy.document')).toMatchObject({ rows: [expect.anything()] }); // only one schedule
  });

  it('keeps an approval-with-conditions on the schedule, and a document cannot be changed or deleted', async () => {
    const { job, branch } = await quotedSubmission({ driverBirth: '2007-03-01' });
    await bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'agent.one', { today: TODAY }).catch(() => undefined);
    const [issue] = await evaluateRules(db, bindDeps.underwriting, branch.id, 'bind', 'agent.one', { today: TODAY });
    await decideIssue(db, bindDeps.underwriting, issue!.id, { decision: 'approved_with_conditions', reason: 'ok', conditions: 'Policyholder drives the car' }, 'senior.uw', { today: TODAY });
    await bindSubmission(db, bindDeps, job.id, { branchId: branch.id }, 'agent.one', { today: TODAY });
    const issued = await issueSubmission(db, bindDeps, job.id, 'agent.one', { today: TODAY });
    expect(issued.document.metadata.conditions).toEqual(['DRIVER_AGE: Policyholder drives the car']);

    await expect(db.query("update policy.document set kind = 'x'")).rejects.toThrow(/document cannot be changed/i);
    await expect(db.query('delete from policy.document')).rejects.toThrow(/document cannot be changed/i);
  });
});
