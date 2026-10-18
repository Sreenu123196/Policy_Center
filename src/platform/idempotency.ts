import type { Database } from './database.js';

// Idempotency keys (document section 17). The first answer to a request is kept under the key the client chose, so a
// retry (a lost reply, a double click) gets the same answer and does not do the work twice.

export interface StoredResponse {
  requestHash: string;
  statusCode: number;
  response: unknown;
}

export async function findIdempotentResponse(db: Pick<Database, 'query'>, userName: string, key: string): Promise<StoredResponse | null> {
  const row = (
    await db.query<{ request_hash: string; status_code: number; response: unknown }>('select request_hash, status_code, response from platform.idempotency_key where user_name = $1 and key = $2', [userName, key])
  ).rows[0];
  return row ? { requestHash: row.request_hash, statusCode: row.status_code, response: row.response } : null;
}

export async function saveIdempotentResponse(db: Pick<Database, 'query'>, userName: string, key: string, stored: StoredResponse): Promise<void> {
  await db.query(
    'insert into platform.idempotency_key (user_name, key, request_hash, status_code, response) values ($1, $2, $3, $4, $5::jsonb) on conflict (user_name, key) do nothing',
    [userName, key, stored.requestHash, stored.statusCode, JSON.stringify(stored.response ?? null)],
  );
}
