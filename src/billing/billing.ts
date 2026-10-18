import type { Database } from '../platform/index.js';
import { z } from 'zod';
import { addDays, isRealDate, isUuid, listEventsAfter, recordAudit, recordEvent, ValidationError } from '../platform/index.js';
import type { OutboxEvent } from '../platform/index.js';
import type { BillingConfigCatalogue } from './config.js';
import { allocateUnapplied } from './allocation.js';
import { splitCharge, type ScheduleItem } from './plan-split.js';

// Billing (document section 14). It learns about policies only through events from the outbox (section 17): when a
// policy is bound, renewed, reinstated or cancelled, Policy says how much premium and tax changed, and Billing turns
// that into charges, payment items by the payment plan, credits for refunds, and invoices. It never reads Policy's tables.

type Q = Pick<Database, 'query'>;

const CONSUMER = 'billing';
// The events that carry money. Every other event is passed over.
const MONEY_EVENTS = ['PolicyBound', 'PolicyRenewed', 'PolicyReinstated', 'PolicyCancelled'];

const moneyEventSchema = z.object({
  policyNumber: z.string().min(1),
  accountId: z.uuid(),
  version: z.number().int(),
  termNumber: z.number().int(),
  reinstatementDate: z.string().nullish(), // a reinstatement with a gap: the first day covered again
  transaction: z.object({
    kind: z.enum(['new_business', 'change', 'cancellation', 'reinstatement', 'renewal']),
    effectiveDate: z.string().refine(isRealDate),
    premiumPaise: z.number().int(),
    taxPaise: z.number().int(),
    totalPaise: z.number().int(),
  }),
});

// ---------------------------------------------------------------- reading

export interface BillingAccount {
  id: string;
  accountId: string; // the account in Policy
  planCode: string;
  status: 'active' | 'closed';
}

export interface Charge {
  id: string;
  sourceEventId: number;
  policyNumber: string;
  termNumber: number;
  version: number;
  kind: string;
  type: 'premium' | 'tax';
  effectiveDate: string;
  amountPaise: number; // negative for a refund
}

export interface BillingScheduleItem {
  id: string;
  sourceEventId: number;
  policyNumber: string;
  kind: string;
  sequence: number;
  dueDate: string;
  premiumPaise: number;
  taxPaise: number;
  feePaise: number;
  amountPaise: number;
  status: 'scheduled' | 'invoiced' | 'paid' | 'void';
  invoiceId: string | null;
}

export interface Credit {
  id: string;
  sourceEventId: number;
  policyNumber: string;
  kind: string;
  effectiveDate: string;
  premiumPaise: number;
  taxPaise: number;
  totalPaise: number;
  remainingPaise: number; // what is left to apply or pay out
  status: 'open' | 'refunded' | 'applied';
}

export interface Invoice {
  id: string;
  number: string;
  billingAccountId: string;
  invoiceDate: string;
  dueDate: string;
  premiumPaise: number;
  taxPaise: number;
  feePaise: number;
  totalPaise: number;
  paidPaise: number;
  outstandingPaise: number;
  status: 'open' | 'paid' | 'void';
}

export interface InvoiceLine {
  scheduleItemId: string;
  policyNumber: string;
  description: string;
  premiumPaise: number;
  taxPaise: number;
  feePaise: number;
  amountPaise: number;
  paidPaise: number;
}

// Money columns are bigint; they are read as float8, which is exact for whole numbers far beyond any premium.
const DATE = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

export async function getBillingAccount(db: Q, accountId: string): Promise<BillingAccount | null> {
  if (!isUuid(accountId)) return null;
  const row = (await db.query<{ id: string; account_id: string; plan_code: string; status: 'active' | 'closed' }>('select id, account_id, plan_code, status from billing.account where account_id = $1', [accountId])).rows[0];
  return row ? { id: row.id, accountId: row.account_id, planCode: row.plan_code, status: row.status } : null;
}

