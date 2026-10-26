'use strict';
// B30: the plan a person can read before anything happens.
//
// The verifier already answers "may this run?". This makes that answer legible as a plan: each step, whether it is permitted, why, and
// the fact that nothing has been executed yet. A plan that was refused cannot be executed later by marking it done - execution asks the
// plan again rather than trusting a flag.

const { AppError } = require('./appError');

function createPlans({ store, sentinel }) {
  const plans = () => {
    store.data.plans = store.data.plans || [];
    return store.data.plans;
  };

  function find(id) {
    const plan = plans().find((p) => p.id === id);
    if (!plan) throw new AppError(404, 'Plan not found');
    return plan;
  }

  /** Build a plan from a proposal: the checks become its steps, and the verdict is theirs. */
  function plan(user, input = {}) {
    if (!input.action) throw new AppError(422, 'action is required');
    const verification = sentinel.verify(input);
    const record = {
      id: 'PL-' + String(store.next('plan')).padStart(6, '0'),
      action: input.action,
      amount: input.amount !== undefined ? Number(input.amount) : null,
      agentId: input.agentId || null,
      proposal: input.proposal || null,
      steps: verification.checks.map((check) => ({ name: check.name, allowed: check.allowed, reason: check.reason })),
      verdict: verification.allowed ? 'permitted' : 'refused',
      blockedBy: verification.blockedBy || null,
      summary: verification.allowed
        ? 'Every check agrees. Nothing has been executed; this is the plan.'
        : 'Refused by the ' + verification.blockedBy + ' check. Nothing has been executed and nothing may be.',
      preparedBy: user && user.id,
      preparedAt: new Date().toISOString(),
      executed: false,
      executedBy: null,
      executedAt: null,
    };
    plans().push(record);
    return record;
  }

  /** Execution re-derives permission from the stored plan; it does not trust a caller saying "go ahead". */
  function markExecuted(user, id) {
    const record = find(id);
    if (record.executed) throw new AppError(409, 'This plan has already been executed');
    if (record.verdict !== 'permitted') throw new AppError(403, 'This plan was refused and cannot be executed');
    record.executed = true;
    record.executedBy = user && user.id;
    record.executedAt = new Date().toISOString();
    return record;
  }

  return { plan, find, list: () => plans(), markExecuted };
}

module.exports = { createPlans };
