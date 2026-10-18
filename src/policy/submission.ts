import type { PGlite } from '@electric-sql/pglite';
import { addDays, addYears, isRealDate, isUuid, recordAudit, ValidationError } from '../platform/index.js';
import { moveJob, refreshJobStatus } from './job-sync.js';
import type { Branch, Job, Policy } from './policy.js';
import { createBranch, createPolicy, getBranch, getBranchAsOf, getJob, nextOptionLabel, startJob } from './policy-repository.js';
import type { ProductCatalogue } from './product-catalogue.js';
import { validateSelection } from './product-selection.js';
import { buildRisk } from './risk.js';
import { formatDate } from './schedule.js';
import { combineSlices, cutDates, type PricedSlice } from './slice-rating.js';
import { checkUnderwriting } from './underwriting.js';
import type { Quote, QuoteDependencies, QuoteResult, WorksheetLine } from './quote.js';

// Quotes stay valid for 30 days (a business rule of this learning version).
const QUOTE_VALID_DAYS = 30;

// ---------------------------------------------------------------- starting

// Starts a new-business submission (document section 8): the policy, a submission job and its first branch for one year.
// Everything is checked first, so a refused request creates nothing.
export async function startSubmission(
  db: PGlite,
  catalogue: ProductCatalogue,
  input: { accountId: string; productCode: string; periodStart: string },
  actor: string,
): Promise<{ policy: Policy; job: Job; branch: Branch }> {
  const errors: string[] = [];
  const accountFound = isUuid(input.accountId) && (await db.query('select 1 from policy.account where id = $1', [input.accountId])).rows.length > 0;
  if (!accountFound) errors.push('The account does not exist');
  const productKnown = catalogue.latest(input.productCode) !== null;
  if (!productKnown) errors.push(`Product ${input.productCode} is not in the product catalogue`);
  if (!isRealDate(input.periodStart)) errors.push('The start date is not a real date (write it as yyyy-mm-dd)');
  else if (productKnown && catalogue.versionInForce(input.productCode, input.periodStart) === null) {
    errors.push(`No version of ${input.productCode} is in force on ${input.periodStart}`);
  }
  if (errors.length > 0) throw new ValidationError(errors);

  const policy = await createPolicy(db, catalogue, { accountId: input.accountId, productCode: input.productCode }, actor);
  const job = await startJob(db, { policyId: policy.id, type: 'submission' }, actor);
  const branch = await createBranch(db, catalogue, { jobId: job.id, periodStart: input.periodStart, periodEnd: addYears(input.periodStart, 1) }, actor);
  return { policy, job, branch };
}

// ---------------------------------------------------------------- quote options

