import type { Database } from '../platform/index.js';
import { addDays, daysBetween, isRealDate, isUuid, recordAudit, recordEvent, ValidationError } from '../platform/index.js';
import { allocate, type Q } from './allocation.js';
import { getBillingAccount } from './billing.js';
import type { BillingConfigCatalogue } from './config.js';

// Payments, refunds and missed payments (document section 14). Money in is allocated to the oldest amount due. Money
// that cannot be matched to an account waits in suspense. Return premium (a credit) is applied to what the customer
// owes or paid out. A late invoice goes through timed steps, the last of which asks Policy to cancel.

export const PAYMENT_METHODS = ['upi', 'enach', 'card', 'bank_transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface Payment {
  id: string;
  billingAccountId: string | null; // null while the payment is in suspense
  policyNumber: string | null;
  amountPaise: number;
  method: PaymentMethod;
  reference: string;
  receivedOn: string;
  allocatedPaise: number;
  unappliedPaise: number;
}

interface PaymentRow {
  id: string;
  billing_account_id: string | null;
  policy_number: string | null;
  amount_paise: number;
  method: PaymentMethod;
  reference: string;
  received_on: string;
  allocated: number;
}

const PAYMENT_SELECT = `select p.id, p.billing_account_id, p.policy_number, p.amount_paise::float8 as amount_paise, p.method, p.reference, to_char(p.received_on, 'YYYY-MM-DD') as received_on,
    coalesce((select sum(a.amount_paise) from billing.allocation a where a.payment_id = p.id), 0)::float8 as allocated
  from billing.payment p`;

const toPayment = (r: PaymentRow): Payment => ({
  id: r.id,
  billingAccountId: r.billing_account_id,
  policyNumber: r.policy_number,
  amountPaise: r.amount_paise,
  method: r.method,
  reference: r.reference,
  receivedOn: r.received_on,
  allocatedPaise: r.allocated,
  unappliedPaise: r.amount_paise - r.allocated,
});

export async function getPayment(db: Q, id: string): Promise<Payment | null> {
  if (!isUuid(id)) return null;
  const row = (await db.query<PaymentRow>(`${PAYMENT_SELECT} where p.id = $1`, [id])).rows[0];
  return row ? toPayment(row) : null;
}

// Payments waiting for someone to say whose they are.
export async function listSuspense(db: Q): Promise<Payment[]> {
  const result = await db.query<PaymentRow>(`${PAYMENT_SELECT} where p.billing_account_id is null order by p.received_on, p.seq`);
  return result.rows.map(toPayment);
}

export interface NewPayment {
  amountPaise: number;
  method: PaymentMethod;
  reference: string;
  receivedOn: string;
  policyNumber?: string; // when the payer says which policy it is for, only that policy is paid
  note?: string;
}

function checkPayment(input: NewPayment): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) errors.push('A payment must be a positive whole amount of paise');
  if (!PAYMENT_METHODS.includes(input.method)) errors.push(`The payment method must be one of ${PAYMENT_METHODS.join(', ')}`);
  if (input.reference.trim() === '') errors.push('A payment reference is required');
  if (!isRealDate(input.receivedOn)) errors.push('The date received is not a real date (write it as yyyy-mm-dd)');
  return errors;
}

