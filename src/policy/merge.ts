import type { PGlite } from '@electric-sql/pglite';
import { isUuid, recordAudit, ValidationError } from '../platform/index.js';
import { moveJob, reopenIfQuoted } from './job-sync.js';
import type { Branch, Job } from './policy.js';
import { applyEdit, type EditInput, type ObjectKind, type Q } from './policy-change.js';
import { getBranch, getJob, nextOptionLabel, openBranch } from './policy-repository.js';

// Merging (document section 6, Appendix B): conflicts found when a change is dated before a change that is already
// bound, and rebasing a preempted job onto the newer version.

export interface MergeConflict {
  id: string;
  branchId: string;
  objectKind: ObjectKind;
  fixedId: string;
  field: string;
  editDate: string; // where the new edit starts
  laterVersion: number; // the bound version that already set the field
  laterDate: string; // from when it set it
  ourValue: unknown; // what the new edit wanted
  laterValue: unknown; // what the later change set; it wins until someone decides otherwise
  resolution: 'keep_later' | 'override' | null;
  resolvedBy: string | null;
  reason: string | null;
}

interface ConflictRow {
  id: string;
  branch_id: string;
  object_kind: ObjectKind;
  fixed_id: string;
  field: string;
  edit_date: string;
  later_version: number;
  later_date: string;
  our_value: unknown;
  later_value: unknown;
  resolution: 'keep_later' | 'override' | null;
  resolved_by: string | null;
  reason: string | null;
}

const CONFLICT_COLUMNS = `id, branch_id, object_kind, fixed_id, field, to_char(edit_date, 'YYYY-MM-DD') as edit_date, later_version,
  to_char(later_date, 'YYYY-MM-DD') as later_date, our_value, later_value, resolution, resolved_by, reason`;

const toConflict = (r: ConflictRow): MergeConflict => ({
  id: r.id,
  branchId: r.branch_id,
  objectKind: r.object_kind,
  fixedId: r.fixed_id,
  field: r.field,
  editDate: r.edit_date,
  laterVersion: r.later_version,
  laterDate: r.later_date,
  ourValue: r.our_value,
  laterValue: r.later_value,
  resolution: r.resolution,
  resolvedBy: r.resolved_by,
  reason: r.reason,
});

export async function listConflicts(db: Q, branchId: string): Promise<MergeConflict[]> {
  const result = await db.query<ConflictRow>(`select ${CONFLICT_COLUMNS} from policy.merge_conflict where branch_id = $1 order by seq`, [branchId]);
  return result.rows.map(toConflict);
}

// "Show each conflict to confirm or override": keep_later accepts the later change, override applies the new value
// from the later change's date to the end of the period. A reason is always required.
export async function resolveConflict(
  db: PGlite,
  conflictId: string,
  input: { resolution: 'keep_later' | 'override'; reason: string },
  actor: string,
): Promise<MergeConflict> {
  const found = isUuid(conflictId) ? (await db.query<ConflictRow>(`select ${CONFLICT_COLUMNS} from policy.merge_conflict where id = $1`, [conflictId])).rows[0] : undefined;
  if (!found) throw new ValidationError(['The merge conflict does not exist']);
  const conflict = toConflict(found);
  const errors: string[] = [];
  if (input.resolution !== 'keep_later' && input.resolution !== 'override') errors.push('The resolution must be keep_later or override');
  if (input.reason.trim() === '') errors.push('A reason is required to resolve a merge conflict');
  if (conflict.resolution !== null) errors.push('This merge conflict is already resolved');
  if (errors.length > 0) throw new ValidationError(errors);

  const branch = await openBranch(db, conflict.branchId);
  const table = conflict.objectKind === 'coverage' ? 'policy.coverage' : 'policy.coverable';
  const column = conflict.objectKind === 'coverage' ? 'terms' : 'attributes';
  await db.transaction(async (tx) => {
    await reopenIfQuoted(tx, branch, actor);
    if (input.resolution === 'override') {
      await tx.query(
        `update ${table} set ${column} = ${column} || jsonb_build_object($4::text, $5::jsonb) where branch_id = $1 and fixed_id = $2 and eff_from >= $3::date`,
        [conflict.branchId, conflict.fixedId, conflict.laterDate, conflict.field, JSON.stringify(conflict.ourValue)],
      );
    }
    await tx.query('update policy.merge_conflict set resolution = $2, resolved_by = $3, reason = $4, resolved_at = now() where id = $1', [conflictId, input.resolution, actor, input.reason.trim()]);
    await recordAudit(tx, {
      actor,
      action: 'merge.resolve',
      entityType: 'policy_period',
      entityId: conflict.branchId,
      reason: input.reason.trim(),
      details: { resolution: input.resolution, field: conflict.field, kind: conflict.objectKind, fixedId: conflict.fixedId },
    });
  });
  const saved = (await db.query<ConflictRow>(`select ${CONFLICT_COLUMNS} from policy.merge_conflict where id = $1`, [conflictId])).rows[0];
  if (!saved) throw new Error('The conflict could not be read back');
  return toConflict(saved);
}

