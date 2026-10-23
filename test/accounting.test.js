'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Accounting, ACCOUNTS, DEFAULT_PRODUCER_COMMISSION } = require('../src/accounting');
const { gstOnPremium } = require('../src/billingRules');
const { accountingConsumer } = require('../src/consumers');
const { EventBus } = require('../src/eventBus');
const { Billing } = require('../src/billing');
const { ClaimMoney } = require('../src/claimMoney');

// Accounting sub-ledger (Tier 3, item 9). Business events (a policy issued, a payment, a refund, a claim paid) become balanced
// journal entries, once each. The books balance, the receivable agrees with the customers' ledgers, a closed month is locked,
// and producers get commission statements. Amounts are in dollars like the rest of the app.

function world() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const bus = new EventBus(pc);
  const accounting = new Accounting(pc);
  bus.register('accounting', accountingConsumer(accounting));
  const billing = new Billing(pc);
  const post = () => bus.run({ now: new Date('2026-03-01T10:00:00Z') });
  const newPolicy = (plan = 'Monthly') => {
    const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
    run(() => pc.updateDraft(job.id, { paymentPlan: plan }, users.agent));
    run(() => pc.quote(job.id, users.agent));
    run(() => pc.bind(job.id, users.agent));
    return { job, policy: pc.policy(job.policyId) };
  };
  return { ...env, acct, bus, accounting, billing, post, newPolicy, money: new ClaimMoney(pc) };
}

const sum = (entries, account, side) => Math.round(entries.flatMap((e) => e.lines).filter((l) => l.account === account).reduce((s, l) => s + (l[side] || 0), 0) * 100) / 100;
const r2 = (n) => Math.round(n * 100) / 100;

test('issuing a policy posts the premium to the receivable and the written premium, plus the instalment fees', () => {
  const env = world();
  const { pc, users, accounting, post, newPolicy } = env;
  const { policy } = newPolicy();
  post();
  const entries = accounting.journal(users.uwm);
  const total = pc.policy(policy.id).transactions[0].amount;
  const fees = r2(pc.db.invoices.filter((i) => i.policyId === policy.id).reduce((s, i) => s + i.fee, 0));
  assert.ok(fees > 0, 'the monthly plan has fees');
  assert.equal(sum(entries, ACCOUNTS.receivable.code, 'debit'), r2(total + fees));
  const split = gstOnPremium({ amount: total });
  assert.equal(split.net + split.gst, r2(total), 'net and GST add back to the gross premium');
  assert.equal(sum(entries, ACCOUNTS.writtenPremium.code, 'credit'), split.net, 'written premium is the net of GST');
  assert.equal(sum(entries, ACCOUNTS.gstPayable.code, 'credit'), split.gst, 'GST is its own liability');
  assert.equal(sum(entries, ACCOUNTS.feeIncome.code, 'credit'), fees);
  assert.ok(entries.every((e) => r2(e.lines.reduce((s, l) => s + (l.debit || 0), 0)) === r2(e.lines.reduce((s, l) => s + (l.credit || 0), 0))), 'every entry balances');
  assert.equal(accounting.trialBalance(users.uwm).balanced, true);
});

test('commission accrues for the producer at their rate, and the rate used is kept on the entry', () => {
  const env = world();
  const { pc, users, accounting, post, newPolicy, run } = env;
  const { policy } = newPolicy();
  post();
  const total = pc.policy(policy.id).transactions[0].amount;
  const accrual = accounting.journal(users.uwm).flatMap((e) => e.lines.map((l) => ({ ...l, entry: e }))).find((l) => l.account === ACCOUNTS.commissionExpense.code);
  assert.equal(accrual.debit, r2(gstOnPremium({ amount: total }).net * DEFAULT_PRODUCER_COMMISSION), 'commission is earned on the net premium');
  assert.deepEqual([accrual.entry.producerCode, accrual.entry.commissionRate], ['PC-100', DEFAULT_PRODUCER_COMMISSION]);

  // A new rate applies to new business; the entries already posted keep the rate they were posted with.
  run(() => accounting.setProducerRate(users.uwm, 'PC-100', 15));
  env.setToday('2026-03-02');
  newPolicy();
  post();
  const rates = accounting.journal(users.uwm).filter((e) => e.commissionRate !== undefined).map((e) => e.commissionRate);
  assert.deepEqual(rates, [DEFAULT_PRODUCER_COMMISSION, 0.15]);
});

