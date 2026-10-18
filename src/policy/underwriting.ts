import type { Database } from '../platform/index.js';
import { addDays, getUserByUsername, isRealDate, isUuid, PermissionError, recordAudit, ValidationError } from '../platform/index.js';
import { evaluateExpression, parseExpression } from './expression.js';
import { getBranch, getBranchAsOf } from './policy-repository.js';
import { buildRisk } from './risk.js';
import { CHECK_POINTS, type CheckPoint, type UwRules, type UwRulesCatalogue } from './uw-rules.js';

// Underwriting (document section 10): rules raise issues at fixed points, an issue may block a step, a person with
// enough authority approves or rejects it, and after any edit the rules run again.

export interface UnderwritingDependencies {
  rules: UwRulesCatalogue;
}

export type IssueStatus = 'open' | 'referred' | 'approved' | 'rejected' | 'cleared';
export type DecisionKind = 'approved' | 'approved_with_conditions' | 'rejected';

export interface UwDecision {
  decision: DecisionKind;
  decidedBy: string;
  reason: string;
  limit: number | null; // the approval covers values up to (max) or down to (min) this
  validUntil: string | null; // the last day the approval counts
  conditions: string | null;
  decidedAt: string;
}

export interface UwIssue {
  id: string;
  branchId: string;
  ruleCode: string;
  issueType: string;
  blocks: 'quote' | 'bind' | 'issuance' | 'none';
  compare: 'max' | 'min';
  value: number;
  message: string;
  status: IssueStatus;
  decision: UwDecision | null; // the latest decision, if any; earlier ones stay in the database as history
}

export interface Referral {
  id: string;
  issueId: string;
  requestedBy: string;
  note: string | null;
  status: 'open' | 'closed';
  context: Record<string, unknown>;
  createdAt: string;
}

type Queryable = Pick<Database, 'query'> | Pick<Database, 'query'>;

const todayText = (): string => new Date().toISOString().slice(0, 10);

// Does an approval limit cover a value? "max": values up to the limit. "min": values down to the limit.
const covers = (compare: 'max' | 'min', limit: number | null, value: number): boolean => limit === null || (compare === 'max' ? value <= limit : value >= limit);

// ---------------------------------------------------------------- reading

interface IssueRow {
  id: string;
  branch_id: string;
  rule_code: string;
  issue_type: string;
  blocks: UwIssue['blocks'];
  compare: 'max' | 'min';
  value: number;
  message: string;
  status: IssueStatus;
  decision: DecisionKind | null;
  decided_by: string | null;
  reason: string | null;
  limit_value: number | null;
  valid_until: string | null;
  conditions: string | null;
  decided_at: Date | null;
}

// Money columns are bigint; they are read as float8, which is exact for whole numbers far beyond any premium or insured value.
const ISSUE_SELECT = `select i.id, i.branch_id, i.rule_code, i.issue_type, i.blocks, i.compare, i.value::float8 as value, i.message, i.status,
    d.decision, d.decided_by, d.reason, d.limit_value::float8 as limit_value, to_char(d.valid_until, 'YYYY-MM-DD') as valid_until, d.conditions, d.decided_at
  from policy.uw_issue i
  left join lateral (
    select decision, decided_by, reason, limit_value, valid_until, conditions, decided_at
      from policy.uw_decision where issue_id = i.id order by seq desc limit 1
  ) d on true`;

const toIssue = (row: IssueRow): UwIssue => ({
  id: row.id,
  branchId: row.branch_id,
  ruleCode: row.rule_code,
  issueType: row.issue_type,
  blocks: row.blocks,
  compare: row.compare,
  value: row.value,
  message: row.message,
  status: row.status,
  decision:
    row.decision === null
      ? null
      : {
          decision: row.decision,
          decidedBy: row.decided_by ?? '',
          reason: row.reason ?? '',
          limit: row.limit_value,
          validUntil: row.valid_until,
          conditions: row.conditions,
          decidedAt: (row.decided_at ?? new Date(0)).toISOString(),
        },
});

