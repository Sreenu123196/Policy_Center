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
