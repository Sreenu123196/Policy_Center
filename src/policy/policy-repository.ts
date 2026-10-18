import { randomUUID } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { canSeeProducerCode, isRealDate, isUuid, recordAudit, ValidationError, type Visibility } from '../platform/index.js';
import {
  COVERABLE_KINDS,
  JOB_TYPES,
  type Branch,
  type BranchAsOf,
  type BranchStatus,
  type CoverableKind,
  type CoverableSlice,
  type CoverageSlice,
  type Job,
  type JobStatus,
  type JobType,
  type Policy,
} from './policy.js';
import { reopenIfQuoted } from './job-sync.js';
import type { ProductCatalogue } from './product-catalogue.js';

// ---------------------------------------------------------------- reading

interface PolicyRow {
  id: string;
  policy_number: string;
  account_id: string;
  product_code: string;
  created_by: string;
  created_at: Date;
}

interface JobRow {
  id: string;
  job_number: string;
  policy_id: string;
  type: JobType;
  status: JobStatus;
  effective_date: string | null;
  created_by: string;
  created_at: Date;
}

interface BranchRow {
  id: string;
  policy_id: string;
  job_id: string;
  term_number: number;
  label: string;
  version: number | null;
  based_on_id: string | null;
  status: BranchStatus;
  period_start: string;
  period_end: string;
  product_version: string;
  created_by: string;
  created_at: Date;
}

const POLICY_COLUMNS = 'id, policy_number, account_id, product_code, created_by, created_at';
const JOB_COLUMNS = "id, job_number, policy_id, type, status, to_char(effective_date, 'YYYY-MM-DD') as effective_date, created_by, created_at";
// Dates are read as text (yyyy-mm-dd), so a time zone can never shift a date by a day.
const BRANCH_COLUMNS = `id, policy_id, job_id, term_number, label, version, based_on_id, status,
  to_char(period_start, 'YYYY-MM-DD') as period_start, to_char(period_end, 'YYYY-MM-DD') as period_end,
  product_version, created_by, created_at`;

