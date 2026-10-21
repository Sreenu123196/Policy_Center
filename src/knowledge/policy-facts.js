'use strict';
// "My policy" questions are answered from the system of record, not from the wording.
//
// Nothing about a customer's own policy may come out of the retrieval index: the index holds documents, and a passage
// is not evidence of what a person bought. This module asks the application (pc.policy, which enforces access, then
// pc.policyAsOf for the snapshot on a date) and returns exactly what it says.
//
// The access rule is the application's, not ours: pc.policy throws for a policy the signed-in user may not see, which
// is what stops one customer asking about another's cover.

function policyFacts({ pc, user, policyNumber, asOf }) {
  if (!policyNumber) throw new Error('a policy number is required');
  const date = asOf || (typeof pc.today === 'function' ? pc.today() : new Date().toISOString().slice(0, 10));

  let policy;
  try {
    policy = pc.policy(policyNumber, user);
  } catch (err) {
    // Not found and not allowed look the same to the caller on purpose: a different message would confirm that the
    // policy exists, which is exactly what a stranger is trying to learn.
    return { found: false, policyNumber, asOf: date, reason: 'not available to this user' };
  }

  const snapshot = pc.policyAsOf(policy, date);
  return {
    found: true,
    policyNumber: policy.policyNumber,
    asOf: date,
    status: snapshot.status,
    termNumber: snapshot.termNumber,
    effectiveDate: snapshot.effectiveDate,
    expirationDate: snapshot.expirationDate,
    product: policy.product,
    form: policy.form,
    insuredName: policy.insuredName ?? null, // derived elsewhere in the app; null is honest, a guess is not
  };
}

module.exports = { policyFacts };
