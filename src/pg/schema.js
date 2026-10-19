'use strict';
// Where each collection lives in PostgreSQL. The JSON file saved the whole book on every write (docs/PERFORMANCE.md);
// here a record is a row, and a write touches only the rows it changes.
//
// Three shapes, because the app has three kinds of collection:
//   rows      one row per record, keyed by the record's own id (the audit log keeps a sequence number instead)
//   kv        settings held as an object; one row per key, written only when that key changes
//   documents small lists without a key of their own (month closings, the log of data requests); kept as one document
// Table names are prefixed pc_ so the database can hold other things too.

const ROW_COLLECTIONS = {
  accounts: 'id',
  policies: 'id',
  jobs: 'id',
  activities: 'id',
  invoices: 'id',
  payments: 'id',
  refunds: 'id',
  ledger: 'id',
  eventFailures: 'id',
  documents: 'id',
  events: 'id',
  claims: 'id',
  followUps: 'id',
  messages: 'id',
  tickets: 'id',
  staff: 'id',
  agentSuggestions: 'id',
  auditLog: 'seq', // an audit entry has a sequence number and no id (src/audit.js); entries are only ever added
};

const DOC_COLLECTIONS = ['closings', 'dataRequests'];

const KV_COLLECTIONS = ['seq', 'producerRates', 'eventConsumers', 'idempotency', 'agentConfig', 'finance'];

// How the tracker and the store treat each collection. A collection that is not listed is written whole (doc), so a new
// one added to src/store.js is never lost before it gets a table of its own.
const KINDS = {};
for (const [name, key] of Object.entries(ROW_COLLECTIONS)) KINDS[name] = { kind: 'rows', key };
for (const name of KV_COLLECTIONS) KINDS[name] = { kind: 'kv' };
for (const name of DOC_COLLECTIONS) KINDS[name] = { kind: 'doc' };

// PostgreSQL folds an unquoted name to lower case, so the names are built in snake_case once and used everywhere.
const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const tableFor = (name) => snake(`pc_${name}`);
const kvTableFor = (name) => snake(`pc_kv_${name}`);
const DOCS_TABLE = 'pc_docs';
const META_TABLE = 'pc_meta';

// The searches the screens and the reports make. An expression index on the JSON document keeps the record shape the
// app already uses (no mapping layer) while the search stays indexed.
const INDEXES = [
  { name: 'pc_accounts_number', table: tableFor('accounts'), column: 'accountNumber' },
  { name: 'pc_accounts_last_name', table: tableFor('accounts'), column: 'lastName' },
  { name: 'pc_accounts_email', table: tableFor('accounts'), column: 'email' },
  { name: 'pc_policies_number', table: tableFor('policies'), column: 'policyNumber' },
  { name: 'pc_policies_account', table: tableFor('policies'), column: 'accountId' },
  { name: 'pc_policies_status', table: tableFor('policies'), column: 'status' },
  { name: 'pc_policies_product', table: tableFor('policies'), column: 'product' },
  { name: 'pc_jobs_number', table: tableFor('jobs'), column: 'jobNumber' },
  { name: 'pc_jobs_policy', table: tableFor('jobs'), column: 'policyId' },
  { name: 'pc_jobs_account', table: tableFor('jobs'), column: 'accountId' },
  { name: 'pc_jobs_status', table: tableFor('jobs'), column: 'status' },
  { name: 'pc_invoices_policy', table: tableFor('invoices'), column: 'policyId' },
  { name: 'pc_invoices_status', table: tableFor('invoices'), column: 'status' },
  { name: 'pc_invoices_due', table: tableFor('invoices'), column: 'dueDate' },
  { name: 'pc_payments_invoice', table: tableFor('payments'), column: 'invoiceId' },
  { name: 'pc_claims_number', table: tableFor('claims'), column: 'claimNumber' },
  { name: 'pc_claims_policy', table: tableFor('claims'), column: 'policyId' },
  { name: 'pc_claims_status', table: tableFor('claims'), column: 'status' },
  { name: 'pc_activities_status', table: tableFor('activities'), column: 'status' },
  { name: 'pc_activities_assignee', table: tableFor('activities'), column: 'assigneeId' },
  { name: 'pc_documents_policy', table: tableFor('documents'), column: 'policyId' },
  { name: 'pc_events_event', table: tableFor('events'), column: 'eventId' },
  { name: 'pc_events_type', table: tableFor('events'), column: 'type' },
  { name: 'pc_messages_policy', table: tableFor('messages'), column: 'policyId' },
  { name: 'pc_suggestions_status', table: tableFor('agentSuggestions'), column: 'status' },
];

// Built once and run in order; every statement is safe to run again, so a start repairs a half-made schema.
function schemaStatements() {
  const statements = [
    `create table if not exists ${META_TABLE} (key text primary key, value jsonb not null)`,
    `create table if not exists ${DOCS_TABLE} (key text primary key, doc jsonb not null, updated_at timestamptz not null default now())`,
  ];
  for (const name of Object.keys(ROW_COLLECTIONS)) {
    statements.push(`create table if not exists ${tableFor(name)} (id text primary key, doc jsonb not null, updated_at timestamptz not null default now())`);
  }
  // A document collection shares pc_docs, keyed by its name: one row holding the whole small list.
  for (const name of KV_COLLECTIONS) statements.push(`create table if not exists ${kvTableFor(name)} (key text primary key, doc jsonb not null, updated_at timestamptz not null default now())`);
  for (const index of INDEXES) statements.push(`create index if not exists ${index.name} on ${index.table} ((doc->>'${index.column}'))`);
  return statements;
}

module.exports = {
  ROW_COLLECTIONS, DOC_COLLECTIONS, KV_COLLECTIONS, KINDS, INDEXES,
  tableFor, kvTableFor, DOCS_TABLE, META_TABLE, schemaStatements,
};