export async function listCharges(db: Q, billingAccountId: string): Promise<Charge[]> {
  const result = await db.query<{ id: string; source_event_id: number; policy_number: string; term_number: number; version: number; kind: string; type: 'premium' | 'tax'; effective_date: string; amount_paise: number }>(
    `select id, source_event_id::float8 as source_event_id, policy_number, term_number, version, kind, type, ${DATE('effective_date')} as effective_date, amount_paise::float8 as amount_paise
       from billing.charge where billing_account_id = $1 order by source_event_id, (type = 'tax')`,
    [billingAccountId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    sourceEventId: r.source_event_id,
    policyNumber: r.policy_number,
    termNumber: r.term_number,
    version: r.version,
    kind: r.kind,
    type: r.type,
    effectiveDate: r.effective_date,
    amountPaise: r.amount_paise,
  }));
}

export async function listScheduleItems(db: Q, billingAccountId: string): Promise<BillingScheduleItem[]> {
  const result = await db.query<{
    id: string; source_event_id: number; policy_number: string; kind: string; sequence: number; due_date: string;
    premium_paise: number; tax_paise: number; fee_paise: number; amount_paise: number; status: BillingScheduleItem['status']; invoice_id: string | null;
  }>(
    `select id, source_event_id::float8 as source_event_id, policy_number, kind, sequence, ${DATE('due_date')} as due_date, premium_paise::float8 as premium_paise,
            tax_paise::float8 as tax_paise, fee_paise::float8 as fee_paise, amount_paise::float8 as amount_paise, status, invoice_id
       from billing.schedule_item where billing_account_id = $1 order by source_event_id, sequence`,
    [billingAccountId],
  );
  return result.rows.map((r) => ({
    id: r.id, sourceEventId: r.source_event_id, policyNumber: r.policy_number, kind: r.kind, sequence: r.sequence, dueDate: r.due_date,
    premiumPaise: r.premium_paise, taxPaise: r.tax_paise, feePaise: r.fee_paise, amountPaise: r.amount_paise, status: r.status, invoiceId: r.invoice_id,
  }));
}

export async function listCredits(db: Q, billingAccountId: string): Promise<Credit[]> {
  const result = await db.query<{ id: string; source_event_id: number; policy_number: string; kind: string; effective_date: string; premium_paise: number; tax_paise: number; total_paise: number; remaining: number; status: Credit['status'] }>(
    `select c.id, c.source_event_id::float8 as source_event_id, c.policy_number, c.kind, ${DATE('c.effective_date')} as effective_date, c.premium_paise::float8 as premium_paise,
            c.tax_paise::float8 as tax_paise, c.total_paise::float8 as total_paise,
            (c.total_paise - coalesce((select sum(a.amount_paise) from billing.allocation a where a.credit_id = c.id), 0)
                           - coalesce((select sum(o.amount_paise) from billing.payout o where o.credit_id = c.id), 0))::float8 as remaining, c.status
       from billing.credit c where c.billing_account_id = $1 order by c.source_event_id`,
    [billingAccountId],
  );
  return result.rows.map((r) => ({
    id: r.id, sourceEventId: r.source_event_id, policyNumber: r.policy_number, kind: r.kind, effectiveDate: r.effective_date,
    premiumPaise: r.premium_paise, taxPaise: r.tax_paise, totalPaise: r.total_paise, remainingPaise: r.remaining, status: r.status,
  }));
}

interface InvoiceRow {
  id: string; number: string; billing_account_id: string; invoice_date: string; due_date: string;
  premium_paise: number; tax_paise: number; fee_paise: number; total_paise: number; paid_paise: number; status: Invoice['status'];
}

const INVOICE_COLUMNS = `id, number, billing_account_id, ${DATE('invoice_date')} as invoice_date, ${DATE('due_date')} as due_date, premium_paise::float8 as premium_paise,
  tax_paise::float8 as tax_paise, fee_paise::float8 as fee_paise, total_paise::float8 as total_paise,
  (select coalesce(sum(l.paid_paise), 0) from billing.invoice_line l where l.invoice_id = billing.invoice.id)::float8 as paid_paise, status`;

const toInvoice = (r: InvoiceRow): Invoice => ({
  id: r.id, number: r.number, billingAccountId: r.billing_account_id, invoiceDate: r.invoice_date, dueDate: r.due_date,
  premiumPaise: r.premium_paise, taxPaise: r.tax_paise, feePaise: r.fee_paise, totalPaise: r.total_paise, paidPaise: r.paid_paise,
  outstandingPaise: r.total_paise - r.paid_paise, status: r.status,
});

