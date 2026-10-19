'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { EventBus } = require('../src/eventBus');
const { claimsQueueConsumer } = require('../src/consumers');
const { ClaimMoney } = require('../src/claimMoney');

// Work queues for claims handling: a new claim becomes an activity for the underwriters, and a claim payment above
// someone's limit becomes an activity for the UW manager. They close by themselves when the work is done. The queues are
// filled by the event bus, so a failing queue never undoes the claim work itself.

function world() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  const bus = new EventBus(pc);
  bus.register('claims-queue', claimsQueueConsumer(pc));
  env.setToday('2026-03-15');
  return { ...env, policy: pc.policy(job.policyId), bus, money: new ClaimMoney(pc), drain: () => bus.run({ now: new Date('2026-03-15T10:00:00Z') }) };
}

const queue = (env) => env.pc.db.activities.filter((a) => a.type === 'Claims');
const open = (env, user) => env.pc.activities(user);

test('a new claim becomes an activity for the underwriters, High when it was reported late or could not be verified', () => {
  const env = world();
  const { pc, users, run, policy } = env;
  const normal = run(() => pc.openClaim(policy.id, { lossDate: '2026-03-10', lossType: 'Collision' }, users.agent));
  env.setToday('2026-05-01'); // 52 days after the loss: a late report
  const late = run(() => pc.openClaim(policy.id, { lossDate: '2026-03-10', lossType: 'Theft' }, users.agent));
  env.drain();

  const [first, second] = queue(env);
  assert.deepEqual([first.assignedTo, first.priority, first.claimId, first.status], ['uw', 'Normal', normal.id, 'Open']);
  assert.match(first.subject, new RegExp(`Review new claim ${normal.claimNumber}`));
  assert.deepEqual([second.priority, second.claimId], ['High', late.id]);
  assert.match(second.description, /late/i);
  assert.equal(open(env, users.uw).filter((a) => a.type === 'Claims').length, 2);
});

test('the review activity closes when the claim is moved out of Submitted', () => {
  const env = world();
  const { pc, users, run, policy } = env;
  const claim = run(() => pc.openClaim(policy.id, { lossDate: '2026-03-10', lossType: 'Collision' }, users.agent));
  env.drain();
  assert.equal(queue(env)[0].status, 'Open');
  run(() => pc.moveClaim(claim.id, { to: 'Under Review' }, users.uw));
  env.drain();
  assert.deepEqual([queue(env)[0].status, queue(env)[0].completedBy], ['Completed', 'system']);
  assert.equal(open(env, users.uw).filter((a) => a.type === 'Claims').length, 0);
});

test('a claim payment above your limit becomes an approval activity for the UW manager, and closes when it is approved', () => {
  const env = world();
  const { pc, users, run, policy, money } = env;
  const claim = run(() => pc.openClaim(policy.id, { lossDate: '2026-03-10', lossType: 'Collision' }, users.agent));
  run(() => pc.moveClaim(claim.id, { to: 'Under Review' }, users.uw));
  run(() => money.addExposure(users.uw, claim.id, { coverage: 'Collision', claimantName: 'Asha', claimantKind: 'insured' }));
  run(() => money.setExposureReserve(users.uwm, claim.id, 1, 40000));
  run(() => pc.moveClaim(claim.id, { to: 'Approved' }, users.uw));
  const pending = run(() => money.payExposure(users.uw, claim.id, 1, { amount: 8000, costType: 'claim_cost' }));
  env.drain();

  const approval = queue(env).find((a) => /Approve claim payment/.test(a.subject));
  assert.deepEqual([approval.assignedTo, approval.priority, approval.paymentId], ['uwm', 'High', pending.id]);
  // A manager whose id is not 'uwm' still sees the manager queue.
  const sudhakar = pc.user('sudhakar');
  assert.ok(open(env, sudhakar).some((a) => a.id === approval.id));
  assert.ok(!open(env, users.uw).some((a) => a.id === approval.id)); // the underwriter who asked does not get it

  run(() => money.approvePayment(users.uwm, claim.id, pending.id));
  env.drain();
  assert.equal(queue(env).find((a) => a.id === approval.id).status, 'Completed');
});

test('events seen twice make one activity', () => {
  const env = world();
  const { pc, users, run, policy } = env;
  run(() => pc.openClaim(policy.id, { lossDate: '2026-03-10', lossType: 'Collision' }, users.agent));
  env.drain();
  pc.db.eventConsumers['claims-queue'] = 0; // the place was lost: every event comes again
  env.drain();
  assert.equal(queue(env).length, 1);
});

test('a UW manager sees the manager queue whoever the manager is (the collections queue too)', () => {
  const env = world();
  const { pc, users } = env;
  pc.db.activities.push({ id: 'x1', activityNumber: 'ACT-9', type: 'Collections', subject: 's', description: 'd', accountId: pc.db.accounts[0].id, assignedTo: 'uwm', status: 'Open', priority: 'Normal', dueDate: '2026-03-20' });
  assert.equal(pc.activities(pc.user('sudhakar')).length, 1);
  assert.equal(pc.activities(users.uwm).length, 1);
  assert.equal(pc.activities(users.uw).length, 0);
});
