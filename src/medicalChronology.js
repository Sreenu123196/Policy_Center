'use strict';
// B13: a medical chronology and the settlement packet a committee reads.
//
// Two rules make this worth having. Events are ordered by date and carry their source, because a chronology that cannot be checked is an opinion.
// And money is held in integer paise: floating rupees added a hundred times drift, and a settlement that is one paise off invites a dispute about
// the arithmetic instead of the claim.

const { AppError } = require('./appError');

const CATEGORIES = ['medical', 'lossOfIncome', 'transportation', 'miscellaneous'];

function toPaise(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new AppError(422, 'amounts must be non-negative numbers');
  const paise = Math.round(number * 100);
  if (Math.abs(paise / 100 - number) > 1e-9) throw new AppError(422, 'amounts may carry at most two decimal places');
  return paise;
}

function buildChronology(events = []) {
  const dated = events.map((event, index) => {
    const at = Date.parse(event.date);
    if (!Number.isFinite(at)) throw new AppError(422, 'event ' + (index + 1) + ' has no readable date: ' + event.date);
    if (!event.description) throw new AppError(422, 'event ' + (index + 1) + ' has no description');
    return { date: new Date(at).toISOString().slice(0, 10), at, description: event.description, source: event.source || null, provider: event.provider || null };
  });
  dated.sort((a, b) => a.at - b.at);
  const first = dated.length ? dated[0].at : null;
  return dated.map((event) => ({
    date: event.date,
    daysFromFirst: first === null ? null : Math.round((event.at - first) / 86400000),
    description: event.description,
    source: event.source,
    provider: event.provider,
  }));
}

/** Totals per category, in paise, plus the sum. Unknown categories are refused rather than quietly added. */
function valueItems(items = []) {
  const totals = {};
  for (const category of CATEGORIES) totals[category] = 0;
  for (const [index, item] of items.entries()) {
    if (!CATEGORIES.includes(item.category)) throw new AppError(422, 'item ' + (index + 1) + ' has an unknown category: ' + item.category);
    totals[item.category] += toPaise(item.amount);
  }
  totals.total = CATEGORIES.reduce((sum, category) => sum + totals[category], 0);
  return totals;
}

/**
 * @param {{claimNumber: string, events?: Array, items?: Array, reserve?: number}} input
 */
function settlementPacket({ claimNumber, events = [], items = [], reserve } = {}) {
  if (!claimNumber) throw new AppError(422, 'a claim number is required');
  const chronology = buildChronology(events);
  const totals = valueItems(items);
  const reservePaise = reserve === undefined ? null : toPaise(reserve);
  return {
    claimNumber,
    chronology,
    totals,
    reservePaise,
    variancePaise: reservePaise === null ? null : totals.total - reservePaise,
    settledAt: null,
    note: reservePaise === null
      ? 'No reserve is recorded, so no variance can be shown.'
      : (totals.total > reservePaise ? 'The demand exceeds the reserve by ' + (totals.total - reservePaise) + ' paise.' : 'The demand is within the reserve.'),
  };
}

module.exports = { settlementPacket, buildChronology, valueItems, toPaise, CATEGORIES };
