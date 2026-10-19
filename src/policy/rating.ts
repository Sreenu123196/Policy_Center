import { ValidationError } from '../platform/index.js';
import type { RateBook, RateBookCatalogue, RateRoutine, RateTable, RatingInput } from './rate-book.js';
import type { Quoter, QuoteRequest, QuoteResult, WorksheetLine } from './quote.js';

// The rating engine (document section 9). It is a pure function: the same request and rate book always give the same
// price, and nothing is read from or written to anywhere. Every step is written to the worksheet.

type Inputs = Partial<Record<RatingInput, number>>;

// Does one key of a table row match? A number must be equal; a range includes both its ends.
const matches = (rule: number | { min?: number | undefined; max?: number | undefined }, value: number): boolean =>
  typeof rule === 'number' ? rule === value : (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max);

// The routine asks for named inputs; this finds each one on the quote, or says what is missing.
function findInputs(request: QuoteRequest): { inputs: Inputs; problems: Partial<Record<RatingInput, string>> } {
  const inputs: Inputs = {};
  const problems: Partial<Record<RatingInput, string>> = {};
  const vehicle = request.branch.coverables.find((c) => c.kind === 'Vehicle');
  const od = request.selection.MOTOR_OD;

  const idv = od?.idv;
  if (typeof idv === 'number') inputs.idv = idv;
  else problems.idv = 'The insured value (idv) of own damage is needed';
  const deductible = od?.vol_deductible;
  inputs.vol_deductible = typeof deductible === 'number' ? deductible : 0;

  const engineCc = vehicle?.attributes.engineCc;
  if (typeof engineCc === 'number' && Number.isInteger(engineCc) && engineCc > 0) inputs.engine_cc = engineCc;
  else problems.engine_cc = 'The vehicle needs an engine size in cc (engineCc)';

  const ageYears = (request.facts.vehicle as { ageYears?: unknown } | undefined)?.ageYears;
  if (typeof ageYears === 'number') inputs.vehicle_age_years = ageYears;
  else problems.vehicle_age_years = 'The age of the vehicle is needed';

  // No claims history recorded means no claim-free years: the customer gets no discount, never a wrong one.
  const claimFree = vehicle?.attributes.claimFreeYears;
  inputs.claim_free_years = typeof claimFree === 'number' && Number.isInteger(claimFree) && claimFree >= 0 ? claimFree : 0;
  return { inputs, problems };
}

function lookup(book: RateBook, tableName: string, t: RateTable, values: number[]): { value: number; label: string } {
  const found = t.rows.filter((row) => t.keys.every((key, i) => matches(row.when[key] ?? Number.NaN, values[i] ?? Number.NaN)));
  const label = t.keys.map((key, i) => `${key}=${values[i]}`).join(', ');
  if (found.length === 0) throw new ValidationError([`Rate book ${book.rate_book}: table ${tableName} has no row for ${label}`]);
  if (found.length > 1) throw new ValidationError([`Rate book ${book.rate_book}: table ${tableName} has more than one row for ${label}`]);
  return { value: found[0]?.value ?? 0, label };
}

// Runs one routine for one coverage and returns its cost. Each step adds a line to the worksheet.
function runRoutine(book: RateBook, code: string, routine: RateRoutine, found: ReturnType<typeof findInputs>, worksheet: WorksheetLine[]): number {
  const vars = new Map<string, number>();
  const get = (variable: string): number => vars.get(variable) ?? 0; // the rate book check guarantees it is defined
  const line = (step: string, note: string, amountPaise?: number): void => {
    worksheet.push(amountPaise === undefined ? { step: `${code}: ${step}`, note } : { step: `${code}: ${step}`, note, amountPaise });
  };

  for (const s of routine.steps) {
    switch (s.op) {
      case 'input': {
        const problem = found.problems[s.name];
        if (problem !== undefined) throw new ValidationError([problem]); // the same missing input is reported once, however many coverages need it
        vars.set(s.as, found.inputs[s.name] ?? 0);
        break;
      }
      case 'constant':
        vars.set(s.as, book.constants[s.name] ?? 0);
        line(`constant ${s.as}`, `${s.name} = ${book.constants[s.name]}`);
        break;
      case 'lookup': {
        const t = book.tables[s.table];
        if (!t) break;
        const result = lookup(book, s.table, t, s.by.map(get));
        vars.set(s.as, result.value);
        line(`lookup ${s.as}`, `${s.table} by ${result.label} -> ${result.value}`);
        break;
      }
      case 'multiply_bps': {
        const result = Math.round((get(s.value) * get(s.rate)) / 10000);
        vars.set(s.as, result);
        line(`multiply ${s.as}`, `${s.value} ${get(s.value)} x ${s.rate} ${get(s.rate)} bps`, result);
        break;
      }
      case 'discount_bps': {
        const result = get(s.value) - Math.round((get(s.value) * get(s.rate)) / 10000);
        vars.set(s.as, result);
        line(`discount ${s.as}`, `${s.value} ${get(s.value)} less ${s.rate} ${get(s.rate)} bps`, result);
        break;
      }
      case 'subtract': {
        const result = get(s.a) - get(s.b);
        vars.set(s.as, result);
        line(`subtract ${s.as}`, `${s.a} ${get(s.a)} - ${s.b} ${get(s.b)}`, result);
        break;
      }
      case 'minimum': {
        const result = Math.max(get(s.value), get(s.min));
        vars.set(s.as, result);
        line(`minimum ${s.as}`, `${s.value} ${get(s.value)}, minimum ${get(s.min)}`, result);
        break;
      }
      case 'round_rupee': {
        const result = Math.round(get(s.value) / 100) * 100;
        vars.set(s.as, result);
        line(`round ${s.as}`, `${s.value} ${get(s.value)} to the nearest rupee`, result);
        break;
      }
    }
  }
  const cost = get(routine.output);
  worksheet.push({ step: `cost ${code}`, note: `${code} for the whole period`, amountPaise: cost });
  return cost;
}

// Builds the quoter that the quote process uses (see quote.ts). It chooses the rate book from the product and the
// start date, prices each chosen coverage with its routine, then adds tax as a separate item.
export function createQuoter(rateBooks: RateBookCatalogue): Quoter {
  return (request: QuoteRequest): QuoteResult => {
    const start = request.branch.branch.periodStart;
    const book = rateBooks.forProduct(request.productVersion.product, start);
    if (book === null) throw new ValidationError([`There is no active rate book for ${request.productVersion.product} on ${start}`]);

    const found = findInputs(request);
    const worksheet: WorksheetLine[] = [{ step: 'rate book', note: `${book.rate_book} for product version ${book.version}` }];
    const errors: string[] = [];
    let premiumPaise = 0;
    for (const code of Object.keys(request.selection)) {
      const routine = book.routines[code];
      if (!routine) {
        errors.push(`${code} has no rating routine in rate book ${book.rate_book}`);
        continue;
      }
      try {
        premiumPaise += runRoutine(book, code, routine, found, worksheet);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        errors.push(...error.errors);
      }
    }
    if (errors.length > 0) throw new ValidationError([...new Set(errors)]);

    // Tax is its own cost item on the total premium (document section 9, step 4).
    const taxPaise = Math.round((premiumPaise * book.tax.rate_bps) / 10000);
    worksheet.push({ step: book.tax.name, note: `${book.tax.rate_bps} bps of premium ${premiumPaise}`, amountPaise: taxPaise });
    return { premiumPaise, taxPaise, rateBook: book.rate_book, worksheet };
  };
}
