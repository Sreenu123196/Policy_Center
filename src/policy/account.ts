// Accounts (document section 5): the customer relationship. An account has a number, a status, a producer
// of record, and contacts with roles. Names and addresses stay in the Contacts module.

// The roles a contact can have on an account. A typelist (step C4) will manage this list later.
export const ACCOUNT_CONTACT_ROLES = ['named_insured', 'driver', 'financier', 'billing_contact'] as const;
export type AccountContactRole = (typeof ACCOUNT_CONTACT_ROLES)[number];

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
