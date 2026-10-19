import type { Database } from './database.js';
import { recordAudit } from './audit.js';
import { isPermission, type Permission } from './permissions.js';
import { ValidationError } from './validation-error.js';

export interface Role {
  code: string;
  name: string;
  permissions: Permission[]; // in alphabetical order
}

const ROLE_CODE_FORMAT = /^[a-z][a-z0-9_]{2,29}$/;

// A role is a named bundle of permissions, for example "underwriter". Roles are data: an administrator
// can create one or change what it grants without a code release.
export async function createRole(db: Database, input: { code: string; name: string; permissions: readonly Permission[] }, actor: string): Promise<Role> {
  const errors: string[] = [];
  const name = input.name.trim();

  if (!ROLE_CODE_FORMAT.test(input.code)) errors.push('Role code must be 3 to 30 lower-case letters, digits or underscores, starting with a letter');
  if (name === '') errors.push('Role name is required');
  for (const permission of input.permissions) {
    if (!isPermission(permission)) errors.push(`Unknown permission ${permission}`);
  }
  if (errors.length > 0) throw new ValidationError(errors);
  if (await getRole(db, input.code)) throw new ValidationError([`Role ${input.code} already exists`]);

  await db.transaction(async (tx) => {
    await tx.query('insert into platform.role (code, name, created_by) values ($1, $2, $3)', [input.code, name, actor]);
    for (const permission of new Set(input.permissions)) {
      await tx.query('insert into platform.role_permission (role_code, permission) values ($1, $2)', [input.code, permission]);
    }
    await recordAudit(tx, {
      actor,
      action: 'role.create',
      entityType: 'role',
      entityId: input.code,
      details: { permissions: [...new Set(input.permissions)].sort() },
    });
  });

  const saved = await getRole(db, input.code);
  if (saved === null) throw new Error('The role was saved but could not be read back');
  return saved;
}

// Returns null if the role does not exist.
export async function getRole(db: Database, code: string): Promise<Role | null> {
  const role = await db.query<{ code: string; name: string }>('select code, name from platform.role where code = $1', [code]);
  const row = role.rows[0];
  if (!row) return null;
  const permissions = await db.query<{ permission: Permission }>(
    'select permission from platform.role_permission where role_code = $1 order by permission',
    [code],
  );
  return { code: row.code, name: row.name, permissions: permissions.rows.map((p) => p.permission) };
}
