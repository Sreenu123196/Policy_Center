import type { Database } from '../platform/index.js';
import { getUserByUsername, isRealDate, isUuid, PermissionError, recordAudit, recordEvent, ValidationError } from '../platform/index.js';
import { EXPOSURE_COLUMNS, getExposure, refreshClaimStatus, toExposure, type Exposure } from './exposures.js';
import { getClaim, type Claim, type ClaimsDependencies } from './fnol.js';

// Reserves, payments and recoveries (document section 15). Money is whole paise. A reserve is the amount still expected
// to be paid on a line (a cost type and a category) of an exposure. A payment reduces it. Incurred is
// paid + outstanding reserves - recoveries. What a person may reserve and pay depends on their claim financial authority.

type Q = Pick<Database, 'query'>;

export const COST_TYPES = ['claim_cost', 'expense'] as const;
export type CostType = (typeof COST_TYPES)[number];
export const PAYMENT_METHODS = ['bank_transfer', 'upi'] as const;
export type ClaimPaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYEE_KINDS = ['claimant', 'garage', 'hospital', 'other'] as const;
export const RECOVERY_KINDS = ['subrogation', 'salvage', 'deductible'] as const;

const isMoney = (value: number): boolean => Number.isInteger(value) && value >= 0;

// ---------------------------------------------------------------- authority

async function limitsOf(db: Q, deps: ClaimsDependencies, claim: Claim, username: string): Promise<{ reserve: number; payment: number } | null> {
  const user = await getUserByUsername(db as Database, username);
  if (user === null) return null;
  const profiles = deps.config.forDate(claim.reportedOn).authority_profiles.filter((p) => p.users.includes(username) || p.roles.some((role) => user.roles.includes(role)));
  if (profiles.length === 0) return null;
  return { reserve: Math.max(...profiles.map((p) => p.reserve_limit_paise)), payment: Math.max(...profiles.map((p) => p.payment_limit_paise)) };
}

// ---------------------------------------------------------------- loading

interface Loaded {
  exposure: Exposure;
  claim: Claim;
}

async function load(db: Q, exposureId: string): Promise<Loaded> {
  const exposure = await getExposure(db, exposureId);
  if (exposure === null) throw new ValidationError(['The exposure does not exist']);
  const claim = await getClaim(db, exposure.claimId);
  if (claim === null) throw new Error('The claim of the exposure could not be read');
  return { exposure, claim };
}

const outstandingTotal = async (db: Q, exposureId: string): Promise<number> =>
  (await db.query<{ total: number }>('select coalesce(sum(outstanding_paise), 0)::float8 as total from claims.reserve_line where exposure_id = $1', [exposureId])).rows[0]?.total ?? 0;

// Changes the outstanding reserve of one line, writes the history and announces it.
async function changeReserve(tx: Q, loaded: Loaded, line: { costType: CostType; category: string }, newPaise: number, reason: string, actor: string): Promise<void> {
  const old = (await tx.query<{ outstanding_paise: number }>('select outstanding_paise::float8 as outstanding_paise from claims.reserve_line where exposure_id = $1 and cost_type = $2 and category = $3', [loaded.exposure.id, line.costType, line.category])).rows[0]?.outstanding_paise ?? 0;
  if (old === newPaise) return;
  await tx.query(
    `insert into claims.reserve_line (exposure_id, cost_type, category, outstanding_paise) values ($1, $2, $3, $4)
     on conflict (exposure_id, cost_type, category) do update set outstanding_paise = excluded.outstanding_paise`,
    [loaded.exposure.id, line.costType, line.category, newPaise],
  );
  await tx.query('insert into claims.reserve_change (exposure_id, cost_type, category, old_paise, new_paise, reason, changed_by) values ($1, $2, $3, $4, $5, $6, $7)', [
    loaded.exposure.id, line.costType, line.category, old, newPaise, reason, actor,
  ]);
  await recordEvent(tx, {
    type: 'ReserveChanged',
    aggregateType: 'claim',
    aggregateId: loaded.claim.id,
    payload: {
      claimNumber: loaded.claim.claimNumber,
      exposureNumber: loaded.exposure.number,
      costType: line.costType,
      category: line.category,
      deltaPaise: newPaise - old,
      outstandingPaise: await outstandingTotal(tx, loaded.exposure.id),
    },
  });
}

