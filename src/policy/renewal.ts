import { createHash } from 'node:crypto';
import type { Database } from '../platform/index.js';
import { addDays, addYears, isUuid, recordAudit, ValidationError } from '../platform/index.js';
import type { PolicyDocument } from './bind.js';
import { latestBound } from './cancellation.js';
import type { Branch, Job } from './policy.js';
import { getBranch, getBranchAsOf, getJob } from './policy-repository.js';
import type { ProductCatalogue } from './product-catalogue.js';
import type { RenewalRulesCatalogue } from './renewal-rules.js';
import { formatDate, formatRupees, renderLinesPdf } from './schedule.js';
import { getLatestQuote } from './submission.js';

// Renewal (document section 8): the next term of a policy. It starts a set number of days before expiry, follows the
// insurer's direction (renew, non-renew, review), is re-rated with the product version and rate book in force on the
// new start date, goes out as an offer, and is accepted by binding or ends as "not taken".

export interface RenewalDependencies {
  catalogue: ProductCatalogue;
  renewal: RenewalRulesCatalogue;
}

const todayText = (): string => new Date().toISOString().slice(0, 10);

const productOf = async (db: Database, policyId: string): Promise<string | undefined> =>
  isUuid(policyId) ? (await db.query<{ product_code: string }>('select product_code from policy.policy where id = $1', [policyId])).rows[0]?.product_code : undefined;

// ---------------------------------------------------------------- directions

export type RenewalDirectionKind = 'renew' | 'non_renew' | 'review';

export interface RenewalDirection {
  id: string;
  policyId: string;
  termNumber: number; // the term that is about to expire
  direction: RenewalDirectionKind;
  reason: string;
  setBy: string;
  approvedBy: string | null; // non-renewal only: the second person
  approvalReason: string | null;
  noticeDocumentId: string | null;
}

interface DirectionRow {
  id: string;
  policy_id: string;
  term_number: number;
  direction: RenewalDirectionKind;
  reason: string;
  set_by: string;
  approved_by: string | null;
  approval_reason: string | null;
  notice_document_id: string | null;
}

const DIRECTION_COLUMNS = 'id, policy_id, term_number, direction, reason, set_by, approved_by, approval_reason, notice_document_id';

const toDirection = (r: DirectionRow): RenewalDirection => ({
  id: r.id,
  policyId: r.policy_id,
  termNumber: r.term_number,
  direction: r.direction,
  reason: r.reason,
  setBy: r.set_by,
  approvedBy: r.approved_by,
  approvalReason: r.approval_reason,
  noticeDocumentId: r.notice_document_id,
});

// Every direction ever given, oldest first.
export async function listRenewalDirections(db: Database, policyId: string): Promise<RenewalDirection[]> {
  if (!isUuid(policyId)) return [];
  const result = await db.query<DirectionRow>(`select ${DIRECTION_COLUMNS} from policy.renewal_direction where policy_id = $1 order by seq`, [policyId]);
  return result.rows.map(toDirection);
}

// The direction in force for a term: the newest one. No direction means "renew".
async function currentDirection(db: Pick<Database, 'query'>, policyId: string, termNumber: number): Promise<RenewalDirection | null> {
  const row = (await db.query<DirectionRow>(`select ${DIRECTION_COLUMNS} from policy.renewal_direction where policy_id = $1 and term_number = $2 order by seq desc limit 1`, [policyId, termNumber])).rows[0];
  return row ? toDirection(row) : null;
}

// The pre-renewal direction (document section 8). A reason is always required. A non-renewal still needs approval.
export async function setRenewalDirection(db: Database, input: { policyId: string; direction: RenewalDirectionKind; reason: string }, actor: string): Promise<RenewalDirection> {
  if ((await productOf(db, input.policyId)) === undefined) throw new ValidationError(['The policy does not exist']);
  const latest = await latestBound(db, input.policyId);
  if (latest === null) throw new ValidationError(['The policy has no bound version']);
  const errors: string[] = [];
  if (!['renew', 'non_renew', 'review'].includes(input.direction)) errors.push('The direction must be renew, non_renew or review');
  if (input.reason.trim() === '') errors.push('A reason is required for every renewal direction');
  if (errors.length > 0) throw new ValidationError(errors);

  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>('insert into policy.renewal_direction (policy_id, term_number, direction, reason, set_by) values ($1, $2, $3, $4, $5) returning id', [
      input.policyId,
      latest.termNumber,
      input.direction,
      input.reason.trim(),
      actor,
    ]);
    const newId = inserted.rows[0]?.id ?? '';
    await recordAudit(tx, { actor, action: 'renewal.direction', entityType: 'policy', entityId: input.policyId, reason: input.reason.trim(), details: { termNumber: latest.termNumber, direction: input.direction } });
    return newId;
  });
  const saved = (await db.query<DirectionRow>(`select ${DIRECTION_COLUMNS} from policy.renewal_direction where id = $1`, [id])).rows[0];
  if (!saved) throw new Error('The direction could not be read back');
  return toDirection(saved);
}

