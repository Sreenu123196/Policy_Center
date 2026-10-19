'use strict';
// Management reports for the billing, refund and claim-approval features. Read only: they change nothing.
//   collections      policies with overdue invoices: how late, how much, and which missed-payment step was taken (UW managers)
//   refunds          refunds by status, and cancelled customers who still owe money (UW managers)
//   claimApprovals   claim payments waiting for a second person, and the ones already approved (underwriters and managers)

const D = require('./dates');
const { AppError } = require('./policyCenter');
const { canSeeBillingReport, canSeeClaimsReport } = require('./permissions');
const { balanceOf } = require('./invoiceView');
const { round2 } = require('./rating');

const BUCKETS = [['1-30', 1, 30], ['31-60', 31, 60], ['61+', 61, Infinity]];

class Reports {
  constructor(pc, billing) {
    this.pc = pc;
    this.billing = billing;
  }

  insuredOf(policy) {
    return this.pc.accountName(this.pc.db.accounts.find((a) => a.id === policy.accountId));
  }

  collections(user, { asOf } = {}) {
    if (!canSeeBillingReport(user)) throw new AppError(403, 'The collections report is for UW managers');
    const date = asOf || this.pc.today();
    if (!D.isDate(date)) throw new AppError(422, 'The date must be yyyy-mm-dd');
    const buckets = Object.fromEntries(BUCKETS.map(([name]) => [name, { policies: 0, balance: 0 }]));
    const policies = [];
    for (const policy of this.pc.db.policies) {
      if (policy.cancellation) continue;
      const overdue = this.pc.db.invoices
        .filter((i) => i.policyId === policy.id && i.amount >= 0 && balanceOf(i) > 0 && i.dueDate < date)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      if (overdue.length === 0) continue;
      const oldest = overdue[0];
      const daysOverdue = D.daysBetween(oldest.dueDate, date);
      const balance = round2(overdue.reduce((sum, i) => sum + balanceOf(i), 0));
      const taken = oldest.stepsTaken || [];
      policies.push({
        policyNumber: policy.policyNumber,
        policyId: policy.id,
        insured: this.insuredOf(policy),
        product: policy.product,
        overdueInvoices: overdue.length,
        oldestDueDate: oldest.dueDate,
        daysOverdue,
        balance,
        stage: taken.includes('cancellation_request') ? 'cancellation_request' : taken.includes('notice') ? 'notice' : 'none',
      });
      const [name] = BUCKETS.find(([, from, to]) => daysOverdue >= from && daysOverdue <= to);
      buckets[name].policies++;
      buckets[name].balance = round2(buckets[name].balance + balance);
    }
    policies.sort((a, b) => b.daysOverdue - a.daysOverdue || a.policyNumber.localeCompare(b.policyNumber));
    return { asOf: date, policies, buckets, total: round2(policies.reduce((sum, p) => sum + p.balance, 0)) };
  }

  refunds(user) {
    if (!canSeeBillingReport(user)) throw new AppError(403, 'The refund report is for UW managers');
    const policyOf = (id) => this.pc.db.policies.find((p) => p.id === id);
    const refunds = this.pc.db.refunds.map((r) => {
      const policy = policyOf(r.policyId);
      return { refundNumber: r.refundNumber, policyNumber: policy.policyNumber, insured: this.insuredOf(policy), amount: r.amount, status: r.status, createdAt: r.createdAt, paidOn: r.paidOn || null };
    });
    const byStatus = { Due: { count: 0, amount: 0 }, Issued: { count: 0, amount: 0 }, Withdrawn: { count: 0, amount: 0 } };
    for (const r of refunds) {
      byStatus[r.status].count++;
      byStatus[r.status].amount = round2(byStatus[r.status].amount + r.amount);
    }
    // A cancelled customer still owes money when their ledger balance is positive.
    const arrears = [];
    for (const policy of this.pc.db.policies.filter((p) => p.cancellation)) {
      const { balance } = this.billing.ledgerFor(policy.id, user);
      if (balance > 0) arrears.push({ policyNumber: policy.policyNumber, insured: this.insuredOf(policy), cancelledOn: policy.cancellation.effectiveDate, owed: balance });
    }
    arrears.sort((a, b) => b.owed - a.owed);
    return { refunds, byStatus, arrears, totalArrears: round2(arrears.reduce((sum, a) => sum + a.owed, 0)) };
  }

  claimApprovals(user) {
    if (!canSeeClaimsReport(user)) throw new AppError(403, 'The claim approvals report is for underwriters and UW managers');
    const today = this.pc.today();
    const pending = [];
    const approved = { count: 0, amount: 0 };
    for (const claim of this.pc.db.claims) {
      const policy = this.pc.db.policies.find((p) => p.id === claim.policyId);
      for (const p of claim.pendingPayments || []) {
        pending.push({
          claimNumber: claim.claimNumber, claimId: claim.id, policyNumber: policy.policyNumber, insured: this.insuredOf(policy), exposure: p.exposureNumber, amount: p.amount, costType: p.costType,
          requestedBy: p.requestedBy, requestedAt: p.requestedAt, ageDays: Math.max(0, D.daysBetween(p.requestedOn || p.requestedAt.slice(0, 10), today)), paymentId: p.id,
        });
      }
      for (const p of claim.payments.filter((x) => x.approvedBy)) {
        approved.count++;
        approved.amount = round2(approved.amount + p.amount);
      }
    }
    pending.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    return { pending, pendingTotal: round2(pending.reduce((sum, p) => sum + p.amount, 0)), approved };
  }
}

module.exports = { Reports };
