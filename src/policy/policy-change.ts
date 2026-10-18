import type { PGlite } from '@electric-sql/pglite';
import { isRealDate, isUuid, recordAudit, ValidationError } from '../platform/index.js';
import { reopenIfQuoted } from './job-sync.js';
import type { Branch, Job } from './policy.js';
import { getBranch, getJob, openBranch } from './policy-repository.js';

// Policy change in sequence (document sections 5 and 6): a change job copies the latest bound version into a new
// branch, the user edits it from an effective date, and binding saves it as the next version.

// ---------------------------------------------------------------- starting

// Starts a mid-term change on a policy: a policy_change job and a draft branch copied from the latest bound version.
// The copy keeps every fixed id, so "the same vehicle" is the same object in both versions.
export async function startPolicyChange(db: PGlite, input: { policyId: string; effectiveDate: string }, actor: string): Promise<{ job: Job; branch: Branch }> {
  const policyFound = isUuid(input.policyId) && (await db.query('select 1 from policy.policy where id = $1', [input.policyId])).rows.length > 0;
  if (!policyFound) throw new ValidationError(['The policy does not exist']);

  if (!isRealDate(input.effectiveDate)) throw new ValidationError(['The effective date is not a real date (write it as yyyy-mm-dd)']);
  // The change is made to the term that contains the effective date (a renewed policy has more than one term).
  const base = (
    await db.query<{ id: string; period_start: string; period_end: string }>(
      `select id, to_char(period_start, 'YYYY-MM-DD') as period_start, to_char(period_end, 'YYYY-MM-DD') as period_end
         from policy.policy_period where policy_id = $1 and status = 'bound' and period_start <= $2::date and $2::date < period_end order by version desc limit 1`,
      [input.policyId, input.effectiveDate],
    )
  ).rows[0];
  if (!base) {
    const any = await db.query("select 1 from policy.policy_period where policy_id = $1 and status = 'bound'", [input.policyId]);
    throw new ValidationError([any.rows.length === 0 ? 'The policy has no bound version to change' : 'The effective date must be inside the policy period of a bound version']);
  }
  const cancelled = (await db.query<{ cancelled_on: string | null }>('select cancelled_on from policy.policy_period where id = $1', [base.id])).rows[0]?.cancelled_on;
  if (cancelled) throw new ValidationError(['The policy is cancelled; reinstate it first']);

  const ids = await db.transaction(async (tx) => {
    const job = (
      await tx.query<{ id: string }>("insert into policy.job (policy_id, type, effective_date, created_by) values ($1, 'policy_change', $2::date, $3) returning id", [
        input.policyId,
        input.effectiveDate,
        actor,
      ])
    ).rows[0];
    if (!job) throw new Error('The job was not saved');
    await recordAudit(tx, { actor, action: 'job.start', entityType: 'job', entityId: job.id, details: { type: 'policy_change', policyId: input.policyId, effectiveDate: input.effectiveDate } });

    const branch = (
      await tx.query<{ id: string }>(
        `insert into policy.policy_period (policy_id, job_id, term_number, label, based_on_id, period_start, period_end, product_version, created_by)
         select policy_id, $2, term_number, 'Option A', id, period_start, period_end, product_version, $3 from policy.policy_period where id = $1 returning id`,
        [base.id, job.id, actor],
      )
    ).rows[0];
    if (!branch) throw new Error('The branch was not saved');
    await tx.query(
      `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by)
       select $2, fixed_id, kind, eff_from, eff_to, attributes, $3 from policy.coverable where branch_id = $1 order by row_id`,
      [base.id, branch.id, actor],
    );
    await tx.query(
      `insert into policy.coverage (branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by)
       select $2, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, $3 from policy.coverage where branch_id = $1 order by row_id`,
      [base.id, branch.id, actor],
    );
    await recordAudit(tx, { actor, action: 'branch.create', entityType: 'policy_period', entityId: branch.id, details: { jobId: job.id, basedOn: base.id, effectiveDate: input.effectiveDate } });
    return { jobId: job.id, branchId: branch.id };
  });

  const job = await getJob(db, ids.jobId);
  const branch = await getBranch(db, ids.branchId);
  if (job === null || branch === null) throw new Error('The change was saved but could not be read back');
  return { job, branch };
}

// ---------------------------------------------------------------- editing from an effective date

// What an edit works on. The rows of one object are "slices": an edit from a date splits the slice that spans the date
// and changes every slice from that date to the end of the period (the window), leaving the days before untouched.
const TARGETS = {
  coverage: {
    table: 'policy.coverage',
    data: 'terms',
    copy: `insert into policy.coverage (branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by)
           select branch_id, fixed_id, coverable_fid, pattern_code, $2::date, $3::date, terms, $4 from policy.coverage where row_id = $1 returning row_id::float8 as row_id`,
  },
  coverable: {
    table: 'policy.coverable',
    data: 'attributes',
    copy: `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by)
           select branch_id, fixed_id, kind, $2::date, $3::date, attributes, $4 from policy.coverable where row_id = $1 returning row_id::float8 as row_id`,
  },
} as const;

