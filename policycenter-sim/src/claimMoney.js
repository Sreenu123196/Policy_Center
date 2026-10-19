'use strict';
// Claim exposures, reserves and payments with financial authority. Ported from the Insurance Suite claims module.
//
//   - An exposure is one claimant against one cover (own damage for the insured, a third party's motorcycle).
//   - Reserves are set per exposure; the claim's reserve is their total. Every change is kept in claim.reserveChanges.
//   - A payment belongs to an exposure and has a cost type (claim cost or expense). It may not take the exposure past its
//     reserve, counting payments that are still waiting.
//   - Each person has limits for setting a reserve and for making a payment (RESERVE_LIMITS, PAYMENT_LIMITS, by
//     authority level). A payment above your limit waits for a DIFFERENT person whose limit covers it; above everyone's
//     limit it is refused. Nobody approves their own payment.
//   - claim.reserve and claim.payments stay the claim's totals, so the older screens, reports and messages keep working.
// Limits are in the app's currency (dollars). Change them here, not in the code that applies them.

const { AppError } = require('./policyCenter');
const { round2 } = require('./rating');
const { levelOf } = require('./permissions');

const RESERVE_LIMITS = { 1: 25000, 2: 250000 }; // by authority level
const PAYMENT_LIMITS = { 1: 5000, 2: 50000 };
const COST_TYPES = ['claim_cost', 'expense'];
const CLAIMANT_KINDS = ['insured', 'third_party'];
const MONEY_STAGES = ['Under Review', 'Documents Pending', 'Approved'];

const limitOf = (limits, user) => limits[Math.min(user.authority, 2)] || 0;
const highest = (limits) => Math.max(...Object.values(limits));
const text = (v) => String(v == null ? '' : v).trim();

class ClaimMoney {
  constructor(pc) {
    this.pc = pc;
  }

  load(user, claimId) {
    this.pc.requireAuthority(user, 1, 'work on claim exposures and payments');
    // An insurance executive reads claims (status and amounts paid) but does not change them or move money.
    if (levelOf(user) === 'executive') throw new AppError(403, `${user.role} can read claims but cannot change exposures, reserves or payments`);
    const claim = this.pc.claim(claimId, user);
    claim.exposures = claim.exposures || [];
    claim.pendingPayments = claim.pendingPayments || [];
    claim.reserveChanges = claim.reserveChanges || [];
    return claim;
  }

  exposureOf(claim, number) {
    const exposure = claim.exposures.find((e) => e.number === Number(number));
    if (!exposure) throw new AppError(404, `Claim ${claim.claimNumber} has no exposure ${number}`);
    return exposure;
  }

  paidOn(claim, exposure) {
    return round2(claim.payments.filter((p) => p.exposureNumber === exposure.number).reduce((s, p) => s + p.amount, 0));
  }

  pendingOn(claim, exposure) {
    return round2(claim.pendingPayments.filter((p) => p.exposureNumber === exposure.number).reduce((s, p) => s + p.amount, 0));
  }

  addExposure(user, claimId, input) {
    const claim = this.load(user, claimId);
    this.pc.assertClaimAt(claim, MONEY_STAGES, 'adding an exposure');
    const errors = [];
    if (!text(input.coverage)) errors.push('The cover is required');
    if (!text(input.claimantName)) errors.push('The claimant name is required');
    if (!CLAIMANT_KINDS.includes(input.claimantKind)) errors.push(`The claimant must be ${CLAIMANT_KINDS.join(' or ')}`);
    if (errors.length > 0) throw new AppError(422, errors.join('; '), { errors: errors.map((message) => ({ message })) });
    const exposure = {
      id: this.pc.store.id('exp'),
      number: claim.exposures.length + 1,
      coverage: text(input.coverage),
      claimant: { name: text(input.claimantName), kind: input.claimantKind },
      description: text(input.description),
      reserve: 0,
      createdBy: user.id,
      createdAt: this.pc.now(),
    };
    claim.exposures.push(exposure);
    this.pc.publish('ClaimExposureAdded', { claimNumber: claim.claimNumber, exposure: exposure.number, coverage: exposure.coverage });
    return exposure;
  }

