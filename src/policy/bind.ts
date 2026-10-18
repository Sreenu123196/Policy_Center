import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { getContact } from '../contacts/index.js';
import { isUuid, recordAudit, recordEvent, ValidationError } from '../platform/index.js';
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

const todayText = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- binding

// Binding accepts the risk: the chosen quoted option becomes a numbered, never-edited policy version (document sections
// 5 and 8). Only this function sets a branch to bound. The other options of the job are withdrawn. The job goes
// quoted, binding, bound in one transaction, and a PolicyBound event is written for billing.
export async function bindSubmission(
  db: PGlite,
  deps: Pick<BindDependencies, 'underwriting'>,
  jobId: string,
  input: { branchId: string },
  actor: string,
  options: { today?: string } = {},
): Promise<{ job: Job; branch: Branch; quote: Quote }> {
  const job = await getJob(db, jobId);
  if (job === null) throw new ValidationError(['The job does not exist']);
  if (job.status !== 'quoted') throw new ValidationError([`Only a quoted job can be bound (this one is ${job.status})`]);
  const chosen = await getBranch(db, input.branchId);
  if (chosen === null || chosen.jobId !== jobId) throw new ValidationError(['The branch must be an option of this job']);
  if (chosen.status !== 'quoted') throw new ValidationError([`Only a quoted option can be bound (this one is ${chosen.status})`]);

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
    const policyNumber = (await tx.query<{ policy_number: string }>('select policy_number from policy.policy where id = $1', [chosen.policyId])).rows[0]?.policy_number;
    await recordEvent(tx, {
      type: 'PolicyBound',
      aggregateType: 'policy',
      aggregateId: chosen.policyId,
      payload: {
        policyNumber,
        version,
        branchId: chosen.id,
        jobId,
        periodStart: chosen.periodStart,
        periodEnd: chosen.periodEnd,
        premiumPaise: quote.premiumPaise,
        taxPaise: quote.taxPaise,
        totalPaise: quote.totalPaise,
      },
    });
  });

  const savedJob = await getJob(db, jobId);
  const savedBranch = await getBranch(db, chosen.id);
  if (savedJob === null || savedBranch === null) throw new Error('The bound job could not be read back');
  return { job: savedJob, branch: savedBranch, quote };
}

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
export async function issueSubmission(
  db: PGlite,
  deps: BindDependencies,
  jobId: string,
  actor: string,
  options: { today?: string } = {},
): Promise<{ job: Job; document: PolicyDocument }> {
  const job = await getJob(db, jobId);
  if (job === null) throw new ValidationError(['The job does not exist']);
  if (!allowedNextStatuses(job.type, job.status).includes('issued')) throw new ValidationError([`A ${job.type} job cannot move from ${job.status} to issued`]);
  const bound = (await db.query<{ id: string }>("select id from policy.policy_period where job_id = $1 and status = 'bound'", [jobId])).rows[0];
  const branch = bound ? await getBranch(db, bound.id) : null;
  const quote = branch ? await getLatestQuote(db, branch.id) : null;
  if (branch === null || quote === null) throw new ValidationError(['The job has no bound version to issue']);

  const today = options.today ?? todayText();
  if (deps.underwriting) await checkUnderwriting(db, deps.underwriting, branch.id, 'issuance', actor, { today });

  const data = await buildScheduleData(db, deps, branch, job.jobNumber, quote, today);
  const content = await renderSchedulePdf(data);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const metadata = { policyNumber: data.policyNumber, jobNumber: data.jobNumber, version: data.version, formCodes: [] as string[], conditions: data.conditions };

  const documentId = await db.transaction(async (tx) => {
    await moveJob(tx, jobId, 'issued', actor);
    const inserted = await tx.query<{ id: string }>(
      `insert into policy.document (policy_id, job_id, branch_id, kind, content_type, content, sha256, metadata, created_by)
       values ($1, $2, $3, 'policy_schedule', 'application/pdf', $4, $5, $6::jsonb, $7) returning id`,
      [branch.policyId, jobId, branch.id, content, sha256, JSON.stringify(metadata), actor],
    );
    const id = inserted.rows[0]?.id ?? '';
    await recordAudit(tx, { actor, action: 'document.create', entityType: 'policy', entityId: branch.policyId, details: { documentId: id, kind: 'policy_schedule', version: data.version } });
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
