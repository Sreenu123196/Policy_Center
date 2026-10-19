'use strict';
// Personal data (DPDP-style): a copy of what is held about a person, and erasure. Erasure here means removing the identity
// (names, contact details, date of birth, licence, address lines, vehicle numbers, free text) while the policy, claim and money
// records that the law makes us keep stay, under their numbers. Whether erasure is allowed, and for how long records must be kept,
// is a legal decision for the company: see docs/DATA-PROTECTION.md.
const { AppError } = require('./policyCenter');

const ERASED = '[erased]';
const SETTLED_POLICY = ['Cancelled', 'Expired'];
const CLOSED_CLAIM = ['Settled', 'Rejected'];
const CLOSED_TICKET = ['Resolved', 'Closed'];
const OPEN_JOB = ['Draft', 'Quoted'];

// Keys that hold an identity, wherever they sit in a record.
const BLANK_KEYS = new Set(['email', 'phone', 'dob', 'line1', 'licenseNumber', 'vin', 'insuredName']);
const NAME_KEYS = { firstName: 'Erased', lastName: 'Person' };
// Free text a person may have written a name or number into, by collection.
const FREE_TEXT = {
  claims: ['description', 'reason', 'closeReason', 'note', 'claimant'],
  tickets: ['subject', 'description', 'text'],
  followUps: ['notes'],
  messages: ['subject', 'body', 'to'],
  activities: ['description'],
};

function redact(value, freeKeys, parentKey = '') {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (item && typeof item === 'object') redact(item, freeKeys, parentKey);
      else if (typeof item === 'string' && freeKeys.includes(parentKey) && item) value[i] = ERASED;
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string' && v) {
      if (BLANK_KEYS.has(key)) value[key] = '';
      else if (NAME_KEYS[key]) value[key] = NAME_KEYS[key];
      else if (key === 'label' && /, age \d+/.test(v)) value[key] = v.replace(/\(([^)]*), age (\d+)\)/, '(age $2)').replace(/^[^(]*, age (\d+)$/, 'age $1'); // the rated driver's name in a rating worksheet
      else if (key === 'name' && parentKey === 'insured') value[key] = 'Erased Person';
      else if (freeKeys.includes(key)) value[key] = ERASED;
    } else if (v && typeof v === 'object') redact(v, freeKeys, key);
  }
}

const copy = (x) => JSON.parse(JSON.stringify(x));

class DataProtection {
  constructor(pc) {
    this.pc = pc;
  }

  get db() {
    return this.pc.db;
  }

  // Everything held that belongs to this account, as the records are stored.
  records(account) {
    const db = this.db;
    const policies = db.policies.filter((p) => p.accountId === account.id);
    const policyIds = new Set(policies.map((p) => p.id));
    return {
      account,
      policies,
      jobs: db.jobs.filter((j) => j.accountId === account.id),
      claims: db.claims.filter((c) => c.accountId === account.id || policyIds.has(c.policyId)),
      tickets: db.tickets.filter((t) => t.accountId === account.id),
      messages: db.messages.filter((m) => m.accountId === account.id),
      followUps: db.followUps.filter((f) => policyIds.has(f.policyId) || f.accountId === account.id),
      activities: db.activities.filter((a) => a.accountId === account.id),
      documents: db.documents.filter((d) => policyIds.has(d.policyId)),
      invoices: db.invoices.filter((i) => policyIds.has(i.policyId)),
      payments: db.payments.filter((p) => policyIds.has(p.policyId)),
      refunds: db.refunds.filter((r) => policyIds.has(r.policyId)),
    };
  }

  log(entry) {
    if (!this.db.dataRequests) this.db.dataRequests = [];
    // No personal data in the record of a request: the account number, who, when and why.
    this.db.dataRequests.push({ at: this.pc.now(), ...entry });
  }

  // A copy of the personal data, for the person who asks for it.
  export(accountId, user) {
    this.pc.requireAuthority(user, 2, 'export personal data');
    const account = this.pc.account(accountId, user);
    const data = copy(this.records(account));
    this.log({ type: 'export', accountNumber: account.accountNumber, by: user.id });
    return { exportedAt: this.pc.now(), accountNumber: account.accountNumber, ...data };
  }

  // What stops an erasure today.
  blockers(account) {
    const r = this.records(account);
    const why = [];
    if (r.policies.some((p) => !SETTLED_POLICY.includes(this.pc.policyStatus(p)))) why.push('a policy is still in force or pending, so the person has cover');
    if (r.claims.some((c) => !CLOSED_CLAIM.includes(c.status))) why.push('a claim is still open');
    if (r.jobs.some((j) => OPEN_JOB.includes(j.status))) why.push('a quote or submission is still open');
    if (r.tickets.some((t) => !CLOSED_TICKET.includes(t.status))) why.push('a ticket is still open');
    if (r.refunds.some((x) => x.status === 'Due')) why.push('a refund is still due to the person');
    return why;
  }

  erase(accountId, { confirm, reason } = {}, user) {
    this.pc.requireAuthority(user, 2, 'erase personal data');
    const account = this.pc.account(accountId, user);
    if (account.erasedAt) throw new AppError(409, 'The personal data of this account was already erased');
    if (confirm !== true) throw new AppError(422, 'Erasing cannot be undone: send confirm: true to go ahead');
    const why = String(reason || '').trim();
    if (!why) throw new AppError(422, 'Give a reason for erasing the data (for example, the customer\'s request and its date)');
    const blocked = this.blockers(account);
    if (blocked.length) throw new AppError(422, `This account cannot be erased yet: ${blocked.join('; ')}`);

    const r = this.records(account);
    redact(account, []);
    account.erasedAt = this.pc.now();
    account.erasedBy = user.id;
    for (const [collection, records] of Object.entries(r)) {
      if (collection === 'account') continue;
      for (const record of records) redact(record, FREE_TEXT[collection] || []);
    }
    // Events and remembered answers that carry the name or address.
    for (const e of this.db.events) if (e.payload && e.payload.accountNumber === account.accountNumber) redact(e.payload, ['name']);
    for (const [key, entry] of Object.entries(this.db.idempotency || {})) {
      const text = JSON.stringify(entry.response || {});
      if (text.includes(account.id) || text.includes(account.accountNumber)) delete this.db.idempotency[key];
    }
    this.log({ type: 'erase', accountNumber: account.accountNumber, by: user.id, reason: why });
    return { erased: true, accountNumber: account.accountNumber, kept: 'policy, claim and money records, under their numbers, without the identity' };
  }

  requests(user) {
    this.pc.requireAuthority(user, 2, 'see data requests');
    return [...(this.db.dataRequests || [])].reverse();
  }
}

module.exports = { DataProtection };
