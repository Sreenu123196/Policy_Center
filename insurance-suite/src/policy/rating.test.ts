import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../platform/index.js';
import type { BranchAsOf } from './policy.js';
import { loadProductCatalogue } from './product-catalogue.js';
import type { Selection } from './product-selection.js';
import type { QuoteRequest } from './quote.js';
import { loadRateBooks } from './rate-book.js';
import { createQuoter } from './rating.js';

const configFolder = fileURLToPath(new URL('../../config/', import.meta.url));
const catalogue = loadProductCatalogue(`${configFolder}products/`);
const rateBooks = loadRateBooks(`${configFolder}ratebooks/`, catalogue);
const quoter = createQuoter(rateBooks);
const PRODUCT = 'MOTOR_PRIVATE_CAR';

// A branch snapshot for rating: one vehicle and the chosen coverages. Ids are made up.
function request(options: { start?: string; engineCc?: number | undefined; ageYears?: number; claimFreeYears?: number; selection: Selection }): QuoteRequest {
  const start = options.start ?? '2026-10-15';
  const productVersion = catalogue.versionInForce(PRODUCT, start);
  if (!productVersion) throw new Error('test setup: no product version');
  const attributes: Record<string, unknown> = { make: 'Maruti', model: 'Swift', year: 2023 };
  if (options.engineCc !== undefined) attributes.engineCc = options.engineCc;
  if (options.claimFreeYears !== undefined) attributes.claimFreeYears = options.claimFreeYears;
  const branch: BranchAsOf = {
    branch: {
      id: 'b', policyId: 'p', jobId: 'j', termNumber: 1, label: 'Option A', version: null, basedOnId: null, status: 'draft',
      periodStart: start, periodEnd: '2027-10-15', productVersion: productVersion.version, cancelledOn: null, createdBy: 'u', createdAt: '2026-10-15T00:00:00.000Z',
    },
    date: start,
    coverables: [{ fixedId: 'v1', kind: 'Vehicle', effFrom: start, effTo: '2027-10-15', attributes }],
    coverages: [],
  };
  return { branch, productVersion, facts: { ownerType: 'individual', vehicle: { ageYears: options.ageYears ?? 3 } }, selection: options.selection };
}

const BASIC: Selection = { MOTOR_TP: {}, PA_OWNER_DRIVER: {}, MOTOR_OD: { idv: 50000000, vol_deductible: 0 } };