export type ObjectKind = keyof typeof TARGETS;
export type Q = Pick<PGlite, 'query'>;

export interface EditInput {
  fixedId: string;
  effectiveDate?: string | undefined;
  patch: Record<string, unknown> | null; // null removes the object from the date
}

// The value of one field of an object on one date in one branch (null when the object or the field is absent).
async function fieldOn(q: Q, kind: ObjectKind, branchId: string, fixedId: string, field: string, date: string): Promise<unknown> {
  const { table, data } = TARGETS[kind];
  const row = (
    await q.query<{ v: unknown }>(`select ${data} -> $3::text as v from ${table} where branch_id = $1 and fixed_id = $2 and eff_from <= $4::date and $4::date < eff_to`, [branchId, fixedId, field, date])
  ).rows[0];
  return row?.v ?? null;
}

// Bound changes dated after the edit (document section 6, Appendix B): a "later change" that touched this field wins
// from its own date. It touched the field when the field has another value in that version than in the version it was based on.
async function protectedFrom(q: Q, kind: ObjectKind, branch: Branch, fixedId: string, date: string, fields: string[]): Promise<Map<string, { from: string; version: number }>> {
  const later = (
    await q.query<{ branch_id: string; based_on_id: string | null; version: number; eff: string }>(
      `select branch_id, based_on_id, version, to_char(effective_date, 'YYYY-MM-DD') as eff
         from policy.premium_transaction where policy_id = $1 and kind = 'change' and effective_date > $2::date order by effective_date, version`,
      [branch.policyId, date],
    )
  ).rows;
  const result = new Map<string, { from: string; version: number }>();
  for (const field of fields) {
    for (const change of later) {
      if (change.based_on_id === null) continue;
      const after = await fieldOn(q, kind, change.branch_id, fixedId, field, change.eff);
      const before = await fieldOn(q, kind, change.based_on_id, fixedId, field, change.eff);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        result.set(field, { from: change.eff, version: change.version });
        break;
      }
    }
  }
  return result;
}

// Applies one edit inside a transaction. Used by the public edit functions and by rebasing.
export async function applyEdit(tx: Q, branch: Branch, kind: ObjectKind, input: EditInput, actor: string): Promise<void> {
  const target = TARGETS[kind];
  const label = kind;
  const job = await getJob(tx, branch.jobId);
  // With no date given, an edit applies from the date of the job (a change) or from the start of the period (a submission).
  const date = input.effectiveDate ?? job?.effectiveDate ?? branch.periodStart;

  const errors: string[] = [];
  if (date === undefined) errors.push('An effective date is needed');
  else if (!isRealDate(date)) errors.push('The effective date is not a real date (write it as yyyy-mm-dd)');
  else if (date < branch.periodStart || date >= branch.periodEnd) errors.push(`The effective date must be inside the policy period (${branch.periodStart} to ${branch.periodEnd})`);
  if (input.patch !== null && Object.keys(input.patch).length === 0) errors.push('There is nothing to change');
  if (errors.length > 0 || date === undefined) throw new ValidationError(errors);

  const known = isUuid(input.fixedId) && (await tx.query(`select 1 from ${target.table} where branch_id = $1 and fixed_id = $2`, [branch.id, input.fixedId])).rows.length > 0;
  if (!known) throw new ValidationError([`The ${label} does not exist in this branch`]);
  const slices = (
    await tx.query<{ row_id: number; eff_from: string; eff_to: string }>(
      `select row_id::float8 as row_id, to_char(eff_from, 'YYYY-MM-DD') as eff_from, to_char(eff_to, 'YYYY-MM-DD') as eff_to
         from ${target.table} where branch_id = $1 and fixed_id = $2 and eff_to > $3::date order by eff_from`,
      [branch.id, input.fixedId, date],
    )
  ).rows;
  if (slices.length === 0) throw new ValidationError([`The ${label} does not exist from that date`]);

  await reopenIfQuoted(tx, branch, actor);
  const guarded = input.patch === null ? new Map<string, { from: string; version: number }>() : await protectedFrom(tx, kind, branch, input.fixedId, date, Object.keys(input.patch));
  const heldBack = new Set<string>(); // fields where a later change kept at least one slice

  for (const slice of slices) {
    if (input.patch === null) {
      if (slice.eff_from < date) await tx.query(`update ${target.table} set eff_to = $2::date where row_id = $1`, [slice.row_id, date]);
      else await tx.query(`delete from ${target.table} where row_id = $1`, [slice.row_id]);
      continue;
    }
    // The part before the date stays as it was; the part from the date on becomes a new slice that takes the change.
    let rowId = slice.row_id;
    let from = slice.eff_from;
    if (slice.eff_from < date) {
      await tx.query(`update ${target.table} set eff_to = $2::date where row_id = $1`, [slice.row_id, date]);
      const copy = await tx.query<{ row_id: number }>(target.copy, [slice.row_id, date, slice.eff_to, actor]);
      rowId = copy.rows[0]?.row_id ?? rowId;
      from = date;
    }
    const apply: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(input.patch)) {
      const hold = guarded.get(field);
      if (hold !== undefined && from >= hold.from) heldBack.add(field);
      else apply[field] = value;
    }
    if (Object.keys(apply).length > 0) await tx.query(`update ${target.table} set ${target.data} = ${target.data} || $2::jsonb where row_id = $1`, [rowId, JSON.stringify(apply)]);
  }

  // A conflict is recorded for each field a later change kept: the later change wins until someone decides otherwise.
  for (const field of heldBack) {
    const hold = guarded.get(field);
    if (hold === undefined || input.patch === null) continue;
    await tx.query('delete from policy.merge_conflict where branch_id = $1 and object_kind = $2 and fixed_id = $3 and field = $4 and resolution is null', [branch.id, kind, input.fixedId, field]);
    const laterValue = await fieldOn(tx, kind, branch.id, input.fixedId, field, hold.from);
    await tx.query(
      `insert into policy.merge_conflict (branch_id, object_kind, fixed_id, field, edit_date, later_version, later_date, our_value, later_value)
       values ($1, $2, $3, $4, $5::date, $6, $7::date, $8::jsonb, $9::jsonb)`,
      [branch.id, kind, input.fixedId, field, date, hold.version, hold.from, JSON.stringify(input.patch[field] ?? null), JSON.stringify(laterValue)],
    );
  }

  await recordAudit(tx, {
    actor,
    action: `${label}.${input.patch === null ? 'remove' : 'change'}`,
    entityType: 'policy_period',
    entityId: branch.id,
    details: { fixedId: input.fixedId, effectiveDate: date, ...(input.patch === null ? {} : { [target.data]: input.patch }), ...(heldBack.size > 0 ? { conflicts: [...heldBack] } : {}) },
  });
}