export async function listInvoices(db: Q, billingAccountId: string): Promise<Invoice[]> {
  const result = await db.query<InvoiceRow>(`select ${INVOICE_COLUMNS} from billing.invoice where billing_account_id = $1 order by number`, [billingAccountId]);
  return result.rows.map(toInvoice);
}

export async function getInvoice(db: Q, id: string): Promise<(Invoice & { lines: InvoiceLine[] }) | null> {
  if (!isUuid(id)) return null;
  const row = (await db.query<InvoiceRow>(`select ${INVOICE_COLUMNS} from billing.invoice where id = $1`, [id])).rows[0];
  if (!row) return null;
  const lines = await db.query<{ schedule_item_id: string; policy_number: string; description: string; premium_paise: number; tax_paise: number; fee_paise: number; amount_paise: number; paid_paise: number }>(
    `select l.schedule_item_id, l.policy_number, l.description, l.premium_paise::float8 as premium_paise, l.tax_paise::float8 as tax_paise,
            l.fee_paise::float8 as fee_paise, l.amount_paise::float8 as amount_paise, l.paid_paise::float8 as paid_paise
       from billing.invoice_line l join billing.schedule_item s on s.id = l.schedule_item_id where l.invoice_id = $1 order by s.source_event_id, s.sequence`,
    [id],
  );
  return {
    ...toInvoice(row),
    lines: lines.rows.map((l) => ({ scheduleItemId: l.schedule_item_id, policyNumber: l.policy_number, description: l.description, premiumPaise: l.premium_paise, taxPaise: l.tax_paise, feePaise: l.fee_paise, amountPaise: l.amount_paise, paidPaise: l.paid_paise })),
  };
}

// ---------------------------------------------------------------- payment plan

// Chooses the payment plan of an account, creating its billing account if it has none yet. Only possible before the
// first charge: after that the plan has already been used to split money.
export async function setPaymentPlan(db: Database, config: BillingConfigCatalogue, accountId: string, planCode: string, actor: string, options: { today?: string } = {}): Promise<BillingAccount> {
  if (!isUuid(accountId)) throw new ValidationError(['The account id is not valid']);
  const current = config.forDate(options.today ?? new Date().toISOString().slice(0, 10));
  if (!current.plans.some((p) => p.code === planCode)) throw new ValidationError([`Payment plan ${planCode} does not exist`]);

  const existing = await getBillingAccount(db, accountId);
  if (existing !== null) {
    const charged = await db.query('select 1 from billing.charge where billing_account_id = $1 limit 1', [existing.id]);
    if (charged.rows.length > 0) throw new ValidationError(['The payment plan can be changed only before the first charge']);
  }
  await db.transaction(async (tx) => {
    const id =
      existing?.id ??
      (await tx.query<{ id: string }>('insert into billing.account (account_id, plan_code) values ($1, $2) returning id', [accountId, planCode])).rows[0]?.id ?? '';
    if (existing !== null) await tx.query('update billing.account set plan_code = $2 where id = $1', [existing.id, planCode]);
    await recordAudit(tx, { actor, action: 'billing.plan', entityType: 'billing_account', entityId: id, details: { planCode, accountId } });
  });
  const saved = await getBillingAccount(db, accountId);
  if (saved === null) throw new Error('The billing account could not be read back');
  return saved;
}

// ---------------------------------------------------------------- the event consumer

async function accountFor(tx: Q, config: BillingConfigCatalogue, accountId: string, today: string): Promise<BillingAccount> {
  const found = await getBillingAccount(tx, accountId);
  if (found) return found;
  const planCode = config.forDate(today).default_plan;
  const id = (await tx.query<{ id: string }>('insert into billing.account (account_id, plan_code) values ($1, $2) returning id', [accountId, planCode])).rows[0]?.id ?? '';
  return { id, accountId, planCode, status: 'active' };
}

