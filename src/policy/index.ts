// Policy module (document sections 5 to 11): accounts, product model, jobs, effective dating,
// rating, underwriting and documents. This file is the module's public door. Built from step C2 onwards.
export { addAccountContact, createAccount, getAccount, listAccounts } from './account-repository.js';
export { NAMED_INSURED } from './account.js';
export type { Account, AccountContact, AccountContactRole, NewAccount } from './account.js';
export { loadProductCatalogue } from './product-catalogue.js';
export type { ProductCatalogue } from './product-catalogue.js';
export type { ProductCoverage, ProductFile, ProductTerm } from './product-model.js';
export { availableCoverages, defaultSelection, validateSelection } from './product-selection.js';
export type { Facts, Selection } from './product-selection.js';
export { addCoverable, addCoverage, createBranch, createPolicy, getBranch, getBranchAsOf, getJob, getPolicy, startJob } from './policy-repository.js';
export type { NewCoverable, NewCoverage } from './policy-repository.js';
export { COVERABLE_KINDS, JOB_TYPES } from './policy.js';
export type { Branch, BranchAsOf, BranchStatus, CoverableKind, CoverableSlice, CoverageSlice, Job, JobStatus, JobType, Policy } from './policy.js';
export { allowedNextStatuses, isFinalStatus } from './job-status.js';
export type { Quote, QuoteDependencies, QuoteRequest, QuoteResult, Quoter, WorksheetLine } from './quote.js';
export { addQuoteOption, compareQuotes, declineJob, markNotTaken, quoteBranch, startSubmission, withdrawJob } from './submission.js';
export { loadRateBooks } from './rate-book.js';
export type { RateBook, RateBookCatalogue } from './rate-book.js';
export { createQuoter } from './rating.js';
export { loadUnderwritingRules } from './uw-rules.js';
export type { CheckPoint, UwRules, UwRulesCatalogue } from './uw-rules.js';
export { checkUnderwriting, decideIssue, evaluateRules, listIssues, listReferrals, requestApproval } from './underwriting.js';
export type { DecisionInput, DecisionKind, IssueStatus, Referral, UnderwritingDependencies, UwDecision, UwIssue } from './underwriting.js';
