import { daysBetween } from '../platform/index.js';
import type { QuoteResult, WorksheetLine } from './quote.js';

// Rating by slices (document sections 6 and 9). The period is cut at every date where anything changes. Each slice is
// priced as if its cover lasted a whole year, then prorated by its days: slice days / days in the term.

export interface PricedSlice {
  from: string; // yyyy-mm-dd, included
  to: string; // excluded
  result: QuoteResult; // the price of this slice's cover for a whole term
}

// The dates that cut a period into slices: its start and end, and every date inside it where a row begins or ends.
export function cutDates(periodStart: string, periodEnd: string, rowDates: string[]): string[] {
  const dates = new Set([periodStart, periodEnd, ...rowDates.filter((d) => d > periodStart && d < periodEnd)]);
  return [...dates].sort();
}

// Adds the slices up. Costs are prorated one by one and rounded to a paise, so they add up to the premium exactly.
// One slice covering the whole term is returned as it is, so an ordinary quote is untouched.
export function combineSlices(slices: PricedSlice[], periodStart: string, periodEnd: string): QuoteResult {
  const first = slices[0];
  if (first === undefined) throw new Error('There is nothing to combine');
  if (slices.length === 1) return first.result;

  const termDays = daysBetween(periodStart, periodEnd);
  const prorate = (amount: number, days: number): number => Math.round((amount * days) / termDays);

  const costs = new Map<string, number>();
  let tax = 0;
  let sliceTotals = 0;
  const sliceLines: WorksheetLine[] = [];
  for (const slice of slices) {
    const days = daysBetween(slice.from, slice.to);
    const sliceTotal = prorate(slice.result.premiumPaise, days);
    sliceTotals += sliceTotal;
    tax += prorate(slice.result.taxPaise, days);
    sliceLines.push({ step: `slice ${slice.from} to ${slice.to}`, note: `${days} of ${termDays} days at the whole-term premium ${slice.result.premiumPaise}`, amountPaise: sliceTotal });
    for (const line of slice.result.worksheet) {
      if (line.step.startsWith('cost ') && line.amountPaise !== undefined) costs.set(line.step, (costs.get(line.step) ?? 0) + prorate(line.amountPaise, days));
    }
  }
  const costLines: WorksheetLine[] = [...costs].map(([step, amountPaise]) => ({ step, note: 'prorated over the slices', amountPaise }));
  const premiumPaise = costs.size > 0 ? [...costs.values()].reduce((a, b) => a + b, 0) : sliceTotals;
  return {
    premiumPaise,
    taxPaise: tax,
    rateBook: first.result.rateBook,
    worksheet: [{ step: 'rate book', note: first.result.rateBook }, ...sliceLines, ...costLines, { step: 'Tax', note: 'prorated over the slices', amountPaise: tax }],
  };
}