// Turns one policy event into charges, payment items and a credit. Returns true when it created charges.
async function handleMoneyEvent(tx: Q, config: BillingConfigCatalogue, event: OutboxEvent): Promise<boolean> {
  const parsed = moneyEventSchema.safeParse(event.payload);
  if (!parsed.success) throw new ValidationError([`Event ${event.id} (${event.type}) has an invalid payload: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`]);
  const { policyNumber, accountId, version, termNumber, transaction, reinstatementDate } = parsed.data;
  const { kind, effectiveDate, premiumPaise, taxPaise } = transaction;
  const total = premiumPaise + taxPaise;
  if (total === 0) return false;

  // Seeing an event twice must change nothing (document section 17).
  const done = await tx.query('select 1 from billing.charge where source_event_id = $1 limit 1', [event.id]);
  if (done.rows.length > 0) return false;

  const today = event.createdAt.slice(0, 10);
  const account = await accountFor(tx, config, accountId, today);
  const plan = config.forDate(today).plans.find((p) => p.code === account.planCode);
  if (!plan) throw new ValidationError([`The payment plan ${account.planCode} of the billing account is not in the billing configuration`]);

  for (const [type, amount] of [['premium', premiumPaise], ['tax', taxPaise]] as const) {
    await tx.query(
      `insert into billing.charge (billing_account_id, source_event_id, policy_id, policy_number, term_number, version, kind, type, effective_date, amount_paise)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10)`,
      [account.id, event.id, event.aggregateId, policyNumber, termNumber, version, kind, type, effectiveDate, amount],
    );
  }

  // A reinstated policy is covered again, so the payments that were cancelled with it fall due again.
  if (kind === 'reinstatement') {
    await tx.query("update billing.schedule_item set status = 'scheduled' where billing_account_id = $1 and policy_number = $2 and status = 'void' and due_date >= $3::date", [account.id, policyNumber, reinstatementDate ?? effectiveDate]);
  }

  let items = 0;
  if (total > 0) {
    // A new term is paid by the plan. A change or reinstatement is billed in one payment on its effective date.
    const schedule: ScheduleItem[] =
      kind === 'new_business' || kind === 'renewal'
        ? splitCharge({ premiumPaise, taxPaise }, plan, effectiveDate)
        : [{ sequence: 1, dueDate: effectiveDate, premiumPaise, taxPaise, feePaise: 0, amountPaise: total }];
    for (const item of schedule) {
      await tx.query(
        `insert into billing.schedule_item (billing_account_id, source_event_id, policy_number, kind, sequence, due_date, premium_paise, tax_paise, fee_paise, amount_paise)
         values ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10)`,
        [account.id, event.id, policyNumber, kind, item.sequence, item.dueDate, item.premiumPaise, item.taxPaise, item.feePaise, item.amountPaise],
      );
    }
    items = schedule.length;
  } else {
    // The cover has ended: payments that would fall due from the effective date, and are not invoiced yet, are cancelled.
    if (kind === 'cancellation') {
      await tx.query("update billing.schedule_item set status = 'void' where billing_account_id = $1 and policy_number = $2 and status = 'scheduled' and due_date >= $3::date", [account.id, policyNumber, effectiveDate]);
    }
    await tx.query(
      `insert into billing.credit (billing_account_id, source_event_id, policy_number, kind, effective_date, premium_paise, tax_paise, total_paise)
       values ($1, $2, $3, $4, $5::date, $6, $7, $8)`,
      [account.id, event.id, policyNumber, kind, effectiveDate, -premiumPaise, -taxPaise, -total],
    );
  }
  await recordEvent(tx, { type: 'ChargesCreated', aggregateType: 'billing_account', aggregateId: account.id, payload: { accountId, policyNumber, kind, totalPaise: total, items } });
  return true;
}

// Reads the events it has not handled yet, in order, and creates the charges. A batch is saved together with the new
// offset or not at all: if one event is bad, nothing from the batch is kept and the offset does not move.
export async function processPolicyEvents(db: Database, config: BillingConfigCatalogue, options: { limit?: number } = {}): Promise<{ eventsRead: number; chargesCreated: number }> {
  const offset = (await db.query<{ last_event_id: number }>('select last_event_id::float8 as last_event_id from billing.consumer_offset where consumer = $1', [CONSUMER])).rows[0]?.last_event_id ?? 0;
  const events = await listEventsAfter(db, offset, options.limit ?? 100);
  const last = events.at(-1);
  if (last === undefined) return { eventsRead: 0, chargesCreated: 0 };

  let chargesCreated = 0;
  await db.transaction(async (tx) => {
    for (const event of events) {
      if (MONEY_EVENTS.includes(event.type) && (await handleMoneyEvent(tx, config, event))) chargesCreated++;
    }
    await tx.query(
      'insert into billing.consumer_offset (consumer, last_event_id) values ($1, $2) on conflict (consumer) do update set last_event_id = excluded.last_event_id',
      [CONSUMER, last.id],
    );
  });
  return { eventsRead: events.length, chargesCreated };
}

