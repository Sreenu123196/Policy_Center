import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../platform/index.js';
import { loadProductCatalogue } from './product-catalogue.js';

// The project's own product files: config/products/
const realProducts = fileURLToPath(new URL('../../config/products/', import.meta.url));

let dir: string; // a throwaway folder for the files each test writes

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suite-products-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const names = (en: string) => ({ en, hi: `${en} (hi)`, te: `${en} (te)` });

// A small valid product to start from. Amounts are in paise.
const product = (over: Record<string, unknown> = {}) => ({
  product: 'MOTOR_TEST',
  version: '2026.10',
  effective_from: '2026-10-01',
  names: names('Test motor'),
  jurisdictions: ['IN'],
  terms_allowed: ['1Y'],
  line: {
    pattern: 'MotorTest',
    coverables: ['Vehicle'],
    coverages: [
      { code: 'TP', names: names('Third party'), category: 'liability', existence: 'required' },
      {
        code: 'OD',
        names: names('Own damage'),
        category: 'own_damage',
        existence: 'electable',
        terms: [{ code: 'idv', type: 'direct', min: 5000000 }],
      },
      { code: 'ADDON', names: names('Add-on'), category: 'add_on', existence: 'electable', requires: ['OD'] },
    ],
  },
  ...over,
});

const withCoverages = (coverages: unknown[]) => product({ line: { pattern: 'MotorTest', coverables: ['Vehicle'], coverages } });

const write = (file: string, content: unknown) =>
  writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2));

const errorsOf = (): string[] => {
  try {
    loadProductCatalogue(dir);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).errors;
  }
  throw new Error('Expected the catalogue to be refused');
};

describe("the project's own products (config/products)", () => {
  it('load without problems: private car in two versions, every coverage named in all three languages', () => {
    const catalogue = loadProductCatalogue(realProducts);
    expect(catalogue.products()).toEqual(['MOTOR_PRIVATE_CAR']);
    expect(catalogue.versionsOf('MOTOR_PRIVATE_CAR').map((v) => v.version)).toEqual(['2026.04', '2026.10']);

    for (const version of catalogue.versionsOf('MOTOR_PRIVATE_CAR')) {
      expect(version.jurisdictions).toEqual(['IN']);
      for (const coverage of version.line.coverages) {
        expect(Object.values(coverage.names).every((n) => n.trim() !== '')).toBe(true);
      }
    }
  });

  it('give the version in force on a date: new business uses the version in force on the start date', () => {
    const catalogue = loadProductCatalogue(realProducts);
    expect(catalogue.versionInForce('MOTOR_PRIVATE_CAR', '2026-05-01')?.version).toBe('2026.04');
    expect(catalogue.versionInForce('MOTOR_PRIVATE_CAR', '2026-09-30')?.version).toBe('2026.04');
    expect(catalogue.versionInForce('MOTOR_PRIVATE_CAR', '2026-10-01')?.version).toBe('2026.10');
    expect(catalogue.versionInForce('MOTOR_PRIVATE_CAR', '2027-03-01')?.version).toBe('2026.10');
    expect(catalogue.versionInForce('MOTOR_PRIVATE_CAR', '2026-03-31')).toBeNull(); // before the first version
    expect(catalogue.versionInForce('NO_SUCH_PRODUCT', '2026-10-01')).toBeNull();
    expect(catalogue.latest('MOTOR_PRIVATE_CAR')?.version).toBe('2026.10');
  });
});

