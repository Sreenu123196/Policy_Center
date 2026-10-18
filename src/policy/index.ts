// Policy module (document sections 5 to 11): accounts, product model, jobs, effective dating,
// rating, underwriting and documents. This file is the module's public door. Built from step C2 onwards.
export { addAccountContact, createAccount, getAccount, listAccounts } from './account-repository.js';
export { ACCOUNT_CONTACT_ROLES } from './account.js';
export type { Account, AccountContact, AccountContactRole, NewAccount } from './account.js';
