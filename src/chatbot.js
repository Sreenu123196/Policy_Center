'use strict';
// PolicyCenter assistant. With Anthropic credentials it runs a Claude tool-use loop over read-only
// PolicyCenter tools; without them it answers common questions directly from the data ("offline").
// Every tool runs as the signed-in user, so producer-code security applies to the chatbot too.

const AnthropicSDK = require('@anthropic-ai/sdk');
const { PRODUCTS, STATES } = require('./productModel');
const { RATE_BOOKS } = require('./rateBooks');
const { CANCEL_REASONS, AppError } = require('./policyCenter');
const { canSeeRatingFactors, canSeeUnderwritingNotes } = require('./permissions');

const Anthropic = AnthropicSDK.default || AnthropicSDK;
const MODEL = process.env.CHAT_MODEL || 'claude-haiku-5-5';
// Server-side refusal fallback ("fallbacks": "default") exists only on these models; Haiku 5.5 has none.
const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
const fallbackParams = () => (FALLBACK_MODELS.includes(MODEL) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {});
const MAX_TOOL_ROUNDS = 8;
const MAX_TURNS = 40;
const MAX_CONVERSATIONS = 200;

const SYSTEM_PROMPT = `You are the PolicyCenter Assistant inside a policy administration system for a personal lines insurer that writes Personal Auto (6-month terms) and Homeowners (12-month terms; forms HO-3, HO-5, HO-4 renters, HO-6 condo) in CA, FL, IL, NY, OH and TX.

You help agents, underwriters and managers find accounts, policies and jobs, explain premiums, underwriting issues, coverages, billing and policy history, and summarize the book of business.

How to work:
- Answer from tool results only. Never invent policy numbers, amounts, dates, coverages, rules, counts or totals. If a tool does not return something, say you could not find it.
- Claims: use list_claims and get_claim. Quote claim numbers, loss dates, paid amounts and status exactly as returned. Reserves appear only when the tool returns them; if a user asks for a reserve and it is missing, say reserves are internal to underwriting. Never estimate or make up figures for data that is not in the results.
- For sales, new business or written premium questions, use sales_report. For book-of-business and policy counts, use portfolio_summary or list_policies. Quote the exact figures the tool returns and say what period and scope they cover.
- Tool results already show only what the signed-in user may see. Never mention or guess at data that is not in the results. If a user asks for rating factors or underwriting notes and the tool says they are internal, say so and do not work around it.
- Look things up before answering questions about specific records. Policy numbers look like PA-0000001 or HO-0000001, jobs like J0000001, accounts like A0000001.
- When explaining a premium, use the rating worksheet: name the factors that drive it most, with their values.
- You are read-only. You cannot quote, bind, change, cancel or approve anything. When the user wants that, tell them which screen and button to use (for example: open the policy, click "Change policy"; open the job, go to Risk analysis and click Approve).
- Each message may start with a bracketed note about the screen the user has open and today's date. Use it to resolve "this policy" or "this job".
- Keep answers short and scannable: a sentence or two, then bullets or a small table when listing several records. Use $ amounts with cents. Always write record numbers in full as plain text (no Markdown links); the app turns them into links.

Language:
- Users write or speak in English, Hindi, Telugu, or a mix such as Hinglish (Hindi and English) or Tenglish (Telugu and English). Speech arrives as transcribed text and may have small transcription errors; read it for meaning.
- Reply in the language and script of the user's latest message. Hindi in Devanagari gets a reply in Devanagari; Telugu in Telugu script gets a reply in Telugu script; English gets English.
- Mixed messages get a reply in the same mix and the same script. Romanized Hinglish (for example "J0000005 kyon blocked hai?") gets romanized Hinglish back; romanized Tenglish (for example "ee policy premium enduku ekkuva undi?") gets romanized Tenglish back. Do not switch a romanized message into Devanagari or Telugu script.
- In every language, keep record numbers, dollar amounts, dates, coverage names and insurance terms that people use in English (premium, deductible, underwriting, bind, quote, referral) in English. Name screens and buttons in English exactly as they appear in the app (for example "Risk analysis", "Approve"), because the app's screens are in English.`;

// ------------------------------------------------------------------ tools

const str = (v) => (v == null ? '' : String(v).trim());