export async function listIssues(db: Queryable, branchId: string): Promise<UwIssue[]> {
  const result = await db.query<IssueRow>(`${ISSUE_SELECT} where i.branch_id = $1 order by i.created_at, i.rule_code`, [branchId]);
  return result.rows.map(toIssue);
}

async function getIssue(db: Queryable, issueId: string): Promise<UwIssue | null> {
  if (!isUuid(issueId)) return null;
  const result = await db.query<IssueRow>(`${ISSUE_SELECT} where i.id = $1`, [issueId]);
  const row = result.rows[0];
  return row ? toIssue(row) : null;
}

// The underwriter queue: referrals nobody has decided yet, oldest first.
export async function listReferrals(db: Database): Promise<Referral[]> {
  const result = await db.query<{ id: string; issue_id: string; requested_by: string; note: string | null; status: 'open' | 'closed'; context: Record<string, unknown>; created_at: Date }>(
    "select id, issue_id, requested_by, note, status, context, created_at from policy.uw_referral where status = 'open' order by seq",
  );
  return result.rows.map((r) => ({ id: r.id, issueId: r.issue_id, requestedBy: r.requested_by, note: r.note, status: r.status, context: r.context, createdAt: r.created_at.toISOString() }));
}

// ---------------------------------------------------------------- running the rules

const getPath = (facts: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (typeof node === 'object' && node !== null && Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : undefined), facts);

