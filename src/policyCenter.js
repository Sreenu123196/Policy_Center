'use strict';
// PolicyCenter application service: accounts, the job framework (Submission, PolicyChange,
// Renewal, Cancellation, Reinstatement), underwriting referrals, and the downstream effects of
// binding (policy versions, transactions, billing, documents, integration events).

const { PRODUCTS, USERS, PRODUCER_CODES, normalizeCoverages } = require('./productModel');
const { rate, replacementCostEstimate, round2 } = require('./rating');
const { validateAccount, validatePeriod } = require('./validation');
const { evaluateUW, applyApprovals } = require('./uwRules');
const D = require('./dates');
const { salesScope, canSeeClaimReserves, canSeeBilling, canSeeSales, canLogFollowUps, canSeeClaimsReport, canSeeBillingReport } = require('./permissions');
const { hashPassword, verifyPassword, temporaryPassword } = require('./passwords');

// Authority levels for each staff role (see permissions.js).
const STAFF_ROLES = { Agent: 0, Underwriter: 1, 'Insurance Executive': 1, 'UW Manager': 2 };

const FOLLOW_UP_CHANNELS = ['Phone', 'Email', 'SMS', 'Visit', 'Letter'];
const FOLLOW_UP_RESULTS = ['Interested', 'Callback requested', 'No answer', 'Not reachable', 'Declined', 'Renewed', 'Other'];
const LAPSING_WINDOW_DAYS = 60; // a policy whose term ends within this many days is lapsing
const LAPSED_WINDOW_DAYS = 90;  // a policy whose term ended this many days ago, not renewed, is lapsed

const CLAIM_TYPES = ['Collision', 'Comprehensive', 'Liability', 'Medical', 'Property', 'Theft', 'Water', 'Wind or hail', 'Other'];

// Claim stages and what each stage may move to.
const CLAIM_TRANSITIONS = {
  Submitted: ['Under Review', 'Rejected'],
  'Under Review': ['Documents Pending', 'Approved', 'Rejected'],
  'Documents Pending': ['Under Review'],
  Approved: ['Settled'],
  Rejected: [],
  Settled: [],
};

// Ticket response deadlines in hours, and ticket stages.
const TICKET_HOURS = { Urgent: 4, High: 24, Normal: 48, Low: 120 };
const TICKET_CATEGORIES = ['Claim', 'Billing', 'Policy change', 'Other'];
const TICKET_TRANSITIONS = {
  Open: [],
  Assigned: ['In Progress'],
  'In Progress': ['Resolved'],
  Resolved: ['Closed', 'In Progress'],
  Closed: [],
};
const PREMIUM_THRESHOLD = 3000; // total current term premium (with tax) that makes a customer a premium customer

class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const OPEN = ['Draft', 'Quoted'];
const EDITABLE_TYPES = ['Submission', 'PolicyChange', 'Renewal'];
const clone = (o) => JSON.parse(JSON.stringify(o));
const str = (v) => (v == null ? '' : String(v).trim());
const int = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r100 = (n) => Math.round(n / 100) * 100;

const CANCEL_REASONS = {
  InsuredRequest: { name: 'Insured request', noticeDays: 0, authority: 0 },
  NonPayment: { name: 'Non-payment of premium', noticeDays: 10, authority: 0 },
  UnderwritingReasons: { name: 'Underwriting reasons', noticeDays: 30, authority: 1 },
  Fraud: { name: 'Material misrepresentation', noticeDays: 0, authority: 2 },
};
const SHORT_RATE_FACTOR = 0.9;
const RENEWAL_WINDOW_DAYS = 120;

class PolicyCenter {
  constructor(store, { today } = {}) {
    this.clockMs = null;
    this.store = store;
    this.today = today || D.todayISO;
    // The staff list starts from the built-in team; accounts created later are added to it.
    if (!this.db.staff.length) {
      for (const u of USERS) this.db.staff.push({ id: u.id, username: u.id, name: u.name, role: u.role, authority: u.authority, producerCode: u.producerCode || null, reportsTo: u.reportsTo || null, active: true, passwordHash: null, mustChangePassword: false });
    }
  }

