import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ValidationError } from '../platform/index.js';
import { ExpressionError, parseExpression } from './expression.js';
import type { ProductCatalogue } from './product-catalogue.js';

// Underwriting rules (document section 10) for one product version, in a file: the issue types, the rules that raise
// them, and the authority profiles that say who may approve what. Conditions use the same safe expression language
// as the product model. Values are numbers (paise for money, years for ages).

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'A code is capital letters, digits or underscores, starting with a letter');

// The points where rules run, in order. An issue type "blocks" one of these points (or none).
export const CHECK_POINTS = ['quote', 'bind', 'issuance'] as const;
export type CheckPoint = (typeof CHECK_POINTS)[number];

const issueType = z.strictObject({
  code,
  description: z.string().min(1),
  blocks: z.enum(['quote', 'bind', 'issuance', 'none']),
  // How a value is compared with an approval: "max" means the approval covers values up to its limit (insured value),
  // "min" means it covers values down to its limit (driver age).
  compare: z.enum(['max', 'min']),
  approval_valid_days: z.number().int().positive().optional(),
});

const rule = z.strictObject({
  code,
  issue_type: code,
  check_at: z.enum(CHECK_POINTS),
  when: z.string().min(1),
  value: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]*$/, 'value is the name of a fact, for example vehicle.ageYears'),
  message: z.string().min(1),
});

const grant = z.strictObject({
  issue_type: code,
  limit: z.number().int().optional(), // the furthest value this profile may approve; none means no limit
});

const profile = z.strictObject({
  code,
  roles: z.array(z.string()).default([]),
  users: z.array(z.string()).default([]),
  grants: z.array(grant),
});

export const uwRulesSchema = z.strictObject({
  product: code,
  version: z.string().regex(/^\d{4}\.\d{2}$/, 'Version looks like 2026.10'), // the product version these rules belong to
  issue_types: z.array(issueType).min(1),
  rules: z.array(rule),
  authority_profiles: z.array(profile),
});

export type UwRules = z.infer<typeof uwRulesSchema>;
export type UwIssueType = z.infer<typeof issueType>;
export type UwRule = z.infer<typeof rule>;
export type AuthorityProfile = z.infer<typeof profile>;

export interface UwRulesCatalogue {
  forVersion(product: string, version: string): UwRules | null;
}

const repeated = (items: string[]): string[] => items.filter((item, i) => items.indexOf(item) !== i);

function crossCheck(file: string, rules: UwRules, catalogue: ProductCatalogue): string[] {
  const errors: string[] = [];
  if (!catalogue.versionsOf(rules.product).some((v) => v.version === rules.version)) errors.push(`${file}: ${rules.version} is not a version of ${rules.product}`);

  const types = new Set(rules.issue_types.map((t) => t.code));
  for (const dup of repeated(rules.issue_types.map((t) => t.code))) errors.push(`${file}: issue type ${dup} is used more than once`);
  for (const dup of repeated(rules.rules.map((r) => r.code))) errors.push(`${file}: rule ${dup} is used more than once`);
  for (const dup of repeated(rules.authority_profiles.map((p) => p.code))) errors.push(`${file}: profile ${dup} is used more than once`);

  for (const r of rules.rules) {
    if (!types.has(r.issue_type)) errors.push(`${file}: ${r.code}: issue type ${r.issue_type} does not exist`);
    try {
      parseExpression(r.when);
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      errors.push(`${file}: ${r.code}: when is not a valid expression (${error.message})`);
    }
  }
  for (const p of rules.authority_profiles) {
    if (p.roles.length === 0 && p.users.length === 0) errors.push(`${file}: profile ${p.code} has no role and no user, so nobody can hold it`);
    for (const g of p.grants) if (!types.has(g.issue_type)) errors.push(`${file}: profile ${p.code}: issue type ${g.issue_type} does not exist`);
  }
  return errors;
}

// Reads every underwriting file in a folder and checks it; one ValidationError lists every problem.
export function loadUnderwritingRules(folder: string, catalogue: ProductCatalogue): UwRulesCatalogue {
  if (!existsSync(folder)) throw new ValidationError([`Underwriting folder ${folder} not found`]);
  const fileNames = readdirSync(folder).filter((n) => n.endsWith('.json')).sort();
  if (fileNames.length === 0) throw new ValidationError([`There are no underwriting files in ${folder}`]);

  const all: UwRules[] = [];
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
    const parsed = uwRulesSchema.safeParse(json);
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
