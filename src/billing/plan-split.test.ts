import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../platform/index.js';
import { loadBillingConfig } from './config.js';
import { splitCharge } from './plan-split.js';

const configFolder = fileURLToPath(new URL('../../config/billing/', import.meta.url));
const config = loadBillingConfig(configFolder);
const plan = (code: string) => config.forDate('2026-10-16').plans.find((p) => p.code === code)!;

describe('loading the billing configuration (document section 14)', () => {
  it('loads the payment plans, with the default plan', () => {
    const current = config.forDate('2026-10-16');
    expect(current.default_plan).toBe('FULL_PAY');
    expect(current.plans.map((p) => p.code)).toEqual(['FULL_PAY', 'TWO_PAY', 'QUARTERLY', 'MONTHLY']);
  });

  it('is not in force before its start date', () => {
    expect(() => config.forDate('2026-03-31')).toThrow(/no billing configuration/i);
  });

  describe('checks the file and reports every problem together', () => {
    const names = { en: 'Plan', hi: 'योजना', te: 'ప్లాన్' };
    const full = { code: 'FULL_PAY', names, down_payment_bps: 10000, installments: 0, interval_days: 0, installment_fee_paise: 0, invoice_lead_days: 15, grace_days: 10 };
    const delinquency = [{ action: 'reminder', days_after_grace: 0 }, { action: 'cancellation_request', days_after_grace: 20 }];
    const base = { version: '2026.04', effective_from: '2026-04-01', default_plan: 'FULL_PAY', plans: [full], delinquency };
    const load = (file: unknown, name = 'billing-2026.04.json') => {
      const folder = mkdtempSync(join(tmpdir(), 'billing-'));
      writeFileSync(join(folder, name), JSON.stringify(file));
      return () => loadBillingConfig(folder);
    };
    const problems = (run: () => unknown): string[] => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        return (error as ValidationError).errors;
      }
      throw new Error('expected the configuration to be refused');
    };

    it('accepts a small valid file', () => {
      expect(load(base)()).toBeDefined();
    });

    it('refuses a default plan that does not exist, a repeated plan, and a wrong file name', () => {
      expect(problems(load({ ...base, default_plan: 'NOPE' }))).toEqual([expect.stringMatching(/default plan NOPE/)]);
      expect(problems(load({ ...base, plans: [full, full] }))).toEqual([expect.stringMatching(/FULL_PAY.*more than once/)]);
      expect(problems(load(base, 'billing.json'))).toEqual([expect.stringMatching(/should be named billing-2026.04.json/)]);
    });

    it('refuses plans whose parts do not fit: a down payment of 100% with instalments, instalments with no interval, a missing language', () => {
      const bad = {
        ...base,
        plans: [
          { ...full, code: 'BAD_ONE', installments: 2, interval_days: 30 },
          { ...full, code: 'BAD_TWO', down_payment_bps: 5000, installments: 2, interval_days: 0 },
        ],
      };
      expect(problems(load(bad))).toEqual(expect.arrayContaining([expect.stringMatching(/BAD_ONE.*100%.*instalments/i), expect.stringMatching(/BAD_TWO.*interval/i)]));
    });

    it('refuses delinquency steps that are out of order, repeated, or do not end with a cancellation request', () => {
      const outOfOrder = { ...base, delinquency: [{ action: 'final_notice', days_after_grace: 10 }, { action: 'reminder', days_after_grace: 0 }, { action: 'cancellation_request', days_after_grace: 20 }] };
      expect(problems(load(outOfOrder))).toEqual([expect.stringMatching(/in order of days_after_grace/)]);
      const repeated = { ...base, delinquency: [{ action: 'reminder', days_after_grace: 0 }, { action: 'reminder', days_after_grace: 5 }, { action: 'cancellation_request', days_after_grace: 20 }] };
      expect(problems(load(repeated))).toEqual([expect.stringMatching(/reminder is used more than once/)]);
      const noEnd = { ...base, delinquency: [{ action: 'reminder', days_after_grace: 0 }] };
      expect(problems(load(noEnd))).toEqual([expect.stringMatching(/last delinquency step must be cancellation_request/)]);
    });

    it('refuses a plan name that is missing in one of the three languages', () => {
      const bad = { ...base, plans: [{ ...full, names: { en: 'x', hi: '', te: 'y' } }] };
      expect(problems(load(bad))).toEqual([expect.stringMatching(/Hindi name is required/)]);
    });
  });
});

