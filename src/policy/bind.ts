import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { getContact } from '../contacts/index.js';
import { isUuid, recordAudit, recordEvent, ValidationError } from '../platform/index.js';
import { bindCancellation, getAdjustment, getAdjustmentOfBranch, issueCancellation } from './cancellation.js';
import { allowedNextStatuses } from './job-status.js';
import { moveJob } from './job-sync.js';
import type { Branch, Job } from './policy.js';
import { getBranch, getBranchAsOf, getJob } from './policy-repository.js';
import type { ProductCatalogue } from './product-catalogue.js';
import type { Quote } from './quote.js';
import { formatDate, formatRupees, renderSchedulePdf, type ScheduleData } from './schedule.js';
import { getLatestQuote } from './submission.js';
import { checkUnderwriting, listIssues, type UnderwritingDependencies } from './underwriting.js';

export interface BindDependencies {
  catalogue: ProductCatalogue;
  underwriting?: UnderwritingDependencies; // when given, issues that block the bind or the issuance stop it
}

// The premium transaction of a bound version, as small numbers for the endorsement schedule.
async function transactionOf(db: PGlite, branchId: string): Promise<{ premium: number; total: number } | undefined> {
  const result = await db.query<{ premium: number; total: number }>('select premium_paise::float8 as premium, total_paise::float8 as total from policy.premium_transaction where branch_id = $1', [branchId]);
  return result.rows[0];
}

const todayText = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- binding

