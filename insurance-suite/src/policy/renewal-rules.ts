import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ValidationError } from '../platform/index.js';
import type { ProductCatalogue } from './product-catalogue.js';

// Renewal rules for one product version (document section 8): how many days before expiry a renewal may start, and
// how many days of notice a non-renewal needs. They are configuration.

export const renewalRulesSchema = z.strictObject({
  product: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  version: z.string().regex(/^\d{4}\.\d{2}$/, 'Version looks like 2026.10'),
  lead_days: z.number().int().positive(), // a renewal starts this many days before the term ends
  non_renewal_notice_days: z.number().int().min(0), // a non-renewal notice must go out this many days before the term ends
});

export type RenewalRules = z.infer<typeof renewalRulesSchema>;

export interface RenewalRulesCatalogue {
  forVersion(product: string, version: string): RenewalRules | null;
}

function crossCheck(file: string, rules: RenewalRules, catalogue: ProductCatalogue): string[] {
  const errors: string[] = [];
  if (!catalogue.versionsOf(rules.product).some((v) => v.version === rules.version)) errors.push(`${file}: ${rules.version} is not a version of ${rules.product}`);
  if (rules.non_renewal_notice_days > rules.lead_days) errors.push(`${file}: non_renewal_notice_days must not be more than lead_days, or the notice would be due before the renewal can start`);
  return errors;
}

// Reads every renewal file in a folder and checks it; one ValidationError lists every problem.
export function loadRenewalRules(folder: string, catalogue: ProductCatalogue): RenewalRulesCatalogue {
  if (!existsSync(folder)) throw new ValidationError([`Renewal folder ${folder} not found`]);
  const fileNames = readdirSync(folder).filter((n) => n.endsWith('.json')).sort();
  if (fileNames.length === 0) throw new ValidationError([`There are no renewal files in ${folder}`]);

  const all: RenewalRules[] = [];
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
    const parsed = renewalRulesSchema.safeParse(json);
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
