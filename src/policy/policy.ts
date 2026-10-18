// Policies, jobs and branches (document sections 4, 5 and 8). Dates are plain text in the form yyyy-mm-dd;
// the end of a range is exclusive (the first day NOT covered). Money in term values is whole paise.

export const JOB_TYPES = ['submission', 'issuance', 'policy_change', 'cancellation', 'reinstatement', 'renewal', 'rewrite', 'audit'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export type JobStatus = 'draft' | 'quoted' | 'binding' | 'bound' | 'issued' | 'withdrawn' | 'declined' | 'not_taken' | 'preempted';
export type BranchStatus = 'draft' | 'quoted' | 'bound' | 'withdrawn';

export const COVERABLE_KINDS = ['Vehicle', 'Driver', 'Location', 'Building'] as const;
export type CoverableKind = (typeof COVERABLE_KINDS)[number];

// The contract. Its number never changes.
export interface Policy {
  id: string;
  policyNumber: string; // for example PL-0000001
  accountId: string;
  productCode: string;
  createdBy: string;
  createdAt: string;
}

// A unit of work on a policy: a submission, a change, a renewal ...
export interface Job {
  id: string;
  jobNumber: string; // for example J-0000001
  policyId: string;
  type: JobType;
  status: JobStatus;
  createdBy: string;
  createdAt: string;
}

// A working copy of one term inside a job (the document also calls it a policy period). Once bound it is a
// numbered version that is never edited again.
export interface Branch {
  id: string;
  policyId: string;
  jobId: string;
  termNumber: number;
  version: number | null; // given when the branch is bound
  basedOnId: string | null; // the version this branch was copied from
  status: BranchStatus;
  periodStart: string;
  periodEnd: string; // exclusive
  productVersion: string; // the product version in force on the start date
  createdBy: string;
  createdAt: string;
}

// One slice of a thing insured (a vehicle, a driver ...). The fixed id is the same for every slice and version of the object.
export interface CoverableSlice {
  fixedId: string;
  kind: CoverableKind;
  effFrom: string;
  effTo: string;
  attributes: Record<string, unknown>;
}

// One slice of a coverage on a coverable.
export interface CoverageSlice {
  fixedId: string;
  coverableFixedId: string;
  patternCode: string;
  effFrom: string;
  effTo: string;
  terms: Record<string, number | string>;
}

// The branch as it was on one date.
export interface BranchAsOf {
  branch: Branch;
  date: string;
  coverables: CoverableSlice[];
  coverages: CoverageSlice[];
}