  // First start only: the first person to open the app chooses a username and password for Sudhakar's
  // UW Manager account. Works only while no account has a password yet.
  setupFirstManager({ username, password }) {
    if (this.db.staff.some((x) => x.passwordHash)) throw new AppError(409, 'The app is already set up. Sign in instead.');
    const uname = String(username || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9.]{2,29}$/.test(uname)) throw new AppError(422, 'Username: 3 to 30 letters, numbers or dots, starting with a letter');
    if (String(password || '').length < 8) throw new AppError(422, 'The password needs at least 8 characters');
    const manager = this.staffById('sudhakar') || this.db.staff.find((x) => x.role === 'UW Manager');
    if (!manager) throw new AppError(500, 'No UW Manager account exists to set up');
    const oldId = manager.id;
    manager.id = uname;
    manager.username = uname;
    for (const x of this.db.staff) if (x.reportsTo === oldId) x.reportsTo = uname;
    manager.passwordHash = hashPassword(password);
    manager.mustChangePassword = false;
    return this.userView(manager);
  }

  setupNeeded() {
    return !this.db.staff.some((x) => x.passwordHash);
  }

  get db() {
    return this.store.data;
  }

  // Real time, unless a test has fixed it with clockMs.
  nowMs() {
    return this.clockMs ?? Date.now();
  }

  now() {
    return new Date(this.nowMs()).toISOString();
  }

  // ------------------------------------------------------------------ users & security

  user(id) {
    const u = this.staffById(id);
    if (!u) throw new AppError(401, `Unknown user '${id}'`);
    return u;
  }

  requireAuthority(user, level, what) {
    if (user.authority < level) throw new AppError(403, `${user.role} does not have authority to ${what}`);
  }

  canSee(user, account) {
    return user.role !== 'Agent' || account.producerCode === user.producerCode;
  }

  // ------------------------------------------------------------------ accounts

  account(id, user) {
    const a = this.db.accounts.find((x) => x.id === id || x.accountNumber === id);
    if (!a || (user && !this.canSee(user, a))) throw new AppError(404, 'Account not found');
    return a;
  }

  accountInput(input) {
    const addr = input.address || {};
    return {
      firstName: str(input.firstName),
      lastName: str(input.lastName),
      dob: str(input.dob),
      email: str(input.email),
      phone: str(input.phone),
      address: { line1: str(addr.line1), city: str(addr.city), state: str(addr.state).toUpperCase(), zip: str(addr.zip) },
      producerCode: str(input.producerCode),
    };
  }

  createAccount(input, user) {
    const a = this.accountInput(input);
    if (user.role === 'Agent') a.producerCode = user.producerCode;
    const errors = validateAccount(a);
    if (errors.length) throw new AppError(422, 'Account has validation errors', { errors });
    const account = {
      id: this.store.id('acc'),
      accountNumber: this.store.number('A', 7),
      type: 'Person',
      ...a,
      createdAt: this.now(),
      createdBy: user.id,
    };
    this.db.accounts.push(account);
    this.publish('AccountCreated', { accountNumber: account.accountNumber, name: this.accountName(account) });
    return account;
  }

  updateAccount(id, input, user) {
    const account = this.account(id, user);
    const a = this.accountInput({ ...account, ...input, address: { ...account.address, ...(input.address || {}) } });
    if (user.role === 'Agent') a.producerCode = account.producerCode;
    const errors = validateAccount(a);
    if (errors.length) throw new AppError(422, 'Account has validation errors', { errors });
    Object.assign(account, a, { updatedAt: this.now() });
    this.publish('AccountUpdated', { accountNumber: account.accountNumber });
    return account;
  }

  accountName(a) {
    return `${a.firstName} ${a.lastName}`;
  }

  listAccounts(q, user) {
    const s = str(q).toLowerCase();
    return this.db.accounts
      .filter((a) => this.canSee(user, a))
      .filter((a) => !s || [a.accountNumber, this.accountName(a), a.address.city, a.address.zip, a.email].join(' ').toLowerCase().includes(s))
      .map((a) => ({ ...a, name: this.accountName(a), policyCount: this.db.policies.filter((p) => p.accountId === a.id).length }));
  }

  accountDetail(id, user) {
    const account = this.account(id, user);
    return {
      account: { ...account, name: this.accountName(account), producerName: PRODUCER_CODES.find((p) => p.code === account.producerCode)?.name },
      policies: this.db.policies.filter((p) => p.accountId === id).map((p) => this.policySummary(p)),
      jobs: this.db.jobs.filter((j) => j.accountId === id).map((j) => this.jobSummary(j)).reverse(),
      activities: this.db.activities.filter((a) => a.accountId === id).reverse(),
      messages: this.db.messages.filter((m) => m.accountId === id).sort((a, b) => b.sentAt.localeCompare(a.sentAt)),
    };
  }

  // ------------------------------------------------------------------ policy helpers

  policy(id, user) {
    const p = this.db.policies.find((x) => x.id === id || x.policyNumber === id);
    if (!p) throw new AppError(404, 'Policy not found');
    if (user) this.account(p.accountId, user);
    return p;
  }

  terms(policy) {
    const byTerm = new Map();
    for (const v of policy.versions) {
      const t = byTerm.get(v.termNumber) || { termNumber: v.termNumber, effectiveDate: v.effectiveDate, expirationDate: v.expirationDate, versions: [] };
      t.versions.push(v);
      t.latest = v;
      byTerm.set(v.termNumber, t);
    }
    return [...byTerm.values()].sort((a, b) => a.termNumber - b.termNumber);
  }

  termContaining(policy, date) {
    return this.terms(policy).find((t) => t.effectiveDate <= date && date < t.expirationDate) || null;
  }

  lastTerm(policy) {
    const terms = this.terms(policy);
    return terms[terms.length - 1];
  }

  policyStatus(policy) {
    if (policy.cancellation) return 'Cancelled';
    const today = this.today();
    const terms = this.terms(policy);
    if (today < terms[0].effectiveDate) return 'Scheduled';
    if (today >= terms[terms.length - 1].expirationDate) return 'Expired';
    return 'In Force';
  }

  currentVersion(policy) {
    const t = this.termContaining(policy, this.today());
    if (t) return t.latest;
    const terms = this.terms(policy);
    return this.today() < terms[0].effectiveDate ? terms[0].latest : terms[terms.length - 1].latest;
  }

  policySummary(p) {
    const v = this.currentVersion(p);
    const account = this.db.accounts.find((a) => a.id === p.accountId);
    return {
      id: p.id,
      policyNumber: p.policyNumber,
      product: p.product,
      accountId: p.accountId,
      insuredName: account ? this.accountName(account) : '',
      status: this.policyStatus(p),
      termNumber: v.termNumber,
      effectiveDate: v.effectiveDate,
      expirationDate: v.expirationDate,
      // Premium plus taxes; fees are excluded so the figure is comparable across versions.
      termPremium: round2(v.quote.premium + v.quote.taxes),
      form: p.product === 'Homeowners' ? v.period.line.form : null,
    };
  }

  // Another product of the same account in force on the date (drives the multi-policy discount).
  hasOtherProductInForce(accountId, product, date) {
    return this.db.policies.some((p) => p.accountId === accountId && p.product !== product && !p.cancellation && this.termContaining(p, date));
  }

  assertNotCancelled(policy) {
    if (policy.cancellation) throw new AppError(409, `Policy ${policy.policyNumber} is cancelled`);
  }

  assertNoOpenJob(policy) {
    const open = this.db.jobs.find((j) => j.policyId === policy.id && OPEN.includes(j.status));
    if (open) throw new AppError(409, `Policy has an open ${open.type} (${open.jobNumber}). Bind or withdraw it first.`);
  }

  // ------------------------------------------------------------------ jobs

  job(id, user) {
    const j = this.db.jobs.find((x) => x.id === id || x.jobNumber === id);
    if (!j) throw new AppError(404, 'Job not found');
    if (user) this.account(j.accountId, user);
    return j;
  }

  jobSummary(j) {
    const account = this.db.accounts.find((a) => a.id === j.accountId);
    const policy = j.policyId && this.db.policies.find((p) => p.id === j.policyId);
    return {
      id: j.id,
      jobNumber: j.jobNumber,
      type: j.type,
      status: j.status,
      product: j.product,
      accountId: j.accountId,
      accountName: account ? this.accountName(account) : '',
      policyId: j.policyId,
      policyNumber: policy ? policy.policyNumber : null,
      effectiveDate: j.cancellation ? j.cancellation.effectiveDate : j.period.editEffectiveDate,
      amount: j.quote ? j.quote.changeAmount : null,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      createdBy: j.createdBy,
    };
  }

  jobDetail(id, user) {
    const job = this.job(id, user);
    const account = this.db.accounts.find((a) => a.id === job.accountId);
    const policy = job.policyId ? this.db.policies.find((p) => p.id === job.policyId) : null;
    return {
      ...job,
      account: { id: account.id, accountNumber: account.accountNumber, name: this.accountName(account), address: account.address },
      policy: policy ? this.policySummary(policy) : null,
      activities: this.db.activities.filter((a) => a.jobId === job.id),
    };
  }

  listJobs(user, { status } = {}) {
    return this.db.jobs
      .filter((j) => this.canSee(user, this.db.accounts.find((a) => a.id === j.accountId)))
      .filter((j) => !status || (status === 'open' ? OPEN.includes(j.status) : j.status === status))
      .map((j) => this.jobSummary(j))
      .reverse();
  }

  newJob(type, { accountId, product, period, policyId = null, basedOnVersionId = null, uwApprovals = {} }, user) {
    const job = {
      id: this.store.id('job'),
      jobNumber: this.store.number('J', 7),
      type,
      status: 'Draft',
      accountId,
      policyId,
      product,
      period,
      basedOnVersionId,
      uwApprovals,
      uwIssues: [],
      quote: null,
      notice: null,
      history: [],
      createdAt: this.now(),
      updatedAt: this.now(),
      createdBy: user.id,
    };
    this.db.jobs.push(job);
    this.log(job, user, `${type} started`);
    return job;
  }

  log(job, user, action, detail) {
    job.history.push({ at: this.now(), by: user.id, byName: user.name, action, detail: detail || null });
    job.updatedAt = this.now();
  }

  assertEditable(job) {
    if (!OPEN.includes(job.status)) throw new AppError(409, `${job.type} ${job.jobNumber} is ${job.status} and can no longer change`);
  }

  // ------------------------------------------------------------------ period construction

  newPeriod(product, account, effectiveDate) {
    const pm = PRODUCTS[product];
    const period = {
      termNumber: 1,
      effectiveDate,
      expirationDate: D.addMonths(effectiveDate, pm.termMonths),
      editEffectiveDate: effectiveDate,
      state: account.address.state,
      producerCode: account.producerCode,
      paymentPlan: 'PaidInFull',
      insured: { name: this.accountName(account), address: clone(account.address) },
      line: null,
    };
    if (product === 'GeneralLiability') {
      period.line = { businessName: '', claimsLast5Years: 0, exposures: [], lineCoverages: {} };
    } else if (product === 'CommercialAuto') {
      period.line = { businessName: '', drivers: [], vehicles: [], lineCoverages: {} };
    } else if (product === 'PersonalAuto') {
      period.line = {
        drivers: [{ firstName: account.firstName, lastName: account.lastName, dob: account.dob, licenseNumber: '', licenseState: account.address.state, yearsLicensed: null, accidents: 0, violations: 0, goodStudent: false }],
        vehicles: [],
      };
    } else {
      period.line = {
        form: 'HO3',
        dwelling: {
          line1: account.address.line1, city: account.address.city, zip: account.address.zip,
          yearBuilt: 2005, construction: 'Frame', squareFeet: 2000, stories: 2, roofAge: 8, protectionClass: 4, distanceToFireStation: 2,
          alarm: 'None', sprinklers: false, pool: false, poolFenced: false, trampoline: false, aggressiveDog: false, priorClaims: 0,
        },
        coverages: {},
      };
    }
    period.line = this.normalizeLine(product, period.line, period, null);
    return period;
  }

  normalizeLine(product, line, period, prevLine) {
    if (product === 'PersonalAuto') {
      const pm = PRODUCTS.PersonalAuto;
      const ctx = { state: period.state };
      return {
        drivers: (line.drivers || []).map((d) => ({
          id: d.id || this.store.id('drv'),
          firstName: str(d.firstName),
          lastName: str(d.lastName),
          dob: str(d.dob),
          licenseNumber: str(d.licenseNumber).toUpperCase(),
          licenseState: str(d.licenseState).toUpperCase(),
          yearsLicensed: int(d.yearsLicensed),
          accidents: int(d.accidents) ?? 0,
          violations: int(d.violations) ?? 0,
          goodStudent: !!d.goodStudent,
        })),
        vehicles: (line.vehicles || []).map((v) => ({
          id: v.id || this.store.id('veh'),
          year: int(v.year),
          make: str(v.make),
          model: str(v.model),
          vin: str(v.vin).toUpperCase(),
          usage: pm.usages.includes(v.usage) ? v.usage : 'Commute',
          annualMiles: int(v.annualMiles),
          marketValue: int(v.marketValue),
          garagingZip: str(v.garagingZip),
          coverages: normalizeCoverages(pm.vehicleCoverages, v.coverages, ctx),
        })),
        lineCoverages: normalizeCoverages(pm.lineCoverages, line.lineCoverages, ctx),
      };
    }

    if (product === 'GeneralLiability') {
      const pm = PRODUCTS.GeneralLiability;
      const ctx = { state: period.state };
      return {
        businessName: str(line.businessName),
        claimsLast5Years: int(line.claimsLast5Years) ?? 0,
        exposures: (line.exposures || []).map((x) => {
          const classCode = str(x.classCode);
          const cls = pm.classes.find((c) => c.code === classCode);
          return { id: x.id || this.store.id('exp'), classCode, description: str(x.description), base: cls ? cls.base : 'Sales', amount: int(x.amount) };
        }),
        lineCoverages: normalizeCoverages(pm.lineCoverages, line.lineCoverages, ctx),
      };
    }
    if (product === 'CommercialAuto') {
      const pm = PRODUCTS.CommercialAuto;
      const ctx = { state: period.state };
      return {
        businessName: str(line.businessName),
        drivers: (line.drivers || []).map((d) => ({
          id: d.id || this.store.id('drv'),
          firstName: str(d.firstName),
          lastName: str(d.lastName),
          dob: str(d.dob),
          licenseNumber: str(d.licenseNumber).toUpperCase(),
          licenseState: str(d.licenseState).toUpperCase(),
          yearsLicensed: int(d.yearsLicensed),
          accidents: int(d.accidents) ?? 0,
          violations: int(d.violations) ?? 0,
          goodStudent: false,
        })),
        vehicles: (line.vehicles || []).map((v) => ({
          id: v.id || this.store.id('veh'),
          year: int(v.year),
          make: str(v.make),
          model: str(v.model),
          vin: str(v.vin).toUpperCase(),
          usage: pm.usages.includes(v.usage) ? v.usage : 'Light',
          radius: pm.radiusClasses.includes(v.radius) ? v.radius : 'Local',
          marketValue: int(v.marketValue),
          garagingZip: str(v.garagingZip),
          coverages: normalizeCoverages(pm.vehicleCoverages, v.coverages, ctx),
        })),
        lineCoverages: normalizeCoverages(pm.lineCoverages, line.lineCoverages, ctx),
      };
    }

    const pm = PRODUCTS.Homeowners;
    const form = pm.forms.some((f) => f.code === line.form) ? line.form : 'HO3';
    const d = line.dwelling || {};
    const dwelling = {
      line1: str(d.line1),
      city: str(d.city),
      zip: str(d.zip),
      yearBuilt: int(d.yearBuilt),
      construction: pm.constructionTypes.includes(d.construction) ? d.construction : 'Frame',
      squareFeet: int(d.squareFeet),
      stories: int(d.stories),
      roofAge: int(d.roofAge),
      protectionClass: int(d.protectionClass),
      distanceToFireStation: num(d.distanceToFireStation),
      alarm: pm.alarmTypes.includes(d.alarm) ? d.alarm : 'None',
      sprinklers: !!d.sprinklers,
      pool: !!d.pool,
      poolFenced: !!d.pool && !!d.poolFenced,
      trampoline: !!d.trampoline,
      aggressiveDog: !!d.aggressiveDog,
      priorClaims: int(d.priorClaims) ?? 0,
    };

    // Coverage B/C/D default to percentages of A (or C for renters/condo). When the form or
    // Coverage A changes, the derived limits are recalculated.
    const covs = clone(line.coverages || {});
    const val = (code) => {
      const v = covs[code] && covs[code].terms ? covs[code].terms.limit : null;
      const n = Number(v);
      return v === '' || v == null || !Number.isFinite(n) ? null : Math.round(n);
    };
    const prevLimit = (code) => (prevLine && prevLine.coverages[code] ? prevLine.coverages[code].terms.limit ?? null : null);
    // Only limits the user left untouched are re-derived; an explicitly entered limit is kept.
    const resetUntouched = (codes) => codes.forEach((code) => {
      if (covs[code] && covs[code].terms && val(code) === prevLimit(code)) delete covs[code].terms.limit;
    });
    if (prevLine && prevLine.form !== form) resetUntouched(['HODwellingCov', 'HOOtherStructuresCov', 'HOPersonalPropertyCov', 'HOLossOfUseCov']);
    else if (prevLimit('HODwellingCov') != null && val('HODwellingCov') !== prevLimit('HODwellingCov')) resetUntouched(['HOOtherStructuresCov', 'HOPersonalPropertyCov', 'HOLossOfUseCov']);

    const owner = form === 'HO3' || form === 'HO5';
    const rce = replacementCostEstimate(period.state, dwelling.construction, dwelling.squareFeet, period.effectiveDate);
    const A = form === 'HO4' ? null : val('HODwellingCov') ?? (owner ? rce || 300000 : 60000);
    const C = val('HOPersonalPropertyCov') ?? (form === 'HO3' ? r100(A * 0.5) : form === 'HO5' ? r100(A * 0.7) : form === 'HO4' ? 30000 : 50000);
    const defaults = {
      HODwellingCov: A,
      HOOtherStructuresCov: owner ? r100(A * 0.1) : null,
      HOPersonalPropertyCov: C,
      HOLossOfUseCov: owner ? r100(A * 0.2) : r100(C * (form === 'HO4' ? 0.3 : 0.4)),
    };
    return { form, dwelling, coverages: normalizeCoverages(pm.coverages, covs, { state: period.state, form }, defaults) };
  }

  // ------------------------------------------------------------------ submission

  startSubmission({ accountId, product, effectiveDate }, user) {
    const account = this.account(accountId, user);
    if (!PRODUCTS[product]) throw new AppError(422, `Unknown product '${product}'`);
    const eff = effectiveDate || this.today();
    if (!D.isDate(eff)) throw new AppError(422, 'Effective date must be yyyy-mm-dd');
    return this.newJob('Submission', { accountId: account.id, product, period: this.newPeriod(product, account, eff) }, user);
  }

  updateDraft(jobId, patch, user) {
    const job = this.job(jobId, user);
    this.assertEditable(job);
    if (!EDITABLE_TYPES.includes(job.type)) throw new AppError(409, `${job.type} has no editable policy data`);
    const p = job.period;
    if (patch.effectiveDate !== undefined && patch.effectiveDate !== p.effectiveDate) {
      if (job.type !== 'Submission') throw new AppError(409, `The effective date of a ${job.type} cannot change`);
      if (!D.isDate(patch.effectiveDate)) throw new AppError(422, 'Effective date must be yyyy-mm-dd');
      p.effectiveDate = p.editEffectiveDate = patch.effectiveDate;
      p.expirationDate = D.addMonths(patch.effectiveDate, PRODUCTS[job.product].termMonths);
    }
    if (patch.paymentPlan !== undefined && patch.paymentPlan !== p.paymentPlan) {
      if (job.type === 'PolicyChange') throw new AppError(409, 'Payment plan changes are handled in billing, not in a policy change');
      if (!PRODUCTS[job.product].paymentPlans.some((pl) => pl.code === patch.paymentPlan)) throw new AppError(422, 'Unknown payment plan');
      p.paymentPlan = patch.paymentPlan;
    }
    if (patch.line !== undefined) p.line = this.normalizeLine(job.product, patch.line, p, p.line);
    job.status = 'Draft';
    job.quote = null;
    job.notice = null;
    job.updatedAt = this.now();
    return job;
  }

  ratingContext(job) {
    return {
      jobType: job.type,
      multiPolicy: this.hasOtherProductInForce(job.accountId, job.product, job.period.editEffectiveDate),
      includeFees: job.type !== 'PolicyChange',
    };
  }

  quote(jobId, user) {
    const job = this.job(jobId, user);
    this.assertEditable(job);
    if (!EDITABLE_TYPES.includes(job.type)) throw new AppError(409, `${job.type} is quoted when it starts`);
    const policy = job.policyId ? this.policy(job.policyId) : null;
    if (policy) this.assertNotCancelled(policy);
    const today = this.today();
    const errors = validatePeriod(job.product, job.period, { jobType: job.type, today });
    if (errors.length) throw new AppError(422, `Cannot quote: ${errors.length} validation error(s)`, { errors });

    job.uwIssues = applyApprovals(evaluateUW(job.product, job.period, { jobType: job.type, today }), job.uwApprovals);
    const blocksQuote = job.uwIssues.filter((i) => i.blockingPoint === 'BlocksQuote' && !i.approved);
    if (blocksQuote.length) {
      job.status = 'Draft';
      job.quote = null;
      const declined = blocksQuote.filter((i) => !i.approvable);
      job.notice = declined.length
        ? { level: 'error', text: `Risk is outside underwriting appetite: ${declined.map((i) => i.name).join(', ')}. Change the risk or decline the submission.` }
        : { level: 'warning', text: `Quote is blocked until an underwriter approves ${blocksQuote.length} issue(s). A referral was sent.` };
      this.refer(job, blocksQuote, user);
      this.log(job, user, 'Quote blocked by underwriting', blocksQuote.map((i) => i.name).join(', '));
      return job;
    }

    const r = rate(job.product, job.period, this.ratingContext(job));
    let changeAmount = r.total;
    let proration = null;
    if (job.type === 'PolicyChange') {
      const base = policy.versions.find((v) => v.versionId === job.basedOnVersionId);
      const oldTerm = base.quote.premium + base.quote.taxes;
      const newTerm = r.premium + r.taxes;
      const termDays = D.daysBetween(job.period.effectiveDate, job.period.expirationDate);
      const remainingDays = D.daysBetween(job.period.editEffectiveDate, job.period.expirationDate);
      changeAmount = round2(((newTerm - oldTerm) * remainingDays) / termDays);
      proration = { priorTermPremium: round2(oldTerm), newTermPremium: round2(newTerm), termDays, remainingDays, factor: Math.round((remainingDays / termDays) * 10000) / 10000 };
    }
    job.quote = { ...r, changeAmount, proration, quotedAt: this.now() };
    job.status = 'Quoted';

    const blocksBind = job.uwIssues.filter((i) => i.blockingPoint === 'BlocksBind' && !i.approved);
    if (blocksBind.length) {
      job.notice = { level: 'warning', text: `Quoted. ${blocksBind.length} underwriting issue(s) must be approved before bind; a referral was sent.` };
      this.refer(job, blocksBind, user);
    } else {
      job.notice = { level: 'success', text: `Quoted: ${job.type === 'PolicyChange' ? 'change in premium' : 'total cost'} $${changeAmount.toFixed(2)}` };
    }
    this.log(job, user, 'Quoted', `Total $${r.total.toFixed(2)} (rate book ${r.rateBook.code} ${r.rateBook.version})`);
    return job;
  }

  // ------------------------------------------------------------------ underwriting

  refer(job, issues, user) {
    const approvable = issues.filter((i) => i.approvable);
    const level = Math.max(1, ...approvable.map((i) => i.approvalLevel));
    const assignedTo = level >= 2 ? 'uwm' : 'uw';
    const description = issues.map((i) => `${i.name}: ${i.description}${i.approvable ? '' : ' (not approvable)'}`).join('\n');
    const existing = this.db.activities.find((a) => a.jobId === job.id && a.type === 'Referral' && a.status === 'Open');
    if (existing) {
      Object.assign(existing, { description, assignedTo, priority: level >= 2 ? 'High' : 'Normal', updatedAt: this.now() });
      return existing;
    }
    const activity = {
      id: this.store.id('act'),
      activityNumber: this.store.number('ACT-', 6),
      type: 'Referral',
      subject: `UW referral: ${job.type} ${job.jobNumber}`,
      description,
      jobId: job.id,
      jobNumber: job.jobNumber,
      accountId: job.accountId,
      policyId: job.policyId,
      assignedTo,
      status: 'Open',
      priority: level >= 2 ? 'High' : 'Normal',
      dueDate: D.addDays(this.today(), 2),
      createdAt: this.now(),
      createdBy: user.id,
    };
    this.db.activities.push(activity);
    return activity;
  }

  completeJobActivities(job, user) {
    for (const a of this.db.activities) {
      if (a.jobId === job.id && a.status === 'Open') Object.assign(a, { status: 'Completed', completedAt: this.now(), completedBy: user.id });
    }
  }

  approveIssue(jobId, key, note, user) {
    const job = this.job(jobId, user);
    this.assertEditable(job);
    const iss = (job.uwIssues || []).find((i) => i.key === key);
    if (!iss) throw new AppError(404, 'Underwriting issue not found');
    if (!iss.approvable) throw new AppError(409, `"${iss.name}" cannot be approved; the risk must change or the submission be declined`);
    this.requireAuthority(user, iss.approvalLevel, `approve "${iss.name}" (requires ${iss.requiredRole})`);
    job.uwApprovals[key] = { value: iss.value, by: user.id, byName: user.name, at: this.now(), note: str(note) };
    job.uwIssues = applyApprovals(job.uwIssues, job.uwApprovals);
    this.log(job, user, 'UW issue approved', `${iss.name}${note ? `: ${note}` : ''}`);
    const pending = job.uwIssues.filter((i) => !i.approved);
    if (!pending.length) this.completeJobActivities(job, user);
    const needsRequote = iss.blockingPoint === 'BlocksQuote' && job.status === 'Draft';
    job.notice = { level: 'success', text: `Approved "${iss.name}".${needsRequote ? ' Quote again to continue.' : ''}` };
    return job;
  }

  withdraw(jobId, user) {
    const job = this.job(jobId, user);
    this.assertEditable(job);
    job.status = 'Withdrawn';
    job.notice = { level: 'info', text: `${job.type} withdrawn` };
    this.completeJobActivities(job, user);
    this.log(job, user, 'Withdrawn');
    return job;
  }

  decline(jobId, reason, user) {
    const job = this.job(jobId, user);
    this.assertEditable(job);
    if (job.type !== 'Submission') throw new AppError(409, 'Only submissions can be declined');
    this.requireAuthority(user, 1, 'decline a submission');
    job.status = 'Declined';
    job.declineReason = str(reason) || 'Outside underwriting appetite';
    job.notice = { level: 'info', text: `Submission declined: ${job.declineReason}` };
    this.completeJobActivities(job, user);
    this.log(job, user, 'Declined', job.declineReason);
    return job;
  }

  // ------------------------------------------------------------------ bind

  bind(jobId, user) {
    const job = this.job(jobId, user);
    if (job.status !== 'Quoted') throw new AppError(409, `${job.type} must be quoted before it can be bound (status is ${job.status})`);
    const unapproved = (job.uwIssues || []).filter((i) => !i.approved);
    if (unapproved.length) {
      this.refer(job, unapproved, user);
      job.notice = { level: 'warning', text: `Cannot bind: ${unapproved.length} underwriting issue(s) need approval (${unapproved.map((i) => i.name).join(', ')}). A referral was sent.` };
      this.log(job, user, 'Bind blocked by underwriting');
      return job;
    }
    let policy;
    switch (job.type) {
      case 'Submission': policy = this.bindSubmission(job, user); break;
      case 'PolicyChange': policy = this.bindChange(job, user); break;
      case 'Renewal': policy = this.bindRenewal(job, user); break;
      case 'Cancellation': policy = this.bindCancellation(job, user); break;
      case 'Reinstatement': policy = this.bindReinstatement(job, user); break;
      default: throw new AppError(409, `Cannot bind ${job.type}`);
    }
    job.status = 'Bound';
    job.boundAt = this.now();
    job.notice = { level: 'success', text: `${job.type} bound on policy ${policy.policyNumber}` };
    this.completeJobActivities(job, user);
    this.log(job, user, 'Bound', policy.policyNumber);
    return job;
  }

  addVersion(policy, job, user) {
    const v = {
      versionId: this.store.id('ver'),
      jobId: job.id,
      jobNumber: job.jobNumber,
      jobType: job.type,
      termNumber: job.period.termNumber,
      effectiveDate: job.period.effectiveDate,
      expirationDate: job.period.expirationDate,
      editEffectiveDate: job.period.editEffectiveDate,
      period: clone(job.period),
      quote: clone(job.quote),
      boundAt: this.now(),
      boundBy: user.id,
    };
    policy.versions.push(v);
    policy.uwApprovals = clone(job.uwApprovals || {});
    return v;
  }

  addTransaction(policy, job, amount, effectiveDate, description) {
    policy.transactions.push({ id: this.store.id('txn'), jobNumber: job.jobNumber, jobType: job.type, effectiveDate, amount: round2(amount), description, postedAt: this.now() });
  }

  scheduleInstallments(policy, job, total, startDate) {
    const pm = PRODUCTS[policy.product];
    const plan = pm.paymentPlans.find((p) => p.code === job.period.paymentPlan) || pm.paymentPlans[0];
    const n = plan.installments;
    const step = pm.termMonths / n;
    const cents = Math.round(total * 100);
    const each = Math.floor(cents / n);
    for (let i = 0; i < n; i++) {
      this.db.invoices.push({
        id: this.store.id('inv'),
        invoiceNumber: this.store.number('INV-', 7),
        policyId: policy.id,
        jobNumber: job.jobNumber,
        termNumber: job.period.termNumber,
        dueDate: D.addMonths(startDate, Math.round(i * step)),
        amount: (each + (i === 0 ? cents - each * n : 0)) / 100,
        fee: n > 1 ? plan.installmentFee : 0,
        description: n > 1 ? `${plan.name}: installment ${i + 1} of ${n}` : 'Paid in full',
      });
    }
  }

  adjustmentInvoice(policy, job, amount, description) {
    if (!amount) return;
    this.db.invoices.push({
      id: this.store.id('inv'),
      invoiceNumber: this.store.number('INV-', 7),
      policyId: policy.id,
      jobNumber: job.jobNumber,
      termNumber: job.period.termNumber,
      dueDate: D.addDays(this.today(), 15),
      amount: round2(amount),
      fee: 0,
      description,
    });
  }

  addDocument(policy, job, name, versionId) {
    this.db.documents.push({
      id: this.store.id('doc'),
      documentNumber: this.store.number('DOC-', 7),
      policyId: policy.id,
      jobNumber: job.jobNumber,
      versionId: versionId || null,
      name,
      createdAt: this.now(),
    });
  }

  publish(type, payload) {
    this.db.events.push({
      id: this.store.id('evt'),
      eventId: this.store.number('EVT-', 8),
      type,
      topic: type.startsWith('Account') ? 'account-events' : 'policy-events',
      occurredAt: this.now(),
      status: 'Delivered',
      payload,
    });
  }

  eventPayload(policy, job, extra = {}) {
    return { policyNumber: policy.policyNumber, product: policy.product, jobNumber: job.jobNumber, jobType: job.type, ...extra };
  }

  bindSubmission(job, user) {
    const account = this.account(job.accountId);
    const policy = {
      id: this.store.id('pol'),
      policyNumber: this.store.number(`${PRODUCTS[job.product].prefix}-`, 7),
      accountId: account.id,
      product: job.product,
      versions: [],
      transactions: [],
      uwApprovals: {},
      cancellation: null,
      createdAt: this.now(),
    };
    this.db.policies.push(policy);
    job.policyId = policy.id;
    const v = this.addVersion(policy, job, user);
    this.addTransaction(policy, job, job.quote.total, job.period.effectiveDate, 'New business premium');
    this.scheduleInstallments(policy, job, job.quote.total, job.period.effectiveDate);
    this.addDocument(policy, job, 'Declarations Page', v.versionId);
    this.addDocument(policy, job, job.product === 'PersonalAuto' ? 'Auto ID Cards' : 'Evidence of Insurance', v.versionId);
    this.publish('PolicyIssued', this.eventPayload(policy, job, { accountNumber: account.accountNumber, effectiveDate: v.effectiveDate, expirationDate: v.expirationDate, totalCost: job.quote.total }));
    return policy;
  }

  bindChange(job, user) {
    const policy = this.policy(job.policyId);
    this.assertNotCancelled(policy);
    const v = this.addVersion(policy, job, user);
    this.addTransaction(policy, job, job.quote.changeAmount, job.period.editEffectiveDate, 'Policy change premium adjustment');
    this.adjustmentInvoice(policy, job, job.quote.changeAmount, job.quote.changeAmount > 0 ? 'Policy change: additional premium' : 'Policy change: return premium credit');
    this.addDocument(policy, job, 'Policy Change Endorsement', v.versionId);
    this.publish('PolicyChanged', this.eventPayload(policy, job, { editEffectiveDate: v.editEffectiveDate, premiumChange: job.quote.changeAmount }));
    return policy;
  }

  bindRenewal(job, user) {
    const policy = this.policy(job.policyId);
    this.assertNotCancelled(policy);
    const v = this.addVersion(policy, job, user);
    this.addTransaction(policy, job, job.quote.total, v.effectiveDate, `Renewal premium (term ${v.termNumber})`);
    this.scheduleInstallments(policy, job, job.quote.total, v.effectiveDate);
    this.addDocument(policy, job, 'Renewal Declarations Page', v.versionId);
    this.publish('PolicyRenewed', this.eventPayload(policy, job, { termNumber: v.termNumber, effectiveDate: v.effectiveDate, expirationDate: v.expirationDate, totalCost: job.quote.total }));
    return policy;
  }

  bindCancellation(job, user) {
    const policy = this.policy(job.policyId);
    this.assertNotCancelled(policy);
    policy.cancellation = { ...job.cancellation, jobNumber: job.jobNumber, boundAt: this.now(), boundBy: user.id };
    this.addTransaction(policy, job, job.quote.changeAmount, job.cancellation.effectiveDate, `Cancellation (${job.cancellation.reasonName}, ${job.cancellation.method})`);
    this.adjustmentInvoice(policy, job, job.quote.changeAmount, 'Cancellation: return premium credit');
    this.addDocument(policy, job, 'Notice of Cancellation');
    this.publish('PolicyCancelled', this.eventPayload(policy, job, { effectiveDate: job.cancellation.effectiveDate, reason: job.cancellation.reason, returnPremium: job.quote.changeAmount }));
    return policy;
  }

  bindReinstatement(job, user) {
    const policy = this.policy(job.policyId);
    if (!policy.cancellation) throw new AppError(409, 'Policy is not cancelled');
    policy.reinstatements = [...(policy.reinstatements || []), { jobNumber: job.jobNumber, cancellation: policy.cancellation, at: this.now(), by: user.id }];
    policy.cancellation = null;
    this.addTransaction(policy, job, job.quote.changeAmount, job.period.editEffectiveDate, 'Reinstatement: premium restored');
    this.adjustmentInvoice(policy, job, job.quote.changeAmount, 'Reinstatement: premium restored');
    this.addDocument(policy, job, 'Notice of Reinstatement');
    this.publish('PolicyReinstated', this.eventPayload(policy, job, { premiumRestored: job.quote.changeAmount }));
    return policy;
  }

  // ------------------------------------------------------------------ post-issuance jobs

  startPolicyChange(policyId, { effectiveDate }, user) {
    const policy = this.policy(policyId, user);
    this.assertNotCancelled(policy);
    this.assertNoOpenJob(policy);
    if (!D.isDate(effectiveDate)) throw new AppError(422, 'Change effective date must be yyyy-mm-dd');
    const term = this.termContaining(policy, effectiveDate);
    if (!term) throw new AppError(422, 'Change effective date must fall within a bound policy term');
    const base = term.latest;
    if (effectiveDate < base.editEffectiveDate) {
      throw new AppError(422, `Out-of-sequence change: the term was last changed effective ${base.editEffectiveDate}. Choose that date or later.`);
    }
    const period = clone(base.period);
    period.editEffectiveDate = effectiveDate;
    return this.newJob('PolicyChange', {
      accountId: policy.accountId, product: policy.product, period, policyId: policy.id,
      basedOnVersionId: base.versionId, uwApprovals: clone(policy.uwApprovals || {}),
    }, user);
  }

  startRenewal(policyId, user) {
    const policy = this.policy(policyId, user);
    this.assertNotCancelled(policy);
    this.assertNoOpenJob(policy);
    const last = this.lastTerm(policy);
    const daysToExpiry = D.daysBetween(this.today(), last.expirationDate);
    if (daysToExpiry > RENEWAL_WINDOW_DAYS) throw new AppError(422, `Renewal can start at most ${RENEWAL_WINDOW_DAYS} days before expiration (term ${last.termNumber} expires ${last.expirationDate})`);
    if (daysToExpiry < -30) throw new AppError(422, 'Policy lapsed more than 30 days ago; write a new submission instead');
    const period = clone(last.latest.period);
    const pm = PRODUCTS[policy.product];
    period.termNumber = last.termNumber + 1;
    period.effectiveDate = period.editEffectiveDate = last.expirationDate;
    period.expirationDate = D.addMonths(last.expirationDate, pm.termMonths);
    const job = this.newJob('Renewal', {
      accountId: policy.accountId, product: policy.product, period, policyId: policy.id,
      basedOnVersionId: last.latest.versionId, uwApprovals: clone(policy.uwApprovals || {}),
    }, user);
    try {
      this.quote(job.id, user);
    } catch (err) {
      if (err.status !== 422) throw err;
      job.notice = { level: 'warning', text: `Renewal needs review before it can be quoted: ${err.details.errors.map((e) => e.message).join('; ')}` };
    }
    return job;
  }

  startCancellation(policyId, { effectiveDate, reason }, user) {
    const policy = this.policy(policyId, user);
    const r = CANCEL_REASONS[reason];
    if (!r) throw new AppError(422, `Cancellation reason must be one of ${Object.keys(CANCEL_REASONS).join(', ')}`);
    this.requireAuthority(user, r.authority, `cancel for ${r.name.toLowerCase()}`);
    this.assertNotCancelled(policy);
    this.assertNoOpenJob(policy);
    if (!D.isDate(effectiveDate)) throw new AppError(422, 'Cancellation effective date must be yyyy-mm-dd');
    const terms = this.terms(policy);
    const term = this.termContaining(policy, effectiveDate) || (effectiveDate === terms[0].effectiveDate ? terms[0] : null);
    if (!term) throw new AppError(422, 'Cancellation effective date must fall within a bound policy term');
    if (effectiveDate < term.latest.editEffectiveDate) throw new AppError(422, `Out-of-sequence cancellation: the term was last changed effective ${term.latest.editEffectiveDate}`);
    const earliest = D.addDays(this.today(), r.noticeDays);
    if (r.noticeDays && effectiveDate < earliest) throw new AppError(422, `${r.name} requires ${r.noticeDays} days notice; earliest effective date is ${earliest}`);

    let refund = 0;
    const lines = [];
    for (const t of terms.filter((x) => x.expirationDate > effectiveDate)) {
      const termPremium = t.latest.quote.premium + t.latest.quote.taxes;
      const termDays = D.daysBetween(t.effectiveDate, t.expirationDate);
      const unearnedDays = t.effectiveDate >= effectiveDate ? termDays : D.daysBetween(effectiveDate, t.expirationDate);
      let amount = (termPremium * unearnedDays) / termDays;
      const shortRate = reason === 'InsuredRequest' && unearnedDays < termDays;
      if (shortRate) amount *= SHORT_RATE_FACTOR;
      refund += amount;
      lines.push({ termNumber: t.termNumber, termPremium: round2(termPremium), termDays, unearnedDays, shortRate, refund: round2(amount) });
    }
    const method = effectiveDate === term.effectiveDate ? 'Flat' : reason === 'InsuredRequest' ? 'Short rate' : 'Pro rata';
    const period = clone(term.latest.period);
    period.editEffectiveDate = effectiveDate;
    const job = this.newJob('Cancellation', { accountId: policy.accountId, product: policy.product, period, policyId: policy.id, basedOnVersionId: term.latest.versionId }, user);
    job.cancellation = { reason, reasonName: r.name, effectiveDate, method, refund: -round2(refund), lines };
    job.quote = { changeAmount: -round2(refund), quotedAt: this.now() };
    job.status = 'Quoted';
    job.notice = { level: 'info', text: `Return premium $${round2(refund).toFixed(2)} (${method}). Bind to cancel the policy.` };
    this.log(job, user, 'Cancellation quoted', `${r.name}, ${method}`);
    return job;
  }

  startReinstatement(policyId, user) {
    const policy = this.policy(policyId, user);
    if (!policy.cancellation) throw new AppError(409, 'Only cancelled policies can be reinstated');
    this.requireAuthority(user, CANCEL_REASONS[policy.cancellation.reason].authority, 'reinstate this policy');
    this.assertNoOpenJob(policy);
    const terms = this.terms(policy);
    const term = this.termContaining(policy, policy.cancellation.effectiveDate) || terms[0];
    const period = clone(term.latest.period);
    period.editEffectiveDate = policy.cancellation.effectiveDate;
    const job = this.newJob('Reinstatement', { accountId: policy.accountId, product: policy.product, period, policyId: policy.id, basedOnVersionId: term.latest.versionId }, user);
    job.reinstatement = { cancellationJobNumber: policy.cancellation.jobNumber, cancellationEffectiveDate: policy.cancellation.effectiveDate, reasonName: policy.cancellation.reasonName };
    job.quote = { changeAmount: -policy.cancellation.refund, quotedAt: this.now() };
    job.status = 'Quoted';
    job.notice = { level: 'info', text: `Reinstating restores $${(-policy.cancellation.refund).toFixed(2)} of premium with no lapse in coverage.` };
    this.log(job, user, 'Reinstatement quoted');
    return job;
  }

  // Renewal batch process: starts and quotes renewals for policies expiring within the window.
  runRenewalBatch({ asOf, daysAhead = 60 }, user) {
    this.requireAuthority(user, 1, 'run batch processes');
    const date = asOf && D.isDate(asOf) ? asOf : this.today();
    const results = [];
    for (const policy of this.db.policies) {
      if (policy.cancellation) continue;
      const last = this.lastTerm(policy);
      const days = D.daysBetween(date, last.expirationDate);
      if (days < 0 || days > daysAhead) continue;
      const open = this.db.jobs.find((j) => j.policyId === policy.id && OPEN.includes(j.status));
      if (open) {
        results.push({ policyNumber: policy.policyNumber, outcome: 'Skipped', message: `Open ${open.type} ${open.jobNumber}` });
        continue;
      }
      try {
        const job = this.startRenewal(policy.id, user);
        results.push({ policyNumber: policy.policyNumber, jobId: job.id, jobNumber: job.jobNumber, outcome: job.status === 'Quoted' ? 'Renewal quoted' : 'Needs review', message: job.notice ? job.notice.text : '' });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        results.push({ policyNumber: policy.policyNumber, outcome: 'Error', message: err.message });
      }
    }
    return { asOf: date, daysAhead, processed: results.length, results };
  }

  // ------------------------------------------------------------------ read models

  policyDetail(id, user) {
    const billing = canSeeBilling(user);
    const policy = this.policy(id, user);
    const account = this.account(policy.accountId);
    const today = this.today();
    const terms = this.terms(policy).map((t) => ({
      termNumber: t.termNumber,
      effectiveDate: t.effectiveDate,
      expirationDate: t.expirationDate,
      versions: t.versions.map((v) => ({ versionId: v.versionId, jobNumber: v.jobNumber, jobType: v.jobType, editEffectiveDate: v.editEffectiveDate, total: v.quote.total, boundAt: v.boundAt })),
    }));
    const invoices = this.db.invoices
      .filter((i) => i.policyId === policy.id)
      .map((i) => ({ ...i, status: i.amount < 0 ? 'Credit' : i.dueDate <= today ? 'Billed' : 'Planned' }))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
    return {
      ...this.policySummary(policy),
      account: { id: account.id, accountNumber: account.accountNumber, name: this.accountName(account), address: account.address, producerCode: account.producerCode },
      cancellation: policy.cancellation,
      reinstatements: policy.reinstatements || [],
      current: this.currentVersion(policy),
      versions: policy.versions,
      terms,
      billingHidden: !billing,
      transactions: billing ? policy.transactions : [],
      writtenPremium: billing ? round2(policy.transactions.reduce((s, t) => s + t.amount, 0)) : null,
      invoices: billing ? invoices : [],
      documents: this.db.documents.filter((d) => d.policyId === policy.id),
      events: this.db.events.filter((e) => e.payload.policyNumber === policy.policyNumber).reverse(),
      jobs: this.db.jobs.filter((j) => j.policyId === policy.id).map((j) => this.jobSummary(j)).reverse(),
      openJob: this.db.jobs.find((j) => j.policyId === policy.id && OPEN.includes(j.status)) ? this.jobSummary(this.db.jobs.find((j) => j.policyId === policy.id && OPEN.includes(j.status))) : null,
    };
  }

  listPolicies(q, user) {
    const s = str(q).toLowerCase();
    return this.db.policies
      .filter((p) => this.canSee(user, this.db.accounts.find((a) => a.id === p.accountId)))
      .map((p) => this.policySummary(p))
      .filter((p) => !s || [p.policyNumber, p.insuredName, p.product, p.status].join(' ').toLowerCase().includes(s))
      .reverse();
  }

  activities(user, { all } = {}) {
    return this.db.activities
      .filter((a) => this.canSee(user, this.db.accounts.find((x) => x.id === a.accountId)))
      .filter((a) => all || a.status === 'Open')
      .filter((a) => all || user.role === 'Agent' || a.assignedTo === user.id || (user.authority >= 2 && a.assignedTo === 'uw'))
      .map((a) => ({ ...a, assignedToName: USERS.find((u) => u.id === a.assignedTo)?.name }))
      .reverse();
  }

  completeActivity(id, user) {
    const a = this.db.activities.find((x) => x.id === id);
    if (!a) throw new AppError(404, 'Activity not found');
    this.account(a.accountId, user);
    if (a.status !== 'Open') throw new AppError(409, 'Activity is already completed');
    Object.assign(a, { status: 'Completed', completedAt: this.now(), completedBy: user.id });
    return a;
  }

  desktop(user) {
    const policies = this.listPolicies('', user);
    const inForce = policies.filter((p) => p.status === 'In Force');
    return {
      stats: {
        inForce: inForce.length,
        inForcePremium: round2(inForce.reduce((s, p) => s + p.termPremium, 0)),
        openJobs: this.listJobs(user, { status: 'open' }).length,
        openReferrals: this.activities(user).length,
      },
      activities: this.activities(user),
      openJobs: this.listJobs(user, { status: 'open' }).slice(0, 15),
      recentPolicies: policies.slice(0, 10),
    };
  }

  search(q, user) {
    return {
      accounts: this.listAccounts(q, user).slice(0, 20),
      policies: this.listPolicies(q, user).slice(0, 20),
      jobs: this.listJobs(user).filter((j) => [j.jobNumber, j.accountName, j.type, j.policyNumber].join(' ').toLowerCase().includes(str(q).toLowerCase())).slice(0, 20),
    };
  }

  // ------------------------------------------------------------------ claims
  // Claim stages: Submitted > Under Review > Documents Pending > Approved / Rejected > Settled.
  // Reserves can be set once a claim is under review; money is paid only after approval.
  // Reserve = the expected remaining cost (internal). Paid = money already paid out.

  claim(id, user) {
    const c = this.db.claims.find((x) => x.id === id || x.claimNumber === id);
    if (!c) throw new AppError(404, 'Claim not found');
    if (user) this.policy(c.policyId, user);
    return c;
  }

  claimView(c, user) {
    const paid = round2(c.payments.reduce((s, p) => s + p.amount, 0));
    const policy = this.db.policies.find((p) => p.id === c.policyId);
    return {
      id: c.id, claimNumber: c.claimNumber, policyNumber: policy ? policy.policyNumber : null, product: c.product,
      insured: this.accountName(this.db.accounts.find((a) => a.id === c.accountId)),
      lossDate: c.lossDate, lossType: c.lossType, description: c.description, status: c.status,
      reportedOn: c.reportedOn, paid, payments: c.payments, closedOn: c.closedOn || null, closeReason: c.closeReason || null,
      history: c.history || [],
      documents: (c.documents || []).map(({ path, ...d }) => d),
      ...(user && !canSeeClaimReserves(user) ? {} : { reserve: c.reserve, outstanding: round2(Math.max(0, c.reserve - paid)) }),
    };
  }

  claimDetail(id, user) {
    return this.claimView(this.claim(id, user), user);
  }

  listClaims(user, { policy, status } = {}) {
    return this.db.claims
      .filter((c) => {
        const account = this.db.accounts.find((a) => a.id === c.accountId);
        return account && this.canSee(user, account);
      })
      .filter((c) => !policy || this.db.policies.find((p) => p.id === c.policyId)?.policyNumber === policy)
      .filter((c) => !status || c.status === status)
      .map((c) => this.claimView(c, user))
      .reverse();
  }

  openClaim(policyId, input, user) {
    const policy = this.policy(policyId, user);
    const lossDate = str(input.lossDate);
    if (!D.isDate(lossDate)) throw new AppError(422, 'Loss date must be yyyy-mm-dd');
    if (lossDate > this.today()) throw new AppError(422, 'Loss date cannot be in the future');
    const inTerm = this.terms(policy).some((t) => t.effectiveDate <= lossDate && lossDate < t.expirationDate);
    if (!inTerm) throw new AppError(422, `No term of ${policy.policyNumber} covers ${lossDate}`);
    const lossType = str(input.lossType);
    if (!CLAIM_TYPES.includes(lossType)) throw new AppError(422, `Loss type must be one of ${CLAIM_TYPES.join(', ')}`);
    const claim = {
      id: this.store.id('clm'),
      claimNumber: this.store.number('CL-', 7),
      policyId: policy.id,
      accountId: policy.accountId,
      product: policy.product,
      lossDate,
      lossType,
      description: str(input.description),
      status: 'Submitted',
      reportedOn: this.today(),
      reserve: 0,
      payments: [],
      documents: [],
      history: [{ at: this.now(), by: user.id, from: null, to: 'Submitted', reason: 'Claim submitted' }],
      createdBy: user.id,
    };
    this.db.claims.push(claim);
    this.publish('ClaimOpened', { claimNumber: claim.claimNumber, policyNumber: policy.policyNumber, lossDate, lossType });
    return claim;
  }

  // Moves a claim to the next stage. Staff only, following the allowed stage order.
  moveClaim(id, { to, reason }, user) {
    this.requireAuthority(user, 1, 'move claims between stages');
    const claim = this.claim(id, user);
    const allowed = CLAIM_TRANSITIONS[claim.status] || [];
    if (!allowed.includes(to)) throw new AppError(409, `A ${claim.status} claim cannot move to ${to}. Allowed: ${allowed.join(', ') || 'none (final stage)'}`);
    if (to === 'Settled') {
      const paid = round2(claim.payments.reduce((s, p) => s + p.amount, 0));
      claim.reserve = paid;
      claim.closedOn = this.today();
      claim.closeReason = str(reason) || 'Settled';
    }
    if (to === 'Rejected') {
      claim.closedOn = this.today();
      claim.closeReason = str(reason) || 'Rejected';
    }
    claim.history.push({ at: this.now(), by: user.id, from: claim.status, to, reason: str(reason) });
    claim.status = to;
    this.publish('ClaimStageChanged', { claimNumber: claim.claimNumber, stage: to });
    return this.claimView(claim, user);
  }

  assertClaimAt(claim, stages, action) {
    if (!stages.includes(claim.status)) throw new AppError(409, `Claim ${claim.claimNumber} is ${claim.status}; ${action} needs it to be ${stages.join(' or ')}`);
  }

  setClaimReserve(id, amount, user) {
    this.requireAuthority(user, 1, 'set claim reserves');
    const claim = this.claim(id, user);
    this.assertClaimAt(claim, ['Under Review', 'Documents Pending', 'Approved'], 'setting a reserve');
    const value = Number(amount);
    const paid = claim.payments.reduce((s, p) => s + p.amount, 0);
    if (!Number.isFinite(value) || value < paid) throw new AppError(422, `Reserve cannot be below the ${round2(paid)} already paid`);
    claim.reserve = round2(value);
    return this.claimView(claim, user);
  }

  payClaim(id, { amount, note }, user) {
    this.requireAuthority(user, 1, 'pay claims');
    const claim = this.claim(id, user);
    this.assertClaimAt(claim, ['Approved'], 'a payment');
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw new AppError(422, 'Payment must be more than zero');
    const paid = claim.payments.reduce((s, p) => s + p.amount, 0);
    if (round2(paid + value) > claim.reserve) throw new AppError(422, 'Payment would exceed the reserve; raise the reserve first');
    claim.payments.push({ date: this.today(), amount: round2(value), note: str(note), by: user.id });
    this.publish('ClaimPaid', { claimNumber: claim.claimNumber, amount: round2(value) });
    return this.claimView(claim, user);
  }

  // ------------------------------------------------------------------ tickets
  // Customer and staff issues. Each ticket has a priority with a response deadline (SLA):
  //   Urgent 4 hours, High 1 day, Normal 2 days, Low 5 days (calendar hours from creation).
  // Customers who hold a premium policy (total current term premium of PREMIUM_THRESHOLD or more) go first
  // in the queue, then by priority, then by the earliest deadline.

  premiumCustomer(accountId) {
    const today = this.today();
    const total = this.db.policies
      .filter((p) => p.accountId === accountId && !p.cancellation)
      .reduce((sum, p) => {
        const term = this.termContaining(p, today);
        return term ? sum + term.latest.quote.premium + term.latest.quote.taxes : sum;
      }, 0);
    return round2(total) >= PREMIUM_THRESHOLD;
  }

  createTicket(input, user) {
    const account = this.account(str(input.accountId), user);
    const priority = input.priority || 'Normal';
    if (!TICKET_HOURS[priority]) throw new AppError(422, `Priority must be one of ${Object.keys(TICKET_HOURS).join(', ')}`);
    const subject = str(input.subject);
    if (subject.length < 3) throw new AppError(422, 'Give the ticket a short subject');
    const category = input.category || 'Other';
    if (!TICKET_CATEGORIES.includes(category)) throw new AppError(422, `Category must be one of ${TICKET_CATEGORIES.join(', ')}`);
    const policy = input.policyId ? this.policy(input.policyId, user) : null;
    const claim = input.claimId ? this.claim(input.claimId, user) : null;
    const createdMs = this.nowMs();
    const ticket = {
      id: this.store.id('tkt'),
      ticketNumber: this.store.number('TKT-', 7),
      accountId: account.id,
      policyId: policy ? policy.id : null,
      claimId: claim ? claim.id : null,
      category, subject, description: str(input.description), priority,
      status: 'Open', assignedTo: null,
      source: input.source || 'staff',
      createdBy: user.id, createdByName: user.name, createdAt: new Date(createdMs).toISOString(),
      slaDueAt: new Date(createdMs + TICKET_HOURS[priority] * 3600 * 1000).toISOString(),
      firstResponseAt: null, resolvedAt: null, closedAt: null,
      notes: [],
      history: [{ at: new Date(createdMs).toISOString(), by: user.id, action: 'Created', detail: `${priority} priority, ${category}` }],
    };
    this.db.tickets.push(ticket);
    this.publish('TicketOpened', { ticketNumber: ticket.ticketNumber, priority, category });
    return ticket;
  }

  ticket(id, user) {
    const t = this.db.tickets.find((x) => x.id === id || x.ticketNumber === id);
    if (!t) throw new AppError(404, 'Ticket not found');
    const account = this.db.accounts.find((a) => a.id === t.accountId);
    if (user && (!account || !this.canSee(user, account))) throw new AppError(404, 'Ticket not found');
    return t;
  }

  // SLA state: Met or Missed once resolved or closed; otherwise Responded, On time, or Breached.
  slaOf(t) {
    const due = Date.parse(t.slaDueAt);
    const hoursLeft = Math.round(((due - this.nowMs()) / 3600000) * 10) / 10;
    if (t.resolvedAt || t.closedAt) return { state: Date.parse(t.resolvedAt || t.closedAt) <= due ? 'Met' : 'Missed', hoursLeft: null };
    if (t.firstResponseAt) return { state: 'Responded', hoursLeft: null };
    return { state: hoursLeft < 0 ? 'Breached' : 'On time', hoursLeft };
  }

  ticketView(t, user) {
    const account = this.db.accounts.find((a) => a.id === t.accountId);
    const { notes, ...rest } = t;
    return {
      ...rest,
      customer: account ? this.accountName(account) : '',
      accountNumber: account ? account.accountNumber : null,
      premiumCustomer: this.premiumCustomer(t.accountId),
      assignedToName: t.assignedTo ? (USERS.find((u) => u.id === t.assignedTo) || { name: t.assignedTo }).name : null,
      sla: this.slaOf(t),
      notes: notes.map((n) => ({ ...n })),
    };
  }

  listTickets(user, { status } = {}) {
    return this.db.tickets
      .filter((t) => {
        const account = this.db.accounts.find((a) => a.id === t.accountId);
        return account && this.canSee(user, account);
      })
      .filter((t) => !status || (status === 'open' ? !['Resolved', 'Closed'].includes(t.status) : t.status === status))
      .map((t) => this.ticketView(t, user))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // The staff queue: open tickets, premium customers first, then priority, then the earliest deadline.
  ticketQueue(user) {
    return this.listTickets(user, { status: 'open' })
      .sort((a, b) => (Number(b.premiumCustomer) - Number(a.premiumCustomer))
        || (TICKET_HOURS[a.priority] - TICKET_HOURS[b.priority])
        || a.slaDueAt.localeCompare(b.slaDueAt));
  }

  assignTicket(id, assigneeId, user) {
    this.requireAuthority(user, 1, 'assign tickets');
    const t = this.ticket(id, user);
    if (!['Open', 'Assigned'].includes(t.status)) throw new AppError(409, `A ${t.status} ticket cannot be assigned`);
    const assignee = USERS.find((u) => u.id === assigneeId && u.authority >= 1);
    if (!assignee) throw new AppError(422, 'Assign to an underwriter, insurance executive or manager');
    t.assignedTo = assignee.id;
    t.status = 'Assigned';
    t.history.push({ at: this.now(), by: user.id, action: 'Assigned', detail: assignee.name });
    return this.ticketView(t, user);
  }

  // Ticket stages: Open > Assigned > In Progress > Resolved > Closed (a resolved ticket can be reopened).
  moveTicket(id, { to }, user) {
    this.requireAuthority(user, 1, 'change ticket status');
    const t = this.ticket(id, user);
    const allowed = TICKET_TRANSITIONS[t.status] || [];
    if (!allowed.includes(to)) throw new AppError(409, `A ${t.status} ticket cannot move to ${to}. Allowed: ${allowed.join(', ') || 'none'}`);
    const at = this.now();
    if (to === 'In Progress' && !t.firstResponseAt) t.firstResponseAt = at;
    if (to === 'Resolved') t.resolvedAt = at;
    if (to === 'Closed') t.closedAt = at;
    if (to === 'In Progress') t.resolvedAt = null;
    t.history.push({ at, by: user.id, action: 'Status', detail: `${t.status} to ${to}` });
    t.status = to;
    return this.ticketView(t, user);
  }

  addTicketNote(id, { text, internal }, user) {
    const t = this.ticket(id, user);
    const body = str(text);
    if (!body) throw new AppError(422, 'Write a note before saving');
    const staff = salesScope(user) === 'all';
    const at = this.now();
    if (staff && !t.firstResponseAt) t.firstResponseAt = at;
    t.notes.push({ at, by: user.id, byName: user.name, text: body, internal: Boolean(internal && staff) });
    t.history.push({ at, by: user.id, action: 'Note', detail: staff ? 'staff note' : 'customer note' });
    return this.ticketView(t, user);
  }

  // ------------------------------------------------------------------ staff accounts
  // Staff who sign in. Created by the UW Manager, who gets a temporary password to pass on.
  // The person must change it at their first sign-in.

  staffById(id) {
    return this.db.staff.find((s) => s.id === id) || null;
  }

  staffByUsername(username) {
    return this.db.staff.find((s) => s.username === String(username || '').toLowerCase()) || null;
  }

  userView(s) {
    return { id: s.id, username: s.username, name: s.name, role: s.role, authority: s.authority, producerCode: s.producerCode || null, reportsTo: s.reportsTo || null, active: s.active };
  }

  listStaff(user) {
    this.requireManager(user, 'see the staff list');
    return this.db.staff.map((s) => ({ ...this.userView(s), mustChangePassword: Boolean(s.mustChangePassword), hasPassword: Boolean(s.passwordHash) }));
  }

  requireManager(user, action) {
    if (!user || user.role !== 'UW Manager') throw new AppError(403, `Only the UW Manager can ${action}`);
  }

  // Creates an account and returns the temporary password (shown once).
  createStaff(input, user) {
    this.requireManager(user, 'create staff accounts');
    const username = String(input.username || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9.]{2,29}$/.test(username)) throw new AppError(422, 'Username: 3 to 30 letters, numbers or dots, starting with a letter');
    if (this.staffByUsername(username)) throw new AppError(409, `The username ${username} is already taken`);
    const name = str(input.name);
    if (name.length < 2) throw new AppError(422, 'Enter the person\'s name');
    const role = str(input.role);
    if (STAFF_ROLES[role] === undefined) throw new AppError(422, `Role must be one of ${Object.keys(STAFF_ROLES).join(', ')}`);
    const producerCode = role === 'Agent' ? str(input.producerCode) : null;
    if (role === 'Agent' && !PRODUCER_CODES.some((p) => p.code === producerCode)) throw new AppError(422, 'Agents need a producer code (PC-100 or PC-200)');
    const reportsTo = role === 'Agent' ? null : (str(input.reportsTo) || user.id);
    const password = temporaryPassword();
    const staff = {
      id: username, username, name, role, authority: STAFF_ROLES[role], producerCode, reportsTo,
      passwordHash: hashPassword(password), mustChangePassword: true, active: true,
      createdBy: user.id, createdAt: this.now(),
    };
    this.db.staff.push(staff);
    return { ...this.userView(staff), temporaryPassword: password };
  }

  resetStaffPassword(id, user) {
    this.requireManager(user, 'reset passwords');
    const s = this.staffById(id);
    if (!s) throw new AppError(404, 'Staff account not found');
    const password = temporaryPassword();
    s.passwordHash = hashPassword(password);
    s.mustChangePassword = true;
    return { ...this.userView(s), temporaryPassword: password };
  }

  setStaffActive(id, active, user) {
    this.requireManager(user, 'turn accounts on or off');
    const s = this.staffById(id);
    if (!s) throw new AppError(404, 'Staff account not found');
    if (s.id === user.id && !active) throw new AppError(422, 'You cannot turn off your own account');
    s.active = Boolean(active);
    return this.userView(s);
  }

  // Changing your own password (also used at the first sign-in).
  changeOwnPassword(user, { current, next }) {
    if (!verifyPassword(current, user.passwordHash)) throw new AppError(401, 'The current password is wrong');
    const value = String(next || '');
    if (value.length < 8) throw new AppError(422, 'The new password needs at least 8 characters');
    if (value === String(current)) throw new AppError(422, 'Choose a new password, not the same one');
    user.passwordHash = hashPassword(value);
    user.mustChangePassword = false;
    return this.userView(user);
  }

  // ------------------------------------------------------------------ sales analytics
  // A sale is a policy whose first job was a Submission. Its salesperson is the user who started that
  // submission, and it is counted on the day the policy was bound. Agents see their own sales only;
  // underwriting staff and managers see every salesperson.

  salespersonOf(policy) {
    const job = this.db.jobs.find((j) => j.policyId === policy.id && j.type === 'Submission');
    const id = job ? job.createdBy : null;
    const user = USERS.find((u) => u.id === id);
    return { id, name: user ? user.name : id || 'Unknown' };
  }

  saleRows(user, { product } = {}) {
    const rows = [];
    for (const p of this.db.policies) {
      const account = this.db.accounts.find((a) => a.id === p.accountId);
      if (!account || !this.canSee(user, account)) continue;
      if (product && p.product !== product) continue;
      const first = p.versions[0];
      if (!first || first.jobType !== 'Submission') continue;
      const seller = this.salespersonOf(p);
      if (salesScope(user) !== 'all' && seller.id !== user.id) continue;
      rows.push({ policyNumber: p.policyNumber, product: p.product, boundDate: first.boundAt.slice(0, 10), premium: round2(first.quote.premium + first.quote.taxes), salesperson: seller, producerCode: account.producerCode || 'None' });
    }
    return rows;
  }

  salesAnalytics(user, { period = 'month', product } = {}) {
    if (!canSeeSales(user)) throw new AppError(403, 'Sales reports are for agents, insurance executives and UW managers');
    if (!['day', 'month', 'year'].includes(period)) throw new AppError(422, 'Period must be day, month or year');
    const keyOf = (date) => (period === 'day' ? date : period === 'month' ? date.slice(0, 7) : date.slice(0, 4));
    const buckets = new Map();
    for (const r of this.saleRows(user, { product })) {
      const key = keyOf(r.boundDate);
      if (!buckets.has(key)) buckets.set(key, { period: key, total: { policies: 0, premium: 0 }, salespeople: {} });
      const b = buckets.get(key);
      b.total.policies++;
      b.total.premium = round2(b.total.premium + r.premium);
      const sp = b.salespeople[r.salesperson.id] || (b.salespeople[r.salesperson.id] = { id: r.salesperson.id, name: r.salesperson.name, policies: 0, premium: 0 });
      sp.policies++;
      sp.premium = round2(sp.premium + r.premium);
    }
    return {
      period,
      product: product || 'all products',
      scope: salesScope(user) === 'all' ? 'all salespeople' : 'your sales only',
      buckets: [...buckets.values()]
        .sort((a, b) => b.period.localeCompare(a.period))
        .map((b) => ({ ...b, salespeople: Object.values(b.salespeople).sort((x, y) => y.premium - x.premium) })),
    };
  }

  // Lapsing: the current term ends within LAPSING_WINDOW_DAYS and nothing has renewed yet.
  // Lapsed: the term ended within the last LAPSED_WINDOW_DAYS and nothing has renewed.
  lapsePolicies(user) {
    if (!canSeeSales(user)) throw new AppError(403, 'Sales reports are for agents, insurance executives and UW managers');
    const today = this.today();
    const out = [];
    for (const p of this.db.policies) {
      if (p.cancellation) continue;
      const account = this.db.accounts.find((a) => a.id === p.accountId);
      if (!account || !this.canSee(user, account)) continue;
      const seller = this.salespersonOf(p);
      if (salesScope(user) !== 'all' && seller.id !== user.id) continue;
      const last = this.lastTerm(p);
      const days = D.daysBetween(today, last.expirationDate);
      let status = null;
      if (days >= 0 && days <= LAPSING_WINDOW_DAYS) status = 'Lapsing';
      else if (days < 0 && -days <= LAPSED_WINDOW_DAYS) status = 'Lapsed';
      if (!status) continue;
      if (this.db.jobs.some((j) => j.policyId === p.id && j.type === 'Renewal' && OPEN.includes(j.status))) continue;
      const notes = this.db.followUps.filter((f) => f.policyId === p.id).sort((a, b) => b.date.localeCompare(a.date) || b.loggedAt.localeCompare(a.loggedAt));
      const latest = notes[0] || null;
      out.push({
        policyId: p.id, accountId: account.id, policyNumber: p.policyNumber, insured: this.accountName(account), product: p.product, status,
        expirationDate: last.expirationDate, daysToExpiry: days,
        premium: round2(last.latest.quote.premium + last.latest.quote.taxes),
        salesperson: seller,
        lastFollowUp: latest ? { date: latest.date, channel: latest.channel, result: latest.result } : null,
        followUpCount: notes.length,
      });
    }
    return out.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  }

  logFollowUp(policyId, input, user) {
    if (!canSeeSales(user)) throw new AppError(403, 'Sales reports are for agents, insurance executives and UW managers');
    if (!canLogFollowUps(user)) throw new AppError(403, 'Insurance executives can view sales but cannot log follow-ups');
    const policy = this.policy(policyId, user);
    const seller = this.salespersonOf(policy);
    if (salesScope(user) !== 'all' && seller.id !== user.id) throw new AppError(403, 'Only the salesperson who sold this policy can log follow-ups for it');
    const channel = str(input.channel);
    if (!FOLLOW_UP_CHANNELS.includes(channel)) throw new AppError(422, `Channel must be one of ${FOLLOW_UP_CHANNELS.join(', ')}`);
    const result = str(input.result);
    if (!FOLLOW_UP_RESULTS.includes(result)) throw new AppError(422, `Result must be one of ${FOLLOW_UP_RESULTS.join(', ')}`);
    const date = str(input.date) || this.today();
    if (!D.isDate(date)) throw new AppError(422, 'Follow-up date must be yyyy-mm-dd');
    if (date > this.today()) throw new AppError(422, 'Follow-up date cannot be in the future');
    const followUp = {
      id: this.store.id('fu'), policyId: policy.id, policyNumber: policy.policyNumber, salespersonId: seller.id,
      date, channel, result, notes: str(input.notes), loggedBy: user.id, loggedByName: user.name, loggedAt: this.now(),
    };
    this.db.followUps.push(followUp);
    return followUp;
  }

  followUpHistory(policyId, user) {
    if (!canSeeSales(user)) throw new AppError(403, 'Sales reports are for agents, insurance executives and UW managers');
    const policy = this.policy(policyId, user);
    return this.db.followUps
      .filter((f) => f.policyId === policy.id)
      .sort((a, b) => b.date.localeCompare(a.date) || b.loggedAt.localeCompare(a.loggedAt));
  }

  // Every follow-up the user may see, newest first, with the customer's name.
  followUpsVisible(user) {
    if (!canSeeSales(user)) throw new AppError(403, 'Sales reports are for agents, insurance executives and UW managers');
    return this.db.followUps
      .map((f) => {
        const p = this.db.policies.find((x) => x.id === f.policyId);
        const account = p && this.db.accounts.find((a) => a.id === p.accountId);
        return { f, account };
      })
      .filter(({ f, account }) => account && this.canSee(user, account) && (salesScope(user) === 'all' || f.salespersonId === user.id))
      .sort((a, b) => b.f.date.localeCompare(a.f.date) || b.f.loggedAt.localeCompare(a.f.loggedAt))
      .map(({ f, account }) => ({ ...f, insured: this.accountName(account) }));
  }

  // Claims report (underwriters and UW managers): claims by stage, loss type and product, with totals.
  claimsReport(user) {
    if (!canSeeClaimsReport(user)) throw new AppError(403, 'The claims report is for underwriters and UW managers');
    const claims = this.db.claims.map((c) => this.claimView(c, user));
    const tally = (keyOf) => {
      const out = {};
      for (const c of claims) {
        const k = keyOf(c);
        out[k] = out[k] || { claims: 0, paid: 0, reserve: 0 };
        out[k].claims++;
        out[k].paid = round2(out[k].paid + c.paid);
        out[k].reserve = round2(out[k].reserve + (c.reserve || 0));
      }
      return out;
    };
    return {
      claims: claims.length,
      totalPaid: round2(claims.reduce((s, c) => s + c.paid, 0)),
      totalReserve: round2(claims.reduce((s, c) => s + (c.reserve || 0), 0)),
      byStage: tally((c) => c.status),
      byLossType: tally((c) => c.lossType),
      byProduct: tally((c) => c.product),
    };
  }

  // Billing report (UW managers only): invoices by status and product for a due-date range.
  billingReport(user, { from, to } = {}) {
    if (!canSeeBillingReport(user)) throw new AppError(403, 'The billing report is for UW managers');
    if (from && !D.isDate(from)) throw new AppError(422, 'From date must be yyyy-mm-dd');
    if (to && !D.isDate(to)) throw new AppError(422, 'To date must be yyyy-mm-dd');
    const today = this.today();
    const statusOf = (i) => (i.amount < 0 ? 'Credit' : i.dueDate <= today ? 'Billed' : 'Planned');
    const invoices = this.db.invoices.filter((i) => (!from || i.dueDate >= from) && (!to || i.dueDate <= to));
    const add = (bucket, key, i) => {
      bucket[key] = bucket[key] || { invoices: 0, amount: 0, fees: 0 };
      bucket[key].invoices++;
      bucket[key].amount = round2(bucket[key].amount + i.amount);
      bucket[key].fees = round2(bucket[key].fees + (i.fee || 0));
    };
    const byStatus = {};
    const byProduct = {};
    for (const i of invoices) {
      add(byStatus, statusOf(i), i);
      const policy = this.db.policies.find((p) => p.id === i.policyId);
      add(byProduct, policy ? policy.product : 'Unknown', i);
    }
    return {
      from: from || 'all dates', to: to || 'all dates',
      invoices: invoices.length,
      totalAmount: round2(invoices.reduce((s, i) => s + i.amount, 0)),
      totalFees: round2(invoices.reduce((s, i) => s + (i.fee || 0), 0)),
      byStatus, byProduct,
    };
  }

  // Sales report: new business written (policies whose first job was a Submission) with an effective
  // date in [from, to]. Agents get their own producer code only; underwriting staff get every producer.
  salesReport(user, { from, to, product } = {}) {
    if (!canSeeSales(user)) throw new AppError(403, 'Sales reports are for agents, insurance executives and UW managers');
    if (!D.isDate(from) || !D.isDate(to)) throw new AppError(422, 'Sales dates must be yyyy-mm-dd');
    if (from > to) throw new AppError(422, 'The start date is after the end date');
    const scope = salesScope(user);
    const rows = [];
    for (const p of this.db.policies) {
      const account = this.db.accounts.find((a) => a.id === p.accountId);
      if (!account || !this.canSee(user, account)) continue;
      if (product && p.product !== product) continue;
      const first = p.versions[0];
      if (!first || first.jobType !== 'Submission') continue;
      if (first.effectiveDate < from || first.effectiveDate > to) continue;
      rows.push({ producerCode: account.producerCode, product: p.product, state: first.period.state, premium: round2(first.quote.premium + first.quote.taxes) });
    }
    const tally = (keyOf) => {
      const out = {};
      for (const r of rows) {
        const k = keyOf(r);
        out[k] = out[k] || { policies: 0, writtenPremium: 0 };
        out[k].policies++;
        out[k].writtenPremium = round2(out[k].writtenPremium + r.premium);
      }
      return out;
    };
    const producerName = (code) => (PRODUCER_CODES.find((p) => p.code === code) || {}).name || code;
    return {
      from, to, product: product || 'all products', scope: scope === 'own' ? 'your producer code only' : 'all producers',
      policies: rows.length,
      writtenPremium: round2(rows.reduce((s, r) => s + r.premium, 0)),
      byProduct: tally((r) => r.product),
      byState: tally((r) => r.state),
      byProducer: scope === 'all' ? Object.fromEntries(Object.entries(tally((r) => r.producerCode)).map(([code, v]) => [`${code} ${producerName(code)}`, v])) : undefined,
    };
  }

  events(limit = 100) {
    return this.db.events.slice(-limit).reverse();
  }
}

module.exports = { PolicyCenter, AppError, CANCEL_REASONS };
