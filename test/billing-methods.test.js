'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Billing, PAYMENT_METHODS } = require('../src/billing');

// The mandate debit path ends in billing.receivePayment, so the method it passes has to be one billing accepts. It was not,
// and every mandate debit would have failed after the rules allowed it - caught by checking instead of assuming.

function boundPolicy(env) {
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  return pc.policy(job.policyId, users.agent);
}

test('eNACH and UPI are accepted payment methods', () => {
  assert.ok(PAYMENT_METHODS.includes('eNACH'), 'eNACH: ' + PAYMENT_METHODS.join(', '));
  assert.ok(PAYMENT_METHODS.includes('UPI'));
});

test('a payment can be recorded with method eNACH, which is what a mandate debit passes', () => {
  const env = setup('2026-03-01');
  const policy = boundPolicy(env);
  const billing = new Billing(env.pc);
  const payment = env.run(() => billing.receivePayment(env.users.uwm, {
    policyId: policy.id, amount: 100, method: 'eNACH', reference: 'MND-1/2026-11', receivedOn: '2026-03-02',
  }));
  assert.ok(payment.paymentNumber, 'a payment number was issued');
  assert.equal(payment.method, 'eNACH');
});

test('an unknown method is still refused', () => {
  const env = setup('2026-03-01');
  const policy = boundPolicy(env);
  const billing = new Billing(env.pc);
  assert.throws(() => env.run(() => billing.receivePayment(env.users.uwm, {
    policyId: policy.id, amount: 100, method: 'Barter', receivedOn: '2026-03-02',
  })), /method/i);
});