describe('loading rate books (document section 9)', () => {
  it('loads the real rate books and picks the one in force on the start date', () => {
    expect(rateBooks.forProduct(PRODUCT, '2026-10-15')?.rate_book).toBe('MPC-2026.10');
    expect(rateBooks.forProduct(PRODUCT, '2026-05-01')?.rate_book).toBe('MPC-2026.04');
    expect(rateBooks.forProduct(PRODUCT, '2026-03-01')).toBeNull();
    expect(rateBooks.forProduct('FLYING_CARPET', '2026-10-15')).toBeNull();
  });

  it('has a routine for every coverage of the product version it prices (nothing can be sold unpriced)', () => {
    for (const product of catalogue.products()) {
      for (const version of catalogue.versionsOf(product)) {
        const book = rateBooks.forProduct(product, version.effective_from);
        expect(book?.version, `${product} ${version.version}`).toBe(version.version);
        for (const coverage of version.line.coverages) expect(Object.keys(book?.routines ?? {}), `${coverage.code} in ${version.version}`).toContain(coverage.code);
      }
    }
  });

  it('only uses Active rate books for live quotes: a draft book is ignored', () => {
    const real = rateBooks.forProduct(PRODUCT, '2026-10-15');
    expect(real?.status).toBe('active');
  });

  describe('checks the files and reports every problem together', () => {
    const base = {
      product: PRODUCT, version: '2026.10', rate_book: 'X-1', effective_from: '2026-10-01', status: 'active', jurisdiction: 'IN',
      tax: { name: 'GST', rate_bps: 1800 }, constants: { FLAT: 1000 },
      tables: { TBL: { keys: ['engine_cc'], rows: [{ when: { engine_cc: { max: 1000 } }, value: 5 }] } },
      routines: { MOTOR_TP: { steps: [{ op: 'constant', name: 'FLAT', as: 'x' }], output: 'x' } },
    };
    const load = (book: unknown, fileName = 'motor_private_car-2026.10.json') => {
      const folder = mkdtempSync(join(tmpdir(), 'ratebooks-'));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, fileName), JSON.stringify(book));
      return () => loadRateBooks(folder, catalogue);
    };
    const problems = (run: () => unknown): string[] => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        return (error as ValidationError).errors;
      }
      throw new Error('expected the rate book to be refused');
    };

    it('accepts a small valid book', () => {
      expect(load(base)()).toBeDefined();
    });

    it('refuses a step that uses a name nothing has defined yet', () => {
      const book = { ...base, routines: { MOTOR_TP: { steps: [{ op: 'multiply_bps', value: 'nothing', rate: 'x', as: 'y' }], output: 'y' } } };
      expect(problems(load(book))).toEqual(expect.arrayContaining([expect.stringMatching(/MOTOR_TP.*nothing.*not defined/i)]));
    });

    it('refuses an unknown table, an unknown constant and a lookup whose keys do not match the table', () => {
      const unknownTable = { ...base, routines: { MOTOR_TP: { steps: [{ op: 'lookup', table: 'NOPE', by: ['engine_cc'], as: 'x' }], output: 'x' } } };
      expect(problems(load(unknownTable))).toEqual(expect.arrayContaining([expect.stringMatching(/table NOPE/i)]));

      const unknownConstant = { ...base, routines: { MOTOR_TP: { steps: [{ op: 'constant', name: 'MISSING', as: 'x' }], output: 'x' } } };
      expect(problems(load(unknownConstant))).toEqual(expect.arrayContaining([expect.stringMatching(/constant MISSING/i)]));

      const wrongKeys = {
        ...base,
        routines: { MOTOR_TP: { steps: [{ op: 'input', name: 'idv', as: 'idv' }, { op: 'lookup', table: 'TBL', by: ['idv'], as: 'x' }], output: 'x' } },
      };
      expect(problems(load(wrongKeys))).toEqual(expect.arrayContaining([expect.stringMatching(/TBL.*keys/i)]));
    });

    it('refuses an output that is never defined, a range with min above max, and a wrong file name', () => {
      const badOutput = { ...base, routines: { MOTOR_TP: { steps: [{ op: 'constant', name: 'FLAT', as: 'x' }], output: 'zzz' } } };
      expect(problems(load(badOutput))).toEqual(expect.arrayContaining([expect.stringMatching(/output zzz/i)]));

      const badRange = { ...base, tables: { TBL: { keys: ['engine_cc'], rows: [{ when: { engine_cc: { min: 2000, max: 1000 } }, value: 5 }] } } };
      expect(problems(load(badRange))).toEqual(expect.arrayContaining([expect.stringMatching(/min.*above.*max/i)]));

      expect(problems(load(base, 'wrong-name.json'))).toEqual([expect.stringMatching(/should be named motor_private_car-2026.10.json/)]);
    });

    it('refuses a rate book for a product version that does not exist', () => {
      expect(problems(load({ ...base, version: '2099.01' }, 'motor_private_car-2099.01.json'))).toEqual(
        expect.arrayContaining([expect.stringMatching(/2099.01.*not a version of MOTOR_PRIVATE_CAR/)]),
      );
    });
  });
});