// ---------------------------------------------------------------- rebasing

interface Edit {
  kind: ObjectKind;
  fixedId: string;
  date: string;
  patch: Record<string, unknown> | null;
}

interface SliceRow {
  fixed_id: string;
  eff_from: string;
  eff_to: string;
  data: Record<string, unknown>;
}

const TABLES: Record<ObjectKind, { table: string; column: string }> = {
  coverable: { table: 'policy.coverable', column: 'attributes' },
  coverage: { table: 'policy.coverage', column: 'terms' },
};

async function slicesOf(q: Q, kind: ObjectKind, branchId: string): Promise<SliceRow[]> {
  const { table, column } = TABLES[kind];
  const result = await q.query<SliceRow>(
    `select fixed_id, to_char(eff_from, 'YYYY-MM-DD') as eff_from, to_char(eff_to, 'YYYY-MM-DD') as eff_to, ${column} as data from ${table} where branch_id = $1 order by eff_from`,
    [branchId],
  );
  return result.rows;
}

const valueOn = (rows: SliceRow[], fixedId: string, date: string): Record<string, unknown> | null =>
  rows.find((r) => r.fixed_id === fixedId && r.eff_from <= date && date < r.eff_to)?.data ?? null;

// Works out what a branch changed compared with the version it was copied from, as field-level edits ("set idv to X
// from this date", "remove this cover from this date"). Objects that are new in the branch are copied whole instead.
async function extractEdits(q: Q, branch: Branch): Promise<{ edits: Edit[]; added: { kind: ObjectKind; fixedId: string }[] }> {
  const edits: Edit[] = [];
  const added: { kind: ObjectKind; fixedId: string }[] = [];
  if (branch.basedOnId === null) return { edits, added };

  for (const kind of ['coverable', 'coverage'] as const) {
    const mine = await slicesOf(q, kind, branch.id);
    const base = await slicesOf(q, kind, branch.basedOnId);
    const baseIds = new Set(base.map((r) => r.fixed_id));
    for (const fixedId of new Set(mine.map((r) => r.fixed_id))) {
      if (!baseIds.has(fixedId)) {
        added.push({ kind, fixedId });
        continue;
      }
      const rows = [...mine, ...base].filter((r) => r.fixed_id === fixedId);
      const dates = [...new Set(rows.flatMap((r) => [r.eff_from, r.eff_to]))].filter((d) => d >= branch.periodStart && d < branch.periodEnd).sort();
      const state = new Map<string, { differs: boolean; value: string }>();
      let removed = false;
      for (const date of dates) {
        const now = valueOn(mine, fixedId, date);
        const was = valueOn(base, fixedId, date);
        if (now === null && was !== null) {
          if (!removed) edits.push({ kind, fixedId, date, patch: null });
          removed = true;
          continue;
        }
        removed = false;
        if (now === null || was === null) continue;
        for (const field of new Set([...Object.keys(now), ...Object.keys(was)])) {
          const mineText = JSON.stringify(now[field] ?? null);
          const differs = mineText !== JSON.stringify(was[field] ?? null);
          const before = state.get(field) ?? { differs: false, value: '' };
          if (differs && (!before.differs || before.value !== mineText)) edits.push({ kind, fixedId, date, patch: { [field]: now[field] } });
          else if (!differs && before.differs && was[field] !== undefined) edits.push({ kind, fixedId, date, patch: { [field]: was[field] } });
          state.set(field, { differs, value: mineText });
        }
      }
    }
  }
  return { edits: edits.sort((a, b) => a.date.localeCompare(b.date)), added };
}