// ---------------------------------------------------------------- invoices

// The invoice batch: every payment item due within its plan's invoice lead days is put on an invoice. Items of one
// billing account due on the same day go on one invoice. An item is never invoiced twice. Returns the invoices made.
export async function generateInvoices(db: Database, config: BillingConfigCatalogue, options: { today: string }, actor: string): Promise<Invoice[]> {
  if (!isRealDate(options.today)) throw new ValidationError(['The invoice date is not a real date (write it as yyyy-mm-dd)']);
  const plans = new Map(config.forDate(options.today).plans.map((p) => [p.code, p]));
  const due = await db.query<{ id: string; billing_account_id: string; plan_code: string; due_date: string }>(
    `select s.id, s.billing_account_id, a.plan_code, ${DATE('s.due_date')} as due_date
       from billing.schedule_item s join billing.account a on a.id = s.billing_account_id
      where s.status = 'scheduled' order by s.due_date, s.billing_account_id, s.source_event_id, s.sequence`,
  );
  const groups = new Map<string, string[]>();
  for (const row of due.rows) {
    const lead = plans.get(row.plan_code)?.invoice_lead_days ?? 0;
    if (row.due_date > addDays(options.today, lead)) continue;
    const key = `${row.billing_account_id}|${row.due_date}`;
    groups.set(key, [...(groups.get(key) ?? []), row.id]);
  }

  const created: string[] = [];
  for (const [key, itemIds] of groups) {
    const [billingAccountId, dueDate] = key.split('|') as [string, string];
    const id = await db.transaction(async (tx) => {
      const items = await tx.query<{ id: string; policy_number: string; kind: string; sequence: number; premium_paise: number; tax_paise: number; fee_paise: number; amount_paise: number }>(
        `select id, policy_number, kind, sequence, premium_paise::float8 as premium_paise, tax_paise::float8 as tax_paise, fee_paise::float8 as fee_paise, amount_paise::float8 as amount_paise
           from billing.schedule_item where id = any($1::uuid[]) order by source_event_id, sequence`,
        [itemIds],
      );
      const sum = (pick: (i: (typeof items.rows)[number]) => number): number => items.rows.reduce((total, i) => total + pick(i), 0);
      const invoice = (
        await tx.query<{ id: string }>(
          `insert into billing.invoice (billing_account_id, invoice_date, due_date, premium_paise, tax_paise, fee_paise, total_paise, created_by)
           values ($1, $2::date, $3::date, $4, $5, $6, $7, $8) returning id`,
          [billingAccountId, options.today, dueDate, sum((i) => i.premium_paise), sum((i) => i.tax_paise), sum((i) => i.fee_paise), sum((i) => i.amount_paise), actor],
        )
      ).rows[0];
      if (!invoice) throw new Error('The invoice was not saved');
      for (const item of items.rows) {
        await tx.query(
          `insert into billing.invoice_line (invoice_id, schedule_item_id, policy_number, description, premium_paise, tax_paise, fee_paise, amount_paise)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [invoice.id, item.id, item.policy_number, `${item.policy_number}: ${item.kind.replace('_', ' ')} payment ${item.sequence}`, item.premium_paise, item.tax_paise, item.fee_paise, item.amount_paise],
        );
        await tx.query("update billing.schedule_item set status = 'invoiced', invoice_id = $2 where id = $1", [item.id, invoice.id]);
      }
      await recordAudit(tx, { actor, action: 'invoice.create', entityType: 'invoice', entityId: invoice.id, details: { billingAccountId, dueDate, lines: items.rows.length } });
      return invoice.id;
    });
    created.push(id);
  }

  // Cash that was waiting (a customer who paid ahead) is put against the new invoices.
  const accounts = new Set([...groups.keys()].map((key) => key.split('|')[0] as string));
  for (const billingAccountId of accounts) await db.transaction((tx) => allocateUnapplied(tx, billingAccountId, actor));

  const result: Invoice[] = [];
  for (const id of created) {
    const invoice = await getInvoice(db, id);
    if (invoice) result.push(invoice);
  }
  return result.sort((a, b) => a.number.localeCompare(b.number));
}
