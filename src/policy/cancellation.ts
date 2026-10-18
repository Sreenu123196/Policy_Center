import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { addDays, isActiveTypelistCode, isRealDate, isUuid, recordAudit, recordEvent, ValidationError } from '../platform/index.js';
import type { CancellationRulesCatalogue, RefundMethod } from './cancellation-rules.js';
import { moveJob } from './job-sync.js';
import type { Branch, Job } from './policy.js';
import { getBranch, getJob } from './policy-repository.js';
import type { ProductCatalogue } from './product-catalogue.js';
import type { WorksheetLine } from './quote.js';
import { computeRefund } from './refund.js';
import { formatDate, formatRupees, renderLinesPdf } from './schedule.js';
import { getLatestQuote } from './submission.js';

// Cancellation and reinstatement (document section 8). A cancellation ends the cover on an effective date in a new
// policy version and refunds the unused premium by one of three methods. A reinstatement brings the cover back,
// with or without a gap in cover.

export interface CancellationDependencies {
  catalogue: ProductCatalogue;
  cancellation: CancellationRulesCatalogue;
}

export interface CoverAdjustment {
  jobId: string;
  branchId: string;
  kind: 'cancellation' | 'reinstatement';
  reasonCode: string | null;
  source: 'insured' | 'insurer' | null;
  method: RefundMethod | null;
  effectiveDate: string;
  restoreDate: string | null; // reinstatement with a gap: the first day covered again
  termPremiumPaise: number | null;
  termTaxPaise: number | null;
  refundPremiumPaise: number | null;
  refundTaxPaise: number | null;
  retainedPremiumPaise: number | null;
  daysInForce: number | null;
  unexpiredDays: number | null;
  termDays: number | null;
}

interface AdjustmentRow {
  job_id: string;
  branch_id: string;
  kind: 'cancellation' | 'reinstatement';
  reason_code: string | null;
  source: 'insured' | 'insurer' | null;
  method: RefundMethod | null;
  effective_date: string;
  restore_date: string | null;
  term_premium_paise: number | null;
  term_tax_paise: number | null;
  refund_premium_paise: number | null;
  refund_tax_paise: number | null;
  retained_premium_paise: number | null;
  days_in_force: number | null;
  unexpired_days: number | null;
  term_days: number | null;
}

const ADJUSTMENT_COLUMNS = `job_id, branch_id, kind, reason_code, source, method, to_char(effective_date, 'YYYY-MM-DD') as effective_date,
  to_char(restore_date, 'YYYY-MM-DD') as restore_date, term_premium_paise::float8 as term_premium_paise, term_tax_paise::float8 as term_tax_paise,
  refund_premium_paise::float8 as refund_premium_paise, refund_tax_paise::float8 as refund_tax_paise, retained_premium_paise::float8 as retained_premium_paise,
  days_in_force, unexpired_days, term_days`;

const toAdjustment = (r: AdjustmentRow): CoverAdjustment => ({
  jobId: r.job_id,
  branchId: r.branch_id,
  kind: r.kind,
  reasonCode: r.reason_code,
  source: r.source,
  method: r.method,
  effectiveDate: r.effective_date,
  restoreDate: r.restore_date,
  termPremiumPaise: r.term_premium_paise,
  termTaxPaise: r.term_tax_paise,
  refundPremiumPaise: r.refund_premium_paise,
  refundTaxPaise: r.refund_tax_paise,
  retainedPremiumPaise: r.retained_premium_paise,
  daysInForce: r.days_in_force,
  unexpiredDays: r.unexpired_days,
  termDays: r.term_days,
});

export async function getAdjustment(db: Pick<PGlite, 'query'>, jobId: string): Promise<CoverAdjustment | null> {
  if (!isUuid(jobId)) return null;
  const row = (await db.query<AdjustmentRow>(`select ${ADJUSTMENT_COLUMNS} from policy.cover_adjustment where job_id = $1`, [jobId])).rows[0];
  return row ? toAdjustment(row) : null;
}

