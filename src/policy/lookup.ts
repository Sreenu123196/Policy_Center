import type { Database } from '../platform/index.js';
import { createHash } from 'node:crypto';
import { isUuid } from '../platform/index.js';

// Small questions the API edge asks Policy: whose account does this belong to (so producer code security can be
// applied), and has this working copy changed (so a lost update can be detected).

type Q = Pick<Database, 'query'>;

async function accountId(db: Q, sql: string, id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  return (await db.query<{ account_id: string }>(sql, [id])).rows[0]?.account_id ?? null;
}

export const accountIdOfJob = (db: Q, jobId: string): Promise<string | null> =>
  accountId(db, 'select p.account_id from policy.job j join policy.policy p on p.id = j.policy_id where j.id = $1', jobId);

export const accountIdOfBranch = (db: Q, branchId: string): Promise<string | null> =>
  accountId(db, 'select p.account_id from policy.policy_period b join policy.policy p on p.id = b.policy_id where b.id = $1', branchId);

export async function accountIdOfPolicyNumber(db: Q, policyNumber: string): Promise<string | null> {
  return (await db.query<{ account_id: string }>('select account_id from policy.policy where policy_number = $1', [policyNumber])).rows[0]?.account_id ?? null;
}

// A fingerprint of a working copy: its status and every row. It changes whenever anything in the branch changes, so a
// client can send it back (If-Match) to say "change this only if it is still the version I looked at".
export async function branchFingerprint(db: Q, branchId: string): Promise<string> {
  const branch = (await db.query<{ status: string; version: number | null }>('select status, version from policy.policy_period where id = $1', [branchId])).rows[0];
  const coverables = await db.query('select row_id::text, fixed_id, kind, eff_from::text, eff_to::text, attributes from policy.coverable where branch_id = $1 order by row_id', [branchId]);
  const coverages = await db.query('select row_id::text, fixed_id, coverable_fid, pattern_code, eff_from::text, eff_to::text, terms from policy.coverage where branch_id = $1 order by row_id', [branchId]);
  return createHash('sha256').update(JSON.stringify([branch, coverables.rows, coverages.rows])).digest('hex').slice(0, 32);
}

export async function policyIdOfNumber(db: Q, policyNumber: string): Promise<string | null> {
  return (await db.query<{ id: string }>('select id from policy.policy where policy_number = $1', [policyNumber])).rows[0]?.id ?? null;
}

export async function accountIdOfPolicy(db: Q, policyId: string): Promise<string | null> {
  return accountId(db, 'select account_id from policy.policy where id = $1', policyId);
}

export interface PolicyVersion {
  termNumber: number;
  version: number;
  periodStart: string;
  periodEnd: string;
  cancelledOn: string | null;
  jobType: string;
  jobNumber: string;
}

// The bound versions of a policy, oldest first: what the policy file shows as its timeline.
export async function listVersions(db: Q, policyId: string): Promise<PolicyVersion[]> {
  const result = await db.query<{ term_number: number; version: number; period_start: string; period_end: string; cancelled_on: string | null; type: string; job_number: string }>(
    `select b.term_number, b.version, to_char(b.period_start, 'YYYY-MM-DD') as period_start, to_char(b.period_end, 'YYYY-MM-DD') as period_end,
            to_char(b.cancelled_on, 'YYYY-MM-DD') as cancelled_on, j.type, j.job_number
       from policy.policy_period b join policy.job j on j.id = b.job_id
      where b.policy_id = $1 and b.status = 'bound' order by b.term_number, b.version`,
    [policyId],
  );
  return result.rows.map((r) => ({ termNumber: r.term_number, version: r.version, periodStart: r.period_start, periodEnd: r.period_end, cancelledOn: r.cancelled_on, jobType: r.type, jobNumber: r.job_number }));
}

// The basic facts of a policy by its number, or null.
export async function policySummary(db: Q, policyNumber: string): Promise<{ policyId: string; policyNumber: string; productCode: string; accountId: string } | null> {
  const row = (await db.query<{ id: string; policy_number: string; product_code: string; account_id: string }>('select id, policy_number, product_code, account_id from policy.policy where policy_number = $1', [policyNumber])).rows[0];
  return row ? { policyId: row.id, policyNumber: row.policy_number, productCode: row.product_code, accountId: row.account_id } : null;
}
