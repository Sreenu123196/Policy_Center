'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { Store } = require('../src/store');
const { PolicyCenter } = require('../src/policyCenter');
const { seed } = require('../src/seed');

function book() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  return { ...env, acct, policy: pc.policy(job.policyId) };
}

const HOUR = 3600 * 1000;

test('tickets: the SLA deadline depends on priority (Urgent 4h, High 1d, Normal 2d, Low 5d)', () => {
  const { pc, users, acct, setToday } = book();
  setToday('2026-03-02');
  pc.clockMs = Date.parse('2026-03-02T09:00:00Z');
  const hours = {};
  for (const priority of ['Urgent', 'High', 'Normal', 'Low']) {
    const t = pc.createTicket({ accountId: acct.id, category: 'Other', priority, subject: `${priority} check` }, users.uwm);
    hours[priority] = (Date.parse(t.slaDueAt) - Date.parse(t.createdAt)) / HOUR;
  }
  assert.deepEqual(hours, { Urgent: 4, High: 24, Normal: 48, Low: 120 });
  assert.throws(() => pc.createTicket({ accountId: acct.id, priority: 'Whenever', subject: 'x y' }, users.uwm), /Priority/);
  assert.throws(() => pc.createTicket({ accountId: acct.id, priority: 'Low', subject: 'a' }, users.uwm), /subject/);
});

test('tickets: SLA shows On time, Breached, Responded, and Met or Missed after resolution', () => {
  const { pc, users, acct } = book();
  pc.clockMs = Date.parse('2026-03-02T09:00:00Z');
  const t = pc.createTicket({ accountId: acct.id, category: 'Claim', priority: 'Urgent', subject: 'Car needed' }, users.uwm);
  assert.equal(pc.ticket(t.id, users.uwm).status, 'Open');
  assert.equal(pc.ticketView(pc.ticket(t.id, users.uwm), users.uwm).sla.state, 'On time');
  pc.clockMs = Date.parse('2026-03-02T14:00:00Z'); // 5 hours later: past the 4-hour Urgent deadline
  assert.equal(pc.ticketView(pc.ticket(t.id, users.uwm), users.uwm).sla.state, 'Breached');
  pc.assignTicket(t.id, 'uw', users.uwm);
  pc.moveTicket(t.id, { to: 'In Progress' }, users.uw);
  assert.equal(pc.ticketView(pc.ticket(t.id, users.uwm), users.uwm).sla.state, 'Responded');
  pc.clockMs = Date.parse('2026-03-02T15:00:00Z');
  pc.moveTicket(t.id, { to: 'Resolved' }, users.uw);
  assert.equal(pc.ticketView(pc.ticket(t.id, users.uwm), users.uwm).sla.state, 'Missed', 'resolved after the deadline');
});

test('tickets: stages follow Open > Assigned > In Progress > Resolved > Closed, and a resolved ticket can be reopened', () => {
  const { pc, users, acct } = book();
  const t = pc.createTicket({ accountId: acct.id, category: 'Billing', priority: 'Normal', subject: 'Installment date' }, users.uwm);
  assert.throws(() => pc.moveTicket(t.id, { to: 'Resolved' }, users.uwm), /cannot move to Resolved/);
  pc.assignTicket(t.id, 'uw', users.uwm);
  pc.moveTicket(t.id, { to: 'In Progress' }, users.uw);
  pc.moveTicket(t.id, { to: 'Resolved' }, users.uw);
  pc.moveTicket(t.id, { to: 'In Progress' }, users.uw);
  pc.moveTicket(t.id, { to: 'Resolved' }, users.uw);
  pc.moveTicket(t.id, { to: 'Closed' }, users.uw);
  assert.throws(() => pc.moveTicket(t.id, { to: 'In Progress' }, users.uw), /cannot move/);
  assert.equal(pc.ticket(t.id, users.uwm).history.filter((h) => h.action === 'Status').length, 5);
});

test('tickets: only underwriting staff can assign, and only to staff', () => {
  const { pc, users, acct } = book();
  const t = pc.createTicket({ accountId: acct.id, category: 'Other', priority: 'Low', subject: 'Address change' }, users.uwm);
  assert.throws(() => pc.assignTicket(t.id, 'uw', users.agent), /authority/);
  assert.throws(() => pc.assignTicket(t.id, 'agent', users.uwm), /Assign to/);
});

