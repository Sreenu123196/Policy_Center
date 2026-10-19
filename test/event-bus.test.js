'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, account, autoSubmission } = require('./helpers');
const { EventBus, PermanentEventError } = require('../src/eventBus');
const { Billing } = require('../src/billing');
const { collectionsConsumer } = require('../src/consumers');

// Event consumers (ported from the Insurance Suite): each consumer reads the events in order and keeps its place. A
// failing event is retried with a growing wait; after too many failures it goes to the dead-letter list and the
// consumer moves on, so one bad event cannot stop everything behind it. A person can redrive a dead event.

const T0 = new Date('2026-10-16T10:00:00.000Z');
const later = (seconds) => new Date(T0.getTime() + seconds * 1000);

function bus() {
  const env = setup('2026-03-01');
  const events = new EventBus(env.pc);
  const emit = (type, n) => env.run(() => env.pc.publish(type, { n }));
  const run = (options = {}) => env.run(() => events.run({ now: T0, ...options }));
  return { ...env, events, emit, run };
}

test('each consumer gets every event once, in order, and remembers where it got to', () => {
  const { events, emit, run } = bus();
  const seen = [];
  events.register('a', (e) => seen.push(`a${e.payload.n}`));
  events.register('b', (e) => seen.push(`b${e.payload.n}`));
  emit('PolicyIssued', 1);
  emit('PolicyChanged', 2);
  assert.deepEqual(run().map((r) => [r.consumer, r.handled]), [['a', 2], ['b', 2]]);
  assert.deepEqual(seen, ['a1', 'a2', 'b1', 'b2']);
  assert.deepEqual(run().map((r) => r.handled), [0, 0]);
  emit('PolicyCancelled', 3);
  run();
  assert.deepEqual(seen.slice(4), ['a3', 'b3']);
});

test('an event is Pending until every consumer has it, then Delivered', () => {
  const { events, emit, run, pc } = bus();
  events.register('a', () => {});
  events.register('b', () => { throw new Error('down'); });
  emit('PolicyIssued', 1);
  run();
  assert.equal(pc.db.events.at(-1).status, 'Retrying');
  const fine = bus();
  fine.events.register('a', () => {});
  fine.emit('PolicyIssued', 1);
  assert.equal(fine.pc.db.events.at(-1).status, 'Pending');
  fine.run();
  assert.equal(fine.pc.db.events.at(-1).status, 'Delivered');
});

test('a failing event is retried after a wait, and nothing behind it is handled out of order', () => {
  const { events, emit, run } = bus();
  let failures = 1;
  const seen = [];
  events.register('a', (e) => {
    if (e.payload.n === 1 && failures-- > 0) throw new Error('the other system is down');
    seen.push(e.payload.n);
  });
  emit('PolicyIssued', 1);
  emit('PolicyChanged', 2);

  const first = run({ backoffSeconds: 30 })[0];
  assert.equal(first.handled, 0);
  assert.deepEqual(first.blockedOn, { eventId: first.blockedOn.eventId, attempts: 1, retryAt: later(30).toISOString() });
  assert.deepEqual(seen, []);

  // Too early: the handler is not even called.
  let called = false;
  events.register('watch', () => { called = true; });
  assert.equal(run({ now: later(10) })[0].blockedOn.attempts, 1);
  assert.equal(called, true); // the other consumer carries on; only 'a' was held back

  const after = run({ now: later(31) })[0];
  assert.deepEqual([after.handled, after.blockedOn], [2, null]);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(events.deadEvents(), []);
});

test('the wait grows after each failure: 30, 60, 120 seconds', () => {
  const { events, emit, run } = bus();
  events.register('a', () => { throw new Error('still down'); });
  emit('PolicyIssued', 1);
  const options = { backoffSeconds: 30, maxAttempts: 5 };
  const one = run({ ...options, now: T0 })[0];
  const two = run({ ...options, now: later(30) })[0];
  const three = run({ ...options, now: later(90) })[0];
  assert.equal(one.blockedOn.retryAt, later(30).toISOString());
  assert.deepEqual([two.blockedOn.attempts, two.blockedOn.retryAt], [2, later(90).toISOString()]);
  assert.deepEqual([three.blockedOn.attempts, three.blockedOn.retryAt], [3, later(210).toISOString()]);
});

test('an event that keeps failing goes to the dead-letter list, and the events behind it carry on', () => {
  const { events, emit, run, pc } = bus();
  const seen = [];
  events.register('a', (e) => {
    if (e.payload.n === 1) throw new Error('cannot understand this event');
    seen.push(e.payload.n);
  });
  emit('PolicyIssued', 1);
  emit('PolicyChanged', 2);
  let clock = 0;
  let result = run({ maxAttempts: 3, backoffSeconds: 10, now: later(clock) })[0];
  while (result.blockedOn) {
    clock += 1000;
    result = run({ maxAttempts: 3, backoffSeconds: 10, now: later(clock) })[0];
  }
  assert.equal(result.deadLettered.length, 1);
  assert.deepEqual(seen, [2]);
  const [dead] = events.deadEvents();
  assert.deepEqual({ consumer: dead.consumer, attempts: dead.attempts, error: dead.lastError, type: dead.eventType }, { consumer: 'a', attempts: 3, error: 'cannot understand this event', type: 'PolicyIssued' });
  assert.equal(pc.db.events[0].status, 'Failed');
  assert.equal(run({ now: later(clock + 5000) })[0].handled, 0); // it does not come back to it
});