test('payments, refunds and claim payments post cash movements', () => {
  const env = world();
  const { pc, users, accounting, post, newPolicy, billing, run, money } = env;
  const { policy } = newPolicy();
  post();
  run(() => billing.receivePayment(users.uwm, { policyId: policy.id, amount: 500, method: 'Cheque', reference: 'C1', receivedOn: '2026-03-01' }));
  env.setToday('2026-03-15');
  const claim = run(() => pc.openClaim(policy.id, { lossDate: '2026-03-10', lossType: 'Collision' }, users.agent));
  run(() => pc.moveClaim(claim.id, { to: 'Under Review' }, users.uw));
  run(() => money.addExposure(users.uw, claim.id, { coverage: 'Collision', claimantName: 'A', claimantKind: 'insured' }));
  run(() => money.setExposureReserve(users.uw, claim.id, 1, 3000));
  run(() => pc.moveClaim(claim.id, { to: 'Approved' }, users.uw));
  run(() => money.payExposure(users.uw, claim.id, 1, { amount: 1200, costType: 'claim_cost' }));
  post();
  const entries = accounting.journal(users.uwm);
  assert.equal(sum(entries, ACCOUNTS.cash.code, 'debit'), 500);
  assert.equal(sum(entries, ACCOUNTS.claimsPaid.code, 'debit'), 1200);
  assert.equal(sum(entries, ACCOUNTS.cash.code, 'credit'), 1200);
  assert.equal(accounting.trialBalance(users.uwm).balanced, true);
  const cash = accounting.trialBalance(users.uwm).accounts.find((a) => a.code === ACCOUNTS.cash.code);
  assert.equal(cash.balance, r2(500 - 1200)); // debit balance: money in less money out
});

test('the receivable always agrees with the customers\' ledgers, through change, cancellation, refund and reinstatement', () => {
  const env = world();
  const { pc, users, accounting, post, newPolicy, billing, run } = env;
  const { policy } = newPolicy();
  post();
  const total = pc.policy(policy.id).transactions[0].amount;
  const fees = pc.db.invoices.filter((i) => i.policyId === policy.id).reduce((s, i) => s + i.fee, 0);
  run(() => billing.receivePayment(users.uwm, { policyId: policy.id, amount: r2(total + fees), method: 'Cheque', reference: 'FULL', receivedOn: '2026-03-01' }));
  env.setToday('2026-04-01');
  const cancel = run(() => pc.startCancellation(policy.id, { effectiveDate: '2026-04-15', reason: 'InsuredRequest' }, users.agent));
  run(() => pc.bind(cancel.id, users.uw));
  post();
  assert.equal(accounting.reconciliation(users.uwm).difference, 0);
  run(() => billing.issueRefund(users.uwm, pc.db.refunds[0].id, { method: 'Bank transfer', reference: 'R1', paidOn: '2026-04-20' }));
  post();
  assert.equal(accounting.reconciliation(users.uwm).difference, 0);
  env.setToday('2026-04-20');
  const back = run(() => pc.startReinstatement(policy.id, users.uwm));
  run(() => pc.bind(back.id, users.uwm));
  post();
  const rec = accounting.reconciliation(users.uwm);
  assert.equal(rec.difference, 0);
  assert.equal(rec.glReceivable, rec.customerBalances);
  assert.equal(accounting.trialBalance(users.uwm).balanced, true);
});

test('an event delivered twice posts once', () => {
  const env = world();
  const { pc, users, accounting, post, newPolicy } = env;
  newPolicy();
  post();
  const before = accounting.journal(users.uwm).length;
  pc.db.eventConsumers.accounting = 0; // the place was lost: every event comes again
  post();
  assert.equal(accounting.journal(users.uwm).length, before);
});

test('closing a month locks it: later postings for that month go into the next open month and say so', () => {
  const env = world();
  const { users, accounting, post, newPolicy, run, billing } = env;
  const { policy } = newPolicy();
  post();
  env.setToday('2026-04-02');
  const closed = run(() => accounting.closeMonth(users.uwm, '2026-03'));
  assert.deepEqual([closed.month, closed.closedBy, closed.entryCount > 0, closed.balanced], ['2026-03', users.uwm.id, true, true]);
  assert.throws(() => run(() => accounting.closeMonth(users.uwm, '2026-03')), (e) => e.status === 409);
  assert.throws(() => run(() => accounting.closeMonth(users.uw, '2026-04')), (e) => e.status === 403);

  // A payment dated in the closed month is posted in April.
  run(() => billing.receivePayment(users.uwm, { policyId: policy.id, amount: 100, method: 'Cheque', reference: 'LATE', receivedOn: '2026-03-20' }));
  env.setToday('2026-03-20');
  post();
  const late = accounting.journal(users.uwm).find((e) => e.reference === 'PAY-0000001');
  assert.deepEqual([late.date, late.originalDate, late.latePosted], ['2026-04-01', '2026-03-20', true]);
  assert.deepEqual(accounting.verifyClosings(users.uwm).map((c) => c.valid), [true]);
});

test('a closed month that is changed afterwards is reported as no longer matching', () => {
  const env = world();
  const { pc, users, accounting, post, newPolicy, run } = env;
  newPolicy();
  post();
  env.setToday('2026-04-02');
  run(() => accounting.closeMonth(users.uwm, '2026-03'));
  pc.db.ledger[0].lines[0].debit += 1; // somebody edits a posted entry in the database
  const [check] = accounting.verifyClosings(users.uwm);
  assert.equal(check.valid, false);
  assert.match(check.problem, /changed/i);
});

