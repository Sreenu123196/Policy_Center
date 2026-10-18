import type { Database } from './database.js';
import { isUuid } from './ids.js';
import { PermissionError } from './permission-error.js';
import type { Permission } from './permissions.js';
import type { Visibility } from './visibility.js';

// May this user do this? A user holds every permission of every role they have.
// An unknown or deactivated user holds none.
export async function hasPermission(db: Database, userId: string, permission: Permission): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const result = await db.query(
    `select 1
       from platform.app_user u
       join platform.user_role ur on ur.user_id = u.id
       join platform.role_permission rp on rp.role_code = ur.role_code
      where u.id = $1 and u.status = 'active' and rp.permission = $2
      limit 1`,
    [userId, permission],
  );
  return result.rows.length > 0;
}

// For use at the edge of the system (the API, step H1): carries on if allowed, otherwise throws.
export async function requirePermission(db: Database, userId: string, permission: Permission): Promise<void> {
  if (!(await hasPermission(db, userId, permission))) throw new PermissionError(permission);
}

// Which producer codes a user's records may come from (document section 13).
// Head office (account.view_all) sees everything; an agent (account.view) sees only the codes they hold;
// anyone else sees nothing.
export async function visibilityFor(db: Database, userId: string): Promise<Visibility> {
  if (await hasPermission(db, userId, 'account.view_all')) return 'all';
  if (!(await hasPermission(db, userId, 'account.view'))) return { producerCodes: [] };
  const codes = await db.query<{ producer_code: string }>(
    'select producer_code from platform.user_producer_code where user_id = $1 order by producer_code',
    [userId],
  );
  return { producerCodes: codes.rows.map((row) => row.producer_code) };
}