// Golden tests: fixed risks with the exact expected price, worked out by hand from the rate book 2026.10.
// If a rate or a step changes, a golden test fails and someone must confirm the change on purpose.
describe('golden tests for rate book MPC-2026.10 (amounts in paise)', () => {
  it('golden 1: 1197 cc car, 3 years old, Rs 5,00,000 IDV, 2 claim-free years', () => {
    // own damage: 50,000,000 x 3.20% = 1,600,000; no-claim bonus 25% = -400,000; = 1,200,000
    // third party 341,600 + owner-driver accident 33,000; GST 18% of 1,574,600 = 283,428
    const result = quoter(request({ engineCc: 1197, claimFreeYears: 2, selection: BASIC }));
    expect(result).toMatchObject({ premiumPaise: 1574600, taxPaise: 283428, rateBook: 'MPC-2026.10' });
    const costs = Object.fromEntries(result.worksheet.filter((l) => l.step.startsWith('cost ')).map((l) => [l.step, l.amountPaise]));
    expect(costs).toEqual({ 'cost MOTOR_OD': 1200000, 'cost MOTOR_TP': 341600, 'cost PA_OWNER_DRIVER': 33000 });
  });

  it('golden 2: a voluntary deductible of Rs 2,500 gives a 15% discount on the own-damage premium', () => {
    // 1,200,000 - 15% (180,000) = 1,020,000; total premium 1,394,600; GST 251,028
    const selection: Selection = { ...BASIC, MOTOR_OD: { idv: 50000000, vol_deductible: 250000 } };
    expect(quoter(request({ engineCc: 1197, claimFreeYears: 2, selection }))).toMatchObject({ premiumPaise: 1394600, taxPaise: 251028 });
  });

  it('golden 3: the minimum own-damage premium applies to a cheap, claim-free-for-5-years car', () => {
    // 5,000,000 x 3.20% = 160,000; no-claim bonus 50% = 80,000; below the minimum of 200,000, so 200,000
    // third party 341,600 + 33,000; total 574,600; GST 103,428
    const selection: Selection = { ...BASIC, MOTOR_OD: { idv: 5000000, vol_deductible: 0 } };
    const result = quoter(request({ engineCc: 1197, claimFreeYears: 5, selection }));
    expect(result).toMatchObject({ premiumPaise: 574600, taxPaise: 103428 });
    expect(result.worksheet.some((l) => /minimum/i.test(l.step) && l.amountPaise === 200000)).toBe(true);
  });

  it('golden 4: amounts are rounded to the whole paise and then to the nearest rupee', () => {
    // 37,777,777 x 3.20% = 1,208,888.864 -> 1,208,889 paise -> nearest rupee 1,208,900
    const selection: Selection = { ...BASIC, MOTOR_OD: { idv: 37777777, vol_deductible: 0 } };
    const result = quoter(request({ engineCc: 1197, claimFreeYears: 0, selection }));
    const od = result.worksheet.find((l) => l.step === 'cost MOTOR_OD');
    expect(od?.amountPaise).toBe(1208900);
  });

  it('golden 5: add-ons (zero depreciation, engine protection, roadside assistance) are priced as their own costs', () => {
    // zero depreciation: 15% of the basic own damage 1,600,000 = 240,000
    // engine protection: 5% of 1,600,000 = 80,000 ; roadside assistance: flat 49,900
    // premium 1,574,600 + 240,000 + 80,000 + 49,900 = 1,944,500 ; GST 350,010
    const selection: Selection = { ...BASIC, ZERO_DEP: {}, ENGINE_PROTECT: {}, ROADSIDE_ASSIST: {} };
    const result = quoter(request({ engineCc: 1197, claimFreeYears: 2, selection }));
    expect(result).toMatchObject({ premiumPaise: 1944500, taxPaise: 350010 });
  });

  it('golden 6: a bigger engine and an older car use other rows of the base-rate table', () => {
    // 1800 cc, 8 years old: 3.52%. 50,000,000 x 3.52% = 1,760,000 ; no bonus ; third party for above 1500 cc = 754,400
    const result = quoter(request({ engineCc: 1800, ageYears: 8, claimFreeYears: 0, selection: BASIC }));
    const costs = Object.fromEntries(result.worksheet.filter((l) => l.step.startsWith('cost ')).map((l) => [l.step, l.amountPaise]));
    expect(costs).toEqual({ 'cost MOTOR_OD': 1760000, 'cost MOTOR_TP': 754400, 'cost PA_OWNER_DRIVER': 33000 });
  });

  it('golden 7: the older rate book 2026.04 prices a policy that starts before October', () => {
    const result = quoter(request({ start: '2026-05-01', engineCc: 1197, claimFreeYears: 2, selection: { ...BASIC, MOTOR_OD: { idv: 50000000, vol_deductible: 0 } } }));
    expect(result.rateBook).toBe('MPC-2026.04');
    expect(result.premiumPaise).toBeLessThan(1574600);
  });
});

describe('the rating is a pure function', () => {
  it('gives the same result for the same request, and leaves the request unchanged', () => {
    const input = request({ engineCc: 1197, claimFreeYears: 2, selection: BASIC });
    const before = JSON.stringify(input);
    const first = quoter(input);
    const second = quoter(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('explains every price: each lookup records its table, its inputs and the factor found', () => {
    const result = quoter(request({ engineCc: 1197, claimFreeYears: 2, selection: BASIC }));
    const lookup = result.worksheet.find((l) => l.step === 'MOTOR_OD: lookup base_rate');
    expect(lookup?.note).toMatch(/OD_BASE_RATE/);
    expect(lookup?.note).toMatch(/engine_cc=1197/);
    expect(lookup?.note).toMatch(/320/);
    expect(result.worksheet.at(-1)).toMatchObject({ step: 'GST', amountPaise: 283428 });
  });

  it('refuses to guess: a missing engine size or a coverage without a routine is reported', () => {
    expect(() => quoter(request({ engineCc: undefined, selection: BASIC }))).toThrow(ValidationError);
    expect(() => quoter(request({ engineCc: undefined, selection: BASIC }))).toThrow(/engine/i);
    expect(() => quoter(request({ engineCc: 1197, selection: { ...BASIC, UNKNOWN_COVER: {} } }))).toThrow(/UNKNOWN_COVER/);
  });

  it('refuses when no rate book is in force on the start date', () => {
    const input = request({ engineCc: 1197, selection: BASIC });
    input.branch.branch.periodStart = '2026-03-01';
    expect(() => quoter(input)).toThrow(/no active rate book/i);
  });
});
