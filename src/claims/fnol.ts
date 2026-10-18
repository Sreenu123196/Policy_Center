import type { PGlite } from '@electric-sql/pglite';
import { daysBetween, isActiveTypelistCode, isRealDate, isUuid, recordAudit, recordEvent, ValidationError } from '../platform/index.js';
import { findPolicyNumbersByRegistration, getPolicyAsOf } from '../policy/index.js';
import type { PolicyAsOf } from '../policy/index.js';
import type { ClaimsConfigCatalogue } from './config.js';

// First notice of loss (document section 15): the first report of a claim from staff, the portal, the phone, WhatsApp
// or a partner. Claims asks Policy for the policy as it was on the loss date, checks that the cover the loss needs was
// there, and keeps that answer with the claim so the claim is judged on the policy as it was, not as it is now.

export const CHANNELS = ['staff', 'portal', 'phone', 'whatsapp', 'partner'] as const;
export type Channel = (typeof CHANNELS)[number];
export const INCIDENT_KINDS = ['damage', 'injury'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export interface ClaimsDependencies {
  config: ClaimsConfigCatalogue;
}

export interface LossReport {
  policyNumber?: string | undefined; // or the registration number of the vehicle
  registrationNumber?: string | undefined;
  lossDate: string;
  lossTime?: string | undefined; // HH:MM
  reportedOn: string;
  cause: string; // a loss_cause typelist code
  place: string;
  description: string;
  channel: Channel;
  reporter?: { name: string; phone?: string } | undefined;
  incidents?: { kind: IncidentKind; description: string }[] | undefined;
  attachments?: { reference: string; caption?: string }[] | undefined; // references to photos and documents kept elsewhere
}

export interface Verification {
  status: 'verified' | 'not_verified';
  reasons: string[]; // why it could not be verified
  duplicates: string[]; // numbers of earlier claims for the same policy, date and cause
  policy: Pick<PolicyAsOf, 'status' | 'reason' | 'message' | 'termNumber' | 'version' | 'productVersion' | 'vehicles' | 'coverages'>;
}

export interface Claim {
  id: string;
  claimNumber: string;
  policyNumber: string;
  policyId: string;
  accountId: string;
  lossDate: string;
  lossTime: string | null;
  reportedOn: string;
  cause: string;
  place: string;
  description: string;
  channel: Channel;
  reporter: { name: string; phone: string | null } | null;
  status: 'submitted' | 'under_review' | 'documents_pending' | 'approved' | 'settled' | 'rejected' | 'closed';
  verification: Verification;
  lateReport: boolean;
  incidents: { kind: IncidentKind; description: string }[];
  attachments: { reference: string; caption: string | null }[];
  createdBy: string;
  createdAt: string;
}

interface ClaimRow {
  id: string;
  claim_number: string;
  policy_number: string;
  policy_id: string;
  account_id: string;
  loss_date: string;
  loss_time: string | null;
  reported_on: string;
  cause: string;
  place: string;
  description: string;
  channel: Channel;
  reporter_name: string | null;
  reporter_phone: string | null;
  status: Claim['status'];
  verification: Verification;
  late_report: boolean;
  created_by: string;
  created_at: Date;
}

const CLAIM_COLUMNS = `id, claim_number, policy_number, policy_id, account_id, to_char(loss_date, 'YYYY-MM-DD') as loss_date, loss_time,
  to_char(reported_on, 'YYYY-MM-DD') as reported_on, cause, place, description, channel, reporter_name, reporter_phone, status, verification, late_report, created_by, created_at`;

async function toClaim(db: Pick<PGlite, 'query'>, row: ClaimRow): Promise<Claim> {
  const incidents = await db.query<{ kind: IncidentKind; description: string }>('select kind, description from claims.incident where claim_id = $1 order by seq', [row.id]);
  const attachments = await db.query<{ reference: string; caption: string | null }>('select reference, caption from claims.attachment where claim_id = $1 order by seq', [row.id]);
  return {
    id: row.id,
    claimNumber: row.claim_number,
    policyNumber: row.policy_number,
    policyId: row.policy_id,
    accountId: row.account_id,
    lossDate: row.loss_date,
    lossTime: row.loss_time,
    reportedOn: row.reported_on,
    cause: row.cause,
    place: row.place,
    description: row.description,
    channel: row.channel,
    reporter: row.reporter_name === null ? null : { name: row.reporter_name, phone: row.reporter_phone },
    status: row.status,
    verification: row.verification,
    lateReport: row.late_report,
    incidents: incidents.rows,
    attachments: attachments.rows,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

// A claim by its id or its number (CL-0000001).
export async function getClaim(db: Pick<PGlite, 'query'>, idOrNumber: string): Promise<Claim | null> {
  const column = isUuid(idOrNumber) ? 'id' : /^CL-\d{7}$/.test(idOrNumber) ? 'claim_number' : null;
  if (column === null) return null;
  const row = (await db.query<ClaimRow>(`select ${CLAIM_COLUMNS} from claims.claim where ${column} = $1`, [idOrNumber])).rows[0];
  return row ? toClaim(db, row) : null;
}

export async function listClaims(db: Pick<PGlite, 'query'>, filter: { policyNumber?: string }): Promise<Claim[]> {
  const rows =
    filter.policyNumber === undefined
      ? await db.query<ClaimRow>(`select ${CLAIM_COLUMNS} from claims.claim order by claim_number`)
      : await db.query<ClaimRow>(`select ${CLAIM_COLUMNS} from claims.claim where policy_number = $1 order by claim_number`, [filter.policyNumber]);
  return Promise.all(rows.rows.map((row) => toClaim(db, row)));
}

// Takes a first notice of loss. A report that can be understood is always recorded, even when the policy was not in
// force on the loss date: the claim then says so ("not verified") and a handler decides. A report that cannot be
// understood (no such policy, an impossible date) is refused and nothing is saved.
export async function reportLoss(db: PGlite, deps: ClaimsDependencies, input: LossReport, actor: string, options: { today?: string } = {}): Promise<Claim> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const errors: string[] = [];

  const lossOk = isRealDate(input.lossDate);
  const reportedOk = isRealDate(input.reportedOn);
  if (!lossOk) errors.push('The loss date is not a real date (write it as yyyy-mm-dd)');
  if (!reportedOk) errors.push('The report date is not a real date (write it as yyyy-mm-dd)');
  if (lossOk && reportedOk && input.reportedOn < input.lossDate) errors.push('The report date must not be before the loss date');
  if (reportedOk && input.reportedOn > today) errors.push('The report date is in the future');
  if (input.lossTime !== undefined && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.lossTime)) errors.push('The loss time must be written HH:MM');
  if (input.place.trim() === '') errors.push('The place of the loss is required');
  if (input.description.trim() === '') errors.push('A description of the loss is required');
  if (!CHANNELS.includes(input.channel)) errors.push(`The channel must be one of ${CHANNELS.join(', ')}`);
  if (input.reporter !== undefined && input.reporter.name.trim() === '') errors.push('The name of the person reporting is required when a reporter is given');
  for (const incident of input.incidents ?? []) {
    if (!INCIDENT_KINDS.includes(incident.kind)) errors.push(`Incident kind must be one of ${INCIDENT_KINDS.join(', ')}`);
    if (incident.description.trim() === '') errors.push('An incident needs a description');
  }
  for (const attachment of input.attachments ?? []) if (attachment.reference.trim() === '') errors.push('An attachment needs a reference');

  const config = reportedOk ? deps.config.forDate(input.reportedOn) : null;
  const cause = config?.causes.find((c) => c.code === input.cause);
  if (config && (!cause || !(await isActiveTypelistCode(db, 'loss_cause', input.cause)))) errors.push(`${input.cause} is not a loss cause`);

  // Find the policy: by number, or by the registration number of the vehicle on the loss date.
  let policyNumber = input.policyNumber?.trim();
  if (policyNumber === undefined || policyNumber === '') {
    const registration = input.registrationNumber?.trim();
    if (registration === undefined || registration === '') errors.push('Give the policy number or the registration number of the vehicle');
    else if (lossOk) {
      const found = await findPolicyNumbersByRegistration(db, registration, input.lossDate);
      if (found.length === 0) errors.push(`No policy in force on ${input.lossDate} was found for registration number ${registration}`);
      else if (found.length > 1) errors.push(`More than one policy was in force for registration number ${registration}; give the policy number`);
      else policyNumber = found[0];
    }
  }
  const policy = lossOk && policyNumber !== undefined && policyNumber !== '' ? await getPolicyAsOf(db, policyNumber, input.lossDate) : null;
  if (policyNumber !== undefined && policyNumber !== '' && lossOk && policy === null) errors.push(`The policy ${policyNumber} does not exist`);
  if (errors.length > 0 || !policy || !config || !cause) throw new ValidationError(errors);

  // Was the cover this loss needs on the policy on the loss date?
  const reasons: string[] = [];
  if (policy.status === 'not_in_force') reasons.push(policy.message);
  else if (!policy.coverages.some((c) => cause.requires_coverage.includes(c.patternCode))) {
    reasons.push(`The cover for ${input.cause} (${cause.requires_coverage.join(' or ')}) was not on the policy on the loss date`);
  }
  const duplicates = (
    await db.query<{ claim_number: string }>('select claim_number from claims.claim where policy_number = $1 and loss_date = $2::date and cause = $3 order by claim_number', [policy.policyNumber, input.lossDate, input.cause])
  ).rows.map((r) => r.claim_number);
  const lateReport = daysBetween(input.lossDate, input.reportedOn) > config.late_report_days;
  const verification: Verification = {
    status: reasons.length === 0 ? 'verified' : 'not_verified',
    reasons,
    duplicates,
    policy: {
      status: policy.status,
      reason: policy.reason,
      message: policy.message,
      termNumber: policy.termNumber,
      version: policy.version,
      productVersion: policy.productVersion,
      vehicles: policy.vehicles,
      coverages: policy.coverages,
    },
  };

  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string; claim_number: string }>(
      `insert into claims.claim (policy_number, policy_id, account_id, loss_date, loss_time, reported_on, cause, place, description, channel, reporter_name, reporter_phone,
                                 verification_status, verification, late_report, created_by)
       values ($1, $2, $3, $4::date, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16) returning id, claim_number`,
      [
        policy.policyNumber, policy.policyId, policy.accountId, input.lossDate, input.lossTime ?? null, input.reportedOn, input.cause, input.place.trim(), input.description.trim(), input.channel,
        input.reporter?.name.trim() ?? null, input.reporter?.phone ?? null, verification.status, JSON.stringify(verification), lateReport, actor,
      ],
    );
    const claim = inserted.rows[0];
    if (!claim) throw new Error('The claim was not saved');
    for (const incident of input.incidents ?? []) {
      await tx.query('insert into claims.incident (claim_id, kind, description) values ($1, $2, $3)', [claim.id, incident.kind, incident.description.trim()]);
    }
    for (const attachment of input.attachments ?? []) {
      await tx.query('insert into claims.attachment (claim_id, reference, caption) values ($1, $2, $3)', [claim.id, attachment.reference.trim(), attachment.caption ?? null]);
    }
    // No phone number or other personal numbers in the audit log or the event.
    await recordAudit(tx, {
      actor,
      action: 'claim.fnol',
      entityType: 'claim',
      entityId: claim.id,
      details: { claimNumber: claim.claim_number, policyNumber: policy.policyNumber, lossDate: input.lossDate, cause: input.cause, channel: input.channel, verification: verification.status, lateReport },
    });
    await recordEvent(tx, {
      type: 'ClaimOpened',
      aggregateType: 'claim',
      aggregateId: claim.id,
      payload: { claimNumber: claim.claim_number, policyNumber: policy.policyNumber, accountId: policy.accountId, lossDate: input.lossDate, cause: input.cause, verification: verification.status },
    });
    return claim.id;
  });
  const saved = await getClaim(db, id);
  if (saved === null) throw new Error('The claim could not be read back');
  return saved;
}
