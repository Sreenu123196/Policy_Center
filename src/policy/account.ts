// Accounts (document section 5): the customer relationship. An account has a number, a status, a producer
// of record, and contacts with roles. Names and addresses stay in the Contacts module.

// The roles a contact can have on an account come from the account_contact_role typelist
// (document section 18), so a new role is a configuration release, not a code change.
export type AccountContactRole = string;

// The one role the code itself relies on: every account has exactly one named insured. That is a
// business rule, not configuration.
export const NAMED_INSURED = 'named_insured';

export interface AccountContact {
  contactId: string;
  role: AccountContactRole;
}

export interface NewAccount {
  namedInsuredContactId: string;
  producerCode: string;
}

export interface Account {
  id: string;
  accountNumber: string; // for example AC-0000001
  status: 'active' | 'closed';
  producerCode: string;
  contacts: AccountContact[]; // the named insured first
  createdBy: string;
  createdAt: string;
}
