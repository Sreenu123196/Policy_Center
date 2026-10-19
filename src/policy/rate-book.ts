import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { isRealDate, ValidationError } from '../platform/index.js';
import type { ProductCatalogue } from './product-catalogue.js';

// A rate book (document section 9): all the rating data for one product version, in a file. It holds lookup tables and
// a routine per coverage, written as ordered declarative steps. There is no free-form code in a rate book.
// Amounts are whole paise; rates and discounts are in basis points (1 bp = 0.01%, so 320 bps = 3.20%).

// The only inputs a routine may ask for. The rating code knows how to find each one on the quote.
export const RATING_INPUTS = ['idv', 'vol_deductible', 'engine_cc', 'vehicle_age_years', 'claim_free_years'] as const;
export type RatingInput = (typeof RATING_INPUTS)[number];

const name = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'A variable name is lower-case letters, digits or underscores');
const upperName = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'A table, constant or coverage name is capital letters, digits or underscores');
const ratingInput = z.enum(RATING_INPUTS);

// A key matches a single value or a range (both ends included; a missing end is open).
const range = z
  .strictObject({ min: z.number().optional(), max: z.number().optional() })
  .refine((r) => r.min !== undefined || r.max !== undefined, { message: 'A range needs a min or a max' })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, { message: 'min must not be above max' });

const table = z.strictObject({
  keys: z.array(ratingInput).min(1),
  rows: z.array(z.strictObject({ when: z.partialRecord(ratingInput, z.union([z.number(), range])), value: z.number().int() })).min(1),
});

const step = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('input'), name: ratingInput, as: name }),
  z.strictObject({ op: z.literal('constant'), name: upperName, as: name }),
  z.strictObject({ op: z.literal('lookup'), table: upperName, by: z.array(name).min(1), as: name }),
  z.strictObject({ op: z.literal('multiply_bps'), value: name, rate: name, as: name }), // value x rate / 10,000, rounded to a paise
  z.strictObject({ op: z.literal('discount_bps'), value: name, rate: name, as: name }), // value minus value x rate / 10,000
  z.strictObject({ op: z.literal('subtract'), a: name, b: name, as: name }),
  z.strictObject({ op: z.literal('minimum'), value: name, min: name, as: name }),
  z.strictObject({ op: z.literal('round_rupee'), value: name, as: name }), // nearest whole rupee (100 paise)
]);

const routine = z.strictObject({ steps: z.array(step).min(1), output: name });

export const rateBookSchema = z.strictObject({
  product: upperName,
  version: z.string().regex(/^\d{4}\.\d{2}$/, 'Version looks like 2026.10'), // the product version this book prices
  rate_book: z.string().min(1), // the name shown on quotes, for example MPC-2026.10
  effective_from: z.string().refine(isRealDate, 'effective_from must be a real date written yyyy-mm-dd'),
  status: z.enum(['draft', 'in_review', 'approved', 'active', 'retired']),
  jurisdiction: z.string().length(2),
  tax: z.strictObject({ name: z.string().min(1), rate_bps: z.number().int().min(0).max(10000) }),
  constants: z.record(upperName, z.number().int()),
  tables: z.record(upperName, table),
  routines: z.record(upperName, routine),
});

export type RateBook = z.infer<typeof rateBookSchema>;
export type RateRoutine = z.infer<typeof routine>;
export type RateStep = z.infer<typeof step>;
export type RateTable = z.infer<typeof table>;

export interface RateBookCatalogue {
  // The active rate book in force on a date for a product (the newest that has started), or null.
  forProduct(product: string, date: string): RateBook | null;
}

// Checks that the schema cannot express: names that must agree with each other inside one rate book.
function crossCheck(file: string, book: RateBook, catalogue: ProductCatalogue): string[] {
  const errors: string[] = [];
  if (!catalogue.versionsOf(book.product).some((v) => v.version === book.version)) {
    errors.push(`${file}: ${book.version} is not a version of ${book.product}`);
  }

  for (const [tableName, t] of Object.entries(book.tables)) {
    for (const row of t.rows) {
      for (const key of Object.keys(row.when)) if (!t.keys.includes(key as RatingInput)) errors.push(`${file}: table ${tableName}: a row uses ${key}, which is not one of its keys`);
      for (const key of t.keys) if (!(key in row.when)) errors.push(`${file}: table ${tableName}: a row does not say what ${key} must be`);
    }
  }

  for (const [code, r] of Object.entries(book.routines)) {
    const defined = new Set<string>();
    const use = (variable: string): void => {
      if (!defined.has(variable)) errors.push(`${file}: ${code}: ${variable} is not defined yet`);
    };
    for (const s of r.steps) {
      if (s.op === 'constant' && !(s.name in book.constants)) errors.push(`${file}: ${code}: constant ${s.name} does not exist`);
      if (s.op === 'lookup') {
        const t = book.tables[s.table];
        if (!t) errors.push(`${file}: ${code}: table ${s.table} does not exist`);
        else if (t.keys.join(',') !== s.by.join(',')) errors.push(`${file}: ${code}: table ${s.table} has keys ${t.keys.join(', ')}, but the lookup is by ${s.by.join(', ')}`);
        s.by.forEach(use);
      }
      if (s.op === 'multiply_bps' || s.op === 'discount_bps') {
        use(s.value);
        use(s.rate);
      }
      if (s.op === 'subtract') {
        use(s.a);
        use(s.b);
      }
      if (s.op === 'minimum') {
        use(s.value);
        use(s.min);
      }
      if (s.op === 'round_rupee') use(s.value);
      defined.add(s.as);
    }
    if (!defined.has(r.output)) errors.push(`${file}: ${code}: output ${r.output} is never defined`);
  }
  return errors;
}

// Reads every rate book in a folder and checks it. Like the product catalogue, one ValidationError lists every problem.
export function loadRateBooks(folder: string, catalogue: ProductCatalogue): RateBookCatalogue {
  if (!existsSync(folder)) throw new ValidationError([`Rate book folder ${folder} not found`]);
  const fileNames = readdirSync(folder).filter((n) => n.endsWith('.json')).sort();
  if (fileNames.length === 0) throw new ValidationError([`There are no rate book files in ${folder}`]);

  const books: RateBook[] = [];
  const errors: string[] = [];
  for (const file of fileNames) {
    const raw = readFileSync(join(folder, file), 'utf8');
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      errors.push(`${file}: the file is not valid JSON (${(error as Error).message})`);
      continue;
    }
    const parsed = rateBookSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${file}: ${issue.path.map(String).join('.') || 'file'}: ${issue.message}`);
      continue;
    }
    const expectedName = `${parsed.data.product.toLowerCase()}-${parsed.data.version}.json`;
    if (file !== expectedName) {
      errors.push(`${file}: the file should be named ${expectedName}`);
      continue;
    }
    const problems = crossCheck(file, parsed.data, catalogue);
    if (problems.length > 0) errors.push(...problems);
    else books.push(parsed.data);
  }
  if (errors.length > 0) throw new ValidationError(errors);

  return {
    forProduct(product, date) {
      const usable = books.filter((b) => b.product === product && b.status === 'active' && b.effective_from <= date);
      usable.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
      return usable.at(-1) ?? null;
    },
  };
}
