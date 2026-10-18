import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { isRealDate, ValidationError } from '../platform/index.js';

// Claims configuration (document section 15): after how many days a report counts as late, and which cover each cause
// of loss needs. It lives in versioned files under config/claims/, like every other business rule.

const cause = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'A cause code is lower-case letters, digits or underscores (it is a typelist code)'),
  // Any one of these covers is enough for the loss to be covered.
  requires_coverage: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/)).min(1, 'requires_coverage needs at least one coverage code'),
});

export const claimsConfigSchema = z.strictObject({
  version: z.string().regex(/^\d{4}\.\d{2}$/, 'Version looks like 2026.04'),
  effective_from: z.string().refine(isRealDate, 'effective_from must be a real date written yyyy-mm-dd'),
  late_report_days: z.number().int().min(0),
  causes: z.array(cause).min(1),
});

export type ClaimsConfig = z.infer<typeof claimsConfigSchema>;

export interface ClaimsConfigCatalogue {
  forDate(date: string): ClaimsConfig;
}

export function loadClaimsConfig(folder: string): ClaimsConfigCatalogue {
  if (!existsSync(folder)) throw new ValidationError([`Claims folder ${folder} not found`]);
  const fileNames = readdirSync(folder).filter((n) => n.endsWith('.json')).sort();
  if (fileNames.length === 0) throw new ValidationError([`There are no claims files in ${folder}`]);

  const all: ClaimsConfig[] = [];
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
    const parsed = claimsConfigSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${file}: ${issue.path.map(String).join('.') || 'file'}: ${issue.message}`);
      continue;
    }
    if (file !== `claims-${parsed.data.version}.json`) {
      errors.push(`${file}: the file should be named claims-${parsed.data.version}.json`);
      continue;
    }
    const codes = parsed.data.causes.map((c) => c.code);
    const repeated = codes.filter((code, i) => codes.indexOf(code) !== i);
    if (repeated.length > 0) errors.push(...[...new Set(repeated)].map((code) => `${file}: cause ${code} is used more than once`));
    else all.push(parsed.data);
  }
  if (errors.length > 0) throw new ValidationError(errors);

  return {
    forDate(date) {
      const usable = all.filter((c) => c.effective_from <= date).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
      const found = usable.at(-1);
      if (!found) throw new ValidationError([`There is no claims configuration in force on ${date}`]);
      return found;
    },
  };
}
