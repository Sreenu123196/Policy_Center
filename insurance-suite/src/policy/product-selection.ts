import { evaluateExpression, parseExpression } from './expression.js';
import type { ProductCoverage, ProductFile, ProductTerm } from './product-model.js';

// What we know about the risk, used by availability rules: for example { ownerType: 'individual', vehicle: { ageYears: 3 } }.
export type Facts = Record<string, unknown>;

// A customer's choices: coverage code -> term values, for example { MOTOR_OD: { idv: 50000000, vol_deductible: 0 } }.
// Amounts are whole paise.
export type Selection = Record<string, Record<string, number | string>>;

const isAvailable = (coverage: ProductCoverage, facts: Facts): boolean =>
  coverage.available_when === undefined || evaluateExpression(parseExpression(coverage.available_when), facts);

// The coverages that may be offered for this risk, in the order the product lists them.
export function availableCoverages(version: ProductFile, facts: Facts): ProductCoverage[] {
  return version.line.coverages.filter((coverage) => isAvailable(coverage, facts));
}

// The starting choices for a new quote: every required coverage that is available, with default values filled in.
export function defaultSelection(version: ProductFile, facts: Facts): Selection {
  const selection: Selection = {};
  for (const coverage of availableCoverages(version, facts)) {
    if (coverage.existence !== 'required') continue;
    selection[coverage.code] = {};
    for (const term of coverage.terms ?? []) {
      if (term.default !== undefined) selection[coverage.code] = { ...selection[coverage.code], [term.code]: term.default };
    }
  }
  return selection;
}

function checkTerm(coverage: ProductCoverage, term: ProductTerm, given: number | string | undefined): string[] {
  const value = given ?? term.default;
  if (value === undefined) return [`${coverage.code}: ${term.code} needs a value`];

  if (term.type === 'option') {
    return term.options.includes(value) ? [] : [`${coverage.code}: ${term.code} must be one of ${term.options.join(', ')}`];
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) return [`${coverage.code}: ${term.code} must be a whole number`];
  if (value < term.min || (term.max !== undefined && value > term.max)) {
    return [`${coverage.code}: ${term.code} must be ${term.max === undefined ? `at least ${term.min}` : `between ${term.min} and ${term.max}`}`];
  }
  return [];
}

// Checks a customer's choices against the product, for this risk. Returns every problem found; an empty list means valid.
export function validateSelection(version: ProductFile, facts: Facts, selection: Selection): string[] {
  const errors: string[] = [];
  const byCode = new Map(version.line.coverages.map((c) => [c.code, c]));
  const chosen = new Set(Object.keys(selection));

  // 1. Everything chosen must be in the product and available for this risk.
  const usable: ProductCoverage[] = [];
  for (const code of chosen) {
    const coverage = byCode.get(code);
    if (!coverage) errors.push(`${code} is not a coverage of this product`);
    else if (!isAvailable(coverage, facts)) errors.push(`${code} is not available for this risk`);
    else usable.push(coverage);
  }

  // 2. Every required coverage that is available must be chosen.
  for (const coverage of availableCoverages(version, facts)) {
    if (coverage.existence === 'required' && !chosen.has(coverage.code)) errors.push(`${coverage.code} is required`);
  }

  // 3. Dependencies: "requires" must be chosen too; "excludes" must not be, and a pair is reported once.
  const reportedPairs = new Set<string>();
  for (const coverage of usable) {
    for (const needed of coverage.requires ?? []) {
      if (!chosen.has(needed)) errors.push(`${coverage.code} requires ${needed}`);
    }
    for (const other of coverage.excludes ?? []) {
      const pair = [coverage.code, other].sort().join('|');
      if (chosen.has(other) && !reportedPairs.has(pair)) {
        reportedPairs.add(pair);
        errors.push(`${coverage.code} and ${other} cannot be chosen together`);
      }
    }
  }

  // 4. Term values: every term needs a legal value (or a default), and no unknown terms are given.
  for (const coverage of usable) {
    const given = selection[coverage.code] ?? {};
    const terms = coverage.terms ?? [];
    for (const key of Object.keys(given)) {
      if (!terms.some((t) => t.code === key)) errors.push(`${coverage.code}: ${key} is not a term of this coverage`);
    }
    for (const term of terms) errors.push(...checkTerm(coverage, term, given[term.code]));
  }
  return errors;
}