export async function getAdjustmentOfBranch(db: Pick<PGlite, 'query'>, branchId: string): Promise<CoverAdjustment | null> {
  const row = (await db.query<AdjustmentRow>(`select ${ADJUSTMENT_COLUMNS} from policy.cover_adjustment where branch_id = $1`, [branchId])).rows[0];
  return row ? toAdjustment(row) : null;
}

// Is the policy in force or cancelled, going by its newest bound version?
export async function getCoverStatus(db: PGlite, policyId: string): Promise<{ status: 'in_force' | 'cancelled' | 'none'; version: number | null; cancelledOn: string | null }> {
  const row = isUuid(policyId)
    ? (
        await db.query<{ version: number; cancelled_on: string | null }>(
          "select version, to_char(cancelled_on, 'YYYY-MM-DD') as cancelled_on from policy.policy_period where policy_id = $1 and status = 'bound' order by term_number desc, version desc limit 1",
          [policyId],
        )
      ).rows[0]
    : undefined;
  if (!row) return { status: 'none', version: null, cancelledOn: null };
  return { status: row.cancelled_on === null ? 'in_force' : 'cancelled', version: row.version, cancelledOn: row.cancelled_on };
}

// The newest bound version of a policy, with what the next job needs to know about it.
async function latestBound(db: Pick<PGlite, 'query'>, policyId: string) {
  const row = (
    await db.query<{ id: string }>("select id from policy.policy_period where policy_id = $1 and status = 'bound' order by term_number desc, version desc limit 1", [policyId])
  ).rows[0];
  return row ? getBranch(db, row.id) : null;
}

const productOf = async (db: PGlite, policyId: string): Promise<string | undefined> =>
  (await db.query<{ product_code: string }>('select product_code from policy.policy where id = $1', [policyId])).rows[0]?.product_code;

// ---------------------------------------------------------------- cancellation

