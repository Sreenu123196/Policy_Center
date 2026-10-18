import { describe, expect, it } from 'vitest';
import { isRealDate } from './dates.js';

describe('isRealDate (dates are written yyyy-mm-dd, as in CLAUDE.md)', () => {
  it('accepts real calendar dates, including 29 February in a leap year', () => {
    expect(isRealDate('2026-10-18')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
  });

  it('rejects days that do not exist in that month, and 29 February in other years', () => {
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2027-02-29')).toBe(false);
    expect(isRealDate('2026-04-31')).toBe(false);
  });

  it('rejects a month or day out of range without crashing', () => {
    expect(isRealDate('2026-13-45')).toBe(false);
    expect(isRealDate('2026-00-10')).toBe(false);
  });

  it('rejects anything not written as yyyy-mm-dd', () => {
    expect(isRealDate('18-10-2026')).toBe(false);
    expect(isRealDate('2026-1-5')).toBe(false);
    expect(isRealDate('2026-10-18T00:00:00Z')).toBe(false);
    expect(isRealDate('')).toBe(false);
  });
});