test('the trial balance can be taken at a date, and lists every account with debits, credits and balance', () => {
  const env = world();
  const { users, accounting, post, newPolicy } = env;
  newPolicy();
  post();
  const tb = accounting.trialBalance(users.uwm, { asOf: '2026-02-28' });
  assert.deepEqual([tb.accounts.length, tb.totalDebit, tb.totalCredit], [Object.keys(ACCOUNTS).length, 0, 0]);
  const now = accounting.trialBalance(users.uwm, { asOf: '2026-03-31' });
  assert.ok(now.totalDebit > 0);
  assert.equal(now.totalDebit, now.totalCredit);
});

test('the general ledger export is a CSV with one line per journal line, balanced, and safe to open in a spreadsheet', () => {
  const env = world();
  const { pc, users, accounting, post, newPolicy } = env;
  newPolicy();
  post();
  pc.db.ledger[0].description = '=HYPERLINK("http://evil")';
  const csv = accounting.glCsv(users.uwm, {});
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,Journal,Account,Account name,Debit,Credit,Description,Reference,Producer');
  assert.equal(lines.length - 1, accounting.journal(users.uwm).reduce((n, e) => n + e.lines.length, 0));
  assert.ok(lines.every((l) => !/^[=+\-@]/.test(l.split(',')[6] || '')), 'text that looks like a formula is neutralised');
  const rows = lines.slice(1).map((l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '')));
  const debit = r2(rows.reduce((s, r) => s + Number(r[4] || 0), 0));
  const credit = r2(rows.reduce((s, r) => s + Number(r[5] || 0), 0));
  assert.equal(debit, credit);
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2},JE-\d{7},\d{4},/);
});

test('commission statement: what was earned, what was paid, and what is still payable; paying cannot exceed it', () => {
  const env = world();
  const { pc, users, accounting, post, newPolicy, run } = env;
  const { policy } = newPolicy();
  post();
  const total = pc.policy(policy.id).transactions[0].amount;
  const statement = accounting.statement(users.agent, 'PC-100', {});
  assert.equal(statement.producerCode, 'PC-100');
  assert.equal(statement.earned, r2(gstOnPremium({ amount: total }).net * DEFAULT_PRODUCER_COMMISSION), 'commission statement follows the net basis');
  assert.deepEqual([statement.paid, statement.payable], [0, statement.earned]);
  assert.equal(statement.lines[0].policyNumber, policy.policyNumber);
  assert.equal(statement.lines[0].premium, total);

  assert.throws(() => run(() => accounting.payCommission(users.uwm, { producerCode: 'PC-100', amount: statement.earned + 1, method: 'Bank transfer', reference: 'X', paidOn: '2026-03-31' })), (e) => e.status === 422);
  assert.throws(() => run(() => accounting.payCommission(users.agent, { producerCode: 'PC-100', amount: 10, method: 'Bank transfer', reference: 'X', paidOn: '2026-03-31' })), (e) => e.status === 403);
  run(() => accounting.payCommission(users.uwm, { producerCode: 'PC-100', amount: 20, method: 'Bank transfer', reference: 'COMM-1', paidOn: '2026-03-31' }));
  const after = accounting.statement(users.uwm, 'PC-100', {});
  assert.deepEqual([after.paid, after.payable], [20, r2(statement.earned - 20)]);
  assert.equal(accounting.trialBalance(users.uwm).balanced, true);
  assert.equal(after.payments[0].reference, 'COMM-1');
});

test('a producer sees only their own statement; underwriters and executives see none; the ledger is for managers', () => {
  const env = world();
  const { pc, users, accounting, post, newPolicy } = env;
  newPolicy();
  post();
  assert.throws(() => accounting.statement(users.agent, 'PC-200', {}), (e) => e.status === 404);
  assert.throws(() => accounting.statement(pc.user('agent2'), 'PC-100', {}), (e) => e.status === 404);
  for (const who of [users.uw, pc.user('venkatesh')]) {
    assert.throws(() => accounting.statement(who, 'PC-100', {}), (e) => e.status === 403);
    assert.throws(() => accounting.trialBalance(who), (e) => e.status === 403);
    assert.throws(() => accounting.glCsv(who, {}), (e) => e.status === 403);
  }
  assert.throws(() => accounting.journal(users.agent), (e) => e.status === 403);
  assert.throws(() => accounting.reconciliation(users.uw), (e) => e.status === 403);
});

test('the statement can be downloaded as a CSV and as a PDF', async () => {
  const env = world();
  const { users, accounting, post, newPolicy } = env;
  newPolicy();
  post();
  const csv = accounting.statementCsv(users.agent, 'PC-100', {});
  assert.match(csv.split('\r\n')[0], /^Date,Policy,Transaction,Premium,Rate,Commission$/);
  const pdf = await accounting.statementPdf(users.agent, 'PC-100', {});
  assert.equal(pdf.slice(0, 4).toString(), '%PDF');
});