// Starts a cancellation. The refund is worked out at once and kept with the job, the new version's cover ends on the
// effective date, and the job is "quoted" (the refund is the quote) until it is bound.
export async function startCancellation(
  db: PGlite,
  deps: CancellationDependencies,
  input: { policyId: string; effectiveDate: string; reasonCode: string; method?: RefundMethod },
  actor: string,
  options: { today?: string } = {},
): Promise<{ job: Job; branch: Branch; adjustment: CoverAdjustment }> {
  const policyFound = isUuid(input.policyId) && (await productOf(db, input.policyId)) !== undefined;
  if (!policyFound) throw new ValidationError(['The policy does not exist']);
  const latest = await latestBound(db, input.policyId);
  if (latest === null) throw new ValidationError(['The policy has no bound version to cancel']);
  if (latest.cancelledOn !== null) throw new ValidationError([`The policy is already cancelled from ${formatDate(latest.cancelledOn)}`]);

  const errors: string[] = [];
  if (!isRealDate(input.effectiveDate)) errors.push('The effective date is not a real date (write it as yyyy-mm-dd)');
  else if (input.effectiveDate < latest.periodStart || input.effectiveDate >= latest.periodEnd) {
    errors.push(`The effective date must be inside the policy period (${latest.periodStart} to ${latest.periodEnd})`);
  }
  const productCode = (await productOf(db, input.policyId)) ?? '';
  const rules = deps.cancellation.forVersion(productCode, latest.productVersion);
  if (rules === null) errors.push(`There are no cancellation rules for ${productCode} ${latest.productVersion}`);
  const reason = rules?.reasons.find((r) => r.code === input.reasonCode);
  if (!(await isActiveTypelistCode(db, 'cancellation_reason', input.reasonCode)) || (rules !== null && !reason)) errors.push(`${input.reasonCode} is not an active cancellation reason`);
  if (errors.length > 0 || rules === null || !reason) throw new ValidationError(errors);

  const method = input.method ?? (reason.methods[0] as RefundMethod);
  if (!reason.methods.includes(method)) throw new ValidationError([`Reason ${reason.code} allows only: ${reason.methods.join(', ')}`]);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (reason.source === 'insurer' && reason.notice_days > 0) {
    const earliest = addDays(today, reason.notice_days);
    if (input.effectiveDate < earliest) throw new ValidationError([`Cancelling for ${reason.code} needs ${reason.notice_days} days notice; the earliest effective date is ${formatDate(earliest)}`]);
  }

  const quote = await getLatestQuote(db, latest.id);
  if (quote === null) throw new ValidationError(['The policy version has no premium to refund']);
  const refund = computeRefund({
    premiumPaise: quote.premiumPaise,
    taxPaise: quote.taxPaise,
    periodStart: latest.periodStart,
    periodEnd: latest.periodEnd,
    effectiveDate: input.effectiveDate,
    method,
    rules,
  });

  const ids = await db.transaction(async (tx) => {
    const job = (
      await tx.query<{ id: string }>("insert into policy.job (policy_id, type, effective_date, created_by) values ($1, 'cancellation', $2::date, $3) returning id", [input.policyId, input.effectiveDate, actor])
    ).rows[0];
    if (!job) throw new Error('The job was not saved');
    await recordAudit(tx, { actor, action: 'job.start', entityType: 'job', entityId: job.id, details: { type: 'cancellation', policyId: input.policyId, effectiveDate: input.effectiveDate } });

    const branch = (
      await tx.query<{ id: string }>(
        `insert into policy.policy_period (policy_id, job_id, term_number, label, based_on_id, period_start, period_end, product_version, cancelled_on, created_by)
         select policy_id, $2, term_number, 'Option A', id, period_start, period_end, product_version, $3::date, $4 from policy.policy_period where id = $1 returning id`,
        [latest.id, job.id, input.effectiveDate, actor],
      )
    ).rows[0];
    if (!branch) throw new Error('The branch was not saved');
    await tx.query(
      `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by)
       select $2, fixed_id, kind, eff_from, eff_to, attributes, $3 from policy.coverable where branch_id = $1 and eff_from < $4::date order by row_id`,
      [latest.id, branch.id, actor, input.effectiveDate],
    );
    await tx.query(
      `insert into policy.coverage (branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by)
       select $2, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, $3 from policy.coverage where branch_id = $1 and eff_from < $4::date order by row_id`,
      [latest.id, branch.id, actor, input.effectiveDate],
    );
    // The cover ends on the effective date: a slice that runs past it is cut there.
    await tx.query('update policy.coverable set eff_to = $2::date where branch_id = $1 and eff_to > $2::date', [branch.id, input.effectiveDate]);
    await tx.query('update policy.coverage set eff_to = $2::date where branch_id = $1 and eff_to > $2::date', [branch.id, input.effectiveDate]);
    await tx.query("update policy.policy_period set status = 'quoted' where id = $1", [branch.id]);

    await tx.query(
      `insert into policy.cover_adjustment (job_id, branch_id, kind, reason_code, source, method, effective_date, term_premium_paise, term_tax_paise, refund_premium_paise,
                                            refund_tax_paise, retained_premium_paise, days_in_force, unexpired_days, term_days, worksheet, created_by)
       values ($1, $2, 'cancellation', $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)`,
      [
        job.id, branch.id, reason.code, reason.source, method, input.effectiveDate, quote.premiumPaise, quote.taxPaise, refund.refundPremiumPaise, refund.refundTaxPaise,
        refund.retainedPremiumPaise, refund.daysInForce, refund.unexpiredDays, refund.termDays, JSON.stringify(refund.worksheet satisfies WorksheetLine[]), actor,
      ],
    );
    await recordAudit(tx, {
      actor,
      action: 'cancellation.calculated',
      entityType: 'job',
      entityId: job.id,
      details: { reasonCode: reason.code, method, effectiveDate: input.effectiveDate, refundPremiumPaise: refund.refundPremiumPaise, refundTaxPaise: refund.refundTaxPaise },
    });
    await moveJob(tx, job.id, 'quoted', actor);
    return { jobId: job.id, branchId: branch.id };
  });

  const job = await getJob(db, ids.jobId);
  const branch = await getBranch(db, ids.branchId);
  const adjustment = await getAdjustment(db, ids.jobId);
  if (job === null || branch === null || adjustment === null) throw new Error('The cancellation could not be read back');
  return { job, branch, adjustment };
}

