'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');

// Two salespeople, each selling one auto policy through their own producer code.
function twoSellers() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const sellerTwo = pc.user('agent2');
  const a1 = run(() => account(pc, users.agent));
  const a2 = run(() => account(pc, sellerTwo, { firstName: 'Other', producerCode: 'PC-200' }));
  for (const [acct, user] of [[a1, users.agent], [a2, sellerTwo]]) {
    const job = run(() => autoSubmission(pc, user, acct, '2026-03-01'));
    run(() => pc.quote(job.id, user));
    run(() => pc.bind(job.id, user));
  }
  return { ...env, sellerTwo, a1 };
}

test('sales: analytics counts policies and premium per salesperson, by day, month and year', () => {
  const { pc, users } = twoSellers();
  const mgr = pc.salesAnalytics(users.uwm, { period: 'month' });
  assert.equal(mgr.buckets.length, 1);
  const bucket = mgr.buckets[0];
  assert.equal(bucket.total.policies, 2);
  assert.deepEqual(bucket.salespeople.map((s) => s.name).sort(), ['Alex Agent', 'Blair Broker']);
  assert.equal(bucket.salespeople.reduce((s, x) => s + x.policies, 0), 2);
  assert.ok(bucket.total.premium > 0);
  assert.equal(pc.salesAnalytics(users.uwm, { period: 'year' }).buckets[0].period.length, 4);
  assert.equal(pc.salesAnalytics(users.uwm, { period: 'day' }).buckets[0].total.policies, 2);
  assert.throws(() => pc.salesAnalytics(users.uwm, { period: 'week' }), /Period/);
});

test('sales: agents see only their own sales in analytics', () => {
  const { pc, users, sellerTwo } = twoSellers();
  const mine = pc.salesAnalytics(users.agent, { period: 'year' });
  assert.equal(mine.buckets[0].total.policies, 1);
  assert.equal(mine.buckets[0].salespeople[0].name, 'Alex Agent');
  assert.equal(mine.scope, 'your sales only');
  assert.equal(pc.salesAnalytics(sellerTwo, { period: 'year' }).buckets[0].salespeople[0].name, 'Blair Broker');
});

test('lapsing: policies whose term ends soon, then lapsed, go to the salesperson who sold them', () => {
  const { pc, users, setToday } = twoSellers();
  // Both policies run 2026-03-01 to 2026-09-01.
  setToday('2026-08-15');
  let rows = pc.lapsePolicies(users.uwm);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'Lapsing' && r.daysToExpiry === 17));
  assert.deepEqual(rows.map((r) => r.salesperson.name).sort(), ['Alex Agent', 'Blair Broker']);
  const mine = pc.lapsePolicies(users.agent);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].salesperson.name, 'Alex Agent');
  setToday('2026-09-10');
  rows = pc.lapsePolicies(users.uwm);
  assert.ok(rows.length === 2 && rows.every((r) => r.status === 'Lapsed'));
  setToday('2026-12-30');
  assert.equal(pc.lapsePolicies(users.uwm).length, 0, 'lapsed for more than 90 days drops off the list');
});

test('lapsing: a renewal already bound takes the policy off the list', () => {
  const { pc, users, setToday, a1 } = twoSellers();
  setToday('2026-08-15');
  const policy = pc.db.policies.find((p) => p.accountId === a1.id);
  const renewal = pc.startRenewal(policy.id, users.uwm);
  pc.quote(renewal.id, users.uwm);
  pc.bind(renewal.id, users.uwm);
  const rows = pc.lapsePolicies(users.uwm);
  assert.equal(rows.length, 1, 'only the policy without a renewal is still lapsing');
  assert.equal(rows[0].salesperson.name, 'Blair Broker');
});

