import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError } from '../platform/index.js';
import { ExpressionError, parseExpression } from './expression.js';
import { productFileSchema, type ProductFile } from './product-model.js';

// All the versions of all the products, loaded from files at start-up (document sections 7 and 18).
export interface ProductCatalogue {
  products(): string[];
  versionsOf(product: string): ProductFile[]; // oldest first
  versionInForce(product: string, date: string): ProductFile | null; // new business uses the version in force on the start date
  latest(product: string): ProductFile | null;
}

// Checks that the schema cannot express: things that must agree with each other inside one product version.
function crossCheck(file: string, product: ProductFile): string[] {
  const errors: string[] = [];
  const coverages = product.line.coverages;
  const byCode = new Map(coverages.map((c) => [c.code, c]));

  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const c of coverages) (seen.has(c.code) ? repeated : seen).add(c.code);
  if (repeated.size > 0) errors.push(`${file}: a coverage code is used more than once: ${[...repeated].join(', ')}`);

  for (const c of coverages) {
    for (const other of c.requires ?? []) {
      if (other === c.code) errors.push(`${file}: ${c.code} cannot require itself`);
      else if (!byCode.has(other)) errors.push(`${file}: ${c.code} requires ${other}, which is not a coverage of this product`);
    }
    for (const other of c.excludes ?? []) {
      if (other === c.code) errors.push(`${file}: ${c.code} cannot exclude itself`);
      else if (!byCode.has(other)) errors.push(`${file}: ${c.code} excludes ${other}, which is not a coverage of this product`);
      // Two required coverages that exclude each other can never both be satisfied.
      else if (c.existence === 'required' && byCode.get(other)?.existence === 'required') {
        errors.push(`${file}: ${c.code} and ${other} are both required but ${c.code} excludes ${other}`);
      }
    }
    if (c.available_when !== undefined) {
      try {
        parseExpression(c.available_when);
      } catch (error) {
        if (!(error instanceof ExpressionError)) throw error;
        errors.push(`${file}: ${c.code}: available_when is not a valid expression (${error.message})`);
      }
    }
  }
  return errors;
}

// The versions of one product must start on different dates, and a higher version must start later.
function checkVersionOrder(versions: ProductFile[]): string[] {
  const errors: string[] = [];
  const sorted = [...versions].sort((a, b) => a.version.localeCompare(b.version));
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1];
    const after = sorted[i];
    if (!before || !after) continue;
    if (after.effective_from === before.effective_from) {
      errors.push(`${after.product}: versions ${before.version} and ${after.version} start on the same date (${after.effective_from})`);
    } else if (after.effective_from < before.effective_from) {
      errors.push(`${after.product}: version ${after.version} starts on an earlier date (${after.effective_from}) than version ${before.version} (${before.effective_from})`);
    }
  }
  return errors;
}

// Reads every product file in a folder and checks it. If anything is wrong, throws a ValidationError that lists
// every problem found in every file, so the whole set can be fixed in one go.
export function loadProductCatalogue(folder: string): ProductCatalogue {
  if (!existsSync(folder)) throw new ValidationError([`Product folder ${folder} not found`]);
  const fileNames = readdirSync(folder).filter((name) => name.endsWith('.json')).sort();
  if (fileNames.length === 0) throw new ValidationError([`There are no product files in ${folder}`]);

  const versions: ProductFile[] = [];
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

    const parsed = productFileSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${file}: ${issue.path.map(String).join('.') || 'file'}: ${issue.message}`);
      continue;
    }

    const expectedName = `${parsed.data.product.toLowerCase()}-${parsed.data.version}.json`;
    if (file !== expectedName) {
      errors.push(`${file}: the file should be named ${expectedName}`);
      continue;
    }

    const problems = crossCheck(file, parsed.data);
    if (problems.length > 0) {
      errors.push(...problems);
      continue;
    }
    versions.push(parsed.data);
  }

  const byProduct = new Map<string, ProductFile[]>();
  for (const version of versions) byProduct.set(version.product, [...(byProduct.get(version.product) ?? []), version]);
  for (const list of byProduct.values()) errors.push(...checkVersionOrder(list));

  if (errors.length > 0) throw new ValidationError(errors);

  const sortedByDate = (code: string): ProductFile[] =>
    [...(byProduct.get(code) ?? [])].sort((a, b) => a.effective_from.localeCompare(b.effective_from));

  return {
    products: () => [...byProduct.keys()].sort(),
    versionsOf: sortedByDate,
    versionInForce: (code, date) => sortedByDate(code).filter((v) => v.effective_from <= date).at(-1) ?? null,
    latest: (code) => sortedByDate(code).at(-1) ?? null,
  };
}
