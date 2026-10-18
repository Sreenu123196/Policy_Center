import type { Database } from '../platform/index.js';
import { getUserByUsername, isUuid, recordAudit, ValidationError } from '../platform/index.js';
import { getClaim, type Claim, type ClaimsDependencies } from './fnol.js';

// Exposures (document section 15): one claimant against one cover of the policy within a claim, each with its own
// status and handler. The statuses are the stages of the simulator: Submitted, Under Review, Documents Pending,
// Approved, Settled, Rejected (and Closed). The claim's own status follows from its exposures.

export const EXPOSURE_STATUSES = ['submitted', 'under_review', 'documents_pending', 'approved', 'settled', 'rejected', 'closed'] as const;
export type ExposureStatus = (typeof EXPOSURE_STATUSES)[number];
export const CLAIMANT_KINDS = ['insured', 'third_party'] as const;
export type ClaimantKind = (typeof CLAIMANT_KINDS)[number];

// The life cycle, one line per status. A move that is not here is forbidden. A rejected or closed exposure can be reopened.
const NEXT: Record<ExposureStatus, ExposureStatus[]> = {
  submitted: ['under_review', 'rejected'],
  under_review: ['documents_pending', 'approved', 'rejected'],
  documents_pending: ['under_review', 'rejected'],
  approved: ['under_review', 'settled'],
  settled: ['closed'],
  rejected: ['under_review', 'closed'],
  closed: ['under_review'],
};

export const allowedExposureMoves = (from: ExposureStatus): ExposureStatus[] => NEXT[from];

// The claim is as far along as its least finished exposure: open work comes first, then approved, then the final states.
export function deriveClaimStatus(statuses: ExposureStatus[]): Claim['status'] {
  if (statuses.length === 0) return 'submitted';
  if (statuses.some((s) => s === 'submitted' || s === 'under_review')) return 'under_review';
  if (statuses.some((s) => s === 'documents_pending')) return 'documents_pending';
  if (statuses.some((s) => s === 'approved')) return 'approved';
  if (statuses.every((s) => s === 'rejected')) return 'rejected';
  if (statuses.some((s) => s === 'settled')) return 'settled';
  return 'closed';
}

export interface Exposure {
  id: string;
  claimId: string;
  number: number; // 1, 2 ... within the claim
  coverageCode: string;
  claimant: { name: string; kind: ClaimantKind };
  description: string;
  status: ExposureStatus;
  handler: string | null;
  limitPaise: number | null; // the most that can be paid for this cover (own damage: the insured value on the loss date)
  deductiblePaise: number;
  createdBy: string;
}

interface ExposureRow {
  id: string;
  claim_id: string;
  number: number;
  coverage_code: string;
  claimant_name: string;
  claimant_kind: ClaimantKind;
  description: string;
  status: ExposureStatus;
  handler: string | null;
  limit_paise: number | null;
  deductible_paise: number;
  created_by: string;
}

export const EXPOSURE_COLUMNS = 'id, claim_id, number, coverage_code, claimant_name, claimant_kind, description, status, handler, limit_paise::float8 as limit_paise, deductible_paise::float8 as deductible_paise, created_by';

export const toExposure = (r: ExposureRow): Exposure => ({
  id: r.id,
  claimId: r.claim_id,
  number: r.number,
  coverageCode: r.coverage_code,
  claimant: { name: r.claimant_name, kind: r.claimant_kind },
  description: r.description,
  status: r.status,
  handler: r.handler,
  limitPaise: r.limit_paise,
  deductiblePaise: r.deductible_paise,
  createdBy: r.created_by,
});

export async function getExposure(db: Pick<Database, 'query'>, id: string): Promise<Exposure | null> {
  if (!isUuid(id)) return null;
  const row = (await db.query<ExposureRow>(`select ${EXPOSURE_COLUMNS} from claims.exposure where id = $1`, [id])).rows[0];
  return row ? toExposure(row) : null;
}

export async function listExposures(db: Pick<Database, 'query'>, claimIdOrNumber: string): Promise<Exposure[]> {
  const claim = await getClaim(db, claimIdOrNumber);
  if (claim === null) return [];
  const result = await db.query<ExposureRow>(`select ${EXPOSURE_COLUMNS} from claims.exposure where claim_id = $1 order by number`, [claim.id]);
  return result.rows.map(toExposure);
}

// Brings the claim's status in line with its exposures.
export async function refreshClaimStatus(tx: Pick<Database, 'query'>, claimId: string, actor: string): Promise<void> {
  const statuses = (await tx.query<{ status: ExposureStatus }>('select status from claims.exposure where claim_id = $1', [claimId])).rows.map((r) => r.status);
  const next = deriveClaimStatus(statuses);
  const current = (await tx.query<{ status: Claim['status'] }>('select status from claims.claim where id = $1', [claimId])).rows[0]?.status;
  if (current === undefined || current === next) return;
  await tx.query('update claims.claim set status = $2 where id = $1', [claimId, next]);
  await recordAudit(tx, { actor, action: 'claim.status', entityType: 'claim', entityId: claimId, details: { from: current, to: next } });
}

