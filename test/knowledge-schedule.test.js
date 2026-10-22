'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { delayUntil, startNightlyDrift } = require('../src/knowledge/schedule');

// The timer's only interesting logic is when it fires next. A wrong calculation means the job runs twice a day or not
// at all, and neither shows up until someone looks at the logs a week later.

test('before the hour, it waits until today', () => {
  const now = new Date('2026-10-22T01:00:00');
  assert.equal(delayUntil(now, 2, 0), 60 * 60 * 1000);
});

test('after the hour, it waits until tomorrow', () => {
  const now = new Date('2026-10-22T03:00:00');
  assert.equal(delayUntil(now, 2, 0), 23 * 60 * 60 * 1000);
});

test('exactly at the hour, it waits a full day rather than firing immediately', () => {
  const now = new Date('2026-10-22T02:00:00');
  assert.equal(delayUntil(now, 2, 0), 24 * 60 * 60 * 1000);
});

test('a custom hour and minute are respected', () => {
  const now = new Date('2026-10-22T23:30:00');
  assert.equal(delayUntil(now, 0, 15), 45 * 60 * 1000);
});

test('starting and stopping returns a working stop function', () => {
  const stop = startNightlyDrift({ run: async () => {}, hour: 2, minute: 0 });
  assert.equal(typeof stop, 'function');
  stop();
});
