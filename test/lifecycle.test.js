'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, vehicle, autoSubmission, homeSubmission } = require('./helpers');

test('submission: quote, bind and issue creates policy, billing, documents and events', () => {
  const { pc, users, store, run } = setup('2026-03-01');
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.updateDraft(job.id, { paymentPlan: 'Monthly' }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  assert.equal(job.status, 'Quoted');
  run(() => pc.bind(job.id, users.agent));
  assert.equal(job.status, 'Bound');

  const policy = pc.policyDetail(job.policyId, users.agent);
  assert.match(policy.policyNumber, /^PA-\d{7}$/);
  assert.equal(policy.status, 'In Force');
  assert.equal(policy.expirationDate, '2026-09-01');
  assert.equal(policy.invoices.length, 6);
  assert.equal(Math.round(policy.invoices.reduce((s, i) => s + i.amount, 0) * 100) / 100, job.quote.total);
  assert.deepEqual(policy.documents.map((d) => d.name), ['Declarations Page', 'Auto ID Cards']);
  assert.ok(store.data.events.some((e) => e.type === 'PolicyIssued' && e.payload.policyNumber === policy.policyNumber));
});

test('validation errors stop the quote and nothing is persisted', () => {
  const { pc, users, run, store } = setup();
  const acct = run(() => account(pc, users.agent));
  const job = run(() => pc.startSubmission({ accountId: acct.id, product: 'PersonalAuto', effectiveDate: '2026-03-01' }, users.agent));
  assert.throws(() => run(() => pc.quote(job.id, users.agent)), (err) => err.status === 422 && err.details.errors.some((e) => /vehicle/i.test(e.message)));
  assert.equal(store.data.jobs[0].status, 'Draft');
});

test('underwriting: BlocksQuote referral, authority checks, approval and re-quote', () => {
  const { pc, users, run, store } = setup();
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01', { drivers: [{ firstName: 'Risky', lastName: 'Driver', dob: '1985-01-01', licenseNumber: 'X1', licenseState: 'OH', yearsLicensed: 15, accidents: 3, violations: 0 }] }));
  run(() => pc.quote(job.id, users.agent));
  assert.equal(job.status, 'Draft');
  assert.equal(job.quote, null);
  const iss = job.uwIssues.find((i) => i.code === 'PA_ACCIDENT_HISTORY');
  assert.equal(iss.approvalLevel, 2);
  const act = store.data.activities.find((a) => a.jobId === job.id);
  assert.equal(act.assignedTo, 'uwm');

  assert.throws(() => run(() => pc.approveIssue(job.id, iss.key, '', users.agent)), (e) => e.status === 403);
  assert.throws(() => run(() => pc.approveIssue(job.id, iss.key, '', users.uw)), (e) => e.status === 403);
  // A failed unit of work rolls the store back to a fresh copy, so re-read the job by id.
  const current = () => pc.job(job.id);
  run(() => pc.approveIssue(job.id, iss.key, 'Accidents were not at fault per police report', users.uwm));
  assert.equal(store.data.activities.find((a) => a.jobId === job.id).status, 'Completed');
  run(() => pc.quote(job.id, users.agent));
  assert.equal(current().status, 'Quoted');
  run(() => pc.bind(job.id, users.agent));
  assert.equal(current().status, 'Bound');
});

test('underwriting: approval does not cover a worse value, and declines cannot be approved', () => {
  const { pc, users, run } = setup();
  const acct = run(() => account(pc, users.agent));
  const job = run(() => homeSubmission(pc, users.agent, acct, '2026-03-01', { dwelling: { yearBuilt: 1995, roofAge: 22 } }));
  run(() => pc.quote(job.id, users.agent));
  assert.equal(job.status, 'Quoted');
  run(() => pc.bind(job.id, users.agent));
  assert.equal(job.status, 'Quoted', 'bind is blocked by the roof age issue');
  run(() => pc.approveIssue(job.id, 'HO_ROOF_AGE', 'Inspection OK', users.uw));

  const line = JSON.parse(JSON.stringify(job.period.line));
  line.dwelling.roofAge = 24;
  run(() => pc.updateDraft(job.id, { line }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  assert.equal(job.uwIssues.find((i) => i.code === 'HO_ROOF_AGE').approved, false, 'older roof than approved needs a new approval');

  line.dwelling.roofAge = 18;
  line.dwelling.protectionClass = 10;
  run(() => pc.updateDraft(job.id, { line }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  const pc10 = job.uwIssues.find((i) => i.code === 'HO_PROTECTION_CLASS');
  assert.equal(pc10.approvable, false);
  assert.throws(() => run(() => pc.approveIssue(job.id, pc10.key, '', users.uwm)), (e) => e.status === 409);
  run(() => pc.decline(job.id, 'Unprotected', users.uw));
  assert.equal(pc.job(job.id).status, 'Declined');
});

test('policy change: pro-rated premium, new version, out-of-sequence rejected', () => {
  const { pc, users, run, setToday } = setup('2026-03-01');
  const acct = run(() => account(pc, users.agent));
  const sub = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(sub.id, users.agent));
  run(() => pc.bind(sub.id, users.agent));

  setToday('2026-06-01');
  const change = run(() => pc.startPolicyChange(sub.policyId, { effectiveDate: '2026-06-01' }, users.agent));
  const line = JSON.parse(JSON.stringify(change.period.line));
  line.vehicles.push(vehicle({ vin: '1FMCU9G60MUA99999', year: 2024, marketValue: 30000 }));
  run(() => pc.updateDraft(change.id, { line }, users.agent));
  run(() => pc.quote(change.id, users.agent));
  const pr = change.quote.proration;
  assert.equal(pr.termDays, 184);
  assert.equal(pr.remainingDays, 92);
  assert.equal(change.quote.changeAmount, Math.round((pr.newTermPremium - pr.priorTermPremium) * 0.5 * 100) / 100);
  assert.ok(change.quote.changeAmount > 0);
  assert.equal(change.quote.fees, 0);
  run(() => pc.bind(change.id, users.agent));

  const policy = pc.policyDetail(sub.policyId, users.agent);
  assert.equal(policy.versions.length, 2);
  assert.equal(policy.current.period.line.vehicles.length, 2);
  assert.throws(() => run(() => pc.startPolicyChange(sub.policyId, { effectiveDate: '2026-05-01' }, users.agent)), /Out-of-sequence/);
});

test('cancellation (short rate) and reinstatement reverse each other', () => {
  const { pc, users, run, setToday } = setup('2026-01-01');
  const acct = run(() => account(pc, users.agent));
  const sub = run(() => homeSubmission(pc, users.agent, acct, '2026-01-01'));
  run(() => pc.quote(sub.id, users.agent));
  run(() => pc.bind(sub.id, users.agent));
  const termPremium = sub.quote.premium + sub.quote.taxes;

  setToday('2026-07-02');
  assert.throws(() => run(() => pc.startCancellation(sub.policyId, { effectiveDate: '2026-07-02', reason: 'UnderwritingReasons' }, users.agent)), (e) => e.status === 403);
  assert.throws(() => run(() => pc.startCancellation(sub.policyId, { effectiveDate: '2026-07-02', reason: 'NonPayment' }, users.agent)), /10 days notice/);
  const cancel = run(() => pc.startCancellation(sub.policyId, { effectiveDate: '2026-07-02', reason: 'InsuredRequest' }, users.agent));
  const expected = -Math.round(((termPremium * 183) / 365) * 0.9 * 100) / 100;
  assert.equal(cancel.cancellation.method, 'Short rate');
  assert.equal(cancel.quote.changeAmount, expected);
  run(() => pc.bind(cancel.id, users.agent));
  assert.equal(pc.policyDetail(sub.policyId, users.agent).status, 'Cancelled');
  assert.throws(() => run(() => pc.startPolicyChange(sub.policyId, { effectiveDate: '2026-07-10' }, users.agent)), /cancelled/);

  const reinstate = run(() => pc.startReinstatement(sub.policyId, users.agent));
  assert.equal(reinstate.quote.changeAmount, -expected);
  run(() => pc.bind(reinstate.id, users.agent));
  const policy = pc.policyDetail(sub.policyId, users.agent);
  assert.equal(policy.status, 'In Force');
  assert.equal(policy.writtenPremium, sub.quote.total);
});

test('renewal: window enforced, new term uses the new rate book, batch picks up candidates', () => {
  const { pc, users, run, setToday } = setup('2026-01-15');
  const acct = run(() => account(pc, users.agent));
  const home = run(() => homeSubmission(pc, users.agent, acct, '2026-01-15'));
  run(() => pc.quote(home.id, users.agent));
  run(() => pc.bind(home.id, users.agent));
  assert.throws(() => run(() => pc.startRenewal(home.policyId, users.agent)), /at most 120 days/);

  setToday('2026-11-20');
  const batch = run(() => pc.runRenewalBatch({ daysAhead: 60 }, users.uw));
  assert.equal(batch.processed, 1);
  const renewal = pc.job(batch.results[0].jobId);
  assert.equal(renewal.status, 'Quoted');
  assert.equal(renewal.period.termNumber, 2);
  assert.equal(renewal.period.effectiveDate, '2027-01-15');
  assert.equal(renewal.quote.rateBook.version, '2027.1');
  assert.ok(renewal.quote.premium > home.quote.premium, 'rate increase applies at renewal');
  run(() => pc.bind(renewal.id, users.agent));
  const policy = pc.policyDetail(home.policyId, users.agent);
  assert.equal(policy.terms.length, 2);
  assert.throws(() => run(() => pc.runRenewalBatch({}, users.agent)), (e) => e.status === 403);
});

test('agents only see accounts for their own producer code', () => {
  const { pc, users, run } = setup();
  const other = pc.user('agent2');
  const a = run(() => account(pc, users.agent));
  run(() => account(pc, other, { firstName: 'Other' }));
  assert.equal(pc.listAccounts('', users.agent).length, 1);
  assert.equal(pc.listAccounts('', users.uw).length, 2);
  assert.throws(() => pc.accountDetail(a.id, other), (e) => e.status === 404);
});