test('tickets: a staff note records the first response; internal notes are marked', () => {
  const { pc, users, acct } = book();
  const t = pc.createTicket({ accountId: acct.id, category: 'Other', priority: 'High', subject: 'Garage door' }, users.uwm);
  const noted = pc.addTicketNote(t.id, { text: 'Called the customer', internal: true }, users.uwm);
  assert.ok(noted.firstResponseAt, 'first staff note counts as the first response');
  assert.equal(noted.notes[0].internal, true);
  assert.throws(() => pc.addTicketNote(t.id, { text: '  ' }, users.uwm), /Write a note/);
});

test('tickets: agents see only their own customers tickets', () => {
  const { pc, users, acct } = book();
  pc.createTicket({ accountId: acct.id, category: 'Other', priority: 'Normal', subject: 'Owner question' }, users.uwm);
  assert.equal(pc.listTickets(users.agent).length, 1);
  assert.equal(pc.listTickets(pc.user('agent2')).length, 0);
  assert.throws(() => pc.ticket('TKT-0000001', pc.user('agent2')), /not found/i);
});

test('tickets: the queue puts premium customers first, then by priority', () => {
  const store = new Store();
  const pc = new PolicyCenter(store);
  store.transaction(() => seed(pc));
  const uwm = pc.user('uwm');
  const queue = pc.ticketQueue(uwm);
  assert.ok(queue.length >= 2);
  assert.equal(queue[0].premiumCustomer, true, 'the premium customer comes first');
  assert.ok(queue.every((t, i) => i === 0 || queue[i - 1].premiumCustomer || !t.premiumCustomer), 'premium tickets are never below non-premium ones');
});

test('claims: stages run in order and each stage has its own rules', () => {
  const { pc, users, policy } = book();
  const claim = pc.openClaim(policy.id, { lossDate: '2026-03-01', lossType: 'Collision' }, users.agent);
  assert.equal(claim.status, 'Submitted');
  assert.throws(() => pc.moveClaim(claim.id, { to: 'Approved' }, users.uw), /cannot move to Approved/);
  assert.throws(() => pc.setClaimReserve(claim.id, 500, users.uw), /needs it to be/, 'no reserve before review');
  pc.moveClaim(claim.id, { to: 'Under Review' }, users.uw);
  pc.moveClaim(claim.id, { to: 'Documents Pending', reason: 'Need repair estimate' }, users.uw);
  assert.throws(() => pc.moveClaim(claim.id, { to: 'Approved' }, users.uw), /cannot move to Approved/, 'documents must come in first');
  pc.moveClaim(claim.id, { to: 'Under Review' }, users.uw);
  pc.setClaimReserve(claim.id, 800, users.uw);
  pc.moveClaim(claim.id, { to: 'Approved' }, users.uw);
  pc.payClaim(claim.id, { amount: 800 }, users.uw);
  const settled = pc.moveClaim(claim.id, { to: 'Settled' }, users.uw);
  assert.equal(settled.status, 'Settled');
  assert.equal(settled.paid, 800);
  assert.equal(settled.history.length, 6, 'every stage change is recorded, including the first');
});

test('claims: a rejected claim is final and cannot be paid', () => {
  const { pc, users, policy } = book();
  const claim = pc.openClaim(policy.id, { lossDate: '2026-03-01', lossType: 'Theft' }, users.agent);
  pc.moveClaim(claim.id, { to: 'Rejected', reason: 'Not covered' }, users.uw);
  assert.throws(() => pc.moveClaim(claim.id, { to: 'Under Review' }, users.uw), /final stage/);
  assert.equal(pc.claimDetail(claim.id, users.uw).closeReason, 'Not covered');
});

test('claims: only underwriting staff move claims between stages', () => {
  const { pc, users, policy } = book();
  const claim = pc.openClaim(policy.id, { lossDate: '2026-03-01', lossType: 'Water' }, users.agent);
  assert.throws(() => pc.moveClaim(claim.id, { to: 'Under Review' }, users.agent), /authority/);
});