// Binding accepts the risk: the chosen quoted option becomes a numbered, never-edited policy version (document sections
// 5 and 8). Only this function sets a branch to bound. The other options of the job are withdrawn. The job goes
// quoted, binding, bound in one transaction. A premium transaction (what this version adds or removes compared with
// the version it was based on) is saved, and a PolicyBound event is written for billing. Works for a submission
// (version 1) and for a policy change (the next version).
export async function bindJob(
  db: PGlite,
  deps: BindDependencies,
  jobId: string,
  input: { branchId: string },
  actor: string,
  options: { today?: string } = {},
): Promise<{ job: Job; branch: Branch; quote: Quote | null }> {
  const job = await getJob(db, jobId);
  if (job === null) throw new ValidationError(['The job does not exist']);
  if (!['submission', 'policy_change', 'reinstatement', 'cancellation', 'renewal'].includes(job.type)) throw new ValidationError([`A ${job.type} job cannot be bound yet`]);
  if (job.status !== 'quoted') throw new ValidationError([`Only a quoted job can be bound (this one is ${job.status})`]);
  const chosen = await getBranch(db, input.branchId);
  if (chosen === null || chosen.jobId !== jobId) throw new ValidationError(['The branch must be an option of this job']);
  if (chosen.status !== 'quoted') throw new ValidationError([`Only a quoted option can be bound (this one is ${chosen.status})`]);

  if (job.type === 'cancellation') {
    await bindCancellation(db, job, chosen, actor);
    const done = await getJob(db, jobId);
    const doneBranch = await getBranch(db, chosen.id);
    if (done === null || doneBranch === null) throw new Error('The bound job could not be read back');
    return { job: done, branch: doneBranch, quote: null };
  }

  // Another job may have bound first. Then this one must be rebased onto the new version (step E2) before it can bind.
  const latest = (
    await db.query<{ id: string; version: number }>(
      "select id, version from policy.policy_period where policy_id = $1 and term_number = $2 and status = 'bound' order by version desc limit 1",
      [chosen.policyId, chosen.termNumber],
    )
  ).rows[0];
  if (latest && latest.id !== chosen.basedOnId) {
    throw new ValidationError([`Version ${latest.version} was bound after this job started; it must be rebased onto it before it can bind (step E2)`]);
  }
  // What the new version is compared with: the quote of the version it was based on. After a cancellation the base is
  // the part of the premium the insurer kept.
  // A renewal starts a new term, so its transaction is the whole premium of the term, not a difference.
  let base: { premiumPaise: number; taxPaise: number; totalPaise: number } | null = chosen.basedOnId === null || job.type === 'renewal' ? null : await getLatestQuote(db, chosen.basedOnId);
  const reinstatement = job.type === 'reinstatement' ? await getAdjustment(db, jobId) : null;
  if (job.type === 'reinstatement' && chosen.basedOnId !== null) {
    const cancelled = await getAdjustmentOfBranch(db, chosen.basedOnId);
    const keptPremium = (cancelled?.termPremiumPaise ?? 0) - (cancelled?.refundPremiumPaise ?? 0);
    const keptTax = (cancelled?.termTaxPaise ?? 0) - (cancelled?.refundTaxPaise ?? 0);
    base = { premiumPaise: keptPremium, taxPaise: keptTax, totalPaise: keptPremium + keptTax };
  }

  const quote = await getLatestQuote(db, chosen.id);
  if (quote === null) throw new ValidationError(['The option has no quote']);
  const today = options.today ?? todayText();
  if (today > quote.validUntil) throw new ValidationError([`The quote has expired: it was valid until ${formatDate(quote.validUntil)}`]);

  if (deps.underwriting) await checkUnderwriting(db, deps.underwriting, chosen.id, 'bind', actor, { today });

  await db.transaction(async (tx) => {
    await moveJob(tx, jobId, 'binding', actor);
    const next = await tx.query<{ version: number }>('select coalesce(max(version), 0) + 1 as version from policy.policy_period where policy_id = $1 and term_number = $2', [
      chosen.policyId,
      chosen.termNumber,
    ]);
    const version = Number(next.rows[0]?.version ?? 1);
    await tx.query("update policy.policy_period set status = 'bound', version = $2 where id = $1", [chosen.id, version]);
    const others = await tx.query<{ id: string }>("select id from policy.policy_period where job_id = $1 and id <> $2 and status in ('draft', 'quoted')", [jobId, chosen.id]);
    for (const { id } of others.rows) {
      await tx.query("update policy.policy_period set status = 'withdrawn' where id = $1", [id]);
      await recordAudit(tx, { actor, action: 'branch.withdraw', entityType: 'policy_period', entityId: id, details: { jobStatus: 'bound' } });
    }
    await recordAudit(tx, { actor, action: 'branch.bind', entityType: 'policy_period', entityId: chosen.id, details: { version, quoteId: quote.id } });
    await moveJob(tx, jobId, 'bound', actor);
    // Two jobs can be open on one policy. When one binds, the others are preempted: they must be rebased onto the new version.
    const rivals = await tx.query<{ id: string }>("select id from policy.job where policy_id = $1 and id <> $2 and type = 'policy_change' and status in ('draft', 'quoted')", [chosen.policyId, jobId]);
    // A renewal is a different term, so it does not clash with changes to the term that is ending.
    if (job.type !== 'renewal') for (const rival of rivals.rows) await moveJob(tx, rival.id, 'preempted', actor, `Version ${version} was bound by job ${job.jobNumber}`);
    const policyRow = (await tx.query<{ policy_number: string; account_id: string }>('select policy_number, account_id from policy.policy where id = $1', [chosen.policyId])).rows[0];
    const policyNumber = policyRow?.policy_number;
    const transaction = {
      kind: job.type === 'reinstatement' ? 'reinstatement' : job.type === 'renewal' ? 'renewal' : base === null ? 'new_business' : 'change',
      effectiveDate: job.effectiveDate ?? chosen.periodStart,
      premiumPaise: quote.premiumPaise - (base?.premiumPaise ?? 0),
      taxPaise: quote.taxPaise - (base?.taxPaise ?? 0),
      totalPaise: quote.totalPaise - (base?.totalPaise ?? 0),
    };
    await tx.query(
      `insert into policy.premium_transaction (policy_id, branch_id, based_on_id, version, kind, effective_date, premium_paise, tax_paise, total_paise, created_by)
       values ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10)`,
      [chosen.policyId, chosen.id, chosen.basedOnId, version, transaction.kind, transaction.effectiveDate, transaction.premiumPaise, transaction.taxPaise, transaction.totalPaise, actor],
    );
    await recordEvent(tx, {
      type: job.type === 'reinstatement' ? 'PolicyReinstated' : job.type === 'renewal' ? 'PolicyRenewed' : 'PolicyBound',
      aggregateType: 'policy',
      aggregateId: chosen.policyId,
      payload: {
        policyNumber,
        accountId: policyRow?.account_id,
        version,
        termNumber: chosen.termNumber,
        branchId: chosen.id,
        jobId,
        periodStart: chosen.periodStart,
        periodEnd: chosen.periodEnd,
        premiumPaise: quote.premiumPaise,
        taxPaise: quote.taxPaise,
        totalPaise: quote.totalPaise,
        transaction,
        ...(reinstatement === null ? {} : { withGap: reinstatement.restoreDate !== null, reinstatementDate: reinstatement.restoreDate, effectiveDate: reinstatement.effectiveDate }),
      },
    });
  });

  const savedJob = await getJob(db, jobId);
  const savedBranch = await getBranch(db, chosen.id);
  if (savedJob === null || savedBranch === null) throw new Error('The bound job could not be read back');
  return { job: savedJob, branch: savedBranch, quote };
}