// Binds a cancellation: the new version is saved, the refund becomes a negative premium transaction, and a
// PolicyCancelled event goes to billing. Other open change jobs on the policy are preempted.
export async function bindCancellation(db: PGlite, job: Job, chosen: Branch, actor: string): Promise<void> {
  const adjustment = await getAdjustmentOfBranch(db, chosen.id);
  if (adjustment === null || adjustment.kind !== 'cancellation') throw new ValidationError(['The job has no cancellation to bind']);
  const latest = await latestBound(db, chosen.policyId);
  if (latest && latest.id !== chosen.basedOnId) throw new ValidationError([`Version ${latest.version} was bound after this job started`]);

  await db.transaction(async (tx) => {
    await moveJob(tx, job.id, 'binding', actor);
    const next = await tx.query<{ version: number }>('select coalesce(max(version), 0) + 1 as version from policy.policy_period where policy_id = $1 and term_number = $2', [chosen.policyId, chosen.termNumber]);
    const version = Number(next.rows[0]?.version ?? 1);
    await tx.query("update policy.policy_period set status = 'bound', version = $2 where id = $1", [chosen.id, version]);
    await recordAudit(tx, { actor, action: 'branch.bind', entityType: 'policy_period', entityId: chosen.id, details: { version, kind: 'cancellation' } });
    await moveJob(tx, job.id, 'bound', actor);
    const rivals = await tx.query<{ id: string }>("select id from policy.job where policy_id = $1 and id <> $2 and type = 'policy_change' and status in ('draft', 'quoted')", [chosen.policyId, job.id]);
    for (const rival of rivals.rows) await moveJob(tx, rival.id, 'preempted', actor, `Version ${version} was bound by job ${job.jobNumber}`);

    const refundPremium = adjustment.refundPremiumPaise ?? 0;
    const refundTax = adjustment.refundTaxPaise ?? 0;
    const transaction = { kind: 'cancellation', effectiveDate: adjustment.effectiveDate, premiumPaise: -refundPremium, taxPaise: -refundTax, totalPaise: -(refundPremium + refundTax) };
    await tx.query(
      `insert into policy.premium_transaction (policy_id, branch_id, based_on_id, version, kind, effective_date, premium_paise, tax_paise, total_paise, created_by)
       values ($1, $2, $3, $4, 'cancellation', $5::date, $6, $7, $8, $9)`,
      [chosen.policyId, chosen.id, chosen.basedOnId, version, adjustment.effectiveDate, transaction.premiumPaise, transaction.taxPaise, transaction.totalPaise, actor],
    );
    const policyNumber = (await tx.query<{ policy_number: string }>('select policy_number from policy.policy where id = $1', [chosen.policyId])).rows[0]?.policy_number;
    await recordEvent(tx, {
      type: 'PolicyCancelled',
      aggregateType: 'policy',
      aggregateId: chosen.policyId,
      payload: { policyNumber, version, branchId: chosen.id, jobId: job.id, effectiveDate: adjustment.effectiveDate, reasonCode: adjustment.reasonCode, method: adjustment.method, transaction },
    });
  });
}

