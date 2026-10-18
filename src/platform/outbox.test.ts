import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { listUnpublishedEvents, markPublished, recordEvent } from './outbox.js';

let db: PGlite;

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
});
