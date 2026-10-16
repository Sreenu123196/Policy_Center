'use strict';
// PolicyCenter application service: accounts, the job framework (Submission, PolicyChange,
// Renewal, Cancellation, Reinstatement), underwriting referrals, and the downstream effects of
// binding (policy versions, transactions, billing, documents, integration events).

const { PRODUCTS, USERS, PRODUCER_CODES, normalizeCoverages } = require('./productModel');
const { rate, replacementCostEstimate, round2 } = require('./rating');
const { validateAccount, validatePeriod } = require('./validation');
const { evaluateUW, applyApprovals } = require('./uwRules');
const D = require('./dates');

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
    this.store = store;
    this.today = today || D.todayISO;
  }

  get db() {
    return this.store.data;
  }

  now() {
    return new Date().toISOString();
  }

  // ------------------------------------------------------------------ users & security

  user(id) {
    const u = USERS.find((x) => x.id === id);
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
    if (product === 'PersonalAuto') {
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
      transactions: policy.transactions,
      writtenPremium: round2(policy.transactions.reduce((s, t) => s + t.amount, 0)),
      invoices,
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

  events(limit = 100) {
    return this.db.events.slice(-limit).reverse();
  }
}

module.exports = { PolicyCenter, AppError, CANCEL_REASONS };
