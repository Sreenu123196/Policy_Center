import type { Database } from '../platform/index.js';
import { recordEvent } from '../platform/index.js';

// Allocation (document section 14): money goes to the oldest amount due first. A line of an invoice is paid by one or
// more allocations, each from a payment or a credit. When every line of an invoice is paid, the invoice is paid.

export type Q = Pick<Database, 'query'>;

export type Source = { paymentId: string; creditId?: undefined } | { creditId: string; paymentId?: undefined };

interface OpenLine {
  id: string;
  invoice_id: string;
  schedule_item_id: string;
  outstanding: number;
}

// Puts up to "amount" paise against the open invoice lines of an account, oldest due date first (then invoice number,
// then the order the charges came). With a policy number, only that policy's lines are used. Returns what was allocated.
export async function allocate(tx: Q, billingAccountId: string, source: Source, amount: number, actor: string, policyNumber?: string | null): Promise<number> {
  if (amount <= 0) return 0;
  const lines = await tx.query<OpenLine>(
    `select l.id, l.invoice_id, l.schedule_item_id, (l.amount_paise - l.paid_paise)::float8 as outstanding
       from billing.invoice_line l
       join billing.invoice i on i.id = l.invoice_id
       join billing.schedule_item s on s.id = l.schedule_item_id
      where i.billing_account_id = $1 and i.status = 'open' and l.paid_paise < l.amount_paise and ($2::text is null or l.policy_number = $2)
      order by i.due_date, i.number, s.source_event_id, s.sequence`,
    [billingAccountId, policyNumber ?? null],
  );

  let left = amount;
  const touched = new Set<string>();
  for (const line of lines.rows) {
    if (left === 0) break;
    const take = Math.min(left, line.outstanding);
    await tx.query('insert into billing.allocation (payment_id, credit_id, invoice_line_id, amount_paise, created_by) values ($1, $2, $3, $4, $5)', [
      source.paymentId ?? null,
      source.creditId ?? null,
      line.id,
      take,
      actor,
    ]);
    await tx.query('update billing.invoice_line set paid_paise = paid_paise + $2 where id = $1', [line.id, take]);
    if (take === line.outstanding) await tx.query("update billing.schedule_item set status = 'paid' where id = $1", [line.schedule_item_id]);
    touched.add(line.invoice_id);
    left -= take;
  }
  for (const invoiceId of touched) await settleInvoice(tx, invoiceId);
  return amount - left;
}

// An invoice whose lines are all paid is paid. If a cancellation had been requested because of it, Policy is asked to
// reinstate, once ("reinstatement if paid later").
async function settleInvoice(tx: Q, invoiceId: string): Promise<void> {
  const unpaid = await tx.query('select 1 from billing.invoice_line where invoice_id = $1 and paid_paise < amount_paise limit 1', [invoiceId]);
  if (unpaid.rows.length > 0) return;
  await tx.query("update billing.invoice set status = 'paid' where id = $1 and status = 'open'", [invoiceId]);

  const requested = await tx.query("select 1 from billing.delinquency_step where invoice_id = $1 and action = 'cancellation_request'", [invoiceId]);
  if (requested.rows.length === 0) return;
  const already = await tx.query("select 1 from billing.delinquency_step where invoice_id = $1 and action = 'reinstatement_requested'", [invoiceId]);
  if (already.rows.length > 0) return;

  const invoice = (
    await tx.query<{ number: string; billing_account_id: string; account_id: string }>(
      'select i.number, i.billing_account_id, a.account_id from billing.invoice i join billing.account a on a.id = i.billing_account_id where i.id = $1',
      [invoiceId],
    )
  ).rows[0];
  if (!invoice) return;
  const policies = await tx.query<{ policy_number: string }>('select distinct policy_number from billing.invoice_line where invoice_id = $1 order by policy_number', [invoiceId]);
  await tx.query("insert into billing.delinquency_step (invoice_id, action, done_on) values ($1, 'reinstatement_requested', current_date)", [invoiceId]);
  await recordEvent(tx, {
    type: 'ReinstatementRequested',
    aggregateType: 'billing_account',
    aggregateId: invoice.billing_account_id,
    payload: { accountId: invoice.account_id, invoiceNumber: invoice.number, policyNumbers: policies.rows.map((p) => p.policy_number) },
  });
}

// Puts cash that was waiting (unapplied) against the invoices that now exist. A payment meant for one policy stays with it.
export async function allocateUnapplied(tx: Q, billingAccountId: string, actor: string): Promise<void> {
  const waiting = await tx.query<{ id: string; policy_number: string | null; unapplied: number }>(
    `select p.id, p.policy_number, (p.amount_paise - coalesce((select sum(amount_paise) from billing.allocation a where a.payment_id = p.id), 0))::float8 as unapplied
       from billing.payment p where p.billing_account_id = $1 order by p.received_on, p.seq`,
    [billingAccountId],
  );
  for (const payment of waiting.rows) {
    if (payment.unapplied > 0) await allocate(tx, billingAccountId, { paymentId: payment.id }, payment.unapplied, actor, payment.policy_number);
  }
}