export interface ReserveLine {
  exposureId: string;
  costType: CostType;
  category: string;
  outstandingPaise: number;
}

// Sets the outstanding reserve of a line. A person with too little authority cannot raise the exposure's reserves
// above their limit; the change is refused and leaves no trace.
export async function setReserve(
  db: Database,
  deps: ClaimsDependencies,
  exposureId: string,
  input: { costType: CostType; category: string; outstandingPaise: number; reason: string },
  actor: string,
): Promise<ReserveLine> {
  const loaded = await load(db, exposureId);
  const { exposure, claim } = loaded;
  const errors: string[] = [];
  if (!isMoney(input.outstandingPaise)) errors.push('The reserve must be a whole number of paise, not negative');
  if (!COST_TYPES.includes(input.costType)) errors.push(`The cost type must be one of ${COST_TYPES.join(', ')}`);
  if (!deps.config.forDate(claim.reportedOn).reserve_categories.includes(input.category)) errors.push(`The category ${input.category} is not a reserve category`);
  if (input.reason.trim() === '') errors.push('A reason is required to change a reserve');
  if (['settled', 'rejected', 'closed'].includes(exposure.status)) errors.push(`A ${exposure.status} exposure cannot have its reserve changed`);
  if (errors.length > 0) throw new ValidationError(errors);

  const limits = await limitsOf(db, deps, claim, actor);
  const others = (
    await db.query<{ total: number }>('select coalesce(sum(outstanding_paise), 0)::float8 as total from claims.reserve_line where exposure_id = $1 and not (cost_type = $2 and category = $3)', [exposureId, input.costType, input.category])
  ).rows[0]?.total ?? 0;
  if (limits === null || others + input.outstandingPaise > limits.reserve) throw new PermissionError('claim.reserve');

  await db.transaction(async (tx) => {
    await changeReserve(tx, loaded, input, input.outstandingPaise, input.reason.trim(), actor);
    await recordAudit(tx, {
      actor,
      action: 'reserve.set',
      entityType: 'claim',
      entityId: claim.id,
      reason: input.reason.trim(),
      details: { exposureNumber: exposure.number, costType: input.costType, category: input.category, outstandingPaise: input.outstandingPaise },
    });
  });
  return { exposureId, costType: input.costType, category: input.category, outstandingPaise: input.outstandingPaise };
}

export async function listReserveHistory(db: Q, exposureId: string): Promise<{ costType: string; category: string; oldPaise: number; newPaise: number; reason: string | null; changedBy: string }[]> {
  const result = await db.query<{ cost_type: string; category: string; old_paise: number; new_paise: number; reason: string | null; changed_by: string }>(
    'select cost_type, category, old_paise::float8 as old_paise, new_paise::float8 as new_paise, reason, changed_by from claims.reserve_change where exposure_id = $1 order by seq',
    [exposureId],
  );
  return result.rows.map((r) => ({ costType: r.cost_type, category: r.category, oldPaise: r.old_paise, newPaise: r.new_paise, reason: r.reason, changedBy: r.changed_by }));
}

// ---------------------------------------------------------------- payments

export interface PaymentInput {
  costType: CostType;
  category: string;
  amountPaise: number;
  kind: 'partial' | 'final';
  payee: { kind: (typeof PAYEE_KINDS)[number]; name: string; bank?: { ifsc: string; accountNumber: string }; upi?: string };
  method: ClaimPaymentMethod;
  reference: string;
  paidOn: string;
  note?: string; // for a payee that is not the claimant: the invoice reference
}

