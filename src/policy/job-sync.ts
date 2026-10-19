import type { Database } from '../platform/index.js';

type Tx = Pick<Database, 'query'>;
import { recordAudit, ValidationError } from '../platform/index.js';
import { allowedNextStatuses } from './job-status.js';
import type { Branch, JobStatus, JobType } from './policy.js';

// Moves a job along its life cycle (document section 8). Every move must be an arrow of the diagram, and is
// audited in the same transaction as the change.
export async function moveJob(tx: Tx, jobId: string, to: JobStatus, actor: string, reason?: string): Promise<void> {
  const found = await tx.query<{ type: JobType; status: JobStatus }>('select type, status from policy.job where id = $1', [jobId]);
  const job = found.rows[0];
  if (!job) throw new ValidationError(['The job does not exist']);
  if (!allowedNextStatuses(job.type, job.status).includes(to)) {
    throw new ValidationError([`A ${job.type} job cannot move from ${job.status} to ${to}`]);
  }
  await tx.query('update policy.job set status = $2 where id = $1', [jobId, to]);
  await recordAudit(tx, {
    actor,
    action: 'job.status',
    entityType: 'job',
    entityId: jobId,
    ...(reason === undefined ? {} : { reason }),
    details: { from: job.status, to },
  });
}

// A submission is "quoted" when it has at least one open option and every open option is quoted. When a branch is
// quoted or edited, the job follows. Withdrawn branches do not count.
export async function refreshJobStatus(tx: Tx, jobId: string, actor: string): Promise<void> {
  const job = (await tx.query<{ status: JobStatus }>('select status from policy.job where id = $1', [jobId])).rows[0];
  if (!job || (job.status !== 'draft' && job.status !== 'quoted')) return;

  const open = await tx.query<{ status: string }>("select status from policy.policy_period where job_id = $1 and status <> 'withdrawn'", [jobId]);
  const allQuoted = open.rows.length > 0 && open.rows.every((b) => b.status === 'quoted');
  if (allQuoted && job.status === 'draft') await moveJob(tx, jobId, 'quoted', actor);
  else if (!allQuoted && job.status === 'quoted') await moveJob(tx, jobId, 'draft', actor);
}

// Editing a quoted branch makes its price stale, so the branch goes back to draft and the job follows.
export async function reopenIfQuoted(tx: Tx, branch: Branch, actor: string): Promise<void> {
  if (branch.status !== 'quoted') return;
  await tx.query("update policy.policy_period set status = 'draft' where id = $1", [branch.id]);
  await recordAudit(tx, { actor, action: 'branch.reopen', entityType: 'policy_period', entityId: branch.id, details: { reason: 'edited after quote' } });
  await refreshJobStatus(tx, branch.jobId, actor);
}
