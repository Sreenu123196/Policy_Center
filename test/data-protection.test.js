'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission, homeSubmission } = require('./helpers');
const { DataProtection } = require('../src/dataProtection');

// Personal data (DPDP-style): a person can be given a copy of what is held about them, and when the law allows it their
// identity is removed while the policy, claim and money records that must be kept stay.

function book({ cancel = false } = {}) {
  const env = setup('2026-01-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent, { firstName: 'Priya', lastName: 'Nair', email: 'priya.nair@example.com', phone: '9876543210', dob: '1985-03-04' }));
  const sub = run(() => autoSubmission(pc, users.agent, acct, '2026-01-01', {}));
  run(() => pc.updateDraft(sub.id, { line: { ...sub.period.line, drivers: [{ ...sub.period.line.drivers[0], firstName: 'Priya', lastName: 'Nair', licenseNumber: 'KA0120230001234' }] } }, users.agent));
  run(() => pc.quote(sub.id, users.agent));
  run(() => pc.bind(sub.id, users.agent));
  env.setToday('2026-01-15');
  const claim = run(() => pc.openClaim(sub.policyId, { lossDate: '2026-01-10', lossType: 'Collision', description: 'Priya Nair was hit at the Silk Board junction' }, users.agent));
  run(() => pc.createTicket({ accountId: acct.id, category: 'Other', priority: 'Low', subject: 'Call Priya Nair on 9876543210', description: 'Priya Nair asked for a call back' }, users.agent));
  if (cancel) {
    run(() => pc.moveClaim(claim.id, { to: 'Rejected', reason: 'Priya Nair - not covered' }, users.uwm));
    env.setToday('2026-02-01');
    const c = run(() => pc.startCancellation(sub.policyId, { effectiveDate: '2026-02-01', reason: 'InsuredRequest' }, users.agent));
    run(() => pc.bind(c.id, users.agent));
    for (const t of pc.db.tickets) t.status = 'Closed';
  }
  return { ...env, acct, sub, claim, dp: new DataProtection(pc) };
}

test('a copy of the personal data lists everything held about the person, and is itself recorded', () => {
  const { dp, acct, users, pc } = book();
  const copy = dp.export(acct.id, users.uwm);
  assert.equal(copy.account.email, 'priya.nair@example.com');
  assert.equal(copy.policies.length, 1);
  assert.equal(copy.claims.length, 1);
  assert.equal(copy.tickets.length, 1);
  assert.ok(copy.jobs.length >= 1);
  assert.ok(copy.invoices.length >= 1);
  assert.equal(copy.policies[0].versions[0].period.line.drivers[0].licenseNumber, 'KA0120230001234');
  const log = pc.db.dataRequests;
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].type, log[0].accountNumber, log[0].by], ['export', acct.accountNumber, 'uwm']);
  assert.ok(!JSON.stringify(log).includes('Priya'), 'the record of the request holds no personal data');
});

test('only a UW manager can export or erase', () => {
  const { dp, acct, users } = book({ cancel: true });
  for (const who of [users.agent, users.uw]) {
    assert.throws(() => dp.export(acct.id, who), (e) => e.status === 403);
    assert.throws(() => dp.erase(acct.id, { confirm: true, reason: 'Request' }, who), (e) => e.status === 403);
  }
});

test('erasing is refused while the person still has cover, an open claim, an open quote or an open ticket, and needs a clear yes', () => {
  const { dp, acct, users, pc, run, claim, sub } = book();
  assert.throws(() => run(() => dp.erase(acct.id, { reason: 'Request' }, users.uwm)), /confirm/i);
  assert.throws(() => run(() => dp.erase(acct.id, { confirm: true }, users.uwm)), /reason/i);
  assert.throws(() => run(() => dp.erase(acct.id, { confirm: true, reason: 'Request' }, users.uwm)), /in force|cover/i);
  assert.equal(pc.account(acct.id).firstName, 'Priya', 'nothing was changed');
  assert.ok(claim && sub);
});

