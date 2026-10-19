'use strict';
// The consumers the app registers on the event bus (src/eventBus.js). Each is a function that gets one event and must
// cope with seeing it twice.

const D = require('./dates');

// Collections: a missed payment, and a request to cancel for non-payment, become work for the UW manager, so nobody
// has to watch the event list. One activity per event, however often the event is delivered.
function collectionsConsumer(pc) {
  const WORK = {
    PaymentMissed: (p) => ({ subject: `Missed payment on ${p.policyNumber}`, description: `Invoice ${p.invoiceNumber} (due ${p.dueDate}) is unpaid, balance ${p.balance}. Contact the insured.`, priority: 'Normal' }),
    CancellationRequested: (p) => ({ subject: `Cancellation for non-payment on ${p.policyNumber}`, description: `Invoice ${p.invoiceNumber} is still unpaid after the notice period. A cancellation job was started or is waiting for review.`, priority: 'High' }),
  };
  return (event) => {
    const make = WORK[event.type];
    if (!make) return;
    if (pc.db.activities.some((a) => a.eventId === event.eventId)) return; // seen before
    const policy = pc.db.policies.find((p) => p.policyNumber === event.payload.policyNumber);
    if (!policy) throw new Error(`Policy ${event.payload.policyNumber} does not exist`);
    pc.db.activities.push({
      id: pc.store.id('act'),
      activityNumber: pc.store.number('ACT-', 6),
      type: 'Collections',
      ...make(event.payload),
      eventId: event.eventId,
      accountId: policy.accountId,
      policyId: policy.id,
      policyNumber: policy.policyNumber,
      assignedTo: 'uwm',
      status: 'Open',
      dueDate: D.addDays(pc.today(), 2),
      createdAt: pc.now(),
      createdBy: 'system',
    });
  };
}

// Claims queues: a new claim becomes an activity for the underwriters (High if it was reported late or could not be verified),
// and a claim payment waiting for approval becomes an activity for the UW manager. They close by themselves: the review when
// the claim leaves Submitted, the approval when the payment is issued. One activity per event, however often it is delivered.
function claimsQueueConsumer(pc) {
  const claimOf = (number) => pc.db.claims.find((c) => c.claimNumber === number);
  const add = (event, claim, fields) => {
    if (pc.db.activities.some((a) => a.eventId === event.eventId)) return; // seen before
    pc.db.activities.push({
      id: pc.store.id('act'),
      activityNumber: pc.store.number('ACT-', 6),
      type: 'Claims',
      eventId: event.eventId,
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      accountId: claim.accountId,
      policyId: claim.policyId,
      policyNumber: (pc.db.policies.find((p) => p.id === claim.policyId) || {}).policyNumber,
      status: 'Open',
      createdAt: pc.now(),
      createdBy: 'system',
      ...fields,
    });
  };
  const close = (match) => {
    for (const a of pc.db.activities) if (a.type === 'Claims' && a.status === 'Open' && match(a)) Object.assign(a, { status: 'Completed', completedAt: pc.now(), completedBy: 'system' });
  };
  return (event) => {
    const p = event.payload;
    const claim = claimOf(p.claimNumber);
    if (!claim) return;
    if (event.type === 'ClaimOpened') {
      const flags = [p.lateReport ? 'It was reported late.' : '', p.verification !== 'verified' ? 'The policy could not be verified for the loss date.' : ''].filter(Boolean);
      add(event, claim, {
        subject: `Review new claim ${claim.claimNumber}`,
        description: `${p.lossType} on ${p.lossDate}, policy ${p.policyNumber}. ${flags.join(' ')}`.trim(),
        assignedTo: 'uw', priority: flags.length ? 'High' : 'Normal', dueDate: D.addDays(pc.today(), 2), review: true,
      });
    } else if (event.type === 'ClaimStageChanged' && p.stage !== 'Submitted') {
      close((a) => a.claimId === claim.id && a.review);
    } else if (event.type === 'ClaimPaymentPending') {
      add(event, claim, {
        subject: `Approve claim payment of ${p.amount} on ${claim.claimNumber}`,
        description: `A payment on exposure ${p.exposure} is above the requester's limit and needs a different person to approve it.`,
        assignedTo: 'uwm', priority: 'High', dueDate: D.addDays(pc.today(), 1), paymentId: p.paymentId,
      });
    } else if (event.type === 'ClaimPaid' && p.paymentId) {
      close((a) => a.paymentId === p.paymentId);
    }
  };
}

// Accounting: every business event that moves money becomes a balanced journal entry, once (src/accounting.js).
function accountingConsumer(accounting) {
  return (event) => void accounting.postFromEvent(event);
}

module.exports = { collectionsConsumer, claimsQueueConsumer, accountingConsumer };
