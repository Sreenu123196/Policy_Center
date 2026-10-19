'use strict';
// Claims: stages, exposures, reserves and payments. Mixed into PolicyCenter's prototype at the end of
// src/policyCenter.js, so these methods run with `this` pointing at the service exactly as before.

const { AppError } = require('../appError');
const { round2 } = require('../rating');
const { str } = require('../text');
const D = require('../dates');
const { canSeeClaimReserves } = require('../permissions');

// A loss reported more than this many days after it happened is flagged as a late report.
const LATE_REPORT_DAYS = 30;

const CLAIM_TYPES = ['Collision', 'Comprehensive', 'Liability', 'Medical', 'Property', 'Theft', 'Water', 'Wind or hail', 'Other'];

// Claim stages and what each stage may move to.
const CLAIM_TRANSITIONS = {
  Submitted: ['Under Review', 'Rejected'],
  'Under Review': ['Documents Pending', 'Approved', 'Rejected'],
  'Documents Pending': ['Under Review'],
  Approved: ['Settled'],
  Rejected: [],
  Settled: [],
};

class Claims {
  // ------------------------------------------------------------------ claims
  // Claim stages: Submitted > Under Review > Documents Pending > Approved / Rejected > Settled.
  // Reserves can be set once a claim is under review; money is paid only after approval.
  // Reserve = the expected remaining cost (internal). Paid = money already paid out.

  claim(id, user) {
    const c = this.db.claims.find((x) => x.id === id || x.claimNumber === id);
    if (!c) throw new AppError(404, 'Claim not found');
    if (user) this.policy(c.policyId, user);
    return c;
  }

  claimView(c, user) {
    const paid = round2(c.payments.reduce((s, p) => s + p.amount, 0));
    const policy = this.db.policies.find((p) => p.id === c.policyId);
    return {
      id: c.id, claimNumber: c.claimNumber, policyNumber: policy ? policy.policyNumber : null, product: c.product,
      insured: this.accountName(this.db.accounts.find((a) => a.id === c.accountId)),
      lossDate: c.lossDate, lossType: c.lossType, description: c.description, status: c.status,
      reportedOn: c.reportedOn, paid, payments: c.payments, closedOn: c.closedOn || null, closeReason: c.closeReason || null,
      lateReport: Boolean(c.lateReport),
      verification: c.verification || 'verified',
      verificationNote: c.verificationNote || '',
      policySnapshot: c.policySnapshot ? this.snapshotSummary(c.policySnapshot) : null,
      history: c.history || [],
      nextStages: CLAIM_TRANSITIONS[c.status] || [],
      exposures: (c.exposures || []).map((e) => this.exposureView(c, e, user)),
      pendingPayments: (c.pendingPayments || []).map((p) => ({ id: p.id, exposureNumber: p.exposureNumber, amount: p.amount, costType: p.costType, requestedBy: p.requestedBy, requestedAt: p.requestedAt })),
      documents: (c.documents || []).map(({ path, ...d }) => d),
      ...(user && !canSeeClaimReserves(user) ? {} : { reserve: c.reserve, outstanding: round2(Math.max(0, c.reserve - paid)) }),
    };
  }

  // One exposure with its money. The reserve and what is outstanding are internal, like the claim's own.
  exposureView(c, e, user) {
    const mine = c.payments.filter((p) => p.exposureNumber === e.number);
    const paid = round2(mine.reduce((sum, p) => sum + p.amount, 0));
    const paidByCostType = { claim_cost: 0, expense: 0 };
    for (const p of mine) paidByCostType[p.costType] = round2(paidByCostType[p.costType] + p.amount);
    const open = user && !canSeeClaimReserves(user) ? {} : { reserve: e.reserve, outstanding: round2(Math.max(0, e.reserve - paid)), incurred: round2(Math.max(e.reserve, paid)) };
    return { id: e.id, number: e.number, coverage: e.coverage, claimant: e.claimant, description: e.description, paid, paidByCostType, ...open };
  }

  // What a person needs from the snapshot: where it sits in the policy and what was insured. The full risk stays on the claim.
  snapshotSummary(s) {
    const { line, ...rest } = s;
    return { ...rest, vehicles: (line.vehicles || []).map((v) => ({ year: v.year, make: v.make, model: v.model })) };
  }

  claimDetail(id, user) {
    return this.claimView(this.claim(id, user), user);
  }

  listClaims(user, { policy, status } = {}) {
    return this.db.claims
      .filter((c) => {
        const account = this.db.accounts.find((a) => a.id === c.accountId);
        return account && this.canSee(user, account);
      })
      .filter((c) => !policy || this.db.policies.find((p) => p.id === c.policyId)?.policyNumber === policy)
      .filter((c) => !status || c.status === status)
      .map((c) => this.claimView(c, user))
      .reverse();
  }