// Non-renewal needs approval (document section 8), and by a different person: separation of duties.
export async function approveNonRenewal(db: Database, policyId: string, approver: string, reason: string): Promise<RenewalDirection> {
  const latest = isUuid(policyId) ? await latestBound(db, policyId) : null;
  const current = latest ? await currentDirection(db, policyId, latest.termNumber) : null;
  if (current === null || current.direction !== 'non_renew') throw new ValidationError(['There is no non-renewal waiting for approval']);
  const errors: string[] = [];
  if (current.approvedBy !== null) errors.push('This non-renewal is already approved');
  if (approver === current.setBy) errors.push('The approver must be a different person from the one who proposed the non-renewal');
  if (reason.trim() === '') errors.push('A reason is required to approve a non-renewal');
  if (errors.length > 0) throw new ValidationError(errors);

  await db.transaction(async (tx) => {
    await tx.query('update policy.renewal_direction set approved_by = $2, approval_reason = $3, approved_at = now() where id = $1', [current.id, approver, reason.trim()]);
    await recordAudit(tx, { actor: approver, action: 'renewal.non_renewal_approved', entityType: 'policy', entityId: policyId, reason: reason.trim(), details: { termNumber: current.termNumber, proposedBy: current.setBy } });
  });
  const saved = await currentDirection(db, policyId, current.termNumber);
  if (saved === null) throw new Error('The direction could not be read back');
  return saved;
}