export interface NewExposure {
  coverageCode: string;
  claimant: { name: string; kind: ClaimantKind };
  description: string;
  overrideReason?: string; // needed when the cover was not on the policy or the claim could not be verified
}

// Adds an exposure to a claim. The cover must have been on the policy on the loss date, and the claim verified; a
// handler who knows better can add it with a reason, which goes into the audit log.
export async function addExposure(db: Database, _deps: ClaimsDependencies, claimIdOrNumber: string, input: NewExposure, actor: string): Promise<Exposure> {
  const claim = await getClaim(db, claimIdOrNumber);
  if (claim === null) throw new ValidationError(['The claim does not exist']);

  const errors: string[] = [];
  if (input.claimant.name.trim() === '') errors.push('The claimant needs a name');
  if (!CLAIMANT_KINDS.includes(input.claimant.kind)) errors.push(`Claimant kind must be one of ${CLAIMANT_KINDS.join(', ')}`);
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(input.coverageCode)) errors.push(`${input.coverageCode} is not a valid cover code`);
  if (input.description.trim() === '') errors.push('A description of the exposure is required');
  const override = (input.overrideReason ?? '').trim();
  const onPolicy = claim.verification.policy.coverages.find((c) => c.patternCode === input.coverageCode);
  if (errors.length === 0 && override === '') {
    if (claim.verification.status !== 'verified') errors.push('The claim could not be verified; give a reason for adding an exposure anyway (overrideReason)');
    else if (!onPolicy) errors.push(`${input.coverageCode} was not on the policy on the loss date; give a reason for the exception (overrideReason)`);
  }
  if (errors.length > 0) throw new ValidationError(errors);

  const limit = input.coverageCode === 'MOTOR_OD' && typeof onPolicy?.terms.idv === 'number' ? onPolicy.terms.idv : null;
  const deductible = input.coverageCode === 'MOTOR_OD' && typeof onPolicy?.terms.vol_deductible === 'number' ? onPolicy.terms.vol_deductible : 0;

  const id = await db.transaction(async (tx) => {
    const next = await tx.query<{ n: number }>('select coalesce(max(number), 0) + 1 as n from claims.exposure where claim_id = $1', [claim.id]);
    const number = Number(next.rows[0]?.n ?? 1);
    const inserted = await tx.query<{ id: string }>(
      `insert into claims.exposure (claim_id, number, coverage_code, claimant_name, claimant_kind, description, limit_paise, deductible_paise, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [claim.id, number, input.coverageCode, input.claimant.name.trim(), input.claimant.kind, input.description.trim(), limit, deductible, actor],
    );
    await recordAudit(tx, {
      actor,
      action: 'exposure.add',
      entityType: 'claim',
      entityId: claim.id,
      ...(override === '' ? {} : { reason: override }),
      details: { exposureNumber: number, coverageCode: input.coverageCode, claimantKind: input.claimant.kind },
    });
    await refreshClaimStatus(tx, claim.id, actor);
    return inserted.rows[0]?.id ?? '';
  });
  const saved = await getExposure(db, id);
  if (saved === null) throw new Error('The exposure could not be read back');
  return saved;
}

// Moves an exposure along its life cycle. Rejecting needs a reason; every move is audited and the claim follows.
export async function moveExposure(db: Database, exposureId: string, to: ExposureStatus, actor: string, reason?: string): Promise<Exposure> {
  const exposure = await getExposure(db, exposureId);
  if (exposure === null) throw new ValidationError(['The exposure does not exist']);
  if (!allowedExposureMoves(exposure.status).includes(to)) throw new ValidationError([`An exposure cannot move from ${exposure.status} to ${to}`]);
  if (to === 'rejected' && (reason ?? '').trim() === '') throw new ValidationError(['A reason is required to reject an exposure']);

  await db.transaction(async (tx) => {
    await tx.query('update claims.exposure set status = $2 where id = $1', [exposureId, to]);
    await recordAudit(tx, {
      actor,
      action: 'exposure.status',
      entityType: 'claim',
      entityId: exposure.claimId,
      ...(reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() }),
      details: { exposureNumber: exposure.number, from: exposure.status, to },
    });
    await refreshClaimStatus(tx, exposure.claimId, actor);
  });
  const saved = await getExposure(db, exposureId);
  if (saved === null) throw new Error('The exposure could not be read back');
  return saved;
}

export async function assignHandler(db: Database, exposureId: string, handler: string, actor: string): Promise<Exposure> {
  const exposure = await getExposure(db, exposureId);
  if (exposure === null) throw new ValidationError(['The exposure does not exist']);
  const user = await getUserByUsername(db, handler);
  if (user === null || user.status !== 'active') throw new ValidationError(['The handler must be an active user']);
  await db.transaction(async (tx) => {
    await tx.query('update claims.exposure set handler = $2 where id = $1', [exposureId, handler]);
    await recordAudit(tx, { actor, action: 'exposure.assign', entityType: 'claim', entityId: exposure.claimId, details: { exposureNumber: exposure.number, handler } });
  });
  return { ...exposure, handler };
}