const toPolicy = (row: PolicyRow): Policy => ({
  id: row.id,
  policyNumber: row.policy_number,
  accountId: row.account_id,
  productCode: row.product_code,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

const toJob = (row: JobRow): Job => ({
  id: row.id,
  jobNumber: row.job_number,
  policyId: row.policy_id,
  type: row.type,
  status: row.status,
  effectiveDate: row.effective_date,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

const toBranch = (row: BranchRow): Branch => ({
  id: row.id,
  policyId: row.policy_id,
  jobId: row.job_id,
  termNumber: row.term_number,
  label: row.label,
  version: row.version,
  basedOnId: row.based_on_id,
  status: row.status,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  productVersion: row.product_version,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

// Producer code security (document section 13): a policy the viewer may not see is reported as "not found".
export async function getPolicy(db: PGlite, id: string, visibility: Visibility): Promise<Policy | null> {
  if (!isUuid(id)) return null;
  const result = await db.query<PolicyRow & { producer_code: string }>(
    `select p.id, p.policy_number, p.account_id, p.product_code, p.created_by, p.created_at, a.producer_code
       from policy.policy p join policy.account a on a.id = p.account_id
      where p.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row && canSeeProducerCode(visibility, row.producer_code) ? toPolicy(row) : null;
}

export async function getJob(db: PGlite, id: string): Promise<Job | null> {
  if (!isUuid(id)) return null;
  const result = await db.query<JobRow>(`select ${JOB_COLUMNS} from policy.job where id = $1`, [id]);
  const row = result.rows[0];
  return row ? toJob(row) : null;
}

export async function getBranch(db: PGlite, id: string): Promise<Branch | null> {
  if (!isUuid(id)) return null;
  const result = await db.query<BranchRow>(`select ${BRANCH_COLUMNS} from policy.policy_period where id = $1`, [id]);
  const row = result.rows[0];
  return row ? toBranch(row) : null;
}

const exists = async (db: PGlite, table: 'account' | 'policy' | 'job', id: string): Promise<boolean> =>
  isUuid(id) && (await db.query(`select 1 from policy.${table} where id = $1`, [id])).rows.length > 0;

// The next free option name in a job: Option A, Option B ... (a job rarely has more than a few).
export async function nextOptionLabel(db: Pick<Transaction, 'query'>, jobId: string): Promise<string> {
  const counted = await db.query<{ n: number }>('select count(*)::int as n from policy.policy_period where job_id = $1', [jobId]);
  return `Option ${String.fromCharCode(65 + (counted.rows[0]?.n ?? 0))}`;
}

// ---------------------------------------------------------------- policy, job, branch

// Creates the contract. The number is given once and never changes.
export async function createPolicy(db: PGlite, catalogue: ProductCatalogue, input: { accountId: string; productCode: string }, actor: string): Promise<Policy> {
  const errors: string[] = [];
  if (!(await exists(db, 'account', input.accountId))) errors.push('The account does not exist');
  if (catalogue.latest(input.productCode) === null) errors.push(`Product ${input.productCode} is not in the product catalogue`);
  if (errors.length > 0) throw new ValidationError(errors);

  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>('insert into policy.policy (account_id, product_code, created_by) values ($1, $2, $3) returning id', [
      input.accountId,
      input.productCode,
      actor,
    ]);
    const newId = inserted.rows[0]?.id;
    if (newId === undefined) throw new Error('The policy was not saved');
    await recordAudit(tx, { actor, action: 'policy.create', entityType: 'policy', entityId: newId, details: { productCode: input.productCode, accountId: input.accountId } });
    return newId;
  });
  const saved = await db.query<PolicyRow>(`select ${POLICY_COLUMNS} from policy.policy where id = $1`, [id]);
  const row = saved.rows[0];
  if (!row) throw new Error('The policy was saved but could not be read back');
  return toPolicy(row);
}

// Starts a unit of work on a policy. It begins as a draft.
export async function startJob(db: PGlite, input: { policyId: string; type: JobType }, actor: string): Promise<Job> {
  const errors: string[] = [];
  if (!(await exists(db, 'policy', input.policyId))) errors.push('The policy does not exist');
  if (!JOB_TYPES.includes(input.type)) errors.push(`Job type must be one of ${JOB_TYPES.join(', ')}`);
  if (errors.length > 0) throw new ValidationError(errors);

  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>('insert into policy.job (policy_id, type, created_by) values ($1, $2, $3) returning id', [
      input.policyId,
      input.type,
      actor,
    ]);
    const newId = inserted.rows[0]?.id;
    if (newId === undefined) throw new Error('The job was not saved');
    await recordAudit(tx, { actor, action: 'job.start', entityType: 'job', entityId: newId, details: { type: input.type, policyId: input.policyId } });
    return newId;
  });
  const saved = await db.query<JobRow>(`select ${JOB_COLUMNS} from policy.job where id = $1`, [id]);
  const row = saved.rows[0];
  if (!row) throw new Error('The job was saved but could not be read back');
  return toJob(row);
}

// Creates a working copy of one term inside a job. New business uses the product version in force on the start date,
// and the branch records which one it was.
export async function createBranch(
  db: PGlite,
  catalogue: ProductCatalogue,
  input: { jobId: string; periodStart: string; periodEnd: string; termNumber?: number },
  actor: string,
): Promise<Branch> {
  const errors: string[] = [];

  const startOk = isRealDate(input.periodStart);
  const endOk = isRealDate(input.periodEnd);
  if (!startOk) errors.push('The start date is not a real date (write it as yyyy-mm-dd)');
  if (!endOk) errors.push('The end date is not a real date (write it as yyyy-mm-dd)');
  if (startOk && endOk && input.periodEnd <= input.periodStart) errors.push('The end date must be after the start date');

  const job = isUuid(input.jobId)
    ? (await db.query<{ policy_id: string; product_code: string }>(
        'select j.policy_id, p.product_code from policy.job j join policy.policy p on p.id = j.policy_id where j.id = $1',
        [input.jobId],
      )).rows[0]
    : undefined;
  if (!job) errors.push('The job does not exist');

  let productVersion: string | undefined;
  if (job && startOk) {
    productVersion = catalogue.versionInForce(job.product_code, input.periodStart)?.version;
    if (productVersion === undefined) errors.push(`No version of ${job.product_code} is in force on ${input.periodStart}`);
  }
  if (errors.length > 0 || !job || productVersion === undefined) throw new ValidationError(errors);

  const id = await db.transaction(async (tx) => {
    const label = await nextOptionLabel(tx, input.jobId);
    const inserted = await tx.query<{ id: string }>(
      `insert into policy.policy_period (policy_id, job_id, term_number, label, period_start, period_end, product_version, created_by)
       values ($1, $2, $3, $4, $5::date, $6::date, $7, $8) returning id`,
      [job.policy_id, input.jobId, input.termNumber ?? 1, label, input.periodStart, input.periodEnd, productVersion, actor],
    );
    const newId = inserted.rows[0]?.id;
    if (newId === undefined) throw new Error('The branch was not saved');
    await recordAudit(tx, {
      actor,
      action: 'branch.create',
      entityType: 'policy_period',
      entityId: newId,
      details: { jobId: input.jobId, periodStart: input.periodStart, periodEnd: input.periodEnd, productVersion },
    });
    return newId;
  });
  const saved = await getBranch(db, id);
  if (saved === null) throw new Error('The branch was saved but could not be read back');
  return saved;
}

// ---------------------------------------------------------------- effective-dated rows

// The branch must exist and still be open for editing. A bound version is never edited (document section 5).
export async function openBranch(db: PGlite, branchId: string): Promise<Branch> {
  const branch = await getBranch(db, branchId);
  if (branch === null) throw new ValidationError(['The branch does not exist']);
  if (branch.status === 'bound') throw new ValidationError(['A bound policy version cannot be changed']);
  if (branch.status === 'withdrawn') throw new ValidationError(['A withdrawn branch cannot be changed']);
  return branch;
}

// Works out the dates of a new slice. By default it covers the whole period.
function sliceDates(branch: Branch, effFrom: string | undefined, effTo: string | undefined): { from: string; to: string; errors: string[] } {
  const from = effFrom ?? branch.periodStart;
  const to = effTo ?? branch.periodEnd;
  const errors: string[] = [];
  if (!isRealDate(from)) errors.push('The from date is not a real date (write it as yyyy-mm-dd)');
  if (!isRealDate(to)) errors.push('The to date is not a real date (write it as yyyy-mm-dd)');
  if (errors.length === 0) {
    if (from >= to) errors.push('The from date must be before the to date');
    else if (from < branch.periodStart || to > branch.periodEnd) {
      errors.push(`The dates must lie inside the policy period (${branch.periodStart} to ${branch.periodEnd})`);
    }
  }
  return { from, to, errors };
}

// The database refuses overlapping slices on its own; this turns its error into a clear message if two requests race.
const isOverlapRefusal = (error: unknown): boolean => error instanceof Error && /exclusion constraint/i.test(error.message);

export interface NewCoverable {
  kind: CoverableKind;
  attributes?: Record<string, unknown>;
  effFrom?: string; // default: the start of the period
  effTo?: string; // default: the end of the period (exclusive)
  fixedId?: string; // give the fixed id of an existing object to add another slice of it
}

// Adds a thing insured (a vehicle, a driver ...) over a range of dates, or another slice of an existing one.
export async function addCoverable(db: PGlite, branchId: string, input: NewCoverable, actor: string): Promise<CoverableSlice> {
  const branch = await openBranch(db, branchId);
  const errors: string[] = [];

  if (!COVERABLE_KINDS.includes(input.kind)) errors.push(`Kind must be one of ${COVERABLE_KINDS.join(', ')}`);
  const dates = sliceDates(branch, input.effFrom, input.effTo);
  errors.push(...dates.errors);
  if (input.fixedId !== undefined && !isUuid(input.fixedId)) errors.push('The fixed id is not valid');
  if (errors.length > 0) throw new ValidationError(errors);

  const fixedId = input.fixedId ?? randomUUID();
  if (input.fixedId !== undefined) {
    const existing = await db.query<{ kind: string }>('select kind from policy.coverable where branch_id = $1 and fixed_id = $2 limit 1', [branchId, fixedId]);
    if (existing.rows[0] && existing.rows[0].kind !== input.kind) throw new ValidationError(['A slice must be the same kind as the object it belongs to']);
    const overlapping = await db.query(
      'select 1 from policy.coverable where branch_id = $1 and fixed_id = $2 and daterange(eff_from, eff_to) && daterange($3::date, $4::date)',
      [branchId, fixedId, dates.from, dates.to],
    );
    if (overlapping.rows.length > 0) throw new ValidationError(['This slice overlaps an existing slice of the same object']);
  }

  try {
    await db.transaction(async (tx) => {
      await reopenIfQuoted(tx, branch, actor);
      await tx.query(
        `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by)
         values ($1, $2, $3, $4::date, $5::date, $6::jsonb, $7)`,
        [branchId, fixedId, input.kind, dates.from, dates.to, JSON.stringify(input.attributes ?? {}), actor],
      );
      await recordAudit(tx, { actor, action: 'coverable.add', entityType: 'policy_period', entityId: branchId, details: { fixedId, kind: input.kind, effFrom: dates.from, effTo: dates.to } });
    });
  } catch (error) {
    if (isOverlapRefusal(error)) throw new ValidationError(['This slice overlaps an existing slice of the same object']);
    throw error;
  }
  return { fixedId, kind: input.kind, effFrom: dates.from, effTo: dates.to, attributes: input.attributes ?? {} };
}

export interface NewCoverage {
  coverableFixedId: string; // the fixed id of the vehicle, driver ... this cover belongs to
  patternCode: string; // a coverage code from the product, for example MOTOR_OD
  terms?: Record<string, number | string>; // for example { idv: 50000000 } (paise)
  effFrom?: string;
  effTo?: string;
  fixedId?: string; // give the fixed id of an existing coverage to add another slice of it
}

// Adds a coverage on a coverable over a range of dates, or another slice of an existing coverage.
export async function addCoverage(db: PGlite, branchId: string, input: NewCoverage, actor: string): Promise<CoverageSlice> {
  const branch = await openBranch(db, branchId);
  const errors: string[] = [];

  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(input.patternCode)) errors.push('Pattern code must be capital letters, digits or underscores, starting with a letter');
  const dates = sliceDates(branch, input.effFrom, input.effTo);
  errors.push(...dates.errors);
  if (input.fixedId !== undefined && !isUuid(input.fixedId)) errors.push('The fixed id is not valid');

  const coverableFound = isUuid(input.coverableFixedId)
    ? (await db.query('select 1 from policy.coverable where branch_id = $1 and fixed_id = $2', [branchId, input.coverableFixedId])).rows.length > 0
    : false;
  if (!coverableFound) errors.push('The coverable does not exist in this branch');
  if (errors.length > 0) throw new ValidationError(errors);

  const fixedId = input.fixedId ?? randomUUID();
  if (input.fixedId !== undefined) {
    const existing = await db.query<{ coverable_fid: string; pattern_code: string }>(
      'select coverable_fid, pattern_code from policy.coverage where branch_id = $1 and fixed_id = $2 limit 1',
      [branchId, fixedId],
    );
    const other = existing.rows[0];
    if (other && (other.coverable_fid !== input.coverableFixedId || other.pattern_code !== input.patternCode)) {
      throw new ValidationError(['A slice must belong to the same coverage and coverable as the object it extends']);
    }
    const overlapping = await db.query(
      'select 1 from policy.coverage where branch_id = $1 and fixed_id = $2 and daterange(eff_from, eff_to) && daterange($3::date, $4::date)',
      [branchId, fixedId, dates.from, dates.to],
    );
    if (overlapping.rows.length > 0) throw new ValidationError(['This slice overlaps an existing slice of the same object']);
  }

  const terms = input.terms ?? {};
  try {
    await db.transaction(async (tx) => {
      await reopenIfQuoted(tx, branch, actor);
      await tx.query(
        `insert into policy.coverage (branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by)
         values ($1, $2, $3, $4, $5::date, $6::date, $7::jsonb, $8)`,
        [branchId, fixedId, input.coverableFixedId, input.patternCode, dates.from, dates.to, JSON.stringify(terms), actor],
      );
      await recordAudit(tx, {
        actor,
        action: 'coverage.add',
        entityType: 'policy_period',
        entityId: branchId,
        details: { fixedId, coverableFixedId: input.coverableFixedId, patternCode: input.patternCode, effFrom: dates.from, effTo: dates.to },
      });
    });
  } catch (error) {
    if (isOverlapRefusal(error)) throw new ValidationError(['This slice overlaps an existing slice of the same object']);
    throw error;
  }
  return { fixedId, coverableFixedId: input.coverableFixedId, patternCode: input.patternCode, effFrom: dates.from, effTo: dates.to, terms };
}

// What the branch looked like on one date (document section 6): the slices that are true on that day.
// A slice covers its first day and not its last, so the boundary day belongs to the later slice.
export async function getBranchAsOf(db: PGlite, branchId: string, date: string): Promise<BranchAsOf | null> {
  if (!isRealDate(date)) throw new ValidationError(['The date is not a real date (write it as yyyy-mm-dd)']);
  const branch = await getBranch(db, branchId);
  if (branch === null) return null;

  const coverables = await db.query<{ fixed_id: string; kind: CoverableKind; eff_from: string; eff_to: string; attributes: Record<string, unknown> }>(
    `select fixed_id, kind, to_char(eff_from, 'YYYY-MM-DD') as eff_from, to_char(eff_to, 'YYYY-MM-DD') as eff_to, attributes
       from policy.coverable
      where branch_id = $1 and eff_from <= $2::date and $2::date < eff_to
      order by row_id`,
    [branchId, date],
  );
  const coverages = await db.query<{ fixed_id: string; coverable_fid: string; pattern_code: string; eff_from: string; eff_to: string; terms: Record<string, number | string> }>(
    `select fixed_id, coverable_fid, pattern_code, to_char(eff_from, 'YYYY-MM-DD') as eff_from, to_char(eff_to, 'YYYY-MM-DD') as eff_to, terms
       from policy.coverage
      where branch_id = $1 and eff_from <= $2::date and $2::date < eff_to
      order by row_id`,
    [branchId, date],
  );

  return {
    branch,
    date,
    coverables: coverables.rows.map((r) => ({ fixedId: r.fixed_id, kind: r.kind, effFrom: r.eff_from, effTo: r.eff_to, attributes: r.attributes })),
    coverages: coverages.rows.map((r) => ({
      fixedId: r.fixed_id,
      coverableFixedId: r.coverable_fid,
      patternCode: r.pattern_code,
      effFrom: r.eff_from,
      effTo: r.eff_to,
      terms: r.terms,
    })),
  };
}
