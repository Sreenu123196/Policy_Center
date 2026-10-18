import type { Database } from './database.js';

// Anything that can run a query: the database itself, or a transaction in progress.
// Audit entries are written with the same transaction as the change, so the two are saved together or not at all.
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface NewAuditEntry {
  actor: string; // the user name of the person or agent
  action: string; // for example account.create
  entityType: string;
  entityId: string;
  reason?: string;
  details?: Record<string, unknown>; // small facts only; never personal numbers
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
  details: Record<string, unknown>;
}

interface AuditRow {
  id: number;
  at: Date;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  reason: string | null;
  details: Record<string, unknown>;
}

export async function recordAudit(db: Queryable, entry: NewAuditEntry): Promise<void> {
  await db.query(
    `insert into platform.audit_log (actor, action, entity_type, entity_id, reason, details)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [entry.actor, entry.action, entry.entityType, entry.entityId, entry.reason ?? null, JSON.stringify(entry.details ?? {})],
  );
}

// Entries in the order they happened, optionally only those about one thing.
export async function listAuditEntries(db: Database, filter: { entityType?: string; entityId?: string } = {}): Promise<AuditEntry[]> {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filter.entityType !== undefined) {
    params.push(filter.entityType);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (filter.entityId !== undefined) {
    params.push(filter.entityId);
    conditions.push(`entity_id = $${params.length}`);
  }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const result = await db.query<AuditRow>(
    `select id::int as id, at, actor, action, entity_type, entity_id, reason, details
       from platform.audit_log ${where} order by id`,
    params,
  );
  return result.rows.map((row) => ({
    id: row.id,
    at: row.at.toISOString(),
    actor: row.actor,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    details: row.details,
  }));
}
