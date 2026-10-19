'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission, driver } = require('./helpers');

// Work queues: one place to see the referrals, claims handling and collections work waiting for people. A person can take
// an item from a shared queue (then it is theirs), a manager can give it to someone, and what is late is flagged.

function world() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  // A referral for the underwriters: two at-fault accidents needs approval level 1. Three needs the manager (level 2).
  const one = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01', { drivers: [driver({ accidents: 2 })] }));
  run(() => pc.quote(one.id, users.agent));
  const two = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01', { drivers: [driver({ accidents: 3 })] }));
  run(() => pc.quote(two.id, users.agent));
  const claim = (type, assignedTo, extra = {}) => pc.db.activities.push({ id: `a-${pc.db.activities.length}`, activityNumber: `ACT-${pc.db.activities.length}`, type, subject: `${type} work`, description: '', accountId: acct.id, assignedTo, status: 'Open', priority: 'Normal', dueDate: '2026-03-05', createdAt: pc.now(), createdBy: 'system', ...extra });
  claim('Claims', 'uw');
  claim('Collections', 'uwm', { dueDate: '2026-03-01' });
  return { ...env, acct, claim };
}

test('the summary counts each queue: open, late, waiting for someone, and mine', () => {
  const env = world();
  const { pc, users } = env;
  env.setToday('2026-03-03');
  const summary = Object.fromEntries(pc.queueSummary(users.uwm).map((q) => [q.type, q]));
  assert.deepEqual(Object.keys(summary).sort(), ['Claims', 'Collections', 'Referral']);
  assert.deepEqual([summary.Collections.open, summary.Collections.overdue, summary.Collections.unassigned], [1, 1, 1]);
  assert.deepEqual([summary.Claims.open, summary.Claims.overdue], [1, 0]);
  assert.ok(summary.Referral.open >= 2);

  // An underwriter sees their own queue only (the manager queue is not theirs).
  const uw = Object.fromEntries(pc.queueSummary(users.uw).map((q) => [q.type, q]));
  assert.equal(uw.Collections.open, 0);
  assert.equal(uw.Claims.open, 1);
});

test('an activity past its due date is flagged late, and the list can be narrowed to one queue', () => {
  const env = world();
  const { pc, users } = env;
  env.setToday('2026-03-03');
  const collections = pc.activities(users.uwm, { type: 'Collections' });
  assert.equal(collections.length, 1);
  assert.equal(collections[0].overdue, true);
  assert.equal(pc.activities(users.uwm, { type: 'Claims' })[0].overdue, false);
  assert.ok(pc.activities(users.uwm).length >= 4);
});

test('a person takes an item from a shared queue; it is then theirs alone, and the manager still sees it', () => {
  const env = world();
  const { pc, users, run } = env;
  const [item] = pc.activities(users.uw, { type: 'Claims' });
  const taken = run(() => pc.takeActivity(item.id, users.uw));
  assert.deepEqual([taken.takenBy, taken.status], [users.uw.id, 'Open']);
  assert.ok(taken.history.some((h) => h.action === 'Taken' && h.by === users.uw.id));
  assert.equal(pc.queueSummary(users.uw).find((q) => q.type === 'Claims').mine, 1);
  assert.equal(pc.queueSummary(users.uw).find((q) => q.type === 'Claims').unassigned, 0);
  // Another underwriter-level person does not get it any more; the manager does.
  assert.equal(pc.activities(pc.user('naagarjuna'), { type: 'Claims' }).length, 0);
  assert.ok(pc.activities(users.uwm, { type: 'Claims' }).some((a) => a.id === item.id));
  // It cannot be taken twice, and an agent cannot take anything.
  assert.throws(() => run(() => pc.takeActivity(item.id, users.uwm)), (e) => e.status === 409);
  assert.throws(() => run(() => pc.takeActivity(item.id, users.agent)), (e) => e.status === 403);
});

test('a UW manager gives an item to a person; nobody else may, and only to staff', () => {
  const env = world();
  const { pc, users, run } = env;
  const [item] = pc.activities(users.uwm, { type: 'Collections' });
  assert.throws(() => run(() => pc.assignActivity(item.id, 'uw', users.uw)), (e) => e.status === 403);
  assert.throws(() => run(() => pc.assignActivity(item.id, 'agent', users.uwm)), (e) => e.status === 422);
  const given = run(() => pc.assignActivity(item.id, 'uw', users.uwm));
  assert.deepEqual([given.takenBy, given.assignedToName], ['uw', 'Uma Underwriter']);
  assert.ok(given.history.some((h) => h.action === 'Assigned' && h.by === users.uwm.id));
  assert.ok(pc.activities(users.uw, { type: 'Collections' }).some((a) => a.id === item.id));
});

test('a completed activity leaves the queue and its counts', () => {
  const env = world();
  const { pc, users, run } = env;
  const [item] = pc.activities(users.uw, { type: 'Claims' });
  run(() => pc.completeActivity(item.id, users.uw));
  assert.equal(pc.queueSummary(users.uw).find((q) => q.type === 'Claims').open, 0);
});

test('an agent sees the referrals on their own accounts, and not the internal claims and collections work', () => {
  const env = world();
  const { pc, users } = env;
  const summary = Object.fromEntries(pc.queueSummary(users.agent).map((q) => [q.type, q]));
  assert.ok(summary.Referral.open >= 2);
  assert.equal(summary.Claims.open + summary.Collections.open, 0);
  assert.ok(pc.activities(users.agent).every((a) => a.type === 'Referral'));
});
