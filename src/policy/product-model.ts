import { z } from 'zod';
import { isRealDate } from '../platform/index.js';

// The shape of a product file (document section 7 and Appendix C). The schema says what is allowed;
// zod checks a file against it and reports every problem found. Amounts are whole paise.

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Code must be capital letters, digits or underscores, starting with a letter');
const termCode = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Term code must be lower-case letters, digits or underscores, starting with a letter');

// Every name is required in all three languages.
const names = z.strictObject({
  en: z.string().trim().min(1, 'The English name is required'),
  hi: z.string().trim().min(1, 'The Hindi name is required'),
  te: z.string().trim().min(1, 'The Telugu name is required'),
});

const termValue = z.union([z.number().int(), z.string().min(1)]);

// A term is one value of a coverage. Either a choice from a list ("option"), or a number between limits ("direct").
const optionTerm = z
  .strictObject({
    code: termCode,
    type: z.literal('option'),
    options: z.array(termValue).min(1, 'An option term needs at least one option'),
    default: termValue.optional(),
  })
  .refine((term) => term.default === undefined || term.options.includes(term.default), {
    message: 'The default must be one of the options',
    path: ['default'],
  });

const directTerm = z
  .strictObject({
    code: termCode,
    type: z.literal('direct'),
    min: z.number().int().nonnegative(),
    max: z.number().int().positive().optional(),
    default: z.number().int().optional(),
  })
  .refine((term) => term.max === undefined || term.min <= term.max, { message: 'min must not be above max', path: ['max'] })
  .refine((term) => term.default === undefined || (term.default >= term.min && (term.max === undefined || term.default <= term.max)), {
    message: 'The default must be between min and max',
    path: ['default'],
  });

const term = z.discriminatedUnion('type', [optionTerm, directTerm]);

const coverage = z
  .strictObject({
    code,
    names,
    category: z.enum(['liability', 'own_damage', 'personal_accident', 'add_on']),
    // required: always on when available. electable: the customer may choose it. suggested: offered as a recommendation.
    existence: z.enum(['required', 'electable', 'suggested']),
    terms: z.array(term).optional(),
    available_when: z.string().trim().min(1, 'available_when cannot be empty').optional(),
    requires: z.array(code).optional(),
    excludes: z.array(code).optional(),
  })
  .refine((c) => new Set((c.terms ?? []).map((t) => t.code)).size === (c.terms ?? []).length, {
    message: 'A term code is used more than once',
    path: ['terms'],
  });

export const productFileSchema = z.strictObject({
  product: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/, 'Product code must be capital letters, digits or underscores, starting with a letter'),
  version: z.string().regex(/^\d{4}\.\d{2}$/, 'Version must look like 2026.10'),
  effective_from: z.string().refine(isRealDate, 'effective_from must be a real date written as yyyy-mm-dd'),
  names,
  jurisdictions: z.array(z.string().regex(/^[A-Z]{2}$/, 'A jurisdiction is a two-letter country code such as IN')).min(1, 'At least one jurisdiction is needed'),
  terms_allowed: z.array(z.string().regex(/^[A-Z0-9_]{2,20}$/, 'A policy term looks like 1Y or 1Y_OD_3Y_TP')).min(1, 'At least one policy term is needed'),
  line: z.strictObject({
    pattern: z.string().regex(/^[A-Z][A-Za-z0-9]{2,39}$/, 'Line pattern must start with a capital letter, for example MotorPrivateCar'),
    coverables: z.array(z.enum(['Vehicle', 'Driver', 'Location', 'Building'])).min(1, 'A line needs at least one coverable'),
    coverages: z.array(coverage).min(1, 'A line needs at least one coverage'),
  }),
});

export type ProductFile = z.infer<typeof productFileSchema>;
export type ProductCoverage = ProductFile['line']['coverages'][number];
export type ProductTerm = NonNullable<ProductCoverage['terms']>[number];