// The same reference is the same payment (a gateway may call twice). If the details differ, something is wrong.
async function existingPayment(tx: Q, input: NewPayment, billingAccountId: string | null): Promise<Payment | null> {
  const found = (await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.reference = $1`, [input.reference.trim()])).rows[0];
  if (!found) return null;
  if (found.amount_paise !== input.amountPaise || found.billing_account_id !== billingAccountId) {
    throw new ValidationError([`The reference ${input.reference.trim()} was already used for a different payment`]);
  }
  return toPayment(found);
}

async function announce(tx: Q, payment: Payment, accountId: string): Promise<void> {
  if (payment.billingAccountId === null) return;
  await recordEvent(tx, {
    type: 'PaymentReceived',
    aggregateType: 'billing_account',
    aggregateId: payment.billingAccountId,
    payload: { accountId, amountPaise: payment.amountPaise, allocatedPaise: payment.allocatedPaise, unappliedPaise: payment.unappliedPaise, reference: payment.reference, method: payment.method },
  });
}

// Takes a payment for an account and allocates it, oldest invoice first. What is left stays as unapplied cash.
export async function receivePayment(db: Database, input: NewPayment & { accountId: string }, actor: string): Promise<Payment> {
  const errors = checkPayment(input);
  const account = await getBillingAccount(db, input.accountId);
  if (account === null) errors.push('There is no billing account for that account; use receiveUnmatchedPayment to hold the money in suspense');
  if (errors.length > 0 || account === null) throw new ValidationError(errors);

  const id = await db.transaction(async (tx) => {
    const again = await existingPayment(tx, input, account.id);
    if (again) return again.id;
    const inserted = await tx.query<{ id: string }>(
      'insert into billing.payment (billing_account_id, policy_number, amount_paise, method, reference, received_on, note, created_by) values ($1, $2, $3, $4, $5, $6::date, $7, $8) returning id',
      [account.id, input.policyNumber ?? null, input.amountPaise, input.method, input.reference.trim(), input.receivedOn, input.note ?? null, actor],
    );
    const paymentId = inserted.rows[0]?.id ?? '';
    await allocate(tx, account.id, { paymentId }, input.amountPaise, actor, input.policyNumber ?? null);
    const saved = await getPayment(tx, paymentId);
    if (saved) await announce(tx, saved, input.accountId);
    await recordAudit(tx, { actor, action: 'payment.receive', entityType: 'payment', entityId: paymentId, details: { amountPaise: input.amountPaise, method: input.method, reference: input.reference.trim() } });
    return paymentId;
  });
  const saved = await getPayment(db, id);
  if (saved === null) throw new Error('The payment could not be read back');
  return saved;
}

// A payment that cannot be matched to an account yet (an unknown transfer) goes to suspense.
export async function receiveUnmatchedPayment(db: Database, input: NewPayment, actor: string): Promise<Payment> {
  const errors = checkPayment(input);
  if (errors.length > 0) throw new ValidationError(errors);
  const id = await db.transaction(async (tx) => {
    const again = await existingPayment(tx, input, null);
    if (again) return again.id;
    const inserted = await tx.query<{ id: string }>(
      'insert into billing.payment (amount_paise, method, reference, received_on, note, created_by) values ($1, $2, $3, $4::date, $5, $6) returning id',
      [input.amountPaise, input.method, input.reference.trim(), input.receivedOn, input.note ?? null, actor],
    );
    const paymentId = inserted.rows[0]?.id ?? '';
    await recordAudit(tx, { actor, action: 'payment.suspense', entityType: 'payment', entityId: paymentId, details: { amountPaise: input.amountPaise, method: input.method, reference: input.reference.trim() } });
    return paymentId;
  });
  const saved = await getPayment(db, id);
  if (saved === null) throw new Error('The payment could not be read back');
  return saved;
}

// Someone works out whose payment it is: it leaves suspense and is allocated like any other.
export async function matchSuspense(db: Database, paymentId: string, accountId: string, actor: string): Promise<Payment> {
  const payment = await getPayment(db, paymentId);
  if (payment === null) throw new ValidationError(['The payment does not exist']);
  if (payment.billingAccountId !== null) throw new ValidationError(['This payment is not in suspense']);
  const account = await getBillingAccount(db, accountId);
  if (account === null) throw new ValidationError(['There is no billing account for that account']);

  await db.transaction(async (tx) => {
    await tx.query('update billing.payment set billing_account_id = $2 where id = $1', [paymentId, account.id]);
    await allocate(tx, account.id, { paymentId }, payment.amountPaise, actor, payment.policyNumber);
    const saved = await getPayment(tx, paymentId);
    if (saved) await announce(tx, saved, accountId);
    await recordAudit(tx, { actor, action: 'payment.match', entityType: 'payment', entityId: paymentId, details: { billingAccountId: account.id } });
  });
  const saved = await getPayment(db, paymentId);
  if (saved === null) throw new Error('The payment could not be read back');
  return saved;
}

// ---------------------------------------------------------------- credits

interface CreditRow {
  id: string;
  billing_account_id: string;
  policy_number: string;
  total_paise: number;
  applied: number;
  paid_out: number;
}

const CREDIT_SELECT = `select c.id, c.billing_account_id, c.policy_number, c.total_paise::float8 as total_paise,
    coalesce((select sum(a.amount_paise) from billing.allocation a where a.credit_id = c.id), 0)::float8 as applied,
    coalesce((select sum(o.amount_paise) from billing.payout o where o.credit_id = c.id), 0)::float8 as paid_out
  from billing.credit c`;

async function getCredit(tx: Q, creditId: string): Promise<CreditRow | null> {
  if (!isUuid(creditId)) return null;
  return (await tx.query<CreditRow>(`${CREDIT_SELECT} where c.id = $1`, [creditId])).rows[0] ?? null;
}

async function closeIfSpent(tx: Q, credit: CreditRow, appliedNow: number, paidOutNow: number): Promise<void> {
  const remaining = credit.total_paise - credit.applied - credit.paid_out - appliedNow - paidOutNow;
  if (remaining > 0) return;
  await tx.query('update billing.credit set status = $2 where id = $1', [credit.id, credit.paid_out + paidOutNow > 0 ? 'refunded' : 'applied']);
}

// Uses a credit against what the customer owes, oldest invoice first. Whatever it cannot be used on stays as credit.
export async function applyCredit(db: Database, creditId: string, actor: string): Promise<{ creditId: string; appliedPaise: number; remainingPaise: number }> {
  const credit = await getCredit(db, creditId);
  if (credit === null) throw new ValidationError(['The credit does not exist']);
  const remaining = credit.total_paise - credit.applied - credit.paid_out;
  if (remaining <= 0) throw new ValidationError(['There is nothing left in this credit']);

  const applied = await db.transaction(async (tx) => {
    const done = await allocate(tx, credit.billing_account_id, { creditId }, remaining, actor, null);
    await closeIfSpent(tx, credit, done, 0);
    await recordAudit(tx, { actor, action: 'credit.apply', entityType: 'credit', entityId: creditId, details: { appliedPaise: done } });
    return done;
  });
  return { creditId, appliedPaise: applied, remainingPaise: remaining - applied };
}

export interface Payout {
  id: string;
  creditId: string;
  amountPaise: number;
  method: PaymentMethod;
  reference: string;
  paidOn: string;
}

// Pays a credit out to the customer. Cash goes back only if it was received: at most what the customer paid for the
// policy beyond what the insurer keeps, and not more than the credit has left. Otherwise the credit is applied instead.
export async function refundCredit(
  db: Database,
  creditId: string,
  input: { method: PaymentMethod; reference: string; paidOn: string; amountPaise?: number },
  actor: string,
): Promise<Payout> {
  const credit = await getCredit(db, creditId);
  if (credit === null) throw new ValidationError(['The credit does not exist']);
  const errors: string[] = [];
  if (!PAYMENT_METHODS.includes(input.method)) errors.push(`The payment method must be one of ${PAYMENT_METHODS.join(', ')}`);
  if (input.reference.trim() === '') errors.push('A payout reference is required');
  if (!isRealDate(input.paidOn)) errors.push('The date paid is not a real date (write it as yyyy-mm-dd)');
  const remaining = credit.total_paise - credit.applied - credit.paid_out;
  if (remaining <= 0) errors.push('There is nothing left to refund in this credit');
  if (errors.length > 0) throw new ValidationError(errors);

  // What the customer paid for this policy, and what the insurer keeps of it (all its charges, refunds included, net).
  const paid = (
    await db.query<{ paid: number }>(
      `select coalesce(sum(a.amount_paise), 0)::float8 as paid from billing.allocation a
         join billing.invoice_line l on l.id = a.invoice_line_id
         join billing.invoice i on i.id = l.invoice_id
        where a.payment_id is not null and i.billing_account_id = $1 and l.policy_number = $2`,
      [credit.billing_account_id, credit.policy_number],
    )
  ).rows[0]?.paid ?? 0;
  const kept = (await db.query<{ kept: number }>('select coalesce(sum(amount_paise), 0)::float8 as kept from billing.charge where billing_account_id = $1 and policy_number = $2', [credit.billing_account_id, credit.policy_number])).rows[0]?.kept ?? 0;
  const earlier = (
    await db.query<{ out: number }>(
      'select coalesce(sum(o.amount_paise), 0)::float8 as out from billing.payout o join billing.credit c on c.id = o.credit_id where c.billing_account_id = $1 and c.policy_number = $2',
      [credit.billing_account_id, credit.policy_number],
    )
  ).rows[0]?.out ?? 0;
  const cap = Math.max(0, Math.min(remaining, paid - kept - earlier));
  const amount = input.amountPaise ?? cap;
  if (cap === 0 || amount <= 0) {
    throw new ValidationError([`The customer has paid ${paid} paise for the policy and the insurer keeps ${kept}, so nothing can be paid out in cash; apply the credit to what the customer owes instead`]);
  }
  if (!Number.isInteger(amount) || amount > cap) throw new ValidationError([`At most ${cap} paise can be paid out`]);

  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>('insert into billing.payout (credit_id, amount_paise, method, reference, paid_on, created_by) values ($1, $2, $3, $4, $5::date, $6) returning id', [
      creditId,
      amount,
      input.method,
      input.reference.trim(),
      input.paidOn,
      actor,
    ]);
    await closeIfSpent(tx, credit, 0, amount);
    const payoutId = inserted.rows[0]?.id ?? '';
    await recordAudit(tx, { actor, action: 'credit.refund', entityType: 'credit', entityId: creditId, details: { amountPaise: amount, method: input.method, reference: input.reference.trim() } });
    return payoutId;
  });
  return { id, creditId, amountPaise: amount, method: input.method, reference: input.reference.trim(), paidOn: input.paidOn };
}

// ---------------------------------------------------------------- missed payments

export interface DelinquencyAction {
  invoiceNumber: string;
  action: 'reminder' | 'final_notice' | 'cancellation_request';
  doneOn: string;
}

const EVENT_FOR: Record<DelinquencyAction['action'], string> = {
  reminder: 'DelinquencyStarted',
  final_notice: 'FinalNoticeDue',
  cancellation_request: 'CancellationRequested',
};

export async function listDelinquencySteps(db: Q, invoiceId: string): Promise<{ action: string; doneOn: string }[]> {
  const result = await db.query<{ action: string; done_on: string }>("select action, to_char(done_on, 'YYYY-MM-DD') as done_on from billing.delinquency_step where invoice_id = $1 order by seq", [invoiceId]);
  return result.rows.map((r) => ({ action: r.action, doneOn: r.done_on }));
}

// The delinquency batch (document section 14): for every open invoice that is still unpaid after its due date plus the
// plan's grace days, do the timed steps that have come due and not been done: a reminder, a final notice, and a
// cancellation request that Policy picks up. A step is done once per invoice. Each step is announced as an event.
export async function runDelinquency(db: Database, config: BillingConfigCatalogue, options: { today: string }, actor: string): Promise<DelinquencyAction[]> {
  if (!isRealDate(options.today)) throw new ValidationError(['The date is not a real date (write it as yyyy-mm-dd)']);
  const current = config.forDate(options.today);
  const plans = new Map(current.plans.map((p) => [p.code, p]));
  const open = await db.query<{ id: string; number: string; due_date: string; plan_code: string; billing_account_id: string; account_id: string; outstanding: number }>(
    `select i.id, i.number, to_char(i.due_date, 'YYYY-MM-DD') as due_date, a.plan_code, a.id as billing_account_id, a.account_id,
            (i.total_paise - coalesce((select sum(l.paid_paise) from billing.invoice_line l where l.invoice_id = i.id), 0))::float8 as outstanding
       from billing.invoice i join billing.account a on a.id = i.billing_account_id
      where i.status = 'open' order by i.due_date, i.number`,
  );

  const done: DelinquencyAction[] = [];
  for (const invoice of open.rows) {
    if (invoice.outstanding <= 0) continue;
    const grace = plans.get(invoice.plan_code)?.grace_days ?? 0;
    for (const step of current.delinquency) {
      if (options.today < addDays(invoice.due_date, grace + step.days_after_grace)) break; // later steps are later still
      const already = await db.query('select 1 from billing.delinquency_step where invoice_id = $1 and action = $2', [invoice.id, step.action]);
      if (already.rows.length > 0) continue;
      await db.transaction(async (tx) => {
        const policies = await tx.query<{ policy_number: string }>('select distinct policy_number from billing.invoice_line where invoice_id = $1 and paid_paise < amount_paise order by policy_number', [invoice.id]);
        await tx.query('insert into billing.delinquency_step (invoice_id, action, done_on) values ($1, $2, $3::date)', [invoice.id, step.action, options.today]);
        await recordEvent(tx, {
          type: EVENT_FOR[step.action],
          aggregateType: 'billing_account',
          aggregateId: invoice.billing_account_id,
          payload: {
            accountId: invoice.account_id,
            invoiceNumber: invoice.number,
            dueDate: invoice.due_date,
            action: step.action,
            overdueDays: daysBetween(invoice.due_date, options.today),
            outstandingPaise: invoice.outstanding,
            policyNumbers: policies.rows.map((p) => p.policy_number),
          },
        });
        await recordAudit(tx, { actor, action: `delinquency.${step.action}`, entityType: 'invoice', entityId: invoice.id, details: { invoiceNumber: invoice.number, overdueDays: daysBetween(invoice.due_date, options.today) } });
      });
      done.push({ invoiceNumber: invoice.number, action: step.action, doneOn: options.today });
    }
  }
  return done;
}

