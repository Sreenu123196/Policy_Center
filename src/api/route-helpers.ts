import { z } from 'zod';
import { getAccount, type Account } from '../policy/index.js';
import { ApiError, notFound, type RouteContext } from './registry.js';

// Small helpers the routes share.

export const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is written yyyy-mm-dd');
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'An id looks like 3f2b8c1e-...');

// Lists are paged (document section 17).
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function paginate<T>(all: T[], query: { limit: number; offset: number }): { items: T[]; total: number; limit: number; offset: number } {
  return { items: all.slice(query.offset, query.offset + query.limit), total: all.length, limit: query.limit, offset: query.offset };
}

// Producer code security: an account the user may not see is reported as not found, so its existence is not revealed.
export async function visibleAccount(context: RouteContext<unknown, unknown>, accountId: string | null, what = 'The account'): Promise<Account> {
  const account = accountId === null ? null : await getAccount(context.db, accountId, context.visibility);
  if (account === null) throw notFound(what);
  return account;
}

// Removes the keys whose value is undefined, so an optional field that was not sent is not passed on as undefined.
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export const etagOf = (fingerprint: string): string => `"${fingerprint}"`;

// A change must say which version it is based on (If-Match) and that must still be the current one.
export function requireIfMatch(context: RouteContext<unknown, unknown>, currentFingerprint: string): void {
  const sent = context.headers['if-match'];
  const value = Array.isArray(sent) ? sent[0] : sent;
  if (value === undefined || value === '') throw new ApiError(428, 'precondition_required', 'The If-Match header is required: send the ETag you read');
  if (value !== etagOf(currentFingerprint)) throw new ApiError(412, 'precondition_failed', 'The resource has changed since you read it; read it again');
}
