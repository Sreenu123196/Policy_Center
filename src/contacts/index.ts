// Contacts module (document section 16): one record per person or company,
// shared by Policy, Billing and Claims through its id. This file is the module's public door.
export { createContact, getContact } from './repository.js';
export type { Address, Contact, ContactKind, NewContact } from './contact.js';
