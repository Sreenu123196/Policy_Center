import type { JobStatus, JobType } from './policy.js';

// The life cycle of a job (document section 8). A job can only follow these arrows.
const NEXT: Record<JobStatus, JobStatus[]> = {
  draft: ['quoted', 'withdrawn', 'declined', 'preempted'],
  quoted: ['draft', 'binding', 'withdrawn', 'declined', 'preempted'], // back to draft when it is edited
  binding: ['bound', 'quoted'],
  bound: ['issued'],
  issued: [],
  withdrawn: [],
  declined: [],
  not_taken: [],
  preempted: ['draft'], // rebased onto the new version, then continued as a draft
};

// "Not taken" means the customer let a quote or a renewal offer lapse, so only those job types can end that way.
const CAN_BE_NOT_TAKEN: JobType[] = ['submission', 'renewal'];

export function allowedNextStatuses(type: JobType, from: JobStatus): JobStatus[] {
  return from === 'quoted' && CAN_BE_NOT_TAKEN.includes(type) ? [...NEXT[from], 'not_taken'] : NEXT[from];
}

// Nothing can follow these. A bound job can still be issued, so it is not final.
export const isFinalStatus = (status: JobStatus): boolean => NEXT[status].length === 0;
