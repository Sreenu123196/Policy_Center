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
  const errors: string[] = [];
  const policyFound = isUuid(input.policyId) && (await db.query('select 1 from policy.policy where id = $1', [input.policyId])).rows.length > 0;
  if (!policyFound) throw new ValidationError(['The policy does not exist']);

  const base = (
    await db.query<{ id: string; period_start: string; period_end: string }>(
      `select id, to_char(period_start, 'YYYY-MM-DD') as period_start, to_char(period_end, 'YYYY-MM-DD') as period_end
         from policy.policy_period where policy_id = $1 and status = 'bound' order by term_number desc, version desc limit 1`,
      [input.policyId],
    )
  ).rows[0];
  if (!base) throw new ValidationError(['The policy has no bound version to change']);

  if (!isRealDate(input.effectiveDate)) errors.push('The effective date is not a real date (write it as yyyy-mm-dd)');
  else if (input.effectiveDate < base.period_start || input.effectiveDate >= base.period_end) {
    errors.push(`The effective date must be inside the policy period (${base.period_start} to ${base.period_end})`);
  }
  if (errors.length > 0) throw new ValidationError(errors);

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
    copy: (patch: string) =>
      `insert into policy.coverage (branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by)
       select branch_id, fixed_id, coverable_fid, pattern_code, $2::date, $3::date, terms || ${patch}, $4 from policy.coverage where row_id = $1`,
    action: 'coverage',
    label: 'coverage',
  },
  coverable: {
    table: 'policy.coverable',
    data: 'attributes',
    copy: (patch: string) =>
      `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by)
       select branch_id, fixed_id, kind, $2::date, $3::date, attributes || ${patch}, $4 from policy.coverable where row_id = $1`,
    action: 'coverable',
    label: 'coverable',
  },
} as const;

interface EditInput {
  fixedId: string;
  effectiveDate?: string | undefined;
  patch: Record<string, unknown> | null; // null removes the object from the date
}

async function editFromDate(db: PGlite, kind: keyof typeof TARGETS, branchId: string, input: EditInput, actor: string): Promise<void> {
  const target = TARGETS[kind];
  const branch = await openBranch(db, branchId);
  const job = await getJob(db, branch.jobId);
  const date = input.effectiveDate ?? job?.effectiveDate ?? undefined;

  const errors: string[] = [];
  if (date === undefined) errors.push('An effective date is needed');
  else if (!isRealDate(date)) errors.push('The effective date is not a real date (write it as yyyy-mm-dd)');
  else if (date < branch.periodStart || date >= branch.periodEnd) errors.push(`The effective date must be inside the policy period (${branch.periodStart} to ${branch.periodEnd})`);
  if (input.patch !== null && Object.keys(input.patch).length === 0) errors.push('There is nothing to change');
  if (errors.length > 0 || date === undefined) throw new ValidationError(errors);

  const known = isUuid(input.fixedId) && (await db.query(`select 1 from ${target.table} where branch_id = $1 and fixed_id = $2`, [branchId, input.fixedId])).rows.length > 0;
  if (!known) throw new ValidationError([`The ${target.label} does not exist in this branch`]);
  const slices = (
    await db.query<{ row_id: number; eff_from: string; eff_to: string }>(
      `select row_id::float8 as row_id, to_char(eff_from, 'YYYY-MM-DD') as eff_from, to_char(eff_to, 'YYYY-MM-DD') as eff_to
         from ${target.table} where branch_id = $1 and fixed_id = $2 and eff_to > $3::date order by eff_from`,
      [branchId, input.fixedId, date],
    )
  ).rows;
  if (slices.length === 0) throw new ValidationError([`The ${target.label} does not exist from that date`]);

  await db.transaction(async (tx) => {
    await reopenIfQuoted(tx, branch, actor);
    for (const slice of slices) {
      const spans = slice.eff_from < date;
      if (input.patch === null) {
        if (spans) await tx.query(`update ${target.table} set eff_to = $2::date where row_id = $1`, [slice.row_id, date]);
        else await tx.query(`delete from ${target.table} where row_id = $1`, [slice.row_id]);
      } else if (spans) {
        // The part before the date stays as it was; the part from the date on becomes a new slice with the change.
        await tx.query(`update ${target.table} set eff_to = $2::date where row_id = $1`, [slice.row_id, date]);
        await tx.query(target.copy('$5::jsonb'), [slice.row_id, date, slice.eff_to, actor, JSON.stringify(input.patch)]);
      } else {
        await tx.query(`update ${target.table} set ${target.data} = ${target.data} || $2::jsonb where row_id = $1`, [slice.row_id, JSON.stringify(input.patch)]);
      }
    }
    await recordAudit(tx, {
      actor,
      action: `${target.action}.${input.patch === null ? 'remove' : 'change'}`,
      entityType: 'policy_period',
      entityId: branchId,
      details: { fixedId: input.fixedId, effectiveDate: date, ...(input.patch === null ? {} : { [target.data]: input.patch }) },
    });
  });
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