export const bindSubmission = bindJob;

// ---------------------------------------------------------------- documents

export interface PolicyDocument {
  id: string;
  policyId: string;
  jobId: string;
  branchId: string;
  kind: string;
  contentType: string;
  sha256: string;
  metadata: { policyNumber: string; jobNumber: string; version: number; formCodes: string[]; conditions: string[] };
  createdBy: string;
  createdAt: string;
}

export interface StoredDocument extends PolicyDocument {
  content: Uint8Array;
}

interface DocumentRow {
  id: string;
  policy_id: string;
  job_id: string;
  branch_id: string;
  kind: string;
  content_type: string;
  sha256: string;
  metadata: PolicyDocument['metadata'];
  created_by: string;
  created_at: Date;
}

const DOCUMENT_COLUMNS = 'id, policy_id, job_id, branch_id, kind, content_type, sha256, metadata, created_by, created_at';

const toDocument = (row: DocumentRow): PolicyDocument => ({
  id: row.id,
  policyId: row.policy_id,
  jobId: row.job_id,
  branchId: row.branch_id,
  kind: row.kind,
  contentType: row.content_type,
  sha256: row.sha256,
  metadata: row.metadata,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

export async function getDocument(db: PGlite, id: string): Promise<StoredDocument | null> {
  if (!isUuid(id)) return null;
  const result = await db.query<DocumentRow & { content: Uint8Array }>(`select ${DOCUMENT_COLUMNS}, content from policy.document where id = $1`, [id]);
  const row = result.rows[0];
  return row ? { ...toDocument(row), content: new Uint8Array(row.content) } : null;
}

// The documents of a policy, oldest first, without their content.
export async function listDocuments(db: PGlite, policyId: string): Promise<PolicyDocument[]> {
  if (!isUuid(policyId)) return [];
  const result = await db.query<DocumentRow>(`select ${DOCUMENT_COLUMNS} from policy.document where policy_id = $1 order by seq`, [policyId]);
  return result.rows.map(toDocument);
}

// Collects what the schedule shows: the policy, the insured, the vehicle, the premium by cover, and underwriting conditions.
async function buildScheduleData(db: PGlite, deps: BindDependencies, branch: Branch, jobNumber: string, quote: Quote, issuedOn: string): Promise<ScheduleData> {
  const policy = (
    await db.query<{ policy_number: string; product_code: string; account_id: string }>('select policy_number, product_code, account_id from policy.policy where id = $1', [branch.policyId])
  ).rows[0];
  if (!policy) throw new Error('The policy could not be read');
  const account = (await db.query<{ producer_code: string }>('select producer_code from policy.account where id = $1', [policy.account_id])).rows[0];
  const insured = (await db.query<{ contact_id: string }>("select contact_id from policy.account_contact where account_id = $1 and role = 'named_insured'", [policy.account_id])).rows[0];
  const contact = insured ? await getContact(db, insured.contact_id) : null;
  if (!account || !contact) throw new ValidationError(['The account has no named insured']);

  const product = deps.catalogue.versionsOf(policy.product_code).find((v) => v.version === branch.productVersion);
  if (!product) throw new ValidationError([`Product version ${branch.productVersion} is not in the product catalogue`]);
  const asOf = await getBranchAsOf(db, branch.id, branch.periodStart);
  const vehicle = asOf?.coverables.find((c) => c.kind === 'Vehicle');
  const od = asOf?.coverages.find((c) => c.patternCode === 'MOTOR_OD');

  const costs = quote.worksheet.filter((l) => l.step.startsWith('cost ') && l.amountPaise !== undefined);
  const coverages =
    costs.length > 0
      ? costs.map((l) => {
          const code = l.step.slice('cost '.length);
          const detail = code === 'MOTOR_OD' && typeof od?.terms.idv === 'number' ? `Insured value ${formatRupees(od.terms.idv)}` : '';
          return { name: product.line.coverages.find((c) => c.code === code)?.names.en ?? code, detail, premiumPaise: l.amountPaise ?? 0 };
        })
      : [{ name: 'Premium', detail: '', premiumPaise: quote.premiumPaise }];

  const issues = await listIssues(db, branch.id);
  const conditions = issues.filter((i) => i.status === 'approved' && i.decision?.decision === 'approved_with_conditions').map((i) => `${i.issueType}: ${i.decision?.conditions ?? ''}`);

  const attrs = vehicle?.attributes ?? {};
  return {
    policyNumber: policy.policy_number,
    jobNumber,
    version: branch.version ?? 0,
    productName: product.names.en,
    rateBook: quote.rateBook,
    periodStart: branch.periodStart,
    periodEnd: branch.periodEnd,
    issuedOn,
    producerCode: account.producer_code,
    insured: {
      name: contact.name,
      addressLines: [contact.address.line1, ...(contact.address.line2 ? [contact.address.line2] : []), `${contact.address.city}, ${contact.address.state} ${contact.address.pinCode}`],
    },
    vehicle: {
      description: [attrs.make, attrs.model, attrs.year].filter((x) => x !== undefined).join(' '),
      registrationNumber: typeof attrs.registrationNumber === 'string' ? attrs.registrationNumber : 'not given',
    },
    coverages,
    premiumPaise: quote.premiumPaise,
    taxName: 'GST',
    taxPaise: quote.taxPaise,
    totalPaise: quote.totalPaise,
    conditions,
  };
}

// ---------------------------------------------------------------- issuing

// Issuing makes the bound policy official: the job becomes issued and the policy schedule is produced and stored.
export async function issueJob(
  db: PGlite,
  deps: BindDependencies,
  jobId: string,
  actor: string,
  options: { today?: string } = {},
): Promise<{ job: Job; document: PolicyDocument }> {
  const job = await getJob(db, jobId);
  if (job === null) throw new ValidationError(['The job does not exist']);
  if (!allowedNextStatuses(job.type, job.status).includes('issued')) throw new ValidationError([`A ${job.type} job cannot move from ${job.status} to issued`]);
  if (job.type === 'cancellation') {
    const done = await issueCancellation(db, job, actor, options);
    const documentRow = (await listDocuments(db, job.policyId)).find((d) => d.id === done.documentId);
    if (documentRow === undefined) throw new Error('The notice could not be read back');
    return { job: done.job, document: documentRow };
  }
  const bound = (await db.query<{ id: string }>("select id from policy.policy_period where job_id = $1 and status = 'bound'", [jobId])).rows[0];
  const branch = bound ? await getBranch(db, bound.id) : null;
  const quote = branch ? await getLatestQuote(db, branch.id) : null;
  if (branch === null || quote === null) throw new ValidationError(['The job has no bound version to issue']);

  const today = options.today ?? todayText();
  if (deps.underwriting) await checkUnderwriting(db, deps.underwriting, branch.id, 'issuance', actor, { today });

  const isChange = job.type === 'policy_change' || job.type === 'reinstatement';
  const kind = job.type === 'policy_change' ? 'endorsement_schedule' : job.type === 'reinstatement' ? 'reinstatement_schedule' : job.type === 'renewal' ? 'renewal_schedule' : 'policy_schedule';
  const data = await buildScheduleData(db, deps, branch, job.jobNumber, quote, today);
  if (isChange) {
    const t = await transactionOf(db, branch.id);
    data.change = { effectiveDate: job.effectiveDate ?? branch.periodStart, premiumChangePaise: t?.premium ?? 0, totalChangePaise: t?.total ?? 0 };
  }
  const content = await renderSchedulePdf(data);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const metadata = { policyNumber: data.policyNumber, jobNumber: data.jobNumber, version: data.version, formCodes: [] as string[], conditions: data.conditions };

  const documentId = await db.transaction(async (tx) => {
    await moveJob(tx, jobId, 'issued', actor);
    const inserted = await tx.query<{ id: string }>(
      `insert into policy.document (policy_id, job_id, branch_id, kind, content_type, content, sha256, metadata, created_by)
       values ($1, $2, $3, $4, 'application/pdf', $5, $6, $7::jsonb, $8) returning id`,
      [branch.policyId, jobId, branch.id, kind, content, sha256, JSON.stringify(metadata), actor],
    );
    const id = inserted.rows[0]?.id ?? '';
    await recordAudit(tx, { actor, action: 'document.create', entityType: 'policy', entityId: branch.policyId, details: { documentId: id, kind, version: data.version } });
    await recordEvent(tx, {
      type: 'PolicyIssued',
      aggregateType: 'policy',
      aggregateId: branch.policyId,
      payload: { policyNumber: data.policyNumber, version: data.version, documentId: id },
    });
    return id;
  });

  const savedJob = await getJob(db, jobId);
  const document = (await listDocuments(db, branch.policyId)).find((d) => d.id === documentId);
  if (savedJob === null || document === undefined) throw new Error('The issued job could not be read back');
  return { job: savedJob, document };
}

export const issueSubmission = issueJob;
