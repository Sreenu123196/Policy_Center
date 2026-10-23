'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dueActions, POLICY } = require('../src/workflowTimers');

const NOW = new Date('2026-10-23T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

// An age becomes an action, once per stage. A timer that fires repeatedly trains people to ignore it.

test('a fresh approval is not due', () => {
  const due = dueActions({ now: NOW, items: [{ id: 'A1', kind: 'approval', status: 'pending', createdAt: hoursAgo(1) }] });
  assert.deepEqual(due, []);
});

test('an approval idle past the remind window is reminded', () => {
  const due = dueActions({ now: NOW, items: [{ id: 'A1', kind: 'approval', status: 'pending', createdAt: hoursAgo(3) }] });
  assert.equal(due.length, 1);
  assert.equal(due[0].action, 'remind');
  assert.equal(due[0].ageHours, 3);
});

test('an approval idle past the escalate window escalates instead of reminding', () => {
  const due = dueActions({ now: NOW, items: [{ id: 'A1', kind: 'approval', status: 'pending', createdAt: hoursAgo(7) }] });
  assert.equal(due[0].action, 'escalate', 'the later stage wins, not both');
});

test('a terminal item is never due', () => {
  const due = dueActions({ now: NOW, items: [
    { id: 'A1', kind: 'approval', status: 'approved', createdAt: hoursAgo(30) },
    { id: 'A2', kind: 'task', status: 'closed', createdAt: hoursAgo(30) },
  ] });
  assert.deepEqual(due, []);
});

test('the clock restarts from the last action, so a reminded item is not reminded again', () => {
  const due = dueActions({ now: NOW, items: [
    { id: 'A1', kind: 'approval', status: 'pending', createdAt: hoursAgo(10), lastActionAt: hoursAgo(1) },
  ] });
  assert.deepEqual(due, [], 'acted on an hour ago');
});

test('kinds have their own windows, and an unknown kind is ignored', () => {
  const due = dueActions({ now: NOW, items: [
    { id: 'T1', kind: 'task', status: 'open', createdAt: hoursAgo(9) },
    { id: 'X1', kind: 'mystery', status: 'open', createdAt: hoursAgo(99) },
  ] });
  assert.deepEqual(due.map((d) => d.id), ['T1']);
  assert.equal(due[0].action, 'remind');
  assert.deepEqual(Object.keys(POLICY).sort(), ['approval', 'referral', 'task']);
});
