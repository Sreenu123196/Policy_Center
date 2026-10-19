'use strict';
// Event consumers with retries and a dead-letter list. Ported from the Insurance Suite event consumer.
//
// pc.publish() writes an event to db.events in the same unit of work as the change that caused it. Each registered
// consumer then reads the events in order and keeps its place (db.eventConsumers[name] = how many it has handled).
//   - The place moves only after the handler worked, in the same unit of work as what the handler wrote, so a crash
//     means the event comes again, never that it is lost. Handlers must cope with seeing an event twice.
//   - A failing event is retried after a growing wait (30, 60, 120 ... seconds). It holds back the events behind it for
//     that consumer, which keeps them in order.
//   - After maxAttempts the event goes to the dead-letter list (status 'dead') and the consumer moves on, so one bad
//     event cannot stop everything behind it. A PermanentEventError goes there at once.
//   - A UW manager can redrive a dead event once the cause is fixed.
// Event status: Pending (not everyone has it), Retrying, Failed (dead-lettered), Delivered (every consumer has it).

const { AppError } = require('./policyCenter');

class PermanentEventError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentEventError';
  }
}

const MAX_ERROR_LENGTH = 500;
const describe = (error) => String(error && error.message ? error.message : error).slice(0, MAX_ERROR_LENGTH);

class EventBus {
  constructor(pc) {
    this.pc = pc;
    this.consumers = new Map(); // name -> handler(event)
  }

  register(name, handle) {
    this.consumers.set(name, handle);
  }

  get db() {
    return this.pc.db; // always read through the store: a rolled-back unit of work replaces the data object
  }

  failureFor(consumer, eventId, statuses) {
    return this.db.eventFailures.find((f) => f.consumer === consumer && f.eventId === eventId && statuses.includes(f.status));
  }

  // The status of an event follows from who has it and what has failed.
  refreshStatus(eventId) {
    const event = this.db.events.find((e) => e.eventId === eventId);
    if (!event) return;
    const failures = this.db.eventFailures.filter((f) => f.eventId === eventId);
    if (failures.some((f) => f.status === 'dead')) event.status = 'Failed';
    else if (failures.some((f) => f.status === 'retrying')) event.status = 'Retrying';
    else if ([...this.consumers.keys()].every((name) => (event.deliveredTo || []).includes(name))) event.status = 'Delivered';
    else event.status = 'Pending';
  }

  // Runs every consumer once over the events it has not handled. Returns one result per consumer.
  run({ now = new Date(), limit = 200, maxAttempts = 5, backoffSeconds = 30 } = {}) {
    return [...this.consumers.keys()].map((name) => this.runConsumer(name, { now, limit, maxAttempts, backoffSeconds }));
  }

  runConsumer(name, { now, limit, maxAttempts, backoffSeconds }) {
    const handle = this.consumers.get(name);
    const result = { consumer: name, handled: 0, deadLettered: [], blockedOn: null };
    let steps = 0;
    while (steps++ < limit) {
      const offset = this.db.eventConsumers[name] || 0;
      const event = this.db.events[offset];
      if (!event) break;
      const waiting = this.failureFor(name, event.eventId, ['retrying']);
      if (waiting && Date.parse(waiting.nextAttemptAt) > now.getTime()) {
        result.blockedOn = { eventId: event.eventId, attempts: waiting.attempts, retryAt: waiting.nextAttemptAt };
        break;
      }
      try {
        // What the handler writes and the move of the place are saved together, or neither is.
        this.pc.store.transaction(() => {
          handle(JSON.parse(JSON.stringify(this.db.events[offset])));
          this.db.eventConsumers[name] = offset + 1;
          const current = this.db.events[offset];
          current.deliveredTo = [...(current.deliveredTo || []), name];
          const failure = this.failureFor(name, current.eventId, ['retrying']);
          if (failure) Object.assign(failure, { status: 'resolved', resolvedBy: 'system', resolvedAt: now.toISOString() });
          this.refreshStatus(current.eventId);
        });
        result.handled++;
      } catch (error) {
        const attempts = (waiting ? waiting.attempts : 0) + 1;
        const giveUp = error instanceof PermanentEventError || attempts >= maxAttempts;
        const retryAt = new Date(now.getTime() + backoffSeconds * 2 ** (attempts - 1) * 1000).toISOString();
        this.pc.store.transaction(() => {
          const known = this.failureFor(name, event.eventId, ['retrying']);
          const failure = known || { id: this.pc.store.id('evf'), consumer: name, eventId: event.eventId, firstFailedAt: now.toISOString() };
          Object.assign(failure, { attempts, lastError: describe(error), lastFailedAt: now.toISOString(), status: giveUp ? 'dead' : 'retrying', nextAttemptAt: giveUp ? null : retryAt });
          if (!known) this.db.eventFailures.push(failure);
          if (giveUp) this.db.eventConsumers[name] = offset + 1;
          this.refreshStatus(event.eventId);
        });
        if (!giveUp) {
          result.blockedOn = { eventId: event.eventId, attempts, retryAt };
          break;
        }
        result.deadLettered.push(event.eventId);
      }
    }
    return result;
  }

  // The events given up on, oldest first. A person looks at these, fixes the cause, and redrives them.
  deadEvents() {
    return this.db.eventFailures
      .filter((f) => f.status === 'dead')
      .map((f) => ({ consumer: f.consumer, eventId: f.eventId, eventType: (this.db.events.find((e) => e.eventId === f.eventId) || {}).type, attempts: f.attempts, lastError: f.lastError, failedAt: f.lastFailedAt }));
  }

  // Runs the handler once more for a dead event, out of its original order (the consumer has moved on). If it works the
  // event is marked resolved with who did it; if not it stays on the list with the new error.
  redrive(user, { consumer, eventId }, { now = new Date() } = {}) {
    this.pc.requireAuthority(user, 2, 'redrive dead events');
    const failure = this.failureFor(consumer, eventId, ['dead']);
    const handle = this.consumers.get(consumer);
    const event = this.db.events.find((e) => e.eventId === eventId);
    if (!failure || !handle || !event) throw new AppError(404, `Event ${eventId} is not on the dead-letter list of ${consumer}`);
    try {
      this.pc.store.transaction(() => handle(JSON.parse(JSON.stringify(this.db.events.find((e) => e.eventId === eventId)))));
    } catch (error) {
      this.pc.store.transaction(() => Object.assign(this.failureFor(consumer, eventId, ['dead']), { lastError: describe(error), lastFailedAt: now.toISOString() }));
      return { ok: false, error: describe(error) };
    }
    this.pc.store.transaction(() => {
      Object.assign(this.failureFor(consumer, eventId, ['dead']), { status: 'resolved', resolvedBy: user.id, resolvedAt: now.toISOString() });
      const current = this.db.events.find((e) => e.eventId === eventId);
      current.deliveredTo = [...new Set([...(current.deliveredTo || []), consumer])];
      this.refreshStatus(eventId);
    });
    return { ok: true };
  }
}

module.exports = { EventBus, PermanentEventError };
