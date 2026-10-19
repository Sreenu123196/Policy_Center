'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account } = require('./helpers');
const { Billing } = require('../src/billing');

// Premium audit (Tier 3, item 10). A workers' compensation or general liability policy is priced on what the business
// ESTIMATES (payroll, receipts). After the term ends, an auditor records what actually happened; the premium is worked out
// again on the actuals, and the difference is billed (additional premium) or returned. One audit per term.

const cls = (over = {}) => ({ classCode: '5403', description: 'Carpentry', payroll: 500000, employees: 8, ...over });

function wcPolicy() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => pc.startSubmission({ accountId: acct.id, product: 'WorkersComp', effectiveDate: '2026-03-01' }, users.agent));
  run(() => pc.updateDraft(job.id, { line: { ...job.period.line, businessName: 'Rivera Services LLC', experienceMod: 1, classes: [cls(), cls({ classCode: '8810', description: 'Office', payroll: 200000, employees: 3 })] } }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const policy = pc.policy(pc.job(job.id).policyId);
  return { ...env, acct, policy, estimated: pc.job(job.id).quote };
}

const startAudit = (env, user = env.users.uw) => env.run(() => env.pc.startPremiumAudit(env.policy.id, {}, user));

test('an audit starts only after the term has ended, by an underwriter, once per term', () => {
  const env = wcPolicy();
  const { users, run, pc, policy } = env;
  assert.throws(() => startAudit(env), (e) => e.status === 422 && /has not ended/i.test(e.message));
  env.setToday('2027-03-02');
  assert.throws(() => startAudit(env, users.agent), (e) => e.status === 403);
  const job = startAudit(env);
  assert.deepEqual([job.type, job.status, job.audit.termNumber], ['PremiumAudit', 'Draft', 1]);
  assert.deepEqual(job.audit.estimated.map((c) => [c.classCode, c.payroll]), [['5403', 500000], ['8810', 200000]]);
  // Not twice at once, and the audit job is the one open job on the policy.
  assert.throws(() => startAudit(env), (e) => e.status === 409);
  assert.throws(() => run(() => pc.startPolicyChange(policy.id, { effectiveDate: '2027-03-02' }, users.agent)), (e) => e.status === 409);
});

test('only products priced on an estimate can be audited', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => pc.startSubmission({ accountId: acct.id, product: 'PersonalAuto', effectiveDate: '2026-03-01' }, users.agent));
  assert.throws(() => run(() => pc.startPremiumAudit(job.id, {}, users.uw)), (e) => e.status === 404 || e.status === 422);
});

test('the actual payroll is recorded, and nothing else about the policy can be changed by an audit', () => {
  const env = wcPolicy();
  const { users, run, pc } = env;
  env.setToday('2027-03-02');
  const job = startAudit(env);
  const updated = run(() => pc.recordAuditActuals(job.id, [{ index: 0, payroll: 650000, employees: 9 }, { index: 1, payroll: 180000, employees: 3 }], users.uw));
  assert.deepEqual(updated.period.line.classes.map((c) => [c.classCode, c.payroll, c.employees]), [['5403', 650000, 9], ['8810', 180000, 3]]);
  assert.throws(() => run(() => pc.recordAuditActuals(job.id, [{ index: 5, payroll: 1 }], users.uw)), (e) => e.status === 422);
  assert.throws(() => run(() => pc.recordAuditActuals(job.id, [{ index: 0, payroll: -5 }], users.uw)), (e) => e.status === 422);
  assert.throws(() => run(() => pc.updateDraft(job.id, { termMonths: 24 }, users.uw)), (e) => e.status === 409); // the generic editor is closed
});

test('more payroll than estimated: additional premium is worked out on the whole term, billed and posted', () => {
  const env = wcPolicy();
  const { users, run, pc, policy, estimated } = env;
  env.setToday('2027-03-02');
  const job = startAudit(env);
  run(() => pc.recordAuditActuals(job.id, [{ index: 0, payroll: 650000 }], users.uw));
  const quoted = run(() => pc.quote(job.id, users.uw));
  assert.equal(quoted.status, 'Quoted');
  assert.ok(quoted.quote.changeAmount > 0, 'additional premium');
  const expected = Math.round(((quoted.quote.premium + quoted.quote.taxes) - (estimated.premium + estimated.taxes)) * 100) / 100;
  assert.equal(quoted.quote.changeAmount, expected);

  run(() => pc.bind(job.id, users.uw));
  const after = pc.policy(policy.id);
  assert.equal(after.audits.length, 1);
  assert.deepEqual([after.audits[0].termNumber, after.audits[0].difference], [1, expected]);
  assert.equal(after.transactions.at(-1).amount, expected);
  const invoice = pc.db.invoices.filter((i) => i.policyId === policy.id).at(-1);
  assert.deepEqual([invoice.amount, /additional premium/i.test(invoice.description)], [expected, true]);
  assert.ok(pc.db.documents.some((d) => d.policyId === policy.id && d.name === 'Premium Audit Statement'));
  assert.ok(pc.db.events.some((e) => e.type === 'PremiumAuditCompleted' && e.payload.premiumChange === expected));
  // The next audit of the same term is refused.
  assert.throws(() => startAudit(env), (e) => e.status === 409);
});

test('less payroll than estimated: a return premium credit', () => {
  const env = wcPolicy();
  const { users, run, pc, policy } = env;
  env.setToday('2027-03-02');
  const job = startAudit(env);
  run(() => pc.recordAuditActuals(job.id, [{ index: 0, payroll: 300000 }, { index: 1, payroll: 100000 }], users.uw));
  run(() => pc.quote(job.id, users.uw));
  run(() => pc.bind(job.id, users.uw));
  const invoice = pc.db.invoices.filter((i) => i.policyId === policy.id).at(-1);
  assert.ok(invoice.amount < 0 && /return premium/i.test(invoice.description));
  const ledger = new Billing(pc).ledgerFor(policy.id, users.uwm);
  assert.ok(ledger.entries.some((e) => e.type === 'credit' && e.amount < 0));
});

test('changing the actuals after a quote reopens the quote; an audit that needs no change is allowed', () => {
  const env = wcPolicy();
  const { users, run, pc } = env;
  env.setToday('2027-03-02');
  const job = startAudit(env);
  run(() => pc.quote(job.id, users.uw)); // actuals equal the estimate
  assert.equal(pc.job(job.id).quote.changeAmount, 0);
  run(() => pc.recordAuditActuals(job.id, [{ index: 0, payroll: 520000 }], users.uw));
  assert.deepEqual([pc.job(job.id).status, pc.job(job.id).quote], ['Draft', null]);
});

test('the audit follows the books: the receivable still agrees with the customer ledger afterwards', () => {
  const { Accounting } = require('../src/accounting');
  const { EventBus } = require('../src/eventBus');
  const { accountingConsumer } = require('../src/consumers');
  const env = wcPolicy();
  const { users, run, pc } = env;
  const bus = new EventBus(pc);
  const accounting = new Accounting(pc);
  bus.register('accounting', accountingConsumer(accounting));
  env.setToday('2027-03-02');
  const job = startAudit(env);
  run(() => pc.recordAuditActuals(job.id, [{ index: 0, payroll: 650000 }], users.uw));
  run(() => pc.quote(job.id, users.uw));
  run(() => pc.bind(job.id, users.uw));
  bus.run({ now: new Date('2027-03-02T10:00:00Z') });
  assert.equal(accounting.reconciliation(users.uwm).difference, 0);
  assert.equal(accounting.trialBalance(users.uwm).balanced, true);
});
