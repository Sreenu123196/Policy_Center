'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account } = require('./helpers');

const cls = (over = {}) => ({ classCode: '8810', description: 'Office staff', payroll: 400000, employees: 6, ...over });

// A workers compensation submission: business name, payroll by classification and the experience modification.
function wcSubmission(pc, user, acct, eff, line = {}) {
  const job = pc.startSubmission({ accountId: acct.id, product: 'WorkersComp', effectiveDate: eff }, user);
  pc.updateDraft(job.id, {
    line: { ...job.period.line, businessName: 'Rivera Services LLC', experienceMod: 1, classes: [cls()], ...line },
  }, user);
  return job;
}

test('workers comp: payroll is priced by classification and the experience modification moves the premium', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const base = run(() => wcSubmission(pc, users.agent, acct, '2026-03-01', { classes: [cls({ classCode: '5403', payroll: 500000 })] }));
  run(() => pc.quote(base.id, users.agent));
  const heavier = run(() => wcSubmission(pc, users.agent, acct, '2026-03-01', { classes: [cls({ classCode: '5403', payroll: 500000 })], experienceMod: 1.2 }));
  run(() => pc.quote(heavier.id, users.agent));
  const classCost = (id) => pc.job(id, users.agent).quote.costs.find((c) => c.coverageCode === 'WCStatutoryCov').amount;
  assert.ok(classCost(base.id) > 0, 'class premium is charged');
  assert.ok(classCost(heavier.id) > classCost(base.id), 'a higher experience modification raises the class premium');
});

test('workers comp: carpentry costs more per $100 of payroll than clerical office', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const office = run(() => wcSubmission(pc, users.agent, acct, '2026-03-01', { classes: [cls({ classCode: '8810', payroll: 500000 })] }));
  run(() => pc.quote(office.id, users.agent));
  const carpentry = run(() => wcSubmission(pc, users.agent, acct, '2026-03-01', { classes: [cls({ classCode: '5403', payroll: 500000 })] }));
  run(() => pc.quote(carpentry.id, users.agent));
  const classCost = (id) => pc.job(id, users.agent).quote.costs.find((c) => c.coverageCode === 'WCStatutoryCov').amount;
  assert.ok(classCost(carpentry.id) > classCost(office.id) * 10);
});

test('workers comp: a classification, payroll and a valid experience modification are required', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const noClass = run(() => wcSubmission(pc, users.agent, acct, '2026-03-01', { classes: [cls({ classCode: 'nope' })] }));
  assert.throws(() => run(() => pc.quote(noClass.id, users.agent)));
  const noPayroll = run(() => wcSubmission(pc, users.agent, acct, '2026-03-01', { classes: [cls({ payroll: 0 })] }));
  assert.throws(() => run(() => pc.quote(noPayroll.id, users.agent)));
  const badMod = run(() => wcSubmission(pc, users.agent, acct, '2026-03-01', { experienceMod: 3 }));
  assert.throws(() => run(() => pc.quote(badMod.id, users.agent)));
});

test('workers comp: a high experience modification needs an underwriter before the quote', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => wcSubmission(pc, users.agent, acct, '2026-03-01', { experienceMod: 1.4 }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'WC_HIGH_MOD');
  assert.ok(issue, 'a 1.4 modification raises an issue');
  assert.equal(issue.requiredRole, 'Underwriter');
  run(() => pc.approveIssue(job.id, issue.key, 'Modification reviewed', users.uw));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  assert.equal(pc.policy(pc.job(job.id, users.agent).policyId).product, 'WorkersComp');
});

test('workers comp: more than 200 employees needs the UW Manager', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => wcSubmission(pc, users.agent, acct, '2026-03-01', { classes: [cls({ employees: 250 })] }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'WC_LARGE_EMPLOYER');
  assert.ok(issue, 'a large workforce raises an issue');
  assert.equal(issue.requiredRole, 'UW Manager');
});