  setExposureReserve(user, claimId, number, amount) {
    const claim = this.load(user, claimId);
    this.pc.assertClaimAt(claim, MONEY_STAGES, 'setting a reserve');
    const exposure = this.exposureOf(claim, number);
    const value = Number(amount);
    const paid = this.paidOn(claim, exposure);
    const pending = this.pendingOn(claim, exposure);
    if (!Number.isFinite(value) || value < 0) throw new AppError(422, 'The reserve must be a number, zero or more');
    if (value < round2(paid + pending)) throw new AppError(422, `The reserve cannot be below the ${round2(paid + pending)} already paid or waiting for approval`);
    const limit = limitOf(RESERVE_LIMITS, user);
    if (value > limit) throw new AppError(403, `A reserve of ${value} is above your authority (${limit}); ask a UW manager`);
    claim.reserveChanges.push({ at: this.pc.now(), by: user.id, exposure: exposure.number, from: exposure.reserve, to: round2(value) });
    exposure.reserve = round2(value);
    claim.reserve = round2(claim.exposures.reduce((s, e) => s + e.reserve, 0));
    return exposure;
  }

  payExposure(user, claimId, number, input) {
    const claim = this.load(user, claimId);
    this.pc.assertClaimAt(claim, ['Approved'], 'a payment');
    const exposure = this.exposureOf(claim, number);
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new AppError(422, 'Payment must be more than zero');
    if (!COST_TYPES.includes(input.costType)) throw new AppError(422, `The cost type must be ${COST_TYPES.join(' or ')}`);
    const value = round2(amount);
    if (round2(this.paidOn(claim, exposure) + this.pendingOn(claim, exposure) + value) > exposure.reserve) {
      throw new AppError(422, 'The payment would take the exposure past its reserve (counting payments waiting for approval); raise the reserve first');
    }
    if (value > highest(PAYMENT_LIMITS)) throw new AppError(422, `A payment of ${value} is above every limit (${highest(PAYMENT_LIMITS)}); no one may make it`);
    const entry = { amount: value, costType: input.costType, note: text(input.note), exposureNumber: exposure.number };
    if (value <= limitOf(PAYMENT_LIMITS, user)) {
      this.issue(claim, { ...entry, by: user.id });
      return { status: 'issued', amount: value };
    }
    const pending = { id: this.pc.store.id('cpp'), ...entry, requestedBy: user.id, requestedAt: this.pc.now() };
    claim.pendingPayments.push(pending);
    this.pc.publish('ClaimPaymentPending', { claimNumber: claim.claimNumber, exposure: exposure.number, amount: value });
    return { status: 'pending_approval', id: pending.id, amount: value };
  }

  issue(claim, entry) {
    claim.payments.push({ date: this.pc.today(), ...entry });
    this.pc.publish('ClaimPaid', { claimNumber: claim.claimNumber, amount: entry.amount, exposure: entry.exposureNumber });
  }

  approvePayment(user, claimId, paymentId) {
    const claim = this.load(user, claimId);
    const pending = claim.pendingPayments.find((p) => p.id === paymentId);
    if (!pending) throw new AppError(404, 'That payment is not waiting for approval');
    if (pending.requestedBy === user.id) throw new AppError(409, 'A different person must approve this payment');
    const limit = limitOf(PAYMENT_LIMITS, user);
    if (pending.amount > limit) throw new AppError(403, `A payment of ${pending.amount} is above your authority (${limit})`);
    claim.pendingPayments = claim.pendingPayments.filter((p) => p.id !== paymentId);
    const { id, requestedAt, ...entry } = pending;
    this.issue(claim, { ...entry, by: pending.requestedBy, approvedBy: user.id });
    return { status: 'issued', amount: pending.amount };
  }
}

module.exports = { ClaimMoney, RESERVE_LIMITS, PAYMENT_LIMITS, COST_TYPES, CLAIMANT_KINDS };
