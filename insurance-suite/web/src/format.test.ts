import { describe, expect, it } from 'vitest';
import { formatDate, formatRupees, rupeesToPaise } from './format.js';

describe('showing money and dates', () => {
  it('writes rupees with Indian grouping', () => {
    expect(formatRupees(0)).toBe('Rs 0.00');
    expect(formatRupees(1858028)).toBe('Rs 18,580.28');
    expect(formatRupees(123456789)).toBe('Rs 12,34,567.89');
    expect(formatRupees(-944760)).toBe('-Rs 9,447.60');
  });

  it('writes dates as DD-MM-YYYY', () => {
    expect(formatDate('2026-10-15')).toBe('15-10-2026');
  });

  it('reads rupees typed by a person as whole paise', () => {
    expect(rupeesToPaise('500000')).toBe(50000000);
    expect(rupeesToPaise('5,00,000')).toBe(50000000);
    expect(rupeesToPaise('1234.5')).toBe(123450);
    expect(rupeesToPaise('abc')).toBeNull();
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise('12.345')).toBeNull();
  });
});