// Rebases a preempted job (document section 6): another job bound a newer version first, so this job's working copy
// is replaced by a new copy of the newest version, and its own edits are applied again with the same merge rules as
// an out-of-sequence change (conflicts are recorded for a person to decide). The old copy is withdrawn. Everything
// happens in one transaction: if an edit no longer fits, nothing changes.
export async function rebaseJob(db: PGlite, jobId: string, actor: string): Promise<{ job: Job; branch: Branch }> {
  const job = await getJob(db, jobId);
  if (job === null) throw new ValidationError(['The job does not exist']);
  if (job.type !== 'policy_change' || job.status !== 'preempted') throw new ValidationError([`Only a preempted job can be rebased (this one is ${job.status})`]);

  const oldId = (await db.query<{ id: string }>("select id from policy.policy_period where job_id = $1 and status <> 'withdrawn' order by created_at desc, label desc limit 1", [jobId])).rows[0]?.id;
  const old = oldId ? await getBranch(db, oldId) : null;
  if (old === null || old.basedOnId === null) throw new ValidationError(['The job has no working copy to rebase']);
  const latest = (
    await db.query<{ id: string; version: number }>(
      "select id, version from policy.policy_period where policy_id = $1 and term_number = $2 and status = 'bound' order by version desc limit 1",
      [old.policyId, old.termNumber],
    )
  ).rows[0];
  if (!latest || latest.id === old.basedOnId) throw new ValidationError(['There is no newer version to rebase onto']);

  const created = await db.transaction(async (tx) => {
    const { edits, added } = await extractEdits(tx, old);
    const inserted = await tx.query<{ id: string }>(
      `insert into policy.policy_period (policy_id, job_id, term_number, label, based_on_id, period_start, period_end, product_version, created_by)
       select policy_id, $2, term_number, $3, id, period_start, period_end, product_version, $4 from policy.policy_period where id = $1 returning id`,
      [latest.id, jobId, await nextOptionLabel(tx, jobId), actor],
    );
    const newId = inserted.rows[0]?.id;
    if (newId === undefined) throw new Error('The branch was not saved');
    await tx.query(
      `insert into policy.coverable (branch_id, fixed_id, kind, eff_from, eff_to, attributes, created_by)
       select $2, fixed_id, kind, eff_from, eff_to, attributes, $3 from policy.coverable where branch_id = $1 order by row_id`,
      [latest.id, newId, actor],
    );
    await tx.query(
      `insert into policy.coverage (branch_id, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, created_by)
       select $2, fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms, $3 from policy.coverage where branch_id = $1 order by row_id`,
      [latest.id, newId, actor],
    );
    // Things the old copy added (a new cover) come across whole, as long as the new version does not already have them.
    for (const item of added) {
      const { table } = TABLES[item.kind];
      const copyColumns =
        item.kind === 'coverable' ? 'fixed_id, kind, eff_from, eff_to, attributes' : 'fixed_id, coverable_fid, pattern_code, eff_from, eff_to, terms';
      const targetColumns = `branch_id, ${copyColumns}, created_by`;
      await tx.query(
        `insert into ${table} (${targetColumns}) select $2, ${copyColumns}, $3 from ${table} src
          where src.branch_id = $1 and src.fixed_id = $4 and not exists (select 1 from ${table} x where x.branch_id = $2 and x.fixed_id = $4) order by row_id`,
        [old.id, newId, actor, item.fixedId],
      );
    }
    const fresh = await getBranch(tx, newId);
    if (fresh === null) throw new Error('The branch was not saved');
    for (const edit of edits) {
      try {
        await applyEdit(tx, fresh, edit.kind, { fixedId: edit.fixedId, effectiveDate: edit.date, patch: edit.patch } satisfies EditInput, actor);
      } catch (error) {
        if (error instanceof ValidationError) throw new ValidationError([`An edit from ${edit.date} cannot be reapplied: ${error.errors.join('; ')}`]);
        throw error;
      }
    }
    await tx.query("update policy.policy_period set status = 'withdrawn' where id = $1", [old.id]);
    await recordAudit(tx, { actor, action: 'branch.withdraw', entityType: 'policy_period', entityId: old.id, details: { reason: 'rebased' } });
    await recordAudit(tx, { actor, action: 'branch.rebase', entityType: 'policy_period', entityId: newId, details: { from: old.id, onto: latest.id, version: latest.version } });
    await moveJob(tx, jobId, 'draft', actor, `Rebased onto version ${latest.version}`);
    return newId;
  });

  const savedJob = await getJob(db, jobId);
  const branch = await getBranch(db, created);
  if (savedJob === null || branch === null) throw new Error('The rebased job could not be read back');
  return { job: savedJob, branch };
}
