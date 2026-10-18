import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../platform/index.js';
import { loadCancellationRules } from './cancellation-rules.js';
import { loadProductCatalogue } from './product-catalogue.js';
import { computeRefund } from './refund.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const catalogue = loadProductCatalogue(`${configFolder}products/`);
const catalogueRules = loadCancellationRules(`${configFolder}cancellation/`, catalogue);
const rules = catalogueRules.forVersion('MOTOR_PRIVATE_CAR', '2026.10')!;

// The golden risk of D4: premium 1,574,600 and GST 283,428 paise for the term 15-10-2026 to 15-10-2027 (365 days).
const policy = { premiumPaise: 1574600, taxPaise: 283428, periodStart: '2026-10-15', periodEnd: '2027-10-15' };
const refund = (effectiveDate: string, method: 'flat' | 'pro_rata' | 'short_rate') => computeRefund({ ...policy, effectiveDate, method, rules });

describe('loading cancellation rules (document section 8)', () => {
  it('loads the rules of each product version', () => {
    expect(rules.reasons.map((r) => r.code)).toEqual(['customer_request', 'vehicle_sold', 'non_payment', 'misrepresentation', 'issued_in_error']);
    expect(catalogueRules.forVersion('MOTOR_PRIVATE_CAR', '2099.01')).toBeNull();
  });

  describe('checks the file and reports every problem together', () => {
    const base = {
      product: 'MOTOR_PRIVATE_CAR',
      version: '2026.10',
      minimum_retained_paise: 100000,
      reinstatement_window_days: 30,
      short_rate: [{ up_to_days: 180, retained_bps: 5000 }, { up_to_days: 366, retained_bps: 10000 }],
      reasons: [{ code: 'customer_request', source: 'insured', methods: ['short_rate'], notice_days: 0 }],
    };
    const load = (file: unknown, name = 'motor_private_car-2026.10.json') => {
      const folder = mkdtempSync(join(tmpdir(), 'cancel-'));
      writeFileSync(join(folder, name), JSON.stringify(file));
      return () => loadCancellationRules(folder, catalogue);
    };
    const problems = (run: () => unknown): string[] => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        return (error as ValidationError).errors;
      }
      throw new Error('expected the rules to be refused');
    };

    it('accepts a small valid file', () => {
      expect(load(base)()).toBeDefined();
    });

    it('refuses a short-rate table that is not in order, does not reach a full term, or retains less as time goes on', () => {
      const unordered = { ...base, short_rate: [{ up_to_days: 200, retained_bps: 5000 }, { up_to_days: 100, retained_bps: 6000 }, { up_to_days: 366, retained_bps: 10000 }] };
      expect(problems(load(unordered))).toEqual(expect.arrayContaining([expect.stringMatching(/short_rate.*increasing/i)]));
      const short = { ...base, short_rate: [{ up_to_days: 180, retained_bps: 5000 }] };
      expect(problems(load(short))).toEqual(expect.arrayContaining([expect.stringMatching(/short_rate.*366/)]));
      const falling = { ...base, short_rate: [{ up_to_days: 100, retained_bps: 6000 }, { up_to_days: 366, retained_bps: 5000 }] };
      expect(problems(load(falling))).toEqual(expect.arrayContaining([expect.stringMatching(/short_rate.*retain/i)]));
    });

    it('refuses a repeated reason, a reason with no method, and a wrong file name', () => {
      const twice = { ...base, reasons: [...base.reasons, ...base.reasons] };
      expect(problems(load(twice))).toEqual(expect.arrayContaining([expect.stringMatching(/customer_request.*more than once/)]));
      const none = { ...base, reasons: [{ code: 'customer_request', source: 'insured', methods: [], notice_days: 0 }] };
      expect(problems(load(none))).toEqual(expect.arrayContaining([expect.stringMatching(/method/i)]));
      expect(problems(load(base, 'cancel.json'))).toEqual([expect.stringMatching(/should be named motor_private_car-2026.10.json/)]);
    });
  });
});

describe('refund methods: golden amounts in paise (document section 8)', () => {
  it('flat cancellation (from the first day) refunds everything, tax included', () => {
    expect(refund('2026-10-15', 'flat')).toMatchObject({ refundPremiumPaise: 1574600, refundTaxPaise: 283428, retainedPremiumPaise: 0, daysInForce: 0, unexpiredDays: 365 });
  });

  it('flat is only possible from the first day of the period', () => {
    expect(() => refund('2026-10-16', 'flat')).toThrow(/flat.*first day/i);
  });

  it('pro rata refunds the unexpired days of the term: premium x 287 / 365 after 78 days', () => {
    // 1,574,600 x 287 / 365 = 1,238,110 ; tax 283,428 x 1,238,110 / 1,574,600 = 222,860
    expect(refund('2027-01-01', 'pro_rata')).toMatchObject({
      refundPremiumPaise: 1238110,
      refundTaxPaise: 222860,
      retainedPremiumPaise: 336490,
      daysInForce: 78,
      unexpiredDays: 287,
      termDays: 365,
    });
  });

  it('short rate keeps more: after 78 days the table retains 40%, so 60% comes back', () => {
    // retained 1,574,600 x 40% = 629,840 ; refund 944,760 ; tax refund 283,428 x 944,760 / 1,574,600 = 170,057
    expect(refund('2027-01-01', 'short_rate')).toMatchObject({ refundPremiumPaise: 944760, refundTaxPaise: 170057, retainedPremiumPaise: 629840 });
  });

  it('uses the right row of the short-rate table on its edge days: 30 days is the first row, 31 days the second', () => {
    expect(refund('2026-11-14', 'short_rate').retainedPremiumPaise).toBe(Math.round(1574600 * 0.2)); // 30 days in force
    expect(refund('2026-11-15', 'short_rate').retainedPremiumPaise).toBe(Math.round(1574600 * 0.3)); // 31 days in force
  });

  it('keeps the minimum retained premium of the product when the pro rata part kept is smaller', () => {
    // 3 days in force: pro rata would keep 12,942, but the product keeps at least 100,000.
    const result = refund('2026-10-18', 'pro_rata');
    expect(result).toMatchObject({ refundPremiumPaise: 1474600, retainedPremiumPaise: 100000, refundTaxPaise: 265428 });
    expect(result.worksheet.some((l) => /minimum retained/i.test(l.step))).toBe(true);
  });

  it('never keeps more than the premium, and a refund plus the part kept always make the premium', () => {
    const cheap = computeRefund({ premiumPaise: 50000, taxPaise: 9000, periodStart: '2026-10-15', periodEnd: '2027-10-15', effectiveDate: '2026-10-20', method: 'pro_rata', rules });
    expect(cheap.refundPremiumPaise).toBe(0);
    expect(cheap.retainedPremiumPaise).toBe(50000);
    for (const day of ['2026-10-16', '2027-01-01', '2027-06-30', '2027-10-14']) {
      const r = refund(day, 'short_rate');
      expect(r.refundPremiumPaise + r.retainedPremiumPaise).toBe(1574600);
    }
  });

  it('explains itself in a worksheet: days, method, table row and each amount', () => {
    const lines = refund('2027-01-01', 'short_rate').worksheet.map((l) => l.step);
    expect(lines).toEqual(expect.arrayContaining(['days in force', 'short-rate row', 'refund premium', 'refund tax']));
  });

  it('refuses a date outside the period', () => {
    expect(() => refund('2027-10-15', 'pro_rata')).toThrow(/inside the policy period/i);
    expect(() => refund('2026-10-14', 'pro_rata')).toThrow(/inside the policy period/i);
  });
});
