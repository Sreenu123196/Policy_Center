import type { Database } from './database.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { listEventsAfter, listUnpublishedEvents, markPublished, recordEvent } from './outbox.js';

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

describe('the outbox (document section 17)', () => {
  it('stores events in order, and lists the ones not published yet', async () => {
    await db.transaction(async (tx) => {
      await recordEvent(tx, { type: 'PolicyBound', aggregateType: 'policy', aggregateId: ID, payload: { version: 1 } });
      await recordEvent(tx, { type: 'PolicyIssued', aggregateType: 'policy', aggregateId: ID, payload: { version: 1 } });
    });
    const events = await listUnpublishedEvents(db);
    expect(events.map((e) => e.type)).toEqual(['PolicyBound', 'PolicyIssued']);
    expect(events[0]).toMatchObject({ aggregateType: 'policy', aggregateId: ID, payload: { version: 1 }, publishedAt: null });
    expect(events[1]!.id).toBeGreaterThan(events[0]!.id);
  });

  it('is saved with the change or not at all: a rolled-back transaction leaves no event', async () => {
    await db
      .transaction(async (tx) => {
        await recordEvent(tx, { type: 'PolicyBound', aggregateType: 'policy', aggregateId: ID, payload: {} });
        throw new Error('the change failed');
      })
      .catch(() => undefined);
    expect(await listUnpublishedEvents(db)).toEqual([]);
  });

  it('marks events as published, so a consumer does not get them twice', async () => {
    await recordEvent(db, { type: 'PolicyBound', aggregateType: 'policy', aggregateId: ID, payload: {} });
    const [event] = await listUnpublishedEvents(db);
    await markPublished(db, [event!.id]);
    expect(await listUnpublishedEvents(db)).toEqual([]);
    await markPublished(db, [event!.id]); // doing it twice is harmless
  });

  it('refuses an event type that is not written like PolicyBound', async () => {
    await expect(recordEvent(db, { type: 'bad type', aggregateType: 'policy', aggregateId: ID, payload: {} })).rejects.toThrow(/event type/i);
  });

  it('lets a consumer read on from its own offset, whether or not the events were published', async () => {
    for (const type of ['PolicyBound', 'PolicyIssued', 'PolicyRenewed']) await recordEvent(db, { type, aggregateType: 'policy', aggregateId: ID, payload: {} });
    const all = await listEventsAfter(db, 0, 100);
    expect(all.map((e) => e.type)).toEqual(['PolicyBound', 'PolicyIssued', 'PolicyRenewed']);
    await markPublished(db, [all[0]!.id]);
    expect((await listEventsAfter(db, 0, 100)).map((e) => e.type)).toHaveLength(3); // published events are still readable
    expect((await listEventsAfter(db, all[1]!.id, 100)).map((e) => e.type)).toEqual(['PolicyRenewed']);
    expect(await listEventsAfter(db, all[2]!.id, 100)).toEqual([]);
    expect((await listEventsAfter(db, 0, 2)).map((e) => e.type)).toEqual(['PolicyBound', 'PolicyIssued']);
  });
});