test('follow-ups: logged with date, channel and result, assigned to the seller, with history', () => {
  const { pc, users, setToday } = twoSellers();
  setToday('2026-08-15');
  const policy = pc.lapsePolicies(users.agent)[0];
  const fu = pc.logFollowUp(policy.policyId, { channel: 'Phone', result: 'Callback requested', notes: 'Call after 5pm' }, users.agent);
  assert.equal(fu.date, '2026-08-15');
  assert.equal(fu.channel, 'Phone');
  assert.equal(fu.salespersonId, 'agent');
  assert.equal(fu.loggedBy, 'agent');
  pc.logFollowUp(policy.policyId, { channel: 'Email', result: 'Interested', date: '2026-08-14' }, users.agent);
  const history = pc.followUpHistory(policy.policyId, users.uwm);
  assert.deepEqual(history.map((f) => f.date), ['2026-08-15', '2026-08-14'], 'newest first');
  const after = pc.lapsePolicies(users.agent)[0];
  assert.equal(after.lastFollowUp.result, 'Callback requested');
  assert.equal(after.followUpCount, 2);
});

test('follow-ups: validation and who may log them', () => {
  const { pc, users, setToday, sellerTwo } = twoSellers();
  setToday('2026-08-15');
  const policy = pc.lapsePolicies(users.agent)[0];
  assert.throws(() => pc.logFollowUp(policy.policyId, { channel: 'Carrier pigeon', result: 'Other' }, users.agent), /Channel/);
  assert.throws(() => pc.logFollowUp(policy.policyId, { channel: 'Email', result: 'Won' }, users.agent), /Result/);
  assert.throws(() => pc.logFollowUp(policy.policyId, { channel: 'Email', result: 'Other', date: '2026-08-16' }, users.agent), /future/);
  assert.throws(() => pc.logFollowUp(policy.policyId, { channel: 'Email', result: 'Other', date: '2026-02-30' }, users.agent), /yyyy-mm-dd/);
  // Blair Broker cannot see Alex's customer at all.
  assert.throws(() => pc.logFollowUp(policy.policyId, { channel: 'Email', result: 'Other' }, sellerTwo), /not found/i);
  // A manager may log for any salesperson's policy.
  const logged = pc.logFollowUp(policy.policyId, { channel: 'Letter', result: 'Other' }, users.uwm);
  assert.equal(logged.salespersonId, 'agent');
  assert.equal(logged.loggedBy, 'uwm');
});

test('follow-ups: the all-follow-ups list is limited by role', () => {
  const { pc, users, setToday } = twoSellers();
  setToday('2026-08-15');
  const alex = pc.lapsePolicies(users.agent)[0];
  const blair = pc.lapsePolicies(users.uwm).find((r) => r.salesperson.name === 'Blair Broker');
  pc.logFollowUp(alex.policyId, { channel: 'Phone', result: 'No answer' }, users.agent);
  pc.logFollowUp(blair.policyId, { channel: 'SMS', result: 'Interested' }, pc.user('agent2'));
  assert.equal(pc.followUpsVisible(users.uwm).length, 2);
  const forAlex = pc.followUpsVisible(users.agent);
  assert.equal(forAlex.length, 1);
  assert.equal(forAlex[0].channel, 'Phone');
  assert.ok(forAlex[0].insured, 'the customer name is included');
  assert.equal(pc.followUpsVisible(pc.user('agent2')).length, 1);
});

test('renewal follow-up: each lapsing row carries the customer, and the message preview gives the WhatsApp number and text for managers, agents and executives', () => {
  const { pc, users, setToday } = twoSellers();
  setToday('2026-08-15');
  const { Messaging } = require('../src/messaging');
  const messaging = new Messaging(pc, { transports: {} });
  const row = pc.lapsePolicies(users.uwm)[0];
  assert.ok(row.accountId, 'the row names the customer account');
  for (const who of [users.uwm, users.agent, users.executive || pc.user('venkatesh')]) {
    const mine = pc.lapsePolicies(who).find((r) => r.policyId === row.policyId);
    if (!mine) continue; // an agent only sees their own sales
    const msg = messaging.preview({ accountId: mine.accountId, policyId: mine.policyId, template: 'renewal', channel: 'whatsapp', language: 'en' }, who);
    assert.ok(msg.body.includes(mine.policyNumber), 'the message names the policy');
    assert.equal(msg.channel, 'whatsapp');
  }
  const lapse = messaging.preview({ accountId: row.accountId, policyId: row.policyId, template: 'lapse', channel: 'email', language: 'hi' }, users.uwm);
  assert.ok(lapse.subject && lapse.body.length > 0, 'lapse template renders for email');
});