// Issues the cancellation: the job is issued and a cancellation notice is stored.
export async function issueCancellation(
  db: PGlite,
  job: Job,
  actor: string,
  options: { today?: string } = {},
): Promise<{ job: Job; documentId: string }> {
  const bound = (await db.query<{ id: string }>("select id from policy.policy_period where job_id = $1 and status = 'bound'", [job.id])).rows[0];
  const branch = bound ? await getBranch(db, bound.id) : null;
  const adjustment = branch ? await getAdjustmentOfBranch(db, branch.id) : null;
  if (branch === null || adjustment === null) throw new ValidationError(['The job has no bound version to issue']);
  const policy = (await db.query<{ policy_number: string }>('select policy_number from policy.policy where id = $1', [branch.policyId])).rows[0];
  const issuedOn = options.today ?? new Date().toISOString().slice(0, 10);

  const lines = [
    'Cancellation notice',
    '',
    `Policy number: ${policy?.policy_number ?? ''}`,
    `Version: ${branch.version}`,
    `Job: ${job.jobNumber}`,
    `Issued on: ${formatDate(issuedOn)}`,
    `Cover ends on: ${formatDate(adjustment.effectiveDate)} (the last day of cover is ${formatDate(addDays(adjustment.effectiveDate, -1))})`,
    `Reason: ${adjustment.reasonCode ?? ''} (${adjustment.source ?? ''})`,
    '',
    'Refund',
    `Method: ${(adjustment.method ?? '').replace('_', ' ')}`,
    `Premium refunded: ${formatRupees(adjustment.refundPremiumPaise ?? 0)}`,
    `Tax refunded: ${formatRupees(adjustment.refundTaxPaise ?? 0)}`,
    `Total refund: ${formatRupees((adjustment.refundPremiumPaise ?? 0) + (adjustment.refundTaxPaise ?? 0))}`,
  ];
  const content = await renderLinesPdf(lines, { title: `Cancellation notice ${policy?.policy_number ?? ''}`, subject: `Policy ${policy?.policy_number ?? ''}, version ${branch.version}, job ${job.jobNumber}`, date: issuedOn, headings: ['Cancellation notice', 'Refund'] });
  const sha256 = createHash('sha256').update(content).digest('hex');
  const metadata = { policyNumber: policy?.policy_number ?? '', jobNumber: job.jobNumber, version: branch.version ?? 0, formCodes: [] as string[], conditions: [] as string[] };

  const documentId = await db.transaction(async (tx) => {
    await moveJob(tx, job.id, 'issued', actor);
    const inserted = await tx.query<{ id: string }>(
      `insert into policy.document (policy_id, job_id, branch_id, kind, content_type, content, sha256, metadata, created_by)
       values ($1, $2, $3, 'cancellation_notice', 'application/pdf', $4, $5, $6::jsonb, $7) returning id`,
      [branch.policyId, job.id, branch.id, content, sha256, JSON.stringify(metadata), actor],
    );
    const id = inserted.rows[0]?.id ?? '';
    await recordAudit(tx, { actor, action: 'document.create', entityType: 'policy', entityId: branch.policyId, details: { documentId: id, kind: 'cancellation_notice', version: branch.version } });
    return id;
  });
  const saved = await getJob(db, job.id);
  if (saved === null) throw new Error('The issued job could not be read back');
  return { job: saved, documentId };
}

// ---------------------------------------------------------------- reinstatement

