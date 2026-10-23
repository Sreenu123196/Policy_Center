'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMandates, FREQUENCIES, NOTICE_HOURS } = require('../src/mandates');

// The refusals are the product: a mandate exists to prevent an unauthorised debit, not to make debits convenient.

const mandates = createMandates();
const fresh = () => {
  const m = mandates.create({ reference: 'MND-1', cap: 5000, frequency: 'monthly', startsOn: '2026-11-01', bankAccountMasked: '[ACCOUNT]' });
  return mandates.authorise(m, { authorisedOn: '2026-10-25' });
};

test('a mandate carries a cap, a frequency and a start date, and starts unauthorised', () => {
  const m = mandates.create({ reference: 'MND-0', cap: 3000, frequency: 'quarterly', startsOn: '2026-12-01' });
  assert.equal(m.status, 'created');
  assert.equal(m.cap, 3000);
  assert.deepEqual(FREQUENCIES, ['monthly', 'quarterly', 'yearly']);
  assert.equal(NOTICE_HOURS, 24);
});

test('a debit within the cap, noticed and in a new period, is taken', () => {
  const m = fresh();
  mandates.notice(m, { debitOn: '2026-11-01', amount: 2500 });
  mandates.debit(m, { on: '2026-11-01', amount: 2500, period: '2026-11' });
  assert.equal(m.debits.length, 1);
  assert.equal(m.debits[0].amount, 2500);
});

test('a debit above the cap is refused even with a notice', () => {
  const m = fresh();
  assert.throws(() => mandates.notice(m, { debitOn: '2026-11-01', amount: 6000 }), /exceeds the mandate cap/);
});

test('a debit without the pre-debit notice is refused', () => {
  const m = fresh();
  assert.throws(() => mandates.debit(m, { on: '2026-11-01', amount: 1000, period: '2026-11' }), /pre-debit notice/);
});

test('the same period cannot be debited twice', () => {
  const m = fresh();
  mandates.notice(m, { debitOn: '2026-11-01', amount: 1000 });
  mandates.debit(m, { on: '2026-11-01', amount: 1000, period: '2026-11' });
  assert.throws(() => mandates.debit(m, { on: '2026-12-01', amount: 1000, period: '2026-11' }), /already been debited/);
});

test('a cancelled mandate takes no notice and no debit', () => {
  const m = fresh();
  mandates.cancel(m, { reason: 'customer request' });
  assert.throws(() => mandates.notice(m, { debitOn: '2026-11-01', amount: 100 }), /not active/);
  assert.throws(() => mandates.debit(m, { on: '2026-11-01', amount: 100, period: '2026-11' }), /not active/);
});

test('a bad frequency, cap or start date is refused at creation', () => {
  assert.throws(() => mandates.create({ reference: 'X', cap: 100, frequency: 'weekly', startsOn: '2026-11-01' }), /frequency must be one of/);
  assert.throws(() => mandates.create({ reference: 'X', cap: 0, startsOn: '2026-11-01' }), /cap must be a positive/);
  assert.throws(() => mandates.create({ reference: 'X', cap: 100, startsOn: '01/11/2026' }), /startsOn must be a date/);
});
