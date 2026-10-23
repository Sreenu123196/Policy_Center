'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPremiumPosting } = require('../src/premiumPosting');

// A posting plan must balance before it is written. These tests are the last cheap place to catch a ledger error.

test('a premium with commission balances to zero', () => {
  const plan = buildPremiumPosting({ grossPremium: 11800, commission: 1500 });
  assert.equal(plan.balanced, true);
  assert.equal(plan.debits, plan.credits);
  const byAccount = Object.fromEntries(plan.entries.map((e) => [e.account, e]));
  assert.equal(byAccount.premium_receivable.debit, 11800);
  assert.equal(byAccount.commission_expense.debit, 1500);
  assert.equal(byAccount.written_premium.credit, 11800, 'written premium is the gross, not the net');
  assert.equal(byAccount.commission_payable.credit, 1500);
});

test('commission is an expense, debited - not a credit', () => {
  const plan = buildPremiumPosting({ grossPremium: 1000, commission: 100 });
  const commission = plan.entries.find((e) => e.account === 'commission_expense');
  assert.equal(commission.debit, 100);
  assert.equal(commission.credit, 0);
});

test('a premium without commission still balances', () => {
  const plan = buildPremiumPosting({ grossPremium: 500 });
  assert.equal(plan.balanced, true);
  assert.deepEqual(plan.entries.map((e) => e.account), ['premium_receivable', 'written_premium']);
});

test('an odd amount balances to the paise', () => {
  const plan = buildPremiumPosting({ grossPremium: 1000.01, commission: 125.005 });
  assert.equal(plan.balanced, true);
});

test('commission above the premium and negative inputs are refused', () => {
  assert.throws(() => buildPremiumPosting({ grossPremium: 100, commission: 200 }), /cannot exceed/);
  assert.throws(() => buildPremiumPosting({ grossPremium: -1 }), /non-negative/);
  assert.throws(() => buildPremiumPosting({ grossPremium: 100, commission: -5 }), /non-negative/);
});
