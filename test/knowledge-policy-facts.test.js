'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { policyFacts } = require('../src/knowledge/policy-facts');

// The one place a customer's own data may be returned. Access is the application's rule, and a stranger must learn
// nothing - not even whether the policy exists.

function book() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  return { ...env, policyNumber: pc.policy(job.policyId).policyNumber, job };
}

test('the owner gets the facts of their own policy, as of a date', () => {
  const { pc, users, policyNumber } = book();
  const facts = policyFacts({ pc, user: users.agent, policyNumber, asOf: '2026-06-01' });
  assert.equal(facts.found, true);
  assert.equal(facts.policyNumber, policyNumber);
  assert.equal(facts.status, 'in_force');
  assert.equal(facts.asOf, '2026-06-01');
  assert.ok(facts.termNumber >= 1);
  assert.ok(facts.product, 'the product is returned');
});

test('another agent learns nothing, not even that the policy exists', () => {
  const { pc, users, policyNumber } = book();
  const other = users.agent2 || { ...users.agent, id: 'someone-else', producerCode: 'PC-999' };
  const facts = policyFacts({ pc, user: other, policyNumber, asOf: '2026-06-01' });
  assert.equal(facts.found, false);
  assert.equal(facts.reason, 'not available to this user');
  assert.equal(facts.insuredName, undefined, 'no field of the policy leaks');
});

test('an underwriter reads the policy, because the application allows it', () => {
  const { pc, users, policyNumber } = book();
  const facts = policyFacts({ pc, user: users.uw, policyNumber, asOf: '2026-03-15' });
  assert.equal(facts.found, true);
  assert.equal(facts.status, 'in_force');
});

test('a date outside every term is reported, not guessed', () => {
  const { pc, users, policyNumber } = book();
  assert.throws(
    () => policyFacts({ pc, user: users.agent, policyNumber, asOf: '2031-01-01' }),
    /No term of/,
  );
});

test('a policy number is required', () => {
  const { pc, users } = book();
  assert.throws(() => policyFacts({ pc, user: users.agent, policyNumber: '' }), /policy number is required/);
});