// A stored PDF for the policy, as a document row. The job and branch are those of the newest bound version or the renewal.
async function storeDocument(
  db: Database,
  doc: { policyId: string; jobId: string; branchId: string; kind: string; content: Uint8Array; metadata: PolicyDocument['metadata'] },
  actor: string,
  after?: (tx: Pick<Database, 'query'>, documentId: string) => Promise<void>,
): Promise<PolicyDocument> {
  const sha256 = createHash('sha256').update(doc.content).digest('hex');
  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into policy.document (policy_id, job_id, branch_id, kind, content_type, content, sha256, metadata, created_by)
       values ($1, $2, $3, $4, 'application/pdf', $5, $6, $7::jsonb, $8) returning id`,
      [doc.policyId, doc.jobId, doc.branchId, doc.kind, doc.content, sha256, JSON.stringify(doc.metadata), actor],
    );
    const documentId = inserted.rows[0]?.id ?? '';
    await recordAudit(tx, { actor, action: 'document.create', entityType: 'policy', entityId: doc.policyId, details: { documentId, kind: doc.kind } });
    if (after) await after(tx, documentId);
    return documentId;
  });
  const row = (
    await db.query<{ id: string; policy_id: string; job_id: string; branch_id: string; kind: string; content_type: string; sha256: string; metadata: PolicyDocument['metadata']; created_by: string; created_at: Date }>(
      'select id, policy_id, job_id, branch_id, kind, content_type, sha256, metadata, created_by, created_at from policy.document where id = $1',
      [id],
    )
  ).rows[0];
  if (!row) throw new Error('The document could not be read back');
  return { id: row.id, policyId: row.policy_id, jobId: row.job_id, branchId: row.branch_id, kind: row.kind, contentType: row.content_type, sha256: row.sha256, metadata: row.metadata, createdBy: row.created_by, createdAt: row.created_at.toISOString() };
}

// Sends the non-renewal notice: only after approval, and in time (the product says how many days before expiry).
export async function issueNonRenewalNotice(db: Database, deps: RenewalDependencies, policyId: string, actor: string, options: { today?: string } = {}): Promise<PolicyDocument> {
  const latest = isUuid(policyId) ? await latestBound(db, policyId) : null;
  const current = latest ? await currentDirection(db, policyId, latest.termNumber) : null;
  if (latest === null || current === null || current.direction !== 'non_renew') throw new ValidationError(['There is no non-renewal to issue a notice for']);
  if (current.approvedBy === null) throw new ValidationError(['The non-renewal needs approval first']);
  if (current.noticeDocumentId !== null) throw new ValidationError(['The non-renewal notice was already issued']);

  const productCode = (await productOf(db, policyId)) ?? '';
  const rules = deps.renewal.forVersion(productCode, latest.productVersion);
  if (rules === null) throw new ValidationError([`There are no renewal rules for ${productCode} ${latest.productVersion}`]);
  const today = options.today ?? todayText();
  const lastDay = addDays(latest.periodEnd, -rules.non_renewal_notice_days);
  if (today > lastDay) throw new ValidationError([`A non-renewal needs ${rules.non_renewal_notice_days} days notice before expiry; the notice had to be issued by ${formatDate(lastDay)}`]);

  const policyNumber = (await db.query<{ policy_number: string }>('select policy_number from policy.policy where id = $1', [policyId])).rows[0]?.policy_number ?? '';
  const lines = [
    'Non-renewal notice',
    '',
    `Policy number: ${policyNumber}`,
    `Issued on: ${formatDate(today)}`,
    `The policy will not be renewed. Cover ends on: ${formatDate(latest.periodEnd)} (the last day of cover is ${formatDate(addDays(latest.periodEnd, -1))})`,
    `Notice given: ${rules.non_renewal_notice_days} days or more before expiry`,
  ];
  const content = await renderLinesPdf(lines, { title: `Non-renewal notice ${policyNumber}`, subject: `Policy ${policyNumber}, term ${latest.termNumber}`, date: today, headings: ['Non-renewal notice'] });
  return storeDocument(
    db,
    { policyId, jobId: latest.jobId, branchId: latest.id, kind: 'non_renewal_notice', content, metadata: { policyNumber, jobNumber: '', version: latest.version ?? 0, formCodes: [], conditions: [] } },
    actor,
    async (tx, documentId) => {
      await tx.query('update policy.renewal_direction set notice_document_id = $2 where id = $1', [current.id, documentId]);
    },
  );
}

// ---------------------------------------------------------------- starting a renewal

// Starts the renewal of a policy's newest term. The new term takes the cover as it stands on the last day of the old
// term, so every change made during the term is carried over; the vehicle keeps its fixed id. With no claims
// recorded, the vehicle gains one claim-free year (claims, Part G, will take that over). The product version is the
// one in force on the new start date, so old choices are checked against it when the renewal is quoted.
export async function startRenewal(
  db: Database,
  deps: RenewalDependencies,
  input: { policyId: string },
  actor: string,
  options: { today?: string } = {},
): Promise<{ job: Job; branch: Branch }> {
  const productCode = await productOf(db, input.policyId);
  if (productCode === undefined) throw new ValidationError(['The policy does not exist']);
  const latest = await latestBound(db, input.policyId);
  if (latest === null) throw new ValidationError(['The policy has no bound version to renew']);
  if (latest.cancelledOn !== null) throw new ValidationError(['The policy is cancelled and cannot be renewed']);
  const rules = deps.renewal.forVersion(productCode, latest.productVersion);
  if (rules === null) throw new ValidationError([`There are no renewal rules for ${productCode} ${latest.productVersion}`]);

  const today = options.today ?? todayText();
  if (today >= latest.periodEnd) throw new ValidationError([`The policy term has ended (${formatDate(latest.periodEnd)})`]);
  const opens = addDays(latest.periodEnd, -rules.lead_days);
  if (today < opens) throw new ValidationError([`A renewal starts ${rules.lead_days} days before expiry, from ${formatDate(opens)}`]);

  const direction = await currentDirection(db, input.policyId, latest.termNumber);
  if (direction?.direction === 'review') throw new ValidationError([`The renewal is under review: ${direction.reason}`]);
  if (direction?.direction === 'non_renew') throw new ValidationError(['The policy is marked for non-renewal']);

  const next = latest.termNumber + 1;
  const existing = await db.query('select 1 from policy.policy_period where policy_id = $1 and term_number = $2 and status <> $3', [input.policyId, next, 'withdrawn']);
  if (existing.rows.length > 0) throw new ValidationError([`A renewal for term ${next} is already started or done`]);

  const newStart = latest.periodEnd;
  const newEnd = addYears(newStart, 1);
  const productVersion = deps.catalogue.versionInForce(productCode, newStart)?.version;
  if (productVersion === undefined) throw new ValidationError([`No version of ${productCode} is in force on ${newStart}`]);
  const snapshot = await getBranchAsOf(db, latest.id, addDays(latest.periodEnd, -1));
  if (snapshot === null) throw new ValidationError(['The policy version could not be read']);

  const ids = await db.transaction(async (tx) => {
    const job = (
      await tx.query<{ id: string }>("insert into policy.job (policy_id, type, effective_date, created_by) values ($1, 'renewal', $2::date, $3) returning id", [input.policyId, newStart, actor])
    ).rows[0];
    if (!job) throw new Error('The job was not saved');
    await recordAudit(tx, { actor, action: 'job.start', entityType: 'job', entityId: job.id, details: { type: 'renewal', policyId: input.policyId, effectiveDate: newStart, termNumber: next } });

    const branch = (
      await tx.query<{ id: string }>(
        `insert into policy.policy_period (policy_id, job_id, term_number, label, based_on_id, period_start, period_end, product_version, created_by)
         values ($1, $2, $3, 'Option A', $4, $5::date, $6::date, $7, $8) returning id`,
        [input.policyId, job.id, next, latest.id, newStart, newEnd, productVersion, actor],
      )
    ).rows[0];
    if (!branch) throw new Error('The branch was not saved');
    for (const coverable of snapshot.coverables) {
      const attributes = { ...coverable.attributes };
      if (coverable.kind === 'Vehicle') attributes.claimFreeYears = (typeof attributes.claimFreeYears === 'number' ? attributes.claimFreeYears : 0) + 1;
      await tx.query('insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by) values ($1, $2, $3, $4::date, $5::date, $6::jsonb, $7)', [
        branch.id,
        coverable.fixedId,
        coverable.kind,
        newStart,
        newEnd,
        JSON.stringify(attributes),
        actor,
      ]);
    }
    for (const coverage of snapshot.coverages) {
      await tx.query(
        'insert into policy.coverage (branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by) values ($1, $2, $3, $4, $5::date, $6::date, $7::jsonb, $8)',
        [branch.id, coverage.fixedId, coverage.coverableFixedId, coverage.patternCode, newStart, newEnd, JSON.stringify(coverage.terms), actor],
      );
    }
    await recordAudit(tx, { actor, action: 'branch.create', entityType: 'policy_period', entityId: branch.id, details: { jobId: job.id, basedOn: latest.id, termNumber: next, productVersion } });
    return { jobId: job.id, branchId: branch.id };
  });

  const job = await getJob(db, ids.jobId);
  const branch = await getBranch(db, ids.branchId);
  if (job === null || branch === null) throw new Error('The renewal could not be read back');
  return { job, branch };
}

// ---------------------------------------------------------------- the renewal offer

// The renewal offer document (a renewal notice): the new premium beside the expiring one, and how long the offer lasts.
// It changes nothing in the job: the offer is accepted by binding, or ends as "not taken".
export async function produceRenewalOffer(db: Database, deps: RenewalDependencies, jobId: string, actor: string, options: { today?: string } = {}): Promise<PolicyDocument> {
  const job = await getJob(db, jobId);
  if (job === null) throw new ValidationError(['The job does not exist']);
  if (job.type !== 'renewal' || job.status !== 'quoted') throw new ValidationError([`Only a quoted renewal job can get an offer (this one is ${job.type}, ${job.status})`]);
  const branchRow = (await db.query<{ id: string }>("select id from policy.policy_period where job_id = $1 and status = 'quoted'", [jobId])).rows[0];
  const branch = branchRow ? await getBranch(db, branchRow.id) : null;
  const quote = branch ? await getLatestQuote(db, branch.id) : null;
  if (branch === null || quote === null) throw new ValidationError(['The renewal has no quote']);
  const expiring = branch.basedOnId === null ? null : await getLatestQuote(db, branch.basedOnId);
  const policyNumber = (await db.query<{ policy_number: string }>('select policy_number from policy.policy where id = $1', [job.policyId])).rows[0]?.policy_number ?? '';
  const today = options.today ?? todayText();

  const lines = [
    'Renewal notice',
    '',
    `Policy number: ${policyNumber}`,
    `Issued on: ${formatDate(today)}`,
    `New term: ${formatDate(branch.periodStart)} to ${formatDate(branch.periodEnd)} (the last day of cover is ${formatDate(addDays(branch.periodEnd, -1))})`,
    `Product version: ${branch.productVersion}`,
    '',
    'Premium',
    ...(expiring === null ? [] : [`Expiring premium: ${formatRupees(expiring.premiumPaise)}`]),
    `Renewal premium: ${formatRupees(quote.premiumPaise)}`,
    `Tax: ${formatRupees(quote.taxPaise)}`,
    `Total payable: ${formatRupees(quote.totalPaise)}`,
    `This offer is valid until ${formatDate(quote.validUntil)}.`,
  ];
  const content = await renderLinesPdf(lines, { title: `Renewal notice ${policyNumber}`, subject: `Policy ${policyNumber}, term ${branch.termNumber}, job ${job.jobNumber}`, date: today, headings: ['Renewal notice', 'Premium'] });
  void deps;
  return storeDocument(db, { policyId: job.policyId, jobId, branchId: branch.id, kind: 'renewal_notice', content, metadata: { policyNumber, jobNumber: job.jobNumber, version: 0, formCodes: [], conditions: [] } }, actor);
}
