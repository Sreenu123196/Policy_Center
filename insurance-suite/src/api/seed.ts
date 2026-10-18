import type { Database } from '../platform/index.js';
import { assignProducerCode, assignRole, createProducerCode, createProducerOrganisation, createRole, createUser, getProducerCode, getRole, getUserByUsername, type Permission } from '../platform/index.js';

// Demo people for a local run: one user for each kind of work, so the screens can be tried without an identity provider.
// Running it again changes nothing. Real users come from the identity provider and the admin screens (document section 13).

export const DEMO_ROLES: Record<string, { name: string; permissions: Permission[] }> = {
  agent: { name: 'Agent', permissions: ['account.view', 'account.create', 'submission.create', 'claim.report'] },
  underwriter: { name: 'Underwriter', permissions: ['policy.bind', 'uw.approve', 'account.view_all', 'submission.create', 'billing.view'] },
  claims_handler: { name: 'Claims handler', permissions: ['claim.report', 'claim.handle', 'claim.pay', 'account.view_all'] },
  cashier: { name: 'Cashier', permissions: ['billing.view', 'billing.pay', 'account.view_all'] },
  api_admin: { name: 'Administrator', permissions: ['admin.manage_users', 'audit.view', 'account.view_all', 'billing.view'] },
};

export const DEMO_USERS: { username: string; displayName: string; role: string; producerCode?: string }[] = [
  { username: 'asha.agent', displayName: 'Asha (agent, PC-100)', role: 'agent', producerCode: 'PC-100' },
  { username: 'uma.underwriter', displayName: 'Uma (underwriter)', role: 'underwriter' },
  { username: 'carl.claims', displayName: 'Carl (claims handler)', role: 'claims_handler' },
  { username: 'bina.billing', displayName: 'Bina (cashier)', role: 'cashier' },
  { username: 'root.admin', displayName: 'Root (administrator)', role: 'api_admin' },
];

export async function seedDemo(db: Database): Promise<void> {
  if ((await getProducerCode(db, 'PC-100')) === null) {
    const organisation = await createProducerOrganisation(db, { name: 'Demo Insurance Agency' }, 'seed');
    await createProducerCode(db, { code: 'PC-100', organisationId: organisation.id }, 'seed');
  }
  for (const [code, role] of Object.entries(DEMO_ROLES)) {
    if ((await getRole(db, code)) === null) await createRole(db, { code, name: role.name, permissions: role.permissions }, 'seed');
  }
  for (const demo of DEMO_USERS) {
    if ((await getUserByUsername(db, demo.username)) !== null) continue;
    await createUser(db, { username: demo.username, displayName: demo.displayName }, 'seed');
    const user = await getUserByUsername(db, demo.username);
    if (user === null) continue;
    await assignRole(db, user.id, demo.role, 'seed');
    if (demo.producerCode) await assignProducerCode(db, user.id, demo.producerCode, 'seed');
  }
}
