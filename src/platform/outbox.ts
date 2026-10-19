import type { Database } from './database.js';
import type { Queryable } from './audit.js';
import { ValidationError } from './validation-error.js';

// The event outbox (document section 17). A module writes an event in the same transaction as the change it reports,
// so the two are saved together or not at all. A publisher reads the unpublished events in order and delivers them.
// Consumers may see an event twice, so they must be idempotent.

export interface NewEvent {
  type: string; // written like PolicyBound
  aggregateType: string; // for example policy
  aggregateId: string;
  payload: Record<string, unknown>; // small facts only; never personal numbers
}

export interface OutboxEvent extends NewEvent {
  id: number;
  createdAt: string;
  publishedAt: string | null;
}

export async function recordEvent(db: Queryable, event: NewEvent): Promise<void> {
  if (!/^[A-Z][A-Za-z0-9]{2,59}$/.test(event.type)) throw new ValidationError([`The event type ${event.type} must be written like PolicyBound`]);
  await db.query('insert into platform.outbox (type, aggregate_type, aggregate_id, payload) values ($1, $2, $3, $4::jsonb)', [
    event.type,
    event.aggregateType,
    event.aggregateId,
    JSON.stringify(event.payload),
  ]);
}

interface EventRow {
  id: number;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
}

// Events not published yet, oldest first.
export async function listUnpublishedEvents(db: Database, limit = 100): Promise<OutboxEvent[]> {
  const result = await db.query<EventRow>(
    'select id::float8 as id, type, aggregate_type, aggregate_id, payload, created_at, published_at from platform.outbox where published_at is null order by id limit $1',
    [limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    type: r.type,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    payload: r.payload,
    createdAt: r.created_at.toISOString(),
    publishedAt: r.published_at === null ? null : r.published_at.toISOString(),
  }));
}

// Marks events as delivered. Doing it twice for the same event is harmless.
export async function markPublished(db: Queryable, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query('update platform.outbox set published_at = now() where id = any($1::bigint[]) and published_at is null', [ids]);
}

// Events after a given id, oldest first, whether or not they were published. A consumer (billing, for example) keeps
// its own offset, the id of the last event it handled, so several consumers can read the same outbox.
export async function listEventsAfter(db: Pick<Database, 'query'>, afterId: number, limit = 100): Promise<OutboxEvent[]> {
  const result = await db.query<EventRow>(
    'select id::float8 as id, type, aggregate_type, aggregate_id, payload, created_at, published_at from platform.outbox where id > $1 order by id limit $2',
    [afterId, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    type: r.type,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    payload: r.payload,
    createdAt: r.created_at.toISOString(),
    publishedAt: r.published_at === null ? null : r.published_at.toISOString(),
  }));
}