const TOOLS = [
  {
    name: 'search',
    description: 'Search accounts, policies and jobs by insured name, account/policy/job number, city, ZIP, product or status. Returns short summaries with ids and numbers.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'get_account',
    description: 'Get an account (insured details, all its policies and jobs) by account id or account number such as A0000001.',
    input_schema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'], additionalProperties: false },
  },
  {
    name: 'get_policy',
    description: 'Get a policy by policy number (PA-0000001, HO-0000001) or id: status, term, premium, insured, current coverages and risk details, transactions, billing summary, documents and history.',
    input_schema: { type: 'object', properties: { policy: { type: 'string' } }, required: ['policy'], additionalProperties: false },
  },
  {
    name: 'get_job',
    description: 'Get a job (Submission, PolicyChange, Renewal, Cancellation, Reinstatement) by job number such as J0000005 or id: status, underwriting issues and approvals, quote totals and the policy data being quoted.',
    input_schema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'], additionalProperties: false },
  },
  {
    name: 'get_rating_worksheet',
    description: 'Get the rating worksheet (every cost with each factor applied) for a job number or a policy number (its current version). Optionally filter to costs whose coverage name contains a word, e.g. "Collision".',
    input_schema: {
      type: 'object',
      properties: { record: { type: 'string', description: 'Job number or policy number' }, coverage: { type: 'string', description: 'Optional coverage name filter' } },
      required: ['record'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_work_queue',
    description: 'List open underwriting referrals (activities) and open jobs (Draft or Quoted) visible to the signed-in user.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'portfolio_summary',
    description: 'Summarize the book of business visible to the signed-in user: policy counts and term premium by status, product, form and state, plus account count and open work. Optionally filter by product, state or status.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: ['PersonalAuto', 'Homeowners'] },
        state: { type: 'string', enum: Object.keys(STATES) },
        status: { type: 'string', enum: ['In Force', 'Scheduled', 'Expired', 'Cancelled'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_policies',
    description: 'List policies matching filters, sorted by the chosen field. Use for questions like "largest homeowners premiums in Florida" or "auto policies expiring soon".',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', enum: ['PersonalAuto', 'Homeowners'] },
        state: { type: 'string', enum: Object.keys(STATES) },
        status: { type: 'string', enum: ['In Force', 'Scheduled', 'Expired', 'Cancelled'] },
        sort: { type: 'string', enum: ['premium_desc', 'premium_asc', 'expiration_asc', 'effective_desc'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_claims',
    description: 'List claims on policies the signed-in user can see, optionally for one policy number or one status (Open or Closed). Returns claim number, policy, insured, loss date, loss type, status, and amounts paid.',
    input_schema: {
      type: 'object',
      properties: {
        policy: { type: 'string', description: 'Policy number, e.g. PA-0000001' },
        status: { type: 'string', enum: ['Open', 'Closed'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_claim',
    description: 'Get one claim by claim number (CL-0000001) or id: policy, loss details, status, payments, and reserve when the user may see it.',
    input_schema: { type: 'object', properties: { claim: { type: 'string' } }, required: ['claim'], additionalProperties: false },
  },
  {
    name: 'sales_report',
    description: 'Sales figures: new business written (policies bound as new submissions) with effective dates from to to, counted and totalled by product, state and (for underwriting staff) producer. Agents only get their own producer code. Use it for any question about sales, new business or written premium in a period.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, yyyy-mm-dd' },
        to: { type: 'string', description: 'End date, yyyy-mm-dd' },
        product: { type: 'string', enum: ['PersonalAuto', 'Homeowners'] },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_product_rules',
    description: 'Reference information: the product model (coverages, limits, forms, payment plans), underwriting rules and authority levels, cancellation reasons and methods, and the rate books.',
    input_schema: { type: 'object', properties: { topic: { type: 'string', enum: ['PersonalAuto', 'Homeowners', 'underwriting', 'cancellation', 'rate_books'] } }, required: ['topic'], additionalProperties: false },
  },
];

const UW_RULES = {
  PersonalAuto: [
    'Driver under 18: blocks bind, Underwriter approval',
    'Driver 80 or older: blocks bind, Underwriter approval',
    '2 at-fault accidents in 3 years: blocks quote, Underwriter; 3+: blocks quote, UW Manager',
    '4+ violations in 3 years: blocks quote, cannot be approved (decline)',
    'More than 4 vehicles: blocks quote, UW Manager',
    'Business use: blocks bind, Underwriter',
    'Over 30,000 annual miles: blocks bind, Underwriter',
    'Vehicle value over $100,000: blocks bind, UW Manager',
    'Vehicle over 20 years old with Collision: blocks bind, Underwriter',
  ],
  Homeowners: [
    'Roof older than 20 years: blocks bind, Underwriter; older than 25: UW Manager',
    'Coverage A over $1M: blocks bind, UW Manager',
    'Protection class 9: blocks quote, Underwriter; class 10: cannot be approved',
    'More than 5 miles to a fire station: blocks bind, Underwriter',
    '2 claims in 5 years: blocks quote, Underwriter; 3+: cannot be approved',
    'Dog with bite history, trampoline, or unfenced pool: blocks bind, Underwriter',
    'HO-5 on a home older than 40 years: cannot be approved (use HO-3)',
    'Coverage A below 80% of replacement cost: blocks bind, Underwriter',
    'Florida 1% wind/hail deductible: blocks bind, UW Manager',
  ],
  common: ['Submission effective date more than 5 days in the past: blocks bind, Underwriter'],
  authority: 'Agents have no underwriting authority. Underwriters approve level-1 issues, UW Managers approve all. An approval stays valid on re-quote unless the risk gets worse.',
};

// Tool inputs stream as they are generated, so the API no longer validates them; check each one here.
for (const t of TOOLS) t.eager_input_streaming = true;

function validateInput(name, input) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `unknown tool ${name}`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  const { properties, required = [] } = tool.input_schema;
  for (const key of required) if (input[key] === undefined) return `missing ${key}`;
  for (const [key, value] of Object.entries(input)) {
    const prop = properties[key];
    if (!prop) return `unexpected field ${key}`;
    if (prop.type === 'string' && typeof value !== 'string') return `${key} must be a string`;
    if (prop.type === 'integer') {
      const inRange = Number.isInteger(value) && (prop.minimum === undefined || value >= prop.minimum) && (prop.maximum === undefined || value <= prop.maximum);
      if (!inRange) return `${key} must be an integer in range`;
    }
    if (prop.enum && !prop.enum.includes(value)) return `${key} must be one of ${prop.enum.join(', ')}`;
  }
  return null;
}

function toolLabel(name, input = {}) {
  switch (name) {
    case 'search': return `Searching for "${input.query}"`;
    case 'get_account': return `Looking up account ${input.account}`;
    case 'get_policy': return `Looking up policy ${input.policy}`;
    case 'get_job': return `Looking up job ${input.job}`;
    case 'get_rating_worksheet': return `Reading the rating worksheet for ${input.record}`;
    case 'list_work_queue': return 'Checking the work queue';
    case 'sales_report': return `Reading sales from ${input.from} to ${input.to}`;
    case 'list_claims': return input.policy ? `Listing claims on ${input.policy}` : 'Listing claims';
    case 'get_claim': return `Looking up claim ${input.claim}`;
    case 'portfolio_summary': return 'Summarizing the book of business';
    case 'list_policies': return 'Listing policies';
    case 'get_product_rules': return `Reading the ${input.topic} rules`;
    default: return name;
  }
}

function compactPeriod(product, period) {
  if (product === 'PersonalAuto') {
    const sel = (m) => Object.entries(m || {}).filter(([, c]) => c.selected).map(([code, c]) => `${code}${Object.keys(c.terms).length ? ' ' + Object.values(c.terms).join('/') : ''}`);
    return {
      paymentPlan: period.paymentPlan,
      drivers: period.line.drivers.map((d) => ({ name: `${d.firstName} ${d.lastName}`, dob: d.dob, yearsLicensed: d.yearsLicensed, accidents: d.accidents, violations: d.violations, goodStudent: d.goodStudent })),
      vehicles: period.line.vehicles.map((v) => ({ vehicle: `${v.year} ${v.make} ${v.model}`, vin: v.vin, usage: v.usage, annualMiles: v.annualMiles, marketValue: v.marketValue, coverages: sel(v.coverages) })),
      policyCoverages: sel(period.line.lineCoverages),
    };
  }
  const covs = Object.entries(period.line.coverages).filter(([, c]) => c.selected).map(([code, c]) => `${code}${Object.keys(c.terms).length ? ' ' + Object.values(c.terms).join('/') : ''}`);
  return {
    paymentPlan: period.paymentPlan,
    form: period.line.form,
    dwelling: period.line.dwelling,
    units: { distanceToFireStation: 'miles', squareFeet: 'square feet', roofAge: 'years', priorClaims: 'claims in the last 5 years' },
    coverages: covs,
  };
}

const costSummary = (q) => (q && q.costs ? q.costs.map((c) => ({ item: `${c.coverable}: ${c.coverageName}`, amount: c.amount })) : undefined);

function findRecord(pc, user, record) {
  const r = str(record);
  if (/^J\d+$/i.test(r) || /^job\d+$/.test(r)) return { kind: 'job', value: pc.jobDetail(r.toUpperCase().startsWith('J0') ? r.toUpperCase() : r, user) };
  return { kind: 'policy', value: pc.policyDetail(r.toUpperCase().startsWith('PA-') || r.toUpperCase().startsWith('HO-') ? r.toUpperCase() : r, user) };
}

function runTool(pc, user, name, input) {
  switch (name) {
    case 'search': {
      const r = pc.search(str(input.query), user);
      return {
        accounts: r.accounts.slice(0, 10).map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name, city: a.address.city, state: a.address.state, policies: a.policyCount })),
        policies: r.policies.slice(0, 10).map((p) => ({ policyNumber: p.policyNumber, insured: p.insuredName, product: p.product, form: p.form, status: p.status, term: `${p.effectiveDate} to ${p.expirationDate}`, termPremium: p.termPremium })),
        jobs: r.jobs.slice(0, 10).map((j) => ({ jobNumber: j.jobNumber, type: j.type, status: j.status, account: j.accountName, policyNumber: j.policyNumber, amount: j.amount })),
      };
    }
    case 'get_account': {
      const d = pc.accountDetail(str(input.account).toUpperCase().startsWith('A0') ? str(input.account).toUpperCase() : str(input.account), user);
      const a = d.account;
      return {
        accountNumber: a.accountNumber, name: a.name, dob: a.dob, email: a.email, phone: a.phone, address: a.address, producer: `${a.producerCode} ${a.producerName || ''}`.trim(),
        policies: d.policies.map((p) => ({ policyNumber: p.policyNumber, product: p.product, form: p.form, status: p.status, term: `${p.effectiveDate} to ${p.expirationDate}`, termPremium: p.termPremium })),
        jobs: d.jobs.map((j) => ({ jobNumber: j.jobNumber, type: j.type, status: j.status, policyNumber: j.policyNumber, effectiveDate: j.effectiveDate, amount: j.amount })),
        openActivities: d.activities.filter((x) => x.status === 'Open').map((x) => ({ activity: x.activityNumber, subject: x.subject, assignedTo: x.assignedTo })),
      };
    }
    case 'get_policy': {
      const p = pc.policyDetail(str(input.policy).toUpperCase().startsWith('PA-') || str(input.policy).toUpperCase().startsWith('HO-') ? str(input.policy).toUpperCase() : str(input.policy), user);
      return {
        policyNumber: p.policyNumber, product: p.product, form: p.form, status: p.status, insured: p.account.name, accountNumber: p.account.accountNumber,
        state: p.current.period.state, producer: p.account.producerCode,
        currentTerm: { termNumber: p.termNumber, effective: p.effectiveDate, expiration: p.expirationDate, termPremiumInclTax: p.termPremium },
        currentVersion: { fromJob: `${p.current.jobType} ${p.current.jobNumber}`, effective: p.current.editEffectiveDate, rateBook: `${p.current.quote.rateBook.code} ${p.current.quote.rateBook.version}`, premium: p.current.quote.premium, taxes: p.current.quote.taxes, fees: p.current.quote.fees },
        details: compactPeriod(p.product, p.current.period),
        costs: costSummary(p.current.quote),
        cancellation: p.cancellation ? { effective: p.cancellation.effectiveDate, reason: p.cancellation.reasonName, method: p.cancellation.method, returnPremium: -p.cancellation.refund } : null,
        writtenPremium: p.writtenPremium,
        transactions: p.transactions.map((t) => ({ job: t.jobNumber, type: t.jobType, effective: t.effectiveDate, amount: t.amount, description: t.description })),
        billing: { invoices: p.invoices.length, billed: p.invoices.filter((i) => i.status === 'Billed').length, planned: p.invoices.filter((i) => i.status === 'Planned').length, nextDue: (p.invoices.find((i) => i.status === 'Planned') || {}).dueDate || null },
        documents: p.documents.map((d) => d.name),
        terms: p.terms.map((t) => ({ term: t.termNumber, effective: t.effectiveDate, expiration: t.expirationDate, versions: t.versions.map((v) => `${v.jobType} ${v.jobNumber} eff ${v.editEffectiveDate}`) })),
        openJob: p.openJob ? `${p.openJob.type} ${p.openJob.jobNumber} (${p.openJob.status})` : null,
      };
    }
    case 'get_job': {
      const j = pc.jobDetail(str(input.job).toUpperCase().startsWith('J0') ? str(input.job).toUpperCase() : str(input.job), user);
      return {
        jobNumber: j.jobNumber, type: j.type, status: j.status, product: j.product, account: `${j.account.name} (${j.account.accountNumber})`, policyNumber: j.policy ? j.policy.policyNumber : null,
        term: `${j.period.effectiveDate} to ${j.period.expirationDate}`, effective: j.period.editEffectiveDate, notice: j.notice ? j.notice.text : null,
        underwritingIssues: (j.uwIssues || []).map((i) => ({
          issue: i.name, description: i.description, blocks: i.blockingPoint, approvalNeeded: i.requiredRole || 'cannot be approved', approved: i.approved,
          ...(canSeeUnderwritingNotes(user) ? { approvedBy: i.approval ? i.approval.byName : null, note: i.approval ? i.approval.note : null } : {}),
        })),
        quote: j.quote ? { premium: j.quote.premium, taxes: j.quote.taxes, fees: j.quote.fees, total: j.quote.total, changeAmount: j.quote.changeAmount, proration: j.quote.proration, rateBook: j.quote.rateBook ? `${j.quote.rateBook.code} ${j.quote.rateBook.version}` : null } : null,
        cancellation: j.cancellation || null,
        details: j.period.line ? compactPeriod(j.product, j.period) : null,
        openActivities: j.activities.filter((a) => a.status === 'Open').map((a) => ({ subject: a.subject, assignedTo: a.assignedTo })),
        history: j.history.slice(-8).map((h) => (canSeeUnderwritingNotes(user)
          ? `${h.at.slice(0, 10)} ${h.byName}: ${h.action}${h.detail ? ' - ' + h.detail : ''}`
          : `${h.at.slice(0, 10)}: ${h.action}`)),
      };
    }
    case 'get_rating_worksheet': {
      const rec = findRecord(pc, user, input.record);
      const quote = rec.kind === 'job' ? rec.value.quote : rec.value.current.quote;
      if (!quote || !quote.costs) return { error: 'This record has no rated quote yet.' };
      const f = str(input.coverage).toLowerCase();
      const costs = quote.costs.filter((c) => !f || c.coverageName.toLowerCase().includes(f) || c.coverable.toLowerCase().includes(f));
      if (!canSeeRatingFactors(user)) {
        // Agents see what each coverage costs, not the internal rating factors behind it.
        return {
          premium: quote.premium, taxes: quote.taxes, fees: quote.fees, total: quote.total,
          costs: costs.map((c) => ({ item: `${c.coverable}: ${c.coverageName}`, term: c.termValue, amount: c.amount })),
          note: 'Rating factors are internal to underwriting and are not shown to agents.',
        };
      }
      return {
        rateBook: quote.rateBook, premium: quote.premium, taxes: quote.taxes, fees: quote.fees, total: quote.total,
        ratedDriver: quote.ratedDriver || undefined, replacementCostEstimate: quote.replacementCost || undefined,
        costs: costs.map((c) => ({ item: `${c.coverable}: ${c.coverageName}`, term: c.termValue, amount: c.amount, factors: c.worksheet.map((s) => `${s.label} = ${s.factor}`) })),
      };
    }
    case 'list_work_queue': {
      const d = pc.desktop(user);
      return {
        openReferrals: d.activities.map((a) => ({ activity: a.activityNumber, subject: a.subject, detail: a.description, job: a.jobNumber, priority: a.priority, assignedTo: a.assignedToName, due: a.dueDate })),
        openJobs: d.openJobs.map((j) => ({ jobNumber: j.jobNumber, type: j.type, status: j.status, account: j.accountName, product: j.product, amount: j.amount })),
      };
    }
    case 'list_claims': {
      const list = pc.listClaims(user, { policy: str(input.policy) || undefined, status: input.status });
      return { claims: list.map(({ payments, ...rest }) => rest), count: list.length };
    }
    case 'get_claim': {
      return pc.claimDetail(str(input.claim).toUpperCase().startsWith('CL-') ? str(input.claim).toUpperCase() : str(input.claim), user);
    }
    case 'sales_report':
      return pc.salesReport(user, { from: str(input.from), to: str(input.to), product: input.product });
    case 'portfolio_summary':
    case 'list_policies': {
      let list = pc.listPolicies('', user).map((p) => ({ ...p, state: (pc.db.accounts.find((a) => a.id === p.accountId) || { address: {} }).address.state }));
      if (input.product) list = list.filter((p) => p.product === input.product);
      if (input.state) list = list.filter((p) => p.state === input.state);
      if (input.status) list = list.filter((p) => p.status === input.status);
      if (name === 'list_policies') {
        const sorters = {
          premium_desc: (a, b) => b.termPremium - a.termPremium,
          premium_asc: (a, b) => a.termPremium - b.termPremium,
          expiration_asc: (a, b) => a.expirationDate.localeCompare(b.expirationDate),
          effective_desc: (a, b) => b.effectiveDate.localeCompare(a.effectiveDate),
        };
        list.sort(sorters[input.sort || 'premium_desc']);
        return { matched: list.length, policies: list.slice(0, input.limit || 10).map((p) => ({ policyNumber: p.policyNumber, insured: p.insuredName, product: p.product, form: p.form, state: p.state, status: p.status, term: `${p.effectiveDate} to ${p.expirationDate}`, termPremium: p.termPremium })) };
      }
      const group = (key) => {
        const out = {};
        for (const p of list) {
          const k = key(p) || 'n/a';
          out[k] = out[k] || { policies: 0, termPremium: 0 };
          out[k].policies++;
          out[k].termPremium = Math.round((out[k].termPremium + p.termPremium) * 100) / 100;
        }
        return out;
      };
      const d = pc.desktop(user);
      return {
        filters: input, policies: list.length, accounts: pc.listAccounts('', user).length,
        byStatus: group((p) => p.status), byProduct: group((p) => p.product), byHomeownersForm: group((p) => p.form), byState: group((p) => p.state),
        openJobs: d.stats.openJobs, openReferrals: d.stats.openReferrals,
      };
    }
    case 'get_product_rules': {
      const t = input.topic;
      if (t === 'underwriting') return UW_RULES;
      if (t === 'cancellation') return { reasons: CANCEL_REASONS, methods: 'Flat if cancelled on the term start date; short rate (90% of unearned premium returned) for insured request; otherwise pro rata. Policy fees are fully earned. Reinstatement restores the returned premium with no lapse.' };
      if (t === 'rate_books') return RATE_BOOKS.map((b) => ({ code: b.code, product: b.product, version: b.version, effectiveDate: b.effectiveDate, status: b.status, rateLevel: b.rateLevel, description: b.description }));
      const p = PRODUCTS[t];
      if (!p) return { error: `Unknown topic ${t}` };
      const cov = (c) => ({ code: c.code, name: c.name, category: c.category, existence: c.existence, states: c.states, forms: c.forms, terms: c.terms.map((x) => `${x.name}: ${x.type === 'option' ? x.options.map((o) => o.label).join(', ') : 'entered amount'}`) });
      return {
        name: p.name, termMonths: p.termMonths, paymentPlans: p.paymentPlans, forms: p.forms, usages: p.usages,
        coverages: p.coverages ? p.coverages.map(cov) : { policyLevel: p.lineCoverages.map(cov), perVehicle: p.vehicleCoverages.map(cov) },
        underwritingRules: UW_RULES[t],
      };
    }
    default:
      throw new AppError(400, `Unknown tool ${name}`);
  }
}

function safeRunTool(pc, user, name, input) {
  try {
    return { ok: true, result: runTool(pc, user, name, input || {}) };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, result: { error: err.message } };
    throw err;
  }
}

// ------------------------------------------------------------------ offline mode

const fmt = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Names the language style of a message so the model gets an explicit, per-turn instruction.
// Romanized Hinglish and Tenglish look like English to a quick read, so they are spotted from
// common Hindi and Telugu words written in Roman letters.
const HINGLISH = /\b(hai|hain|kya|kyon|kyun|kaise|kitna|kitne|kitni|mein|mujhe|batao|bataiye|dikhao|nahi|nahin|aur|bhi|wala|wali|karo|kijiye|chahiye|abhi|kab|kahan|iska|iski|kaun|kaunsa)\b/;
const TENGLISH = /\b(enduku|enti|emiti|ela|elaa|cheppu|cheppandi|chupinchu|chupinchandi|undi|unnayi|ledu|levu|kavali|ayindi|avutundi|ee|aa|ga|lo|ki|naku|meeru|nenu|chala|ekkuva|takkuva|enni|entha)\b/;

function replyLanguage(text) {
  if (/[ఀ-౿]/.test(text)) return 'Telugu in Telugu script (keep insurance terms, record numbers and amounts in English).';
  if (/[ऀ-ॿ]/.test(text)) return 'Hindi in Devanagari script (keep insurance terms, record numbers and amounts in English).';
  const lower = text.toLowerCase();
  const hi = (lower.match(new RegExp(HINGLISH.source, 'g')) || []).length;
  const te = (lower.match(new RegExp(TENGLISH.source, 'g')) || []).length;
  // "ki", "lo", "ga", "aa", "ee" are short and could appear elsewhere, so Tenglish needs two signals.
  if (te >= 2 && te >= hi) return 'romanized Tenglish: Telugu sentences written in Roman letters, mixed with English insurance terms, the way the user wrote. Use Telugu connecting words (enduku ante, kabatti, mariyu, meeru, undi, ledu), never Hindi ones (kyunki, aur, aap, hai). Write bullet points in Tenglish too; only names, numbers, dates and insurance terms stay in English. Do not answer in plain English and do not use Telugu script.';
  if (hi >= 1) return 'romanized Hinglish: Hindi sentences written in Roman letters, mixed with English insurance terms, the way the user wrote. Write bullet points in Hinglish too (for example "Premium: $1,974.20 hai, jisme tax shamil hai"); only names, numbers, dates and insurance terms stay in English. Do not answer in plain English and do not use Devanagari.';
  return 'the same language as the user’s message.';
}

// Offline keyword matching in English, Hindi, Telugu, and romanized Hinglish / Tenglish.
// (Devanagari and Telugu letters are not "word" characters to \b, so those words match as plain substrings.)
const OFFLINE_WORDS = {
  // Hinglish "is" ("is policy") is left out: it would also match the English word.
  thisRecord: { latin: /\b(this|current|ye|yeh|yah|iska|iski|iske|ee|idi|deeni|deni)\b/, native: ['यह', 'ये', 'इस', 'ఈ', 'ఇది', 'దీని'] },
  workQueue: { latin: /referral|activit|queue|approv|pending|open job|baaki|baki|lambit/, native: ['रेफरल', 'लंबित', 'बाकी', 'मंजूरी', 'రెఫరల్', 'పెండింగ్', 'ఆమోదం'] },
  summary: { latin: /summary|portfolio|book|how many|total|count|kitne|kitni|kitna|saransh|enni|entha|motham/, native: ['सारांश', 'कितने', 'कितनी', 'कुल', 'సారాంశం', 'ఎన్ని', 'మొత్తం'] },
};
const saysAny = (key, lower, text) => OFFLINE_WORDS[key].latin.test(lower) || OFFLINE_WORDS[key].native.some((w) => text.includes(w));
const NON_LATIN_SCRIPT = /[ऀ-ॿఀ-౿]/;

function offlineAnswer(pc, user, message, context) {
  const text = str(message);
  const lower = text.toLowerCase();
  const num = text.match(/\b(PA-\d{7}|HO-\d{7}|J\d{7}|A\d{7})\b/i) || (saysAny('thisRecord', lower, text) && context && context.record ? [context.record, context.record] : null);
  const out = [];
  try {
    if (num) {
      const id = num[1].toUpperCase();
      if (id.startsWith('J')) {
        const j = runTool(pc, user, 'get_job', { job: id });
        out.push(`**${j.jobNumber}** is a ${j.type} for ${j.account}, status **${j.status}**${j.quote ? `, quoted at ${fmt(j.quote.changeAmount)}` : ''}.`);
        const open = j.underwritingIssues.filter((i) => !i.approved);
        if (j.underwritingIssues.length) out.push('Underwriting issues:', ...j.underwritingIssues.map((i) => `- ${i.issue}: ${i.description} (${i.blocks}, ${i.approved ? `approved by ${i.approvedBy}` : `needs ${i.approvalNeeded}`})`));
        if (open.length) out.push('Open the job, go to **Risk analysis**, and approve with the right authority to continue.');
      } else if (id.startsWith('A')) {
        const a = runTool(pc, user, 'get_account', { account: id });
        out.push(`**${a.accountNumber}** ${a.name}, ${a.address.city}, ${a.address.state}. ${a.policies.length} policies:`, ...a.policies.map((p) => `- ${p.policyNumber} ${p.product}${p.form ? ' ' + p.form : ''}, ${p.status}, ${fmt(p.termPremium)}`));
      } else {
        const p = runTool(pc, user, 'get_policy', { policy: id });
        out.push(`**${p.policyNumber}** (${p.product}${p.form ? ' ' + p.form : ''}) for ${p.insured} is **${p.status}**, term ${p.currentTerm.effective} to ${p.currentTerm.expiration}.`,
          `- Term premium incl. tax: ${fmt(p.currentTerm.termPremiumInclTax)}`, `- Written premium to date: ${fmt(p.writtenPremium)}`, `- Rate book: ${p.currentVersion.rateBook}`,
          `- Billing: ${p.billing.billed} billed, ${p.billing.planned} planned${p.billing.nextDue ? `, next due ${p.billing.nextDue}` : ''}`);
        if (p.cancellation) out.push(`- Cancelled ${p.cancellation.effective} (${p.cancellation.reason}), return premium ${fmt(p.cancellation.returnPremium)}`);
        if (p.openJob) out.push(`- Open job: ${p.openJob}`);
      }
    } else if (/claim/i.test(text) && !num) {
      const c = runTool(pc, user, 'list_claims', {});
      out.push(c.count ? `You can see ${c.count} claim(s):` : 'No claims found.', ...c.claims.map((x) => `- ${x.claimNumber} on ${x.policyNumber} (${x.insured}): ${x.lossType}, ${x.status}, paid ${fmt(x.paid)}, loss ${x.lossDate}`));
    } else if (saysAny('workQueue', lower, text)) {
      const q = runTool(pc, user, 'list_work_queue', {});
      out.push(q.openReferrals.length ? `You have ${q.openReferrals.length} open referral(s):` : 'No open referrals.', ...q.openReferrals.map((a) => `- ${a.job}: ${a.detail.split('\n')[0]} (${a.assignedTo}, due ${a.due})`));
      if (q.openJobs.length) out.push(`Open jobs: ${q.openJobs.map((j) => `${j.jobNumber} (${j.type}, ${j.status})`).join(', ')}`);
    } else if (saysAny('summary', lower, text)) {
      const s = runTool(pc, user, 'portfolio_summary', {});
      out.push(`You can see ${s.accounts} accounts and ${s.policies} policies.`, ...Object.entries(s.byStatus).map(([k, v]) => `- ${k}: ${v.policies} policies, ${fmt(v.termPremium)}`), ...Object.entries(s.byProduct).map(([k, v]) => `- ${k}: ${v.policies} policies, ${fmt(v.termPremium)}`));
    } else if (text.length >= 3) {
      let r = runTool(pc, user, 'search', { query: text.replace(/^(find|search|show|look up|lookup)\s+/i, '') });
      // Mixed-language messages ("Rivera ki policy dikhao", "Rivera policy chupinchu"): try each Latin word as a name.
      if (!r.accounts.length && !r.policies.length) {
        const seen = new Set();
        const merged = { accounts: [], policies: [] };
        for (const word of text.match(/[A-Za-z]{4,}/g) || []) {
          const hit = runTool(pc, user, 'search', { query: word });
          for (const a of hit.accounts) if (!seen.has(a.accountNumber)) { seen.add(a.accountNumber); merged.accounts.push(a); }
          for (const p of hit.policies) if (!seen.has(p.policyNumber)) { seen.add(p.policyNumber); merged.policies.push(p); }
        }
        if (merged.accounts.length + merged.policies.length <= 10) r = merged;
      }
      const n = r.accounts.length + r.policies.length;
      if (n) out.push('Here is what I found:', ...r.accounts.map((a) => `- Account ${a.accountNumber}: ${a.name}, ${a.city} ${a.state}`), ...r.policies.map((p) => `- ${p.policyNumber}: ${p.insured}, ${p.product}, ${p.status}, ${fmt(p.termPremium)}`));
    }
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    out.push(`I couldn't find that: ${err.message}.`);
  }
  if (!out.length) out.push('In offline mode I can look up a policy, job or account by number (for example PA-0000001 or J0000005), list your referrals, summarize the book of business, or search by name or city.');
  if (NON_LATIN_SCRIPT.test(text)) out.push('\n(Offline mode replies in English only. With an API key set, I reply in Hindi or Telugu.)');
  return out.join('\n');
}

// ------------------------------------------------------------------ chat service

// The SDK resolves an API key, an auth token, or a profile saved by `ant auth login`.
// Non-secret assistant settings (such as the workspace ID) live in chat.config.json next to package.json.
// The API key never goes in this file; it stays in the ANTHROPIC_API_KEY environment variable.
function readChatConfig() {
  const file = require('node:path').join(__dirname, '..', 'chat.config.json');
  try {
    return JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function hasCredentials() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const home = require('node:os').homedir();
  return require('node:fs').existsSync(require('node:path').join(home, '.config', 'anthropic'));
}

const NO_KEY = 'No Anthropic credentials found, so the assistant is in offline mode (lookups and summaries only). Set ANTHROPIC_API_KEY and restart the server for full answers.';

class Chatbot {
  constructor(pc, { client } = {}) {
    this.pc = pc;
    this.conversations = new Map();
    this.offlineReason = null;
    if (client !== undefined) this.client = client;
    else if (!hasCredentials()) this.client = null;
    else {
      try {
        // User-scoped keys (sk-ant-usr-...) must name the workspace on every request.
        const workspace = process.env.ANTHROPIC_WORKSPACE_ID || readChatConfig().workspaceId;
        this.client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
      } catch {
        this.client = null;
      }
    }
    if (!this.client) this.offlineReason = NO_KEY;
  }

  status() {
    return { mode: this.offlineReason ? 'offline' : 'claude', model: MODEL, reason: this.offlineReason };
  }

  conversation(id, user) {
    let c = id && this.conversations.get(id);
    if (!c || c.userId !== user.id) {
      c = { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, userId: user.id, messages: [], turns: 0 };
      this.conversations.set(c.id, c);
      if (this.conversations.size > MAX_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value);
    }
    return c;
  }

  // Runs one user turn. `emit(type, data)` receives live events as they happen:
  //   tool {name, label}   a lookup is starting
  //   delta {text}         the next piece of the answer
  //   reset {}             discard the partial answer (a declined draft is being re-answered)
  // The resolved value is the complete reply.
  async chat({ conversationId, message, context }, user, emit = () => {}) {
    const text = str(message);
    if (!text) throw new AppError(422, 'Message is empty');
    if (text.length > 4000) throw new AppError(422, 'Message is too long (4,000 characters max)');
    const conv = this.conversation(conversationId, user);
    if (conv.turns >= MAX_TURNS) throw new AppError(409, 'This conversation is long; start a new chat to continue');
    conv.turns++;

    if (this.offlineReason) {
      const reply = offlineAnswer(this.pc, user, text, context);
      emit('delta', { text: reply });
      return { conversationId: conv.id, mode: 'offline', reply, toolsUsed: [], notice: this.offlineReason };
    }

    const style = replyLanguage(text);
    const note = `[Today: ${this.pc.today()}. Signed in as ${user.name} (${user.role}). Viewing: ${context && context.page ? context.page : 'unknown'}${context && context.record ? `, record ${context.record}` : ''}]`;
    // History is append-only: assistant content (including thinking blocks) goes back unchanged, and
    // the conversation is only updated once the whole turn has succeeded.
    // The reply style goes in a mid-conversation system message right after the question: the model
    // weighs it as an operator instruction, which keeps short Hinglish/Tenglish questions from drifting
    // into plain English.
    const pending = [
      ...conv.messages,
      { role: 'user', content: `${note}\n${text}` },
      { role: 'system', content: `Reply language for this answer: ${style} Start directly with the answer; never label or mention the language.` },
    ];
    const toolsUsed = [];
    let streamed = '';
    let jsonRetries = 0;
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (round > 0 && streamed) emit('delta', { text: '\n' });
        const stream = this.client.beta.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          ...fallbackParams(),
          // Answers written in Telugu or Hindi script get more care; low effort produced garbled openings there.
          output_config: { effort: NON_LATIN_SCRIPT.test(text) ? 'medium' : 'low' },
          cache_control: { type: 'ephemeral' },
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: pending,
        });
        let response;
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
              emit('reset', {});
              streamed = '';
            } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              streamed += event.delta.text;
              emit('delta', { text: event.delta.text });
            }
          }
          response = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // With eager input streaming, a tool input that is not valid JSON rejects the stream.
          // Only that case is retried; API errors go to the outer handler.
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          emit('reset', {});
          streamed = '';
          round--;
          continue;
        }

        const calls = response.content.filter((b) => b.type === 'tool_use');
        if (response.stop_reason === 'refusal') {
          conv.messages = [...pending, { role: 'assistant', content: response.content }];
          emit('reset', {});
          const reply = 'I can’t help with that request.';
          emit('delta', { text: reply });
          return { conversationId: conv.id, mode: 'claude', reply, toolsUsed };
        }
        if (response.stop_reason === 'max_tokens' && calls.length) {
          throw new AppError(502, 'The assistant ran out of room while looking something up; try a narrower question');
        }
        pending.push({ role: 'assistant', content: response.content });

        if (response.stop_reason !== 'tool_use' || !calls.length || round === MAX_TOOL_ROUNDS) {
          conv.messages = pending;
          let reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          if (!reply) {
            reply = 'I could not find an answer to that.';
            emit('delta', { text: reply });
          }
          if (response.stop_reason === 'max_tokens') {
            const more = '\n\n(The answer was cut off; ask me to continue.)';
            reply += more;
            emit('delta', { text: more });
          }
          return { conversationId: conv.id, mode: 'claude', reply, toolsUsed };
        }

        const results = calls.map((call) => {
          toolsUsed.push(call.name);
          const problem = validateInput(call.name, call.input);
          if (problem) {
            return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: problem, received: call.input }) };
          }
          emit('tool', { name: call.name, label: toolLabel(call.name, call.input) });
          const { ok, result } = safeRunTool(this.pc, user, call.name, call.input);
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result), is_error: !ok };
        });
        pending.push({ role: 'user', content: results });
      }
    } catch (err) {
      conv.turns--;
      if (err instanceof AppError) throw err;
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        this.offlineReason = 'The Anthropic credentials were rejected, so the assistant switched to offline mode. Check ANTHROPIC_API_KEY and restart the server for full answers.';
        emit('reset', {});
        return this.chat({ conversationId: conv.id, message: text, context }, user, emit);
      }
      if (err instanceof Anthropic.RateLimitError) throw new AppError(429, 'The assistant is busy right now; try again in a moment');
      if (err instanceof Anthropic.APIConnectionError) throw new AppError(503, 'Could not reach the Claude API; check the network and try again');
      if (err instanceof Anthropic.APIError) throw new AppError(502, `Claude API error ${err.status}: ${err.message}`);
      throw err;
    }
    throw new AppError(500, 'Assistant stopped unexpectedly');
  }
}

module.exports = { Chatbot, TOOLS, runTool, offlineAnswer, validateInput, replyLanguage };
