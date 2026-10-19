import type { Database } from './database.js';
import { recordAudit } from './audit.js';
import { listEventsAfter, type OutboxEvent } from './outbox.js';
import { ValidationError } from './validation-error.js';

// An event consumer (document section 17): reads the outbox in order and keeps its place (platform.event_consumer).
// The place moves only after an event has been handled, so a crash means the event comes again, never that it is lost:
// handlers must therefore be idempotent. A failing event is retried with a growing wait (it blocks the events behind it,
// which keeps them in order). After maxAttempts it goes to the dead-letter list and the consumer moves on, so one bad
// event cannot stop everything behind it. An error that can never succeed (PermanentEventError) goes there at once.

export class PermanentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEventError';
  }
}

export interface ConsumeOptions {
  consumer: string; // the consumer's name, for example billing
  handle: (event: OutboxEvent) => Promise<void>;
  limit?: number; // events per run (default 100)
  maxAttempts?: number; // failures before the dead-letter list (default 5)
  backoffSeconds?: number; // the wait after the first failure; it doubles each time (default 30)
  now?: Date; // the time "now"; tests set it
}

export interface ConsumeResult {
  handled: number;
  deadLettered: number[]; // ids of the events given up on in this run
  blockedOn: { eventId: number; attempts: number; retryAt: string } | null; // an event waiting for its next try
}

const MAX_ERROR_LENGTH = 500;
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);

async function offsetOf(db: Pick<Database, 'query'>, consumer: string): Promise<number> {
  return (await db.query<{ last_event_id: number }>('select last_event_id::float8 as last_event_id from platform.event_consumer where consumer = $1', [consumer])).rows[0]?.last_event_id ?? 0;
}

async function moveOffset(db: Pick<Database, 'query'>, consumer: string, eventId: number): Promise<void> {
  await db.query('insert into platform.event_consumer (consumer, last_event_id) values ($1, $2) on conflict (consumer) do update set last_event_id = excluded.last_event_id', [consumer, eventId]);
}

interface FailureRow {
  attempts: number;
  status: 'retrying' | 'dead' | 'resolved';
  next_attempt_at: Date | null;
}

export async function consumeEvents(db: Database, options: ConsumeOptions): Promise<ConsumeResult> {
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? 5;
  const backoff = options.backoffSeconds ?? 30;
  const events = await listEventsAfter(db, await offsetOf(db, options.consumer), options.limit ?? 100);
  const result: ConsumeResult = { handled: 0, deadLettered: [], blockedOn: null };

  for (const event of events) {
    const failure = (await db.query<FailureRow>('select attempts, status, next_attempt_at from platform.event_failure where consumer = $1 and event_id = $2', [options.consumer, event.id])).rows[0];
    if (failure?.status === 'retrying' && failure.next_attempt_at !== null && failure.next_attempt_at.getTime() > now.getTime()) {
      result.blockedOn = { eventId: event.id, attempts: failure.attempts, retryAt: failure.next_attempt_at.toISOString() };
      return result;
    }
    try {
      await options.handle(event);
    } catch (error) {
      const attempts = (failure?.attempts ?? 0) + 1;
      const message = describeError(error);
      const giveUp = error instanceof PermanentEventError || attempts >= maxAttempts;
      const retryAt = new Date(now.getTime() + backoff * 2 ** (attempts - 1) * 1000);
      await db.transaction(async (tx) => {
        await tx.query(
          `insert into platform.event_failure (consumer, event_id, attempts, last_error, status, first_failed_at, last_failed_at, next_attempt_at)
           values ($1, $2, $3, $4, $5, $6, $6, $7)
           on conflict (consumer, event_id) do update set attempts = excluded.attempts, last_error = excluded.last_error, status = excluded.status, last_failed_at = excluded.last_failed_at, next_attempt_at = excluded.next_attempt_at`,
          [options.consumer, event.id, attempts, message, giveUp ? 'dead' : 'retrying', now.toISOString(), giveUp ? null : retryAt.toISOString()],
        );
        if (giveUp) {
          await recordAudit(tx, { actor: 'system', action: 'event.dead_letter', entityType: 'event', entityId: String(event.id), details: { consumer: options.consumer, type: event.type, attempts } });
          await moveOffset(tx, options.consumer, event.id);
        }
      });
      if (!giveUp) {
        result.blockedOn = { eventId: event.id, attempts, retryAt: retryAt.toISOString() };
        return result;
      }
      result.deadLettered.push(event.id);
      continue;
    }
    await db.transaction(async (tx) => {
      await moveOffset(tx, options.consumer, event.id);
      if (failure) await tx.query("update platform.event_failure set status = 'resolved', resolved_by = 'system', resolved_at = $3 where consumer = $1 and event_id = $2", [options.consumer, event.id, now.toISOString()]);
    });
    result.handled++;
  }
  return result;
}

export interface DeadEvent {
  consumer: string;
  eventId: number;
  eventType: string;
  attempts: number;
  lastError: string;
  failedAt: string;
}

// The events given up on, oldest first. A person looks at these, fixes the cause, and redrives them.
export async function listDeadEvents(db: Pick<Database, 'query'>): Promise<DeadEvent[]> {
  const rows = await db.query<{ consumer: string; event_id: number; type: string; attempts: number; last_error: string; last_failed_at: Date }>(
    `select f.consumer, f.event_id::float8 as event_id, o.type, f.attempts, f.last_error, f.last_failed_at
       from platform.event_failure f join platform.outbox o on o.id = f.event_id
      where f.status = 'dead' order by f.event_id, f.consumer`,
  );
  return rows.rows.map((r) => ({ consumer: r.consumer, eventId: r.event_id, eventType: r.type, attempts: r.attempts, lastError: r.last_error, failedAt: r.last_failed_at.toISOString() }));
}

// Runs the handler once more for a dead event, out of its original order (the consumer has moved on). If it works the
// event is marked resolved and the person who did it is recorded; if not, it stays on the list with the new error.
export async function redriveDeadEvent(
  db: Database,
  options: { consumer: string; eventId: number; handle: (event: OutboxEvent) => Promise<void>; now?: Date },
  actor: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = options.now ?? new Date();
  const dead = (await db.query("select 1 from platform.event_failure where consumer = $1 and event_id = $2 and status = 'dead'", [options.consumer, options.eventId])).rows;
  if (dead.length === 0) throw new ValidationError([`Event ${options.eventId} is not on the dead-letter list of ${options.consumer}`]);
  const event = (await listEventsAfter(db, options.eventId - 1, 1))[0];
  if (event === undefined || event.id !== options.eventId) throw new ValidationError([`Event ${options.eventId} no longer exists`]);
  try {
    await options.handle(event);
  } catch (error) {
    const message = describeError(error);
    await db.query('update platform.event_failure set last_error = $3, last_failed_at = $4 where consumer = $1 and event_id = $2', [options.consumer, options.eventId, message, now.toISOString()]);
    return { ok: false, error: message };
  }
  await db.transaction(async (tx) => {
    await tx.query("update platform.event_failure set status = 'resolved', resolved_by = $3, resolved_at = $4 where consumer = $1 and event_id = $2", [options.consumer, options.eventId, actor, now.toISOString()]);
    await recordAudit(tx, { actor, action: 'event.redrive', entityType: 'event', entityId: String(options.eventId), details: { consumer: options.consumer } });
  });
  return { ok: true };
}
