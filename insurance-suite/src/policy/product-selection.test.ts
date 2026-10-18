import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadProductCatalogue } from './product-catalogue.js';
import { availableCoverages, defaultSelection, validateSelection } from './product-selection.js';

const realProducts = fileURLToPath(new URL('../../config/products/', import.meta.url));
const catalogue = loadProductCatalogue(realProducts);
const v2610 = catalogue.versionInForce('MOTOR_PRIVATE_CAR', '2026-10-01');
const v2604 = catalogue.versionInForce('MOTOR_PRIVATE_CAR', '2026-05-01');
if (!v2610 || !v2604) throw new Error('The private car product versions are missing');

// What we know about the risk. Money is in paise: 50,00,000 paise is Rs 50,000.
const individualWithNewCar = { ownerType: 'individual', vehicle: { ageYears: 3 } };
const codes = (list: { code: string }[]): string[] => list.map((c) => c.code);

describe('which coverages can be offered (document section 7: availability rules)', () => {
  it('depend on the facts: zero depreciation up to 5 years, engine protection up to 10, owner-driver cover only for individuals', () => {
    expect(codes(availableCoverages(v2610, { ownerType: 'individual', vehicle: { ageYears: 3 } }))).toEqual([
      'MOTOR_TP', 'MOTOR_OD', 'PA_OWNER_DRIVER', 'ZERO_DEP', 'ENGINE_PROTECT', 'ROADSIDE_ASSIST',
    ]);
    expect(codes(availableCoverages(v2610, { ownerType: 'individual', vehicle: { ageYears: 7 } }))).not.toContain('ZERO_DEP');
    expect(codes(availableCoverages(v2610, { ownerType: 'individual', vehicle: { ageYears: 7 } }))).toContain('ENGINE_PROTECT');
    expect(codes(availableCoverages(v2610, { ownerType: 'individual', vehicle: { ageYears: 12 } }))).not.toContain('ENGINE_PROTECT');
    expect(codes(availableCoverages(v2610, { ownerType: 'company', vehicle: { ageYears: 3 } }))).not.toContain('PA_OWNER_DRIVER');
  });

  it('follow the product version: the earlier version has no engine protection', () => {
    expect(codes(availableCoverages(v2604, individualWithNewCar))).not.toContain('ENGINE_PROTECT');
  });
});

describe('the starting choices', () => {
  it('contain only the required coverages that are available, with their default values', () => {
    expect(defaultSelection(v2610, individualWithNewCar)).toEqual({ MOTOR_TP: {}, PA_OWNER_DRIVER: {} });
    expect(defaultSelection(v2610, { ownerType: 'company', vehicle: { ageYears: 3 } })).toEqual({ MOTOR_TP: {} });
  });
});

describe('checking a customer\'s choices against the product (document section 7)', () => {
  const valid = {
    MOTOR_TP: {},
    PA_OWNER_DRIVER: {},
    MOTOR_OD: { idv: 50000000, vol_deductible: 250000 },
    ZERO_DEP: {},
  };

  it('accept a complete valid choice', () => {
    expect(validateSelection(v2610, individualWithNewCar, valid)).toEqual([]);
  });

  it('use the default for a value that was left out, but ask for one that has no default', () => {
    expect(validateSelection(v2610, individualWithNewCar, { ...valid, MOTOR_OD: { idv: 50000000 } })).toEqual([]);
    expect(validateSelection(v2610, individualWithNewCar, { ...valid, MOTOR_OD: { vol_deductible: 0 } })).toEqual([
      expect.stringMatching(/MOTOR_OD: idv needs a value/),
    ]);
  });

  it('insist on every required coverage that is available', () => {
    expect(validateSelection(v2610, individualWithNewCar, { MOTOR_OD: { idv: 50000000 } })).toEqual(
      expect.arrayContaining([expect.stringMatching(/MOTOR_TP is required/), expect.stringMatching(/PA_OWNER_DRIVER is required/)]),
    );
    // For a company the owner-driver cover is not available, so it is not required either.
    expect(validateSelection(v2610, { ownerType: 'company', vehicle: { ageYears: 3 } }, { MOTOR_TP: {} })).toEqual([]);
  });

  it('refuse a coverage that is not available for this risk, or that is not in the product', () => {
    expect(validateSelection(v2610, { ownerType: 'individual', vehicle: { ageYears: 7 } }, valid)).toEqual([
      expect.stringMatching(/ZERO_DEP is not available for this risk/),
    ]);
    expect(validateSelection(v2610, individualWithNewCar, { ...valid, TELEPORT: {} })).toEqual([expect.stringMatching(/TELEPORT is not a coverage of this product/)]);
  });

  it('enforce "requires": zero depreciation needs own damage', () => {
    const { MOTOR_OD: _ignored, ...withoutOwnDamage } = valid;
    void _ignored;
    expect(validateSelection(v2610, individualWithNewCar, withoutOwnDamage)).toEqual([expect.stringMatching(/ZERO_DEP requires MOTOR_OD/)]);
  });

  it('enforce "excludes" in both directions, with only one message per pair', () => {
    const exclusive = {
      ...v2610,
      line: {
        ...v2610.line,
        coverages: v2610.line.coverages.map((c) => (c.code === 'ENGINE_PROTECT' ? { ...c, excludes: ['ZERO_DEP'] } : c)),
      },
    };
    const both = { ...valid, ENGINE_PROTECT: {} };
    expect(validateSelection(exclusive, individualWithNewCar, both)).toEqual([expect.stringMatching(/ENGINE_PROTECT and ZERO_DEP cannot be chosen together/)]);
    expect(validateSelection(exclusive, individualWithNewCar, { ...valid })).toEqual([]);
  });

  it('check term values: an insured value below the minimum or above the maximum, a deductible not on the list, a term that does not exist', () => {
    const odErrors = (od: Record<string, number | string>) => validateSelection(v2610, individualWithNewCar, { ...valid, MOTOR_OD: od });
    expect(odErrors({ idv: 4999999 })).toEqual([expect.stringMatching(/MOTOR_OD: idv must be between 5000000 and 500000000/)]);
    expect(odErrors({ idv: 500000001 })).toEqual([expect.stringMatching(/MOTOR_OD: idv must be between/)]);
    expect(odErrors({ idv: 50000000.5 })).toEqual([expect.stringMatching(/MOTOR_OD: idv must be a whole number/)]);
    expect(odErrors({ idv: 50000000, vol_deductible: 100 })).toEqual([expect.stringMatching(/MOTOR_OD: vol_deductible must be one of 0, 250000, 500000/)]);
    expect(odErrors({ idv: 50000000, colour: 1 })).toEqual([expect.stringMatching(/MOTOR_OD: colour is not a term of this coverage/)]);
  });

  it('follow the version: an insured value of Rs 40,000 is allowed in 2026.04 but not in 2026.10', () => {
    const selection = { MOTOR_TP: {}, PA_OWNER_DRIVER: {}, MOTOR_OD: { idv: 4000000 } };
    expect(validateSelection(v2604, individualWithNewCar, selection)).toEqual([]);
    expect(validateSelection(v2610, individualWithNewCar, selection)).toEqual([expect.stringMatching(/idv must be between 5000000/)]);
  });
});
