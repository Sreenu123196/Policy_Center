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

module.exports = { collectionsConsumer };
