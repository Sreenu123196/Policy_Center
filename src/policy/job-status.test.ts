import { describe, expect, it } from 'vitest';
import { allowedNextStatuses, isFinalStatus } from './job-status.js';
import { JOB_TYPES, type JobStatus, type JobType } from './policy.js';

const ALL_STATUSES: JobStatus[] = ['draft', 'quoted', 'binding', 'bound', 'issued', 'withdrawn', 'declined', 'not_taken', 'preempted'];

// The life cycle of document section 8, written out as a diagram, one line per status.
// A job can only follow these arrows; every other move is forbidden.
const DIAGRAM: Record<JobStatus, JobStatus[]> = {
  draft: ['quoted', 'withdrawn', 'declined', 'preempted'],
  quoted: ['draft', 'binding', 'withdrawn', 'declined', 'preempted'], // not_taken is added for submissions and renewals below
  binding: ['bound', 'quoted'],
  bound: ['issued'],
  issued: [],
  withdrawn: [],
  declined: [],
  not_taken: [],
  preempted: ['draft'], // rebase onto the new version, then continue as a draft
};

// "Not taken" means the customer let a quote or a renewal offer lapse, so only those job types can end that way.
const CAN_BE_NOT_TAKEN: JobType[] = ['submission', 'renewal'];

const expected = (type: JobType, from: JobStatus): JobStatus[] =>
  from === 'quoted' && CAN_BE_NOT_TAKEN.includes(type) ? [...DIAGRAM[from], 'not_taken'] : DIAGRAM[from];

describe('the job life cycle (document section 8)', () => {
  for (const type of JOB_TYPES) {
    it(`for a ${type} job allows exactly the moves in the diagram, and forbids every other one`, () => {
      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          const allowed = allowedNextStatuses(type, from).includes(to);
          expect(allowed, `${type}: ${from} -> ${to}`).toBe(expected(type, from).includes(to));
        }
      }
    });
  }

  it('has final states from which nothing can follow: issued, withdrawn, declined and not taken', () => {
    for (const type of JOB_TYPES) {
      for (const status of ['issued', 'withdrawn', 'declined', 'not_taken'] as const) {
        expect(allowedNextStatuses(type, status)).toEqual([]);
        expect(isFinalStatus(status)).toBe(true);
      }
    }
    expect(isFinalStatus('draft')).toBe(false);
    expect(isFinalStatus('bound')).toBe(false); // a bound job can still be issued
  });

  it('never lets a job skip a step: a draft cannot go straight to bound or issued', () => {
    for (const type of JOB_TYPES) {
      expect(allowedNextStatuses(type, 'draft')).not.toContain('bound');
      expect(allowedNextStatuses(type, 'draft')).not.toContain('issued');
      expect(allowedNextStatuses(type, 'quoted')).not.toContain('bound');
    }
  });
});