describe('product files are checked (document sections 7 and 18)', () => {
  it('accept a valid product', () => {
    write('motor_test-2026.10.json', product());
    expect(loadProductCatalogue(dir).products()).toEqual(['MOTOR_TEST']);
  });

  it('report every schema problem in every file together, with the file name and the place', () => {
    write('motor_test-2026.10.json', product({ version: '10.2026', jurisdictions: [], names: { en: 'Test', hi: '', te: 'x' } }));
    write('broken.json', '{ not json');
    write('other-2026.10.json', withCoverages([{ code: 'tp', names: names('x'), category: 'nonsense', existence: 'maybe' }]));

    const errors = errorsOf();
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/motor_test-2026\.10\.json: version/),
        expect.stringMatching(/motor_test-2026\.10\.json: jurisdictions/),
        expect.stringMatching(/motor_test-2026\.10\.json: names\.hi/),
        expect.stringMatching(/broken\.json: .*not valid JSON/i),
        expect.stringMatching(/other-2026\.10\.json: line\.coverages\.0\.code/),
        expect.stringMatching(/other-2026\.10\.json: line\.coverages\.0\.category/),
        expect.stringMatching(/other-2026\.10\.json: line\.coverages\.0\.existence/),
      ]),
    );
  });

  it('refuse a file whose name does not match its product and version', () => {
    write('something-else.json', product());
    expect(errorsOf()).toEqual([expect.stringMatching(/something-else\.json: the file should be named motor_test-2026\.10\.json/)]);
  });

  it('refuse a dependency on a coverage that does not exist or on itself, and duplicate coverage codes', () => {
    write(
      'motor_test-2026.10.json',
      withCoverages([
        { code: 'TP', names: names('Third party'), category: 'liability', existence: 'required' },
        { code: 'AA', names: names('AA'), category: 'add_on', existence: 'electable', requires: ['MISSING', 'AA'], excludes: ['NOWHERE'] },
        { code: 'AA', names: names('AA again'), category: 'add_on', existence: 'electable' },
      ]),
    );
    expect(errorsOf()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/AA requires MISSING, which is not a coverage of this product/),
        expect.stringMatching(/AA cannot require itself/),
        expect.stringMatching(/AA excludes NOWHERE, which is not a coverage of this product/),
        expect.stringMatching(/more than once.*AA/),
      ]),
    );
  });

  it('refuse two required coverages that exclude each other, since no policy could ever satisfy both', () => {
    write(
      'motor_test-2026.10.json',
      withCoverages([
        { code: 'XX', names: names('XX'), category: 'liability', existence: 'required', excludes: ['YY'] },
        { code: 'YY', names: names('YY'), category: 'liability', existence: 'required' },
      ]),
    );
    expect(errorsOf()).toEqual([expect.stringMatching(/XX and YY are both required but XX excludes YY/)]);
  });

  it('refuse an availability rule that does not parse, naming the coverage and the mistake', () => {
    write(
      'motor_test-2026.10.json',
      withCoverages([
        { code: 'TP', names: names('Third party'), category: 'liability', existence: 'required' },
        { code: 'ADDON', names: names('Add-on'), category: 'add_on', existence: 'electable', available_when: 'vehicle.ageYears <=' },
      ]),
    );
    expect(errorsOf()).toEqual([expect.stringMatching(/ADDON: available_when .*expected a value/i)]);
  });

  it('refuse terms that cannot work: a default outside the options, a minimum above the maximum, repeated term codes', () => {
    write(
      'motor_test-2026.10.json',
      withCoverages([
        {
          code: 'OD',
          names: names('Own damage'),
          category: 'own_damage',
          existence: 'electable',
          terms: [
            { code: 'deductible', type: 'option', options: [0, 250000], default: 999 },
            { code: 'idv', type: 'direct', min: 9000000, max: 5000000 },
            { code: 'idv', type: 'direct', min: 1 },
          ],
        },
      ]),
    );
    expect(errorsOf()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/line\.coverages\.0\.terms\.0.*default must be one of the options/i),
        expect.stringMatching(/line\.coverages\.0\.terms\.1.*min .* max/i),
        expect.stringMatching(/line\.coverages\.0.*term code.*more than once/i),
      ]),
    );
  });

  it('refuse two versions of a product that start on the same date or that are out of order', () => {
    write('motor_test-2026.10.json', product());
    write('motor_test-2026.11.json', product({ version: '2026.11', effective_from: '2026-10-01' }));
    write('motor_test-2026.12.json', product({ version: '2026.12', effective_from: '2026-09-01' }));
    expect(errorsOf()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/MOTOR_TEST.*2026\.10 and 2026\.11.*same date/i),
        expect.stringMatching(/MOTOR_TEST.*2026\.12.*earlier date/i),
      ]),
    );
  });

  it('say so when the folder does not exist or holds no product files', () => {
    expect(() => loadProductCatalogue(join(dir, 'missing'))).toThrow(/product folder .* not found/i);
    expect(() => loadProductCatalogue(dir)).toThrow(/no product files/i);
  });
});
