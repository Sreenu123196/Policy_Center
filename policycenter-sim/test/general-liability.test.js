'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, account } = require('./helpers');

const exposure = (over = {}) => ({ classCode: '60010', description: 'Retail shop', amount: 1000000, ...over });

// A general liability submission for a business: named insured, classes of business and claims history.
function glSubmission(pc, user, acct, eff, line = {}) {
  const job = pc.startSubmission({ accountId: acct.id, product: 'GeneralLiability', effectiveDate: eff }, user);
  pc.updateDraft(job.id, {
    line: { ...job.period.line, businessName: 'Rivera Retail LLC', claimsLast5Years: 0, exposures: [exposure()], ...line },
  }, user);
  return job;
}

test('general liability: each class of business is priced on its exposure', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => glSubmission(pc, users.agent, acct, '2026-03-01', {
    exposures: [exposure({ amount: 2000000 }), exposure({ classCode: '16500', description: 'Cafe', amount: 800000 })],
  }));
  run(() => pc.quote(job.id, users.agent));
  const q = pc.job(job.id, users.agent).quote;
  assert.ok(q.total > 0, 'a premium is quoted');
  assert.equal(q.costs.filter((c) => c.coverageCode === 'GLPremOpsCov').length, 2, 'one charge per class');
  assert.ok(q.costs.filter((c) => c.type !== 'Fee').every((c) => c.worksheet && c.worksheet.length > 1), 'every priced charge has a factor worksheet');
});

test('general liability: a higher-risk class costs more for the same exposure', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const retail = run(() => glSubmission(pc, users.agent, acct, '2026-03-01', { exposures: [exposure({ classCode: '60010', amount: 1000000 })] }));
  run(() => pc.quote(retail.id, users.agent));
  const carpentry = run(() => glSubmission(pc, users.agent, acct, '2026-03-01', { exposures: [exposure({ classCode: '91340', amount: 1000000 })] }));
  run(() => pc.quote(carpentry.id, users.agent));
  const charge = (id) => pc.job(id, users.agent).quote.costs.find((c) => c.coverageCode === 'GLPremOpsCov').amount;
  assert.ok(charge(carpentry.id) > charge(retail.id), 'carpentry is rated above retail');
});

test('general liability: a class and a positive amount are required before quoting', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const noClass = run(() => glSubmission(pc, users.agent, acct, '2026-03-01', { exposures: [exposure({ classCode: 'nope' })] }));
  assert.throws(() => run(() => pc.quote(noClass.id, users.agent)));
  const zeroAmount = run(() => glSubmission(pc, users.agent, acct, '2026-03-01', { exposures: [exposure({ amount: 0 })] }));
  assert.throws(() => run(() => pc.quote(zeroAmount.id, users.agent)));
});

test('general liability: two liability claims in five years needs an underwriter before binding', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => glSubmission(pc, users.agent, acct, '2026-03-01', { claimsLast5Years: 2 }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'GL_LOSS_HISTORY');
  assert.ok(issue, 'loss history raises an issue');
  assert.equal(issue.requiredRole, 'Underwriter');
  run(() => pc.approveIssue(job.id, issue.key, 'Loss history reviewed', users.uw));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  assert.equal(pc.policy(pc.job(job.id, users.agent).policyId).product, 'GeneralLiability');
});

test('general liability: a restaurant serving liquor is referred to an underwriter', () => {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => glSubmission(pc, users.agent, acct, '2026-03-01', { exposures: [exposure({ classCode: '16501', description: 'Bar and grill', amount: 600000 })] }));
  run(() => pc.quote(job.id, users.agent));
  const issue = pc.job(job.id, users.agent).uwIssues.find((i) => i.code === 'GL_LIQUOR_SERVICE');
  assert.ok(issue, 'liquor service raises an issue');
  assert.equal(issue.requiredRole, 'Underwriter');
});