async function editFromDate(db: PGlite, kind: ObjectKind, branchId: string, input: EditInput, actor: string): Promise<void> {
  const branch = await openBranch(db, branchId);
  await db.transaction((tx) => applyEdit(tx, branch, kind, input, actor));
}

// Changes terms of a coverage (for example the insured value) from a date to the end of the period.
export const changeCoverage = (db: PGlite, branchId: string, input: { coverageFixedId: string; effectiveDate?: string; terms: Record<string, number | string> }, actor: string): Promise<void> =>
  editFromDate(db, 'coverage', branchId, { fixedId: input.coverageFixedId, effectiveDate: input.effectiveDate, patch: input.terms }, actor);

// Changes attributes of a coverable (for example a vehicle's registration number) from a date to the end of the period.
export const changeCoverable = (db: PGlite, branchId: string, input: { coverableFixedId: string; effectiveDate?: string; attributes: Record<string, unknown> }, actor: string): Promise<void> =>
  editFromDate(db, 'coverable', branchId, { fixedId: input.coverableFixedId, effectiveDate: input.effectiveDate, patch: input.attributes }, actor);

// Ends a coverage from a date: the days before it stay covered. To add a cover from a date, use addCoverage with effFrom.
export const removeCoverage = (db: PGlite, branchId: string, input: { coverageFixedId: string; effectiveDate?: string }, actor: string): Promise<void> =>
  editFromDate(db, 'coverage', branchId, { fixedId: input.coverageFixedId, effectiveDate: input.effectiveDate, patch: null }, actor);

// ---------------------------------------------------------------- transactions

export interface PremiumTransaction {
  id: string;
  policyId: string;
  branchId: string;
  basedOnId: string | null;
  version: number;
  kind: 'new_business' | 'change';
  effectiveDate: string;
  premiumPaise: number; // signed: a refund is negative
  taxPaise: number;
  totalPaise: number;
  createdBy: string;
}

// What each bound version changed in premium, oldest first. Billing is built from these (step F1).
export async function listTransactions(db: PGlite, policyId: string): Promise<PremiumTransaction[]> {
  if (!isUuid(policyId)) return [];
  const result = await db.query<{
    id: string;
    policy_id: string;
    branch_id: string;
    based_on_id: string | null;
    version: number;
    kind: 'new_business' | 'change';
    effective_date: string;
    premium_paise: number;
    tax_paise: number;
    total_paise: number;
    created_by: string;
  }>(
    `select id, policy_id, branch_id, based_on_id, version, kind, to_char(effective_date, 'YYYY-MM-DD') as effective_date,
            premium_paise::float8 as premium_paise, tax_paise::float8 as tax_paise, total_paise::float8 as total_paise, created_by
       from policy.premium_transaction where policy_id = $1 order by seq`,
    [policyId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    policyId: r.policy_id,
    branchId: r.branch_id,
    basedOnId: r.based_on_id,
    version: r.version,
    kind: r.kind,
    effectiveDate: r.effective_date,
    premiumPaise: r.premium_paise,
    taxPaise: r.tax_paise,
    totalPaise: r.total_paise,
    createdBy: r.created_by,
  }));
}
