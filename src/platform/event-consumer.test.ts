import type { Database } from './database.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { listAuditEntries } from './audit.js';
import { consumeEvents, listDeadEvents, PermanentEventError, redriveDeadEvent } from './event-consumer.js';
import { recordEvent } from './outbox.js';

// The event consumer (document section 17: retries and a dead-letter queue). A consumer reads the outbox in order and
// keeps its place. A failing event is retried with a growing wait; after too many failures it goes to the dead-letter
// list and the consumer moves on, so one bad event cannot stop everything behind it.

let db: Database;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db);
});

const ID = '11111111-1111-4111-8111-111111111111';
const emit = (type: string, n: number) => recordEvent(db, { type, aggregateType: 'policy', aggregateId: ID, payload: { n } });
const T0 = new Date('2026-10-16T10:00:00.000Z');
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('reading events in order', () => {
  it('hands each event over once, in order, and remembers where it got to', async () => {
    await emit('PolicyBound', 1);
    await emit('PolicyIssued', 2);
    const seen: number[] = [];
    const first = await consumeEvents(db, { consumer: 'test', handle: async (e) => void seen.push(e.payload.n as number), now: T0 });
    expect(first).toEqual({ handled: 2, deadLettered: [], blockedOn: null });
    const second = await consumeEvents(db, { consumer: 'test', handle: async (e) => void seen.push(e.payload.n as number), now: T0 });
    expect(second.handled).toBe(0);
    expect(seen).toEqual([1, 2]);

    await emit('PolicyChanged', 3);
    await consumeEvents(db, { consumer: 'test', handle: async (e) => void seen.push(e.payload.n as number), now: T0 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('gives every consumer its own place in the outbox', async () => {
    await emit('PolicyBound', 1);
    const a: number[] = [];
    const b: number[] = [];
    await consumeEvents(db, { consumer: 'a', handle: async (e) => void a.push(e.id), now: T0 });
    await consumeEvents(db, { consumer: 'b', handle: async (e) => void b.push(e.id), now: T0 });
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it('reads at most the limit at a time', async () => {
    for (let n = 1; n <= 5; n++) await emit('PolicyBound', n);
    const result = await consumeEvents(db, { consumer: 'test', handle: async () => undefined, limit: 2, now: T0 });
    expect(result.handled).toBe(2);
  });
});

describe('retries', () => {
  it('stops at a failing event, waits, and tries again later; nothing behind it is handled out of order', async () => {
    await emit('PolicyBound', 1);
    await emit('PolicyIssued', 2);
    let failures = 1;
    const seen: number[] = [];
    const handle = async (e: { payload: Record<string, unknown> }) => {
      if (e.payload.n === 1 && failures-- > 0) throw new Error('billing database is down');
      seen.push(e.payload.n as number);
    };

    const first = await consumeEvents(db, { consumer: 'test', handle, backoffSeconds: 30, now: T0 });
    expect(first.handled).toBe(0);
    expect(first.blockedOn).toMatchObject({ attempts: 1, retryAt: later(30).toISOString() });
    expect(seen).toEqual([]);

    // Too early: the handler is not even called.
    let called = false;
    const early = await consumeEvents(db, { consumer: 'test', handle: async () => void (called = true), now: later(10) });
    expect(called).toBe(false);
    expect(early.blockedOn).toMatchObject({ attempts: 1 });

    // After the wait it works, and the event behind it follows.
    const after = await consumeEvents(db, { consumer: 'test', handle, now: later(31) });
    expect(after).toEqual({ handled: 2, deadLettered: [], blockedOn: null });
    expect(seen).toEqual([1, 2]);
    expect(await listDeadEvents(db)).toEqual([]);
  });

  it('waits longer after each failure (30, 60, 120 seconds)', async () => {
    await emit('PolicyBound', 1);
    const handle = async () => Promise.reject(new Error('still down'));
    const one = await consumeEvents(db, { consumer: 'test', handle, backoffSeconds: 30, maxAttempts: 5, now: T0 });
    const two = await consumeEvents(db, { consumer: 'test', handle, backoffSeconds: 30, maxAttempts: 5, now: later(30) });
    const three = await consumeEvents(db, { consumer: 'test', handle, backoffSeconds: 30, maxAttempts: 5, now: later(90) });
    expect(one.blockedOn?.retryAt).toBe(later(30).toISOString());
    expect(two.blockedOn).toMatchObject({ attempts: 2, retryAt: later(30 + 60).toISOString() });
    expect(three.blockedOn).toMatchObject({ attempts: 3, retryAt: later(90 + 120).toISOString() });
  });
});

describe('the dead-letter list', () => {
  it('moves an event that keeps failing to the dead-letter list and carries on with the events behind it', async () => {
    await emit('PolicyBound', 1);
    await emit('PolicyIssued', 2);
    const seen: number[] = [];
    const handle = async (e: { payload: Record<string, unknown> }) => {
      if (e.payload.n === 1) throw new Error('cannot understand this event');
      seen.push(e.payload.n as number);
    };
    let clock = 0;
    let result = await consumeEvents(db, { consumer: 'test', handle, maxAttempts: 3, backoffSeconds: 10, now: later(clock) });
    while (result.blockedOn !== null) {
      clock += 1000; // always past the wait
      result = await consumeEvents(db, { consumer: 'test', handle, maxAttempts: 3, backoffSeconds: 10, now: later(clock) });
    }
    expect(result.deadLettered).toHaveLength(1);
    expect(seen).toEqual([2]);

    const dead = await listDeadEvents(db);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ consumer: 'test', attempts: 3, lastError: 'cannot understand this event', eventType: 'PolicyBound' });
    expect((await listAuditEntries(db, { action: 'event.dead_letter' })).length).toBe(1);

    // Later runs do not come back to it.
    expect((await consumeEvents(db, { consumer: 'test', handle, now: later(clock + 5000) })).handled).toBe(0);
  });

  it('dead-letters at once an event that can never work (a permanent error), without waiting', async () => {
    await emit('PolicyBound', 1);
    const result = await consumeEvents(db, { consumer: 'test', handle: async () => Promise.reject(new PermanentEventError('the payload is invalid')), now: T0 });
    expect(result.deadLettered).toHaveLength(1);
    expect(result.blockedOn).toBeNull();
    expect((await listDeadEvents(db))[0]).toMatchObject({ attempts: 1, lastError: 'the payload is invalid' });
  });

  it('can be redriven once the cause is fixed: the handler runs for that event, and it is marked resolved with who did it', async () => {
    await emit('PolicyBound', 1);
    await consumeEvents(db, { consumer: 'test', handle: async () => Promise.reject(new PermanentEventError('bad')), now: T0 });
    const [dead] = await listDeadEvents(db);

    // Still broken: it stays on the list, with the new error.
    const failed = await redriveDeadEvent(db, { consumer: 'test', eventId: dead!.eventId, handle: async () => Promise.reject(new Error('still bad')) }, 'root.admin');
    expect(failed).toEqual({ ok: false, error: 'still bad' });
    expect((await listDeadEvents(db))[0]).toMatchObject({ lastError: 'still bad' });

    const handled: number[] = [];
    const fixed = await redriveDeadEvent(db, { consumer: 'test', eventId: dead!.eventId, handle: async (e) => void handled.push(e.id) }, 'root.admin');
    expect(fixed).toEqual({ ok: true });
    expect(handled).toEqual([dead!.eventId]);
    expect(await listDeadEvents(db)).toEqual([]);
    const audit = await listAuditEntries(db, { action: 'event.redrive' });
    expect(audit.map((a) => a.actor)).toEqual(['root.admin']);
  });

  it('refuses to redrive an event that is not on the dead-letter list', async () => {
    await emit('PolicyBound', 1);
    await expect(redriveDeadEvent(db, { consumer: 'test', eventId: 1, handle: async () => undefined }, 'root.admin')).rejects.toThrow(/dead-letter/);
  });
});