test('erasing removes the identity everywhere but keeps the policy, claim and money records', () => {
  const { dp, acct, users, pc, run, store, sub, claim } = book({ cancel: true });
  const premiumBefore = pc.policyDetail(sub.policyId, users.uwm).versions[0].quote.premium;
  const ledgerBefore = JSON.stringify(store.data.ledger);
  const policyNumber = pc.policyDetail(sub.policyId, users.uwm).policyNumber;

  const result = run(() => dp.erase(acct.id, { confirm: true, reason: 'Request from the customer, 3 Feb' }, users.uwm));
  assert.equal(result.erased, true);

  const all = JSON.stringify(store.data);
  for (const personal of ['Priya', 'Nair', 'priya.nair@example.com', '9876543210', '1985-03-04', 'KA0120230001234', 'Silk Board', '1 Main St']) {
    assert.ok(!all.includes(personal), `${personal} is gone`);
  }
  // What the law makes us keep stays.
  const acctNow = pc.account(acct.id);
  assert.equal(acctNow.accountNumber, acct.accountNumber);
  assert.equal(acctNow.erasedAt !== undefined, true);
  assert.equal(pc.policyDetail(sub.policyId, users.uwm).policyNumber, policyNumber);
  assert.equal(pc.policyDetail(sub.policyId, users.uwm).versions[0].quote.premium, premiumBefore);
  assert.equal(JSON.stringify(store.data.ledger), ledgerBefore, 'the money records are untouched');
  assert.equal(pc.db.claims.find((c) => c.id === claim.id).claimNumber, claim.claimNumber);
  assert.equal(pc.db.claims.find((c) => c.id === claim.id).status, 'Rejected');
  // The person can no longer be found by name, and the request is recorded without personal data.
  assert.equal(pc.listAccounts(users.uwm, { q: 'priya' }).length, 0);
  const log = pc.db.dataRequests.find((r) => r.type === 'erase');
  assert.deepEqual([log.accountNumber, log.by, log.reason], [acct.accountNumber, 'uwm', 'Request from the customer, 3 Feb']);
  // A second time there is nothing left to erase.
  assert.throws(() => run(() => dp.erase(acct.id, { confirm: true, reason: 'again' }, users.uwm)), /already/i);
});

test('an erase that fails part way changes nothing (it runs as one unit of work)', () => {
  const { dp, acct, users, pc, run } = book({ cancel: true });
  const real = pc.db.claims;
  Object.defineProperty(real[0], 'description', { configurable: true, get() { return 'x'; }, set() { throw new Error('disk trouble'); } });
  assert.throws(() => run(() => dp.erase(acct.id, { confirm: true, reason: 'Request' }, users.uwm)), /disk trouble/);
  assert.equal(pc.account(acct.id).firstName, 'Priya');
  assert.equal(pc.account(acct.id).email, 'priya.nair@example.com');
  assert.equal(pc.db.dataRequests.filter((r) => r.type === 'erase').length, 0, 'no record of an erase that did not happen');
});

test('a home policy (a different product) is also cleaned', () => {
  const env = setup('2026-01-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent, { firstName: 'Meera', lastName: 'Iyer', email: 'meera@example.com' }));
  const sub = run(() => homeSubmission(pc, users.agent, acct, '2026-01-01', { dwelling: { line1: '77 Lake View Road' } }));
  run(() => pc.quote(sub.id, users.agent));
  run(() => pc.bind(sub.id, users.agent));
  env.setToday('2026-02-01');
  const c = run(() => pc.startCancellation(sub.policyId, { effectiveDate: '2026-02-01', reason: 'InsuredRequest' }, users.agent));
  run(() => pc.bind(c.id, users.agent));
  run(() => new DataProtection(pc).erase(acct.id, { confirm: true, reason: 'Request' }, users.uwm));
  const all = JSON.stringify(env.store.data);
  for (const personal of ['Meera', 'Iyer', 'meera@example.com', '77 Lake View Road']) assert.ok(!all.includes(personal), personal);
});
