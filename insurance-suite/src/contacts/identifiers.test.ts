import { describe, expect, it } from 'vitest';
import {
  isValidEmail,
  isValidGstin,
  isValidPan,
  isValidPinCode,
  maskAadhaar,
  maskPan,
  normalisePhone,
} from './identifiers.js';

// All numbers in these tests are made up.

describe('PIN code (document section 16)', () => {
  it('accepts six digits that do not start with 0', () => {
    expect(isValidPinCode('500081')).toBe(true);
    expect(isValidPinCode('110001')).toBe(true);
  });

  it('rejects a leading 0, the wrong length, letters and spaces', () => {
    expect(isValidPinCode('012345')).toBe(false);
    expect(isValidPinCode('50008')).toBe(false);
    expect(isValidPinCode('5000812')).toBe(false);
    expect(isValidPinCode('50008a')).toBe(false);
    expect(isValidPinCode(' 500081')).toBe(false);
  });
});

describe('PAN', () => {
  it('has five letters, four digits and a letter', () => {
    expect(isValidPan('ABCPK1234D', 'person')).toBe(true);
    expect(isValidPan('ABCP1234D', 'person')).toBe(false);
    expect(isValidPan('abcpk1234d', 'person')).toBe(false);
  });

  it('uses the fourth letter for the holder type: P for a person, another letter for a company', () => {
    expect(isValidPan('ABCPK1234D', 'company')).toBe(false);
    expect(isValidPan('ABCCK1234D', 'company')).toBe(true);
    expect(isValidPan('ABCCK1234D', 'person')).toBe(false);
  });

  it('is shown with the middle hidden', () => {
    expect(maskPan('ABCPK1234D')).toBe('ABCPK****D');
  });
});

describe('GSTIN', () => {
  it('has a state code, a PAN, an entity number, the letter Z and a check character', () => {
    expect(isValidGstin('36ABCCK1234D1Z5')).toBe(true);
  });

  it('rejects a bad state code, a missing Z and the wrong length', () => {
    expect(isValidGstin('99ABCCK1234D1Z5')).toBe(false);
    expect(isValidGstin('36ABCCK1234D1X5')).toBe(false);
    expect(isValidGstin('36ABCCK1234D1Z')).toBe(false);
  });
});

describe('Aadhaar (never stored in full)', () => {
  it('is masked to the last four digits', () => {
    expect(maskAadhaar('234567890123')).toBe('XXXX XXXX 0123');
    expect(maskAadhaar('2345 6789 0123')).toBe('XXXX XXXX 0123');
  });

  it('must be 12 digits and cannot start with 0 or 1', () => {
    expect(() => maskAadhaar('23456789012')).toThrow(/12 digits/);
    expect(() => maskAadhaar('123456789012')).toThrow(/cannot start with 0 or 1/);
    expect(() => maskAadhaar('abcd56789012')).toThrow();
  });
});

describe('phone and email', () => {
  it('turns an Indian mobile number into one standard form', () => {
    expect(normalisePhone('9876543210')).toBe('+919876543210');
    expect(normalisePhone('+91 98765 43210')).toBe('+919876543210');
    expect(normalisePhone('09876543210')).toBe('+919876543210');
  });

  it('rejects numbers that are too short or do not start with 6 to 9', () => {
    expect(normalisePhone('5876543210')).toBeNull();
    expect(normalisePhone('98765')).toBeNull();
  });

  it('checks an email has a name, an @ and a domain', () => {
    expect(isValidEmail('asha.rao@example.com')).toBe(true);
    expect(isValidEmail('asha.rao@example')).toBe(false);
    expect(isValidEmail('asha rao@example.com')).toBe(false);
  });
});
