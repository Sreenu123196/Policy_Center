'use strict';
// The bind gate.
//
// Binding costs money if it is wrong, so the assistant cannot do it. It can ask a person, and then it can only present the
// id of a record that person changed. Every rule is re-read at execution time: an approval is not a flag, it is a row with
// a status, an approver, a premium, a timestamp and a single use.
//
// The nine refusals here are the point of the module; the happy path is the easy case.

const { AppError } = require('./appError');

// How much premium each role may authorise. A manager signs for more than an underwriter, and an agent signs for the least.
const AUTHORITY = { 'UW Manager': 1000000, Underwriter: 250000, Agent: 50000 };
const WINDOW_MS = 30 * 60 * 1000;

function createBindGate(pc, store) {
  const approvals = () => {
    if (!Array.isArray(store.data.bindApprovals)) store.data.bindApprovals = [];
    return store.data.bindApprovals;
  };

  function jobFor(id) {
    const job = (store.data.jobs || []).find((j) => j.id === id || j.jobNumber === id);
    if (!job) throw new AppError(404, 'Job not found');
    return job;
  }

  function requestApproval(user, jobId) {
    const job = jobFor(jobId);
    if (job.status !== 'Quoted') throw new AppError(422, 'Only a quoted job can be sent for a bind approval');
    const record = {
      id: 'BA-' + String(store.next('bindApproval')).padStart(7, '0'),
      jobId: job.id,
      status: 'pending',
      premium: Number(job.premium || job.quotedPremium || 0),
      requestedBy: user && user.id,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
      usedAt: null,
    };
    approvals().push(record);
    return record;
  }

  /** A person decides. Kept here so tests and the API share one path. */
  function decide(user, approvalId, status) {
    const record = approvals().find((a) => a.id === approvalId);
    if (!record) throw new AppError(404, 'Approval not found');
    if (!['approved', 'declined'].includes(status)) throw new AppError(422, 'status must be approved or declined');
    if (record.status !== 'pending') throw new AppError(409, 'This approval has already been decided');
    // Separation of duties: the person who asked for the bind cannot be the person who approves it. A manager approving their
    // own request is the exact conflict this gate exists to prevent.
    if (record.requestedBy && user && record.requestedBy === user.id) {
      throw new AppError(403, 'You cannot decide an approval you requested');
    }
    record.status = status;
    record.decidedAt = new Date().toISOString();
    record.decidedBy = user && user.id;
    return record;
  }

  /**
   * Bind, if and only if a live, matching, in-authority, unused approval says so.
   * @returns {{bound: true, policyNumber: string, approvalId: string}}
   */
  function bind(user, jobId, approvalId) {
    const job = jobFor(jobId);
    const record = approvals().find((a) => a.id === approvalId);
    if (!record) throw new AppError(403, 'A bind approval is required');
    if (record.jobId !== job.id) throw new AppError(403, 'That approval is for a different job');
    if (record.status !== 'approved') throw new AppError(403, 'The approval has not been given');
    if (record.usedAt) throw new AppError(409, 'That approval has already been used');
    if (Date.now() - new Date(record.decidedAt || record.createdAt).getTime() > WINDOW_MS) {
      throw new AppError(403, 'The approval has expired; ask again');
    }
    const authority = AUTHORITY[record.decidedBy ? (store.data.staff || []).find((s) => s.username === record.decidedBy || s.id === record.decidedBy)?.role : user.role];
    const approverRole = record.approverRole || (store.data.staff || []).find((s) => s.id === record.decidedBy || s.username === record.decidedBy)?.role;
    const limit = AUTHORITY[approverRole];
    if (limit === undefined || record.premium > limit) throw new AppError(403, 'The approver’s authority does not cover this premium');
    if (job.status !== 'Quoted') throw new AppError(409, 'The job is not quoted');
    if (job.referred || (Array.isArray(job.uwIssues) && job.uwIssues.length)) throw new AppError(409, 'The job has open underwriting issues');

    const bound = pc.bind(job.id, user);
    record.usedAt = new Date().toISOString();
    record.usedBy = user && user.id;
    return { bound: true, policyNumber: bound.policyNumber || bound.policyNo, approvalId: record.id };
  }

  /** What is waiting for a person, newest first, with the job's number for the screen. */
  function list() {
    return approvals().slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  return { requestApproval, decide, bind, list, AUTHORITY, WINDOW_MS };
}

module.exports = { createBindGate, AUTHORITY, WINDOW_MS };