describe('splitting a charge by the payment plan (document section 14)', () => {
  // The golden policy: premium 1,574,600 and GST 283,428 paise, 1,858,028 in all.
  const charge = { premiumPaise: 1574600, taxPaise: 283428 };

  it('full pay is one item for everything, due on the effective date', () => {
    expect(splitCharge(charge, plan('FULL_PAY'), '2026-10-15')).toEqual([
      { sequence: 1, dueDate: '2026-10-15', premiumPaise: 1574600, taxPaise: 283428, feePaise: 0, amountPaise: 1858028 },
    ]);
  });

  it('two-pay takes half as a down payment and the rest 180 days later', () => {
    const items = splitCharge(charge, plan('TWO_PAY'), '2026-10-15');
    expect(items.map((i) => [i.sequence, i.dueDate, i.amountPaise])).toEqual([[1, '2026-10-15', 929014], [2, '2027-04-13', 929014]]);
  });

  it('quarterly takes 25% down and three instalments 90 days apart, each with the instalment fee', () => {
    const items = splitCharge(charge, plan('QUARTERLY'), '2026-10-15');
    expect(items.map((i) => [i.sequence, i.dueDate, i.feePaise, i.amountPaise])).toEqual([
      [1, '2026-10-15', 0, 464507],
      [2, '2027-01-13', 5000, 469507],
      [3, '2027-04-13', 5000, 469507],
      [4, '2027-07-12', 5000, 469507],
    ]);
  });

  it('puts the rounding left over into the last instalment, so the items always add up exactly', () => {
    // Monthly: 10% down = 185,803 ; the other 1,672,225 in ten parts of 167,222 with 5 left for the last.
    const items = splitCharge(charge, plan('MONTHLY'), '2026-10-15');
    expect(items).toHaveLength(11);
    expect(items[0]?.amountPaise).toBe(185803);
    expect((items[1]?.amountPaise ?? 0) - (items[1]?.feePaise ?? 0)).toBe(167222);
    expect(items.at(-1)?.amountPaise).toBe(167227 + 5000);
    const withoutFees = items.reduce((sum, i) => sum + i.amountPaise - i.feePaise, 0);
    expect(withoutFees).toBe(1858028);
  });

  it('splits premium and tax in proportion, and each item adds up: premium parts add to the premium, tax parts to the tax', () => {
    for (const code of ['TWO_PAY', 'QUARTERLY', 'MONTHLY']) {
      const items = splitCharge(charge, plan(code), '2026-10-15');
      expect(items.reduce((s, i) => s + i.premiumPaise, 0)).toBe(1574600);
      expect(items.reduce((s, i) => s + i.taxPaise, 0)).toBe(283428);
      for (const item of items) expect(item.amountPaise).toBe(item.premiumPaise + item.taxPaise + item.feePaise);
    }
  });

  it('survives awkward amounts: tiny charges, and a charge that does not divide', () => {
    const tiny = splitCharge({ premiumPaise: 7, taxPaise: 1 }, plan('QUARTERLY'), '2026-10-15');
    expect(tiny.reduce((s, i) => s + i.premiumPaise + i.taxPaise, 0)).toBe(8);
    expect(tiny.every((i) => i.premiumPaise >= 0 && i.taxPaise >= 0)).toBe(true);
    const odd = splitCharge({ premiumPaise: 1000003, taxPaise: 180001 }, plan('MONTHLY'), '2026-10-15');
    expect(odd.reduce((s, i) => s + i.premiumPaise + i.taxPaise, 0)).toBe(1180004);
  });

  it('refuses a charge that is not a positive whole amount', () => {
    expect(() => splitCharge({ premiumPaise: -1, taxPaise: 0 }, plan('FULL_PAY'), '2026-10-15')).toThrow(/positive/i);
    expect(() => splitCharge({ premiumPaise: 1.5, taxPaise: 0 }, plan('FULL_PAY'), '2026-10-15')).toThrow(/whole/i);
  });
});
