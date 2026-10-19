import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ValidationError } from '../platform/index.js';
import type { ProductCatalogue } from './product-catalogue.js';

// Cancellation and reinstatement rules for one product version (document section 8): the reasons and who may use them,
// how much notice an insurer must give, which refund methods each reason allows, the short-rate table, the minimum
// premium the insurer keeps, and how long after a cancellation a policy may be reinstated. They are configuration.

export const REFUND_METHODS = ['flat', 'pro_rata', 'short_rate'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

const reason = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'A reason code is lower-case letters, digits or underscores (it is a typelist code)'),
  source: z.enum(['insured', 'insurer']), // who asks for the cancellation
  methods: z.array(z.enum(REFUND_METHODS)).min(1, 'A reason needs at least one refund method'),
  notice_days: z.number().int().min(0), // days of notice the insurer must give before the effective date
});

export const cancellationRulesSchema = z.strictObject({
  product: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  version: z.string().regex(/^\d{4}\.\d{2}$/, 'Version looks like 2026.10'),
  minimum_retained_paise: z.number().int().min(0),
  reinstatement_window_days: z.number().int().min(0),
  // Share of the term premium the insurer keeps, by days the policy was in force. The first row whose limit covers the days applies.
  short_rate: z.array(z.strictObject({ up_to_days: z.number().int().positive(), retained_bps: z.number().int().min(0).max(10000) })).min(1),
  reasons: z.array(reason),
});

export type CancellationRules = z.infer<typeof cancellationRulesSchema>;
export type CancellationReason = z.infer<typeof reason>;

export interface CancellationRulesCatalogue {
  forVersion(product: string, version: string): CancellationRules | null;
}

function crossCheck(file: string, rules: CancellationRules, catalogue: ProductCatalogue): string[] {
  const errors: string[] = [];
  if (!catalogue.versionsOf(rules.product).some((v) => v.version === rules.version)) errors.push(`${file}: ${rules.version} is not a version of ${rules.product}`);

  const table = rules.short_rate;
  for (let i = 1; i < table.length; i++) {
    const before = table[i - 1];
    const row = table[i];
    if (!before || !row) continue;
    if (row.up_to_days <= before.up_to_days) errors.push(`${file}: short_rate must have increasing up_to_days (${row.up_to_days} comes after ${before.up_to_days})`);
    if (row.retained_bps < before.retained_bps) errors.push(`${file}: short_rate must retain at least as much as the row before it (${row.up_to_days} days)`);
  }
  if ((table.at(-1)?.up_to_days ?? 0) < 366) errors.push(`${file}: short_rate must reach 366 days, so every day of a term has a row`);

  const seen = new Set<string>();
  for (const r of rules.reasons) {
    if (seen.has(r.code)) errors.push(`${file}: reason ${r.code} is used more than once`);
    seen.add(r.code);
  }
  return errors;
}

// Reads every cancellation file in a folder and checks it; one ValidationError lists every problem.
export function loadCancellationRules(folder: string, catalogue: ProductCatalogue): CancellationRulesCatalogue {
  if (!existsSync(folder)) throw new ValidationError([`Cancellation folder ${folder} not found`]);
  const fileNames = readdirSync(folder).filter((n) => n.endsWith('.json')).sort();
  if (fileNames.length === 0) throw new ValidationError([`There are no cancellation files in ${folder}`]);

  const all: CancellationRules[] = [];
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
    const parsed = cancellationRulesSchema.safeParse(json);
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
    else all.push(parsed.data);
  }
  if (errors.length > 0) throw new ValidationError(errors);
  return { forVersion: (product, version) => all.find((r) => r.product === product && r.version === version) ?? null };
}
