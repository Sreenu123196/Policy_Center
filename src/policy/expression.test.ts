import { describe, expect, it } from 'vitest';
import { evaluateExpression, ExpressionError, parseExpression } from './expression.js';

const check = (text: string, facts: Record<string, unknown>): boolean => evaluateExpression(parseExpression(text), facts);

describe('availability expressions (document section 7)', () => {
  it('compare a fact with a text value', () => {
    expect(check("ownerType == 'individual'", { ownerType: 'individual' })).toBe(true);
    expect(check("ownerType == 'individual'", { ownerType: 'company' })).toBe(false);
    expect(check("ownerType != 'individual'", { ownerType: 'company' })).toBe(true);
  });

  it('compare a fact with a number, reaching into nested facts such as vehicle.ageYears', () => {
    expect(check('vehicle.ageYears <= 5', { vehicle: { ageYears: 5 } })).toBe(true);
    expect(check('vehicle.ageYears <= 5', { vehicle: { ageYears: 6 } })).toBe(false);
    expect(check('vehicle.ageYears > 2', { vehicle: { ageYears: 3 } })).toBe(true);
    expect(check('vehicle.ageYears >= 3', { vehicle: { ageYears: 3 } })).toBe(true);
    expect(check('vehicle.ageYears < 3', { vehicle: { ageYears: 3 } })).toBe(false);
  });

  it('combine with and, or and not, where and binds tighter than or, and brackets decide otherwise', () => {
    const facts = { a: 1, b: 0, c: 0 };
    expect(check('a == 1 or b == 2 and c == 3', facts)).toBe(true); // a == 1 or (b == 2 and c == 3)
    expect(check('(a == 1 or b == 2) and c == 3', facts)).toBe(false);
    expect(check('not a == 1', facts)).toBe(false);
    expect(check('not (b == 2 or c == 3)', facts)).toBe(true);
  });

  it('read a yes/no fact on its own, and the words true and false', () => {
    expect(check('vehicle.isNew', { vehicle: { isNew: true } })).toBe(true);
    expect(check('vehicle.isNew', { vehicle: { isNew: false } })).toBe(false);
    expect(check('vehicle.isNew == true', { vehicle: { isNew: true } })).toBe(true);
  });

  it('treat a comparison with a fact that is missing as false, so an unknown fact never makes a cover available', () => {
    expect(check('vehicle.ageYears <= 5', {})).toBe(false);
    expect(check("ownerType == 'individual'", { vehicle: {} })).toBe(false);
    expect(check('vehicle.ageYears <= 5', { vehicle: { ageYears: 'old' } })).toBe(false); // wrong kind of value
  });

  it('report a syntax error with its position, so a mistake in a product file can be found', () => {
    const message = (text: string): string => {
      try {
        parseExpression(text);
        return 'no error';
      } catch (error) {
        expect(error).toBeInstanceOf(ExpressionError);
        return (error as ExpressionError).message;
      }
    };
    expect(message('vehicle.ageYears <=')).toMatch(/expected a value.*end of the expression/i);
    expect(message("ownerType = 'individual'")).toMatch(/position 10/);
    expect(message("ownerType == 'individual")).toMatch(/unterminated text/i);
    expect(message('a == 1 b == 2')).toMatch(/unexpected "b" at position 7/i);
    expect(message('(a == 1')).toMatch(/expected "\)"/);
    expect(message('a == #')).toMatch(/unexpected character "#" at position 5/i);
    expect(message('')).toMatch(/empty/i);
  });

  it('can only compare and combine: anything that looks like running code is refused, never run', () => {
    expect(() => parseExpression("process.exit()")).toThrow(ExpressionError);
    expect(() => parseExpression("constructor.constructor('return 1')()")).toThrow(ExpressionError);
    expect(() => parseExpression('a == 1; b == 2')).toThrow(ExpressionError);
  });
});