test('an error that can never work (permanent) is dead-lettered at once', () => {
  const { events, emit, run } = bus();
  events.register('a', () => { throw new PermanentEventError('the payload is invalid'); });
  emit('PolicyIssued', 1);
  const result = run()[0];
  assert.equal(result.deadLettered.length, 1);
  assert.equal(result.blockedOn, null);
  assert.equal(events.deadEvents()[0].attempts, 1);
});

test('what a failing handler wrote is rolled back, so a retry cannot leave it twice', () => {
  const { events, emit, run, pc } = bus();
  events.register('a', (e) => {
    pc.db.activities.push({ id: `half-${e.eventId}` });
    throw new Error('failed after writing');
  });
  emit('PolicyIssued', 1);
  const before = pc.db.activities.length;
  run();
  assert.equal(pc.db.activities.length, before);
});

test('a manager redrives a dead event once the cause is fixed; it is marked resolved with who did it', () => {
  const { events, emit, run, users, pc } = bus();
  let broken = true;
  const handled = [];
  events.register('a', (e) => {
    if (broken) throw new PermanentEventError('bad');
    handled.push(e.eventId);
  });
  emit('PolicyIssued', 1);
  run();
  const [dead] = events.deadEvents();
  const redrive = (user) => pc.store.transaction(() => events.redrive(user, { consumer: 'a', eventId: dead.eventId }));

  assert.throws(() => redrive(users.uw), (e) => e.status === 403);
  assert.deepEqual(redrive(users.uwm), { ok: false, error: 'bad' });
  assert.equal(events.deadEvents().length, 1);

  broken = false;
  assert.deepEqual(redrive(users.uwm), { ok: true });
  assert.deepEqual(handled, [dead.eventId]);
  assert.deepEqual(events.deadEvents(), []);
  assert.equal(pc.db.eventFailures[0].resolvedBy, users.uwm.id);
  assert.equal(pc.db.events[0].status, 'Delivered');
  assert.throws(() => redrive(users.uwm), (e) => e.status === 404); // no longer on the list
});

// ---- the collections consumer: missed payments become work for a person

function unpaidPolicy() {
  const env = bus();
  const { pc, users } = env;
  const run = (fn) => pc.store.transaction(fn); // the bus helper's own run() drains events
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.updateDraft(job.id, { paymentPlan: 'Monthly' }, users.agent));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  env.events.register('collections', collectionsConsumer(pc));
  return { ...env, tx: run, policy: pc.policy(job.policyId), billing: new Billing(pc) };
}

test('collections: a missed payment and a cancellation request each become one activity for the UW manager', () => {
  const { events, billing, users, pc, tx } = unpaidPolicy();
  tx(() => billing.runDelinquency(users.uwm, { asOf: '2026-03-17' }));
  events.run({ now: T0 });
  const activities = pc.db.activities.filter((a) => a.type === 'Collections');
  assert.deepEqual(activities.map((a) => a.assignedTo), ['uwm', 'uwm']);
  assert.match(activities[0].subject, /missed payment/i);
  assert.match(activities[1].subject, /cancellation for non-payment/i);

  // Seeing the same events again (the place was lost) makes no second activity.
  pc.db.eventConsumers.collections = 0;
  events.run({ now: later(60) });
  assert.equal(pc.db.activities.filter((a) => a.type === 'Collections').length, 2);
});

// ---- batches: a backlog must not take a unit of work (a copy and a save of all the data) per event

test('a backlog is worked off in a handful of units of work, not one per event', () => {
  const { events, emit, pc } = bus();
  const seen = [];
  events.register('a', (e) => seen.push(e.payload.n));
  for (let n = 1; n <= 250; n++) emit('PolicyIssued', n);
  let units = 0;
  const original = pc.store.transaction.bind(pc.store);
  pc.store.transaction = (fn) => { units++; return original(fn); };
  const result = events.run({ now: T0, limit: 1000 })[0];
  assert.equal(result.handled, 250);
  assert.deepEqual(seen, Array.from({ length: 250 }, (_, i) => i + 1));
  assert.ok(units <= 5, `250 events took ${units} units of work`);
});

test('a failing event in the middle of a batch: the ones before it are handled once, the failing one is pinned, the rest wait', () => {
  const { events, emit, run } = bus();
  const calls = [];
  events.register('a', (e) => {
    calls.push(e.payload.n);
    if (e.payload.n === 5 && calls.filter((n) => n === 5).length === 1) throw new Error('fails the first time');
  });
  for (let n = 1; n <= 10; n++) emit('PolicyIssued', n);
  const first = run({ backoffSeconds: 30 })[0];
  assert.equal(first.handled, 4);
  assert.deepEqual([first.blockedOn.attempts, first.blockedOn.retryAt], [1, later(30).toISOString()]);
  assert.deepEqual(calls.slice(0, 5), [1, 2, 3, 4, 5], 'the batch ran in order up to the failing event');
  assert.equal(calls.filter((n) => n === 5).length, 1, 'the failing handler ran once in that run');
  const second = run({ now: later(31) })[0];
  assert.equal(second.handled, 6);
  assert.equal(calls.filter((n) => n === 5).length, 2);
});
