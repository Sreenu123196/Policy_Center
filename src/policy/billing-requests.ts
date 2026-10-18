import type { Database } from '../platform/index.js';
import { z } from 'zod';
import { addDays, consumeEvents, PermanentEventError, recordAudit, ValidationError, type OutboxEvent } from '../platform/index.js';
import { getAdjustmentOfBranch, latestBound, startCancellation, startReinstatement, type CancellationDependencies } from './cancellation.js';

// What Billing asks of Policy (document section 14: "Billing sends back payment status, delinquency cancellation
// requests and reinstatement triggers"). Policy reads Billing's events from the outbox with its own offset. A missed
// payment ends in a cancellation request: Policy starts a cancellation job for non-payment, with the notice the product
// requires. A late payment of that invoice asks for a reinstatement: Policy starts one if the policy was cancelled for
// non-payment and the time limit has not passed. A person still quotes and binds the jobs, so nothing is done in the dark.

const CONSUMER = 'billing-requests';
const HANDLED = ['CancellationRequested', 'ReinstatementRequested'];

const requestSchema = z.object({ policyNumbers: z.array(z.string().min(1)) });

export interface BillingRequestResult {
  policyNumber: string;
  outcome: 'cancellation_started' | 'reinstatement_started' | 'skipped';
  jobId?: string;
  reason?: string;
}

async function handlePolicy(db: Database, deps: CancellationDependencies, type: string, policyNumber: string, actor: string, today: string): Promise<BillingRequestResult> {
  const policy = (await db.query<{ id: string }>('select id from policy.policy where policy_number = $1', [policyNumber])).rows[0];
  if (!policy) return { policyNumber, outcome: 'skipped', reason: 'The policy does not exist' };
  const latest = await latestBound(db, policy.id);
  if (latest === null) return { policyNumber, outcome: 'skipped', reason: 'The policy has no bound version' };

  const skip = async (reason: string): Promise<BillingRequestResult> => {
    await recordAudit(db, { actor, action: 'billing_request.skipped', entityType: 'policy', entityId: policy.id, reason, details: { request: type } });
    return { policyNumber, outcome: 'skipped', reason };
  };

  if (type === 'CancellationRequested') {
    if (latest.cancelledOn !== null) return skip('The policy is already cancelled');
    const open = await db.query("select 1 from policy.job where policy_id = $1 and type = 'cancellation' and status in ('draft', 'quoted')", [policy.id]);
    if (open.rows.length > 0) return skip('The policy already has a cancellation in progress');
    const productCode = (await db.query<{ product_code: string }>('select product_code from policy.policy where id = $1', [policy.id])).rows[0]?.product_code ?? '';
    const rules = deps.cancellation.forVersion(productCode, latest.productVersion);
    const notice = rules?.reasons.find((r) => r.code === 'non_payment')?.notice_days ?? 0;
    const effectiveDate = addDays(today, notice) < latest.periodStart ? latest.periodStart : addDays(today, notice);
    if (effectiveDate >= latest.periodEnd) return skip('The term ends before the notice period is over');
    try {
      const started = await startCancellation(db, deps, { policyId: policy.id, effectiveDate, reasonCode: 'non_payment' }, actor, { today });
      return { policyNumber, outcome: 'cancellation_started', jobId: started.job.id };
    } catch (error) {
      if (error instanceof ValidationError) return skip(error.errors.join('; '));
      throw error;
    }
  }

  // ReinstatementRequested
  if (latest.cancelledOn === null) return skip('The policy is not cancelled');
  const adjustment = await getAdjustmentOfBranch(db, latest.id);
  if (adjustment?.reasonCode !== 'non_payment') return skip('The policy was not cancelled for non-payment');
  const open = await db.query("select 1 from policy.job where policy_id = $1 and type = 'reinstatement' and status in ('draft', 'quoted')", [policy.id]);
  if (open.rows.length > 0) return skip('The policy already has a reinstatement in progress');
  try {
    const started = await startReinstatement(db, deps, { policyId: policy.id, withGap: false }, actor, { today });
    return { policyNumber, outcome: 'reinstatement_started', jobId: started.job.id };
  } catch (error) {
    if (error instanceof ValidationError) return skip(error.errors.join('; '));
    throw error;
  }
}

// Handles one request from Billing. Exported so a dead event can be redriven. Starting a job that is already started is
// skipped by handlePolicy, so seeing an event twice is harmless.
export async function handleBillingEvent(db: Database, deps: CancellationDependencies, actor: string, today: string, event: OutboxEvent): Promise<BillingRequestResult[]> {
  if (!HANDLED.includes(event.type)) return [];
  const parsed = requestSchema.safeParse(event.payload);
  if (!parsed.success) throw new PermanentEventError(`Event ${event.id} (${event.type}) has an invalid payload`);
  const results: BillingRequestResult[] = [];
  for (const policyNumber of parsed.data.policyNumbers) results.push(await handlePolicy(db, deps, event.type, policyNumber, actor, today));
  return results;
}

// Reads Billing's requests that Policy has not handled yet, in order (platform consumer: retries and dead letters).
export async function processBillingEvents(db: Database, deps: CancellationDependencies, actor: string, options: { today?: string; limit?: number; now?: Date } = {}): Promise<BillingRequestResult[]> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const results: BillingRequestResult[] = [];
  await consumeEvents(db, {
    consumer: CONSUMER,
    limit: options.limit ?? 200,
    ...(options.now ? { now: options.now } : {}),
    handle: async (event) => void results.push(...(await handleBillingEvent(db, deps, actor, today, event))),
  });
  return results;
}