  openClaim(policyId, input, user) {
    const policy = this.policy(policyId, user);
    const lossDate = str(input.lossDate);
    if (!D.isDate(lossDate)) throw new AppError(422, 'Loss date must be yyyy-mm-dd');
    if (lossDate > this.today()) throw new AppError(422, 'Loss date cannot be in the future');
    const inTerm = this.terms(policy).some((t) => t.effectiveDate <= lossDate && lossDate < t.expirationDate);
    if (!inTerm) throw new AppError(422, `No term of ${policy.policyNumber} covers ${lossDate}`);
    const snapshot = this.policyAsOf(policy, lossDate);
    const lossType = str(input.lossType);
    if (!CLAIM_TYPES.includes(lossType)) throw new AppError(422, `Loss type must be one of ${CLAIM_TYPES.join(', ')}`);
    const claim = {
      id: this.store.id('clm'),
      claimNumber: this.store.number('CL-', 7),
      policyId: policy.id,
      accountId: policy.accountId,
      product: policy.product,
      lossDate,
      lossType,
      description: str(input.description),
      status: 'Submitted',
      reportedOn: this.today(),
      lateReport: D.daysBetween(lossDate, this.today()) > LATE_REPORT_DAYS,
      policySnapshot: snapshot,
      verification: snapshot.status === 'in_force' ? 'verified' : 'not_verified',
      verificationNote: snapshot.status === 'in_force' ? '' : `The policy was cancelled effective ${policy.cancellation.effectiveDate}, before the loss date`,
      reserve: 0,
      payments: [],
      documents: [],
      history: [{ at: this.now(), by: user.id, from: null, to: 'Submitted', reason: 'Claim submitted' }],
      createdBy: user.id,
    };
    this.db.claims.push(claim);
    this.publish('ClaimOpened', { claimNumber: claim.claimNumber, policyNumber: policy.policyNumber, lossDate, lossType, lateReport: claim.lateReport, verification: claim.verification });
    return claim;
  }

  // Moves a claim to the next stage. Staff only, following the allowed stage order.
  moveClaim(id, { to, reason }, user) {
    this.requireAuthority(user, 1, 'move claims between stages');
    const claim = this.claim(id, user);
    const allowed = CLAIM_TRANSITIONS[claim.status] || [];
    if (!allowed.includes(to)) throw new AppError(409, `A ${claim.status} claim cannot move to ${to}. Allowed: ${allowed.join(', ') || 'none (final stage)'}`);
    if (to === 'Settled') {
      const paid = round2(claim.payments.reduce((s, p) => s + p.amount, 0));
      claim.reserve = paid;
      claim.closedOn = this.today();
      claim.closeReason = str(reason) || 'Settled';
    }
    if (to === 'Rejected') {
      claim.closedOn = this.today();
      claim.closeReason = str(reason) || 'Rejected';
    }
    claim.history.push({ at: this.now(), by: user.id, from: claim.status, to, reason: str(reason) });
    claim.status = to;
    this.publish('ClaimStageChanged', { claimNumber: claim.claimNumber, stage: to });
    return this.claimView(claim, user);
  }

  assertClaimAt(claim, stages, action) {
    if (!stages.includes(claim.status)) throw new AppError(409, `Claim ${claim.claimNumber} is ${claim.status}; ${action} needs it to be ${stages.join(' or ')}`);
  }

  setClaimReserve(id, amount, user) {
    this.requireAuthority(user, 1, 'set claim reserves');
    const claim = this.claim(id, user);
    this.assertClaimAt(claim, ['Under Review', 'Documents Pending', 'Approved'], 'setting a reserve');
    if ((claim.exposures || []).length > 0) throw new AppError(409, 'This claim has exposures: set the reserve on an exposure');
    const value = Number(amount);
    const paid = claim.payments.reduce((s, p) => s + p.amount, 0);
    if (!Number.isFinite(value) || value < paid) throw new AppError(422, `Reserve cannot be below the ${round2(paid)} already paid`);
    claim.reserve = round2(value);
    return this.claimView(claim, user);
  }

  payClaim(id, { amount, note }, user) {
    this.requireAuthority(user, 1, 'pay claims');
    const claim = this.claim(id, user);
    this.assertClaimAt(claim, ['Approved'], 'a payment');
    if ((claim.exposures || []).length > 0) throw new AppError(409, 'This claim has exposures: pay from an exposure');
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new AppError(422, 'Payment must be more than zero');
    const paid = claim.payments.reduce((s, p) => s + p.amount, 0);
    if (round2(paid + value) > claim.reserve) throw new AppError(422, 'Payment would exceed the reserve; raise the reserve first');
    claim.payments.push({ date: this.today(), amount: round2(value), note: str(note), by: user.id });
    this.publish('ClaimPaid', { claimNumber: claim.claimNumber, amount: round2(value) });
    return this.claimView(claim, user);
  }
}

module.exports = { Claims, CLAIM_TYPES, CLAIM_TRANSITIONS };
