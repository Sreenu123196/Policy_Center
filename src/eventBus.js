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
const BATCH_SIZE = 100; // events handled in one unit of work when all is well
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
    const names = [...this.consumers.keys()];
    const waiting = names.filter((name) => (this.db.eventConsumers[name] || 0) < this.db.events.length);
    if (waiting.length === 0) return names.map((name) => ({ consumer: name, handled: 0, deadLettered: [], blockedOn: null }));
    // The fast path: when nothing is held back, ALL consumers catch up in one unit of work (one copy and one save of the data for
    // the whole run, not one per consumer). If any handler fails, everything is undone and each consumer runs on its own below,
    // where a failure is retried, waited for and dead-lettered as before.
    const clear = waiting.every((name) => {
      const offset = this.db.eventConsumers[name] || 0;
      return this.db.events.slice(offset, offset + limit).every((e) => !this.failureFor(name, e.eventId, ['retrying']));
    });
    if (clear) {
      const handled = {};
      let at = null; // the consumer and event being handled, so a failure is pinned on it without running its handler again
      try {
        this.pc.store.transaction(() => {
          for (const name of waiting) {
            const offset = this.db.eventConsumers[name] || 0;
            const count = Math.min(limit, this.db.events.length - offset);
            for (let k = 0; k < count; k++) {
              at = { name, offset: offset + k };
              this.deliver(name, this.consumers.get(name), offset + k, now);
            }
            handled[name] = count;
          }
        });
        return names.map((name) => ({ consumer: name, handled: handled[name] || 0, deadLettered: [], blockedOn: null }));
      } catch (error) {
        this.failedAt = at ? { ...at, error } : null;
        // fall through: one consumer at a time
      }
    }
    const failed = this.failedAt;
    this.failedAt = null;
    return names.map((name) => this.runConsumer(name, { now, limit, maxAttempts, backoffSeconds, known: failed && failed.name === name ? { offset: failed.offset, error: failed.error } : null }));
  }

  // Hands one event to a consumer and moves its place: what the handler writes and the move are saved together, or neither is.
  deliver(name, handle, index, now) {
    handle(JSON.parse(JSON.stringify(this.db.events[index])));
    this.db.eventConsumers[name] = index + 1;
    const current = this.db.events[index];
    current.deliveredTo = [...(current.deliveredTo || []), name];
    const failure = this.failureFor(name, current.eventId, ['retrying']);
    if (failure) Object.assign(failure, { status: 'resolved', resolvedBy: 'system', resolvedAt: now.toISOString() });
    this.refreshStatus(current.eventId);
  }

  runConsumer(name, { now, limit, maxAttempts, backoffSeconds, known: foundBefore = null }) {
    const handle = this.consumers.get(name);
    const result = { consumer: name, handled: 0, deadLettered: [], blockedOn: null };
    let steps = 0;
    let known = foundBefore; // an error already found for the event at this place: the handler is not run a second time

    while (steps < limit) {
      const offset = this.db.eventConsumers[name] || 0;
      const event = this.db.events[offset];
      if (!event) break;
      const waiting = this.failureFor(name, event.eventId, ['retrying']);
      if (waiting && Date.parse(waiting.nextAttemptAt) > now.getTime()) {
        result.blockedOn = { eventId: event.eventId, attempts: waiting.attempts, retryAt: waiting.nextAttemptAt };
        break;
      }

      // The fast path: a run of events with nothing wrong goes through in ONE unit of work. Every unit of work copies and saves
      // all the data, so doing it per event made a backlog of thousands of events take minutes. If an event in the batch fails,
      // the whole batch is undone, the events before it are done again as a batch, and the failure is pinned on its own event.
      // (Up to an event already known to fail, if there is one.)
      const room = known && known.offset >= offset ? known.offset - offset : Infinity;
      const size = Math.min(BATCH_SIZE, limit - steps, this.db.events.length - offset, room);
      if (size > 1 && this.db.events.slice(offset, offset + size).every((e) => !this.failureFor(name, e.eventId, ['retrying']))) {
        let at = 0;
        try {
          this.pc.store.transaction(() => {
            for (at = 0; at < size; at++) this.deliver(name, handle, offset + at, now);
          });
          result.handled += size;
          steps += size;
          continue;
        } catch (error) {
          known = { offset: offset + at, error };
          if (at > 0) {
            try {
              this.pc.store.transaction(() => {
                for (let k = 0; k < at; k++) this.deliver(name, handle, offset + k, now);
              });
              result.handled += at;
              steps += at;
            } catch {
              known = null; // the events before it did not repeat cleanly: handle them one by one
            }
          }
          continue;
        }
      }

      steps++;
      try {
        if (known && known.offset === offset) {
          const error = known.error;
          known = null;
          throw error;
        }
        this.pc.store.transaction(() => this.deliver(name, handle, offset, now));
        result.handled++;
      } catch (error) {
        const attempts = (waiting ? waiting.attempts : 0) + 1;
        const giveUp = error instanceof PermanentEventError || attempts >= maxAttempts;
        const retryAt = new Date(now.getTime() + backoffSeconds * 2 ** (attempts - 1) * 1000).toISOString();
        this.pc.store.transaction(() => {
          const knownFailure = this.failureFor(name, event.eventId, ['retrying']);
          const failure = knownFailure || { id: this.pc.store.id('evf'), consumer: name, eventId: event.eventId, firstFailedAt: now.toISOString() };
          Object.assign(failure, { attempts, lastError: describe(error), lastFailedAt: now.toISOString(), status: giveUp ? 'dead' : 'retrying', nextAttemptAt: giveUp ? null : retryAt });
          if (!knownFailure) this.db.eventFailures.push(failure);
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