// Runs the rules that belong to a point (and the earlier points) and brings the branch's issues up to date:
// new issues are raised, an approval that still covers the new value stays, one that does not reopens the issue,
// and an issue whose rule no longer fires is cleared. Returns all the issues of the branch.
export async function evaluateRules(
  db: Database,
  deps: UnderwritingDependencies,
  branchId: string,
  point: CheckPoint,
  actor: string,
  options: { today?: string } = {},
): Promise<UwIssue[]> {
  const branch = await getBranch(db, branchId);
  if (branch === null) throw new ValidationError(['The branch does not exist']);
  const policy = (await db.query<{ product_code: string; account_id: string }>('select product_code, account_id from policy.policy where id = $1', [branch.policyId])).rows[0];
  const rules = policy ? deps.rules.forVersion(policy.product_code, branch.productVersion) : null;
  if (!policy || rules === null) return []; // no underwriting set up for this product version

  const asOf = await getBranchAsOf(db, branchId, branch.periodStart);
  if (asOf === null) throw new ValidationError(['The branch does not exist']);
  const { facts } = await buildRisk(db, policy.account_id, asOf);
  const today = options.today ?? todayText();
  const reached = CHECK_POINTS.indexOf(point);
  const types = new Map(rules.issue_types.map((t) => [t.code, t]));

  await db.transaction(async (tx) => {
    for (const rule of rules.rules) {
      if (CHECK_POINTS.indexOf(rule.check_at) > reached) continue;
      const type = types.get(rule.issue_type);
      if (!type) continue;
      const fires = evaluateExpression(parseExpression(rule.when), facts);
      const existing = (await tx.query<{ id: string }>('select id from policy.uw_issue where branch_id = $1 and rule_code = $2', [branchId, rule.code])).rows[0];
      const current = existing ? await getIssue(tx, existing.id) : null;

      if (!fires) {
        if (current && current.status !== 'cleared') {
          await tx.query("update policy.uw_issue set status = 'cleared' where id = $1", [current.id]);
          await recordAudit(tx, { actor, action: 'uw.cleared', entityType: 'uw_issue', entityId: current.id, details: { ruleCode: rule.code } });
        }
        continue;
      }

      const value = getPath(facts, rule.value);
      if (typeof value !== 'number') throw new ValidationError([`Rule ${rule.code}: the fact ${rule.value} is not a number`]);
      if (!current) {
        const inserted = await tx.query<{ id: string }>(
          `insert into policy.uw_issue (branch_id, rule_code, issue_type, blocks, compare, value, message)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [branchId, rule.code, rule.issue_type, type.blocks, type.compare, value, rule.message],
        );
        const id = inserted.rows[0]?.id ?? '';
        await recordAudit(tx, { actor, action: 'uw.issue_raised', entityType: 'uw_issue', entityId: id, details: { ruleCode: rule.code, issueType: rule.issue_type, value, branchId } });
        continue;
      }

      // The issue exists. Decide what the new value does to an earlier approval.
      const approvedStillCovers =
        current.status === 'approved' &&
        current.decision !== null &&
        current.decision.decision !== 'rejected' &&
        covers(current.compare, current.decision.limit, value) &&
        (current.decision.validUntil === null || today <= current.decision.validUntil);
      let status: IssueStatus = current.status;
      if (current.status === 'cleared' || (current.status === 'approved' && !approvedStillCovers)) status = 'open';
      await tx.query('update policy.uw_issue set value = $2, status = $3 where id = $1', [current.id, value, status]);
      if (status !== current.status) {
        await recordAudit(tx, {
          actor,
          action: 'uw.reopened',
          entityType: 'uw_issue',
          entityId: current.id,
          details: { ruleCode: rule.code, from: current.status, value },
        });
      }
    }
  });
  return listIssues(db, branchId);
}

const BLOCK_LEVEL: Record<UwIssue['blocks'], number> = { quote: 0, bind: 1, issuance: 2, none: 99 };

// Runs the rules, then refuses if an issue that blocks this point is not approved. The issues are saved either way,
// so an underwriter can see them and act. Used before quoting; binding (D6) will use it for 'bind' and 'issuance'.
export async function checkUnderwriting(
  db: Database,
  deps: UnderwritingDependencies,
  branchId: string,
  point: CheckPoint,
  actor: string,
  options: { today?: string } = {},
): Promise<UwIssue[]> {
  const issues = await evaluateRules(db, deps, branchId, point, actor, options);
  const blockers = issues.filter((i) => ['open', 'referred', 'rejected'].includes(i.status) && BLOCK_LEVEL[i.blocks] <= CHECK_POINTS.indexOf(point));
  if (blockers.length > 0) {
    throw new ValidationError(
      blockers.map((i) => (i.status === 'rejected' ? `Underwriting issue ${i.issueType} was rejected: ${i.message}` : `Underwriting issue ${i.issueType} needs approval: ${i.message}`)),
    );
  }
  return issues;
}

// ---------------------------------------------------------------- referral and decisions

// "Request approval": anyone may ask. The issue becomes referred and a task with the full context goes to the underwriter queue.
export async function requestApproval(db: Database, issueId: string, actor: string, note?: string): Promise<UwIssue> {
  const issue = await getIssue(db, issueId);
  if (issue === null) throw new ValidationError(['The issue does not exist']);
  if (issue.status === 'referred') throw new ValidationError(['This issue is already referred to an underwriter']);
  if (issue.status !== 'open' && issue.status !== 'rejected') throw new ValidationError([`An issue that is ${issue.status} cannot be referred`]);

  const where = (
    await db.query<{ policy_number: string; job_number: string }>(
      `select p.policy_number, j.job_number from policy.policy_period b
         join policy.policy p on p.id = b.policy_id join policy.job j on j.id = b.job_id where b.id = $1`,
      [issue.branchId],
    )
  ).rows[0];
  const context = { branchId: issue.branchId, policyNumber: where?.policy_number, jobNumber: where?.job_number, issueType: issue.issueType, message: issue.message, value: issue.value };

  await db.transaction(async (tx) => {
    await tx.query("update policy.uw_issue set status = 'referred' where id = $1", [issueId]);
    await tx.query('insert into policy.uw_referral (issue_id, requested_by, note, context) values ($1, $2, $3, $4::jsonb)', [issueId, actor, note ?? null, JSON.stringify(context)]);
    await recordAudit(tx, { actor, action: 'uw.referred', entityType: 'uw_issue', entityId: issueId, details: { issueType: issue.issueType } });
  });
  const saved = await getIssue(db, issueId);
  if (saved === null) throw new Error('The issue could not be read back');
  return saved;
}

export interface DecisionInput {
  decision: DecisionKind;
  reason: string; // always required
  limit?: number; // approve up to (or down to) this value; default: the current value
  validUntil?: string; // last day the approval counts; default: the issue type's approval period
  conditions?: string; // required for approved_with_conditions
}

// Who may approve what: the grants of every authority profile the person holds, by role or by name.
async function grantsFor(db: Database, rules: UwRules, username: string, issueType: string) {
  const user = await getUserByUsername(db, username);
  if (user === null) return [];
  return rules.authority_profiles
    .filter((p) => p.users.includes(username) || p.roles.some((role) => user.roles.includes(role)))
    .flatMap((p) => p.grants)
    .filter((g) => g.issue_type === issueType);
}

// Approve, reject, or approve with conditions. The person must hold an authority profile with a grant for this issue
// type (and, to approve, a limit that reaches the approved ceiling). Every decision is kept with who decided and why.
export async function decideIssue(db: Database, deps: UnderwritingDependencies, issueId: string, input: DecisionInput, actor: string, options: { today?: string } = {}): Promise<UwIssue> {
  const issue = await getIssue(db, issueId);
  if (issue === null) throw new ValidationError(['The issue does not exist']);
  if (issue.status !== 'open' && issue.status !== 'referred') throw new ValidationError([`Only an open or referred issue can be decided (this one is ${issue.status})`]);

  const today = options.today ?? todayText();
  const errors: string[] = [];
  if (input.reason.trim() === '') errors.push('A reason is required for every decision');
  if (input.decision === 'approved_with_conditions' && (input.conditions ?? '').trim() === '') errors.push('Approval with conditions needs the conditions');
  const approving = input.decision !== 'rejected';
  const limit = approving ? (input.limit ?? issue.value) : null;
  if (approving && limit !== null && !covers(issue.compare, limit, issue.value)) errors.push('The approval ceiling must cover the current value');

  const branch = await getBranch(db, issue.branchId);
  const policy = branch ? (await db.query<{ product_code: string }>('select product_code from policy.policy where id = $1', [branch.policyId])).rows[0] : undefined;
  const rules = branch && policy ? deps.rules.forVersion(policy.product_code, branch.productVersion) : null;
  if (rules === null) errors.push('There are no underwriting rules for this policy');

  let validUntil: string | null = null;
  if (approving) {
    if (input.validUntil !== undefined) {
      if (!isRealDate(input.validUntil)) errors.push('The valid-until date is not a real date (write it as yyyy-mm-dd)');
      else if (input.validUntil < today) errors.push('The valid-until date is in the past');
      else validUntil = input.validUntil;
    } else {
      const days = rules?.issue_types.find((t) => t.code === issue.issueType)?.approval_valid_days;
      validUntil = days === undefined ? null : addDays(today, days);
    }
  }
  if (errors.length > 0 || rules === null) throw new ValidationError(errors);

  const grants = await grantsFor(db, rules, actor, issue.issueType);
  const allowed = approving ? grants.some((g) => g.limit === undefined || (limit !== null && covers(issue.compare, g.limit, limit))) : grants.length > 0;
  if (!allowed) throw new PermissionError(`uw.approve for ${issue.issueType}${approving && limit !== null ? ` up to ${limit}` : ''}`);

  await db.transaction(async (tx) => {
    await tx.query(
      `insert into policy.uw_decision (issue_id, decision, decided_by, reason, limit_value, valid_until, conditions)
       values ($1, $2, $3, $4, $5, $6::date, $7)`,
      [issueId, input.decision, actor, input.reason.trim(), limit, validUntil, input.conditions?.trim() ?? null],
    );
    await tx.query('update policy.uw_issue set status = $2 where id = $1', [issueId, approving ? 'approved' : 'rejected']);
    await tx.query("update policy.uw_referral set status = 'closed', closed_at = now() where issue_id = $1 and status = 'open'", [issueId]);
    await recordAudit(tx, {
      actor,
      action: 'uw.decision',
      entityType: 'uw_issue',
      entityId: issueId,
      reason: input.reason.trim(),
      details: { decision: input.decision, issueType: issue.issueType, limit, validUntil },
    });
  });
  const saved = await getIssue(db, issueId);
  if (saved === null) throw new Error('The issue could not be read back');
  return saved;
}
