import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ValidationError } from '../platform/index.js';
import { isRealDate } from '../platform/index.js';

// Billing configuration (document section 14): payment plans and the invoicing rules that go with them. It lives in
// versioned files under config/billing/, like every other business rule. Money is whole paise.

const names = z.strictObject({
  en: z.string().trim().min(1, 'The English name is required'),
  hi: z.string().trim().min(1, 'The Hindi name is required'),
  te: z.string().trim().min(1, 'The Telugu name is required'),
});

const plan = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'A plan code is capital letters, digits or underscores'),
  names,
  down_payment_bps: z.number().int().min(1).max(10000), // share of the charge due on the first date, in basis points (2500 = 25%)
  installments: z.number().int().min(0), // payments after the down payment
  interval_days: z.number().int().min(0), // days between payments
  installment_fee_paise: z.number().int().min(0), // added to every payment after the down payment
  invoice_lead_days: z.number().int().min(0), // an invoice is made this many days before its due date
  grace_days: z.number().int().min(0), // days after the due date before a missed payment is treated as late (step F2)
});

export const billingConfigSchema = z.strictObject({
  version: z.string().regex(/^\d{4}\.\d{2}$/, 'Version looks like 2026.10'),
  effective_from: z.string().refine(isRealDate, 'effective_from must be a real date written yyyy-mm-dd'),
  default_plan: z.string(),
  plans: z.array(plan).min(1),
});

export type BillingConfig = z.infer<typeof billingConfigSchema>;
export type PaymentPlan = z.infer<typeof plan>;

export interface BillingConfigCatalogue {
  // The configuration in force on a date: the newest one that has started.
  forDate(date: string): BillingConfig;
}

function crossCheck(file: string, config: BillingConfig): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const p of config.plans) {
    if (seen.has(p.code)) errors.push(`${file}: plan ${p.code} is used more than once`);
    seen.add(p.code);
    if (p.down_payment_bps === 10000 && p.installments > 0) errors.push(`${file}: ${p.code} takes 100% as a down payment, so it cannot also have instalments`);
    if (p.down_payment_bps < 10000 && p.installments === 0) errors.push(`${file}: ${p.code} takes less than 100% as a down payment but has no instalments for the rest`);
    if (p.installments > 0 && p.interval_days === 0) errors.push(`${file}: ${p.code} has instalments but no interval between them`);
  }
  if (!seen.has(config.default_plan)) errors.push(`${file}: the default plan ${config.default_plan} is not one of the plans`);
  return errors;
}

// Reads the billing files in a folder (billing-<version>.json) and checks them; one ValidationError lists every problem.
export function loadBillingConfig(folder: string): BillingConfigCatalogue {
  if (!existsSync(folder)) throw new ValidationError([`Billing folder ${folder} not found`]);
  const fileNames = readdirSync(folder).filter((n) => n.endsWith('.json')).sort();
  if (fileNames.length === 0) throw new ValidationError([`There are no billing files in ${folder}`]);

  const all: BillingConfig[] = [];
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
    const parsed = billingConfigSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${file}: ${issue.path.map(String).join('.') || 'file'}: ${issue.message}`);
      continue;
    }
    if (file !== `billing-${parsed.data.version}.json`) {
      errors.push(`${file}: the file should be named billing-${parsed.data.version}.json`);
      continue;
    }
    const problems = crossCheck(file, parsed.data);
    if (problems.length > 0) errors.push(...problems);
    else all.push(parsed.data);
  }
  if (errors.length > 0) throw new ValidationError(errors);

  return {
    forDate(date) {
      const usable = all.filter((c) => c.effective_from <= date).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
      const found = usable.at(-1);
      if (!found) throw new ValidationError([`There is no billing configuration in force on ${date}`]);
      return found;
    },
  };
}
