import { daysBetween, ValidationError } from '../platform/index.js';
import type { CancellationRules, RefundMethod } from './cancellation-rules.js';
import type { WorksheetLine } from './quote.js';

// Refund on cancellation (document section 8). A pure function, like rating: the same input gives the same refund.
//   flat       = everything comes back (only from the first day of the period)
//   pro rata   = term premium x unexpired days / days in the term
//   short rate = term premium x (1 - the share the table keeps for the days in force)
// The insurer never keeps less than the product's minimum retained premium (or the whole premium, if that is smaller).
// Tax is refunded in the same proportion as the premium. All amounts are whole paise.

export interface RefundInput {
  premiumPaise: number; // premium of the whole term
  taxPaise: number;
  periodStart: string;
  periodEnd: string; // exclusive
  effectiveDate: string; // the first day without cover
  method: RefundMethod;
  rules: CancellationRules;
}

export interface RefundResult {
  method: RefundMethod;
  termDays: number;
  daysInForce: number;
  unexpiredDays: number;
  refundPremiumPaise: number;
  refundTaxPaise: number;
  retainedPremiumPaise: number;
  worksheet: WorksheetLine[];
}

export function computeRefund(input: RefundInput): RefundResult {
  const { premiumPaise, taxPaise, periodStart, periodEnd, effectiveDate, method, rules } = input;
  if (effectiveDate < periodStart || effectiveDate >= periodEnd) throw new ValidationError([`The effective date must be inside the policy period (${periodStart} to ${periodEnd})`]);
  if (method === 'flat' && effectiveDate !== periodStart) throw new ValidationError(['A flat cancellation starts on the first day of the period']);

  const termDays = daysBetween(periodStart, periodEnd);
  const daysInForce = daysBetween(periodStart, effectiveDate);
  const unexpiredDays = termDays - daysInForce;
  const worksheet: WorksheetLine[] = [
    { step: 'days in force', note: `${daysInForce} of ${termDays} days; ${unexpiredDays} unexpired` },
    { step: 'term premium', note: `method ${method}`, amountPaise: premiumPaise },
  ];

  let retained: number;
  if (method === 'flat') retained = 0;
  else if (method === 'pro_rata') retained = premiumPaise - Math.round((premiumPaise * unexpiredDays) / termDays);
  else {
    const row = rules.short_rate.find((r) => daysInForce <= r.up_to_days) ?? rules.short_rate.at(-1);
    retained = Math.round((premiumPaise * (row?.retained_bps ?? 10000)) / 10000);
    worksheet.push({ step: 'short-rate row', note: `up to ${row?.up_to_days} days keeps ${(row?.retained_bps ?? 10000) / 100}%` });
  }

  const floor = Math.min(rules.minimum_retained_paise, premiumPaise);
  if (method !== 'flat' && retained < floor) {
    retained = floor;
    worksheet.push({ step: 'minimum retained premium', note: 'the insurer keeps at least this much', amountPaise: floor });
  }

  const refundPremiumPaise = premiumPaise - retained;
  const refundTaxPaise = premiumPaise === 0 ? 0 : Math.round((taxPaise * refundPremiumPaise) / premiumPaise);
  worksheet.push({ step: 'refund premium', note: 'term premium less the part kept', amountPaise: refundPremiumPaise });
  worksheet.push({ step: 'refund tax', note: 'tax in the same proportion as the premium', amountPaise: refundTaxPaise });
  return { method, termDays, daysInForce, unexpiredDays, refundPremiumPaise, refundTaxPaise, retainedPremiumPaise: retained, worksheet };
}
