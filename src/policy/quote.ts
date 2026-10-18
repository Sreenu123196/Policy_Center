import type { BranchAsOf } from './policy.js';
import type { ProductCatalogue } from './product-catalogue.js';
import type { ProductFile } from './product-model.js';
import type { Facts, Selection } from './product-selection.js';

// What the rating needs to price a branch (document section 9). The real rating engine is built in step D4.
export interface QuoteRequest {
  branch: BranchAsOf; // the branch as it was on its start date
  productVersion: ProductFile; // the product version the branch was sold on
  facts: Facts; // what we know about the risk
  selection: Selection; // the coverages chosen, with their terms
}

// One step of the calculation, kept so the price can be explained later.
export interface WorksheetLine {
  step: string;
  note: string;
  amountPaise?: number;
}

export interface QuoteResult {
  premiumPaise: number; // whole paise
  taxPaise: number;
  rateBook: string;
  worksheet: WorksheetLine[];
}

// Rating is a pure function: the same request always gives the same price. It is passed in, so the quote process
// can be tested with a stand-in price now, and the real rating plugged in at step D4.
export type Quoter = (request: QuoteRequest) => QuoteResult;

export interface QuoteDependencies {
  catalogue: ProductCatalogue;
  quoter: Quoter;
}

// A price given to a customer. Permanent: a new price is a new quote, the old one stays as history.
export interface Quote {
  id: string;
  branchId: string;
  premiumPaise: number;
  taxPaise: number;
  totalPaise: number;
  currency: 'INR';
  validUntil: string; // the last day the price can be accepted
  rateBook: string;
  worksheet: WorksheetLine[];
  createdBy: string;
  createdAt: string;
}