// Adds another option (branch) to a submission, so the customer can compare prices. With copyFrom, the new option
// starts as a copy of that branch and keeps the fixed ids, so the same vehicle is still the same vehicle in both.
export async function addQuoteOption(db: PGlite, jobId: string, input: { copyFrom?: string }, actor: string): Promise<Branch> {
  const job = await getJob(db, jobId);
  if (job === null) throw new ValidationError(['The job does not exist']);
  if (job.status !== 'draft' && job.status !== 'quoted') throw new ValidationError([`Cannot add an option to a ${job.status} job`]);

  const first = (await db.query<{ id: string }>('select id from policy.policy_period where job_id = $1 order by created_at, label limit 1', [jobId])).rows[0];
  if (!first) throw new ValidationError(['The job has no branch to take the period from']);
  let source = first.id;
  if (input.copyFrom !== undefined) {
    const from = await getBranch(db, input.copyFrom);
    if (from === null || from.jobId !== jobId) throw new ValidationError(['The branch to copy must belong to the same job']);
    source = from.id;
  }

  const newId = await db.transaction(async (tx) => {
    const label = await nextOptionLabel(tx, jobId);
    const inserted = await tx.query<{ id: string }>(
      `insert into policy.policy_period (policy_id, job_id, term_number, label, period_start, period_end, product_version, created_by)
       select policy_id, job_id, term_number, $2, period_start, period_end, product_version, $3 from policy.policy_period where id = $1
       returning id`,
      [source, label, actor],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('The option was not saved');
    if (input.copyFrom !== undefined) {
      await tx.query(
        `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by)
         select $2, fixed_id, kind, eff_from, eff_to, attributes, $3 from policy.coverable where branch_id = $1 order by row_id`,
        [source, id, actor],
      );
      await tx.query(
        `insert into policy.coverage (branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by)
         select $2, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, $3 from policy.coverage where branch_id = $1 order by row_id`,
        [source, id, actor],
      );
    }
    await recordAudit(tx, {
      actor,
      action: input.copyFrom === undefined ? 'branch.create' : 'branch.copy',
      entityType: 'policy_period',
      entityId: id,
      details: input.copyFrom === undefined ? { jobId, label } : { jobId, label, copiedFrom: source },
    });
    await refreshJobStatus(tx, jobId, actor); // a new draft option means the job is not fully quoted any more
    return id;
  });
  const saved = await getBranch(db, newId);
  if (saved === null) throw new Error('The option was saved but could not be read back');
  return saved;
}

// ---------------------------------------------------------------- quoting

interface QuoteRow {
  id: string;
  branch_id: string;
  premium_paise: number;
  tax_paise: number;
  total_paise: number;
  currency: 'INR';
  valid_until: string;
  rate_book: string;
  worksheet: WorksheetLine[];
  created_by: string;
  created_at: Date;
}

// Money columns are bigint; they are read as float8, which is exact for whole numbers far beyond any premium.
const QUOTE_COLUMNS = `id, branch_id, premium_paise::float8 as premium_paise, tax_paise::float8 as tax_paise, total_paise::float8 as total_paise,
  currency, to_char(valid_until, 'YYYY-MM-DD') as valid_until, rate_book, worksheet, created_by, created_at`;

const toQuote = (row: QuoteRow): Quote => ({
  id: row.id,
  branchId: row.branch_id,
  premiumPaise: row.premium_paise,
  taxPaise: row.tax_paise,
  totalPaise: row.total_paise,
  currency: row.currency,
  validUntil: row.valid_until,
  rateBook: row.rate_book,
  worksheet: row.worksheet,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

const isMoney = (value: number): boolean => Number.isInteger(value) && value >= 0;

// Prices a draft branch (document sections 8 and 9). The branch is checked against its product version first, and
// every problem is reported together. On success the quote is stored and the branch becomes quoted; the job becomes
// quoted when all its open options are.
export async function quoteBranch(db: PGlite, deps: QuoteDependencies, branchId: string, actor: string, options: { today?: string } = {}): Promise<Quote> {
  const branch = await getBranch(db, branchId);
  if (branch === null) throw new ValidationError(['The branch does not exist']);
  if (branch.status !== 'draft') throw new ValidationError(['Only a draft branch can be quoted']);

  const policy = (await db.query<{ product_code: string; account_id: string }>('select product_code, account_id from policy.policy where id = $1', [branch.policyId])).rows[0];
  const productVersion = policy ? deps.catalogue.versionsOf(policy.product_code).find((v) => v.version === branch.productVersion) : undefined;
  if (!policy || !productVersion) throw new ValidationError([`Product version ${branch.productVersion} is not in the product catalogue`]);

  // The period is cut at every date where anything changes (document section 6); each slice is checked and priced.
  const rowDates = await db.query<{ d: string }>(
    `select to_char(d, 'YYYY-MM-DD') as d from (
       select eff_from as d from policy.coverable where branch_id = $1 union select eff_to from policy.coverable where branch_id = $1
       union select eff_from from policy.coverage where branch_id = $1 union select eff_to from policy.coverage where branch_id = $1) x`,
    [branchId],
  );
  const dates = cutDates(branch.periodStart, branch.periodEnd, rowDates.rows.map((r) => r.d));
  const many = dates.length > 2;
  const errors: string[] = [];
  const priced: PricedSlice[] = [];
  const note = (from: string, message: string): string => (many ? `From ${formatDate(from)}: ${message}` : message);
  for (let i = 0; i < dates.length - 1; i++) {
    const from = dates[i] as string;
    const to = dates[i + 1] as string;
    const asOf = await getBranchAsOf(db, branchId, from);
    if (asOf === null) throw new ValidationError(['The branch does not exist']);
    // Facts about the risk come from the branch and from the account's named insured.
    const { facts, selection, errors: problems } = await buildRisk(db, policy.account_id, asOf);
    problems.push(...validateSelection(productVersion, facts, selection));
    if (problems.length > 0) {
      errors.push(...problems.map((m) => note(from, m)));
      continue;
    }
    try {
      priced.push({ from, to, result: deps.quoter({ branch: asOf, productVersion, facts, selection }) });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      errors.push(...error.errors.map((m) => note(from, m)));
    }
  }
  if (errors.length > 0) throw new ValidationError([...new Set(errors)]);

  // Underwriting rules (document section 10): an issue that blocks the quote stops it until someone with authority approves.
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (deps.underwriting) await checkUnderwriting(db, deps.underwriting, branchId, 'quote', actor, { today });

  const result: QuoteResult = combineSlices(priced, branch.periodStart, branch.periodEnd);
  if (![result.premiumPaise, result.taxPaise].every(isMoney)) throw new ValidationError(['The rating returned an invalid price']);

  const total = result.premiumPaise + result.taxPaise;
  const quoteId = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into policy.quote (branch_id, premium_paise, tax_paise, total_paise, valid_until, rate_book, worksheet, created_by)
       values ($1, $2, $3, $4, $5::date, $6, $7::jsonb, $8) returning id`,
      [branchId, result.premiumPaise, result.taxPaise, total, addDays(today, QUOTE_VALID_DAYS), result.rateBook, JSON.stringify(result.worksheet), actor],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('The quote was not saved');
    await tx.query("update policy.policy_period set status = 'quoted' where id = $1", [branchId]);
    await recordAudit(tx, { actor, action: 'branch.quote', entityType: 'policy_period', entityId: branchId, details: { quoteId: id, totalPaise: total } });
    await refreshJobStatus(tx, branch.jobId, actor);
    return id;
  });
  const saved = await db.query<QuoteRow>(`select ${QUOTE_COLUMNS} from policy.quote where id = $1`, [quoteId]);
  const row = saved.rows[0];
  if (!row) throw new Error('The quote was saved but could not be read back');
  return toQuote(row);
}

// The newest quote of a branch, or null.
export async function getLatestQuote(db: PGlite, branchId: string): Promise<Quote | null> {
  const row = (await db.query<QuoteRow>(`select ${QUOTE_COLUMNS} from policy.quote where branch_id = $1 order by seq desc limit 1`, [branchId])).rows[0];
  return row ? toQuote(row) : null;
}

// The options of a job side by side. A branch shows its newest quote only while it is quoted; once edited, the old
// price is history and the option shows no price until it is quoted again.
export async function compareQuotes(db: PGlite, jobId: string): Promise<{ branch: Branch; quote: Quote | null }[]> {
  const ids = await db.query<{ id: string }>('select id from policy.policy_period where job_id = $1 order by label', [jobId]);
  const options: { branch: Branch; quote: Quote | null }[] = [];
  for (const { id } of ids.rows) {
    const branch = await getBranch(db, id);
    if (branch === null) continue;
    let quote: Quote | null = null;
    if (branch.status === 'quoted') {
      const row = (await db.query<QuoteRow>(`select ${QUOTE_COLUMNS} from policy.quote where branch_id = $1 order by seq desc limit 1`, [id])).rows[0];
      quote = row ? toQuote(row) : null;
    }
    options.push({ branch, quote });
  }
  return options;
}

// ---------------------------------------------------------------- ending a submission

// Moves the job to an end state and withdraws its branches, in one transaction.
async function endJob(db: PGlite, jobId: string, to: 'withdrawn' | 'declined' | 'not_taken', actor: string, reason?: string): Promise<Job> {
  await db.transaction(async (tx) => {
    await moveJob(tx, jobId, to, actor, reason);
    const open = await tx.query<{ id: string }>("select id from policy.policy_period where job_id = $1 and status in ('draft', 'quoted')", [jobId]);
    for (const { id } of open.rows) {
      await tx.query("update policy.policy_period set status = 'withdrawn' where id = $1", [id]);
      await recordAudit(tx, { actor, action: 'branch.withdraw', entityType: 'policy_period', entityId: id, details: { jobStatus: to } });
    }
  });
  const job = await getJob(db, jobId);
  if (job === null) throw new Error('The job could not be read back');
  return job;
}

// The customer or agent stops the submission.
export const withdrawJob = (db: PGlite, jobId: string, actor: string, reason?: string): Promise<Job> => endJob(db, jobId, 'withdrawn', actor, reason);

// The insurer refuses the risk. A reason is always required.
export async function declineJob(db: PGlite, jobId: string, actor: string, reason: string): Promise<Job> {
  if (reason.trim() === '') throw new ValidationError(['A reason is required to decline a submission']);
  return endJob(db, jobId, 'declined', actor, reason.trim());
}

// A quote the customer did not accept.
export const markNotTaken = (db: PGlite, jobId: string, actor: string, reason?: string): Promise<Job> => endJob(db, jobId, 'not_taken', actor, reason);
