import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assignRole, createRole, createUser, getUserByUsername, listAuditEntries, ValidationError } from '../platform/index.js';
import type { Account } from '../policy/index.js';
import { createTestDatabase, loadTestConfiguration, resetDatabase } from '../testing/database.js';
import { createCustomer, issueGoldenPolicy } from '../testing/golden-policy.js';
import { loadClaimsConfig } from './config.js';
import { addExposure, allowedExposureMoves, assignHandler, deriveClaimStatus, EXPOSURE_STATUSES, listExposures, moveExposure, type ExposureStatus } from './exposures.js';
import { getClaim, reportLoss, type LossReport } from './fnol.js';

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
  await createRole(db, { code: 'claims_handler', name: 'Claims handler', permissions: ['claim.pay'] }, 'admin');
  await createUser(db, { username: 'handler.one', displayName: 'Handler One' }, 'admin');
  await assignRole(db, (await getUserByUsername(db, 'handler.one'))!.id, 'claims_handler', 'admin');
});

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

const lossReport = (over: Partial<LossReport> = {}): LossReport => ({
  policyNumber: 'PL-0000001',
  lossDate: '2026-12-01',
  reportedOn: '2026-12-02',
  cause: 'collision',
  place: 'Outer Ring Road, Hyderabad',
  description: 'Hit from behind at a signal',
  channel: 'phone',
  ...over,
});
const newClaim = (over: Partial<LossReport> = {}) => reportLoss(db, deps, lossReport(over), 'agent.one', { today: '2026-12-02' });
const ownDamage = { coverageCode: 'MOTOR_OD', claimant: { name: 'Asha Rao', kind: 'insured' as const }, description: 'Damage to the insured car' };

describe('exposure life cycle (document section 15: statuses of the simulator)', () => {
  const ALL = EXPOSURE_STATUSES;
  // The diagram, one line per status. Every other move is forbidden.
  const DIAGRAM: Record<ExposureStatus, ExposureStatus[]> = {
    submitted: ['under_review', 'rejected'],
    under_review: ['documents_pending', 'approved', 'rejected'],
    documents_pending: ['under_review', 'rejected'],
    approved: ['under_review', 'settled'],
    settled: ['closed'],
    rejected: ['under_review', 'closed'],
    closed: ['under_review'],
  };

  it('allows exactly the moves in the diagram, and forbids every other one', () => {
    for (const from of ALL) for (const to of ALL) expect(allowedExposureMoves(from).includes(to), `${from} -> ${to}`).toBe(DIAGRAM[from].includes(to));
  });

  it('gives the claim a status from its exposures', () => {
    const status = (...list: ExposureStatus[]) => deriveClaimStatus(list);
    expect(status()).toBe('submitted');
    expect(status('submitted')).toBe('under_review');
    expect(status('under_review', 'settled')).toBe('under_review');
    expect(status('documents_pending')).toBe('documents_pending');
    expect(status('documents_pending', 'under_review')).toBe('under_review');
    expect(status('approved', 'settled')).toBe('approved');
    expect(status('settled', 'rejected')).toBe('settled');
    expect(status('rejected', 'rejected')).toBe('rejected');
    expect(status('settled', 'closed')).toBe('settled');
    expect(status('closed', 'rejected')).toBe('closed');
  });
});

