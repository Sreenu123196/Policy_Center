import { addDays } from '../platform/index.js';
import type { PaymentPlan } from './config.js';

// Splits a charge into payments by the payment plan (document section 14): a down payment on the first date and equal
// instalments after it, with the rounding left over put into the last one. Premium and tax are split in proportion, so
// every item shows its own tax (a tax invoice must). The instalment fee is added on top of every payment after the
// first. All amounts are whole paise.

export interface ScheduleItem {
  sequence: number; // 1 is the down payment
  dueDate: string;
  premiumPaise: number;
  taxPaise: number;
  feePaise: number;
  amountPaise: number; // premium + tax + fee
}

export function splitCharge(charge: { premiumPaise: number; taxPaise: number }, plan: PaymentPlan, firstDueDate: string): ScheduleItem[] {
  const { premiumPaise, taxPaise } = charge;
  if (!Number.isInteger(premiumPaise) || !Number.isInteger(taxPaise)) throw new Error('A charge must be in whole paise');
  if (premiumPaise < 0 || taxPaise < 0 || premiumPaise + taxPaise === 0) throw new Error('A charge to split must be a positive amount');

  const total = premiumPaise + taxPaise;
  const down = Math.round((total * plan.down_payment_bps) / 10000);
  const rest = total - down;
  const each = plan.installments === 0 ? 0 : Math.floor(rest / plan.installments);
  const bases = [down, ...Array.from({ length: plan.installments }, (_, i) => (i === plan.installments - 1 ? rest - each * (plan.installments - 1) : each))];

  // The premium share of each item comes from running totals, so the shares add up to the premium exactly and never go negative.
  let before = 0;
  let premiumBefore = 0;
  return bases.map((base, index) => {
    before += base;
    const premiumUpTo = Math.round((premiumPaise * before) / total);
    const premiumShare = premiumUpTo - premiumBefore;
    premiumBefore = premiumUpTo;
    const fee = index === 0 ? 0 : plan.installment_fee_paise;
    return {
      sequence: index + 1,
      dueDate: index === 0 ? firstDueDate : addDays(firstDueDate, index * plan.interval_days),
      premiumPaise: premiumShare,
      taxPaise: base - premiumShare,
      feePaise: fee,
      amountPaise: base + fee,
    };
  });
}