export interface ClaimPayment {
  id: string;
  exposureId: string;
  costType: CostType;
  category: string;
  amountPaise: number;
  kind: 'partial' | 'final';
  payee: { kind: string; name: string; instrument: string }; // the instrument is masked
  method: ClaimPaymentMethod;
  reference: string;
  paidOn: string;
  status: 'issued' | 'pending_approval';
  requestedBy: string;
  approvedBy: string | null;
}

interface PaymentRow {
  id: string;
  exposure_id: string;
  cost_type: CostType;
  category: string;
  amount_paise: number;
  kind: 'partial' | 'final';
  payee_kind: string;
  payee_name: string;
  instrument: string;
  method: ClaimPaymentMethod;
  reference: string;
  paid_on: string;
  status: 'issued' | 'pending_approval';
  requested_by: string;
  approved_by: string | null;
}

const PAYMENT_COLUMNS = `id, exposure_id, cost_type, category, amount_paise::float8 as amount_paise, kind, payee_kind, payee_name, instrument, method, reference,
  to_char(paid_on, 'YYYY-MM-DD') as paid_on, status, requested_by, approved_by`;

const toPayment = (r: PaymentRow): ClaimPayment => ({
  id: r.id,
  exposureId: r.exposure_id,
  costType: r.cost_type,
  category: r.category,
  amountPaise: r.amount_paise,
  kind: r.kind,
  payee: { kind: r.payee_kind, name: r.payee_name, instrument: r.instrument },
  method: r.method,
  reference: r.reference,
  paidOn: r.paid_on,
  status: r.status,
  requestedBy: r.requested_by,
  approvedBy: r.approved_by,
});

