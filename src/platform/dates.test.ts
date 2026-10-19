import { describe, expect, it } from 'vitest';
import { addDays, addYears, daysBetween, isRealDate } from './dates.js';

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

describe('addYears (an annual policy ends on the anniversary of its start; the end day is excluded)', () => {
  it('moves to the same day of the later year', () => {
    expect(addYears('2026-04-01', 1)).toBe('2027-04-01');
    expect(addYears('2026-12-31', 1)).toBe('2027-12-31');
    expect(addYears('2026-04-01', 3)).toBe('2029-04-01');
  });

  it('keeps 29 February when the later year is also a leap year, and otherwise ends on 1 March', () => {
    expect(addYears('2028-02-29', 4)).toBe('2032-02-29');
    expect(addYears('2028-02-29', 1)).toBe('2029-03-01');
  });

  it('refuses a date that is not real', () => {
    expect(() => addYears('2026-13-45', 1)).toThrow(/real date/i);
  });
});

describe('addDays (used for how long a quote stays valid)', () => {
  it('counts days across month and year ends', () => {
    expect(addDays('2026-10-16', 30)).toBe('2026-11-15');
    expect(addDays('2026-12-20', 15)).toBe('2027-01-04');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-16', 0)).toBe('2026-10-16');
  });

  it('refuses a date that is not real', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(/real date/i);
  });
});

describe('daysBetween (the length of a slice, used to prorate premium)', () => {
  it('counts the days from the first date up to, but not including, the second', () => {
    expect(daysBetween('2026-10-15', '2027-10-15')).toBe(365);
    expect(daysBetween('2026-10-15', '2027-01-01')).toBe(78);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2); // 2028 is a leap year
    expect(daysBetween('2026-10-15', '2026-10-15')).toBe(0);
  });

  it('refuses a date that is not real', () => {
    expect(() => daysBetween('2026-02-30', '2026-03-05')).toThrow(/real date/i);
  });
});
