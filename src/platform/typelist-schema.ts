import { z } from 'zod';
import { isRealDate } from './dates.js';

// The shape every typelist file must have (document section 18: configuration is checked against a schema).
// A schema is a description of what is allowed. zod checks a file against it and reports every problem found.

// All three languages are required for every entry.
const names = z.strictObject({
  en: z.string().trim().min(1, 'The English name is required'),
  hi: z.string().trim().min(1, 'The Hindi name is required'),
  te: z.string().trim().min(1, 'The Telugu name is required'),
});

const entry = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Code must be lower-case letters, digits or underscores, starting with a letter'),
  names,
  sort: z.number().int().nonnegative('Sort must be 0 or more'),
  retired: z.boolean().optional(),
});

export const typelistFileSchema = z
  .strictObject({
    typelist: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/, 'Typelist name must be 3 to 41 lower-case letters, digits or underscores, starting with a letter'),
    version: z.string().regex(/^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,3}$/, 'Version must look like 2026.10.1'),
    effective_from: z.string().refine(isRealDate, 'effective_from must be a real date written as yyyy-mm-dd'),
    entries: z.array(entry).min(1, 'A typelist needs at least one entry'),
  })
  .refine((file) => new Set(file.entries.map((e) => e.code)).size === file.entries.length, {
    message: 'Two entries share the same code',
    path: ['entries'],
  });

export type TypelistFile = z.infer<typeof typelistFileSchema>;