export async function listPayments(db: Q, exposureId: string): Promise<ClaimPayment[]> {
  const result = await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from claims.claim_payment where exposure_id = $1 order by seq`, [exposureId]);
  return result.rows.map(toPayment);
}

// Checks who is being paid and where, and returns the payment instrument with its number hidden. The full account
// number is not kept: it goes to the payment gateway adapter (document section 17), which is not built here.
function checkPayee(input: PaymentInput, claimantName: string): { errors: string[]; instrument: string } {
  const errors: string[] = [];
  const name = input.payee.name.trim();
  if (!PAYEE_KINDS.includes(input.payee.kind)) errors.push(`The payee kind must be one of ${PAYEE_KINDS.join(', ')}`);
  if (name === '') errors.push('The payee needs a name');
  else if (input.payee.kind === 'claimant' && name.toLowerCase() !== claimantName.trim().toLowerCase()) errors.push(`The payee must be the claimant ${claimantName} for a payment to a claimant`);
  if (input.payee.kind !== 'claimant' && (input.note ?? '').trim() === '') errors.push('A payment to a garage, hospital or other payee needs an invoice reference in the note');

  let instrument = '';
  if (!PAYMENT_METHODS.includes(input.method)) errors.push(`The payment method must be one of ${PAYMENT_METHODS.join(', ')}`);
  else if (input.method === 'bank_transfer') {
    const bank = input.payee.bank;
    if (!bank) errors.push('A bank transfer needs the bank details of the payee');
    else {
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bank.ifsc)) errors.push('The IFSC code is not valid');
      if (!/^\d{9,18}$/.test(bank.accountNumber)) errors.push('The account number must be 9 to 18 digits');
      else instrument = `${'X'.repeat(bank.accountNumber.length - 4)}${bank.accountNumber.slice(-4)}`;
    }
  } else {
    const upi = input.payee.upi;
    if (upi === undefined) errors.push("A UPI payment needs the payee's UPI address");
    else if (!/^[a-z0-9._-]{2,}@[a-z]{2,}$/i.test(upi)) errors.push('The UPI address is not valid');
    else instrument = `${upi.slice(0, 2)}***${upi.slice(upi.indexOf('@'))}`;
  }
  return { errors, instrument };
}

// Reduces the reserve for a payment that is now issued, releases the rest of the exposure on a final payment, settles
// the exposure, and announces the payment. Used when a payment is issued at once and when it is approved later.
async function issue(tx: Q, loaded: Loaded, payment: PaymentRow, actor: string): Promise<void> {
  const line = { costType: payment.cost_type, category: payment.category };
  const current = (await tx.query<{ outstanding_paise: number }>('select outstanding_paise::float8 as outstanding_paise from claims.reserve_line where exposure_id = $1 and cost_type = $2 and category = $3', [loaded.exposure.id, line.costType, line.category])).rows[0]?.outstanding_paise ?? 0;
  await changeReserve(tx, loaded, line, current - payment.amount_paise, `Payment ${payment.reference}`, actor);
  if (payment.kind === 'final') {
    const rest = await tx.query<{ cost_type: CostType; category: string }>('select cost_type, category from claims.reserve_line where exposure_id = $1 and outstanding_paise > 0 order by cost_type, category', [loaded.exposure.id]);
    for (const other of rest.rows) await changeReserve(tx, loaded, { costType: other.cost_type, category: other.category }, 0, 'Released by the final payment', actor);
    await tx.query("update claims.exposure set status = 'settled' where id = $1", [loaded.exposure.id]);
    await recordAudit(tx, { actor, action: 'exposure.status', entityType: 'claim', entityId: loaded.claim.id, reason: 'Final payment', details: { exposureNumber: loaded.exposure.number, from: 'approved', to: 'settled' } });
    await refreshClaimStatus(tx, loaded.claim.id, actor);
  }
  await recordEvent(tx, {
    type: 'ClaimPaymentIssued',
    aggregateType: 'claim',
    aggregateId: loaded.claim.id,
    payload: {
      claimNumber: loaded.claim.claimNumber,
      exposureNumber: loaded.exposure.number,
      amountPaise: payment.amount_paise,
      kind: payment.kind,
      method: payment.method,
      payeeKind: payment.payee_kind,
      reference: payment.reference,
    },
  });
}

// What can still be paid on the line and on the cover. Errors say what to do.
async function checkRoom(db: Q, exposure: Exposure, costType: CostType, category: string, amount: number): Promise<string[]> {
  const line = (await db.query<{ outstanding_paise: number }>('select outstanding_paise::float8 as outstanding_paise from claims.reserve_line where exposure_id = $1 and cost_type = $2 and category = $3', [exposure.id, costType, category])).rows[0];
  const errors: string[] = [];
  if (!line) errors.push(`There is no reserve for ${costType} ${category}; raise the reserve first`);
  else if (amount > line.outstanding_paise) errors.push(`Only ${line.outstanding_paise} paise is outstanding on this reserve line; raise the reserve first`);
  if (exposure.limitPaise !== null) {
    const used = (await db.query<{ used: number }>('select coalesce(sum(amount_paise), 0)::float8 as used from claims.claim_payment where exposure_id = $1', [exposure.id])).rows[0]?.used ?? 0;
    if (used + amount > exposure.limitPaise) errors.push(`This payment would go over the limit of the cover (${exposure.limitPaise} paise); ${exposure.limitPaise - used} paise left`);
  }
  return errors;
}

// Pays a claimant, garage or hospital from a reserve line. A payment inside the requester's authority is issued at once;
// a bigger one waits for a second person with enough authority. The same reference is the same payment.
export async function makePayment(db: Database, deps: ClaimsDependencies, exposureId: string, input: PaymentInput, actor: string): Promise<ClaimPayment> {
  const loaded = await load(db, exposureId);
  const { exposure, claim } = loaded;

  const earlier = (await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from claims.claim_payment where reference = $1`, [input.reference.trim()])).rows[0];
  if (earlier) {
    if (earlier.exposure_id !== exposureId || earlier.amount_paise !== input.amountPaise || earlier.method !== input.method) {
      throw new ValidationError([`The reference ${input.reference.trim()} was already used for a different payment`]);
    }
    return toPayment(earlier);
  }

  const errors: string[] = [];
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) errors.push('A payment must be a positive whole amount of paise');
  if (!COST_TYPES.includes(input.costType)) errors.push(`The cost type must be one of ${COST_TYPES.join(', ')}`);
  if (!deps.config.forDate(claim.reportedOn).reserve_categories.includes(input.category)) errors.push(`The category ${input.category} is not a reserve category`);
  if (!['partial', 'final'].includes(input.kind)) errors.push('A payment is partial or final');
  if (input.reference.trim() === '') errors.push('A payment reference is required');
  if (!isRealDate(input.paidOn)) errors.push('The date paid is not a real date (write it as yyyy-mm-dd)');
  const payee = checkPayee(input, exposure.claimant.name);
  errors.push(...payee.errors);
  if (errors.length > 0) throw new ValidationError(errors);

  if (exposure.status !== 'approved') throw new ValidationError([`Only an approved exposure can be paid (this one is ${exposure.status})`]);
  const room = await checkRoom(db, exposure, input.costType, input.category, input.amountPaise);
  if (room.length > 0) throw new ValidationError(room);
  const limits = await limitsOf(db, deps, claim, actor);
  if (limits === null) throw new PermissionError('claim.pay');
  const needsApproval = input.amountPaise > limits.payment;

  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<PaymentRow>(
      `insert into claims.claim_payment (exposure_id, cost_type, category, amount_paise, kind, payee_kind, payee_name, instrument, method, reference, note, paid_on, status, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13, $14) returning ${PAYMENT_COLUMNS}`,
      [exposureId, input.costType, input.category, input.amountPaise, input.kind, input.payee.kind, input.payee.name.trim(), payee.instrument, input.method, input.reference.trim(), input.note ?? null, input.paidOn, needsApproval ? 'pending_approval' : 'issued', actor],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('The payment was not saved');
    await recordAudit(tx, {
      actor,
      action: needsApproval ? 'payment.request' : 'payment.issue',
      entityType: 'claim',
      entityId: claim.id,
      details: { exposureNumber: exposure.number, amountPaise: input.amountPaise, kind: input.kind, method: input.method, reference: input.reference.trim() },
    });
    if (!needsApproval) await issue(tx, loaded, row, actor);
    return row.id;
  });
  const saved = (await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from claims.claim_payment where id = $1`, [id])).rows[0];
  if (!saved) throw new Error('The payment could not be read back');
  return toPayment(saved);
}

// A second person approves a payment that was above the requester's authority: a different person, with a payment limit
// that covers the amount, and a reason. Then the payment is issued.
export async function approvePayment(db: Database, deps: ClaimsDependencies, paymentId: string, approver: string, reason: string): Promise<ClaimPayment> {
  const row = isUuid(paymentId) ? (await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from claims.claim_payment where id = $1`, [paymentId])).rows[0] : undefined;
  if (!row) throw new ValidationError(['The payment does not exist']);
  if (row.status !== 'pending_approval') throw new ValidationError(['This payment is not waiting for approval']);
  const errors: string[] = [];
  if (reason.trim() === '') errors.push('A reason is required to approve a payment');
  if (approver === row.requested_by) errors.push('The approver must be a different person from the one who asked for the payment');
  if (errors.length > 0) throw new ValidationError(errors);

  const loaded = await load(db, row.exposure_id);
  const limits = await limitsOf(db, deps, loaded.claim, approver);
  if (limits === null || row.amount_paise > limits.payment) throw new PermissionError('claim.pay');
  if (loaded.exposure.status !== 'approved') throw new ValidationError([`Only an approved exposure can be paid (this one is ${loaded.exposure.status})`]);
  const line = (await db.query<{ outstanding_paise: number }>('select outstanding_paise::float8 as outstanding_paise from claims.reserve_line where exposure_id = $1 and cost_type = $2 and category = $3', [row.exposure_id, row.cost_type, row.category])).rows[0];
  if (!line || row.amount_paise > line.outstanding_paise) throw new ValidationError(['The reserve no longer covers this payment; raise the reserve first']);

  await db.transaction(async (tx) => {
    await tx.query("update claims.claim_payment set status = 'issued', approved_by = $2, approval_reason = $3 where id = $1", [paymentId, approver, reason.trim()]);
    await recordAudit(tx, { actor: approver, action: 'payment.approve', entityType: 'claim', entityId: loaded.claim.id, reason: reason.trim(), details: { exposureNumber: loaded.exposure.number, amountPaise: row.amount_paise, reference: row.reference } });
    await issue(tx, loaded, row, approver);
  });
  const saved = (await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from claims.claim_payment where id = $1`, [paymentId])).rows[0];
  if (!saved) throw new Error('The payment could not be read back');
  return toPayment(saved);
}

// ---------------------------------------------------------------- recoveries

export interface Recovery {
  id: string;
  exposureId: string;
  kind: (typeof RECOVERY_KINDS)[number];
  amountPaise: number;
  source: string;
  reference: string;
  receivedOn: string;
}

interface RecoveryRow {
  id: string;
  exposure_id: string;
  kind: Recovery['kind'];
  amount_paise: number;
  source: string;
  reference: string;
  received_on: string;
}

const toRecovery = (r: RecoveryRow): Recovery => ({ id: r.id, exposureId: r.exposure_id, kind: r.kind, amountPaise: r.amount_paise, source: r.source, reference: r.reference, receivedOn: r.received_on });
const RECOVERY_COLUMNS = "id, exposure_id, kind, amount_paise::float8 as amount_paise, source, reference, to_char(received_on, 'YYYY-MM-DD') as received_on";

// Money coming back: from another insurer (subrogation), from selling the wreck (salvage) or from the insured (deductible).
// It reduces what the claim has cost, and can never be more than was paid on the exposure.
export async function recordRecovery(
  db: Database,
  exposureId: string,
  input: { kind: Recovery['kind']; amountPaise: number; source: string; reference: string; receivedOn: string },
  actor: string,
): Promise<Recovery> {
  const { exposure, claim } = await load(db, exposureId);
  const earlier = (await db.query<RecoveryRow>(`select ${RECOVERY_COLUMNS} from claims.recovery where reference = $1`, [input.reference.trim()])).rows[0];
  if (earlier) {
    if (earlier.exposure_id !== exposureId || earlier.amount_paise !== input.amountPaise || earlier.kind !== input.kind) {
      throw new ValidationError([`The reference ${input.reference.trim()} was already used for a different recovery`]);
    }
    return toRecovery(earlier);
  }

  const errors: string[] = [];
  if (!RECOVERY_KINDS.includes(input.kind)) errors.push(`Recovery kind must be one of ${RECOVERY_KINDS.join(', ')}`);
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) errors.push('A recovery must be a positive whole amount of paise');
  if (input.source.trim() === '') errors.push('The source of the recovery is required');
  if (input.reference.trim() === '') errors.push('A recovery reference is required');
  if (!isRealDate(input.receivedOn)) errors.push('The date received is not a real date (write it as yyyy-mm-dd)');
  if (errors.length === 0) {
    const paid = (await db.query<{ paid: number }>("select coalesce(sum(amount_paise), 0)::float8 as paid from claims.claim_payment where exposure_id = $1 and status = 'issued'", [exposureId])).rows[0]?.paid ?? 0;
    const recovered = (await db.query<{ recovered: number }>('select coalesce(sum(amount_paise), 0)::float8 as recovered from claims.recovery where exposure_id = $1', [exposureId])).rows[0]?.recovered ?? 0;
    if (recovered + input.amountPaise > paid) errors.push(`A recovery cannot be more than was paid (${paid} paise paid so far on this exposure, ${recovered} already recovered)`);
  }
  if (errors.length > 0) throw new ValidationError(errors);

  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>('insert into claims.recovery (exposure_id, kind, amount_paise, source, reference, received_on, created_by) values ($1, $2, $3, $4, $5, $6::date, $7) returning id', [
      exposureId, input.kind, input.amountPaise, input.source.trim(), input.reference.trim(), input.receivedOn, actor,
    ]);
    await recordAudit(tx, { actor, action: 'recovery.record', entityType: 'claim', entityId: claim.id, details: { exposureNumber: exposure.number, kind: input.kind, amountPaise: input.amountPaise, reference: input.reference.trim() } });
    return inserted.rows[0]?.id ?? '';
  });
  const saved = (await db.query<RecoveryRow>(`select ${RECOVERY_COLUMNS} from claims.recovery where id = $1`, [id])).rows[0];
  if (!saved) throw new Error('The recovery could not be read back');
  return toRecovery(saved);
}

// ---------------------------------------------------------------- the financial view

export interface Money {
  paidPaise: number;
  outstandingPaise: number;
  recoveredPaise: number;
  incurredPaise: number; // paid + outstanding - recovered
}

const money = (paid: number, outstanding: number, recovered: number): Money => ({ paidPaise: paid, outstandingPaise: outstanding, recoveredPaise: recovered, incurredPaise: paid + outstanding - recovered });

export async function getFinancials(db: Q, claimIdOrNumber: string): Promise<{ claim: Money; exposures: (Money & { number: number; status: string })[]; byCostType: Record<CostType, Money> }> {
  const claim = await getClaim(db, claimIdOrNumber);
  if (claim === null) throw new ValidationError(['The claim does not exist']);
  const exposures = (await db.query<Parameters<typeof toExposure>[0]>(`select ${EXPOSURE_COLUMNS} from claims.exposure where claim_id = $1 order by number`, [claim.id])).rows.map(toExposure);

  const rows: (Money & { number: number; status: string })[] = [];
  const byType: Record<CostType, { paid: number; outstanding: number; recovered: number }> = {
    claim_cost: { paid: 0, outstanding: 0, recovered: 0 },
    expense: { paid: 0, outstanding: 0, recovered: 0 },
  };
  for (const e of exposures) {
    const paid = await db.query<{ cost_type: CostType; total: number }>("select cost_type, sum(amount_paise)::float8 as total from claims.claim_payment where exposure_id = $1 and status = 'issued' group by cost_type", [e.id]);
    const outstanding = await db.query<{ cost_type: CostType; total: number }>('select cost_type, sum(outstanding_paise)::float8 as total from claims.reserve_line where exposure_id = $1 group by cost_type', [e.id]);
    const recovered = (await db.query<{ total: number }>('select coalesce(sum(amount_paise), 0)::float8 as total from claims.recovery where exposure_id = $1', [e.id])).rows[0]?.total ?? 0;
    for (const r of paid.rows) byType[r.cost_type].paid += r.total;
    for (const r of outstanding.rows) byType[r.cost_type].outstanding += r.total;
    byType.claim_cost.recovered += recovered; // recoveries reduce the cost of the claim, not its expenses
    const sum = (list: { total: number }[]): number => list.reduce((a, b) => a + b.total, 0);
    rows.push({ number: e.number, status: e.status, ...money(sum(paid.rows), sum(outstanding.rows), recovered) });
  }
  const total = rows.reduce((t, r) => ({ paid: t.paid + r.paidPaise, outstanding: t.outstanding + r.outstandingPaise, recovered: t.recovered + r.recoveredPaise }), { paid: 0, outstanding: 0, recovered: 0 });
  return {
    claim: money(total.paid, total.outstanding, total.recovered),
    exposures: rows,
    byCostType: {
      claim_cost: money(byType.claim_cost.paid, byType.claim_cost.outstanding, byType.claim_cost.recovered),
      expense: money(byType.expense.paid, byType.expense.outstanding, byType.expense.recovered),
    },
  };
}
