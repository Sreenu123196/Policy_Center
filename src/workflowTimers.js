'use strict';
// Workflow timers.
//
// A task that nobody acts on is a decision not to act. These rules turn an age into an action: a pending item is reminded
// after a few hours and escalated to its manager after a few more. Nothing fires twice for the same stage, because the item
// records when it was last acted on - a timer that repeats is worse than no timer, it trains people to ignore it.

const HOUR = 3600 * 1000;

const POLICY = {
  'approval': { remindAfterHours: 2, escalateAfterHours: 6 },
  'task': { remindAfterHours: 8, escalateAfterHours: 24 },
  'referral': { remindAfterHours: 4, escalateAfterHours: 12 },
};

const TERMINAL = ['approved', 'declined', 'closed', 'cancelled', 'bound', 'done'];

/**
 * @param {object} input
 * @param {Date|number} input.now
 * @param {Array<{id: string, kind: string, status: string, createdAt: string, lastActionAt?: string|null}>} input.items
 * @returns {Array<{id: string, action: 'remind'|'escalate', ageHours: number, reason: string}>}
 */
function dueActions({ now, items = [], policy = POLICY }) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(at)) throw new Error('now is required');
  const due = [];
  for (const item of items) {
    if (TERMINAL.includes(String(item.status))) continue;
    const rule = policy[item.kind];
    if (!rule) continue;
    const since = Date.parse(item.lastActionAt || item.createdAt);
    if (!Number.isFinite(since)) continue;
    const ageHours = (at - since) / HOUR;
    if (ageHours >= rule.escalateAfterHours) {
      due.push({ id: item.id, action: 'escalate', ageHours: Math.round(ageHours * 10) / 10, reason: 'no action for ' + rule.escalateAfterHours + ' hours: escalate to the manager' });
    } else if (ageHours >= rule.remindAfterHours) {
      due.push({ id: item.id, action: 'remind', ageHours: Math.round(ageHours * 10) / 10, reason: 'no action for ' + rule.remindAfterHours + ' hours: remind the owner' });
    }
  }
  return due;
}

module.exports = { dueActions, POLICY, TERMINAL };
