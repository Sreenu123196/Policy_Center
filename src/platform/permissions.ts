// The permissions the system knows (document section 13). A role is a bundle of these.
// New business actions add a permission here; roles then grant it through data, not code.
export const PERMISSIONS = [
  'account.view', // see accounts under the user's own producer codes
  'account.view_all', // see accounts under every producer code (head office)
  'account.create',
  'submission.create',
  'policy.bind',
  'uw.approve', // approve underwriting issues
  'billing.view',
  'billing.pay', // take payments
  'claim.report', // take a first notice of loss
  'claim.handle', // work a claim: exposures, reserves
  'claim.pay',
  'audit.view',
  'admin.manage_users',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (value: string): value is Permission => (PERMISSIONS as readonly string[]).includes(value);
