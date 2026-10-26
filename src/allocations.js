'use strict';
// Persisting an allocation.
//
// `allocatePayment` answers where the money would go; this records the decision, so a receipt's fate is an auditable row
// rather than something recomputed on the next screen. It deliberately does not touch the invoices: settling them is the
// payment path's job, and doing it here would be a second, silent way to change a balance.

const { AppError } = require('./appError');

function createAllocations(store) {
  const list = () => {
    store.data.allocations = store.data.allocations || [];
    return store.data.allocations;
  };

  function record(user, plan, input = {}) {
    if (!plan || !Array.isArray(plan.allocations)) throw new AppError(422, 'an allocation plan is required');
    const record = {
      id: 'AL-' + String(store.next('allocation')).padStart(7, '0'),
      amount: plan.amount !== undefined ? plan.amount : (input.amount !== undefined ? input.amount : null),
      reference: input.reference || null,
      allocations: plan.allocations,
      suspense: plan.suspense,
      reason: plan.reason,
      allocatedBy: user && user.id,
      allocatedAt: new Date().toISOString(),
    };
    list().push(record);
    return record;
  }

  function get(id) {
    const record = list().find((a) => a.id === id);
    if (!record) throw new AppError(404, 'Allocation not found');
    return record;
  }

  /** What is still sitting in suspense across every recorded allocation. */
  function suspenseTotal() {
    return list().reduce((sum, a) => sum + (Number(a.suspense) || 0), 0);
  }

  return { record, get, list, suspenseTotal };
}

module.exports = { createAllocations };