// Starts a reinstatement of a cancelled policy. The new draft version is a copy of the version before the
// cancellation. With a gap, the days from the cancellation date to the reinstatement date stay uncovered. The job is
// then quoted like any other (so underwriting and rating apply) and bound; its transaction is the new premium less
// the part of the premium the insurer kept at cancellation.
export async function startReinstatement(
  db: PGlite,
  deps: CancellationDependencies,
  input: { policyId: string; withGap: boolean; reinstatementDate?: string },
  actor: string,
  options: { today?: string } = {},
): Promise<{ job: Job; branch: Branch }> {
  if (!isUuid(input.policyId) || (await productOf(db, input.policyId)) === undefined) throw new ValidationError(['The policy does not exist']);
  const cancelled = await latestBound(db, input.policyId);
  if (cancelled === null || cancelled.cancelledOn === null) throw new ValidationError(['The policy is not cancelled']);
  const cancelledOn = cancelled.cancelledOn;
  const before = cancelled.basedOnId === null ? null : await getBranch(db, cancelled.basedOnId);
  if (before === null) throw new ValidationError(['The version before the cancellation could not be found']);

  const productCode = (await productOf(db, input.policyId)) ?? '';
  const rules = deps.cancellation.forVersion(productCode, cancelled.productVersion);
  if (rules === null) throw new ValidationError([`There are no cancellation rules for ${productCode} ${cancelled.productVersion}`]);

  const errors: string[] = [];
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const lastDay = addDays(cancelledOn, rules.reinstatement_window_days);
  if (today > lastDay) errors.push(`A policy can be reinstated only within ${rules.reinstatement_window_days} days of the cancellation date (${formatDate(cancelledOn)})`);
  const date = input.reinstatementDate;
  if (input.withGap) {
    if (date === undefined) errors.push('A reinstatement date is needed when there is a gap in cover');
    else if (!isRealDate(date)) errors.push('The reinstatement date is not a real date (write it as yyyy-mm-dd)');
    else if (date <= cancelledOn) errors.push(`The reinstatement date must be after the cancellation date (${formatDate(cancelledOn)})`);
    else if (date >= cancelled.periodEnd) errors.push('The reinstatement date must be before the end of the policy period');
  } else if (date !== undefined) errors.push('A reinstatement date is used only with a gap in cover');
  if (errors.length > 0) throw new ValidationError(errors);
  const restore = input.withGap ? (date as string) : null;

  const ids = await db.transaction(async (tx) => {
    const job = (
      await tx.query<{ id: string }>("insert into policy.job (policy_id, type, effective_date, created_by) values ($1, 'reinstatement', $2::date, $3) returning id", [input.policyId, cancelledOn, actor])
    ).rows[0];
    if (!job) throw new Error('The job was not saved');
    await recordAudit(tx, { actor, action: 'job.start', entityType: 'job', entityId: job.id, details: { type: 'reinstatement', policyId: input.policyId, effectiveDate: cancelledOn, withGap: input.withGap } });
    const branch = (
      await tx.query<{ id: string }>(
        `insert into policy.policy_period (policy_id, job_id, term_number, label, based_on_id, period_start, period_end, product_version, created_by)
         select policy_id, $2, term_number, 'Option A', $3, period_start, period_end, product_version, $4 from policy.policy_period where id = $1 returning id`,
        [before.id, job.id, cancelled.id, actor],
      )
    ).rows[0];
    if (!branch) throw new Error('The branch was not saved');
    await tx.query(
      `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by)
       select $2, fixed_id, kind, eff_from, eff_to, attributes, $3 from policy.coverable where branch_id = $1 order by row_id`,
      [before.id, branch.id, actor],
    );
    await tx.query(
      `insert into policy.coverage (branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by)
       select $2, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, $3 from policy.coverage where branch_id = $1 order by row_id`,
      [before.id, branch.id, actor],
    );
    if (restore !== null) {
      // Cut the gap [cancelledOn, restore) out of every slice: a slice that spans the gap becomes two.
      for (const [table, columns] of [
        ['policy.coverable', 'branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by'],
        ['policy.coverage', 'branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by'],
      ] as const) {
        const spanning = await tx.query<{ row_id: number; eff_to: string }>(
          `select row_id::float8 as row_id, to_char(eff_to, 'YYYY-MM-DD') as eff_to from ${table} where branch_id = $1 and eff_from < $2::date and eff_to > $3::date`,
          [branch.id, cancelledOn, restore],
        );
        for (const row of spanning.rows) {
          await tx.query(`update ${table} set eff_to = $2::date where row_id = $1`, [row.row_id, cancelledOn]);
          await tx.query(
            `insert into ${table} (${columns}) select ${columns.replace('eff_from', '$2::date').replace('eff_to', '$3::date')} from ${table} where row_id = $1`,
            [row.row_id, restore, row.eff_to],
          );
        }
        await tx.query(`update ${table} set eff_to = $2::date where branch_id = $1 and eff_from < $2::date and eff_to > $2::date and eff_to <= $3::date`, [branch.id, cancelledOn, restore]);
        await tx.query(`update ${table} set eff_from = $3::date where branch_id = $1 and eff_from >= $2::date and eff_from < $3::date and eff_to > $3::date`, [branch.id, cancelledOn, restore]);
        await tx.query(`delete from ${table} where branch_id = $1 and eff_from >= $2::date and eff_to <= $3::date`, [branch.id, cancelledOn, restore]);
      }
    }
    await tx.query(
      `insert into policy.cover_adjustment (job_id, branch_id, kind, effective_date, restore_date, created_by) values ($1, $2, 'reinstatement', $3::date, $4::date, $5)`,
      [job.id, branch.id, cancelledOn, restore, actor],
    );
    await recordAudit(tx, { actor, action: 'branch.create', entityType: 'policy_period', entityId: branch.id, details: { jobId: job.id, basedOn: cancelled.id, copiedFrom: before.id, restoreDate: restore } });
    return { jobId: job.id, branchId: branch.id };
  });

  const job = await getJob(db, ids.jobId);
  const branch = await getBranch(db, ids.branchId);
  if (job === null || branch === null) throw new Error('The reinstatement could not be read back');
  return { job, branch };
}
