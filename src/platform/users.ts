import type { PGlite } from '@electric-sql/pglite';
import { recordAudit } from './audit.js';
import { isUuid } from './ids.js';
import { getProducerCode } from './producers.js';
import { getRole } from './roles.js';
import { ValidationError } from './validation-error.js';

export type UserKind = 'person' | 'agent';

export interface User {
  id: string;
  username: string;
  displayName: string;
  kind: UserKind; // an agent is an AI worker with its own login, so its actions are audited like anyone's
  status: 'active' | 'inactive';
  roles: string[];
  producerCodes: string[];
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  kind: UserKind;
  status: 'active' | 'inactive';
}

const USERNAME_FORMAT = /^[a-z][a-z0-9.]{2,29}$/;

export async function createUser(db: PGlite, input: { username: string; displayName: string; kind?: UserKind }, actor: string): Promise<User> {
  const errors: string[] = [];
  const displayName = input.displayName.trim();
  const kind = input.kind ?? 'person';

  if (!USERNAME_FORMAT.test(input.username)) errors.push('Username must be 3 to 30 lower-case letters, digits or dots, starting with a letter');
  if (displayName === '') errors.push('Display name is required');
  if (kind !== 'person' && kind !== 'agent') errors.push('Kind must be person or agent');
  if (errors.length > 0) throw new ValidationError(errors);
  if (await getUserByUsername(db, input.username)) throw new ValidationError([`User ${input.username} already exists`]);

  const id = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      'insert into platform.app_user (username, display_name, kind, created_by) values ($1, $2, $3, $4) returning id',
      [input.username, displayName, kind, actor],
    );
    const newId = inserted.rows[0]?.id;
    if (newId === undefined) throw new Error('The user was not saved');
    await recordAudit(tx, { actor, action: 'user.create', entityType: 'user', entityId: newId, details: { username: input.username, kind } });
    return newId;
  });

  const saved = await getUser(db, id);
  if (saved === null) throw new Error('The user was saved but could not be read back');
  return saved;
}

export async function getUser(db: PGlite, id: string): Promise<User | null> {
  if (!isUuid(id)) return null;
  const result = await db.query<UserRow>('select id, username, display_name, kind, status from platform.app_user where id = $1', [id]);
  return loadUser(db, result.rows[0]);
}

export async function getUserByUsername(db: PGlite, username: string): Promise<User | null> {
  const result = await db.query<UserRow>('select id, username, display_name, kind, status from platform.app_user where username = $1', [username]);
  return loadUser(db, result.rows[0]);
}

async function loadUser(db: PGlite, row: UserRow | undefined): Promise<User | null> {
  if (!row) return null;
  const roles = await db.query<{ role_code: string }>('select role_code from platform.user_role where user_id = $1 order by role_code', [row.id]);
  const codes = await db.query<{ producer_code: string }>(
    'select producer_code from platform.user_producer_code where user_id = $1 order by producer_code',
    [row.id],
  );
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    kind: row.kind,
    status: row.status,
    roles: roles.rows.map((r) => r.role_code),
    producerCodes: codes.rows.map((c) => c.producer_code),
  };
}

// A deactivated user keeps their history but holds no permissions any more.
export async function deactivateUser(db: PGlite, userId: string, actor: string): Promise<User> {
  if ((await getUser(db, userId)) === null) throw new ValidationError(['The user does not exist']);
  await db.transaction(async (tx) => {
    await tx.query("update platform.app_user set status = 'inactive' where id = $1", [userId]);
    await recordAudit(tx, { actor, action: 'user.deactivate', entityType: 'user', entityId: userId });
  });
  const saved = await getUser(db, userId);
  if (saved === null) throw new Error('The user could not be read back');
  return saved;
}

export async function assignRole(db: PGlite, userId: string, roleCode: string, actor: string): Promise<User> {
  const user = await getUser(db, userId);
  if (user === null) throw new ValidationError(['The user does not exist']);
  if ((await getRole(db, roleCode)) === null) throw new ValidationError([`Role ${roleCode} does not exist`]);
  if (user.roles.includes(roleCode)) throw new ValidationError(['The user already has that role']);

  await db.transaction(async (tx) => {
    await tx.query('insert into platform.user_role (user_id, role_code, created_by) values ($1, $2, $3)', [userId, roleCode, actor]);
    await recordAudit(tx, { actor, action: 'user.assign_role', entityType: 'user', entityId: userId, details: { role: roleCode } });
  });
  const saved = await getUser(db, userId);
  if (saved === null) throw new Error('The user could not be read back');
  return saved;
}

// Links a user to a producer code. The codes a user holds decide which accounts they may see.
export async function assignProducerCode(db: PGlite, userId: string, producerCode: string, actor: string): Promise<User> {
  const user = await getUser(db, userId);
  if (user === null) throw new ValidationError(['The user does not exist']);
  if ((await getProducerCode(db, producerCode)) === null) throw new ValidationError([`Producer code ${producerCode} does not exist`]);
  if (user.producerCodes.includes(producerCode)) throw new ValidationError([`The user already holds producer code ${producerCode}`]);

  await db.transaction(async (tx) => {
    await tx.query('insert into platform.user_producer_code (user_id, producer_code, created_by) values ($1, $2, $3)', [userId, producerCode, actor]);
    await recordAudit(tx, { actor, action: 'user.assign_producer_code', entityType: 'user', entityId: userId, details: { producerCode } });
  });
  const saved = await getUser(db, userId);
  if (saved === null) throw new Error('The user could not be read back');
  return saved;
}