describe('exposures: one claimant against one cover (document section 15)', () => {
  it('adds an exposure to a verified claim, with the limit and deductible of the policy on the loss date', async () => {
    const { claimNumber } = await (async () => {
      await issueGoldenPolicy(db, customer);
      return newClaim();
    })();
    const exposure = await addExposure(db, deps, claimNumber, ownDamage, 'handler.one');
    expect(exposure).toMatchObject({ number: 1, coverageCode: 'MOTOR_OD', claimant: { name: 'Asha Rao', kind: 'insured' }, status: 'submitted', handler: null, limitPaise: 50000000, deductiblePaise: 0, createdBy: 'handler.one' });
    expect((await getClaim(db, claimNumber))?.status).toBe('under_review');
  });

  it('numbers the exposures of a claim 1, 2 ... and lists them', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await newClaim();
    await addExposure(db, deps, claim.id, ownDamage, 'handler.one');
    const third = await addExposure(db, deps, claim.id, { coverageCode: 'MOTOR_TP', claimant: { name: 'Ravi Kumar', kind: 'third_party' }, description: 'The car in front' }, 'handler.one');
    expect(third).toMatchObject({ number: 2, coverageCode: 'MOTOR_TP', limitPaise: null });
    expect((await listExposures(db, claim.claimNumber)).map((e) => [e.number, e.coverageCode])).toEqual([[1, 'MOTOR_OD'], [2, 'MOTOR_TP']]);
  });

  it('needs the cover to have been on the policy, unless a handler gives a reason for the exception', async () => {
    await issueGoldenPolicy(db, customer, { ownDamage: false });
    const claim = await newClaim({ cause: 'third_party_injury' });
    expect(await errorsOf(addExposure(db, deps, claim.id, ownDamage, 'handler.one'))).toEqual([expect.stringMatching(/MOTOR_OD was not on the policy.*reason/i)]);
    const exception = await addExposure(db, deps, claim.id, { ...ownDamage, overrideReason: 'Goodwill decision of the claims manager' }, 'handler.one');
    expect(exception.number).toBe(1);
    const entries = await listAuditEntries(db, { entityType: 'claim', entityId: claim.id });
    expect(entries.find((e) => e.action === 'exposure.add')).toMatchObject({ reason: 'Goodwill decision of the claims manager' });
  });

  it('also needs a reason when the claim could not be verified, even if the cover exists', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await newClaim({ lossDate: '2026-10-10', reportedOn: '2026-10-12' }); // before the policy started
    expect(claim.verification.status).toBe('not_verified');
    expect(await errorsOf(addExposure(db, deps, claim.id, ownDamage, 'handler.one'))).toEqual([expect.stringMatching(/could not be verified.*reason/i)]);
  });

  it('refuses an unknown claim, a bad claimant and an unknown cover code', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await newClaim();
    expect(await errorsOf(addExposure(db, deps, 'CL-9999999', ownDamage, 'u'))).toEqual([expect.stringMatching(/claim does not exist/i)]);
    expect(await errorsOf(addExposure(db, deps, claim.id, { ...ownDamage, claimant: { name: ' ', kind: 'insured' } }, 'u'))).toEqual([expect.stringMatching(/claimant.*name/i)]);
    expect(await errorsOf(addExposure(db, deps, claim.id, { ...ownDamage, claimant: { name: 'X', kind: 'alien' as never } }, 'u'))).toEqual([expect.stringMatching(/claimant kind/i)]);
    expect(await errorsOf(addExposure(db, deps, claim.id, { ...ownDamage, coverageCode: 'zero' }, 'u'))).toEqual([expect.stringMatching(/cover code/i)]);
    expect(await errorsOf(addExposure(db, deps, claim.id, { ...ownDamage, description: ' ' }, 'u'))).toEqual([expect.stringMatching(/description/i)]);
  });

  it('assigns a handler who is an active user', async () => {
    await issueGoldenPolicy(db, customer);
    const claim = await newClaim();
    const exposure = await addExposure(db, deps, claim.id, ownDamage, 'handler.one');
    expect((await assignHandler(db, exposure.id, 'handler.one', 'handler.one')).handler).toBe('handler.one');
    expect(await errorsOf(assignHandler(db, exposure.id, 'nobody.known', 'u'))).toEqual([expect.stringMatching(/handler.*user/i)]);
  });
});

describe('moving an exposure through its life cycle', () => {
  async function exposure() {
    await issueGoldenPolicy(db, customer);
    const claim = await newClaim();
    return { claim, exposure: await addExposure(db, deps, claim.id, ownDamage, 'handler.one') };
  }

  it('follows the diagram, records each move in the audit log, and moves the claim along with it', async () => {
    const { claim, exposure: e } = await exposure();
    await moveExposure(db, e.id, 'under_review', 'handler.one');
    await moveExposure(db, e.id, 'documents_pending', 'handler.one', 'Waiting for the repair estimate');
    expect((await getClaim(db, claim.id))?.status).toBe('documents_pending');
    await moveExposure(db, e.id, 'under_review', 'handler.one');
    const approved = await moveExposure(db, e.id, 'approved', 'handler.one', 'Estimate checked');
    expect(approved.status).toBe('approved');
    expect((await getClaim(db, claim.id))?.status).toBe('approved');

    const moves = (await listAuditEntries(db, { entityType: 'claim', entityId: claim.id })).filter((x) => x.action === 'exposure.status');
    expect(moves.map((m) => (m.details as { to: string }).to)).toEqual(['under_review', 'documents_pending', 'under_review', 'approved']);
    expect(moves[1]).toMatchObject({ actor: 'handler.one', reason: 'Waiting for the repair estimate' });
  });

  it('refuses a move that is not in the diagram, and needs a reason to reject', async () => {
    const { exposure: e } = await exposure();
    expect(await errorsOf(moveExposure(db, e.id, 'approved', 'u'))).toEqual([expect.stringMatching(/cannot move from submitted to approved/i)]);
    expect(await errorsOf(moveExposure(db, e.id, 'rejected', 'u'))).toEqual([expect.stringMatching(/reason is required to reject/i)]);
    const rejected = await moveExposure(db, e.id, 'rejected', 'u', 'Not covered: driving without a licence');
    expect(rejected.status).toBe('rejected');
    await expect(moveExposure(db, e.id, 'under_review', 'u', 'New evidence')).resolves.toMatchObject({ status: 'under_review' }); // reopened
    expect(await errorsOf(moveExposure(db, '00000000-0000-0000-0000-000000000000', 'under_review', 'u'))).toEqual([expect.stringMatching(/exposure does not exist/i)]);
  });
});
